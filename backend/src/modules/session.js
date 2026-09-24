import { pool } from '../db.js';
import { AppError } from '../errors.js';

/*
 * Mock login. This is a demo session, NOT authentication: the browser names a user in `X-User-Id` and the
 * server checks that it is a real active user (or the operator). There are no passwords or tokens, so anyone
 * who can reach the API can claim any identity — fine for a demo, never for production.
 *
 * A request with no header keeps the old behaviour (it acts as the demo user), so load-test scripts, k6 and the
 * GitHub Actions workflows work unchanged. The web app itself forces a login before showing anything.
 */
export const OPERATOR_ID = 'operator';
export const OPERATOR = { role: 'operator', user_id: OPERATOR_ID, display_name: 'Operations', home_currency: 'INR', locale: 'en-IN' };

const COLS = 'user_id, display_name, home_currency, locale, loyalty_tier';
const PERSONA_COUNT = 10;
let personas = null;

/**
 * The 10 demo travellers, chosen by a fixed rule so every machine shows the same list: the first two active INR
 * users (the Alice-and-Bob pair for the two-browser scenario), then the first active user of each other home
 * currency, most common currency first — so switching user also shows localised prices.
 */
export async function listPersonas() {
  if (personas) return personas;
  const leads = (await pool.query(`SELECT ${COLS} FROM users WHERE status = 'active' AND home_currency = 'INR' ORDER BY user_id LIMIT 2`)).rows;
  const others = (
    await pool.query(
      `SELECT DISTINCT ON (home_currency) ${COLS}, count(*) OVER (PARTITION BY home_currency) AS n
         FROM users WHERE status = 'active' AND home_currency <> 'INR'
        ORDER BY home_currency, user_id`,
    )
  ).rows.sort((a, b) => Number(b.n) - Number(a.n) || a.home_currency.localeCompare(b.home_currency));
  personas = [...leads, ...others]
    .slice(0, PERSONA_COUNT)
    .map(({ n, ...u }, i) => ({ ...u, display_name: u.display_name?.trim() || `Traveller ${i + 1}`, lead: i < 2 }));
  return personas;
}

const known = new Map();
async function findUser(id) {
  if (known.has(id)) return known.get(id);
  const { rows } = await pool.query(`SELECT ${COLS} FROM users WHERE user_id = $1 AND status = 'active'`, [id]);
  if (rows[0]) known.set(id, rows[0]);
  return rows[0] ?? null;
}

/** Express middleware: sets req.session = null | { role, user_id, display_name, home_currency, locale }. */
export async function attachSession(req, _res, next) {
  const id = req.get('x-user-id');
  if (!id) {
    req.session = null;
    return next();
  }
  if (id === OPERATOR_ID) {
    req.session = OPERATOR;
    return next();
  }
  const user = await findUser(id);
  if (!user) return next(new AppError('invalid_session'));
  req.session = { role: 'traveller', ...user };
  return next();
}

/** Only the operator may pass; an anonymous caller must log in first. */
export function operatorOnly(req, _res, next) {
  if (!req.session) return next(new AppError('login_required'));
  if (req.session.role !== 'operator') return next(new AppError('forbidden'));
  return next();
}
