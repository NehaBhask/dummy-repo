-- 004_hub_flights.sql — additive (new rows only, deterministic ids, safe to run repeatedly).
--
-- Demo supply for connecting itineraries. The provided seed is a set of one-off flights on random routes, so a
-- search like Bengaluru -> Jaipur has no sensible one-stop option (a connection needs a flight that lands at a
-- hub and another that leaves that same airport 1-6 hours later). This adds a small daily schedule through two
-- hubs so the popular domestic routes do:
--
--   New Delhi (NEW):  Bengaluru, Chennai, Hyderabad, Kolkata, Jaipur   <->  New Delhi
--   Mumbai    (MUM):  Bengaluru, Jaipur, Hyderabad                     <->  Mumbai
--
-- Every day from 2026-09-24 to 2026-11-29: spoke -> hub at 06:00 and 12:00, hub -> spoke at 10:30, 16:30 and 18:30
-- (local clock time, stored the same way as the provided flights, i.e. written as-is into the timestamptz).
-- Layovers therefore range from ~1h15 to ~5h30. One economy fare per flight; a few hub -> Jaipur flights have only
-- 2 seats so a scarce connection can be shown selling out. Nothing in the provided seed is changed or removed.
-- Ids are prefixed flt_h / far_h / inv_h so they can never collide with (or be mistaken for) the provided rows.

WITH legs(hub, spoke, dur, fare) AS (
  VALUES ('NEW','BEN',175,7900), ('NEW','CHE',180,8200), ('NEW','HYD',140,6800), ('NEW','KOL',145,7000), ('NEW','JAI',65,2600),
         ('MUM','BEN',105,4800), ('MUM','JAI',125,5600), ('MUM','HYD',95,4300)
),
slots(dir, dep) AS (
  VALUES ('in','06:00'), ('in','12:00'), ('out','10:30'), ('out','16:30'), ('out','18:30')
),
days AS (SELECT generate_series('2026-09-24'::date, '2026-11-29'::date, '1 day')::date AS d),
airlines_pick AS (
  SELECT airline_id, row_number() OVER (ORDER BY iata) - 1 AS n FROM airlines WHERE iata IN ('6E','AI','UK','SG','QP','IX')
),
plan AS (
  SELECT l.hub, l.spoke, s.dir, s.dep, d.d,
         CASE WHEN s.dir = 'in' THEN l.spoke ELSE l.hub END AS o_iata,
         CASE WHEN s.dir = 'in' THEN l.hub ELSE l.spoke END AS d_iata,
         l.dur + (abs(hashtext(l.hub || l.spoke || s.dir || s.dep || d.d::text)) % 11) - 5 AS dur,
         l.fare * (0.85 + (abs(hashtext('p' || l.hub || l.spoke || s.dir || s.dep || d.d::text)) % 41) / 100.0) AS base,
         substr(md5(l.hub || l.spoke || s.dir || s.dep || d.d::text), 1, 8) AS h,
         abs(hashtext('a' || l.hub || l.spoke || s.dir || s.dep || d.d::text)) AS ah,
         abs(hashtext('s' || l.hub || l.spoke || s.dir || s.dep || d.d::text)) AS sh
    FROM legs l CROSS JOIN slots s CROSS JOIN days d
),
built AS (
  SELECT p.*,
         (p.d + p.dep::time) AT TIME ZONE 'UTC' AS departs_at,
         a.airline_id, al.iata AS al_iata,
         oa.airport_id AS o_id, da.airport_id AS d_id,
         -- a few hub -> Jaipur evening flights are nearly full, to make a sold-out connection easy to show
         CASE WHEN p.d_iata = 'JAI' AND p.dir = 'out' AND p.sh % 4 = 0 THEN 2 ELSE 8 + (p.sh % 33) END AS seats
    FROM plan p
    JOIN airlines_pick a ON a.n = p.ah % (SELECT count(*) FROM airlines_pick)
    JOIN airlines al ON al.airline_id = a.airline_id
    JOIN airports oa ON oa.iata = p.o_iata
    JOIN airports da ON da.iata = p.d_iata
),
ins_flights AS (
  INSERT INTO flights (flight_id, airline_id, flight_number, origin_airport_id, dest_airport_id, departs_at, arrives_at,
                       duration_minutes, stops, aircraft_type, cabin_classes, carbon_kg, status, updated_at)
  SELECT 'flt_h' || h, airline_id, al_iata || '-' || (2000 + ah % 7000), o_id, d_id, departs_at,
         departs_at + make_interval(mins => dur), dur, 0, 'A320', 'economy', round(dur * 0.55, 3), 'active', now()
    FROM built
  ON CONFLICT (flight_id) DO NOTHING
  RETURNING flight_id
),
ins_fares AS (
  INSERT INTO flight_fares (fare_id, flight_id, cabin_class, fare_class, base_fare, taxes, currency, baggage_kg,
                            cabin_baggage_kg, changeable, change_fee, refundable, seats_total, status, updated_at)
  SELECT 'far_h' || h, 'flt_h' || h, 'economy', 'standard', round(base, 2), round(base * 0.12, 2), 'INR', 15, 7,
         true, 1500, false, seats, 'active', now()
    FROM built
  ON CONFLICT (fare_id) DO NOTHING
  RETURNING fare_id
)
INSERT INTO inventory_calendar (inventory_id, entity_type, entity_id, for_date, total_units, booked_units, held_units,
                                price, currency, min_stay_nights, closed_to_arrival, updated_at)
SELECT 'inv_h' || h, 'flight_fare', 'far_h' || h, d, seats, 0, 0, round(base * 1.12, 2), 'INR', 1, false, now()
  FROM built
ON CONFLICT DO NOTHING;
