# Demo script — live run-through (~6 min)

Two speakers at most. Everything below was run and verified against this repo; nothing is aspirational.

## Before you walk up (15–30 min ahead)

- [ ] `docker compose up -d` (repo root) — Postgres "healthy".
- [ ] `cd backend && npm run migrate && npm run build:web && npm start` → `http://localhost:3000` loads the real app. (`npm start` serves whatever is in `frontend/dist`; **rebuild after any frontend change.**)
- [ ] For the AI step click **AI search** and **paste** one of the demo queries below **exactly** (keep them in a notes file). They are pre-cached (`ai/search.js → seedDemoQueries`), so they answer instantly and correctly even if the Gemini API is down — badge shows **Cached**. Free-typed queries still need Gemini (or fall back to the English heuristic parser and can be slow: up to ~13–27 s while three models time out).
- [ ] Clear leftover holds/bookings from rehearsal (the My trip badge in the header / My bookings) so the live run starts clean.
- [ ] Have a second browser tab pre-loaded on a finished GitHub Actions run of `distributed-load-test.yml` (screenshot as backup). It is **shown, never re-triggered live** (~85 s of dead air).
- [ ] Decide who speaks for which step now.

## Run-through

| # | ≈ Time | Do | Say | Proves |
|---|---|---|---|---|
| 1 | 0:00 | Click **AI search** in the Where box → paste `जयपुर में 2 रातों के लिए होटल, ₹5000 से कम` → Enter. | "Search in your own language. Gemini fills in city, dates and budget; every room you see is a real database row — the model never invents inventory." | AI search, multilingual, grounded |
| 2 | 0:45 | **View stay** on a hotel marked "Only N left" → **Add to trip** → **Add a flight** → **Add to trip** → **Reserve for 10 min**; point at the one countdown. | "Nothing is held while you browse. Reserve locks the hotel and the flight together, in one transaction, under one timer — it can never run out on one and not the other." | TTL hold, shared deadline |
| 3 | 1:30 | Header → **Demo controls** → *Simulate a failure at checkout* → *Flight sells out (hotel is rolled back)*. **Fill test details** → **Pay now**. | "Part of a multi-item booking fails — watch the hotel that was already confirmed get rolled back and its room returned. Nothing half-booked." | Saga + compensation |
| 4 | 2:30 | On a confirmed booking click **Retry the same request**. | "A flaky network makes the app retry — same key, same booking back, never a duplicate." | Idempotent API |
| 5 | 3:00 | **My bookings → Cancel booking**; switch currency in the header. | "Cancel restocks and refunds. Prices are localised through a dated FX table." | Cancellation + restock, localised currency |
| 6 | 3:30 | **Load test** tab → scarcest room pre-selected → **Fire N requests**. | "Hundreds of simultaneous requests for the last few rooms. Zero oversell — and it read the *database*, not our own counts, to say so." | The headline guarantee |
| 6b | 4:15 | Open two tabs → sign in as two different travellers (demo login, no password). Both add the same last-unit room to their trip; user A **Reserve** → user B **Reserve**. Then a third tab → **Operations dashboard**. | "Two people, one room. One gets it, the other is told it is sold out — and the operator view shows the hold, the rejected attempt, the counts and 0 violations, read from the database." | Correctness under concurrency, per-user sessions |
| 7 | 5:00 | Switch to the pre-loaded GitHub Actions tab; point at the green run. | "The same guarantee held when fired from five separate machines on GitHub's cloud — real distributed clients." | Distributed proof |
| 8 | 5:30 | *(if asked)* **System Visualizer → Live backend** → run the three scenarios (each logs what the server really returned), or `npm run loadtest:mixed` in a terminal. | "Winners confirm, the rest abandon and expire; the closing balance `booked + held + available == total` prints PASS with the numbers." | No stock leaked by expired holds |

## If something goes sideways

- **Gemini down / slow:** paste a cached query. If a free-typed query hangs, say "that's the live model; the safety net is the cache" and paste one, or use the structured search form — no AI dependency.
- **A check shows red in the load test:** say so plainly — that is the database catching something, exactly what it is there for — and show the pinned Actions run as the proof. Never hide a red result.
- **Venue wifi drops:** steps 1–6 run entirely on the laptop (the pasted AI queries are cached). Only step 7 needs the network — hence pre-loaded.
- **Backend not responding:** check nothing else holds port 3000, restart `npm start`.

## Short answers for judges

- *Is the load test really concurrent?* Yes — all requests are released at one instant over real HTTP; we also sample Postgres' own lock-wait counters during the run to show contention actually reached the database.
- *Who wins a tight race?* Postgres's row-lock queue. The guarantee is exactly the free units are granted and never more — not millisecond fairness.
- *What if the server crashes mid-booking?* Every completed step is persisted; the gap is that an interrupted saga isn't auto-resumed (no recovery worker yet). Named limitation, known fix. Full list: `docs/ARCHITECTURE.md`.
- *Why isn't it on a public URL?* It runs locally for latency; a tunnel is one command away and is exactly what produced the distributed proof.
