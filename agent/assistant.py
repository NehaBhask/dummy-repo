"""
The booking assistant: a LangChain agent whose tools all come from the FastMCP server through
langchain-mcp-adapters' MultiServerMCPClient. The LLM is the same Gemini model the rest of the app uses.

One MCP client is built per chat request so the signed-in traveller's id travels as the X-User-Id header of every
tool call (the model never sees, chooses or can change it).
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import date
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient

from settings import AGENT_MAX_STEPS, AGENT_TIMEOUT_S, GEMINI_API_KEY, GEMINI_MODELS, MCP_URL

SYSTEM_PROMPT = """You are the Kognivera booking assistant, inside a travel website (hotels and flights).
You talk to one signed-in traveller and can search, and (with their consent) book, using tools.

FACTS
- Never invent hotels, flights, prices, availability or booking details. Get them from tools; if a tool returns
  nothing, say so plainly and suggest a change (other dates, another city).
- Today is {today}. Dates you pass to tools are ISO (YYYY-MM-DD). Work out "tomorrow", "next Friday" etc. yourself.
- Listed prices exclude the 12% tax; the booking total adds it. Say "plus 12% tax" when quoting a search price.
- City names: pass the city as the traveller said it ('Delhi', 'Bangalore'); the tools resolve common names. If a tool
  returns error=unknown_city, offer its did_you_mean cities. Never say there are no flights or hotels for a route unless
  a tool said so; when a date has none, offer other_dates_with_direct_flights.
- Use the durations exactly as the tools word them (for example '7h 35m'); do not recompute them.
- Prices come back in the currency the tool shows (mostly INR). The traveller's home currency is {currency}; only
  mention a conversion if a tool gave you one.
- Availability is live and can change: a room shown a minute ago may be gone when you reserve. Say so if reserving fails.

BOOKING SAFETY (strict)
- Reserving, paying and cancelling need the traveller's explicit yes in THIS conversation. Before calling
  reserve_trip, pay_and_confirm or cancel_booking, restate exactly what will happen (items, dates, rooms/seats, total
  price) and wait for a clear yes. Only then call the tool with user_confirmed=true. Never guess consent.
- Book in two steps, in two separate replies. (1) After their yes, reserve_trip holds everything together for 10
  minutes and charges nothing. Then STOP: tell them the total (price_if_paid_now, taxes included), when the hold
  expires, and ask whether to pay. (2) Only after they answer yes to THAT question, call pay_and_confirm (a demo payment
  gateway: no real money). If they decline, release_holds. "Yes, reserve it" is NOT consent to pay.
- Hotel + flight, or both legs of a one-stop flight, go into ONE reserve_trip call so they are held together.
  Copy each `stay` object from the search result unchanged.
- If a tool says sold_out or fails, tell the traveller what happened and offer an alternative. Nothing is charged
  when a booking fails; say that.
- Only act on the signed-in traveller's own data. If asked about someone else, decline.

STYLE
- Be brief and concrete: 2 to 5 short lines, or a short list of at most 4 options with price and a key fact.
- Reply in the language the traveller writes in (English or Hindi).
- After you book, give the booking reference and total. Do not paste raw ids unless asked.

WHAT THE TRAVELLER IS LOOKING AT RIGHT NOW
{page_context}
Use this to resolve "this hotel", "these dates", "my trip", "here". If they ask something the page already answers,
answer from it; use tools for anything you cannot see.
"""


def describe_context(ctx: dict[str, Any]) -> str:
    """Turn the page snapshot the website sends into a few plain lines for the model."""
    page = ctx.get("page") or "unknown"
    lines = [f"- Page: {page} (path {ctx.get('path', '?')})"]
    q = {k: v for k, v in (ctx.get("query") or {}).items() if v not in (None, "")}
    if q:
        lines.append("- Page parameters: " + ", ".join(f"{k}={v}" for k, v in q.items()))
    if ctx.get("hotel_id"):
        lines.append(f"- The hotel page open is hotel_id {ctx['hotel_id']} (use get_hotel_rooms for its rooms)")
    if ctx.get("booking_id"):
        lines.append(f"- The booking open is booking_id {ctx['booking_id']}")
    trip = ctx.get("trip") or {}
    items = trip.get("items") or []
    if items:
        lines.append("- Their trip cart (drafts stay unheld until they press Reserve): " + "; ".join(
            f"{i.get('title')} [{i.get('status')}]" for i in items))
        if trip.get("reserved"):
            lines.append(f"- The cart is RESERVED (held) until {trip.get('expires_at')}")
    else:
        lines.append("- Their trip cart is empty")
    if ctx.get("summary"):
        lines.append(f"- On screen: {ctx['summary']}")
    return "\n".join(lines)


def build_prompt(ctx: dict[str, Any], user: dict[str, Any]) -> str:
    return SYSTEM_PROMPT.format(
        today=ctx.get("today") or date.today().isoformat(),
        currency=user.get("home_currency") or "INR",
        page_context=describe_context(ctx),
    )


def text_of(content: Any) -> str:
    """Gemini returns either a string or a list of content blocks."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def _json(content: Any) -> Any:
    try:
        return json.loads(text_of(content))
    except Exception:
        return None


def summarise_steps(new_messages: list[BaseMessage]) -> tuple[list[dict], list[dict]]:
    """(tool steps for the UI, follow-up actions such as 'open this booking')."""
    steps: list[dict] = []
    actions: list[dict] = []
    calls: dict[str, dict] = {}
    for m in new_messages:
        if isinstance(m, AIMessage):
            for c in m.tool_calls or []:
                calls[c["id"]] = {"tool": c["name"], "args": c.get("args", {})}
        elif isinstance(m, ToolMessage):
            info = calls.get(m.tool_call_id, {"tool": m.name, "args": {}})
            data = _json(m.content)
            ok = (m.status != "error") and not (isinstance(data, dict) and data.get("ok") is False)
            steps.append({"tool": info["tool"], "ok": ok})
            if ok and isinstance(data, dict):
                if info["tool"] == "reserve_trip" and data.get("hold_ids"):
                    actions.append({"type": "navigate", "to": "/hold", "label": "view_trip"})
                elif info["tool"] == "pay_and_confirm" and data.get("booking_id"):
                    actions.append({"type": "navigate", "to": f"/confirmation/{data['booking_id']}", "label": "view_booking"})
                elif info["tool"] == "cancel_booking":
                    actions.append({"type": "navigate", "to": "/bookings", "label": "my_bookings"})
    return steps, actions


def to_messages(history: list[dict], message: str) -> list[BaseMessage]:
    out: list[BaseMessage] = []
    for turn in history[-12:]:
        if turn["role"] == "user":
            out.append(HumanMessage(turn["content"]))
        else:
            out.append(AIMessage(turn["content"]))
    out.append(HumanMessage(message))
    return out


def make_llm(model: str):
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(model=model, google_api_key=GEMINI_API_KEY, temperature=0.2, timeout=AGENT_TIMEOUT_S, max_retries=1)


class AssistantUnavailable(RuntimeError):
    pass


async def chat(message: str, history: list[dict], context: dict, user: dict, *, llm_factory=make_llm, models: list[str] | None = None,
               mcp_url: str = MCP_URL) -> dict:
    """Run one turn. Returns {reply, steps, actions, model, ms}."""
    models = models if models is not None else GEMINI_MODELS
    if llm_factory is make_llm and not GEMINI_API_KEY:
        raise AssistantUnavailable("GEMINI_API_KEY is not set")

    client = MultiServerMCPClient(
        {"kognivera": {"transport": "streamable_http", "url": mcp_url, "headers": {"X-User-Id": user["user_id"], "X-Turn-Id": uuid.uuid4().hex}}}
    )
    try:
        tools = await client.get_tools()
    except Exception as exc:  # the tool server is down or unreachable
        raise AssistantUnavailable(f"tool server unavailable: {exc.__class__.__name__}") from exc

    prompt = build_prompt(context, user)
    messages = to_messages(history, message)
    last_err: Exception | None = None
    started = time.time()
    for model in models:
        try:
            agent = create_agent(llm_factory(model), tools, system_prompt=prompt)
            result = await agent.ainvoke({"messages": messages}, config={"recursion_limit": AGENT_MAX_STEPS * 2 + 1})
        except Exception as exc:  # a busy / retired / slow model must not take the assistant down: try the next one
            last_err = exc
            continue
        new = result["messages"][len(messages):]
        reply = ""
        for m in reversed(new):
            if isinstance(m, AIMessage) and not m.tool_calls:
                reply = text_of(m.content).strip()
                break
        steps, actions = summarise_steps(new)
        return {"reply": reply or "Sorry, I could not put an answer together. Could you rephrase?", "steps": steps,
                "actions": actions, "model": model, "ms": int((time.time() - started) * 1000)}
    raise AssistantUnavailable(f"all models failed: {last_err.__class__.__name__ if last_err else 'none configured'}: {str(last_err)[:120]}")
