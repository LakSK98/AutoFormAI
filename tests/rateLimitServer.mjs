/**
 * A fake OpenAI-compatible endpoint that returns Groq-style 429s for the first
 * N requests, to prove the generator waits and recovers instead of aborting.
 *
 *   node tests/rateLimitServer.mjs        # 429s the first 2 calls, then succeeds
 */

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3200);
const FAIL_FIRST = Number(process.env.FAIL_FIRST ?? 2);

let calls = 0;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }

      calls++;
      if (calls <= FAIL_FIRST) {
        console.log(`call ${calls}: replying 429`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                'Rate limit reached for model `fake-model` on tokens per minute (TPM): Limit 8000, Used 5784, Requested 2655. Please try again in 1.5s.',
              type: 'rate_limit_exceeded',
            },
          }),
        );
        return;
      }

      console.log(`call ${calls}: replying 200`);
      const payload = JSON.parse(body || '{}');
      const wantsRows = /containing exactly (\d+)/.exec(
        payload.messages?.[0]?.content ?? '',
      );
      const n = wantsRows ? Number(wantsRows[1]) : 1;
      const responses = Array.from({ length: n }, (_, i) => ({
        'entry.1': `Person ${calls}-${i}`,
        'entry.6': 1 + ((i + calls) % 5),
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ responses }) } }],
        }),
      );
    });
  })
  .listen(PORT, () => {
    console.log(`Fake LLM on http://localhost:${PORT}/v1 — 429s the first ${FAIL_FIRST} call(s)`);
  });
