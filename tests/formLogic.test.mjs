/**
 * Field-type coverage tests for the Google Form submission pipeline.
 *
 *   npx tsc src/lib/*.ts --outDir scratch/build --module commonjs \
 *       --target es2020 --skipLibCheck --esModuleInterop
 *   node scratch/formLogic.test.mjs
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const F = require('./build/lib/formFields.js');
const G = require('./build/lib/googleFormSubmit.js');
const B = require('./build/lib/formBootstrap.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
  }
}

function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

/** Encode one field and return the params as a sorted key=value list. */
function encode(field, value) {
  const p = new URLSearchParams();
  G.appendFieldParams(p, field, value);
  return Array.from(p.entries()).map(([k, v]) => `${k}=${v}`);
}

const section = (t) => console.log(`\n${t}`);

/* ================================================================== */
section('Short answer / paragraph — must NOT be date-split');

check(
  'text answer that looks like a date stays intact',
  encode({ name: 'entry.1', type: 'text', pageIndex: 0, required: true }, '2025-08-20'),
  ['entry.1=2025-08-20'],
);
check(
  'text answer that looks like a time stays intact',
  encode({ name: 'entry.2', type: 'text', pageIndex: 0, required: true }, '1:30'),
  ['entry.2=1:30'],
);
check(
  'paragraph keeps newlines',
  encode({ name: 'entry.3', type: 'textarea', pageIndex: 0, required: false }, 'line one\nline two'),
  ['entry.3=line one\nline two'],
);

/* ================================================================== */
section('Date — every variant, every input format');

const dateField = { name: 'entry.10', type: 'date', pageIndex: 0, required: true };

check('ISO date + time', encode(dateField, '2025-08-20 14:30'), [
  'entry.10_year=2025',
  'entry.10_month=8',
  'entry.10_day=20',
  'entry.10_hour=14',
  'entry.10_minute=30',
]);
check('ISO date only (time defaulted, still sent)', encode(dateField, '2025-08-20'), [
  'entry.10_year=2025',
  'entry.10_month=8',
  'entry.10_day=20',
  'entry.10_hour=12',
  'entry.10_minute=0',
]);
check('day-first slash format', encode(dateField, '20/08/2025').slice(0, 3), [
  'entry.10_year=2025',
  'entry.10_month=8',
  'entry.10_day=20',
]);
check('long month name', encode(dateField, 'August 20, 2025').slice(0, 3), [
  'entry.10_year=2025',
  'entry.10_month=8',
  'entry.10_day=20',
]);
check('12-hour clock with meridiem', encode(dateField, '2025-08-20 9:05 PM').slice(3), [
  'entry.10_hour=21',
  'entry.10_minute=5',
]);
check(
  'date without year omits _year when detected',
  encode({ ...dateField, includeYear: false, includeTime: false }, '2025-08-20'),
  ['entry.10_month=8', 'entry.10_day=20'],
);
assert(
  'unparseable date still yields a valid submission',
  encode(dateField, 'sometime next week').length === 5,
  JSON.stringify(encode(dateField, 'sometime next week')),
);

/* ================================================================== */
section('Time — time of day vs duration');

check(
  'time of day (variant undetected -> superset incl. _second)',
  encode({ name: 'entry.20', type: 'time', pageIndex: 0, required: true }, '09:30'),
  ['entry.20_hour=9', 'entry.20_minute=30', 'entry.20_second=0'],
);
check(
  'time of day detected -> no _second',
  encode({ name: 'entry.20', type: 'time', pageIndex: 0, required: true, isDuration: false }, '9:30 PM'),
  ['entry.20_hour=21', 'entry.20_minute=30'],
);
check(
  'duration sends _second',
  encode({ name: 'entry.21', type: 'time', pageIndex: 0, required: true, isDuration: true }, '2:45:30'),
  ['entry.21_hour=2', 'entry.21_minute=45', 'entry.21_second=30'],
);
check(
  'duration from prose',
  encode({ name: 'entry.21', type: 'time', pageIndex: 0, required: true, isDuration: true }, '2h 30m'),
  ['entry.21_hour=2', 'entry.21_minute=30', 'entry.21_second=0'],
);
check(
  'duration overflow rolls up',
  encode({ name: 'entry.21', type: 'time', pageIndex: 0, required: true, isDuration: true }, '0:90:00'),
  ['entry.21_hour=1', 'entry.21_minute=30', 'entry.21_second=0'],
);

/* ================================================================== */
section('Multiple choice / dropdown, including "Other"');

const radio = {
  name: 'entry.30',
  type: 'radio',
  pageIndex: 0,
  required: true,
  options: ['Daily', 'Weekly', 'Monthly'],
};

check('exact option', encode(radio, 'Weekly'), ['entry.30=Weekly']);
check('case-insensitive option', encode(radio, 'weekly'), ['entry.30=Weekly']);
check('hallucinated option falls back to a real one', encode(radio, 'Fortnightly'), ['entry.30=Daily']);
check('option with "Other" enabled routes free text', encode({ ...radio, hasOther: true }, 'Twice a year'), [
  'entry.30=__other_option__',
  'entry.30.other_option_response=Twice a year',
  'entry.30_sentinel=',
]);
check(
  'dropdown matches numeric-prefixed labels',
  encode(
    { name: 'entry.31', type: 'dropdown', pageIndex: 0, required: true, options: ['1 - Poor', '5 - Excellent'] },
    '5',
  ),
  ['entry.31=5 - Excellent'],
);

/* ================================================================== */
section('Checkboxes');

const checkbox = {
  name: 'entry.40',
  type: 'checkbox',
  pageIndex: 0,
  required: true,
  options: ['Email', 'SMS', 'Push'],
};

check('multiple selections + sentinel', encode(checkbox, ['Email', 'Push']), [
  'entry.40=Email',
  'entry.40=Push',
  'entry.40_sentinel=',
]);
check('single string is accepted', encode(checkbox, 'SMS'), ['entry.40=SMS', 'entry.40_sentinel=']);
check('invalid entries are dropped, sentinel still sent', encode(checkbox, ['Carrier pigeon']), [
  'entry.40_sentinel=',
]);
check('checkbox with Other', encode({ ...checkbox, hasOther: true }, ['Email', 'Carrier pigeon']), [
  'entry.40=Email',
  'entry.40=__other_option__',
  'entry.40.other_option_response=Carrier pigeon',
  'entry.40_sentinel=',
]);

/* ================================================================== */
section('Grids');

const radioGrid = {
  name: 'entry.50',
  type: 'radio_grid',
  pageIndex: 0,
  required: true,
  options: ['Poor', 'OK', 'Great'],
};
const checkboxGrid = { ...radioGrid, name: 'entry.51', type: 'checkbox_grid' };

check('radio grid row takes one column', encode(radioGrid, 'OK'), ['entry.50=OK']);
check('checkbox grid row keeps ALL selections', encode(checkboxGrid, ['Poor', 'Great']), [
  'entry.51=Poor',
  'entry.51=Great',
  'entry.51_sentinel=',
]);

/* ================================================================== */
section('Linear scale / rating');

const scale = { name: 'entry.60', type: 'linear_scale', pageIndex: 0, required: true, low: 1, high: 5 };
check('in-range value', encode(scale, 4), ['entry.60=4']);
check('above range is clamped', encode(scale, 9), ['entry.60=5']);
check('below range is clamped', encode({ ...scale, low: 0 }, -3), ['entry.60=0']);
check('numeric string', encode({ name: 'entry.61', type: 'rating', pageIndex: 0, required: true, low: 1, high: 10 }, '7'), [
  'entry.61=7',
]);

/* ================================================================== */
section('Email collection');

check('emailAddress field', encode({ name: 'emailAddress', type: 'email', pageIndex: 0, required: true }, 'a@b.com'), [
  'emailAddress=a@b.com',
]);

/* ================================================================== */
section('Value coercion / repair');

const c = (field, raw) => F.coerceFieldValue(field, raw, []);

check('missing required radio is filled', typeof c(radio, undefined).value, 'string');
check('missing optional text stays empty', c({ ...radio, type: 'text', required: false }, undefined).value, null);
check('scale garbage becomes the midpoint', c(scale, 'very good').value, '3');
check('checkbox required with no valid answer gets one', c(checkbox, ['nope']).value.length, 1);
assert('bad email is replaced', /@/.test(c({ name: 'e', type: 'email', pageIndex: 0, required: true }, 'not-an-email').value));
assert(
  'text field with email validation is repaired',
  /@/.test(
    c(
      { name: 'entry.70', type: 'text', pageIndex: 0, required: true, validation: { kind: 'email', description: '' } },
      'great product',
    ).value,
  ),
);
check(
  'number validation is clamped',
  c(
    { name: 'entry.71', type: 'text', pageIndex: 0, required: true, validation: { kind: 'number', min: 1, max: 10, description: '' } },
    '99',
  ).value,
  '10',
);
check('date is normalised to ISO with a time', c(dateField, 'Aug 20, 2025 5pm').value, '2025-08-20 17:00');

/* ================================================================== */
section('Cookie handling');

check(
  'Expires comma does not split the cookie',
  G.splitSetCookie('NID=abc; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/, SID=xyz; Path=/'),
  ['NID=abc; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/', 'SID=xyz; Path=/'],
);
check(
  'cookies merge and later values win',
  G.mergeCookies('A=1; B=2', ['B=99; Path=/', 'C=3']),
  'A=1; B=99; C=3',
);

/* ================================================================== */
section('Response classification — the bug that hid everything else');

check(
  'validation error page is a failure',
  G.classifyResponse('<form action="/forms/d/e/x/formResponse"><div>This is a required question</div></form>').kind,
  'error',
);
check(
  'confirmation page is a success',
  G.classifyResponse('<div class="freebirdFormviewerViewResponseConfirmationMessage">Your response has been recorded</div>').kind,
  'confirmation',
);
check(
  're-rendered form with no visible error is still not a confirmation',
  G.classifyResponse('<form action="https://docs.google.com/forms/d/e/x/formResponse"></form>').kind,
  'form',
);
check('sign-in wall is detected', G.classifyResponse('<html>ServiceLogin</html>').kind, 'login');
check('closed form is detected', G.classifyResponse('<p>no longer accepting responses</p>').kind, 'closed');

/* ================================================================== */
section('Hidden input + state token extraction');

const pageHtml = `
  <input type="hidden" name="fbzx" value="-12345">
  <input type="hidden" name="partialResponse" value="[null,null,&quot;-999&quot;]">
  <input value="0,1" type="hidden" name="pageHistory">
`;
check('fbzx', G.extractHiddenInput(pageHtml, 'fbzx'), '-12345');
check('entities are decoded', G.extractStateToken(pageHtml), { name: 'partialResponse', value: '[null,null,"-999"]' });
check('reversed attribute order', G.extractHiddenInput(pageHtml, 'pageHistory'), '0,1');
check(
  'falls back to draftResponse',
  G.extractStateToken('<input name="draftResponse" value="[null,null]">'),
  { name: 'draftResponse', value: '[null,null]' },
);

/* ================================================================== */
section('Bootstrap array extraction');

const trickyHtml = `<script>var FB_PUBLIC_LOAD_DATA_ = [null,[null,[[1,"What is a\\" ]; tricky title",null,0,[[100,null,1]]]]],"x"];</script>`;
const boot = B.extractBootstrapArray(trickyHtml);
assert('parses past "];" inside a string value', boot !== null && Array.isArray(boot), JSON.stringify(boot));
if (boot) {
  check('question title survives', boot[1][1][0][1], 'What is a" ]; tricky title');
  check('entry id is reachable', boot[1][1][0][4][0][0], 100);
  check('required flag is reachable', boot[1][1][0][4][0][2], 1);
}

/* ================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
