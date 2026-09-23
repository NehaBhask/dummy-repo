# Kognivera web app (React 18 + Vite)

Dark-theme single-page app for the APS-05 booking service. English and Hindi. No UI framework, no chart
library: vanilla CSS and hand-drawn SVG.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api to the backend on :3000
npm run build      # -> dist/, which the backend serves at :3000 when present
npm run check:i18n # every key used in src/ exists in en.json and hi.json, placeholders match
```

## Screens

| Route | What it shows |
|---|---|
| `#/search` | AI search bar (English/Hindi, shows what was understood, which parser answered, and steers away from cities with no rooms) + structured filters + hotel cards with live availability and rate plans → **Hold this room** |
| `#/trip` | Held items with live countdowns (server-confirmed), add a flight, confirm & pay, **Retry the same request** (same idempotency key: proves no duplicate), rolled-back view when the saga compensates |
| `#/bookings` | All bookings with line items (rolled-back lines struck through), payment state, cancel with restock |
| `#/loadtest` | Pick a scarce room, fire 100–1000 simultaneous requests, live counters/chart/percentiles, verdict with six checks, peak database sessions blocked on the row lock |

The header **Demo** menu (only when the backend is not in production) sets a short hold time (15 s / 60 s) and
simulates a checkout failure (flight / hotel sells out, payment declined). These reset on every page load and
after each checkout attempt so a demo setting can never leak into a real booking.

## Design notes

- **Translations** are reviewed JSON (`src/locales`), never machine-translated at runtime; money/dates/numbers use `Intl`.
  **The Hindi text was written by an AI and needs review by a Hindi speaker before the demo.**
- **Idempotency:** each user action gets one key (`newKey`) and re-uses it on retry; a changed checkout payload gets a new key.
- **State:** `context.jsx` (config, currency, routing, toasts), `trip.jsx` (holds + last outcome, persisted to
  localStorage), `i18n.jsx`. Note Windows file names are case-insensitive, so `App.jsx` and a would-be `app.jsx` collide.
- Hotel descriptions are shown in English (translation deferred until a Cloud Translation key is available).
