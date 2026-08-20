/**
 * Everything to do with actually POSTing a response to Google Forms:
 * parameter encoding per field type, cookie/session handling across sections,
 * and telling a real success apart from a re-rendered validation error.
 */

import {
  FormField,
  OTHER_SENTINEL,
  clamp,
  fallbackDate,
  fallbackTime,
  firstScalar,
  matchOption,
  parseDateValue,
  parseTimeValue,
  toInt,
  toList,
} from './formFields';

/* ------------------------------------------------------------------ */
/* Parameter encoding                                                  */
/* ------------------------------------------------------------------ */

/**
 * Append the Google Forms parameters for one field.
 *
 * Note on date/time: Google ignores sub-parameters a question does not use, so
 * when the scraper could not positively determine the variant we deliberately
 * send the superset (`_hour`/`_minute` on dates, `_second` on times). Missing a
 * required sub-parameter fails the whole submission; an extra one does not.
 */
export function appendFieldParams(
  params: URLSearchParams,
  field: FormField,
  rawValue: unknown,
): void {
  const name = field.name;
  const options = field.options ?? [];

  switch (field.type) {
    case 'checkbox':
    case 'checkbox_grid': {
      const items = toList(rawValue);
      let otherUsed = false;

      for (const item of items) {
        const matched = matchOption(item, options);
        if (matched !== null) {
          params.append(name, matched);
        } else if (field.hasOther && field.type === 'checkbox' && !otherUsed && item.trim()) {
          otherUsed = true;
          params.append(name, OTHER_SENTINEL);
          params.append(`${name}.other_option_response`, item.trim());
        }
      }
      // Google's own client always posts this alongside checkbox questions and
      // required-checkbox validation depends on it being present.
      params.append(`${name}_sentinel`, '');
      return;
    }

    case 'radio':
    case 'dropdown':
    case 'radio_grid': {
      const raw = firstScalar(rawValue).trim();
      if (!raw) {
        if (field.hasOther) params.append(`${name}_sentinel`, '');
        return;
      }
      const matched = matchOption(raw, options);
      if (matched !== null) {
        params.append(name, matched);
      } else if (field.hasOther) {
        params.append(name, OTHER_SENTINEL);
        params.append(`${name}.other_option_response`, raw);
      } else if (options.length) {
        // Never post a value Google will discard: fall back to a real option so
        // a required question still validates.
        params.append(name, options[0]);
      } else {
        params.append(name, raw);
      }
      if (field.hasOther) params.append(`${name}_sentinel`, '');
      return;
    }

    case 'linear_scale':
    case 'rating': {
      const low = field.low ?? 1;
      const high = field.high ?? 5;
      const n = toInt(firstScalar(rawValue));
      if (n === null) return;
      params.append(name, String(clamp(n, low, high)));
      return;
    }

    case 'date': {
      const parts = parseDateValue(rawValue) ?? parseDateValue(fallbackDate());
      if (!parts) return;
      if (field.includeYear !== false) params.append(`${name}_year`, String(parts.year));
      params.append(`${name}_month`, String(parts.month));
      params.append(`${name}_day`, String(parts.day));
      if (field.includeTime !== false) {
        params.append(`${name}_hour`, String(parts.hour));
        params.append(`${name}_minute`, String(parts.minute));
      }
      return;
    }

    case 'time': {
      const isDuration = field.isDuration === true;
      const parts =
        parseTimeValue(rawValue, isDuration) ?? parseTimeValue(fallbackTime(isDuration), isDuration);
      if (!parts) return;
      params.append(`${name}_hour`, String(parts.hour));
      params.append(`${name}_minute`, String(parts.minute));
      if (field.isDuration !== false) params.append(`${name}_second`, String(parts.second));
      return;
    }

    default: {
      const s = firstScalar(rawValue);
      if (s === '') return;
      params.append(name, s);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

/**
 * Split a folded `set-cookie` header without breaking on the comma inside
 * `Expires=Wed, 21 Oct 2025 07:28:00 GMT`.
 */
export function splitSetCookie(header: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== ',') continue;
    // A real separator is followed by `name=` (no spaces/semicolons before `=`).
    if (/^\s*[^=;,\s]+=/.test(header.slice(i + 1))) {
      out.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(header.slice(start).trim());
  return out.filter(Boolean);
}

function readSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? splitSetCookie(raw) : [];
}

/** Merge newly issued cookies into an existing `Cookie:` header value. */
export function mergeCookies(existing: string | null, setCookies: string[]): string | null {
  const jar = new Map<string, string>();
  if (existing) {
    for (const pair of existing.split(';')) {
      const [k, ...rest] = pair.trim().split('=');
      if (k) jar.set(k, rest.join('='));
    }
  }
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const [k, ...rest] = pair.trim().split('=');
    if (k) jar.set(k, rest.join('='));
  }
  if (jar.size === 0) return existing;
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ------------------------------------------------------------------ */
/* HTML helpers                                                        */
/* ------------------------------------------------------------------ */

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Read a hidden input's value regardless of attribute order. */
export function extractHiddenInput(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forward = new RegExp(`name=["']${escaped}["'][^>]*?value=["']([^"']*)["']`, 'i');
  const reverse = new RegExp(`value=["']([^"']*)["'][^>]*?name=["']${escaped}["']`, 'i');
  const m = html.match(forward) ?? html.match(reverse);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * The multi-section continuation token. Google has shipped this under two
 * names; rather than guessing we echo back whichever one the page actually
 * contains.
 */
export interface StateToken {
  name: 'partialResponse' | 'draftResponse';
  value: string;
}

export function extractStateToken(html: string): StateToken | null {
  for (const name of ['partialResponse', 'draftResponse'] as const) {
    const value = extractHiddenInput(html, name);
    if (value) return { name, value };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Response classification                                             */
/* ------------------------------------------------------------------ */

export type ResponseKind = 'confirmation' | 'error' | 'form' | 'login' | 'closed' | 'unknown';

export interface Classification {
  kind: ResponseKind;
  errors: string[];
}

const CONFIRMATION_MARKERS = [
  'freebirdformviewerviewresponseconfirmation',
  'your response has been recorded',
  'response has been recorded',
  'submit another response',
  'thanks for filling',
  'thank you for filling',
];

const ERROR_PHRASES = [
  'this is a required question',
  'is a required question',
  'must be a number',
  'enter a valid email address',
  'enter a valid url',
  'invalid response',
  'must select at least',
  'select at most',
  'must be a whole number',
  'enter a date',
  'enter a time',
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

export function classifyResponse(html: string): Classification {
  const lower = html.toLowerCase();

  if (lower.includes('accounts.google.com/v3/signin') || lower.includes('servicelogin')) {
    return { kind: 'login', errors: ['The form requires a Google sign-in.'] };
  }
  if (lower.includes('closedform') || lower.includes('no longer accepting responses')) {
    return { kind: 'closed', errors: ['The form is no longer accepting responses.'] };
  }

  const text = stripTags(html).toLowerCase();
  const matched = ERROR_PHRASES.filter((p) => text.includes(p));
  // Several phrases overlap ("is a required question" sits inside "this is a
  // required question"); keep only the most specific of each pair.
  const errors = matched.filter((p) => !matched.some((other) => other !== p && other.includes(p)));
  if (errors.length) return { kind: 'error', errors };

  if (CONFIRMATION_MARKERS.some((m) => lower.includes(m))) {
    return { kind: 'confirmation', errors: [] };
  }

  // Still showing the questionnaire => the submission was rejected and the page
  // was simply re-rendered.
  const stillForm =
    /<form[^>]+action=["'][^"']*formresponse/i.test(html) || lower.includes('fb_public_load_data_');
  if (stillForm) return { kind: 'form', errors: [] };

  return { kind: 'unknown', errors: [] };
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Google generates a fresh random fbzx on every page load; reusing one across
 *  many submissions is a duplicate-detection risk, so we mint a new one. */
export function randomFbzx(): string {
  let digits = String(1 + Math.floor(Math.random() * 9));
  for (let i = 0; i < 17; i++) digits += Math.floor(Math.random() * 10);
  return (Math.random() < 0.5 ? '-' : '') + digits;
}

export interface SubmitArgs {
  /** `https://docs.google.com/forms/d/e/<id>/formResponse` */
  formUrl: string;
  fields: FormField[];
  data: Record<string, unknown>;
  /** Total number of sections, including ones with no answerable question. */
  pageCount?: number;
}

export interface PageOutcome {
  pageIndex: number;
  status: number;
  kind: ResponseKind;
  errors: string[];
  sentKeys: string[];
}

export interface SubmitResult {
  success: boolean;
  error?: string;
  pages: PageOutcome[];
  warnings: string[];
}

export async function submitResponse(args: SubmitArgs): Promise<SubmitResult> {
  const { formUrl, fields, data } = args;
  const warnings: string[] = [];
  const pages: PageOutcome[] = [];

  const viewUrl = formUrl.replace(/\/formResponse.*$/, '/viewform');
  const maxFieldPage = fields.reduce((m, f) => Math.max(m, f.pageIndex ?? 0), 0);
  const totalPages = Math.max(args.pageCount ?? 1, maxFieldPage + 1, 1);

  let cookies: string | null = null;
  let fbzx = randomFbzx();
  let state: StateToken | null = null;

  // Multi-section forms are stateful: start from a real page load so we hold a
  // matching cookie jar and fbzx before the first POST.
  if (totalPages > 1) {
    try {
      const seed = await fetch(viewUrl, { headers: { 'User-Agent': UA } });
      cookies = mergeCookies(cookies, readSetCookies(seed));
      const seedHtml = await seed.text();
      const seedFbzx = extractHiddenInput(seedHtml, 'fbzx');
      if (seedFbzx) fbzx = seedFbzx;
      state = extractStateToken(seedHtml);
    } catch {
      warnings.push('Could not pre-load the form; continuing with a generated fbzx.');
    }
  }

  // Fields that belong to each section. Sections with no answerable question
  // still have to be walked through, so we iterate the page range, not the map.
  const byPage = new Map<number, FormField[]>();
  for (const f of fields) {
    const p = f.pageIndex ?? 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p)!.push(f);
  }

  const alreadySent: FormField[] = [];

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const isLastPage = pageIndex === totalPages - 1;
    const pageFields = byPage.get(pageIndex) ?? [];

    const params = new URLSearchParams();
    params.append('fvv', '1');
    params.append('pageHistory', Array.from({ length: pageIndex + 1 }, (_, i) => i).join(','));
    params.append('fbzx', fbzx);
    params.append('submissionTimestamp', '-1');
    if (state) params.append(state.name, state.value);
    if (!isLastPage) params.append('continue', '1');

    // Normally only the current section's answers are posted; the continuation
    // token carries the earlier ones. If we never found that token, resend
    // everything so the answers are not silently dropped.
    const toSend = state ? pageFields : [...alreadySent, ...pageFields];

    for (const field of toSend) {
      const value = data[field.name];
      if (value === undefined || value === null) continue;
      appendFieldParams(params, field, value);
    }
    alreadySent.push(...pageFields);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: viewUrl,
      Origin: 'https://docs.google.com',
    };
    if (cookies) headers.Cookie = cookies;

    const res = await fetch(formUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      redirect: 'manual',
    });

    cookies = mergeCookies(cookies, readSetCookies(res));
    const sentKeys = Array.from(new Set(params.keys())).filter((k) => k.startsWith('entry.') || k === 'emailAddress');

    if (res.status >= 400) {
      pages.push({ pageIndex, status: res.status, kind: 'unknown', errors: [`HTTP ${res.status}`], sentKeys });
      return { success: false, error: `Page ${pageIndex + 1}: HTTP ${res.status}`, pages, warnings };
    }

    // A 3xx to formResponse is Google's success redirect.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      if (/accounts\.google\.com/i.test(location)) {
        pages.push({ pageIndex, status: res.status, kind: 'login', errors: ['sign-in required'], sentKeys });
        return { success: false, error: 'The form requires a Google sign-in.', pages, warnings };
      }
      pages.push({ pageIndex, status: res.status, kind: 'confirmation', errors: [], sentKeys });
      if (isLastPage) return { success: true, pages, warnings };
      continue;
    }

    const html = await res.text();
    const cls = classifyResponse(html);
    pages.push({ pageIndex, status: res.status, kind: cls.kind, errors: cls.errors, sentKeys });

    if (cls.kind === 'login' || cls.kind === 'closed') {
      return { success: false, error: cls.errors[0], pages, warnings };
    }
    if (cls.kind === 'error') {
      return {
        success: false,
        error: `Page ${pageIndex + 1} was rejected: ${cls.errors.join('; ')}`,
        pages,
        warnings,
      };
    }

    if (isLastPage) {
      if (cls.kind === 'confirmation') return { success: true, pages, warnings };
      if (cls.kind === 'form') {
        return {
          success: false,
          error:
            'Google re-rendered the form instead of confirming. A required question was probably left blank or given a value it does not accept.',
          pages,
          warnings,
        };
      }
      warnings.push('Could not positively confirm the submission page; treating it as accepted.');
      return { success: true, pages, warnings };
    }

    // Intermediate page: pick up the next section's state.
    const nextState = extractStateToken(html);
    if (nextState) {
      state = nextState;
    } else if (!state) {
      warnings.push(
        `No continuation token on section ${pageIndex + 1}; resending all answers on the next section.`,
      );
    }

    const nextFbzx = extractHiddenInput(html, 'fbzx');
    if (nextFbzx) fbzx = nextFbzx;

    const history = extractHiddenInput(html, 'pageHistory');
    if (history) {
      const last = history.split(',').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)).pop();
      if (last !== undefined && last <= pageIndex) {
        warnings.push(
          `Section ${pageIndex + 1} did not advance (pageHistory=${history}). The form may use answer-based section branching, which is not supported.`,
        );
      }
    }
  }

  return { success: true, pages, warnings };
}
