import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { Client } from '@upstash/qstash';
import {
  FormField,
  clamp,
  coerceFieldValue,
  isExcluded,
  matchOption,
  pick,
  toInt,
} from '@/lib/formFields';
import { submitResponse } from '@/lib/googleFormSubmit';

export const runtime = 'nodejs';
export const maxDuration = 300;

type FieldIntent = 'positive' | 'negative' | 'random';

const MODEL = 'llama-3.3-70b-versatile';
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 3;
const MAX_COUNT = 100;

/* ------------------------------------------------------------------ */
/* Field overrides parsed out of the persona/context box               */
/* ------------------------------------------------------------------ */

const OVERRIDE_KEYWORDS = [
  'strongly_disagree',
  'disagree',
  'neutral',
  'agree',
  'strongly_agree',
  'min',
  'max',
  'random',
] as const;

type OverrideKeyword = (typeof OVERRIDE_KEYWORDS)[number];

const LIKERT_ORDER: OverrideKeyword[] = [
  'strongly_disagree',
  'disagree',
  'neutral',
  'agree',
  'strongly_agree',
];

const LIKERT_LABELS: Record<string, string> = {
  strongly_disagree: 'Strongly Disagree',
  disagree: 'Disagree',
  neutral: 'Neutral',
  agree: 'Agree',
  strongly_agree: 'Strongly Agree',
};

function parseFieldOverrides(context: string): Record<string, OverrideKeyword> {
  const overrides: Record<string, OverrideKeyword> = {};
  const section = context.match(/field\s+overrides\s*:([\s\S]*?)(?:\n\n|\n[A-Z]|$)/i);
  if (!section) return overrides;

  const pairRegex = /(entry\.\d+)\s*=\s*([a-z_]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(section[1])) !== null) {
    const name = match[1].toLowerCase();
    const keyword = match[2].toLowerCase() as OverrideKeyword;
    if (OVERRIDE_KEYWORDS.includes(keyword)) overrides[name] = keyword;
    else console.warn(`Unknown override keyword "${keyword}" for ${name} — skipping`);
  }
  return overrides;
}

/* ------------------------------------------------------------------ */
/* Sentiment ordering                                                  */
/* ------------------------------------------------------------------ */

const POSITIVE_RE = /strongly agree|excellent|very satisfied|very good|very likely|always|outstanding/i;
const NEGATIVE_RE = /strongly disagree|very dissatisfied|very poor|terrible|awful|never|not at all|very unlikely/i;

/** Return the options ordered most-negative → most-positive. */
function orientOptions(options: string[]): string[] {
  if (options.length < 2) return options;
  const firstIsPositive = POSITIVE_RE.test(options[0]);
  const lastIsNegative = NEGATIVE_RE.test(options[options.length - 1]);
  return firstIsPositive || lastIsNegative ? [...options].reverse() : options;
}

/**
 * Nudge a choice into the requested half of the scale without collapsing every
 * response onto the same option — hard-forcing one value produces obviously
 * fake, identical rows.
 */
function steerChoice(value: unknown, options: string[], intent: FieldIntent): unknown {
  if (intent === 'random' || options.length < 2) return value;
  const ordered = orientOptions(options);
  const mid = Math.floor(ordered.length / 2);
  const wanted = intent === 'negative' ? ordered.slice(0, Math.max(1, mid)) : ordered.slice(mid);

  const current = matchOption(value, options);
  if (current !== null && wanted.includes(current)) return value;
  return pick(wanted);
}

function steerScale(value: unknown, low: number, high: number, intent: FieldIntent): unknown {
  if (intent === 'random') return value;
  const mid = (low + high) / 2;
  const n = toInt(value);
  if (intent === 'negative') {
    if (n !== null && n <= mid) return value;
    return String(low + Math.floor(Math.random() * Math.max(1, Math.ceil(mid) - low + 1)));
  }
  if (n !== null && n >= mid) return value;
  const from = Math.ceil(mid);
  return String(from + Math.floor(Math.random() * Math.max(1, high - from + 1)));
}

function resolveOverride(field: FormField, keyword: OverrideKeyword): unknown {
  const options = field.options ?? [];
  const isScale = field.type === 'linear_scale' || field.type === 'rating';
  const low = field.low ?? 1;
  const high = field.high ?? 5;

  if (keyword === 'random') {
    if (isScale) return String(low + Math.floor(Math.random() * (high - low + 1)));
    return options.length ? pick(options) : undefined;
  }
  if (keyword === 'min') {
    if (isScale) return String(low);
    const ordered = orientOptions(options);
    return ordered[0];
  }
  if (keyword === 'max') {
    if (isScale) return String(high);
    const ordered = orientOptions(options);
    return ordered[ordered.length - 1];
  }

  // Likert keyword.
  const idx = LIKERT_ORDER.indexOf(keyword);
  if (isScale) {
    // Map the 5-point scale onto this question's actual range.
    return String(Math.round(low + (idx / (LIKERT_ORDER.length - 1)) * (high - low)));
  }
  const label = LIKERT_LABELS[keyword];
  const matched = matchOption(label, options);
  if (matched !== null) return matched;
  if (options.length) {
    const ordered = orientOptions(options);
    const pos = Math.round((idx / (LIKERT_ORDER.length - 1)) * (ordered.length - 1));
    return ordered[clamp(pos, 0, ordered.length - 1)];
  }
  return label;
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

function answerSpec(field: FormField): string {
  switch (field.type) {
    case 'email':
      return 'A realistic personal email address.';
    case 'text':
      return `A short realistic answer, under 80 characters${field.validation ? ` (${field.validation.description})` : ''}.`;
    case 'textarea':
      return `One to three realistic sentences${field.validation ? ` (${field.validation.description})` : ''}.`;
    case 'radio':
    case 'dropdown':
      return `EXACTLY ONE string copied verbatim from "options"${field.hasOther ? ', or a short free-text answer if none fit' : ''}.`;
    case 'radio_grid':
      return 'EXACTLY ONE string copied verbatim from "options" (these are the grid columns).';
    case 'checkbox':
      return `A JSON ARRAY of one or more strings copied verbatim from "options"${field.hasOther ? ', optionally plus one free-text entry' : ''}.`;
    case 'checkbox_grid':
      return 'A JSON ARRAY of strings copied verbatim from "options" (these are the grid columns).';
    case 'linear_scale':
    case 'rating':
      return `A whole number from ${field.low ?? 1} to ${field.high ?? 5} inclusive.`;
    case 'date':
      // Always ask for a time too: a date+time question needs it, and a
      // date-only question simply ignores the extra parameters.
      return 'A date string formatted EXACTLY as "YYYY-MM-DD HH:MM" using a 24-hour clock.';
    case 'time':
      return field.isDuration
        ? 'A duration formatted EXACTLY as "H:MM:SS".'
        : 'A time of day formatted EXACTLY as "HH:MM" using a 24-hour clock.';
    default:
      return 'A short realistic answer.';
  }
}

function describeField(field: FormField, intent: FieldIntent) {
  const spec: Record<string, unknown> = {
    name: field.name,
    question: field.gridTitle ? `${field.gridTitle} — ${field.rowLabel}` : field.title,
    type: field.type,
    required: field.required,
    answer: answerSpec(field),
  };
  if (field.options?.length) spec.options = field.options;
  if (field.hasOther) spec.allowsOtherFreeText = true;
  if (field.low !== undefined) spec.min = field.low;
  if (field.high !== undefined) spec.max = field.high;
  if (field.lowLabel) spec.minLabel = field.lowLabel;
  if (field.highLabel) spec.maxLabel = field.highLabel;
  if (intent !== 'random') spec.tone = intent;
  return spec;
}

/* ------------------------------------------------------------------ */
/* Model output handling                                               */
/* ------------------------------------------------------------------ */

function extractRows(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['responses', 'data', 'results', 'rows', 'items', 'answers']) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value) && value.every((v) => v && typeof v === 'object')) {
        return value as Record<string, unknown>[];
      }
    }
    // A single row returned bare.
    if (Object.keys(obj).some((k) => k.startsWith('entry.') || k === 'emailAddress')) return [obj];
  }
  return [];
}

function safeParse(content: string): unknown {
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Salvage the outermost JSON structure if the model wrapped it in prose.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/** Run async tasks with a bounded number in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, fields, context, count, timeWindowHours, pageCount, mode } = body ?? {};

    if (!formUrl || !Array.isArray(fields) || fields.length === 0) {
      return NextResponse.json({ error: 'Missing form URL or field schema.' }, { status: 400 });
    }

    const isTest = mode === 'test';
    const requested = isTest ? 1 : clamp(toInt(count) ?? 1, 1, MAX_COUNT);

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return NextResponse.json({ error: 'Missing GROQ_API_KEY.' }, { status: 500 });
    }

    const qstashToken = process.env.QSTASH_TOKEN;
    if (!isTest && !qstashToken) {
      return NextResponse.json({ error: 'Missing QSTASH_TOKEN.' }, { status: 500 });
    }

    const seen = new Set<string>();
    const allFields = (fields as FormField[]).filter((f) => {
      if (!f?.name || seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });

    const groq = new OpenAI({ apiKey: groqApiKey, baseURL: 'https://api.groq.com/openai/v1' });
    const contextText = typeof context === 'string' ? context : '';

    /* ---- Step 1: deterministic overrides from the context box ---- */
    const hardOverrides = parseFieldOverrides(contextText);

    /* ---- Step 2: classify intent + banned option values ---- */
    const classifiable = allFields.filter(
      (f) => !(f.name in hardOverrides) && f.type !== 'date' && f.type !== 'time' && f.type !== 'email',
    );

    const intentMap: Record<string, FieldIntent> = {};
    // Default is "random", i.e. trust the model. Forcing a direction everywhere
    // makes every response identical.
    for (const f of allFields) intentMap[f.name] = 'random';
    let excludedOptions: string[] = [];

    if (classifiable.length > 0 && contextText.trim()) {
      try {
        const classifyPrompt = [
          "You are analysing a survey form's context instructions in order to:",
          '1. Classify the tone each field should be answered with.',
          '2. Identify option values that must NEVER be selected.',
          '',
          `Context: "${contextText}"`,
          `Fields: ${JSON.stringify(
            classifiable.map((f) => ({ name: f.name, title: f.title, type: f.type, options: f.options ?? [] })),
            null,
            2,
          )}`,
          '',
          'Only mark a field "positive" or "negative" when the context clearly asks for it; otherwise use "random".',
          'Return ONLY raw JSON: {"intents":{"entry.123":"positive"|"negative"|"random"},"excludedOptions":["string"]}',
        ].join('\n');

        const completion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: classifyPrompt }],
          model: MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
        });

        const parsed = safeParse(completion.choices[0]?.message?.content ?? '{}') as any;
        if (parsed?.intents && typeof parsed.intents === 'object') {
          for (const [name, intent] of Object.entries(parsed.intents)) {
            if (intent === 'positive' || intent === 'negative' || intent === 'random') {
              intentMap[name] = intent;
            }
          }
        }
        if (Array.isArray(parsed?.excludedOptions)) {
          excludedOptions = parsed.excludedOptions.filter((o: unknown) => typeof o === 'string' && o.trim());
        }
      } catch (err) {
        console.warn('Intent classification failed, defaulting to random:', (err as Error).message);
      }
    }

    /* ---- Step 3: strip banned options from the schema ---- */
    const cleanedFields: FormField[] = allFields.map((f) => {
      if (!Array.isArray(f.options) || excludedOptions.length === 0) return f;
      const options = f.options.filter((o) => !isExcluded(o, excludedOptions));
      return { ...f, options: options.length ? options : f.options };
    });

    /* ---- Step 4: field guide (every type gets its real constraints) ---- */
    const guided = cleanedFields.filter((f) => !(f.name in hardOverrides));
    const fieldGuide = guided.map((f) => describeField(f, intentMap[f.name] ?? 'random'));

    /* ---- Step 5: generate in batches ---- */
    const batches: number[] = [];
    for (let remaining = requested; remaining > 0; remaining -= BATCH_SIZE) {
      batches.push(Math.min(BATCH_SIZE, remaining));
    }

    const basePrompt = [
      `You are generating realistic Google Form responses from this persona: "${contextText || 'General users'}"`,
      '',
      'FIELD SPECIFICATION:',
      JSON.stringify(fieldGuide, null, 2),
      '',
      'RULES:',
      '- Use the exact "name" values as JSON keys. Never invent keys.',
      '- Follow each field\'s "answer" instruction to the letter.',
      '- For choice fields the value MUST be copied character-for-character from "options".',
      excludedOptions.length ? `- Never use any of these values: ${JSON.stringify(excludedOptions)}.` : '',
      '- Vary the answers between people. Do not repeat the same wording.',
      '- Answer every field, including optional ones, unless a blank is realistic.',
    ]
      .filter(Boolean)
      .join('\n');

    const rawBatches = await mapLimit(batches, BATCH_CONCURRENCY, async (n) => {
      const prompt = `${basePrompt}\n\nReturn ONLY raw JSON shaped as {"responses":[ ... ]} containing exactly ${n} response objects.`;
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: MODEL,
        temperature: 0.9,
        response_format: { type: 'json_object' },
      });
      return extractRows(safeParse(completion.choices[0]?.message?.content ?? '{}'));
    });

    const rawRows = rawBatches.flat();
    if (rawRows.length === 0) {
      return NextResponse.json(
        { error: 'The model did not return any usable responses. Try again or reduce the response count.' },
        { status: 502 },
      );
    }

    /* ---- Step 6: repair every row against the real schema ---- */
    const repairNotes = new Map<string, number>();

    const buildRow = (rawRow: Record<string, unknown>): Record<string, unknown> => {
      const row: Record<string, unknown> = {};

      for (const field of cleanedFields) {
        const override = hardOverrides[field.name];
        let raw: unknown;

        if (override) {
          raw = resolveOverride(field, override);
        } else {
          raw = rawRow?.[field.name];
          if (raw === undefined) raw = rawRow?.[field.title];

          const intent = intentMap[field.name] ?? 'random';
          if (intent !== 'random') {
            if (field.type === 'linear_scale' || field.type === 'rating') {
              raw = steerScale(raw, field.low ?? 1, field.high ?? 5, intent);
            } else if (field.options?.length && field.type !== 'checkbox' && field.type !== 'checkbox_grid') {
              raw = steerChoice(raw, field.options, intent);
            }
          }
        }

        const { value, repaired, note } = coerceFieldValue(field, raw, excludedOptions);
        if (repaired && note) repairNotes.set(note, (repairNotes.get(note) ?? 0) + 1);
        if (value === null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        row[field.name] = value;
      }

      return row;
    };

    // Top the batch up if the model returned fewer rows than asked for.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < requested; i++) {
      rows.push(buildRow(rawRows[i % rawRows.length] ?? {}));
    }

    const missingRequired = cleanedFields
      .filter((f) => f.required && rows.some((r) => r[f.name] === undefined))
      .map((f) => f.title);

    const notes = Array.from(repairNotes.entries()).map(([note, n]) => `${note} (${n}x)`);
    if (notes.length) console.log('[generate] repairs:', notes.join(', '));

    const resolvedPageCount = typeof pageCount === 'number' && pageCount > 0 ? pageCount : undefined;

    /* ---- Step 7a: test mode — submit one now and report the truth ---- */
    if (isTest) {
      const result = await submitResponse({
        formUrl,
        fields: cleanedFields,
        data: rows[0],
        pageCount: resolvedPageCount,
      });
      return NextResponse.json({
        success: result.success,
        error: result.error,
        preview: rows[0],
        pages: result.pages,
        warnings: [...result.warnings, ...notes.map((n) => `Repaired: ${n}`)],
        missingRequired,
      });
    }

    /* ---- Step 7b: schedule via QStash ---- */
    const protocol = req.headers.get('x-forwarded-proto') ?? 'https';
    const host = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;
    const qstash = new Client({ token: qstashToken! });

    const windowSeconds = Math.max(0, (toInt(timeWindowHours) ?? 0) * 3600);

    // One failed publish must not discard the ones that already went out, so
    // failures are collected rather than thrown.
    const failures: string[] = [];
    await mapLimit(rows, 5, async (data) => {
      // `delay` is in seconds.
      const delay = windowSeconds > 0 ? Math.floor(Math.random() * windowSeconds) : 0;
      try {
        await qstash.publishJSON({
          url: submitUrl,
          body: { formUrl, data, fields: cleanedFields, pageCount: resolvedPageCount },
          retries: 3,
          ...(delay > 0 ? { delay } : {}),
        });
      } catch (err) {
        failures.push((err as Error).message);
      }
    });

    const scheduled = rows.length - failures.length;
    if (scheduled === 0) {
      return NextResponse.json(
        { error: `Could not schedule any responses: ${failures[0] ?? 'unknown QStash error'}` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      scheduled,
      message: `Scheduled ${scheduled} response${scheduled === 1 ? '' : 's'}.`,
      warnings: [
        ...notes.map((n) => `Repaired: ${n}`),
        ...(failures.length ? [`${failures.length} response(s) could not be queued: ${failures[0]}`] : []),
      ],
      missingRequired,
    });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: (error as Error).message || 'Server error' }, { status: 500 });
  }
}
