# Comparison: design_submission.md vs design_submission_dora.md

## Summary

Both documents are **very close** — same structure, same 14 sections, same core content. Dora's version is essentially a refined revision of ours that incorporates the concurrency feedback more tightly. Here's a section-by-section diff:

---

## Sections That Are Identical (No Differences)

| Section | Verdict |
|---------|---------|
| **1. Cover** | Identical |
| **2. Problem Understanding** | Identical |
| **8. AI Features** | Identical |
| **9. Business Benefits** | Identical |
| **13. Multilingual Approach** | Identical |
| **14. XR Declaration** | Identical |

---

## Sections Where Dora's Version Is Better

### 1. Section 3 (Scope) — Two Extra "Out" Items

Dora adds two additional items to the "deliberately leaving out" table:

| Extra Item | Dora's Reasoning |
|-----------|-----------------|
| **Kafka / message queue** | *"Our invariant needs strong transactional consistency, which Postgres row-locking already gives us. Routing bookings through an async queue would mean rebuilding correctness as an event-sourced saga — a bigger project than 24 hours affords."* |
| **Load balancer / horizontal scaling** | *"Our load test proves the invariant against a single deployed instance; Postgres row locks already serialize correctly across instances if we ever add more."* |

> **Verdict:** ✅ **Worth adopting.** These are exactly the kind of "why NOT this?" answers that show systems judgement. Kafka especially — someone will ask "why not use a message queue?" and this pre-empts it.

---

### 2. Section 5 (Architecture) — "Concurrency Hardening Notes" Subsection

This is the **biggest difference**. Dora adds a dedicated subsection with 7 bullet points:

| Dora Has | We Have | Gap |
|----------|---------|-----|
| Fixed lock ordering (deadlock prevention) | ✅ We have this (in Section 6) | Same, but Dora puts it in architecture too |
| Idempotent upsert via `ON CONFLICT` | ✅ We have this (in Section 6) | Same, but Dora puts it in architecture too |
| Connection pooling `pg.Pool(max: 20)` | ✅ We have this | Same |
| **`lock_timeout = '2s'`** | ❌ We DON'T have this | **Gap — worth adding** |
| **Isolation level: `READ COMMITTED` + explicit row locks, not `SERIALIZABLE`** | ❌ We DON'T have this | **Gap — worth adding** |
| **Index check on FOR UPDATE query** | ❌ We DON'T have this | **Gap — worth adding** |
| **No I/O inside the locked transaction** | ❌ We DON'T have this | **Gap — worth adding** |

> **Verdict:** ✅ **Adopt the 4 missing points.** These are each one sentence but show deep understanding of what breaks under real load:
> - `lock_timeout` → prevents hung requests from stalling the load test dashboard
> - Isolation level → shows you chose `READ COMMITTED` deliberately, not by default
> - Index check → an unindexed `FOR UPDATE` can lock the whole table, not just one row
> - No I/O inside lock → the mock payment must NOT happen while the row is locked

---

### 3. Section 5 (Architecture Diagram) — pg.Pool as Separate Box

Dora shows the connection pool as a **separate visual element** between the backend and Postgres:

```
              ┌──────┐
              │pg.Pool│  max: 20 — reused connections...
              └──┬───┘
                 │
          ┌──────▼──────┐
          │  PostgreSQL  │
```

We embed it as a line inside the Postgres box. Dora's is more visually clear.

> **Verdict:** Minor visual preference. Either works in a PDF.

---

### 4. Section 6 (Flow Diagram) — Confirm Step Wording

Dora's confirm step shows the `ON CONFLICT` / `RETURNING *` language explicitly:

```
INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
RETURNING * — atomic upsert, no dupe even under concurrent retries
```

We have the same concept but with slightly different wording. Both are correct.

> **Verdict:** 🔄 Roughly equivalent. Dora's has a more explicit annotation.

---

### 5. Section 7 (Data Model) — Index Mention on inventory_calendar

Dora adds to the `inventory_calendar` row:
> *"We confirm an index exists on the columns our `FOR UPDATE` lock query filters on (`hotel_room_type_id`, `for_date`) before load testing."*

We don't mention indexing at all.

> **Verdict:** ✅ **Worth adding.** One sentence, but it shows awareness that `FOR UPDATE` on an unindexed column is a table-level lock in disguise.

---

### 6. Section 10 (Tech Stack) — Connection Pooling as Separate Row

Dora adds `pg.Pool` as its **own tech stack row** with the reasoning:
> *"Prevents exhausting Postgres's max_connections when the load test fires 200–500 concurrent requests"*

We fold it into the DB Client row.

> **Verdict:** Minor. Dora's is slightly clearer because it calls out the load test connection risk explicitly.

---

### 7. Section 11 (24-Hour Plan) — Task Specificity

Dora's schedule has more specific task names:

| Block | Dora's Version | Our Version |
|-------|---------------|-------------|
| Block 1 (Neha) | *"...confirm index on `inventory_calendar(hotel_room_type_id, for_date)`"* | No index mention |
| Block 1 (Thijesh) | *"...configure `pg.Pool(max:20)`"* | No pool mention |
| Block 2 (Thijesh) | *"...fixed lock ordering"* | No lock ordering mention |
| Block 3 (Thijesh) | *"...via `INSERT...ON CONFLICT...RETURNING`, `lock_timeout` set"* | Just says "idempotency" |
| Block 4 (Thijesh) | *"...fixed lock order across items"* | Just says "compensation" |
| Block 5 (Yogita) | *"...p50/p95/p99 latency"* on dashboard | Just says "counters" |

> **Verdict:** ✅ **Worth adopting.** These small additions show the concurrency work is planned, not an afterthought. Judges see "fixed lock ordering" in hour 2 and know the team thought about it early.

---

### 8. Section 12 (Risks) — Risk #4 and Enhanced Risk #2

Dora adds:
- **Risk #4**: Compensation transaction failure — as a numbered risk, not a "known limitations" table
- **Risk #2 enhancement**: *"Fixed lock ordering and an explicit `lock_timeout` reduce the two most likely causes (deadlock, hung requests) before they show up under load."*

We have these as a "Known Limitations" table instead. Both approaches work.

> **Verdict:** 🔄 Roughly equivalent formats. Dora integrates it into the risk table directly; ours separates risks from known limitations. Either reads well.

---

## Sections Where OUR Version Is Better

### 1. Section 4 (User Journey) — Visual Flow Diagram

**We have a full visual flowchart** (the ASCII art diagram showing Search → Hold → Confirm/Expire → Saga → My Bookings → Cancel). Dora has **no diagram** — just the screen descriptions.

> **Verdict:** ✅ **Our version is better here.** The flowchart is exactly what the submission guide asks for: *"Two or three screens sketched beats ten described."*

---

### 2. Section 4 — Latency Percentile Story on Load Test Dashboard

We have the explanation:
> *"The latency percentiles are the visually convincing 'this is a real systems problem' story — they show the cost of serialised access under contention, not just the pass/fail outcome."*

Dora mentions p50/p95/p99 but doesn't explain *why* they matter for the story.

> **Verdict:** ✅ **Our version is better** — it tells the judge what to look for.

---

### 3. Section 7 (Data Model) — p50/p95/p99 in load_test_runs Table

Our `load_test_runs` table includes `p50_ms`, `p95_ms`, `p99_ms` columns. Dora's doesn't.

> **Verdict:** ✅ **Our version is better** — the data model matches the dashboard we promised.

---

### 4. Section 12 — Known Limitations Table with Production Fixes

Our "Known Limitations" table includes **3 items with production fixes**:
- Compensation failure → dead-letter queue
- Single-instance worker → advisory lock
- No saga persistence → saga_log table

Dora only covers compensation failure (as Risk #4) and mentions the single-instance caveat inline.

> **Verdict:** ✅ **Our version is more thorough** — the production fix column shows we know the real solution even though we're cutting it.

---

## Recommendations: What to Merge into Our Document

### Must-Add (4 items — each is one sentence)

1. **`lock_timeout = '2s'`** — Add to architecture notes: contended requests fail fast with a clear "sold out" instead of hanging
2. **Isolation level: `READ COMMITTED`** — State it explicitly: we chose this deliberately because our conflicts are on known rows via `FOR UPDATE`
3. **Index check on FOR UPDATE query** — Add to data model: verify `inventory_calendar` has an index on the filter columns before load testing
4. **No I/O inside the locked transaction** — Mock payment happens outside the lock, so a slow external call never blocks other requests

### Should-Add (2 items — strengthen scope section)

5. **Kafka / message queue** in scope-out table
6. **Load balancer / horizontal scaling** in scope-out table

### Nice-to-Have (make schedule more specific)

7. Add concurrency-specific task names to the 24-hour plan (lock ordering, lock_timeout, index check in specific blocks)

---

## Overall Assessment

| Aspect | Ours | Dora's |
|--------|------|--------|
| User journey visual | ✅ Better (has flowchart) | ❌ No diagram |
| Concurrency depth | Good (deadlock, idempotency, pool) | ✅ Better (adds lock_timeout, isolation level, index check, no-I/O-inside-lock) |
| Scope-out reasoning | Good (8 items) | ✅ Better (10 items, includes Kafka and LB) |
| Known limitations | ✅ Better (3 items with production fixes) | Good (1 item as risk) |
| Load test data model | ✅ Better (has p50/p95/p99 columns) | Missing percentile columns |
| Schedule specificity | Good | ✅ Better (concurrency tasks named in blocks) |
| Latency storytelling | ✅ Better (explains why judges should care) | Just lists p50/p95/p99 |

**Bottom line:** Merge the 4 concurrency points from Dora into our doc and we have the stronger submission.
