import * as cheerio from 'cheerio';
import { NextResponse } from 'next/server';
import type { FieldType, FieldValidation, FormField } from '@/lib/formFields';
import { extractBootstrapArray } from '@/lib/formBootstrap';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Google's question type codes. */
const TYPE_MAP: Record<number, string> = {
  0: 'text',
  1: 'textarea',
  2: 'radio',
  3: 'dropdown',
  4: 'checkbox',
  5: 'linear_scale',
  6: 'title_description',
  7: 'grid', // both radio and checkbox grids
  8: 'page_break',
  9: 'date',
  10: 'time',
  11: 'image',
  12: 'video',
  13: 'file_upload',
  18: 'rating',
};

const NON_QUESTION = new Set(['title_description', 'image', 'video']);

/* ------------------------------------------------------------------ */
/* Per-question helpers                                                */
/* ------------------------------------------------------------------ */

const OTHER_LABEL = '__other_option__';

interface ParsedOptions {
  options: string[];
  hasOther: boolean;
  branches: boolean;
}

function parseOptions(rawOptions: unknown): ParsedOptions {
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  const options: string[] = [];
  let hasOther = false;
  let branches = false;

  for (const entry of list) {
    if (!Array.isArray(entry)) continue;
    const label = typeof entry[0] === 'string' ? entry[0] : '';

    // "Other…" shows up either as the sentinel label, as an explicit flag, or
    // as an option with an empty label.
    if (label === OTHER_LABEL || entry[4] === 1 || label.trim() === '') {
      hasOther = true;
      continue;
    }
    // A numeric section target means this option jumps somewhere.
    if (typeof entry[2] === 'number') branches = true;

    options.push(label);
  }

  return { options, hasOther, branches };
}

/**
 * Best-effort read of a short-answer question's response validation. Anything
 * we cannot confidently identify is left as `null` so the generator does not
 * get a misleading constraint.
 */
function parseValidation(entry: any, title: string, type: FieldType): FieldValidation | null {
  const raw = Array.isArray(entry?.[4]) ? entry[4][0] : null;

  if (Array.isArray(raw)) {
    const kindCode = typeof raw[0] === 'number' ? raw[0] : null;
    const subCode = typeof raw[1] === 'number' ? raw[1] : null;
    const args: number[] = Array.isArray(raw[2])
      ? raw[2].map((a: unknown) => Number(a)).filter((n: number) => Number.isFinite(n))
      : [];

    if (subCode === 102) return { kind: 'email', description: 'must be a valid email address' };
    if (subCode === 103) return { kind: 'url', description: 'must be a valid URL' };

    if (kindCode === 1) {
      const [min, max] = args;
      return {
        kind: 'number',
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
        description:
          Number.isFinite(min) && Number.isFinite(max)
            ? `must be a number between ${min} and ${max}`
            : 'must be a number',
      };
    }
    if (kindCode === 4 && args.length) {
      return { kind: 'length', max: Math.max(...args), description: `at most ${Math.max(...args)} characters` };
    }
  }

  // Narrow title heuristic — only for an unmistakably email-shaped label.
  if ((type === 'text' || type === 'textarea') && title.length <= 40 && /\be-?mail\b/i.test(title)) {
    return { kind: 'email', description: 'must be a valid email address' };
  }

  return null;
}

/**
 * Work out a scale question's numeric bounds. Google lists the selectable
 * numbers as the question's options, which survives layout changes better than
 * reading a fixed index, so that wins when it parses cleanly.
 */
function scaleBounds(entry: any, defaultLow: number, defaultHigh: number): { low: number; high: number } {
  const numbers = (Array.isArray(entry?.[1]) ? entry[1] : [])
    .map((o: any) => (Array.isArray(o) ? Number(o[0]) : Number(o)))
    .filter((n: number) => Number.isFinite(n));

  if (numbers.length >= 2) {
    return { low: Math.min(...numbers), high: Math.max(...numbers) };
  }

  const raw = Array.isArray(entry?.[3]) ? entry[3] : [];
  const low = Number(raw[0]);
  const high = Number(raw[1]);
  return {
    low: Number.isFinite(low) ? low : defaultLow,
    high: Number.isFinite(high) && high > (Number.isFinite(low) ? low : defaultLow) ? high : defaultHigh,
  };
}

/** Layout hints read off the rendered HTML, keyed by normalised question title. */
interface HtmlHint {
  hasDateInput: boolean;
  hasTimeInput: boolean;
  hasSeconds: boolean;
  hasYear: boolean;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/\*+$/, '').replace(/\s+/g, ' ').trim();
}

function collectHtmlHints($: cheerio.CheerioAPI): Map<string, HtmlHint> {
  const hints = new Map<string, HtmlHint>();
  $('div[role="listitem"]').each((_, el) => {
    const title = normTitle($(el).find('div[role="heading"], span.M7eMe').first().text());
    if (!title) return;

    const labels = $(el)
      .find('input')
      .map((__, input) => $(input).attr('aria-label') ?? '')
      .get()
      .join(' ')
      .toLowerCase();

    hints.set(title, {
      hasDateInput: $(el).find('input[type="date"]').length > 0 || /\bday\b|\bdate\b/.test(labels),
      hasTimeInput: $(el).find('input[type="time"]').length > 0 || /\bhour\b|\bminute\b/.test(labels),
      hasSeconds: /second/.test(labels),
      hasYear: /year/.test(labels),
    });
  });
  return hints;
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string' || !url.startsWith('https://docs.google.com/forms/')) {
      return NextResponse.json({ error: 'A valid Google Form URL is required.' }, { status: 400 });
    }

    const viewUrl = url.replace(/\/formResponse$/, '/viewform').split('?')[0];

    const res = await fetch(viewUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch the form URL.' }, { status: res.status });
    }

    const html = await res.text();

    if (html.includes('ServiceLogin') || html.includes('accounts.google.com/v3/signin')) {
      return NextResponse.json(
        { error: 'This form requires a Google sign-in. Make it public to continue.' },
        { status: 403 },
      );
    }
    if (/no longer accepting responses/i.test(html)) {
      return NextResponse.json({ error: 'This form is no longer accepting responses.' }, { status: 400 });
    }

    const $ = cheerio.load(html);
    const htmlHints = collectHtmlHints($);

    const fields: FormField[] = [];
    const warnings: string[] = [];
    let sectionCount = 1;
    let hasBranching = false;

    const bootstrap = extractBootstrapArray(html);
    const questions: any[] = bootstrap?.[1]?.[1] ?? [];

    if (questions.length) {
      let currentPage = 0;

      for (const q of questions) {
        const rawTitle = typeof q[1] === 'string' ? q[1].trim() : '';
        const typeCode: number = q[3];
        const kind = TYPE_MAP[typeCode] ?? 'text';

        if (kind === 'page_break') {
          currentPage++;
          sectionCount = currentPage + 1;
          continue;
        }
        if (NON_QUESTION.has(kind)) continue;

        const entries = Array.isArray(q[4]) ? q[4] : null;

        if (kind === 'file_upload') {
          const required = entries?.[0]?.[2] === true || entries?.[0]?.[2] === 1;
          warnings.push(
            required
              ? `"${rawTitle || 'File upload'}" is a REQUIRED file upload. Google will reject every submission because uploads need a signed-in account.`
              : `"${rawTitle || 'File upload'}" is a file upload and will be left blank.`,
          );
          continue;
        }

        if (!entries || !entries[0]) continue;

        const hint = htmlHints.get(normTitle(rawTitle));
        const base = { pageIndex: currentPage, title: rawTitle };

        if (kind === 'grid') {
          // Checkbox grids carry a marker in the row entry; if we cannot read it
          // we fall back to the rendered HTML role.
          const flagged = entries[0]?.[11]?.[0] === 1;
          // Cross-check against the rendered markup. Built as a filter rather
          // than an interpolated `:contains()` selector, which breaks on titles
          // containing quotes.
          const htmlIsCheckbox =
            rawTitle.length > 0 &&
            $('div[role="listitem"]')
              .filter((_, el) => $(el).text().includes(rawTitle))
              .find('div[role="checkbox"]').length > 0;
          const gridType: FieldType = flagged || htmlIsCheckbox ? 'checkbox_grid' : 'radio_grid';

          const { options: columns, branches } = parseOptions(entries[0][1]);
          if (branches) hasBranching = true;

          entries.forEach((row: any, i: number) => {
            const entryId = row?.[0];
            if (!entryId) return;
            const rowLabel = typeof row[3] === 'string' && row[3] ? row[3] : `Row ${i + 1}`;
            fields.push({
              name: `entry.${entryId}`,
              title: `${rawTitle} → ${rowLabel}`,
              type: gridType,
              pageIndex: currentPage,
              required: row[2] === true || row[2] === 1,
              options: columns,
              columns,
              gridTitle: rawTitle,
              rowLabel,
            });
          });
          continue;
        }

        const entry = entries[0];
        const entryId = entry?.[0];
        if (!entryId) continue;

        const name = `entry.${entryId}`;
        const required = entry[2] === true || entry[2] === 1;
        const title = rawTitle || `Field ${entryId}`;

        if (kind === 'linear_scale') {
          // The scale's own option list is the most reliable source for the
          // bounds; `entry[3]` holds the end labels and is only a fallback.
          const bounds = scaleBounds(entry, 1, 5);
          const labels = Array.isArray(entry[3]) ? entry[3] : [];
          const endLabels = labels.filter((l: unknown) => typeof l === 'string') as string[];
          fields.push({
            ...base,
            name,
            title,
            type: 'linear_scale',
            required,
            low: bounds.low,
            high: bounds.high,
            lowLabel: endLabels[0] ?? '',
            highLabel: endLabels[1] ?? '',
          });
          continue;
        }

        if (kind === 'rating') {
          const bounds = scaleBounds(entry, 1, 5);
          fields.push({
            ...base,
            name,
            title,
            type: 'rating',
            required,
            low: 1,
            high: bounds.high,
          });
          continue;
        }

        if (kind === 'date') {
          fields.push({
            ...base,
            name,
            title,
            type: 'date',
            required,
            // `undefined` means "not determined" — the submitter then sends the
            // superset of sub-parameters rather than risk omitting a required one.
            includeTime: hint ? hint.hasTimeInput : undefined,
            includeYear: hint?.hasYear ? true : undefined,
          });
          continue;
        }

        if (kind === 'time') {
          fields.push({
            ...base,
            name,
            title,
            type: 'time',
            required,
            isDuration: hint ? hint.hasSeconds : undefined,
          });
          continue;
        }

        if (kind === 'radio' || kind === 'dropdown' || kind === 'checkbox') {
          const { options, hasOther, branches } = parseOptions(entry[1]);
          if (branches) hasBranching = true;
          fields.push({
            ...base,
            name,
            title,
            type: kind as FieldType,
            required,
            options,
            hasOther,
          });
          continue;
        }

        // text / textarea
        const textType: FieldType = kind === 'textarea' ? 'textarea' : 'text';
        fields.push({
          ...base,
          name,
          title,
          type: textType,
          required,
          validation: parseValidation(entry, title, textType),
        });
      }
    }

    /* -------- Cheerio fallback (older/simple forms, single section) -------- */
    if (fields.length === 0) {
      $('div[role="listitem"], div.geS5n').each((_, elem) => {
        const title = $(elem)
          .find('div[role="heading"], span.M7eMe')
          .first()
          .text()
          .trim()
          .replace(/\*$/, '')
          .trim();

        const name =
          $(elem).find('input[name^="entry."], textarea[name^="entry."]').attr('name') ??
          $(elem).find('input[type="hidden"][name^="entry."]').attr('name');

        if (!name || fields.some((f) => f.name === name)) return;

        let type: FieldType = 'text';
        if ($(elem).find('textarea').length) type = 'textarea';
        else if ($(elem).find('div[role="radio"]').length) type = 'radio';
        else if ($(elem).find('div[role="checkbox"]').length) type = 'checkbox';
        else if ($(elem).find('div[role="listbox"]').length) type = 'dropdown';

        const options: string[] = [];
        $(elem)
          .find('div[data-value], span[data-value]')
          .each((__, opt) => {
            const val = $(opt).attr('data-value');
            if (val && val !== OTHER_LABEL) options.push(val);
          });

        fields.push({
          name,
          title: title || `Unknown (${name})`,
          type,
          pageIndex: 0,
          required: $(elem).find('[aria-required="true"], .vnumgf').length > 0,
          ...(options.length ? { options } : {}),
        });
      });
    }

    if (fields.length === 0) {
      $('input[name^="entry."], textarea[name^="entry."]').each((_, el) => {
        const name = $(el).attr('name');
        if (!name || fields.some((f) => f.name === name)) return;
        fields.push({
          name,
          title: `Unknown (${name})`,
          type: el.tagName === 'textarea' ? 'textarea' : 'text',
          pageIndex: 0,
          required: false,
        });
      });
    }

    /* -------- Email collection -------- */
    const collectsEmail =
      bootstrap?.[1]?.[10]?.[6] >= 2 ||
      /name=["']emailAddress["']/.test(html) ||
      /<input[^>]+type=["']email["']/i.test(html);

    if (collectsEmail && !fields.some((f) => f.name === 'emailAddress')) {
      fields.unshift({
        name: 'emailAddress',
        title: 'Email address',
        type: 'email',
        pageIndex: 0,
        required: true,
      });
    }

    /* -------- Dedupe, keeping the first (correct) pageIndex -------- */
    const seen = new Set<string>();
    const dedupedFields = fields.filter((f) => {
      if (seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });

    if (dedupedFields.length === 0) {
      return NextResponse.json(
        { error: 'No fields found. Check the URL and make sure the form is public.' },
        { status: 404 },
      );
    }

    const maxFieldPage = dedupedFields.reduce((m, f) => Math.max(m, f.pageIndex), 0);
    const pageCount = Math.max(sectionCount, maxFieldPage + 1);

    if (hasBranching) {
      warnings.push(
        'This form sends people to different sections based on their answers. Responses will follow the sections in order, which may not match every path.',
      );
    }

    const formTitle =
      $('div[role="heading"][aria-level="1"]').first().text().trim() ||
      $('title').text().replace(' - Google Forms', '').trim() ||
      'Untitled Form';

    const submitUrl = viewUrl.replace('/viewform', '/formResponse');

    console.log(
      `Scraped "${formTitle}": ${dedupedFields.length} fields across ${pageCount} section(s), ${warnings.length} warning(s)`,
    );

    return NextResponse.json({
      title: formTitle,
      submitUrl,
      fields: dedupedFields,
      pageCount,
      hasBranching,
      warnings,
    });
  } catch (error) {
    console.error('Error scraping form:', error);
    return NextResponse.json({ error: 'Unexpected error while extracting form fields.' }, { status: 500 });
  }
}
