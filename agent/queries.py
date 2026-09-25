"""
Read-only database queries behind the MCP tools.

Every function is a fixed, parameterised query (no free-form SQL from the model), on a connection that Postgres
itself refuses to write on. What a traveller can see about *their own* bookings and holds is filtered by the
user id the MCP server took from the request, never from anything the model says.

Availability follows the same rule as the booking API: free = total - booked - held. These are snapshots; the hold
(reserve) is what actually locks stock, and it re-checks under a row lock.
"""
from __future__ import annotations

import difflib
import functools
import json
import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.rows import dict_row

from settings import DATABASE_URL

MIN_LAYOVER_MIN = 60   # same rule as backend/src/modules/inventory/search.js
MAX_LAYOVER_MIN = 360


def connect() -> psycopg.Connection:
    # default_transaction_read_only: the database rejects any write on this connection, whatever the SQL says.
    return psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row, options="-c default_transaction_read_only=on")


def plain(value: Any) -> Any:
    """JSON-safe copy (Decimal -> string, dates -> ISO)."""
    return json.loads(json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o)))


def _rows(sql: str, params: dict) -> list[dict]:
    with connect() as conn:
        return conn.execute(sql, params).fetchall()


# ------------------------------------------------------------------------------------------------ reference


def list_cities() -> list[dict]:
    return plain(_rows(
        """SELECT c.name AS city, c.state, c.country_code,
                  (SELECT count(*) FROM hotels h WHERE h.city_id = c.city_id AND h.status = 'active')::int AS hotels
             FROM cities c WHERE c.status = 'active' ORDER BY c.name""", {}))


# ------------------------------------------------------------------------------------------------ city names

# What travellers actually type. Keys are lower case; values are the names in the cities table.
ALIASES = {
    "delhi": "New Delhi", "nai delhi": "New Delhi", "dilli": "New Delhi", "ncr": "New Delhi",
    "bangalore": "Bengaluru", "bengalooru": "Bengaluru", "blr": "Bengaluru",
    "bombay": "Mumbai", "calcutta": "Kolkata", "madras": "Chennai", "goa": "Panaji", "panjim": "Panaji",
    "mysore": "Mysuru", "cochin": "Kochi", "ernakulam": "Kochi", "trivandrum": "Thiruvananthapuram",
    "banaras": "Varanasi", "benares": "Varanasi", "kashi": "Varanasi", "allepey": "Alleppey", "alappuzha": "Alleppey",
    "pondy": "Pondicherry", "puducherry": "Pondicherry", "vizag": "Visakhapatnam", "kathmandu valley": "Kathmandu",
    "singapura": "Singapore", "bali island": "Bali", "kl": "Kuala Lumpur", "gangtok sikkim": "Gangtok",
}


@functools.lru_cache(maxsize=1)
def _city_names() -> tuple[str, ...]:
    return tuple(r["city"] for r in _rows("SELECT name AS city FROM cities WHERE status = 'active' ORDER BY name", {}))


@functools.lru_cache(maxsize=1)
def _iata_to_city() -> dict[str, str]:
    return {r["iata"]: r["city"] for r in _rows("SELECT a.iata, c.name AS city FROM airports a JOIN cities c ON c.city_id = a.city_id", {})}


def resolve_city(name: str) -> tuple[str | None, list[str]]:
    """(the city's name in the database, [] ) or (None, suggestions). 'delhi' -> 'New Delhi', 'bangalore' -> 'Bengaluru'."""
    cities = _city_names()
    by_lower = {c.lower(): c for c in cities}
    k = " ".join(name.strip().lower().split())
    if k in by_lower:
        return by_lower[k], []
    if k in ALIASES and ALIASES[k].lower() in by_lower:
        return by_lower[ALIASES[k].lower()], []
    if len(k) == 3 and k.upper() in _iata_to_city():
        return _iata_to_city()[k.upper()], []  # an airport code names its city
    contains = [c for c in cities if k and (k in c.lower() or c.lower() in k)]
    if len(contains) == 1:
        return contains[0], []
    close = difflib.get_close_matches(name.strip(), list(cities), n=3, cutoff=0.6)
    if len(close) >= 1 and difflib.SequenceMatcher(None, k, close[0].lower()).ratio() >= 0.85:
        return close[0], []
    return None, contains[:5] or close


def _unknown_city(name: str, suggestions: list[str]) -> dict:
    return plain({
        "error": "unknown_city",
        "message": f"'{name}' is not a city on this site." + (f" Did you mean: {', '.join(suggestions)}?" if suggestions else " Use list_cities to see the cities covered."),
        "did_you_mean": suggestions,
    })


# ------------------------------------------------------------------------------------------------ hotels

HOTEL_SQL = """
SELECT h.hotel_id, h.name AS hotel_name, h.star_rating, h.guest_score::float AS guest_score, c.name AS city,
       rt.room_type_id, rt.name AS room_name, rt.max_occupancy, rt.max_adults, rt.bed_config,
       round(avg(ic.price), 2) AS per_night, min(ic.currency) AS currency,
       min(ic.total_units - ic.booked_units - ic.held_units)::int AS free_units,
       bool_or(ic.closed_to_arrival) FILTER (WHERE ic.for_date = %(check_in)s::date) AS closed,
       max(ic.min_stay_nights) FILTER (WHERE ic.for_date = %(check_in)s::date) AS min_stay
  FROM hotels h
  JOIN cities c ON c.city_id = h.city_id
  JOIN hotel_room_types rt ON rt.hotel_id = h.hotel_id AND rt.status = 'active'
  JOIN inventory_calendar ic
    ON ic.entity_type = 'room_type' AND ic.entity_id = rt.room_type_id
   AND ic.for_date >= %(check_in)s::date AND ic.for_date < %(check_in)s::date + %(nights)s::int
 WHERE h.status = 'active'
   AND (%(city)s::text IS NULL OR lower(c.name) = lower(%(city)s))
   AND (%(hotel_id)s::text IS NULL OR h.hotel_id = %(hotel_id)s)
 GROUP BY h.hotel_id, c.city_id, rt.room_type_id
HAVING count(*) = %(nights)s::int
"""


def _hotel_rows(city: str | None, hotel_id: str | None, check_in: str, nights: int, rooms: int, adults: int, *, include_sold_out: bool):
    out = []
    for r in _rows(HOTEL_SQL, {"city": city, "hotel_id": hotel_id, "check_in": check_in, "nights": nights}):
        if r["closed"] or nights < (r["min_stay"] or 1):
            continue
        if math.ceil(adults / rooms) > min(r["max_adults"], r["max_occupancy"]):
            continue
        if not include_sold_out and r["free_units"] < rooms:
            continue
        out.append(r)
    return out


def _room_view(r: dict, check_in: str, nights: int, rooms: int) -> dict:
    per_night = Decimal(str(r["per_night"]))
    return {
        "room_type_id": r["room_type_id"],
        "room": r["room_name"],
        "bed": r["bed_config"],
        "sleeps": r["max_occupancy"],
        "free_rooms": r["free_units"],
        "sold_out": r["free_units"] <= 0,
        "price_per_room_night": str(per_night),
        "currency": r["currency"],
        "total_for_stay": str(per_night * nights * rooms),
        # exactly what reserve_trip takes to hold this room
        "stay": {"entity_type": "room_type", "entity_id": r["room_type_id"], "for_date": check_in, "nights": nights, "units": rooms},
    }


def search_hotels(city: str, check_in: str, nights: int = 1, rooms: int = 1, adults: int = 2,
                  max_price_per_night: float | None = None, min_stars: int | None = None, limit: int = 6) -> dict:
    resolved, suggestions = resolve_city(city)
    if not resolved:
        return _unknown_city(city, suggestions)
    city = resolved
    hotels: dict[str, dict] = {}
    for r in _hotel_rows(city, None, check_in, nights, rooms, adults, include_sold_out=False):
        if min_stars and r["star_rating"] < min_stars:
            continue
        if max_price_per_night is not None and Decimal(str(r["per_night"])) > Decimal(str(max_price_per_night)):
            continue
        h = hotels.setdefault(r["hotel_id"], {
            "hotel_id": r["hotel_id"], "hotel": r["hotel_name"], "city": r["city"], "stars": r["star_rating"],
            "guest_score": r["guest_score"], "rooms": [],
        })
        h["rooms"].append(_room_view(r, check_in, nights, rooms))
    result = sorted(hotels.values(), key=lambda h: min(Decimal(x["price_per_room_night"]) for x in h["rooms"]))[:limit]
    for h in result:
        h["rooms"].sort(key=lambda x: Decimal(x["price_per_room_night"]))
    return plain({
        "query": {"city": city, "check_in": check_in, "nights": nights, "rooms": rooms, "adults": adults},
        "count": len(result),
        "hotels": result,
        "note": None if result else "No hotel in that city has enough free rooms for those dates. Try other dates or a nearby city.",
    })


def get_hotel_rooms(hotel_id: str, check_in: str, nights: int = 1, rooms: int = 1, adults: int = 2) -> dict:
    """One hotel's room categories for the dates, including the ones that are fully booked."""
    found = _hotel_rows(None, hotel_id, check_in, nights, rooms, adults, include_sold_out=True)
    if not found:
        return plain({"hotel_id": hotel_id, "rooms": [], "note": "No room categories are open for those dates at this hotel."})
    first = found[0]
    return plain({
        "hotel_id": hotel_id, "hotel": first["hotel_name"], "city": first["city"], "stars": first["star_rating"],
        "guest_score": first["guest_score"],
        "query": {"check_in": check_in, "nights": nights, "rooms": rooms, "adults": adults},
        "rooms": sorted((_room_view(r, check_in, nights, rooms) for r in found), key=lambda x: (x["sold_out"], Decimal(x["price_per_room_night"]))),
    })


# ------------------------------------------------------------------------------------------------ flights

# One row per flight: its cheapest fare with enough free seats, and the dated inventory row it books from.
LEG_CTE = """
leg AS (
  SELECT DISTINCT ON (f.flight_id)
         f.flight_id, f.flight_number, al.name AS airline, f.departs_at, f.arrives_at, f.duration_minutes,
         f.origin_airport_id, f.dest_airport_id,
         oa.iata AS origin_iata, oc.name AS origin_city, oc.city_id AS origin_city_id,
         da.iata AS dest_iata, dc.name AS dest_city, dc.city_id AS dest_city_id,
         ff.fare_id, ff.cabin_class, ic.inventory_id, ic.price, ic.currency, ic.for_date,
         (ic.total_units - ic.booked_units - ic.held_units)::int AS free_seats
    FROM flights f
    JOIN airlines al ON al.airline_id = f.airline_id
    JOIN airports oa ON oa.airport_id = f.origin_airport_id JOIN cities oc ON oc.city_id = oa.city_id
    JOIN airports da ON da.airport_id = f.dest_airport_id   JOIN cities dc ON dc.city_id = da.city_id
    JOIN flight_fares ff ON ff.flight_id = f.flight_id AND ff.status = 'active' AND ff.cabin_class = 'economy'
    JOIN inventory_calendar ic ON ic.entity_type = 'flight_fare' AND ic.entity_id = ff.fare_id
     AND ic.for_date BETWEEN %(date)s::date AND %(date)s::date + 1
   WHERE f.status = 'active' AND ic.total_units - ic.booked_units - ic.held_units >= %(seats)s
   ORDER BY f.flight_id, ic.price
)"""

DIRECT_SQL = f"""
WITH {LEG_CTE}
SELECT * FROM leg
 WHERE for_date = %(date)s::date
   AND (lower(origin_city) = lower(%(origin)s) OR origin_iata = upper(%(origin)s))
   AND (lower(dest_city) = lower(%(dest)s) OR dest_iata = upper(%(dest)s))
   AND origin_city_id <> dest_city_id
 ORDER BY price LIMIT 8
"""

CONNECTION_SQL = f"""
WITH {LEG_CTE}
SELECT to_jsonb(a) AS a, to_jsonb(b) AS b
  FROM leg a JOIN leg b
    ON b.origin_airport_id = a.dest_airport_id
   AND b.departs_at BETWEEN a.arrives_at + make_interval(mins => {MIN_LAYOVER_MIN})
                        AND a.arrives_at + make_interval(mins => {MAX_LAYOVER_MIN})
 WHERE a.for_date = %(date)s::date
   AND (lower(a.origin_city) = lower(%(origin)s) OR a.origin_iata = upper(%(origin)s))
   AND (lower(b.dest_city) = lower(%(dest)s) OR b.dest_iata = upper(%(dest)s))
   AND a.origin_city_id <> b.dest_city_id
   AND a.dest_city_id <> a.origin_city_id AND b.dest_city_id <> a.dest_city_id
"""


def hm(minutes: int) -> str:
    """Durations as text (the model misreads 455 as 4h55, so it is given '7h 35m')."""
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _leg_view(r: dict, seats: int) -> dict:
    return {
        "flight": r["flight_number"], "airline": r["airline"],
        "from": r["origin_iata"], "from_city": r["origin_city"], "to": r["dest_iata"], "to_city": r["dest_city"],
        "departs": str(r["departs_at"]), "arrives": str(r["arrives_at"]), "duration": hm(r["duration_minutes"]),
        "free_seats": r["free_seats"], "price_per_seat": str(r["price"]), "currency": r["currency"],
        "stay": {"entity_type": "flight_fare", "entity_id": r["fare_id"], "for_date": str(r["for_date"])[:10], "nights": 1, "units": seats},
    }


DATES_SQL = """
SELECT DISTINCT ic.for_date::text AS d
  FROM flights f
  JOIN airports oa ON oa.airport_id = f.origin_airport_id JOIN cities oc ON oc.city_id = oa.city_id
  JOIN airports da ON da.airport_id = f.dest_airport_id   JOIN cities dc ON dc.city_id = da.city_id
  JOIN flight_fares ff ON ff.flight_id = f.flight_id AND ff.status = 'active'
  JOIN inventory_calendar ic ON ic.entity_type = 'flight_fare' AND ic.entity_id = ff.fare_id
   AND ic.for_date BETWEEN %(date)s::date - 3 AND %(date)s::date + 10
   AND ic.total_units - ic.booked_units - ic.held_units >= %(seats)s
 WHERE f.status = 'active' AND oc.city_id <> dc.city_id
   AND (lower(oc.name) = lower(%(origin)s) OR oa.iata = upper(%(origin)s))
   AND (lower(dc.name) = lower(%(dest)s) OR da.iata = upper(%(dest)s))
 ORDER BY d LIMIT 10
"""


def search_flights(origin: str, destination: str, date: str, seats: int = 1, include_one_stop: bool = True) -> dict:
    o, o_sugg = resolve_city(origin)
    d, d_sugg = resolve_city(destination)
    if not o:
        return _unknown_city(origin, o_sugg)
    if not d:
        return _unknown_city(destination, d_sugg)
    origin, destination = o, d
    params = {"origin": origin, "dest": destination, "date": date, "seats": seats}
    direct = [_leg_view(r, seats) for r in _rows(DIRECT_SQL, params)]
    one_stop = []
    if include_one_stop:
        conns = []
        for row in _rows(CONNECTION_SQL, params):
            a, b = row["a"], row["b"]
            # to_jsonb() gives strings; normalise the times so the layover can be computed
            for leg in (a, b):
                leg["departs_at"] = datetime.fromisoformat(leg["departs_at"])
                leg["arrives_at"] = datetime.fromisoformat(leg["arrives_at"])
                leg["price"] = Decimal(str(leg["price"]))
            conns.append({
                "via": {"iata": a["dest_iata"], "city": a["dest_city"]},
                "layover": hm(int((b["departs_at"] - a["arrives_at"]).total_seconds() // 60)),
                "total_travel_time": hm(int((b["arrives_at"] - a["departs_at"]).total_seconds() // 60)),
                "total_price": str(a["price"] + b["price"]),
                "currency": a["currency"],
                "free_seats": min(a["free_seats"], b["free_seats"]),
                "legs": [_leg_view(a, seats), _leg_view(b, seats)],
                # both legs are held in ONE reserve_trip call, so they are booked together or not at all
                "stays": [_leg_view(a, seats)["stay"], _leg_view(b, seats)["stay"]],
            })
        one_stop = sorted(conns, key=lambda c: Decimal(c["total_price"]))[:5]
    other_dates: list[str] = []
    if not direct and not one_stop:
        other_dates = [r["d"] for r in _rows(DATES_SQL, {"origin": origin, "dest": destination, "date": date, "seats": seats})]
    return plain({
        "query": {"origin": origin, "destination": destination, "date": date, "seats": seats},
        "direct": direct,
        "one_stop": one_stop,
        # when nothing flies that day: the dates within a few days that do have direct flights (never guess dates)
        "other_dates_with_direct_flights": other_dates,
        "note": None if (direct or one_stop) else (
            "No flights on that date. Direct flights do exist on the dates in other_dates_with_direct_flights: offer those."
            if other_dates else "No direct or one-stop flights with enough seats on that date or within a few days of it."
        ),
    })


# ------------------------------------------------------------------------------------------------ the traveller's own data

BOOKING_ITEMS_SQL = """
SELECT booking_id, title, entity_type, for_date, units, line_total::text AS line_total, currency, status
  FROM booking_items WHERE booking_id = ANY(%(ids)s) ORDER BY booking_id, for_date NULLS LAST, title
"""


def _with_items(bookings: list[dict]) -> list[dict]:
    if not bookings:
        return []
    items = _rows(BOOKING_ITEMS_SQL, {"ids": [b["booking_id"] for b in bookings]})
    for b in bookings:
        b["items"] = [{k: v for k, v in i.items() if k != "booking_id"} for i in items if i["booking_id"] == b["booking_id"]]
    return bookings


def my_bookings(user_id: str, status: str | None = None, limit: int = 10) -> list[dict]:
    rows = _rows(
        """SELECT booking_id, booking_reference AS reference, status, total_amount::text AS total, currency,
                  created_at, confirmed_at, cancelled_at
             FROM bookings
            WHERE user_id = %(u)s AND (%(status)s::text IS NULL OR status = %(status)s)
            ORDER BY created_at DESC LIMIT %(limit)s""",
        {"u": user_id, "status": status, "limit": max(1, min(limit, 25))},
    )
    return plain(_with_items(rows))


def booking(user_id: str, booking_id: str) -> dict | None:
    rows = _rows(
        """SELECT booking_id, booking_reference AS reference, status, total_amount::text AS total, tax_amount::text AS tax,
                  currency, created_at, confirmed_at, cancelled_at, cancellation_reason
             FROM bookings WHERE booking_id = %(id)s AND user_id = %(u)s""",
        {"id": booking_id, "u": user_id},
    )
    return plain(_with_items(rows)[0]) if rows else None


TAX_PCT = 12  # same rule as the booking API (backend/src/money.js)


def hold_quote(user_id: str, hold_ids: list[str]) -> dict:
    """What holds cost if paid now: subtotal, 12% tax and total, per currency of the held rows (room-only rates)."""
    rows = _rows(
        """SELECT ic.currency, sum(ic.price * h.units) AS subtotal
             FROM holds h JOIN inventory_calendar ic ON ic.inventory_id = h.inventory_id
            WHERE h.hold_id = ANY(%(ids)s) AND h.user_id = %(u)s
            GROUP BY ic.currency""",
        {"ids": hold_ids, "u": user_id},
    )
    quotes = []
    for r in rows:
        sub = Decimal(r["subtotal"])
        tax = (sub * TAX_PCT / 100).quantize(Decimal("0.01"))
        quotes.append({"currency": r["currency"], "subtotal": str(sub), "tax": str(tax), "total": str(sub + tax)})
    return plain({"quotes": quotes})


def my_active_holds(user_id: str) -> list[dict]:
    return plain(_rows(
        """SELECT h.hold_id, h.units, h.expires_at, greatest(0, extract(epoch FROM h.expires_at - now()))::int AS seconds_left,
                  ic.for_date, ic.entity_type,
                  coalesce(hh.name || ' · ' || rt.name, f.flight_number || ' ' || oa.iata || '→' || da.iata) AS title
             FROM holds h
             JOIN inventory_calendar ic ON ic.inventory_id = h.inventory_id
             LEFT JOIN hotel_room_types rt ON ic.entity_type = 'room_type' AND rt.room_type_id = ic.entity_id
             LEFT JOIN hotels hh ON hh.hotel_id = rt.hotel_id
             LEFT JOIN flight_fares ff ON ic.entity_type = 'flight_fare' AND ff.fare_id = ic.entity_id
             LEFT JOIN flights f ON f.flight_id = ff.flight_id
             LEFT JOIN airports oa ON oa.airport_id = f.origin_airport_id
             LEFT JOIN airports da ON da.airport_id = f.dest_airport_id
            WHERE h.user_id = %(u)s AND h.status = 'active' AND h.expires_at > now()
            ORDER BY h.expires_at""",
        {"u": user_id},
    ))
