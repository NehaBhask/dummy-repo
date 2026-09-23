-- 002_create_holds_function.sql — additive (new function only). Safe to run repeatedly.
--
-- The hot path of the whole system: reserve N inventory rows atomically. Doing lock → check →
-- insert → update inside ONE database call means a row lock is held for microseconds inside
-- Postgres instead of across several network round trips, which is what bounds throughput when
-- hundreds of requests race for the same row. Semantics are identical to the JS implementation
-- in src/modules/booking/holds.js (HOLD_IMPL=js) and are covered by the same tests.
--
-- Returns jsonb: {outcome: 'created', holds: [...]} | {outcome: 'sold_out', inventory_id, available}
--                | {outcome: 'missing', inventory_id}
-- Raises P0001 'idempotency_race' (rolling back any partial insert) if a key already owns a hold.

CREATE OR REPLACE FUNCTION kognivera_create_holds(
  p_user_id          text,
  p_inventory_ids    text[],
  p_units            int[],
  p_keys             text[],
  p_hold_ids         text[],
  p_ttl_seconds      double precision,
  p_lock_timeout_ms  int DEFAULT 2000
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  n         int := cardinality(p_inventory_ids);
  locked    int := 0;
  r         record;
  sold_id   text;
  sold_free int;
  ins       int;
BEGIN
  PERFORM set_config('lock_timeout', p_lock_timeout_ms::text || 'ms', true);

  -- Lock every requested row in ascending inventory_id order (fixed order => no deadlock), and
  -- evaluate availability on the freshly locked row versions.
  FOR r IN
    SELECT ic.inventory_id AS id,
           (ic.total_units - ic.booked_units - ic.held_units) AS free,
           u.want
      FROM inventory_calendar ic
      JOIN unnest(p_inventory_ids, p_units) AS u(id, want) ON u.id = ic.inventory_id
     ORDER BY ic.inventory_id
       FOR UPDATE OF ic
  LOOP
    locked := locked + 1;
    IF sold_id IS NULL AND r.want > r.free THEN
      sold_id := r.id;
      sold_free := r.free;
    END IF;
  END LOOP;

  IF locked < n THEN
    RETURN jsonb_build_object(
      'outcome', 'missing',
      'inventory_id', (SELECT x FROM unnest(p_inventory_ids) x
                        WHERE NOT EXISTS (SELECT 1 FROM inventory_calendar c WHERE c.inventory_id = x) LIMIT 1));
  END IF;

  IF sold_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'sold_out', 'inventory_id', sold_id, 'available', GREATEST(sold_free, 0));
  END IF;

  INSERT INTO holds (hold_id, inventory_id, user_id, units, idempotency_key,
                     created_at, expires_at, status, updated_at)
  SELECT u.hold_id, u.inventory_id, p_user_id, u.units, u.idem,
         statement_timestamp(), statement_timestamp() + make_interval(secs => p_ttl_seconds), 'active', statement_timestamp()
    FROM unnest(p_hold_ids, p_inventory_ids, p_units, p_keys) AS u(hold_id, inventory_id, units, idem)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS ins = ROW_COUNT;

  IF ins <> n THEN
    RAISE EXCEPTION 'idempotency_race' USING ERRCODE = 'P0001';  -- undoes any partial insert
  END IF;

  UPDATE inventory_calendar ic
     SET held_units = ic.held_units + u.units, updated_at = statement_timestamp()
    FROM unnest(p_inventory_ids, p_units) AS u(id, units)
   WHERE ic.inventory_id = u.id;

  RETURN jsonb_build_object(
    'outcome', 'created',
    'holds', (SELECT jsonb_agg(jsonb_build_object(
                'hold_id', h.hold_id, 'inventory_id', h.inventory_id, 'user_id', h.user_id, 'units', h.units,
                'idempotency_key', h.idempotency_key, 'status', h.status, 'created_at', h.created_at,
                'expires_at', h.expires_at, 'released_at', h.released_at, 'booking_id', h.booking_id)
              ORDER BY array_position(p_keys, h.idempotency_key))
                FROM holds h WHERE h.idempotency_key = ANY(p_keys)));
END;
$$;
