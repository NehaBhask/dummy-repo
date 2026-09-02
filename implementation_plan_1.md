# APS-05 Build Plan — Distributed Booking & Inventory System

## 🎯 The End Product (What We're Demoing)

A **travel booking platform** with a web UI where a user can:

1. **Search** for hotels/flights using natural language (English or Hindi) — *"3-star hotel in Jaipur for 2 adults, Dec 15–17, under ₹6000"*
2. **Hold** a room/seat with a visible countdown timer (TTL)
3. **Book** (confirm + mock payment) — or watch the hold auto-release
4. **Book multiple items** (hotel + flight) — and see the saga compensate on partial failure
5. **Cancel** a booking and watch inventory restock live

And then the **hero moment of the demo**:

6. 🔥 **Fire up the Load Test Dashboard** — blast 200+ concurrent booking requests at a room with only 3 units left → watch a real-time chart showing exactly 3 succeed, 197+ rejected, **zero oversell**

> The system is the star, not the UI. The UI exists to make the system's correctness *visible*.

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│          React + Vite (Single Page Application)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐   │
│  │  Search   │ │ Booking  │ │ My       │ │  Load Test    │   │
│  │  (+ AI)   │ │  Flow    │ │ Bookings │ │  Dashboard 📊 │   │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘   │
└──────────────────────┬───────────────────────────────────────┘
                       │ REST API
┌──────────────────────▼───────────────────────────────────────┐
│                    BACKEND (FastAPI)                          │
│              Python · Modular Monolith                        │
│                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │  Inventory   │ │   Booking   │ │   AI Search         │    │
│  │  Service     │ │   Service   │ │   Service           │    │
│  │              │ │             │ │                     │    │
│  │ • Availability│ │ • Holds    │ │ • NL → Structured   │    │
│  │ • Stock Mgmt │ │ • Confirm  │ │ • Grounded in DB    │    │
│  │ • Calendar   │ │ • Cancel   │ │ • Multi-language     │    │
│  │              │ │ • Saga     │ │                     │    │
│  └──────┬──────┘ └──────┬─────┘ └──────────┬──────────┘    │
│         │               │                   │                │
│  ┌──────▼───────────────▼───────────────────▼──────────┐    │
│  │              Payment Service (Mock)                  │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────┐    │
│  │          Hold Expiry Worker (Background)             │    │
│  │     Runs every 30s — releases expired holds          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          Load Test Engine (Built-in)                  │    │
│  │     Fires concurrent requests · Reports results      │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                    PostgreSQL                                 │
│                                                              │
│  • Row-level locking (SELECT ... FOR UPDATE)                 │
│  • ACID transactions for every inventory mutation             │
│  • CHECK constraint: booked_units + held_units <= total_units │
│  • UNIQUE constraints on idempotency_key columns             │
│  • Loaded with provided 41,855 rows                          │
└──────────────────────────────────────────────────────────────┘
```

### Why a Modular Monolith (Not Microservices)?

We have **24 hours**. Microservices add network hops, deployment complexity, distributed debugging — none of which help us prove correctness. A single FastAPI app with clearly separated modules gives us:
- One deploy target
- Shared DB transactions (critical for saga)
- Easy to debug under load
- Can always be split later (that's a "what we left out" talking point)

---

## 🔧 Tech Stack

| Layer | Choice | Why (one line) |
|-------|--------|----------------|
| **Backend** | Python + FastAPI | Async-native, auto-generated API docs (Swagger), Python AI ecosystem, type-safe |
| **Database** | PostgreSQL | Row-level locking (`FOR UPDATE`), real ACID transactions, production-grade concurrency — this is the entire reason the system works |
| **ORM** | SQLAlchemy 2.0 + asyncpg | Async PostgreSQL driver, proper transaction management |
| **Frontend** | React + Vite | Fast dev server, component-based, easy state management for real-time updates |
| **AI** | Google Gemini API (or OpenAI) | Function calling to convert NL → structured search params, multilingual out of the box |
| **Load Testing** | Built-in `asyncio` + `aiohttp` | No external tool needed — we build the load test INTO the product as a feature |
| **Background Worker** | APScheduler (in-process) | Hold expiry every 30s, no separate service needed |
| **Styling** | CSS with a clean dark theme | Looks premium, fast to build, no framework overhead |

---

## 🧠 The Concurrency Strategy (The Heart of the System)

This is **the** technical decision. Everything else is scaffolding around this.

### Approach: Pessimistic Locking with PostgreSQL `SELECT ... FOR UPDATE`

```
User Request → BEGIN transaction
             → SELECT inventory row FOR UPDATE (row is now locked)
             → Check: booked + held + requested ≤ total ?
             → YES: UPDATE inventory, INSERT hold/booking → COMMIT
             → NO:  ROLLBACK, return "sold out"
```

Any other concurrent request for the **same row** blocks at the `SELECT FOR UPDATE` until the first transaction commits or rolls back. This serialises access at the row level — not the table level — so different rooms/dates remain fully parallel.

### Why This Works

| Property | How it's guaranteed |
|----------|-------------------|
| **No oversell** | Lock → check → update is atomic within a transaction. The CHECK constraint is the safety net. |
| **Idempotency** | `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING` → return existing record on retry |
| **Hold TTL** | Background worker runs `UPDATE holds SET status='expired' ... WHERE expires_at < NOW()` and decrements `held_units` |
| **Saga compensation** | Each booking item is confirmed in sequence within a try/except. On failure, loop back and compensate (undo) each previously confirmed item. |
| **Cancellation restock** | `UPDATE inventory_calendar SET booked_units = booked_units - N` within a transaction |

### Pseudocode: The Critical Path

```python
# === CREATE HOLD (with idempotency) ===
async def create_hold(inventory_id, user_id, units, idempotency_key):
    async with db.transaction():
        # 1. Idempotency check
        existing = await get_hold_by_idempotency_key(idempotency_key)
        if existing:
            return existing  # Same request, same response

        # 2. Lock the inventory row
        inv = await db.execute(
            "SELECT * FROM inventory_calendar WHERE inventory_id = $1 FOR UPDATE",
            inventory_id
        )

        # 3. Check availability
        free = inv.total_units - inv.booked_units - inv.held_units
        if units > free:
            raise SoldOutError()

        # 4. Create hold + update inventory (atomic)
        hold = await insert_hold(inventory_id, user_id, units, idempotency_key,
                                 expires_at=now() + timedelta(minutes=10))
        await db.execute(
            "UPDATE inventory_calendar SET held_units = held_units + $1",
            units
        )
        return hold


# === MULTI-ITEM BOOKING WITH SAGA ===
async def confirm_multi_item_booking(hold_ids, payment_info, idempotency_key):
    # Idempotency check
    existing = await get_booking_by_idempotency_key(idempotency_key)
    if existing:
        return existing

    confirmed_items = []
    try:
        for hold_id in hold_ids:
            item = await confirm_single_item(hold_id)  # Each in its own transaction
            confirmed_items.append(item)

        # All succeeded → process payment
        payment = await process_payment(payment_info)
        booking = await create_booking(confirmed_items, payment, idempotency_key)
        return booking

    except Exception as e:
        # COMPENSATE: rollback all confirmed items
        for item in confirmed_items:
            await compensate_item(item)  # Undo the booking, restock inventory
        raise BookingFailedError(compensated=confirmed_items)
```

---

## 🤖 AI Feature: Smart Search Assistant

### What It Does
Natural language → structured availability search, grounded in real inventory data.

### How It Works

```
User types: "Family-friendly hotel in Goa, 3 nights from Dec 20, 
             2 rooms, budget ₹4000/night, breakfast included"
                    │
                    ▼
        ┌─── Gemini API (Function Calling) ───┐
        │                                      │
        │  Extracts:                           │
        │  • city: "Goa"                       │
        │  • check_in: "2026-12-20"            │
        │  • nights: 3                         │
        │  • rooms: 2                          │
        │  • max_price: 4000.00                │
        │  • currency: "INR"                   │
        │  • preferences: ["breakfast"]        │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌─── SQL Query Builder ───────────────┐
        │                                      │
        │  JOIN hotels + room_types +           │
        │  inventory_calendar + rate_plans      │
        │  WHERE city matches, date range,      │
        │  free units >= 2, price <= 4000,      │
        │  includes_breakfast = true            │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌─── Results + AI Summary ────────────┐
        │                                      │
        │  3 hotels found, ranked by score.     │
        │  AI generates a brief comparison      │
        │  summary highlighting trade-offs.     │
        └──────────────────────────────────────┘
```

### How We Know It Works
- **Precision test**: 20 predefined NL queries with expected structured output → measure parse accuracy
- **Grounding test**: Every result links back to real `inventory_calendar` rows with verifiable availability
- **Multilingual test**: Same query in Hindi produces same results

### Multilingual
- Gemini/OpenAI handle Hindi, Tamil, Telugu, etc. natively
- UI labels in English + Hindi (at minimum)
- AI search accepts queries in both languages
- Hotel descriptions can be shown in the user's preferred language via translation

---

## ✅ Scope: In vs Out

### 🟢 IN (24-hour MVP)

| Feature | Why it's in |
|---------|-------------|
| Availability search API (+ AI natural language) | Core flow |
| TTL hold creation with idempotency | Core guarantee #2 + #3 |
| Hold expiry background worker | Required for TTL to mean anything |
| Booking confirmation with mock payment | Core flow |
| Multi-item booking with saga compensation | Core guarantee #4 |
| Cancellation with inventory restock | Core guarantee #5 |
| Idempotent APIs (holds + bookings) | Core guarantee #3 |
| Load test proving zero oversell | **The hero deliverable** |
| AI-powered natural language search | Required AI feature |
| Web UI for the demo flow | Need to show it working |
| Hindi + English support | Multilingual requirement |

### 🔴 OUT (Deliberately Left Out)

| Feature | Why it's out |
|---------|-------------|
| Real payment gateway integration | Mock is sufficient; integrating Razorpay/Stripe is plumbing, not systems thinking |
| User authentication/sessions | Not the problem being solved; hardcode a demo user |
| Microservices / distributed deployment | 24 hours — modular monolith proves the same concurrency guarantees with less ops risk |
| Flight search UI | We support flights in the API, but the demo focuses on hotel booking (cleaner story) |
| Email/SMS notifications | Nice-to-have, not core |
| Rate limiting / API gateway | Important in production, not for proving correctness |
| Admin panel | No time, no value for the demo |
| XR/VR scene viewing | Unclear requirement — defer unless specified in the app |
| Complex pricing (dynamic, surge) | Out of scope — use static prices from the data |

---

## 📐 Data Model: What We Use & What We Add

### Tables We Use (from the provided 20)

| Table | How we use it |
|-------|---------------|
| `inventory_calendar` | **Primary** — all availability checks and stock mutations go through here |
| `holds` | TTL reservations — create, expire, confirm, release |
| `bookings` | Order header — the confirmed booking record |
| `booking_items` | Line items per booking — enables saga compensation |
| `payments` | Mock payment records |
| `hotels` | Search results, display info |
| `hotel_room_types` | Bookable unit, room details |
| `hotel_rate_plans` | Rate selection for bookings |
| `flights` | Secondary search — flights as bookable items |
| `flight_fares` | Bookable flight unit |
| `cities` | Location-based search |
| `countries` | Reference joins |
| `currencies` | Money display |
| `fx_rates` | Currency conversion for display |

### Tables/Columns We Add (extending, not renaming)

| Addition | Purpose |
|----------|---------|
| `load_test_runs` table | Store load test results for the dashboard |
| `load_test_results` table | Per-request outcome (success/fail/time) |
| `search_logs` table | AI search queries and parsed parameters (for measuring AI accuracy) |
| `ai_query_cache` table | Cache parsed NL queries to avoid redundant API calls |

> All additions follow Rule R1 (additive only) and R2 (opaque prefixed IDs).

---

## 🗓️ 24-Hour Build Plan

### Team Role Assumptions (4-person team)

| Role | Focus |
|------|-------|
| **P1 — Backend Lead** | Inventory service, concurrency logic, hold/booking APIs |
| **P2 — Backend + AI** | AI search service, Gemini integration, multilingual |
| **P3 — Frontend** | React UI, search page, booking flow, load test dashboard |
| **P4 — Data + Testing** | DB setup, data loading, load test engine, integration tests |

### Hour-by-Hour Plan

| Block | Time | P1 (Backend Lead) | P2 (Backend + AI) | P3 (Frontend) | P4 (Data + Test) |
|-------|------|----|----|----|----|
| **0** | 12:00–13:00 | 🤝 **ALL:** Agree on the one demo flow, confirm API contracts, set up repo & project skeleton | | | |
| **1** | 13:00–15:00 | DB schema (Postgres), inventory service: `search`, `check_availability` | FastAPI project scaffold, auth middleware (demo user), API route structure | React + Vite setup, design system (colors, components, dark theme) | Load Postgres with CSV data, verify with `validate_conformance.py`, run starter queries |
| **2** | 15:00–17:00 | Hold service: `create_hold` (with `FOR UPDATE` + idempotency), `release_hold` | AI search: Gemini function calling, NL → structured params, wire to search API | Search page UI: search bar, results grid, room cards | Hold expiry background worker, unit tests for inventory service |
| **3** | 17:00–19:00 | Booking service: `confirm_booking` (hold → booking + payment), idempotency | AI: multilingual support (Hindi queries), result summarisation | Booking flow UI: hold countdown timer, confirm/pay modal | Integration tests: hold creation, expiry, confirm flow end-to-end |
| **4** | 19:00–21:00 | Multi-item booking: saga pattern, compensation on partial failure | AI: accuracy testing (20 predefined queries), edge cases | Multi-item UI: add flight + hotel, show saga status | Load test engine: async concurrent requests, result collection |
| **5** | 21:00–23:00 | Cancellation service: cancel → restock, API endpoint | Connect AI to frontend, search flow end-to-end | Load test dashboard: real-time chart, success/fail counters | Run first real load test, find and fix concurrency bugs |
| **6** | 23:00–01:00 | Bug fixes, edge cases (double-cancel, expired hold confirm) | Refine AI prompts, test multilingual, fallback handling | My Bookings page, cancellation UI | Stress test: 500 concurrent, measure P99 latency |
| **7** | 01:00–03:00 | 🤝 **ALL:** Full integration test — run the complete demo flow end to end, fix any broken seams | | | |
| **8** | 03:00–05:00 | Polish APIs, add proper error messages, logging | Solution write-up draft | UI polish: animations, responsive, error states | Final load test runs, collect results for demo |
| **9** | 05:00–07:00 | 💤 **REST** (at least 2 hours — teams that don't sleep demo badly) | | | |
| **10** | 07:00–09:00 | Final bug fixes only — **no new features** (09:00 rule) | Review solution write-up, architecture note | Final UI tweaks, ensure demo path is flawless | Record fallback demo video (offline backup) |
| **11** | 09:00–11:00 | 🤝 **ALL:** Stabilise. Fix the demo path. Nothing new. | | | |
| **12** | 11:00–12:00 | 🤝 **ALL:** Rehearse the demo **twice**, on the demo machine. Decide who speaks (2 voices max). | | | |

---

## 🎬 The Demo Script (6 minutes)

| Min | What we show | What it proves |
|-----|-------------|----------------|
| 0–1 | Open the app. Type in Hindi: *"जयपुर में 2 रातों के लिए 3-स्टार होटल, ₹5000 से कम"*. AI parses it, results appear. | **AI feature works. Multilingual works.** |
| 1–2 | Pick a room → click "Hold" → **10-minute countdown starts**. Show the inventory count drop by 1 in the DB. | **TTL hold works. Inventory updates atomically.** |
| 2–3 | Add a flight to the booking → Confirm & Pay → Booking confirmed. Then intentionally trigger a flight failure → show hotel auto-compensated (rolled back). | **Multi-item saga with compensation works.** |
| 3–4 | Click the same "Confirm" button again (simulate retry) → same booking returned, no duplicate. | **Idempotency works.** |
| 4–5 | Cancel the booking → show inventory restock (units go back up). | **Cancellation restock works.** |
| 5–6 | 🔥 **Load Test Dashboard**: Fire 200 concurrent requests at a room with 3 units. Real-time chart shows exactly 3 succeed. Query the DB: `booked + held ≤ total`. Zero violations. | **THE HERO MOMENT. Zero oversell proven.** |

---

## ⚠️ Risks and Fallbacks

| # | Risk | Likelihood | Fallback |
|---|------|-----------|----------|
| 1 | **AI API quota/rate limit** hit during demo | Medium | Pre-cache the demo query results. Have a "structured search" fallback that bypasses AI entirely. |
| 2 | **Concurrency bugs** surface under real load | High (initially) | Start load testing by hour 10, not hour 20. Use DB CHECK constraint as the ultimate safety net. If our app-level logic has a bug, the DB rejects the oversell. |
| 3 | **Frontend incomplete** — UI not polished enough | Medium | The backend APIs + Swagger UI are a perfectly valid demo. We can demo via Swagger + a Postman-like tool and focus the live UI on just the load test dashboard. |
| 4 | **Postgres connection issues** at venue | Low | Keep SQLite as a fallback DB (with `BEGIN EXCLUSIVE` for locking — less elegant but works for demo). |
| 5 | **Venue Wi-Fi dies** during demo | Medium | Record a complete demo run as a video before 09:00. Have it on the machine, offline. |

---

## 🌐 Multilingual Approach

| Aspect | Approach |
|--------|----------|
| **UI Language** | English (default) + Hindi — toggle in the header |
| **AI Search** | Gemini handles Hindi, Tamil, Telugu natively — no extra work needed |
| **Hotel Descriptions** | Shown in English from the data; optionally AI-translated to Hindi on request |
| **Error Messages** | English + Hindi |
| **Data** | BCP-47 tags throughout (Rule R6): `hi`, `en-IN`, `ta` |
| **Where it appears** | Search bar, search results, booking confirmation page, error states |

---

## 🔑 Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Monolith vs Microservices | **Modular monolith** | 24 hours. One deploy. Shared transactions. Split later. |
| Locking strategy | **Pessimistic (`FOR UPDATE`)** | Simplest correctness guarantee. Optimistic locking adds retry complexity we don't need for a demo. |
| Load test tool | **Built into the product** | The load test IS the deliverable. It should be a first-class feature with a UI, not a separate script. |
| AI feature | **NL search with function calling** | Grounded in real data, measurable accuracy, visually impressive, naturally multilingual. |
| Payment | **Mock service** | Real payment adds integration risk with zero correctness value. |
| Auth | **Demo user, no auth** | Not the problem. Hardcode `usr_` prefix user. |

---

## 📋 Open Questions for the Team

1. **Team size?** — The plan above assumes 4 people. If 3 or 5, we redistribute.
2. **AI API choice?** — Gemini (free tier generous) vs OpenAI (better function calling)? Do we have API keys ready?
3. **XR requirement?** — The README mentions an XR device requirement on the statement page. Do we have access to that? What does it say?
4. **Deployment?** — Do we deploy to cloud (Render/Railway/fly.io) or run locally on the demo machine? Running locally is safer.
5. **Has everyone run the starter queries?** — If not, that's step zero before any coding begins.
