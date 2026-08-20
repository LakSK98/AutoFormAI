/**
 * Shared Google Form field schema + value normalisation.
 *
 * Everything that needs to know "what does a valid answer for this field look
 * like" lives here, so the scraper, the generator and the submitter can never
 * drift apart.
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'radio'
  | 'dropdown'
  | 'checkbox'
  | 'linear_scale'
  | 'rating'
  | 'radio_grid'
  | 'checkbox_grid'
  | 'date'
  | 'time';

export type ValidationKind =
  | 'none'
  | 'email'
  | 'url'
  | 'number'
  | 'integer'
  | 'length'
  | 'regex';

export interface FieldValidation {
  kind: ValidationKind;
  min?: number;
  max?: number;
  /** Human readable hint handed to the LLM. */
  description: string;
}

export interface FormField {
  /** `entry.123456` or the special `emailAddress`. */
  name: string;
  title: string;
  type: FieldType;
  /** 0-based section index. */
  pageIndex: number;
  required: boolean;

  /** Choice types + grids (grid options are the column labels). */
  options?: string[];
  /** Radio / checkbox / dropdown with an "Other..." entry. */
  hasOther?: boolean;

  /** linear_scale + rating. */
  low?: number;
  high?: number;
  lowLabel?: string;
  highLabel?: string;

  /** Grid rows are flattened into one field each. */
  gridTitle?: string;
  rowLabel?: string;
  /** Grid column labels (mirrors `options`, kept for display). */
  columns?: string[];

  /** Date / time variants. */
  includeYear?: boolean;
  includeTime?: boolean;
  isDuration?: boolean;

  validation?: FieldValidation | null;
}

export const OTHER_SENTINEL = '__other_option__';

export const CHOICE_TYPES: FieldType[] = [
  'radio',
  'dropdown',
  'checkbox',
  'radio_grid',
  'checkbox_grid',
];

export const MULTI_TYPES: FieldType[] = ['checkbox', 'checkbox_grid'];

export const SCALE_TYPES: FieldType[] = ['linear_scale', 'rating'];

export function isMulti(type: FieldType): boolean {
  return MULTI_TYPES.includes(type);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const m = v.trim().match(/-?\d+/);
    if (m) return parseInt(m[0], 10);
  }
  return null;
}

export function clamp(n: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(max, Math.max(min, n));
}

function strictNorm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function looseNorm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull the first scalar out of whatever the model produced. */
export function firstScalar(v: unknown): string {
  if (Array.isArray(v)) return v.length ? firstScalar(v[0]) : '';
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>);
    return vals.length ? firstScalar(vals[0]) : '';
  }
  return String(v);
}

export function toList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => toList(x));
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(toList);
  const s = String(v).trim();
  return s === '' ? [] : [s];
}

/**
 * Resolve a model-supplied answer onto one of the real option labels.
 * Google silently discards a choice value that is not byte-identical to an
 * option, so this has to be forgiving but must always return a REAL label.
 */
export function matchOption(value: unknown, options: string[]): string | null {
  if (!options.length) return null;
  const raw = firstScalar(value).trim();
  if (!raw) return null;

  const exact = options.find((o) => o === raw);
  if (exact !== undefined) return exact;

  const s = strictNorm(raw);
  const strict = options.find((o) => strictNorm(o) === s);
  if (strict !== undefined) return strict;

  const l = looseNorm(raw);
  if (l) {
    const loose = options.find((o) => looseNorm(o) === l);
    if (loose !== undefined) return loose;

    // Containment: "5" -> "5 - Excellent", "Agree" -> "Agree strongly"
    const partial = options.filter((o) => {
      const ol = looseNorm(o);
      return ol.length > 0 && (ol.startsWith(l + ' ') || l.startsWith(ol + ' '));
    });
    if (partial.length === 1) return partial[0];
  }

  const n = toInt(raw);
  if (n !== null) {
    const numeric = options.find((o) => toInt(o) === n);
    if (numeric !== undefined) return numeric;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Date parsing                                                        */
/* ------------------------------------------------------------------ */

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** false when the source string carried no time component. */
  hadTime: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface Clock {
  hour: number;
  minute: number;
  second: number;
  matched: string;
}

/** Find a clock time anywhere inside a string. */
function findClock(input: string): Clock | null {
  const withMeridiem = input.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  const plain = input.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  const bare = input.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);

  const m = withMeridiem ?? plain ?? bare;
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  let minute = 0;
  let second = 0;
  let meridiem: string | undefined;

  if (m === bare) {
    meridiem = m[2];
  } else {
    minute = parseInt(m[2], 10);
    second = m[3] ? parseInt(m[3], 10) : 0;
    meridiem = m[4];
  }

  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'p';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // Deliberately unclamped: a duration of "0:90:00" has to survive long enough
  // for normaliseTime to roll it up into 1h30m. Callers clamp as appropriate.
  return { hour, minute, second, matched: m[0] };
}

function buildDate(year: number, month: number, day: number) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { year, month, day };
}

function normYear(y: number): number {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

function parseCalendar(input: string) {
  const s = input.trim();
  if (!s) return null;

  // ISO: 2025-08-20 / 2025-8-2
  const iso = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    const d = buildDate(+iso[1], +iso[2], +iso[3]);
    if (d) return d;
  }

  // "20 August 2025" / "20 Aug 25"
  const dmy = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{2,4})\b/i);
  if (dmy && MONTH_NAMES[dmy[2].toLowerCase()]) {
    const d = buildDate(normYear(+dmy[3]), MONTH_NAMES[dmy[2].toLowerCase()], +dmy[1]);
    if (d) return d;
  }

  // "August 20, 2025" / "Aug 20 2025"
  const mdy = s.match(/\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/i);
  if (mdy && MONTH_NAMES[mdy[1].toLowerCase()]) {
    const d = buildDate(normYear(+mdy[3]), MONTH_NAMES[mdy[1].toLowerCase()], +mdy[2]);
    if (d) return d;
  }

  // Slash form with a trailing year: 20/08/2025 or 08/20/2025.
  // Genuinely ambiguous. The generator normalises to ISO before this is ever
  // reached, so this only guards hand-edited payloads. Day-first wins when the
  // first number cannot be a month, otherwise assume month-first (US style).
  const slash = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (slash) {
    const a = +slash[1];
    const b = +slash[2];
    const year = normYear(+slash[3]);
    const d = a > 12 ? buildDate(year, b, a) : (buildDate(year, a, b) ?? buildDate(year, b, a));
    if (d) return d;
  }

  // Last resort: let the platform try ("Wed Aug 20 2025" etc).
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return { year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate() };
  }

  return null;
}

export function parseDateValue(raw: unknown): DateParts | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const month = toInt(o.month);
    const day = toInt(o.day);
    if (month !== null && day !== null) {
      const built = buildDate(toInt(o.year) ?? new Date().getFullYear(), month, day);
      if (built) {
        const hour = toInt(o.hour);
        const minute = toInt(o.minute);
        return {
          ...built,
          hour: hour === null ? 12 : clamp(hour, 0, 23),
          minute: minute === null ? 0 : clamp(minute, 0, 59),
          hadTime: hour !== null,
        };
      }
    }
  }

  const s = firstScalar(raw).trim();
  if (!s) return null;

  const clock = findClock(s);
  // Strip the clock before calendar parsing so "10:30" cannot be read as a date.
  const calendarPart = clock ? s.replace(clock.matched, ' ') : s;
  const cal = parseCalendar(calendarPart);
  if (!cal) return null;

  return {
    ...cal,
    hour: clock ? clamp(clock.hour, 0, 23) : 12,
    minute: clock ? clamp(clock.minute, 0, 59) : 0,
    hadTime: clock !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Time parsing                                                        */
/* ------------------------------------------------------------------ */

export interface TimeParts {
  hour: number;
  minute: number;
  second: number;
}

function normaliseTime(hour: number, minute: number, second: number, isDuration: boolean): TimeParts {
  if (isDuration) {
    // Duration allows 0-72 hours; roll overflow upward.
    let totalSeconds = hour * 3600 + minute * 60 + second;
    totalSeconds = clamp(totalSeconds, 0, 72 * 3600);
    return {
      hour: Math.floor(totalSeconds / 3600),
      minute: Math.floor((totalSeconds % 3600) / 60),
      second: totalSeconds % 60,
    };
  }
  return {
    hour: clamp(hour, 0, 23),
    minute: clamp(minute, 0, 59),
    second: clamp(second, 0, 59),
  };
}

export function parseTimeValue(raw: unknown, isDuration: boolean): TimeParts | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const hour = toInt(o.hour ?? o.hours);
    const minute = toInt(o.minute ?? o.minutes);
    if (hour !== null || minute !== null) {
      return normaliseTime(hour ?? 0, minute ?? 0, toInt(o.second ?? o.seconds) ?? 0, isDuration);
    }
  }

  const s = firstScalar(raw).trim();
  if (!s) return null;

  const clock = findClock(s);
  if (clock) return normaliseTime(clock.hour, clock.minute, clock.second, isDuration);

  if (isDuration) {
    const h = s.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/i);
    const m = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
    const sec = s.match(/(\d+)\s*(?:s|sec|secs|second|seconds)\b/i);
    if (h || m || sec) {
      return normaliseTime(h ? +h[1] : 0, m ? +m[1] : 0, sec ? +sec[1] : 0, true);
    }
    const bare = toInt(s);
    if (bare !== null) return normaliseTime(0, bare, 0, true); // bare number = minutes
    return null;
  }

  const bareHour = toInt(s);
  if (bareHour !== null) return normaliseTime(bareHour, 0, 0, false);
  return null;
}

/* ------------------------------------------------------------------ */
/* Fallback values (used when a required answer is missing/unusable)   */
/* ------------------------------------------------------------------ */

export function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function fallbackDate(): string {
  const d = new Date(Date.now() - Math.floor(Math.random() * 45) * 86_400_000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(9 + Math.floor(Math.random() * 9))}:${pick(['00', '15', '30', '45'])}`;
}

export function fallbackTime(isDuration: boolean): string {
  if (isDuration) return `${Math.floor(Math.random() * 3)}:${pad2(Math.floor(Math.random() * 60))}:00`;
  return `${pad2(8 + Math.floor(Math.random() * 11))}:${pick(['00', '15', '30', '45'])}`;
}

export function fallbackEmail(): string {
  const first = pick(['alex', 'sam', 'priya', 'jordan', 'nuwan', 'mei', 'chris', 'dilini', 'omar', 'tara']);
  const last = pick(['perera', 'silva', 'khan', 'lee', 'brown', 'garcia', 'novak', 'ito', 'ahmed', 'walsh']);
  return `${first}.${last}${Math.floor(Math.random() * 900) + 100}@gmail.com`;
}

export function fallbackText(field: FormField): string {
  const kind = field.validation?.kind;
  if (kind === 'email') return fallbackEmail();
  if (kind === 'url') return 'https://example.com';
  if (kind === 'number' || kind === 'integer') {
    const min = field.validation?.min ?? 1;
    const max = field.validation?.max ?? Math.max(min + 9, 10);
    return String(Math.floor(min + Math.random() * (max - min + 1)));
  }
  if (field.type === 'textarea') {
    return pick([
      'Overall it has been a solid experience and it fits into my daily workflow well.',
      'It works well for what I need, though there is still room for improvement.',
      'I have been using it for a while now and it does the job reliably.',
    ]);
  }
  return pick(['Good', 'Works well', 'Satisfied', 'No issues so far']);
}

/* ------------------------------------------------------------------ */
/* Coercion: force any model output into a submittable value           */
/* ------------------------------------------------------------------ */

export interface CoerceResult {
  value: string | string[] | null;
  /** true when the incoming value had to be repaired or invented. */
  repaired: boolean;
  note?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isExcluded(value: string, excluded: string[]): boolean {
  if (!excluded.length) return false;
  const v = strictNorm(value);
  return excluded.some((e) => strictNorm(e) === v);
}

/**
 * Turn `raw` into something Google will actually accept for `field`.
 * Returns `value: null` only for optional fields with genuinely no answer.
 */
export function coerceFieldValue(field: FormField, raw: unknown, excluded: string[] = []): CoerceResult {
  const options = (field.options ?? []).filter((o) => !isExcluded(o, excluded));
  const empty =
    raw === null ||
    raw === undefined ||
    (typeof raw === 'string' && raw.trim() === '') ||
    (Array.isArray(raw) && raw.length === 0);

  switch (field.type) {
    case 'email': {
      const s = firstScalar(raw).trim();
      if (EMAIL_RE.test(s)) return { value: s, repaired: false };
      return { value: fallbackEmail(), repaired: true, note: 'invalid email address' };
    }

    case 'text':
    case 'textarea': {
      let s = firstScalar(raw).trim();
      if (!s) {
        if (!field.required) return { value: null, repaired: false };
        return { value: fallbackText(field), repaired: true, note: 'empty required text' };
      }
      const v = field.validation;
      if (v?.kind === 'email' && !EMAIL_RE.test(s)) {
        return { value: fallbackEmail(), repaired: true, note: 'failed email validation' };
      }
      if (v?.kind === 'url' && !/^https?:\/\/\S+$/i.test(s)) {
        return { value: 'https://example.com', repaired: true, note: 'failed url validation' };
      }
      if (v?.kind === 'number' || v?.kind === 'integer') {
        const n = toInt(s);
        if (n === null) return { value: fallbackText(field), repaired: true, note: 'failed number validation' };
        const bounded = clamp(n, v.min ?? -1e9, v.max ?? 1e9);
        return { value: String(bounded), repaired: bounded !== n };
      }
      if (v?.kind === 'length' && v.max !== undefined && s.length > v.max) {
        s = s.slice(0, v.max).trim();
        return { value: s, repaired: true, note: 'truncated to max length' };
      }
      return { value: s, repaired: false };
    }

    case 'radio':
    case 'dropdown':
    case 'radio_grid': {
      if (empty) {
        if (!field.required) return { value: null, repaired: false };
        return { value: options.length ? pick(options) : null, repaired: true, note: 'missing choice' };
      }
      const matched = matchOption(raw, options);
      if (matched !== null) return { value: matched, repaired: false };

      const free = firstScalar(raw).trim();
      if (field.hasOther && free) return { value: free, repaired: true, note: 'routed to "Other"' };
      if (options.length) return { value: pick(options), repaired: true, note: `"${free}" is not an option` };
      return { value: free, repaired: false };
    }

    case 'checkbox':
    case 'checkbox_grid': {
      const incoming = toList(raw);
      const chosen: string[] = [];
      let otherText: string | null = null;

      for (const item of incoming) {
        const matched = matchOption(item, options);
        if (matched !== null) {
          if (!chosen.includes(matched)) chosen.push(matched);
        } else if (field.hasOther && field.type === 'checkbox' && otherText === null && item.trim()) {
          otherText = item.trim();
        }
      }
      if (otherText !== null) chosen.push(otherText);

      if (chosen.length === 0) {
        if (!field.required) return { value: [], repaired: incoming.length > 0 };
        if (!options.length) return { value: [], repaired: true, note: 'no selectable options left' };
        return { value: [pick(options)], repaired: true, note: 'missing checkbox selection' };
      }
      return { value: chosen, repaired: chosen.length !== incoming.length };
    }

    case 'linear_scale':
    case 'rating': {
      const low = field.low ?? 1;
      const high = field.high ?? 5;
      const n = toInt(firstScalar(raw));
      if (n === null) {
        return { value: String(Math.round((low + high) / 2)), repaired: true, note: 'non-numeric scale value' };
      }
      const bounded = clamp(n, low, high);
      return { value: String(bounded), repaired: bounded !== n };
    }

    case 'date': {
      const parts = parseDateValue(raw);
      if (!parts) {
        if (!field.required) return { value: null, repaired: !empty };
        return { value: fallbackDate(), repaired: true, note: 'unparseable date' };
      }
      const iso = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
      return { value: iso, repaired: true };
    }

    case 'time': {
      const parts = parseTimeValue(raw, field.isDuration === true);
      if (!parts) {
        if (!field.required) return { value: null, repaired: !empty };
        return { value: fallbackTime(field.isDuration === true), repaired: true, note: 'unparseable time' };
      }
      return {
        value: field.isDuration
          ? `${parts.hour}:${pad2(parts.minute)}:${pad2(parts.second)}`
          : `${pad2(parts.hour)}:${pad2(parts.minute)}`,
        repaired: true,
      };
    }

    default:
      return { value: firstScalar(raw) || null, repaired: false };
  }
}
