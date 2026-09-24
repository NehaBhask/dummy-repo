# APS-05 Build Plan v2 — Distributed Booking & Inventory System

**Team:** Yogita, Neha, Thijesh, Tejas
**Stack:** Node.js + Express · PostgreSQL · React + Vite · Gemini AI
**Deploy:** Railway

---

## 🎯 The End Product

A **travel booking web app** where:

1. A user types a natural language query (English/Hindi) → AI parses it → shows available hotels/flights
2. User holds a room (visible TTL countdown) → confirms with payment → or lets it auto-expire
3. Multi-item bookings (hotel + flight) use saga compensation on partial failure
4. Cancellations restock inventory
5. **The hero demo:** A load test dashboard blasts 200+ concurrent requests at scarce inventory and proves zero oversell in real-time

> The system's **correctness under concurrency** is the star — the UI makes that correctness visible.

---

## 📊 What We Learned from the Data

Running the starter queries revealed the exact battlefield:

### Scarce Inventory (Load Test Targets)
```
Lake Nest Suites / Executive        → total=2, FREE=1  (only 1 room left!)
Royal Terraces Suites / Family Room → total=4, FREE=1
Hillview Nest Boutique Stay         → total=3, FREE=1
```
These are the rows we'll race 200 concurrent requests against.

### Current Hold States
```
active    → 115 holds (175 units currently locked)
confirmed → 193 holds (converted to bookings)
expired   →  98 holds (TTL ran out — our worker handles this)
released  →  90 holds (manually released)
```

### Saga Compensation Already Exists in Data
```
10 booking_items with status='compensated' and compensated_at timestamps
→ The seed data already shows what our saga rollback should produce
```

### Cancellations to Restock
```
cancelled → 313 bookings (485 units)
failed    →  90 bookings (140 units)
refunded  →  86 bookings (128 units)
```

### Invariant Holds
```
✓ ZERO violations of booked_units + held_units <= total_units
→ Our system must keep this true under 200 concurrent requests
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Vite)                      │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌────────────────┐  │
│  │ AI Search │ │ Hold +    │ │ My         │ │ Load Test      │  │
│  │ Page      │ │ Book Flow │ │ Bookings   │ │ Dashboard 📊   │  │
│  └──────────┘ └───────────┘ └────────────┘ └────────────────┘  │
└──────────────────────┬──────────────────────────────────────────┘
                       │ REST API (JSON)
┌──────────────────────▼──────────────────────────────────────────┐
│              BACKEND — Node.js + Express                         │
│              (Modular Monolith)                                  │
│                                                                  │
│  ┌────────────────┐ ┌────────────────┐ ┌─────────────────────┐  │
│  │ Inventory      │ │ Booking        │ │ AI Search           │  │
│  │ Module         │ │ Module         │ │ Module              │  │
│  │                │ │                │ │                     │  │
│  │ • search()     │ │ • createHold() │ │ • NL → structured   │  │
│  │ • checkAvail() │ │ • confirm()    │ │ • Gemini function   │  │
│  │ • restock()    │ │ • cancel()     │ │   calling           │  │
│  │                │ │ • saga()       │ │ • Hindi + English   │  │
│  └───────┬────────┘ └───────┬────────┘ └──────────┬──────────┘  │
│          │                  │                      │             │
│  ┌───────▼──────────────────▼──────────────────────▼──────────┐  │
│  │                 Payment Module (Mock)                       │  │
│  └────────────────────────┬──────────────────────────────────┘  │
│                           │                                      │
│  ┌────────────────────────▼──────────────────────────────────┐  │
│  │        Hold Expiry Worker (runs every 30s via setInterval) │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │        Load Test Engine (fires concurrent requests)        │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                      PostgreSQL (Railway)                        │
│                                                                  │
│  • SELECT ... FOR UPDATE  (row-level locks)                      │
│  • ACID transactions                                             │
│  • CHECK: booked_units + held_units <= total_units               │
│  • UNIQUE constraints on idempotency_key                         │
│  • Seeded with 41,855 rows of provided data                      │
└─────────────────────────────────────────────────────────────────┘
```

### Why Modular Monolith?

24 hours. One Railway deploy. Shared DB transactions (critical for saga). Easy debugging under load. We can always say *"designed to split into services"* — that shows **more** judgement than actually doing it under time pressure.

---

## 🔧 Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | Node.js 20+ | Team's strongest language, excellent async I/O |
| **Framework** | Express.js | Battle-tested, minimal boilerplate, fast to scaffold |
| **Database** | PostgreSQL (Railway) | Row-level locking (`FOR UPDATE`), real ACID — this is why the system works |
| **DB Client** | `pg` + `knex.js` | Raw SQL where we need `FOR UPDATE`, Knex for migrations and queries |
| **Money** | `decimal.js` | Never IEEE-754 floats — Rule R3 |
| **AI** | Gemini API (`@google/generative-ai`) | Function calling for NL → structured search, multilingual native |
| **Frontend** | React 18 + Vite | Fast dev, component-based, good for real-time dashboard |
| **Styling** | Vanilla CSS (dark theme) | Premium look, no framework overhead |
| **Load Test** | Built-in (async fetch batching) | The load test is a product feature, not a separate script |
| **Deploy** | Railway | One-click deploy, free PostgreSQL, simple and reliable |

---

## 🧠 Concurrency Strategy (The Core of the System)

### Pessimistic Locking with `SELECT ... FOR UPDATE`

```
Request arrives → BEGIN transaction
               → SELECT inventory_calendar row FOR UPDATE (row is now LOCKED)
               → Check: booked + held + requested ≤ total ?
               → YES: UPDATE inventory, INSERT hold/booking → COMMIT
               → NO:  ROLLBACK → return { error: "sold_out" }
```

Any concurrent request hitting the **same inventory row** waits at `FOR UPDATE` until the first transaction finishes. Different rooms/dates stay fully parallel.

### Key Implementation (Node.js with pg)

```javascript
// === CREATE HOLD (idempotent, concurrency-safe) ===
async function createHold(client, { inventoryId, userId, units, idempotencyKey }) {
  // 1. Idempotency: return existing hold if key matches
  const existing = await client.query(
    'SELECT * FROM holds WHERE idempotency_key = $1', [idempotencyKey]
  );
  if (existing.rows.length > 0) return existing.rows[0]; // Same request → same response

  // 2. Lock the inventory row (blocks concurrent access to THIS row only)
  const inv = await client.query(
    'SELECT * FROM inventory_calendar WHERE inventory_id = $1 FOR UPDATE',
    [inventoryId]
  );
  const row = inv.rows[0];

  // 3. Check availability
  const free = row.total_units - row.booked_units - row.held_units;
  if (units > free) throw new SoldOutError();

  // 4. Atomic: create hold + update inventory
  const hold = await client.query(
    `INSERT INTO holds (hold_id, inventory_id, user_id, units, idempotency_key, 
     expires_at, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + interval '10 minutes', 'active', NOW(), NOW())
     RETURNING *`,
    [generateId('hld'), inventoryId, userId, units, idempotencyKey]
  );
  await client.query(
    'UPDATE inventory_calendar SET held_units = held_units + $1, updated_at = NOW() WHERE inventory_id = $2',
    [units, inventoryId]
  );
  return hold.rows[0];
}

// === MULTI-ITEM BOOKING WITH SAGA COMPENSATION ===
async function confirmMultiItemBooking(holdIds, paymentInfo, idempotencyKey) {
  // Idempotency check (outside the per-item loop)
  const existing = await pool.query(
    'SELECT * FROM bookings WHERE idempotency_key = $1', [idempotencyKey]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const confirmedItems = [];
  try {
    for (const holdId of holdIds) {
      const item = await confirmSingleItem(holdId); // Each in its own transaction
      confirmedItems.push(item);
    }
    // All succeeded → process mock payment → create booking
    const booking = await createBookingRecord(confirmedItems, paymentInfo, idempotencyKey);
    return booking;
  } catch (err) {
    // COMPENSATE: undo all previously confirmed items
    for (const item of confirmedItems) {
      await compensateItem(item); // Restock inventory, mark as compensated
    }
    throw new BookingFailedError({ compensated: confirmedItems });
  }
}
```

### Guarantee Matrix

| Guarantee | Mechanism |
|-----------|-----------|
| **No oversell** | `FOR UPDATE` lock → check → update (atomic). DB CHECK constraint is the safety net. |
| **Idempotency** | `UNIQUE(idempotency_key)` — return existing record on retry, never create duplicate |
| **TTL hold** | Background `setInterval(30s)` expires holds and decrements `held_units` |
| **Saga compensation** | Try each item → on failure, loop back and undo all confirmed items |
| **Cancellation restock** | `booked_units -= N` within a transaction |

---

## 🤖 AI Feature: Natural Language Search

### Flow
```
User: "जयपुर में 3 रातों के लिए 3-स्टार होटल, ₹5000 से कम"
         │
         ▼
┌─── Gemini Function Calling ──────────────┐
│ Extracts structured params:              │
│  city: "Jaipur"                          │
│  check_in: "2026-12-20"                  │
│  nights: 3                               │
│  max_price: 5000, currency: "INR"        │
│  star_rating: 3                          │
└───────────────┬──────────────────────────┘
                ▼
┌─── SQL Query ────────────────────────────┐
│ JOIN hotels + room_types +               │
│ inventory_calendar + rate_plans          │
│ WHERE city=Jaipur, dates match,          │
│ free_units > 0, price ≤ 5000             │
└───────────────┬──────────────────────────┘
                ▼
┌─── Results + AI Summary ─────────────────┐
│ "3 hotels found near Jaipur with rooms   │
│  under ₹5000. The Haveli Inn has the     │
│  best rating (8.4) with a heritage room  │
│  at ₹3,200/night..."                     │
└──────────────────────────────────────────┘
```

### How We Prove It Works
- **20 predefined NL queries** (10 English, 10 Hindi) with expected structured output → measure parse accuracy
- **Grounding:** every result links to real `inventory_calendar` rows
- **Same Hindi/English query** → same results

---

## ✅ Scope: In vs Out

### IN (24-hour MVP)

| Feature | Status |
|---------|--------|
| Availability search API (+ AI NL search) | Core |
| TTL hold with idempotency | Core |
| Hold expiry background worker | Core |
| Booking confirmation with mock payment | Core |
| Multi-item saga with compensation | Core |
| Cancellation with restock | Core |
| Idempotent APIs (holds + bookings) | Core |
| Load test dashboard (zero oversell proof) | **Hero deliverable** |
| AI NL search (Gemini function calling) | Required |
| Web UI for the demo flow | Required |
| Hindi + English | Required |

### OUT (Deliberately Left Out — With Reasons)

| Feature | Why |
|---------|-----|
| Real payment gateway | Mock proves the flow; Razorpay adds integration risk, not systems value |
| User auth/sessions | Not the problem — hardcode demo user |
| Microservices | Shared transactions are critical for saga; monolith proves same guarantees with less ops |
| Flight search UI | API supports flights, demo focuses on hotel booking (cleaner story) |
| Email/SMS notifications | Nice-to-have, no correctness value |
| Dynamic pricing | Use static prices from seed data |
| Admin panel | No time, no demo value |

---

## 📐 Data Model

### Tables We Use
`inventory_calendar` · `holds` · `bookings` · `booking_items` · `payments` · `hotels` · `hotel_room_types` · `hotel_rate_plans` · `flights` · `flight_fares` · `cities` · `countries` · `currencies` · `fx_rates`

### Tables We Add (Rule R1 — extending, not renaming)

| New Table | Purpose |
|-----------|---------|
| `load_test_runs` | Store load test configuration and aggregate results |
| `load_test_results` | Per-request outcome (success/fail/latency) |
| `search_logs` | AI queries + parsed params (for measuring accuracy) |

---

## 👥 Team Roles & 24-Hour Plan

| Role | Person | Focus Area |
|------|--------|------------|
| **Backend Lead** | **Thijesh** | Inventory service, concurrency (FOR UPDATE), hold/booking APIs, saga |
| **Backend + AI** | **Tejas** | Gemini integration, NL search, multilingual, API scaffold |
| **Frontend Lead** | **Yogita** | React UI, search page, booking flow, load test dashboard |
| **Data + QA** | **Neha** | DB setup (Railway Postgres), data loading, load test engine, testing |

> [!NOTE]
> Role assignments are suggestions — rearrange based on who's strongest where. The key is that **concurrency logic** and **frontend** are separate people.

### Hour-by-Hour

| Block | Time | Thijesh (Backend) | Tejas (Backend+AI) | Yogita (Frontend) | Neha (Data+QA) |
|-------|------|----|----|----|----|
| **0** | 12:00–13:00 | **ALL FOUR:** Agree demo flow, confirm API contracts, set up repo + Railway project | | | |
| **1** | 13:00–15:00 | DB schema migrations (Knex), inventory search + check availability APIs | Express project scaffold, route structure, error handling middleware | React+Vite setup, design system, dark theme, component library | Load Postgres with CSV data (Railway), verify with conformance script |
| **2** | 15:00–17:00 | `createHold()` with FOR UPDATE + idempotency, `releaseHold()` | Gemini function calling: NL → structured search params, wire to search API | Search page: AI search bar, hotel result cards, availability display | Hold expiry worker (`setInterval`), unit tests for inventory module |
| **3** | 17:00–19:00 | `confirmBooking()` (hold→booking+payment), idempotency | Multilingual: Hindi query parsing, AI result summaries | Booking flow: hold countdown timer, confirm/pay modal, status updates | Integration tests: create hold → expire → verify restock |
| **4** | 19:00–21:00 | Multi-item saga: `confirmMultiItem()` with compensation rollback | Connect AI search to frontend, end-to-end search flow | Multi-item UI: add hotel+flight, show saga compensation status | Load test engine: fire N concurrent requests, collect results |
| **5** | 21:00–23:00 | Cancel booking → restock API, edge cases (double-cancel, expired hold) | Test 20 NL queries (10 EN, 10 HI), tune prompts, handle edge cases | Load test dashboard: real-time chart, success/fail counters, invariant check | Run first real load tests, find and fix concurrency bugs |
| **6** | 23:00–01:00 | Bug fixes, error handling, logging | Fallback: cached AI results for demo, structured search bypass | My Bookings page, cancellation UI, error states | Stress test: 500 concurrent, measure P99, find breaking points |
| **7** | 01:00–03:00 | **ALL FOUR:** Full integration test — run complete demo path end to end, fix broken seams | | | |
| **8** | 03:00–05:00 | Polish APIs, proper HTTP status codes, error messages | Solution write-up draft, architecture note | UI polish: hover effects, transitions, responsive layout | Final load test runs, screenshot/record results |
| **9** | 05:00–07:00 | 💤 **SLEEP** (teams that don't sleep demo badly — per the hackathon guide) | | | |
| **10** | 07:00–09:00 | Final bug fixes ONLY — no new features | Review write-up, prepare talking points | Ensure demo path is flawless on demo machine | Record fallback demo video (offline backup) |
| **11** | 09:00–11:00 | **ALL FOUR:** Stabilise. Fix demo path only. Nothing new. (THE 09:00 RULE) | | | |
| **12** | 11:00–12:00 | **ALL FOUR:** Rehearse demo TWICE. Decide speakers (2 voices max). | | | |

---

## 🎬 Demo Script (6 minutes)

| Min | What We Show | What It Proves |
|-----|-------------|----------------|
| 0–1 | Open app. Type Hindi: *"जयपुर में 2 रातों के लिए होटल, ₹5000 से कम"*. AI parses → results appear. | **AI works. Multilingual works.** |
| 1–2 | Pick a room → "Hold" → 10-min countdown starts. Show inventory count drop in real-time. | **TTL hold. Atomic inventory update.** |
| 2–3 | Add a flight → Confirm & Pay. Then trigger a flight failure → show hotel auto-rolls-back (compensated). | **Saga compensation works.** |
| 3–4 | Hit "Confirm" again (simulate retry) → same booking returned, no duplicate. | **Idempotency works.** |
| 4–5 | Cancel booking → inventory restocks (free units go back up). | **Cancellation restock works.** |
| 5–6 | 🔥 **Load Test:** Fire 200 concurrent requests at a room with 2 units. Chart shows exactly 2 succeed. Query DB: `booked + held ≤ total`. Zero violations. | **ZERO OVERSELL. THE HERO MOMENT.** |

---

## ⚠️ Risks & Fallbacks

| # | Risk | Fallback |
|---|------|----------|
| 1 | **Gemini API rate limit/quota** during demo | Pre-cache demo queries. Fallback to structured search form (dropdowns instead of NL). |
| 2 | **Concurrency bugs** under real load | Start load testing by hour 10, not hour 20. DB CHECK constraint is the ultimate safety net. |
| 3 | **Railway downtime / network at venue** | Keep a local Docker Postgres + SQLite fallback. Record a complete demo video before 09:00. |

---

## 🌐 Multilingual Approach

| Where | How |
|-------|-----|
| AI Search bar | Gemini handles Hindi natively — no extra work |
| UI labels | English default + Hindi toggle (i18n JSON files) |
| Hotel descriptions | English from data; AI-translated to Hindi on request |
| Error messages | Bilingual |
| Data conventions | BCP-47 tags: `hi`, `en-IN`, `ta` (Rule R6) |

---

## 🔑 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend language | **Node.js** | Team's strongest stack; concurrency logic is DB-level, language-agnostic |
| Locking strategy | **Pessimistic (FOR UPDATE)** | Simplest correctness; optimistic adds retry complexity we don't need |
| Architecture | **Modular monolith** | 24 hours; shared transactions; designed to split later |
| Load test | **Built into the product** | It's THE deliverable — make it a first-class feature with UI |
| AI feature | **NL search (Gemini function calling)** | Grounded in real data, measurable, impressive in demo |
| Payment | **Mock** | Real payment adds risk with zero correctness value |
| Deploy | **Railway** | One command deploy, free Postgres, zero DevOps |

---

## 📋 Open Items

> [!IMPORTANT]
> **XR Requirement:** The README says there's an XR device requirement on the statement's page in the hackathon app. Please check that page and share what it says — it could affect our scope.

> [!NOTE]
> **Role assignments** above are suggestions. Rearrange based on who's strongest at what. The main rule: the person doing concurrency logic should NOT also be doing frontend.
