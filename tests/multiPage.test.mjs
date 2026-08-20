/**
 * Drives submitResponse() against a local server that mimics a 3-section
 * Google Form, to verify pageHistory, the continuation token, cookie carry-over
 * and success/failure classification.
 *
 *   npm test
 */

import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('./build/lib/googleFormSubmit.js');

let passed = 0;
let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
};
const assert = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const FORM_PAGE = (extra = '') => `
  <html><body>
    <form action="/formResponse" method="POST">
      <input type="hidden" name="fbzx" value="-555">
      ${extra}
    </form>
    <script>var FB_PUBLIC_LOAD_DATA_ = [null,[null,[]]];</script>
  </body></html>`;

const CONFIRMATION = `<html><body><div class="freebirdFormviewerViewResponseConfirmationMessage">Your response has been recorded</div></body></html>`;
const REQUIRED_ERROR = `<html><body><form action="/formResponse"><div>This is a required question</div></form></body></html>`;

/** Records every POST the submitter makes. */
function startServer(behaviour, seedToken = true) {
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/viewform')) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'NID=seed123; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/',
      });
      res.end(FORM_PAGE(seedToken ? '<input type="hidden" name="partialResponse" value="[null,null,&quot;seed&quot;]">' : ''));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      posts.push({ params, cookie: req.headers.cookie ?? null });
      behaviour(posts.length - 1, params, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, port: server.address().port }));
  });
}

const fields = [
  { name: 'entry.1', title: 'Name', type: 'text', pageIndex: 0, required: true },
  // section 1 (index 1) has no answerable question at all — an image-only section
  { name: 'entry.3', title: 'Rating', type: 'linear_scale', pageIndex: 2, required: true, low: 1, high: 5 },
];
const data = { 'entry.1': 'Alex', 'entry.3': '4' };

/* ================================================================== */
console.log('\nHappy path: 3 sections, middle section has no questions');
{
  const { server, posts, port } = await startServer((i, params, res) => {
    if (i < 2) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `STEP=${i}; Path=/` });
      res.end(
        FORM_PAGE(
          `<input type="hidden" name="partialResponse" value="[step${i}]">` +
            `<input type="hidden" name="pageHistory" value="${Array.from({ length: i + 2 }, (_, k) => k).join(',')}">`,
        ),
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CONFIRMATION);
    }
  });

  const result = await G.submitResponse({
    formUrl: `http://127.0.0.1:${port}/formResponse`,
    fields,
    data,
    pageCount: 3,
  });

  check('submission succeeds', result.success, true);
  check('one POST per section, including the empty one', posts.length, 3);
  check('pageHistory grows correctly', posts.map((p) => p.params.get('pageHistory')), ['0', '0,1', '0,1,2']);
  check('continue=1 on all but the last', posts.map((p) => p.params.get('continue')), ['1', '1', null]);
  check('fvv is always sent', posts.every((p) => p.params.get('fvv') === '1'), true);
  check('submissionTimestamp is sent', posts.every((p) => p.params.get('submissionTimestamp') === '-1'), true);
  check('section 0 carries its own answer', posts[0].params.get('entry.1'), 'Alex');
  check('empty section 1 posts no answers', posts[1].params.get('entry.1'), null);
  check('section 2 carries its own answer', posts[2].params.get('entry.3'), '4');
  check('continuation token is echoed forward', posts.map((p) => p.params.get('partialResponse')), [
    '[null,null,"seed"]',
    '[step0]',
    '[step1]',
  ]);
  assert('seed cookie survives the Expires comma', posts[0].cookie?.includes('NID=seed123'), posts[0].cookie);
  assert('later cookies accumulate', posts[2].cookie?.includes('STEP=1'), posts[2].cookie);
  assert('fbzx is stable across the submission', new Set(posts.map((p) => p.params.get('fbzx'))).size === 1);
  server.close();
}

/* ================================================================== */
console.log('\nGoogle returns HTTP 200 with a validation error');
{
  const { server, port } = await startServer((i, params, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(REQUIRED_ERROR);
  });

  const result = await G.submitResponse({
    formUrl: `http://127.0.0.1:${port}/formResponse`,
    fields: [fields[0]],
    data,
    pageCount: 1,
  });

  check('a 200 validation error is reported as failure', result.success, false);
  assert('the reason names the required question', /required question/i.test(result.error), result.error);
  server.close();
}

/* ================================================================== */
console.log('\nGoogle silently re-renders the form (no visible error text)');
{
  const { server, port } = await startServer((i, params, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FORM_PAGE());
  });

  const result = await G.submitResponse({
    formUrl: `http://127.0.0.1:${port}/formResponse`,
    fields: [fields[0]],
    data,
    pageCount: 1,
  });
  check('re-rendered form is a failure, not a success', result.success, false);
  server.close();
}

/* ================================================================== */
console.log('\nNo continuation token: answers are resent instead of lost');
{
  const { server, posts, port } = await startServer((i, params, res) => {
    if (i === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FORM_PAGE()); // no partialResponse anywhere
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CONFIRMATION);
    }
  }, false);

  // viewform for this server also omits the token
  const result = await G.submitResponse({
    formUrl: `http://127.0.0.1:${port}/formResponse`,
    fields: [
      { name: 'entry.1', title: 'Name', type: 'text', pageIndex: 0, required: true },
      { name: 'entry.2', title: 'Note', type: 'text', pageIndex: 1, required: true },
    ],
    data: { 'entry.1': 'Alex', 'entry.2': 'Hello' },
    pageCount: 2,
  });

  check('still succeeds', result.success, true);
  assert(
    'page 1 resends page 0 answers as a fallback',
    posts[1].params.get('entry.1') === 'Alex' && posts[1].params.get('entry.2') === 'Hello',
    posts[1].params.toString(),
  );
  server.close();
}

/* ================================================================== */
console.log('\nSign-in redirect');
{
  const { server, port } = await startServer((i, params, res) => {
    res.writeHead(302, { Location: 'https://accounts.google.com/v3/signin' });
    res.end();
  });
  const result = await G.submitResponse({
    formUrl: `http://127.0.0.1:${port}/formResponse`,
    fields: [fields[0]],
    data,
    pageCount: 1,
  });
  check('sign-in redirect is a failure', result.success, false);
  assert('reason mentions sign-in', /sign-in/i.test(result.error), result.error);
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
