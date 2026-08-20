/**
 * A stand-in Google Form for local testing, so you can exercise /api/submit
 * without touching a real form.
 *
 *   node tests/mockForm.mjs           # listens on http://localhost:3100
 *   node tests/mockForm.mjs --reject  # rejects everything, like a required-field error
 *
 * Then POST a response through your dev server:
 *
 *   curl -s -X POST http://localhost:3000/api/submit \
 *     -H 'content-type: application/json' \
 *     -d @tests/samplePayload.json
 */

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3100);
const REJECT = process.argv.includes('--reject');

const CONFIRMATION = `<html><body>
  <div class="freebirdFormviewerViewResponseConfirmationMessage">Your response has been recorded</div>
</body></html>`;

const REJECTION = `<html><body>
  <form action="/formResponse"><div>This is a required question</div></form>
</body></html>`;

http
  .createServer((req, res) => {
    if (req.url.includes('/viewform')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<form action="/formResponse"><input type="hidden" name="fbzx" value="-1"></form>');
      return;
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`\n--- POST ${req.url} ---`);
      for (const [k, v] of new URLSearchParams(body)) console.log(`  ${k} = ${v}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(REJECT ? REJECTION : CONFIRMATION);
    });
  })
  .listen(PORT, () => {
    console.log(`Mock form listening on http://localhost:${PORT}`);
    console.log(`Submit URL: http://localhost:${PORT}/formResponse`);
    console.log(REJECT ? 'Mode: REJECT every submission' : 'Mode: accept every submission');
  });
