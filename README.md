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
| `GROQ_API_KEY` | yes | Response generation (Llama 3.3 70B via Groq). |
| `QSTASH_TOKEN` | yes | Queues and delays the submissions. |
| `QSTASH_CURRENT_SIGNING_KEY` | recommended | Verifies that `/api/submit` was really called by QStash. |
| `QSTASH_NEXT_SIGNING_KEY` | recommended | Second key used during QStash key rotation. |

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
