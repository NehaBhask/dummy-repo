import { config } from '../src/config.js';
import { closePool } from '../src/db.js';
import { aiSearch } from '../src/modules/ai/search.js';

// Verifies the live Gemini path end to end. Usage: node scripts/check-gemini.js ["your own query"]
// For each query it prints who answered (gemini | heuristic), what was extracted, and how many
// real, available rooms came back. If parser is "heuristic", `fallback_reason` says why Gemini failed.
const queries = process.argv[2]
  ? [process.argv[2]]
  : [
      '3-star hotel in Jaipur for 2 adults, Oct 10-12, under ₹5000/night',
      'जयपुर में 2 रातों के लिए होटल, ₹5000 से कम',
      'गोवा में 3 रातों के लिए फैमिली रूम, 2 कमरे, नाश्ता शामिल, 20 अक्टूबर से',
      'Family room in Goa, 3 nights from Oct 20, 2 rooms, breakfast included',
    ];

if (!config.gemini.apiKey) {
  console.log('GEMINI_API_KEY is not set: only the English heuristic fallback will run.');
}
console.log(`models (tried in order): ${config.gemini.models.join(', ')}\n`);

let failed = 0;
try {
  for (const query of queries) {
    const started = Date.now();
    try {
      const r = await aiSearch({ query });
      const p = r.parsed_params ?? {};
      console.log(`Q: ${query}`);
      console.log(`   parser=${r.parser}  language=${r.language}  ${Date.now() - started} ms${r.fallback_reason ? `\n   FALLBACK REASON: ${r.fallback_reason}` : ''}`);
      console.log(`   parsed: city=${p.city} check_in=${p.check_in_date} nights=${p.nights} rooms=${p.rooms} adults=${p.adults} max=${p.max_price_per_night} ${p.currency ?? ''} stars=${p.star_rating} prefs=${(p.preferences ?? []).join(',')}`);
      console.log(`   results: ${r.total}${r.needs_clarification ? `  (needs_clarification: ${r.needs_clarification})` : ''}`);
      if (r.summary) console.log(`   summary: ${r.summary}`);
      if (r.parser !== 'gemini' && config.gemini.apiKey) failed++;
    } catch (err) {
      failed++;
      console.log(`Q: ${query}\n   ERROR ${err.code ?? ''} ${err.message}`);
    }
    console.log();
  }
} finally {
  await closePool();
}
process.exitCode = failed ? 1 : 0;
