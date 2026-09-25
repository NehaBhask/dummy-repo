"""
FastMCP server: every tool the assistant can use, in one place.

  Read tools    query Postgres (queries.py): cities, hotels, rooms, flights (direct and one-stop), the traveller's
                bookings and live holds.
  Write tools   call the booking API (rest.py) so holds stay atomic, payments idempotent and failures rolled back.

Who is asking comes from the X-User-Id header of the MCP request (the agent sets it from the signed-in session), never
from a tool argument, so the model cannot read or change anyone else's bookings.

Run:  python mcp_server.py        (streamable HTTP on MCP_HOST:MCP_PORT, path /mcp)
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_headers
from pydantic import BaseModel, Field

import time

import queries
import rest
from settings import MCP_HOST, MCP_PORT

# Enforced here, not just asked of the model: paying happens in a LATER turn than reserving, so the traveller always
# sees the total and answers once more before any money moves. (turn id -> when reserve_trip succeeded in that turn)
_reserved_in_turn: dict[str, float] = {}

mcp = FastMCP(
    name="kognivera-tools",
    instructions=(
        "Tools for a travel booking site: search hotels and flights from the live database, read the traveller's own "
        "bookings and holds, and (after the traveller confirms) reserve, pay for and cancel bookings."
    ),
)

Date = Annotated[str, Field(description="ISO date YYYY-MM-DD", pattern=r"^\d{4}-\d{2}-\d{2}$")]


def current_turn() -> str:
    return get_http_headers().get("x-turn-id") or ""


def current_user() -> str:
    uid = get_http_headers().get("x-user-id")
    if not uid:
        raise ToolError("No signed-in traveller on this request.")
    return uid


class Stay(BaseModel):
    """One thing to hold. Copy the `stay` object from a search result exactly."""

    entity_type: Literal["room_type", "flight_fare"]
    entity_id: str
    for_date: Date
    nights: int = Field(1, ge=1, le=30)
    units: int = Field(1, ge=1, le=9, description="rooms or seats")


# ---------------------------------------------------------------------------------------------- read tools


@mcp.tool(annotations={"readOnlyHint": True})
def list_cities() -> list[dict]:
    """Cities the site covers, with how many hotels each has."""
    return queries.list_cities()


@mcp.tool(annotations={"readOnlyHint": True})
def search_hotels(
    city: str,
    check_in: Date,
    nights: Annotated[int, Field(ge=1, le=30)] = 1,
    rooms: Annotated[int, Field(ge=1, le=5)] = 1,
    adults: Annotated[int, Field(ge=1, le=10)] = 2,
    max_price_per_night: float | None = None,
    min_stars: Annotated[int | None, Field(ge=1, le=5)] = None,
    limit: Annotated[int, Field(ge=1, le=10)] = 6,
) -> dict:
    """Hotels with enough free rooms for the dates, cheapest first. Each room has a `stay` object for reserve_trip.
    Prices are per room per night, room-only rate, in the currency shown."""
    return queries.search_hotels(city, check_in, nights, rooms, adults, max_price_per_night, min_stars, limit)


@mcp.tool(annotations={"readOnlyHint": True})
def get_hotel_rooms(
    hotel_id: str,
    check_in: Date,
    nights: Annotated[int, Field(ge=1, le=30)] = 1,
    rooms: Annotated[int, Field(ge=1, le=5)] = 1,
    adults: Annotated[int, Field(ge=1, le=10)] = 2,
) -> dict:
    """One hotel's room categories for the dates, including fully booked ones (sold_out=true)."""
    return queries.get_hotel_rooms(hotel_id, check_in, nights, rooms, adults)


@mcp.tool(annotations={"readOnlyHint": True})
def search_flights(
    origin: str,
    destination: str,
    date: Date,
    seats: Annotated[int, Field(ge=1, le=6)] = 1,
    include_one_stop: bool = True,
) -> dict:
    """Direct flights and one-stop connections (same-airport layover of 1 to 6 hours) on a date, cheapest first.
    Cities or IATA codes are accepted. A one-stop option has two `stays`: pass both to reserve_trip together."""
    return queries.search_flights(origin, destination, date, seats, include_one_stop)


@mcp.tool(annotations={"readOnlyHint": True})
def get_my_bookings(
    status: Literal["confirmed", "cancelled", "failed", "pending", "partially_confirmed", "refunded"] | None = None,
    limit: Annotated[int, Field(ge=1, le=25)] = 10,
) -> list[dict]:
    """The signed-in traveller's bookings, newest first, with their items."""
    return queries.my_bookings(current_user(), status, limit)


@mcp.tool(annotations={"readOnlyHint": True})
def get_booking(booking_id: str) -> dict:
    """One of the traveller's bookings by id."""
    found = queries.booking(current_user(), booking_id)
    if not found:
        raise ToolError("No such booking for this traveller.")
    return found


@mcp.tool(annotations={"readOnlyHint": True})
def get_my_active_holds() -> list[dict]:
    """Reservations the traveller has made but not paid yet, with the seconds left before they expire."""
    return queries.my_active_holds(current_user())


# ---------------------------------------------------------------------------------------------- write tools


@mcp.tool(annotations={"destructiveHint": False, "idempotentHint": False})
def reserve_trip(
    items: Annotated[list[Stay], Field(min_length=1, max_length=6, description="every room and seat of the trip, together")],
    user_confirmed: Annotated[bool, Field(description="true only after the traveller has said yes to reserving these exact items")],
) -> dict:
    """Hold rooms and seats (nothing is charged). All items are held atomically under one 10-minute timer: either
    every item is held or none is. Fails with sold_out if any item was taken meanwhile."""
    if not user_confirmed:
        return {"ok": False, "error_code": "needs_confirmation", "message": "Ask the traveller to confirm before reserving."}
    out = rest.call("POST", "/api/holds", current_user(), json={"items": [i.model_dump() for i in items]}, idempotent=True)
    if not out["ok"]:
        return out
    body = out["body"]
    hold_ids = [h["hold_id"] for h in body["holds"]]
    turn = current_turn()
    if turn:
        now = time.time()
        for k in [k for k, t in _reserved_in_turn.items() if now - t > 900]:
            del _reserved_in_turn[k]
        _reserved_in_turn[turn] = now
    return {
        "ok": True,
        "hold_ids": hold_ids,
        "expires_at": body["expires_at"],
        "price_if_paid_now": queries.hold_quote(current_user(), hold_ids),
        "note": "Reserved, NOT paid. It now shows on the traveller's My trip page with a countdown, where they can also pay. "
                "Tell them the total and the expiry time and ask if they want you to pay. "
                "Do not call pay_and_confirm in this same reply: it needs their next message.",
    }


@mcp.tool(annotations={"destructiveHint": False, "idempotentHint": False})
def pay_and_confirm(
    hold_ids: Annotated[list[str], Field(min_length=1, max_length=12)],
    user_confirmed: Annotated[bool, Field(description="true only after the traveller has said yes to paying for these holds")],
    payment_method: Literal["card", "upi", "netbanking", "wallet"] = "card",
) -> dict:
    """Turn active holds into a confirmed booking and take payment (a demo gateway: nothing real is charged).
    If any line fails the whole booking is rolled back and nothing is charged."""
    if not user_confirmed:
        return {"ok": False, "error_code": "needs_confirmation", "message": "Ask the traveller to confirm payment first."}
    if current_turn() and current_turn() in _reserved_in_turn:
        return {
            "ok": False,
            "error_code": "payment_needs_its_own_confirmation",
            "message": "You just reserved these items in this same reply. Show the traveller the total and ask whether to pay; "
                       "call pay_and_confirm only after they answer.",
        }
    out = rest.call(
        "POST", "/api/bookings", current_user(), idempotent=True,
        json={"hold_ids": hold_ids, "payment": {"method": payment_method}, "channel": "agent"},
    )
    if not out["ok"]:
        return {**out, "rolled_back": True}
    b = out["body"]["booking"]
    return {
        "ok": True,
        "booking_id": b["booking_id"],
        "reference": b["booking_reference"],
        "status": b["status"],
        "total": b["total_amount"],
        "currency": b["currency"],
        "items": [i["title"] for i in b.get("items", [])],
    }


@mcp.tool(annotations={"destructiveHint": False})
def release_holds(hold_ids: Annotated[list[str], Field(min_length=1, max_length=12)]) -> dict:
    """Give reserved (unpaid) items back so others can book them."""
    uid = current_user()
    results = [rest.call("POST", f"/api/holds/{h}/release", uid) for h in hold_ids]
    return {
        "ok": all(r["ok"] for r in results),
        "released": sum(r["ok"] for r in results),
        "errors": [r["message"] for r in results if not r["ok"]],
    }


@mcp.tool(annotations={"destructiveHint": True})
def cancel_booking(
    booking_id: str,
    user_confirmed: Annotated[bool, Field(description="true only after the traveller has said yes to cancelling")],
) -> dict:
    """Cancel a confirmed booking: refunds it and returns the rooms and seats to stock. `booking_id` is the id that
    starts with bkg_ (from get_my_bookings), not the 6-character reference."""
    if not user_confirmed:
        return {"ok": False, "error_code": "needs_confirmation", "message": "Ask the traveller to confirm the cancellation."}
    out = rest.call("POST", f"/api/bookings/{booking_id}/cancel", current_user(), json={"reason": "cancelled via assistant"})
    if not out["ok"]:
        return out
    b = out["body"].get("booking", {})
    return {"ok": True, "booking_id": booking_id, "status": b.get("status", "cancelled")}


if __name__ == "__main__":
    mcp.run(transport="http", host=MCP_HOST, port=MCP_PORT, path="/mcp", show_banner=False)
