"""The agent end to end with a scripted model: MultiServerMCPClient -> FastMCP tools -> reply, no Gemini call needed."""
from __future__ import annotations

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

import assistant


class ScriptedModel(FakeMessagesListChatModel):
    """Plays back a fixed list of replies (tool calls, then text) and remembers what it was shown."""

    seen: list = []

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *a, **k):
        self.seen.append(messages)
        return super()._generate(messages, *a, **k)


def factory(replies):
    def make(_model):
        m = ScriptedModel(responses=replies)
        m.seen = []
        factory.last = m
        return m

    return make


async def test_agent_calls_an_mcp_tool_and_the_context_reaches_the_prompt(mcp_url, users):
    user = {"user_id": users[0]["user_id"], "display_name": users[0]["display_name"], "home_currency": "INR"}
    replies = [
        AIMessage(content="", tool_calls=[{"name": "search_hotels", "args": {"city": "Jaipur", "check_in": "2026-10-08", "nights": 1}, "id": "c1"}]),
        AIMessage(content="Here is the cheapest stay in Jaipur."),
    ]
    ctx = {"page": "hotel_search", "path": "/search", "query": {"city": "Jaipur", "check_in": "2026-10-08"},
           "trip": {"items": [{"title": "Standard @ Hillview", "status": "draft"}]}, "today": "2026-09-25"}

    out = await assistant.chat("cheapest in Jaipur?", [], ctx, user, llm_factory=factory(replies), models=["scripted"], mcp_url=mcp_url)

    assert out["reply"] == "Here is the cheapest stay in Jaipur."
    assert out["steps"] == [{"tool": "search_hotels", "ok": True}]
    system = factory.last.seen[0][0].content
    assert "hotel_search" in system and "Standard @ Hillview" in system and "check_in=2026-10-08" in system
    assert "2026-09-25" in system


async def test_a_failed_tool_call_is_reported_not_hidden(mcp_url, users):
    user = {"user_id": users[0]["user_id"], "display_name": "x", "home_currency": "INR"}
    replies = [
        AIMessage(content="", tool_calls=[{"name": "reserve_trip", "args": {
            "items": [{"entity_type": "room_type", "entity_id": "rmt_does_not_exist", "for_date": "2026-10-08", "nights": 1, "units": 1}],
            "user_confirmed": True}, "id": "c1"}]),
        AIMessage(content="That room could not be reserved."),
    ]
    out = await assistant.chat("book it", [], {"page": "explore"}, user, llm_factory=factory(replies), models=["scripted"], mcp_url=mcp_url)
    assert out["steps"] == [{"tool": "reserve_trip", "ok": False}]
    assert out["actions"] == []


async def test_a_busy_model_falls_back_to_the_next_one(mcp_url, users):
    user = {"user_id": users[0]["user_id"], "display_name": "x", "home_currency": "INR"}

    def make(model):
        if model == "busy":
            raise RuntimeError("503 model overloaded")
        return factory([AIMessage(content="ok from the second model")])(model)

    out = await assistant.chat("hi", [], {"page": "explore"}, user, llm_factory=make, models=["busy", "second"], mcp_url=mcp_url)
    assert out["reply"] == "ok from the second model" and out["model"] == "second"


async def test_tool_server_down_is_a_clean_error(users):
    user = {"user_id": users[0]["user_id"], "display_name": "x", "home_currency": "INR"}
    try:
        await assistant.chat("hi", [], {}, user, llm_factory=factory([AIMessage(content="x")]), models=["m"], mcp_url="http://127.0.0.1:9/mcp")
    except assistant.AssistantUnavailable as exc:
        assert "tool server unavailable" in str(exc)
    else:
        raise AssertionError("expected AssistantUnavailable")
