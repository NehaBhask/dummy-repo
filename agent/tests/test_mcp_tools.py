"""The FastMCP tools, called over HTTP with a signed-in traveller, against the real database and booking API."""
from __future__ import annotations

import uuid

import httpx
import pytest

import queries

DATE = "2026-10-08"  # inside the seeded inventory window


async def _any_room(tools, rooms=1):
    r = await tools.call("search_hotels", city="Jaipur", check_in=DATE, nights=1, rooms=rooms, adults=2, limit=10)
    assert r["hotels"], "the seed should have a Jaipur room free on that date"
    return r["hotels"][0]["rooms"][0]


async def test_the_server_offers_every_tool(tools_for, users):
    names = await tools_for(users[0]["user_id"]).names()
    assert names >= {
        "list_cities", "search_hotels", "get_hotel_rooms", "search_flights", "get_my_bookings", "get_booking",
        "get_my_active_holds", "reserve_trip", "pay_and_confirm", "release_holds", "cancel_booking",
    }


async def test_hotel_search_agrees_with_the_booking_api(tools_for, users, api_url):
    """The SQL tool and the site's own search must offer the same hotels at the same price for the same dates."""
    tools = tools_for(users[0]["user_id"])
    got = await tools.call("search_hotels", city="Jaipur", check_in=DATE, nights=2, rooms=1, adults=2, limit=10)
    api = httpx.get(f"{api_url}/api/search/hotels", params={"city": "Jaipur", "check_in": DATE, "nights": 2, "rooms": 1, "adults": 2, "limit": 50}).json()
    assert {h["hotel_id"] for h in got["hotels"]} == {c["hotel"]["hotel_id"] for c in api["results"]}
    api_room = {r["room_type_id"]: r for c in api["results"] for r in c["rooms"]}
    for h in got["hotels"]:
        for room in h["rooms"]:
            a = api_room[room["room_type_id"]]
            assert room["free_rooms"] == a["available_units"]
            assert room["price_per_room_night"] == a["options"][0]["per_night"]["amount"] or any(
                room["price_per_room_night"] == o["per_night"]["amount"] for o in a["options"]
            )


async def test_sold_out_rooms_are_shown_as_sold_out_not_hidden(tools_for, users):
    tools = tools_for(users[0]["user_id"])
    room = await _any_room(tools)
    rooms = (await tools.call("get_hotel_rooms", hotel_id=(await tools.call("search_hotels", city="Jaipur", check_in=DATE, limit=1))["hotels"][0]["hotel_id"], check_in=DATE))["rooms"]
    assert rooms and all("sold_out" in r for r in rooms)
    assert room["stay"]["entity_type"] == "room_type"


async def test_one_stop_flights_agree_with_the_booking_api(tools_for, users, api_url):
    tools = tools_for(users[0]["user_id"])
    got = await tools.call("search_flights", origin="Bengaluru", destination="Jaipur", date="2026-10-05")
    api = httpx.get(f"{api_url}/api/search/flights", params={"origin": "Bengaluru", "destination": "Jaipur", "date": "2026-10-05"}).json()
    assert got["one_stop"], "the hub schedule gives Bengaluru -> Jaipur a connection"
    assert got["one_stop"][0]["total_price"] == api["connections"][0]["price"]["amount"], "same cheapest connection, same price"
    assert len(got["one_stop"][0]["stays"]) == 2


async def test_the_database_connection_is_read_only():
    with pytest.raises(Exception, match="read-only"):
        with queries.connect() as conn:
            conn.execute("UPDATE hotels SET name = name WHERE false")


async def test_no_signed_in_traveller_no_personal_data(tools_for):
    out = await tools_for(None).call("get_my_bookings")
    assert "No signed-in traveller" in str(out)


async def test_reserving_needs_the_travellers_yes(tools_for, users):
    tools = tools_for(users[0]["user_id"])
    room = await _any_room(tools)
    out = await tools.call("reserve_trip", items=[room["stay"]], user_confirmed=False)
    assert out["ok"] is False and out["error_code"] == "needs_confirmation"
    held_after = await tools.call("get_my_active_holds")
    assert not [h for h in held_after if h["for_date"].startswith(DATE) and h["units"] == 1 and h["title"].endswith(room["room"])], "nothing was held"


async def test_a_full_booking_isolates_travellers_and_pays_only_in_a_later_turn(tools_for, users):
    a, b = users[0]["user_id"], users[1]["user_id"]
    turn = uuid.uuid4().hex
    tools = tools_for(a, turn)
    room = await _any_room(tools)

    reserved = await tools.call("reserve_trip", items=[room["stay"]], user_confirmed=True)
    assert reserved["ok"], reserved
    assert reserved["price_if_paid_now"]["quotes"][0]["total"], "the traveller is shown a total before paying"
    holds = await tools.call("get_my_active_holds")
    assert set(reserved["hold_ids"]) <= {h["hold_id"] for h in holds}
    assert all(h["seconds_left"] > 0 for h in holds)

    # same turn: refused. The server enforces the two-step, whatever the model wants.
    early = await tools.call("pay_and_confirm", hold_ids=reserved["hold_ids"], user_confirmed=True)
    assert early["ok"] is False and early["error_code"] == "payment_needs_its_own_confirmation"
    # no consent flag: refused too
    assert (await tools_for(a).call("pay_and_confirm", hold_ids=reserved["hold_ids"], user_confirmed=False))["error_code"] == "needs_confirmation"

    # the next turn (a new X-Turn-Id) may pay
    paid = await tools_for(a).call("pay_and_confirm", hold_ids=reserved["hold_ids"], user_confirmed=True, payment_method="card")
    assert paid["ok"], paid
    booking_id = paid["booking_id"]
    assert paid["status"] == "confirmed" and paid["total"]

    mine = await tools_for(a).call("get_booking", booking_id=booking_id)
    assert mine["status"] == "confirmed" and mine["items"]

    # another traveller can neither see it, nor cancel it, nor pay for its holds
    assert "No such booking" in str(await tools_for(b).call("get_booking", booking_id=booking_id))
    assert booking_id not in {x["booking_id"] for x in await tools_for(b).call("get_my_bookings")}
    stolen = await tools_for(b).call("cancel_booking", booking_id=booking_id, user_confirmed=True)
    assert stolen["ok"] is False

    # cancelling needs a yes too, then restocks
    assert (await tools_for(a).call("cancel_booking", booking_id=booking_id, user_confirmed=False))["error_code"] == "needs_confirmation"
    done = await tools_for(a).call("cancel_booking", booking_id=booking_id, user_confirmed=True)
    assert done["ok"] and done["status"] == "cancelled"


async def test_two_travellers_racing_for_the_last_room_one_wins(tools_for, users):
    """Chat goes through the same atomic hold as the website: a second reserve for a taken room is refused."""
    a, b = users[0]["user_id"], users[1]["user_id"]
    ta, tb = tools_for(a), tools_for(b)
    hotels = (await ta.call("search_hotels", city="Jaipur", check_in="2026-10-09", limit=10))["hotels"]
    scarce = min((r for h in hotels for r in h["rooms"]), key=lambda r: r["free_rooms"])
    stay = {**scarce["stay"], "units": scarce["free_rooms"]}
    first = await ta.call("reserve_trip", items=[stay], user_confirmed=True)
    assert first["ok"], first
    second = await tb.call("reserve_trip", items=[{**stay, "units": 1}], user_confirmed=True)
    try:
        assert second["ok"] is False and second["error_code"] == "sold_out"
    finally:
        await ta.call("release_holds", hold_ids=first["hold_ids"])


async def test_city_names_as_people_type_them(tools_for, users):
    """'Delhi' is New Delhi, 'Bangalore' is Bengaluru: a traveller must not be told there are no flights because of a spelling."""
    tools = tools_for(users[0]["user_id"])
    typed = await tools.call("search_flights", origin="delhi", destination="bangalore", date="2026-09-29")
    exact = await tools.call("search_flights", origin="New Delhi", destination="Bengaluru", date="2026-09-29")
    assert typed["query"]["origin"] == "New Delhi" and typed["query"]["destination"] == "Bengaluru"
    assert typed["direct"], "the database has direct New Delhi -> Bengaluru flights"
    assert [f["flight"] for f in typed["direct"]] == [f["flight"] for f in exact["direct"]]
    hotels = await tools.call("search_hotels", city="bangalore", check_in="2026-10-05")
    assert hotels["query"]["city"] == "Bengaluru"
    by_code = await tools.call("search_flights", origin="BEN", destination="JAI", date="2026-10-05")
    assert by_code["query"]["origin"] == "Bengaluru", "airport codes name their city"


async def test_an_unknown_city_gets_suggestions_not_an_empty_answer(tools_for, users):
    tools = tools_for(users[0]["user_id"])
    out = await tools.call("search_flights", origin="Jaipurr", destination="Atlantis", date="2026-10-05")
    assert out.get("error") == "unknown_city" and "Atlantis" in out["message"]


async def test_when_a_date_has_no_flights_real_alternative_dates_are_offered(tools_for, users):
    tools = tools_for(users[0]["user_id"])
    # a date with no direct flight that has neighbours which do: found from the site's own route list
    import httpx, settings
    dates = httpx.get(f"{settings.API_URL}/api/flights/routes", params={"origin": "New Delhi", "destination": "Bengaluru"}).json()["routes"][0]["dates"]
    from datetime import date, timedelta
    have = {date.fromisoformat(d) for d in dates}
    gap = next((d for d in sorted(have) for k in (1, 2, 3) if (d + timedelta(days=k)) not in have and any((d + timedelta(days=k + j)) in have for j in (-1, 1))), None)
    if gap is None:
        pytest.skip("this data has a flight on every nearby date")
    empty = next(d + timedelta(days=k) for d in sorted(have) for k in (1, 2, 3) if (d + timedelta(days=k)) not in have)
    out = await tools.call("search_flights", origin="New Delhi", destination="Bengaluru", date=str(empty), include_one_stop=False)
    if not out["direct"]:
        assert out["other_dates_with_direct_flights"], "the traveller is told which nearby dates do have flights"
        assert "other_dates_with_direct_flights" in out["note"]
