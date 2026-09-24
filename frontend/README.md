# Kognivera web app (React 18 + Vite)

Airbnb-inspired booking UI for the APS-05 service — warm white surfaces, coral `#FF385C` accent, rounded cards,
soft shadows, no photography (icons and colour blocks instead) — plus a near-black **System Visualizer** and
**Load test** for the concurrency proof. English and Hindi. Vanilla CSS, hand-drawn SVG charts, `lucide-react` icons.

The visual design and page flow follow the `vera-hold-flow` reference; everything behind them is the real backend
(no mock data).

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api to the backend on :3000
npm run build      # -> dist/, which the backend serves at :3000 when present (rebuild after UI changes)
npm run check:i18n # every key used in src/ exists in en.json and hi.json, placeholders match
```

## Pages

Real URLs (History API router, `src/router.jsx`); the backend serves `index.html` for any non-`/api` path, so they
can be refreshed and shared. Old `#/search`-style links redirect.

| Route | What it shows |
|---|---|
| `/` **Home** | Hotels / Flights switcher with a structured search bar; AI search box (English/Hindi, "Powered by AI") with the cached **Try:** example chips; popular destinations with the real cheapest stay |
| `/search` **Results** | Filters (city, dates, price slider, rating, breakfast / free cancellation, sort) that live in the URL; hotel cards with low-stock badges; flight results. `?q=` runs the AI search and shows what was understood and which parser answered |
| `/hotel/:id` **Stay** | Room and rate-plan selection, exact price breakdown incl. 12% tax, "only N left" warning, **Add to trip** (holds nothing) |
| `/hold` **My trip** | Items added so far (hotel + flight), one **Reserve** that holds them all atomically under a single deadline, countdown banner (pulses under 60 s), release/expired recovery, **Card / UPI** with client-side validation. **Pay now** stays locked until the trip is reserved, then runs the real saga |
| `/confirmation/:id` | Animated check, booking reference, itinerary, **Retry the same request** (same idempotency key → same booking), rolled-back view when the saga compensates, cancel |
| `/bookings` | Upcoming / Past, status badges, cancel dialog showing the refund, line-by-line detail |
| `/visualizer` **System Visualizer** | Race, saga-failure and duplicate-retry scenarios with animated request dots, node/lock states and a JSON event log. **Simulated** replays a scripted timeline; **Live backend** drives the real API (real load test, real forced saga failure, real duplicate confirm) and logs what the server actually returned |
| `/loadtest` | Pick a scarce room, fire 100–1000 simultaneous requests, live counters/chart/percentiles, verdict with six checks, peak database sessions blocked on the row lock |

The header **Demo controls** (only when the backend is not in production) set a short hold time (15 s / 60 s) and
simulate a checkout failure (flight / hotel sells out, payment declined). They apply to one checkout and reset on
page load, so a demo setting can never leak into a real booking. On the payment form, **Fill test details** inserts
a dummy card for the mock gateway.

## Design notes

- **Tokens, not one-offs:** colours, radii and shadows are CSS custom properties in `src/styles.css`; the ops theme
  re-points the same tokens. Text on tinted badges uses darker "ink" variants for contrast.
- **Translations** are reviewed JSON (`src/locales`), never machine-translated at runtime; money/dates/numbers use `Intl`.
  **The Hindi text was written by an AI and needs review by a Hindi speaker before the demo.**
- **Money is never a float:** the tax breakdown uses integer minor units (`src/lib/money.js`, mirrors the backend's 12%
  rule); the server's total at confirm time is authoritative and matched the estimate in testing.
- **Cart, then one reservation:** drafts hold nothing; Reserve is a single `POST /api/holds` over every item, so all holds share one `expires_at`. Holds are matched back to items by `inventory_id`, never by position. Changing a reserved trip releases the reservation, so active items can never carry different deadlines; a sold-out item fails the whole request and is named.
- **Idempotency:** each user action gets one key (`newKey`) and re-uses it on retry; a changed checkout payload gets a new key.
- **Payment form:** a mock gateway — card fields are validated in the browser and never sent; only the method is.
- **State:** `context.jsx` (config, currency, toasts), `router.jsx`, `trip.jsx` (holds + last outcome, persisted to
  localStorage), `i18n.jsx`. Windows file names are case-insensitive, so `App.jsx` and a would-be `app.jsx` collide.
- **Visualizer event source:** `src/viz/scenarios.js` (simulated) and `src/viz/live.js` (real backend) emit the same
  event shape, so a WebSocket/SSE adapter is a third source, not a rewrite. The Live source creates real holds and
  bookings and then cancels or rolls them back (nothing is hard-deleted).
- Hotel descriptions are shown in English (translation deferred until a Cloud Translation key is available).
