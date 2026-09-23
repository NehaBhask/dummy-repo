import { pool } from '../../db.js';
import { D, money, sum } from '../../money.js';
import { fxContext, convert, moneyOut, assertCurrency } from '../../fx.js';

/*
 * Availability search. Everything returned is read from inventory_calendar at query time, so a
 * result always corresponds to a real, bookable row: free = total - booked - held. Search is a
 * read-only, unlocked snapshot — the hold is what actually reserves, and it re-checks under lock.
 */

const HOTEL_SQL = `
  SELECT h.hotel_id, h.name AS hotel_name, h.star_rating, h.guest_score::text AS guest_score, h.review_count,
         h.property_type, h.address_line, h.distance_to_centre_km::text AS distance_to_centre_km,
         h.description, c.city_id, c.name AS city,
         rt.room_type_id, rt.name AS room_name, rt.max_occupancy, rt.max_adults, rt.max_children,
         rt.bed_config, rt.size_sqm,
         array_agg(ic.inventory_id ORDER BY ic.for_date)              AS inventory_ids,
         array_agg(ic.for_date::text ORDER BY ic.for_date)            AS dates,
         array_agg(ic.price::text ORDER BY ic.for_date)               AS prices,
         min(ic.total_units - ic.booked_units - ic.held_units)::int   AS min_free,
         min(ic.currency) AS currency,
         bool_or(ic.closed_to_arrival) FILTER (WHERE ic.for_date = $2::date) AS closed_to_arrival,
         max(ic.min_stay_nights)       FILTER (WHERE ic.for_date = $2::date) AS min_stay_nights
    FROM hotels h
    JOIN cities c ON c.city_id = h.city_id
    JOIN hotel_room_types rt ON rt.hotel_id = h.hotel_id AND rt.status = 'active'
    JOIN inventory_calendar ic
      ON ic.entity_type = 'room_type' AND ic.entity_id = rt.room_type_id
     AND ic.for_date >= $2::date AND ic.for_date < $2::date + $3::int
   WHERE h.status = 'active'
     AND (c.city_id = $1 OR lower(c.name) = lower($1))
     AND h.star_rating >= $4
   GROUP BY h.hotel_id, c.city_id, rt.room_type_id
  HAVING count(*) = $3::int
     AND min(ic.total_units - ic.booked_units - ic.held_units) >= $5`;

const PLAN_SQL = `
  SELECT rate_plan_id, room_type_id, plan_type, name, price_delta::text AS price_delta, currency,
         cancellation_window_hours, cancellation_penalty_pct, includes_breakfast, min_stay_nights
    FROM hotel_rate_plans WHERE room_type_id = ANY($1::text[]) AND status = 'active'`;

/**
 * @param {{ city: string, check_in: string, nights?: number, rooms?: number, adults?: number, children?: number,
 *           max_price?: string|number, min_stars?: number, breakfast?: boolean, refundable?: boolean,
 *           currency?: string, sort?: 'price'|'rating'|'score', limit?: number }} q
 */
export async function searchHotels(q) {
  const nights = q.nights ?? 1;
  const rooms = q.rooms ?? 1;
  const adults = q.adults ?? 1;
  const children = q.children ?? 0;
  const fx = await fxContext();
  if (q.currency) assertCurrency(fx, q.currency);

  const { rows } = await pool.query(HOTEL_SQL, [q.city, q.check_in, nights, q.min_stars ?? 0, rooms]);
  const planRows = rows.length
    ? (await pool.query(PLAN_SQL, [rows.map((r) => r.room_type_id)])).rows
    : [];

  const cards = new Map();
  for (const r of rows) {
    if (r.closed_to_arrival || nights < (r.min_stay_nights ?? 1)) continue;
    if (Math.ceil(adults / rooms) > r.max_adults || Math.ceil(children / rooms) > r.max_children) continue;
    if (Math.ceil((adults + children) / rooms) > r.max_occupancy) continue;

    const out = q.currency ?? r.currency;
    const nightly = r.prices.map((p) => D(p));
    const baseTotal = sum(nightly);
    const avgNight = baseTotal.div(nights);

    const wantsPlan = q.breakfast || q.refundable;
    const options = [];
    if (!wantsPlan) options.push({ plan: null, delta: D(0) });
    for (const p of planRows) {
      if (p.room_type_id !== r.room_type_id || p.min_stay_nights > nights || p.currency !== r.currency) continue;
      if (q.breakfast && !p.includes_breakfast) continue;
      if (q.refundable && !(p.plan_type === 'refundable' || p.cancellation_penalty_pct === 0)) continue;
      options.push({ plan: p, delta: D(p.price_delta) });
    }

    const priced = options
      .map((o) => {
        const perNightNative = money(avgNight.plus(o.delta));
        const totalNative = money(baseTotal.plus(o.delta.mul(nights)));
        return {
          rate_plan: o.plan && {
            rate_plan_id: o.plan.rate_plan_id,
            plan_type: o.plan.plan_type,
            name: o.plan.name,
            includes_breakfast: o.plan.includes_breakfast,
            cancellation_window_hours: o.plan.cancellation_window_hours,
            cancellation_penalty_pct: o.plan.cancellation_penalty_pct,
          },
          per_night: moneyOut(fx, convert(fx, perNightNative, r.currency, out), out),
          total: moneyOut(fx, convert(fx, totalNative, r.currency, out), out),
          _cmp: D(convert(fx, perNightNative, r.currency, out)),
          _budget: D(convert(fx, perNightNative, r.currency, q.budget_currency ?? out)),
        };
      })
      .filter((o) => q.max_price == null || o._budget.lte(q.max_price)) // budget is in budget_currency (default: display currency)
      .sort((a, b) => a._cmp.cmp(b._cmp));
    if (!priced.length) continue;

    const room = {
      room_type_id: r.room_type_id,
      name: r.room_name,
      max_occupancy: r.max_occupancy,
      bed_config: r.bed_config,
      size_sqm: r.size_sqm,
      available_units: r.min_free,
      nights,
      // What a client passes to POST /api/holds to reserve this stay.
      stay: { entity_type: 'room_type', entity_id: r.room_type_id, for_date: q.check_in, nights, units: rooms },
      inventory: r.inventory_ids.map((id, i) => ({ inventory_id: id, for_date: r.dates[i] })),
      from_price: priced[0].per_night,
      options: priced.map(({ _cmp, _budget, ...o }) => o),
      _cmp: priced[0]._cmp,
    };

    if (!cards.has(r.hotel_id)) {
      cards.set(r.hotel_id, {
        hotel: {
          hotel_id: r.hotel_id,
          name: r.hotel_name,
          city: r.city,
          star_rating: r.star_rating,
          guest_score: r.guest_score,
          review_count: r.review_count,
          property_type: r.property_type,
          address_line: r.address_line,
          distance_to_centre_km: r.distance_to_centre_km,
          description: r.description,
        },
        rooms: [],
      });
    }
    cards.get(r.hotel_id).rooms.push(room);
  }

  const list = [...cards.values()];
  for (const c of list) {
    c.rooms.sort((a, b) => a._cmp.cmp(b._cmp));
    c.from_price = c.rooms[0].from_price;
    c._cmp = c.rooms[0]._cmp;
  }
  const sort = q.sort ?? 'price';
  list.sort((a, b) => {
    if (sort === 'rating') return b.hotel.star_rating - a.hotel.star_rating || Number(b.hotel.guest_score ?? 0) - Number(a.hotel.guest_score ?? 0);
    if (sort === 'score') return Number(b.hotel.guest_score ?? 0) - Number(a.hotel.guest_score ?? 0);
    return a._cmp.cmp(b._cmp);
  });
  const results = list.slice(0, q.limit ?? 20).map((c) => {
    c.rooms.forEach((r) => delete r._cmp);
    delete c._cmp;
    return c;
  });

  return {
    query: { ...q, nights, rooms, adults, children },
    currency: q.currency ?? null,
    fx_rate_date: fx.rateDate,
    total: list.length,
    results,
  };
}

const FLIGHT_SQL = `
  SELECT f.flight_id, f.flight_number, al.name AS airline, f.departs_at, f.arrives_at, f.duration_minutes, f.stops,
         oa.iata AS origin_iata, oc.name AS origin_city, da.iata AS dest_iata, dc.name AS dest_city,
         ff.fare_id, ff.cabin_class, ff.fare_class, ff.baggage_kg, ff.cabin_baggage_kg, ff.refundable, ff.changeable,
         ic.inventory_id, ic.price::text AS price, ic.currency,
         (ic.total_units - ic.booked_units - ic.held_units)::int AS free_seats
    FROM flights f
    JOIN airlines al ON al.airline_id = f.airline_id
    JOIN airports oa ON oa.airport_id = f.origin_airport_id
    JOIN cities oc   ON oc.city_id = oa.city_id
    JOIN airports da ON da.airport_id = f.dest_airport_id
    JOIN cities dc   ON dc.city_id = da.city_id
    JOIN flight_fares ff ON ff.flight_id = f.flight_id AND ff.status = 'active'
    JOIN inventory_calendar ic
      ON ic.entity_type = 'flight_fare' AND ic.entity_id = ff.fare_id AND ic.for_date = $3::date
   WHERE f.status = 'active'
     AND (lower(oc.name) = lower($1) OR oa.iata = upper($1))
     AND (lower(dc.name) = lower($2) OR da.iata = upper($2))
     AND ($5::text IS NULL OR ff.cabin_class = $5)
     AND ic.total_units - ic.booked_units - ic.held_units >= $4`;

export async function searchFlights(q) {
  const fx = await fxContext();
  if (q.currency) assertCurrency(fx, q.currency);
  const { rows } = await pool.query(FLIGHT_SQL, [q.origin, q.destination, q.date, q.seats ?? 1, q.cabin ?? null]);

  const results = rows
    .map((r) => {
      const out = q.currency ?? r.currency;
      const price = convert(fx, r.price, r.currency, out);
      return {
        cmp: D(price),
        flight: {
          flight_id: r.flight_id,
          flight_number: r.flight_number,
          airline: r.airline,
          origin: { iata: r.origin_iata, city: r.origin_city },
          destination: { iata: r.dest_iata, city: r.dest_city },
          departs_at: r.departs_at,
          arrives_at: r.arrives_at,
          duration_minutes: r.duration_minutes,
          stops: r.stops,
        },
        fare: {
          fare_id: r.fare_id,
          cabin_class: r.cabin_class,
          fare_class: r.fare_class,
          baggage_kg: r.baggage_kg,
          cabin_baggage_kg: r.cabin_baggage_kg,
          refundable: r.refundable,
          changeable: r.changeable,
        },
        available_seats: r.free_seats,
        inventory_id: r.inventory_id,
        stay: { entity_type: 'flight_fare', entity_id: r.fare_id, for_date: q.date, nights: 1, units: q.seats ?? 1 },
        price: moneyOut(fx, price, out),
      };
    })
    .filter((r) => q.max_price == null || r.cmp.lte(q.max_price))
    .sort((a, b) => a.cmp.cmp(b.cmp))
    .slice(0, q.limit ?? 20)
    .map(({ cmp, ...r }) => r);

  return { query: q, currency: q.currency ?? null, fx_rate_date: fx.rateDate, total: results.length, results };
}

/** Scarce rows worth racing (starter query #1): few units, 1–3 still free. */
export async function findContendedInventory(limit = 20) {
  const { rows } = await pool.query(
    `SELECT ic.inventory_id, ic.for_date::text AS for_date, ic.total_units, ic.booked_units, ic.held_units,
            (ic.total_units - ic.booked_units - ic.held_units)::int AS free_units,
            ic.price::text AS price, ic.currency, h.name AS hotel, rt.name AS room_type
       FROM inventory_calendar ic
       JOIN hotel_room_types rt ON rt.room_type_id = ic.entity_id AND ic.entity_type = 'room_type'
       JOIN hotels h ON h.hotel_id = rt.hotel_id
      WHERE ic.total_units <= 4
        AND ic.total_units - ic.booked_units - ic.held_units BETWEEN 1 AND 3
        AND ic.for_date >= CURRENT_DATE
      ORDER BY (ic.total_units - ic.booked_units - ic.held_units), ic.for_date
      LIMIT $1`,
    [limit],
  );
  return rows;
}
