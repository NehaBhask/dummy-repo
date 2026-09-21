import { pool } from '../db.js';
import { config } from '../config.js';

// No auth is in scope (design §3): every request without a user_id acts as one demo user.
let cached = null;

export async function demoUser() {
  if (cached) return cached;
  const { rows } = config.demoUserId
    ? await pool.query('SELECT user_id, display_name, home_currency, locale FROM users WHERE user_id = $1', [config.demoUserId])
    : await pool.query(
        `SELECT user_id, display_name, home_currency, locale FROM users
          WHERE status = 'active' AND home_currency = 'INR' ORDER BY user_id LIMIT 1`,
      );
  if (!rows[0]) throw new Error('no demo user available; is the data loaded?');
  cached = rows[0];
  return cached;
}
