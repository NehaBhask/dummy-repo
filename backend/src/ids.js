import { randomBytes } from 'node:crypto';

// R2: opaque prefixed ids. Prefixes match data-model/enums.json (hld, bkg, bit, pay, inv) plus
// the additive tables (ltr, ltrs, slg).
export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

// Seed references are 6 uppercase hex chars, e.g. 8A3C2E.
export const newBookingReference = () => randomBytes(3).toString('hex').toUpperCase();
