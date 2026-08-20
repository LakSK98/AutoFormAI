/**
 * Lists the chat models your keys can actually reach, and probes whether each
 * candidate works with the JSON output this app depends on.
 *
 *   node tests/checkModels.mjs                    # uses .env
 *   node tests/checkModels.mjs gemini-3.7-flash   # probe specific models
 *
 * Model ids get retired without warning (llama-3.3-70b-versatile did), so this
 * answers "what can I actually use right now" from your account, not from docs.
 */

import fs from 'node:fs';
import path from 'node:path';

/* Load .env without adding a dependency. */
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const PROVIDERS = [
  {
    label: 'Gemini',
    key: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaults: ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  },
  {
    label: 'Groq',
    key: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    defaults: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
  },
];

/** new URL() drops the last path segment unless the base ends in a slash. */
const api = (p, route) => new URL(route, p.baseURL.endsWith('/') ? p.baseURL : p.baseURL + '/');

const PROMPT =
  'Return ONLY raw JSON shaped as {"responses":[{"entry.1":"a name","entry.2":3}]} with exactly 1 object.';

async function listModels(p) {
  const res = await fetch(api(p, 'models'), {
    headers: { Authorization: `Bearer ${p.key}` },
  });
  if (!res.ok) return { error: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}` };
  const body = await res.json();
  return { ids: (body.data ?? []).map((m) => m.id).sort() };
}

/** Try a chat completion, first with json_object, then without. */
async function probe(p, model) {
  for (const withFormat of [true, false]) {
    const res = await fetch(api(p, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages: [{ role: 'user', content: PROMPT }],
        ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = body.choices?.[0]?.message?.content ?? '';
      let parses = false;
      try {
        const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        JSON.parse(cleaned.slice(cleaned.search(/[[{]/)));
        parses = true;
      } catch { /* left false */ }
      return {
        ok: true,
        jsonMode: withFormat,
        parses,
        sample: text.replace(/\s+/g, ' ').slice(0, 90),
      };
    }

    const message = body.error?.message ?? `HTTP ${res.status}`;
    if (withFormat && /response_format|json/i.test(message)) continue; // retry without
    return { ok: false, message: message.slice(0, 150) };
  }
  return { ok: false, message: 'unknown failure' };
}

const requested = process.argv.slice(2);

for (const p of PROVIDERS) {
  console.log(`\n=== ${p.label} ===`);
  if (!p.key) {
    console.log('  no API key set — skipped');
    continue;
  }

  const listing = await listModels(p);
  if (listing.error) console.log(`  could not list models: ${listing.error}`);
  else console.log(`  ${listing.ids.length} models visible to this key`);

  const candidates = requested.length ? requested : p.defaults;
  for (const model of candidates) {
    if (listing.ids && !listing.ids.includes(model)) {
      console.log(`  ${model.padEnd(28)} NOT LISTED for this key`);
      continue;
    }
    const r = await probe(p, model);
    if (!r.ok) {
      console.log(`  ${model.padEnd(28)} FAILS — ${r.message}`);
    } else {
      const mode = r.jsonMode ? 'json_object' : 'no json_object (falls back)';
      console.log(`  ${model.padEnd(28)} works [${mode}] parses=${r.parses}`);
      console.log(`  ${''.padEnd(28)}   ${r.sample}`);
    }
  }
}

console.log('\nSet GEMINI_MODEL / GROQ_MODEL in .env to whichever you want to use.');
