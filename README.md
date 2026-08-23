# AutoForm AI

Generates realistic mock responses with an LLM and submits them to a public Google Form,
optionally spread over a time window via QStash.

## Setup

```bash
npm install
npm run dev
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CEREBRAS_API_KEY` | one of these | Response generation via Cerebras. Most generous free daily quota. |
| `GEMINI_API_KEY` | one of these | Response generation via Google Gemini. |
| `GROQ_API_KEY` | one of these | Response generation via Groq. Used when there is no Gemini key. |
| `GEMINI_MODEL` | no | Overrides the Gemini model id. Default `gemini-3.7-flash`. |
| `GROQ_MODEL` | no | Overrides the Groq model id. Default `openai/gpt-oss-120b`. |
| `CEREBRAS_MODEL` | no | Overrides the Cerebras model id. Default `gpt-oss-120b`. |
| `LLM_BASE_URL` | no | Any OpenAI-compatible endpoint (Ollama, OpenRouter, Together). Wins over all keys. |
| `LLM_MODEL` / `LLM_API_KEY` / `LLM_LABEL` | no | Model, key and display name for `LLM_BASE_URL`. |
| `LLM_PROVIDER` | no | Force one provider by name when several keys are set. |
| `LLM_BATCH_SIZE` | no | Responses generated per request. Default 10. |
| `LLM_CONCURRENCY` | no | Parallel generation requests. Default 1 — raise only on a paid plan. |
| `QSTASH_TOKEN` | yes | Queues and delays the submissions. |
| `QSTASH_URL` | no | Points the QStash SDK at a local QStash dev server. |
| `QSTASH_CURRENT_SIGNING_KEY` | recommended | Verifies that `/api/submit` was really called by QStash. |
| `QSTASH_NEXT_SIGNING_KEY` | recommended | Second key used during QStash key rotation. |

### Choosing a model provider

Both providers speak the OpenAI-compatible protocol, so only the key, base URL and model id
differ. Set **one** of `GEMINI_API_KEY` or `GROQ_API_KEY`; Gemini wins if both are present.
The server logs which one it picked on every run:

```
[generate] using Groq / openai/gpt-oss-120b
```

**Model ids get retired.** `llama-3.3-70b-versatile` was decommissioned by Groq, which is why
both providers accept a `*_MODEL` override — you can move to a new model without a code
change. If the model is rejected, the API returns a message naming the env var to set.

To find out what your keys can actually use — and whether each model handles the JSON output
this app depends on — run the checker instead of trusting any documentation:

```bash
node tests/checkModels.mjs                    # probes the defaults for both providers
node tests/checkModels.mjs gemini-3.7-flash   # probe specific model ids
```

It reads `.env`, lists every model each key can see, and sends a real JSON-shaped request to
each candidate, reporting whether `response_format: json_object` is accepted or has to be
skipped.

### Rate limits

Free tiers cap **tokens per minute**, not just requests, and generating 100 responses means
several calls in quick succession. The app handles this rather than failing:

- Batches run **sequentially** by default (`LLM_CONCURRENCY=1`) so calls do not burst.
- A `429` is retried up to 6 times, waiting exactly as long as the provider asks
  ("Please try again in 3.2925s") rather than guessing.
- If a batch still fails, the responses that *did* generate are kept and reused to fill the
  campaign; the run reports how many were unique instead of failing outright.

Rough free-tier ceilings (verify before relying on them — they change often):

| Provider | Free limit |
| --- | --- |
| Cerebras | ~1M tokens/day, 60–100k tokens/min |
| Groq | 8,000 tokens/min on `on_demand` |
| Gemini | Per-minute and per-day request caps on Flash models |
| Ollama (local) | No limit — bounded only by your hardware |

**Truly unlimited means local.** Point the app at Ollama and there is no quota at all:

```bash
ollama serve
ollama pull llama3.1
```

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1
LLM_LABEL=Ollama
```

**Gemini's free tier**: available for the Flash models, with per-minute and per-day request
limits. Get a key at [aistudio.google.com](https://aistudio.google.com/apikey). Note that
Google states free-tier content **is used to improve their products** — if the persona text or
generated responses are sensitive, use the paid tier or stay on Groq.

Both signing keys are in the Upstash QStash console. **If they are not set, `/api/submit`
accepts unsigned requests** and anyone who knows the URL can push submissions through your
deployment; the server logs a warning on every request in that state.

## Verifying a form before launching a campaign

Step 2 has a **Test 1 response** button. It generates one response, submits it immediately,
and reports whether Google actually recorded it — including the specific validation message
if Google rejected it. Use this before scheduling a batch.

## Supported question types

Short answer, paragraph, multiple choice (incl. *Other*), dropdown, checkboxes (incl. *Other*),
linear scale, rating, multiple-choice grid, checkbox grid, date (all four year/time variants),
time of day, duration, and the `emailAddress` field added by "Collect email addresses".

File uploads cannot be automated — they need a signed-in Google account. If a form has a
**required** file upload, the scraper says so up front, because no submission can succeed.

Forms that route people to different sections based on their answers are submitted in plain
section order, which may not match every branch. The scraper warns when it detects branching.

## Testing locally

Everything except the QStash queue runs entirely on your machine.

### 1. The `.env` file

`next dev` reads `.env` at startup only — restart after editing it. Shell variables win
over the file, which is handy for one-off experiments:

```bash
QSTASH_CURRENT_SIGNING_KEY=sig_test npm run dev
```

For local runs you only strictly need `GROQ_API_KEY`.

### 2. Test against a real form without queueing

Use the **Test 1 response** button in step 2. It generates one response and submits it
in-process, so it needs neither QStash nor a public URL, and it reports Google's actual
verdict.

### 3. Test the submit pipeline without touching a real form

A stand-in form server is included:

```bash
node tests/mockForm.mjs              # accepts submissions
node tests/mockForm.mjs --reject     # behaves like a required-field error
```

Then, in another terminal:

```bash
curl -s -X POST http://localhost:3000/api/submit   -H 'content-type: application/json'   -d @tests/samplePayload.json
```

The mock prints every parameter it received, so you can confirm dates split into
`_year`/`_month`/`_day`, durations carry `_second`, checkboxes repeat the key plus
`_sentinel`, and "Other" answers become `__other_option__`.

In `--reject` mode the endpoint must return **HTTP 500** with the rejection reason. If it
ever returns success there, success detection has regressed.

### 4. Test the full QStash path locally

QStash cannot reach `localhost`, so either run Upstash's local QStash server:

```bash
npx @upstash/qstash-cli dev
```

It prints a `QSTASH_URL`, token and signing keys — put those in `.env` (the SDK picks up
`QSTASH_URL` automatically) and it will deliver to `http://localhost:3000/api/submit`.

Or expose your dev server with a tunnel (`ngrok http 3000`) and use your real QStash
credentials.

## Tests

```bash
npm test
```

Covers parameter encoding for every question type, date/time parsing, option matching and
repair, cookie handling, success-vs-validation-error detection, the multi-section flow
(against a mock Google Forms server), and the scraper (against a synthetic form containing
one of every question type).
