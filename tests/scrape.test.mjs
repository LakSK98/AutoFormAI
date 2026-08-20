/**
 * Runs the real /api/scrape route against a synthetic Google Form page that
 * contains one of every question type.
 *
 *   npm test
 */

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, 'build');

// tsc leaves `@/...` specifiers untouched, so map them onto the build output.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    return originalResolve.call(this, path.join(buildDir, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

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

/* ---------------- synthetic FB_PUBLIC_LOAD_DATA_ ---------------- */
// item  = [itemId, title, description, typeCode, entries]
// entry = [entryId, options, required, rowLabel?, validation?, ...]

const grid3 = [['Poor'], ['OK'], ['Great']];
const cbGridRow = (id, label) => {
  const row = [id, [['A'], ['B']], 0, label];
  row[11] = [1]; // checkbox-grid marker
  return row;
};

const questions = [
  [1, 'Your name', null, 0, [[1001, null, 1]]],
  [2, 'Tell us more', null, 1, [[1002, null, 0]]],
  [3, 'How often?', null, 2, [[1003, [['Daily'], ['Weekly'], ['__other_option__']], 1]]],
  [4, 'Country', null, 3, [[1004, [['Sri Lanka'], ['India']], 1]]],
  [5, 'Channels', null, 4, [[1005, [['Email'], ['SMS'], ['Push']], 1]]],
  [6, 'Rate us', null, 5, [[1006, [['1'], ['2'], ['3'], ['4'], ['5']], 1, ['Bad', 'Great']]]],
  [7, 'A section header', 'some description', 6, null],
  [8, 'Page two', null, 8, null], // page break
  [9, 'When did you start?', null, 9, [[1009, null, 1]]],
  [10, 'Preferred time', null, 10, [[1010, null, 1]]],
  [11, 'Quality grid', null, 7, [
    [1011, grid3, 1, 'Speed'],
    [1012, grid3, 1, 'Support'],
  ]],
  [12, 'Pick all that apply', null, 7, [cbGridRow(1013, 'Row1'), cbGridRow(1014, 'Row2')]],
  [13, 'Upload your CV', null, 13, [[1015, null, 1]]],
  [14, 'Overall stars', null, 18, [[1016, [['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['10']], 1]]],
  [15, 'Contact email', null, 0, [[1017, null, 1, null, [[2, 102, [], 'bad email']]]]],
];

const d1 = new Array(11).fill(null);
d1[1] = questions;
d1[10] = [null, null, null, null, null, null, 2]; // collect email addresses

const HTML = `<!doctype html><html><head><title>My Survey - Google Forms</title></head><body>
<div role="heading" aria-level="1">My Survey</div>

<div role="listitem"><div role="heading">When did you start?</div>
  <input type="date" aria-label="Date"><input type="time" aria-label="Time">
</div>
<div role="listitem"><div role="heading">Preferred time</div>
  <input type="text" aria-label="Hour"><input type="text" aria-label="Minute">
</div>
<div role="listitem"><div role="heading">Pick all that apply</div>
  <div role="checkbox"></div>
</div>
<input type="email" name="emailAddress">

<script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify([null, d1])};</script>
</body></html>`;

/* ---------------- run the route ---------------- */
globalThis.fetch = async () =>
  new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });

const require = createRequire(import.meta.url);
const { POST } = require(path.join(buildDir, 'app/api/scrape/route.js'));

const res = await POST(
  new Request('http://localhost/api/scrape', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://docs.google.com/forms/d/e/ABC/viewform' }),
  }),
);
const out = await res.json();
if (out.error) {
  console.error('route returned an error:', out.error);
  process.exit(1);
}

const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
const get = (id) => byName[`entry.${id}`];

console.log('\nForm level');
check('title', out.title, 'My Survey');
check('submitUrl', out.submitUrl, 'https://docs.google.com/forms/d/e/ABC/formResponse');
check('section count includes the page break', out.pageCount, 2);
assert('required file upload raises a warning', out.warnings.some((w) => /REQUIRED file upload/.test(w)), JSON.stringify(out.warnings));
assert('file upload is not submitted as a field', !out.fields.some((f) => f.name === 'entry.1015'));
assert('title/description item is skipped', !out.fields.some((f) => f.title === 'A section header'));

console.log('\nEmail collection');
check('emailAddress field is added', byName.emailAddress?.type, 'email');
check('emailAddress is required', byName.emailAddress?.required, true);

console.log('\nText / paragraph');
check('short answer type', get(1001).type, 'text');
check('short answer required flag is read', get(1001).required, true);
check('paragraph type', get(1002).type, 'textarea');
check('optional flag is read', get(1002).required, false);
check('email validation is detected', get(1017).validation?.kind, 'email');

console.log('\nChoice questions');
check('radio options exclude the Other sentinel', get(1003).options, ['Daily', 'Weekly']);
check('radio hasOther is detected', get(1003).hasOther, true);
check('dropdown options', get(1004).options, ['Sri Lanka', 'India']);
check('dropdown has no Other', get(1004).hasOther, false);
check('checkbox options', get(1005).options, ['Email', 'SMS', 'Push']);

console.log('\nScales');
check('linear scale bounds come from the options', [get(1006).low, get(1006).high], [1, 5]);
check('linear scale end labels', [get(1006).lowLabel, get(1006).highLabel], ['Bad', 'Great']);
check('rating upper bound', get(1016).high, 10);

console.log('\nDate / time variants');
check('date is on section 1', get(1009).pageIndex, 1);
check('date+time detected from the rendered inputs', get(1009).includeTime, true);
check('time-of-day is not treated as a duration', get(1010).isDuration, false);

console.log('\nGrids');
check('radio grid rows become separate fields', [get(1011).type, get(1012).type], ['radio_grid', 'radio_grid']);
check('grid row titles', get(1011).title, 'Quality grid → Speed');
check('grid columns become options', get(1011).options, ['Poor', 'OK', 'Great']);
check('checkbox grid is detected', [get(1013).type, get(1014).type], ['checkbox_grid', 'checkbox_grid']);
check('grid rows inherit the section', get(1011).pageIndex, 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
