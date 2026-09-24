# --rebase

**KogniVera Hackathon 2026**

- Problem statement: Distributed Booking & Inventory System (Concurrency & Consistency)
- College: BMS College of Engineering

Push all your 24-hour hackathon work to **this repository**. Every team member has write access; judges have read access.

---

## Required repository structure

Your repo (`kv-hack2026-rebase`) must follow this layout. We expect your codebase organised this way —
**MVP completeness against your Problem Statement**, **coverage**, and **data-model conformance** all
need to be easy to find, and a clear, predictable layout helps the judges assess your work and scores
materially higher on "Repo Hygiene & Structure".

```
kv-hack2026-rebase/
├── README.md                 # REQUIRED — see the README contract below
├── frontend/                 # UI app (React/Next/Flutter/…) — or web/ / app/
│   ├── src/
│   └── package.json
├── backend/                  # API / services (Node/Python/…) — or server/ / api/
│   ├── src/
│   └── (requirements.txt | package.json | pom.xml | …)
├── data-model/               # REQUIRED — your schema + how it maps to the shared data model
│   ├── schema.sql            # or prisma/schema.prisma, models.py, migrations/…
│   ├── seed/                 # seed data / fixtures used in the demo
│   └── DATA_MODEL.md         # which canonical tables (D1–D9) you use + any additions
├── ai/                       # AI/ML code: prompts, retrieval, model calls, evals
│   ├── prompts/
│   └── (retrieval | model | pipeline).*
├── docs/                     # architecture notes, API docs, demo script
│   └── ARCHITECTURE.md
├── tests/                    # automated tests (unit / integration / the "hard proof" test)
├── .env.example              # REQUIRED — every env var your app needs, with dummy values
└── .gitignore
```

> Monorepo or split folders are both fine — the key is that **frontend, backend, data-model, ai, and
> tests are clearly separated and discoverable**. If your framework dictates its own layout (e.g. Next.js
> app router), keep it, but still add `data-model/`, `docs/`, and `tests/`.

## README contract (required sections, in order)

1. **Team & Problem Statement** — team name, PS id + title.
2. **What we built** — 3–6 bullets mapping to your PS's MVP checklist.
3. **Architecture** — one diagram or a short component list (frontend ↔ backend ↔ data ↔ AI).
4. **Data model** — which canonical tables (D1–D9) you use, and any tables you added.
5. **AI features** — each AI capability, the mechanism (model/technique/library), and how it's grounded.
6. **Run it locally** — exact steps: install, env (`.env.example`), migrate/seed, start, open.
7. **Demo path** — the exact click-path that completes your MVP's terminal outcome.
8. **Tests / proof** — how to run your tests, including the statement's hard-proof test where one applies.

## Data-model conformance (scored)

- Use the **canonical shared data model** for your Problem Statement as the source of truth. Keep the
  canonical table and column names.
- Additions are allowed — **document them** in `data-model/DATA_MODEL.md` (new tables/columns, why).
- Boundary rules stated in your PS (currency, min/max, capacity, constraints) must be **enforced in
  code**, not just described — put the enforcement in the backend and cover it with a test.

## What we look for in your repository

| Dimension | What scores well |
|---|---|
| **MVP completeness** | Each item in your PS "What you need to build" is present and wired end-to-end in code. |
| **Coverage vs PS** | The core capability + terminal outcome of the statement are implemented and reachable from the app entry point. |
| **Data-model conformance** | Canonical tables/columns used; boundary rules enforced in code; additions documented. |
| **Structure & hygiene** | This layout followed; README contract complete; `.env.example` present; sensible commit history. |
| **Runnability** | Clear run steps; app builds; seed/fixtures let the demo path run. |

Assessment is **strict**: unimplemented MVP items, undocumented schema drift, or an unrunnable repo lower
the score. Claims in the README that aren't backed by code do not count — **the code is the evidence**.
