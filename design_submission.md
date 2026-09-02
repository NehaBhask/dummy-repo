# APS-05 — Distributed Booking & Inventory System

## Design Submission · Kognivera Hackathon 2026

---

## 1. Cover

| | |
|---|---|
| **Team Name** | *--rebase* |
| **Problem Statement** | APS-05 — Distributed Booking & Inventory System |
| **Theme** | Travel & Tourism |

| Member | Role |
|--------|------|
| **Thijesh** | Backend Lead — Inventory service, concurrency logic, hold/booking APIs, saga pattern |
| **Tejas** | Backend + AI — Gemini integration, natural language search, multilingual, API scaffold |
| **Yogita** | Frontend Lead — React UI, search interface, booking flow, load test dashboard |
| **Neha** | Data & QA — Database setup, data loading, load test engine, integration testing |

---

## 2. Problem Understanding

Travel platforms face a fundamental systems challenge: when hundreds of users simultaneously try to book the same scarce inventory — say, the last 3 rooms at a popular hotel — the system must guarantee that **exactly 3 bookings succeed** and the rest receive a clean rejection. Not 4, not 2 — exactly 3. This is the **no-oversell invariant**.

The problem goes beyond a simple counter. A real booking system must support a **two-phase flow**: first, a traveller searches and places a temporary hold (a TTL reservation that locks inventory for a limited time), then confirms with payment — or the hold auto-expires and inventory returns to the pool. This hold-then-confirm pattern means the system must track two kinds of consumed inventory (`booked_units` and `held_units`) and ensure their sum never exceeds the total at any point in time.

Three additional correctness properties make this a genuine distributed systems problem:

- **Idempotency**: Network glitches cause retries. A retried booking request must return the same booking — never create a duplicate. This requires every mutation to carry an idempotency key that the system can recognise.
- **Saga compensation**: A traveller may book a hotel room and a flight together. If the flight booking fails after the hotel succeeds, the system must automatically roll back the hotel booking and restock its inventory. Partial failure must produce a clean, consistent state — not dangling reservations.
- **Cancellation restock**: When a booking is cancelled, the units it consumed must return to available inventory. No units may vanish.

The standout deliverable is not a feature but a **proof**: a load test that fires hundreds of concurrent requests at scarce inventory and demonstrates that the invariant `booked_units + held_units ≤ total_units` is never violated — zero oversell, proven under real concurrency.

---

## 3. Scope

### What We Will Build in 24 Hours (MVP)

1. **Availability Search API** — query hotels/flights by city, dates, guests, and price range, with real-time availability from `inventory_calendar`
2. **AI-Powered Natural Language Search** — "3-star hotel in Jaipur for 2 adults, under ₹5000" → structured query → results (English + Hindi)
3. **TTL Hold System** — create a temporary reservation with a 10-minute expiry; idempotent via unique key
4. **Hold Expiry Worker** — background process that auto-releases expired holds and restocks inventory every 30 seconds
5. **Booking Confirmation with Mock Payment** — convert hold to confirmed booking + mock payment record; idempotent
6. **Multi-Item Booking with Saga Compensation** — book hotel + flight together; if one fails, automatically compensate (roll back) the other
7. **Cancellation with Restock** — cancel a booking and return units to available inventory
8. **Idempotent APIs** — every hold and booking mutation uses an idempotency key; retries return the existing record
9. **Load Test Dashboard** — fire N concurrent requests at scarce inventory from within the app; real-time visualization of results proving zero oversell
10. **Web UI** — search, hold (with countdown timer), confirm, cancel, and load test flows
11. **Multilingual Support** — Hindi + English for AI search and core UI labels

### What We Are Deliberately Leaving Out

| Feature | Why |
|---------|-----|
| **Real payment gateway** (Razorpay/Stripe) | A mock payment proves the same transactional flow. Real gateway integration adds 3–4 hours of credential management and webhook handling with zero value for proving concurrency correctness. |
| **User authentication / sessions** | Not the problem being solved. We use a demo user. Auth would consume 2–3 hours better spent on the saga and load test. |
| **Microservices deployment** | With 24 hours, a modular monolith with clear module boundaries proves identical concurrency guarantees with far less operational risk. We can articulate the service split as a next step. |
| **Dynamic / surge pricing** | The seed data provides static prices per date. Dynamic pricing is an optimisation problem, not a correctness problem. |
| **Email / SMS notifications** | Nice-to-have, but irrelevant to the core invariant. |
| **Admin panel** | No demo value in 24 hours. |
| **Flight search UI** | The API supports flights as a bookable entity. The demo UI focuses on hotel booking for a cleaner story; flights are the second item in the saga demo. |
| **Rate limiting / API gateway** | Important in production, but not for proving correctness under concurrency. |

---

## 4. User Journey

The main flow from the traveller's perspective, end to end:

### Screen 1 — Search (AI-Powered)

The traveller lands on a search page with a prominent text input. They can type in natural language — in English or Hindi:

> *"3-star hotel in Jaipur for 2 adults, Dec 15–17, under ₹5000/night"*
> or
> *"जयपुर में 2 रातों के लिए होटल, ₹5000 से कम"*

The AI (Gemini) parses this into structured parameters: city, dates, guests, max price, star rating. The system queries `inventory_calendar` joined with `hotels`, `hotel_room_types`, and `hotel_rate_plans` — returning only rooms with available units (`total_units - booked_units - held_units > 0`).

Results appear as hotel cards showing: hotel name, star rating, guest score, room type, price per night, and available units. A structured search fallback (dropdowns for city, date picker, price slider) is always available.

### Screen 2 — Hold & Book

The traveller selects a room and clicks **"Hold Room"**. The system:
- Creates a hold with a 10-minute TTL
- Decrements available units instantly
- Shows a **countdown timer** on screen

The traveller sees the booking details: hotel, room type, dates, price breakdown, and the ticking countdown. They can optionally **add a flight** (multi-item booking).

Two paths:
- **Confirm & Pay** (within TTL): Mock payment processes, hold converts to confirmed booking. The traveller sees a confirmation page with booking reference.
- **Timer expires**: Hold auto-releases, inventory restocks, traveller sees "Hold expired — search again."

If the traveller clicks Confirm again (retry), the system returns the same booking — no duplicate.

### Screen 3 — My Bookings

The traveller sees their bookings: confirmed, cancelled, and partially-confirmed (saga). Each booking shows its items and their individual statuses. They can **cancel** a booking — inventory restocks and the status updates to "cancelled" with a timestamp.

### Screen 4 — Load Test Dashboard (Demo)

A special demo page that visualises the system's correctness. The presenter:
1. Selects a scarce inventory row (e.g., "Lake Nest Suites / Executive — 2 total, 1 free")
2. Configures concurrent requests (e.g., 200 requests for 1 unit each)
3. Fires the load test
4. Watches a real-time chart: requests in flight, successes, rejections
5. Sees the final result: exactly 1 success, 199 rejections, and the DB invariant query returning zero violations

---

## 5. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Vite)                      │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ AI Search │  │ Hold +    │  │ My         │  │ Load Test    │ │
│  │ Page      │  │ Book Flow │  │ Bookings   │  │ Dashboard    │ │
│  └──────────┘  └───────────┘  └────────────┘  └──────────────┘ │
└──────────────────────┬──────────────────────────────────────────┘
                       │ REST API (JSON)
┌──────────────────────▼──────────────────────────────────────────┐
│               BACKEND — Node.js + Express                        │
│               (Modular Monolith)                                 │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐  │
│  │  Inventory     │  │  Booking       │  │  AI Search        │  │
│  │  Module        │  │  Module        │  │  Module           │  │
│  │                │  │                │  │                   │  │
│  │ • search       │  │ • createHold   │  │ • NL → struct     │  │
│  │ • availability │  │ • confirm      │  │ • Gemini function │  │
│  │ • restock      │  │ • cancel       │  │   calling         │  │
│  │                │  │ • saga         │  │ • multilingual    │  │
│  └───────┬────────┘  └───────┬────────┘  └────────┬──────────┘  │
│          │                   │                     │             │
│  ┌───────▼───────────────────▼─────────────────────▼──────────┐ │
│  │              Payment Module (Mock)                          │ │
│  └────────────────────────┬───────────────────────────────────┘ │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────────┐ │
│  │     Hold Expiry Worker (setInterval · 30s cycle)           │ │
│  │     Releases expired holds, decrements held_units          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │     Load Test Engine (concurrent async requests)           │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                    PostgreSQL (Railway)                           │
│                                                                  │
│  Row-level locking: SELECT ... FOR UPDATE                        │
│  ACID transactions for every inventory mutation                  │
│  CHECK: booked_units + held_units <= total_units                 │
│  UNIQUE constraints on idempotency_key columns                   │
│  Seeded with 41,855 rows of provided data                        │
└─────────────────────────────────────────────────────────────────┘
                       │
                 Gemini API
         (NL parsing, function calling)
```

**Why a modular monolith, not microservices?**
With 24 hours, a single deployable unit with clearly separated modules gives us shared database transactions (critical for saga compensation), one deploy target, and easy debugging under load — all while proving identical concurrency guarantees. The module boundaries are designed for future service extraction.

---

## 6. Flow Diagram

### Booking Flow — End to End

```
TRAVELLER                    BACKEND                         DATABASE (PostgreSQL)
    │                            │                                │
    │  1. Search (NL or struct)  │                                │
    │ ──────────────────────────>│                                │
    │                            │  Query inventory_calendar      │
    │                            │ ─────────────────────────────> │
    │                            │  Available rooms               │
    │                            │ <───────────────────────────── │
    │  Results with availability │                                │
    │ <──────────────────────────│                                │
    │                            │                                │
    │  2. Hold Room (idemp.key)  │                                │
    │ ──────────────────────────>│                                │
    │                            │  BEGIN TRANSACTION             │
    │                            │  SELECT ... FOR UPDATE (lock)  │
    │                            │ ─────────────────────────────> │
    │                            │  Check: free >= requested?     │
    │                            │  INSERT hold, UPDATE held_units│
    │                            │  COMMIT                        │
    │                            │ <───────────────────────────── │
    │  Hold created (10min TTL)  │                                │
    │ <──────────────────────────│                                │
    │                            │                                │
    │         ┌─── PATH A: Confirm within TTL ───┐                │
    │         │                                   │               │
    │  3a. Confirm + Pay (idemp.key)              │               │
    │ ──────────────────────────>│                                │
    │                            │  BEGIN TRANSACTION             │
    │                            │  Check idemp. key (no dupe)    │
    │                            │  FOR UPDATE → move held→booked │
    │                            │  INSERT booking, booking_items │
    │                            │  INSERT payment (mock)         │
    │                            │  COMMIT                        │
    │                            │ ─────────────────────────────> │
    │  Booking confirmed         │                                │
    │ <──────────────────────────│                                │
    │         │                                                   │
    │         └─── PATH B: TTL Expires ──────────┐                │
    │                            │                │               │
    │               EXPIRY WORKER (every 30s)     │               │
    │                            │  BEGIN TRANSACTION             │
    │                            │  Find expired active holds     │
    │                            │  UPDATE hold status='expired'  │
    │                            │  Decrement held_units          │
    │                            │  COMMIT                        │
    │                            │ ─────────────────────────────> │
    │  Hold expired notification │                                │
    │ <──────────────────────────│                                │
    │                            │                                │
    │  4. Cancel booking         │                                │
    │ ──────────────────────────>│                                │
    │                            │  BEGIN TRANSACTION             │
    │                            │  Decrement booked_units        │
    │                            │  Update booking status         │
    │                            │  COMMIT                        │
    │                            │ ─────────────────────────────> │
    │  Cancelled, restocked      │                                │
    │ <──────────────────────────│                                │
```

### Multi-Item Saga Flow

```
  CONFIRM MULTI-ITEM (hotel + flight)
      │
      ▼
  ┌─ Try Item 1 (Hotel) ──────────────────┐
  │  BEGIN → FOR UPDATE → confirm → COMMIT │
  │  ✓ Success                             │
  └────────────────────────┬───────────────┘
                           │
  ┌─ Try Item 2 (Flight) ─▼───────────────┐
  │  BEGIN → FOR UPDATE → confirm → COMMIT │
  │  ✗ FAILURE (sold out)                  │
  └────────────────────────┬───────────────┘
                           │
  ┌─ COMPENSATE ───────────▼───────────────┐
  │  Roll back Item 1:                     │
  │  Decrement booked_units                │
  │  Set booking_item status='compensated' │
  │  Set compensated_at = NOW()            │
  │  Restock inventory                     │
  └────────────────────────────────────────┘
```

---

## 7. Data Model Usage

### Provided Tables We Use (14 of 20)

| Table | How We Use It |
|-------|---------------|
| **`inventory_calendar`** (15,030 rows) | **Central table.** Every availability check, hold, booking, and restock mutates this table. The `booked_units + held_units ≤ total_units` CHECK constraint is the invariant we defend. |
| **`holds`** (496 rows) | TTL reservations. We create, expire, confirm, and release holds. Retained per Rule R8. |
| **`bookings`** (1,996 rows) | Order header with mandatory `idempotency_key`. Every confirmed booking lives here. |
| **`booking_items`** (2,669 rows) | Line items per booking. The `status='compensated'` value and `compensated_at` field are what make saga rollback auditable. |
| **`payments`** (1,996 rows) | Mock payment records with separate authorised/captured/refunded amounts. |
| **`hotels`** (300 rows) | Search results, display info, city/rating/price joins. |
| **`hotel_room_types`** (1,200 rows) | The bookable unit — room details, occupancy, bed config. Deliberately scarce `total_units` on some rows. |
| **`hotel_rate_plans`** (2,400 rows) | Rate selection (refundable vs non-refundable, breakfast included, etc.). |
| **`flights`** (4,000 rows) | Flight schedules for the multi-item booking (hotel + flight saga). |
| **`flight_fares`** (8,002 rows) | The bookable flight unit — cabin class, fare class, baggage, prices. |
| **`cities`** (60 rows) | Geographic anchor for search (city-based availability). |
| **`countries`** (30 rows) | Reference joins for country info. |
| **`currencies`** (25 rows) | Money display with correct minor-unit exponent (Rule R3). |
| **`fx_rates`** (912 rows) | Currency conversion for display when the traveller's home currency differs from the hotel's. |

### Tables We Add (Rule R1 — Additive Only)

| New Table | Purpose | Key Fields |
|-----------|---------|------------|
| `load_test_runs` | Stores load test configuration and aggregate results for the dashboard | `run_id (PK, ltr_ prefix)`, `target_inventory_id`, `concurrent_requests`, `successes`, `failures`, `invariant_violations`, `created_at` |
| `load_test_results` | Per-request outcome within a load test run | `result_id (PK, ltrs_ prefix)`, `run_id (FK)`, `status` (success/sold_out/error), `latency_ms`, `created_at` |
| `search_logs` | AI search queries and parsed parameters for measuring accuracy | `log_id (PK, slg_ prefix)`, `raw_query`, `language (BCP-47)`, `parsed_params (JSON)`, `result_count`, `created_at` |

All new tables follow the existing conventions: opaque prefixed IDs (R2), timestamptz with offset (R4), lowercase_snake_case enums (R5), and soft-delete via status (R8).

---

## 8. AI Features

### Feature: Natural Language Availability Search

**What it does:** Allows travellers to search for hotels and flights using free-form text in English or Hindi, instead of filling structured search forms.

**Where it sits in the flow:** It is the entry point — Screen 1 of the user journey. The traveller's natural language query is the first interaction with the system.

**How it works:**

1. **Input**: Traveller types a query:
   - English: *"Family room in Goa, 3 nights from Dec 20, 2 rooms, under ₹4000, breakfast included"*
   - Hindi: *"गोवा में 3 रातों के लिए फैमिली रूम, ₹4000 से कम, नाश्ता शामिल"*

2. **Parsing (Gemini Function Calling)**: The query is sent to Google Gemini with a function-calling schema that extracts:
   - `city` (string) → matched against `cities.name`
   - `check_in_date` (date) → for `inventory_calendar.for_date`
   - `nights` (integer) → date range
   - `rooms` (integer) → units required
   - `max_price_per_night` (decimal) → price filter
   - `currency` (string, ISO-4217) → for price comparison
   - `star_rating` (integer, optional) → `hotels.star_rating`
   - `preferences` (array: breakfast, refundable, etc.) → `hotel_rate_plans` filters

3. **Grounding against real data**: The parsed parameters are used to build a SQL query joining `hotels`, `hotel_room_types`, `hotel_rate_plans`, and `inventory_calendar`. Only results with `total_units - booked_units - held_units >= requested_rooms` are returned. Every result is a real, bookable inventory row — not a hallucination.

4. **Response enhancement**: Gemini generates a brief natural-language summary comparing the top results (e.g., trade-offs between price, rating, and location), displayed alongside the structured results.

**How we know it works (measurable target):**

- **Parse accuracy**: We prepare 20 predefined queries (10 English, 10 Hindi) with known expected structured output. We measure: does the parsed city, date, price, and room count match the expected values? Target: ≥ 90% field-level accuracy.
- **Grounding test**: For every query, we verify that all returned results have `free_units > 0` in `inventory_calendar` for the requested dates. Target: 100% — no phantom availability.
- **Multilingual consistency**: The same query in English and Hindi must produce the same result set. We test 10 parallel pairs.

**Fallback**: If Gemini is unavailable (rate limit, network), the UI falls back to a structured search form with dropdowns for city, date pickers, and price sliders. The demo queries are also pre-cached so the live demo is never blocked by an API outage.

---

## 9. Business Benefits

### For the Traveller

- **Trust in booking**: When a traveller sees "2 rooms left" and clicks book, they get the room. No "sorry, that was just sold" after entering payment details — a frustration that erodes trust and drives users to competitors.
- **Fair hold system**: The TTL hold means a traveller gets a genuine 10-minute window to decide and pay, without another user snatching the room mid-checkout. This mirrors the experience users expect from ticketing platforms (IRCTC, BookMyShow).
- **Natural language search**: Travellers describe what they want in their own words and language (Hindi, English). No need to learn filter interfaces — especially valuable for first-time or less tech-savvy users.
- **Safe retries**: Flaky networks (common on Indian mobile data) no longer risk accidental double-bookings. The traveller can retry safely.

### For the Business

- **Zero revenue leakage from overselling**: An oversold room costs the platform a compensation payout, a bad review, and a lost customer. The no-oversell guarantee eliminates this category of loss entirely.
- **Higher conversion from holds**: The hold system lets users "lock in" availability while they decide, reducing drop-off during the payment step. Expired holds return automatically — no manual cleanup.
- **Operational confidence at scale**: The load test proves the system handles 200+ concurrent requests correctly. The platform can run flash sales, seasonal demand spikes, and promotional campaigns without fearing inventory corruption.
- **Clean partial failure handling**: Multi-item bookings (hotel + flight) fail cleanly. The saga ensures the platform never has orphaned charges or phantom bookings — reducing support tickets and manual reconciliation.
- **Multilingual reach**: Supporting Hindi alongside English opens the platform to a much larger user base across India, particularly in Tier 2 and Tier 3 cities.

---

## 10. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | Node.js 20+ | Team's strongest stack; excellent async I/O for handling concurrent booking requests |
| **Framework** | Express.js | Battle-tested, minimal boilerplate, fast to scaffold REST APIs |
| **Database** | PostgreSQL (Railway) | Row-level locking (`SELECT ... FOR UPDATE`) provides the concurrency guarantee that is the entire point of APS-05 |
| **DB Client** | `pg` + `knex.js` | Raw SQL where we need `FOR UPDATE` locking, Knex for migrations and structured queries |
| **Money handling** | `decimal.js` | Never IEEE-754 floats — Rule R3 compliance; the data guide explicitly recommends this for JavaScript |
| **AI** | Google Gemini API (`@google/generative-ai`) | Function calling for NL → structured search; multilingual (Hindi/English) built in; generous free tier |
| **Frontend** | React 18 + Vite | Fast dev server, component-based UI, good for real-time load test dashboard |
| **Styling** | Vanilla CSS (dark theme) | Premium look, full control, no framework dependency |
| **Deployment** | Railway | One-command deploy with built-in PostgreSQL; zero DevOps overhead in a 24-hour sprint |

---

## 11. 24-Hour Plan

### Team Allocation

| Person | Primary Role |
|--------|-------------|
| **Thijesh** | Backend: inventory service, concurrency (FOR UPDATE), hold/booking/cancel APIs, saga |
| **Tejas** | Backend + AI: Express scaffold, Gemini integration, NL search, multilingual |
| **Yogita** | Frontend: React UI, search page, booking flow, load test dashboard |
| **Neha** | Data + QA: PostgreSQL setup (Railway), data loading, load test engine, testing |

### Schedule

| Block | Time | Thijesh | Tejas | Yogita | Neha |
|-------|------|---------|-------|--------|------|
| **0** | 12:00–13:00 | **ALL:** Agree demo flow, confirm API contracts, set up repo + Railway | | | |
| **1** | 13:00–15:00 | DB schema (Knex migrations), inventory search + availability APIs | Express project, route structure, middleware, error handling | React+Vite setup, design system, dark theme, component library | Load Postgres with CSV data, verify conformance, run starter queries |
| **2** | 15:00–17:00 | `createHold()` with FOR UPDATE + idempotency, `releaseHold()` | Gemini function calling: NL → structured search params, wire to search | Search page UI: search bar, hotel cards, availability badges | Hold expiry worker, unit tests for inventory module |
| **3** | 17:00–19:00 | `confirmBooking()` (hold→booking+payment), idempotency | Multilingual: Hindi query parsing, AI result summaries | Booking flow: hold countdown timer, confirm/pay modal | Integration tests: hold → expire → restock, hold → confirm |
| **4** | 19:00–21:00 | Multi-item saga: `confirmMultiItem()` with compensation | End-to-end AI search flow connected to frontend | Multi-item UI, saga status display | Load test engine: fire N concurrent requests, collect results |
| **5** | 21:00–23:00 | Cancellation → restock, edge cases (double-cancel, expired hold confirm) | Test 20 NL queries, tune prompts, handle edge cases | Load test dashboard: real-time chart, counters | First real load tests, find concurrency bugs |
| **6** | 23:00–01:00 | Bug fixes, error handling, logging | Fallback: cached demo queries, structured search bypass | My Bookings page, cancellation UI | Stress test: ramp to 500 concurrent, measure latency |
| **7** | 01:00–03:00 | **ALL:** Full integration test — complete demo path end to end | | | |
| **8** | 03:00–05:00 | API polish, error messages | Solution write-up, architecture note | UI polish, animations, responsive | Final load tests, collect results for demo |
| **9** | 05:00–07:00 | 💤 **REST** | 💤 **REST** | 💤 **REST** | 💤 **REST** |
| **10** | 07:00–09:00 | Final bug fixes only | Write-up review, talking points | Demo path verification | Record fallback demo video |
| **11** | 09:00–11:00 | **ALL:** Stabilise. Fix demo path only. No new features. (09:00 rule) | | | |
| **12** | 11:00–12:00 | **ALL:** Rehearse demo TWICE on demo machine. 2 speakers max. | | | |

---

## 12. Risks and Fallbacks

| # | Risk | Likelihood | Fallback |
|---|------|-----------|----------|
| **1** | **Gemini API rate limit or network failure during live demo** | Medium | Pre-cache the 3 demo search queries (results stored locally). Fall back to structured search form with dropdowns. The AI feature is demonstrated either way — live if possible, cached if not. |
| **2** | **Concurrency bugs surface under real load** | High (initially) | Begin load testing by hour 10 (21:00), not hour 20. This gives 12+ hours to find and fix race conditions. The PostgreSQL CHECK constraint (`booked + held ≤ total`) acts as a hard safety net — even if our application logic has a bug, the database rejects the oversell. |
| **3** | **Venue network or Railway downtime during presentation** | Medium | Record a complete demo run as a screen capture before 09:00 on Day 2. Keep it on the demo machine, playable offline. We also maintain a local PostgreSQL Docker setup as a cold backup that can be started in under 2 minutes. |

---

## 13. Multilingual Approach

| Aspect | Implementation |
|--------|---------------|
| **Languages supported** | English (default) + Hindi |
| **AI search input** | Gemini handles Hindi natively — queries in either language produce structured search params. Tested with 10 parallel Hindi/English query pairs. |
| **UI labels** | Bilingual i18n JSON files (`en.json`, `hi.json`). Language toggle in the header. Key surfaces: search page, booking flow, error messages, confirmation screen. |
| **Hotel descriptions** | Displayed in English from the seed data. AI-translated to Hindi on request (non-critical, best-effort). |
| **Data conventions** | BCP-47 tags throughout (Rule R6): `hi`, `en-IN`. User locale stored in `users.locale`. |
| **Currency display** | Respects `currencies.minor_unit_exponent` — JPY shows no decimals, INR shows 2. Locale-aware formatting via `Intl.NumberFormat`. |

---

## 14. XR Device Declaration

**Not applicable.** APS-05 (Distributed Booking & Inventory System) is not an AR/VR problem statement. No XR device is required.
