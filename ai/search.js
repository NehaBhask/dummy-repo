import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import { AppError } from '../backend/src/errors.js';
import { newId } from '../backend/src/ids.js';
import { searchHotels } from '../backend/src/modules/inventory/search.js';

/*
 * Natural-language search: text (English or Hindi) → structured params → the SAME grounded SQL
 * search as the form UI. The model never sees or invents inventory; it only fills in the
 * parameters, so every result is a real row with real availability (design §8).
 *
 * Gemini function calling is used when GEMINI_API_KEY is set. If it is missing, rate-limited or
 * down, a small English-only heuristic parser keeps the demo alive (design risk #1) and the
 * response says which parser answered.
 */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

// Prompts and the function-calling schema live in ai/prompts/ so they can be reviewed and versioned
// as artifacts, not buried in code. {{placeholders}} are filled by render().
const promptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const readPrompt = (name) => readFileSync(path.join(promptDir, name), 'utf8');
const render = (template, vars) => template.trim().replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
const TOOL = JSON.parse(readPrompt('search_hotels.tool.json'));
const SEARCH_SYSTEM_PROMPT = readPrompt('search_system.md');
const SUMMARISE_PROMPT = readPrompt('summarise.md');

const cache = new Map(); // normalised query → parsed params (also serves as the pre-cached demo path)
const cities = { at: 0, names: [] };

async function cityNames() {
  if (Date.now() - cities.at > 10 * 60_000) {
    cities.names = (await pool.query(`SELECT name FROM cities WHERE status = 'active' ORDER BY name`)).rows.map((r) => r.name);
    cities.at = Date.now();
  }
  return cities.names;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => isoDate(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));

/** Pre-load answers for demo queries so a live demo never depends on the network. */
export function primeCache(query, params) {
  cache.set(normalise(query), { ...params });
}
const normalise = (q) => q.trim().toLowerCase().replace(/\s+/g, ' ');

// The exact "Try:" example queries shown in the UI (frontend/src/locales/{en,hi}.json), pre-answered
// so the live demo's opening beat never depends on Gemini being reachable at pitch time. A healthy
// Gemini is never consulted for these — cache is checked first in aiSearch() — but that's fine: the
// params below are what Gemini would return anyway, just guaranteed instead of best-effort.
export function seedDemoQueries() {
  primeCache('3-star hotel in Jaipur for 2 adults, Oct 10-12, under ₹5000', {
    city: 'Jaipur', check_in_date: '2026-10-10', nights: 2, adults: 2, star_rating: 3, max_price_per_night: 5000, currency: 'INR',
  });
  primeCache('जयपुर में 2 लोगों के लिए 3-स्टार होटल, 10-12 अक्टूबर, ₹5000 से कम', {
    city: 'Jaipur', check_in_date: '2026-10-10', nights: 2, adults: 2, star_rating: 3, max_price_per_night: 5000, currency: 'INR',
  });
  primeCache('जयपुर में 2 रातों के लिए होटल, ₹5000 से कम', {
    city: 'Jaipur', nights: 2, max_price_per_night: 5000, currency: 'INR',
  });
  primeCache('Heritage stay in Udaipur, 3 nights from Oct 15, breakfast included', {
    city: 'Udaipur', check_in_date: '2026-10-15', nights: 3, preferences: ['breakfast'],
  });
  primeCache('उदयपुर में 15 अक्टूबर से 3 रातों के लिए हेरिटेज होटल, नाश्ता शामिल', {
    city: 'Udaipur', check_in_date: '2026-10-15', nights: 3, preferences: ['breakfast'],
  });
}

// Try each configured model in turn: a busy (503), retired (404) or slow model must not take the
// search bar down. The first model that answers wins; the last error is reported if all fail.
async function callGemini(body) {
  let lastErr;
  for (const model of config.gemini.models) {
    try {
      const res = await fetch(`${GEMINI}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`gemini ${model} ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`);
      const json = await res.json();
      json.__model = model;
      return json;
    } catch (err) {
      lastErr = err.name === 'TimeoutError' ? new Error(`gemini ${model} timed out`) : err;
    }
  }
  throw lastErr;
}

async function parseWithGemini(text, today, names) {
  const system = render(SEARCH_SYSTEM_PROMPT, { today, cities: names.join(', ') });
  const json = await callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    tools: [{ functionDeclarations: [TOOL] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search_hotels'] } },
  });
  const call = json.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
  if (!call?.args) throw new Error('gemini returned no function call');
  Object.defineProperty(call.args, '__model', { value: json.__model, enumerable: false });
  return call.args;
}

// Common names that aren't a row in `cities` (e.g. the demo query says "Goa"; the data has Panaji).
const CITY_ALIASES = {
  goa: 'Panaji', bombay: 'Mumbai', bangalore: 'Bengaluru', delhi: 'New Delhi', calcutta: 'Kolkata',
  cochin: 'Kochi', trivandrum: 'Thiruvananthapuram', mysore: 'Mysuru', benares: 'Varanasi',
  banaras: 'Varanasi', vizag: 'Visakhapatnam', pondicherry: 'Pondicherry', ooty: 'Ooty',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SYMBOLS = { '₹': 'INR', rs: 'INR', inr: 'INR', $: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP' };

/** English-only fallback. Deliberately small: it exists to keep the demo alive, not to compete. */
export function parseHeuristic(text, today, names) {
  const t = text.toLowerCase();
  const out = {};
  out.city =
    [...names].sort((a, b) => b.length - a.length).find((n) => new RegExp(`\\b${n.toLowerCase()}\\b`).test(t)) ??
    Object.entries(CITY_ALIASES).find(([alias, name]) => new RegExp(`\\b${alias}\\b`).test(t) && names.includes(name))?.[1];

  const year = Number(today.slice(0, 4));
  const iso = t.match(/(\d{4}-\d{2}-\d{2})/);
  const range = t.match(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\b`));
  const single = t.match(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`)) ??
    t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})`));
  const toDate = (m, d) => {
    let date = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (date < today) date = `${year + 1}${date.slice(4)}`;
    return date;
  };
  if (iso) out.check_in_date = iso[1];
  else if (range) {
    out.check_in_date = toDate(MONTHS.indexOf(range[1]), Number(range[2]));
    out.nights = Math.max(1, Number(range[3]) - Number(range[2]));
  } else if (single) {
    const [month, day] = MONTHS.includes(single[1]) ? [single[1], single[2]] : [single[2], single[1]];
    out.check_in_date = toDate(MONTHS.indexOf(month), Number(day));
  }

  out.nights ??= Number(t.match(/(\d+)\s*nights?/)?.[1]) || undefined;
  out.rooms = Number(t.match(/(\d+)\s*rooms?/)?.[1]) || undefined;
  out.adults = Number(t.match(/(\d+)\s*(?:adults?|guests?|people|persons?)/)?.[1]) || undefined;
  out.star_rating = Number(t.match(/(\d)\s*-?\s*stars?/)?.[1]) || undefined;
  const price = t.match(/(?:under|below|less than|upto|up to|max(?:imum)?|within)\s*(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)?\s*([\d,]+)/);
  if (price) {
    out.max_price_per_night = Number(price[2].replace(/,/g, ''));
    out.currency = SYMBOLS[(price[1] ?? '').replace('.', '')] ?? undefined;
  }
  const prefs = [];
  if (/breakfast/.test(t)) prefs.push('breakfast');
  if (/refundable|free cancellation/.test(t)) prefs.push('refundable');
  if (prefs.length) out.preferences = prefs;
  return out;
}

async function summarise(results, lang) {
  if (!config.gemini.apiKey || !results.length) return null;
  const top = results.slice(0, 3).map((r) => ({
    hotel: r.hotel.name, stars: r.hotel.star_rating, score: r.hotel.guest_score,
    from: r.from_price.display, room: r.rooms[0].name, left: r.rooms[0].available_units,
  }));
  try {
    const json = await callGemini({
      contents: [{
        role: 'user',
        parts: [{
          text: render(SUMMARISE_PROMPT, { language: lang === 'hi' ? 'in Hindi' : 'in English', data: JSON.stringify(top) }),
        }],
      }],
    });
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null; // the summary is garnish; never fail the search over it
  }
}

/** Map model/heuristic output onto the search API's parameter names, with safe defaults. */
const CURRENCY_HINTS = [[/₹|रुपये|रुपए|\brs\.?\b|\binr\b/i, 'INR'], [/\$|\busd\b|dollar/i, 'USD'], [/€|\beur\b/i, 'EUR'], [/£|\bgbp\b/i, 'GBP']];

// A budget with no currency would be compared against each hotel's own currency (a Dubai hotel's AED
// against ₹5000), so infer it from the traveller's own text, defaulting to INR for this platform.
function budgetCurrency(p, text) {
  if (p.currency && /^[A-Z]{3}$/.test(p.currency)) return p.currency;
  return CURRENCY_HINTS.find(([re]) => re.test(text))?.[1] ?? 'INR';
}

function toSearchParams(p, today, text = '') {
  return {
    city: p.city,
    check_in: p.check_in_date ?? addDays(today, 1),
    nights: clamp(p.nights ?? 1, 1, 30),
    rooms: clamp(p.rooms ?? 1, 1, 10),
    adults: clamp(p.adults ?? 2, 1, 20),
    max_price: p.max_price_per_night > 0 ? p.max_price_per_night : undefined,
    currency: p.max_price_per_night > 0 ? budgetCurrency(p, text) : undefined,
    min_stars: p.star_rating ? clamp(p.star_rating, 1, 5) : undefined,
    breakfast: p.preferences?.includes('breakfast') || undefined,
    refundable: p.preferences?.includes('refundable') || undefined,
  };
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(n))));

// Only some hotels have room-night rows in inventory_calendar (in the seed, 43 of 60 cities), so a city
// can exist in the catalogue and still never return a result. Say so instead of a bare "0 results".
const withInventory = { at: 0, rows: [] };
async function citiesWithInventory() {
  if (Date.now() - withInventory.at > 10 * 60_000) {
    withInventory.rows = (
      await pool.query(
        `SELECT c.name, count(*)::int AS room_nights
           FROM inventory_calendar ic
           JOIN hotel_room_types rt ON rt.room_type_id = ic.entity_id
           JOIN hotels h ON h.hotel_id = rt.hotel_id
           JOIN cities c ON c.city_id = h.city_id
          WHERE ic.entity_type = 'room_type' AND ic.for_date >= CURRENT_DATE
          GROUP BY c.name ORDER BY room_nights DESC, c.name`,
      )
    ).rows;
    withInventory.at = Date.now();
  }
  return withInventory.rows;
}

export async function aiSearch({ query, currency }) {
  const started = Date.now();
  const today = isoDate(new Date());
  const names = await cityNames();
  const language = /[ऀ-ॿ]/.test(query) ? 'hi' : 'en-IN';

  let raw = cache.get(normalise(query));
  let parser = raw ? 'cache' : null;
  let fallbackReason = null;

  if (!raw && config.gemini.apiKey) {
    try {
      raw = await parseWithGemini(query, today, names);
      parser = 'gemini';
    } catch (err) {
      fallbackReason = err.message;
    }
  }
  if (!raw) {
    if (language === 'hi' && !config.gemini.apiKey) {
      throw new AppError('ai_unavailable', { details: { reason: 'Hindi queries need GEMINI_API_KEY' } });
    }
    raw = parseHeuristic(query, today, names);
    parser = 'heuristic';
  }
  if (parser === 'gemini') cache.set(normalise(query), raw);

  if (!raw.city || !names.some((n) => n.toLowerCase() === String(raw.city).toLowerCase())) {
    return { language, parser, fallback_reason: fallbackReason, parsed_params: raw, needs_clarification: 'city', results: [], total: 0 };
  }

  const params = toSearchParams(raw, today, query);
  // The budget stays in the currency the traveller stated it in; the header currency only changes how prices are shown.
  params.budget_currency = params.max_price ? params.currency : undefined;
  if (currency) params.currency = currency;
  const found = await searchHotels(params);
  const summary = parser === 'heuristic' && !config.gemini.apiKey ? null : await summarise(found.results, language === 'hi' ? 'hi' : 'en');

  await pool
    .query(
      `INSERT INTO search_logs (log_id, raw_query, language, parser, parsed_params, result_count, latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [newId('slg'), query, language, parser, JSON.stringify(raw), found.total, Date.now() - started],
    )
    .catch((err) => console.error('[ai] search_logs insert failed:', err.message));

  return {
    language,
    parser,
    model: raw.__model,
    fallback_reason: fallbackReason,
    parsed_params: raw,
    search_params: found.query,
    summary,
    currency: found.currency,
    fx_rate_date: found.fx_rate_date,
    total: found.total,
    results: found.results,
    ...(found.total === 0 ? await noResultsHint(raw.city) : {}),
  };
}

async function noResultsHint(city) {
  const cities = await citiesWithInventory();
  const has = cities.some((c) => c.name.toLowerCase() === String(city).toLowerCase());
  return {
    no_results_reason: has ? 'no_match_for_filters' : 'city_has_no_inventory',
    cities_with_inventory: cities.slice(0, 10).map((c) => c.name),
  };
}
