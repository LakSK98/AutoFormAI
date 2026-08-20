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

## Tests

```bash
npm test
```

Covers parameter encoding for every question type, date/time parsing, option matching and
repair, cookie handling, success-vs-validation-error detection, the multi-section flow
(against a mock Google Forms server), and the scraper (against a synthetic form containing
one of every question type).
