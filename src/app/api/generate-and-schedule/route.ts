import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { Client } from '@upstash/qstash';

type FieldIntent = 'positive' | 'negative' | 'random';

// ── Supported override values and what they resolve to ───────────────────────
// These are the keywords users can write after entry.XXXXXXX= in context.
// Matched case-insensitively. Add more aliases here as needed.
const OVERRIDE_VALUE_MAP: Record<string, string[]> = {
  strongly_disagree: ['Strongly Disagree'],
  disagree:          ['Disagree'],
  neutral:           ['Neutral'],
  agree:             ['Agree'],
  strongly_agree:    ['Strongly Agree'],
  // Scale shortcuts — will use the field's actual low/high at runtime
  min:               ['__MIN__'],
  max:               ['__MAX__'],
  random:            ['__RANDOM__'],
};

// ── Parse "Field overrides:" block from context string ───────────────────────
// Supports both formats in the context text:
//   Field overrides: entry.123=strongly_disagree, entry.456=agree
//   Field overrides:
//     entry.123=strongly_disagree
//     entry.456=random
//
// Returns a map of { "entry.123456": "Strongly Disagree" } (resolved values)
function parseFieldOverrides(context: string): Record<string, string | '__MIN__' | '__MAX__' | '__RANDOM__'> {
  const overrides: Record<string, string> = {};

  // Find the "Field overrides:" section — grab everything after it
  const sectionMatch = context.match(/field\s+overrides\s*:([\s\S]*?)(?:\n\n|\n[A-Z]|$)/i);
  if (!sectionMatch) return overrides;

  const section = sectionMatch[1];

  // Match every entry.XXXXXXX=value pair in that section
  const pairRegex = /(entry\.\d+)\s*=\s*([a-z_]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pairRegex.exec(section)) !== null) {
    const entryId  = match[1].toLowerCase().replace('entry.', '');
    const keyword  = match[2].toLowerCase();
    const name     = `entry.${entryId}`;
    const resolved = OVERRIDE_VALUE_MAP[keyword];

    if (resolved) {
      overrides[name] = resolved[0]; // store the display string or sentinel
    } else {
      console.warn(`Unknown override keyword "${keyword}" for ${name} — skipping`);
    }
  }

  return overrides;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, fields, context, count, timeWindowHours, fbzx } = body;

    if (!formUrl || !fields || !count) {
      return NextResponse.json({ error: 'Missing required configuration parameters.' }, { status: 400 });
    }

    const groqKey     = process.env.GROQ_API_KEY;
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!groqKey || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys.' }, { status: 500 });
    }

    const seenNames = new Set<string>();
    const dedupedFields = (fields as any[]).filter((f: any) => {
      if (seenNames.has(f.name)) return false;
      seenNames.add(f.name);
      return true;
    });

    const groq = new Groq({ apiKey: groqKey });

    // ── Step 1: Parse hard overrides from context ─────────────────────────────────
    // These bypass the LLM entirely — 100% deterministic.
    const hardOverrides = parseFieldOverrides(context ?? '');
    console.log('Hard overrides parsed from context:', hardOverrides);

    // ── Step 2: LLM classification for everything else ────────────────────────────
    // Exclude hard-overridden fields from classification — no point asking the LLM
    // about fields we've already decided.
    const fieldsToClassify = dedupedFields.filter(
      (f: any) => !(f.name in hardOverrides)
    );

    const fieldTitleList = fieldsToClassify.map((f: any) => ({
      name:    f.name,
      title:   f.title,
      type:    f.type,
      options: f.options ?? [],
    }));

    const intentMap: Record<string, FieldIntent> = {};
    for (const f of dedupedFields) intentMap[f.name] = 'positive';
    let excludedOptions: string[] = [];

    if (fieldTitleList.length > 0) {
      const classifyPrompt = `
You are analyzing a survey form's context instructions to:
1. Classify how each field should be answered (intent).
2. Identify any specific option values that must NEVER be selected for any field.

Context instructions provided for this form:
"""
${context || ''}
"""

Here are the form fields to classify (fields with explicit overrides have been excluded):
${JSON.stringify(fieldTitleList, null, 2)}

TASK 1 — Intent classification:
For each field assign one of:
- "positive"  → positive/agree/high-value responses (default if unspecified)
- "negative"  → negative/disagree/low-value responses
- "random"    → varied, neutral, or randomly distributed

TASK 2 — Excluded options:
List any specific option strings that must NEVER be selected (e.g. "Prefer not to say").
Return empty array if none.

Return ONLY a raw JSON object in exactly this shape. No markdown, no explanation:
{
  "intents": {
    "entry.123456": "positive",
    "entry.789012": "negative"
  },
  "excludedOptions": ["Prefer not to say"]
}
`.trim();

      const classifyCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: classifyPrompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
      });

      let classifyContent = classifyCompletion.choices[0]?.message?.content ?? '{}';
      classifyContent = classifyContent.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        const parsed = JSON.parse(classifyContent);
        if (parsed.intents && typeof parsed.intents === 'object') {
          for (const [name, intent] of Object.entries(parsed.intents)) {
            if (['positive', 'negative', 'random'].includes(intent as string)) {
              intentMap[name] = intent as FieldIntent;
            }
          }
        }
        if (Array.isArray(parsed.excludedOptions)) {
          excludedOptions = parsed.excludedOptions.filter((o: any) => typeof o === 'string');
        }
      } catch {
        console.warn('Could not parse classification response, using defaults');
      }
    }

    console.log('Field intents from LLM:', intentMap);
    console.log('Excluded options:', excludedOptions);

    // ── Step 3: Strip excluded options from fields ────────────────────────────────
    const cleanedFields = dedupedFields.map((f: any) => {
      if (!Array.isArray(f.options) || excludedOptions.length === 0) return f;
      return {
        ...f,
        options: f.options.filter(
          (o: string) => !excludedOptions.some(
            ex => ex.toLowerCase().trim() === o.toLowerCase().trim()
          )
        ),
      };
    });

    // ── Step 4: Build field guide — skip hard-overridden fields ──────────────────
    const fieldGuide = cleanedFields
      .filter((f: any) => !(f.name in hardOverrides))
      .map((f: any) => {
        const intent: FieldIntent = intentMap[f.name] ?? 'positive';
        const label = intent.toUpperCase();

        let hint = '';
        switch (f.type) {
          case 'text':
            hint = intent === 'random' ? 'Short text answer. Vary across respondents.' : 'Short text answer.';
            break;
          case 'textarea':
            hint = intent === 'random' ? 'Paragraph answer. Vary across respondents.' : 'Longer paragraph answer.';
            break;
          case 'radio':
            hint = intent === 'negative'
              ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Disagree" or "Strongly Disagree".`
              : intent === 'random'
              ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: distribute randomly.`
              : `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Agree" or "Strongly Agree".`;
            break;
          case 'dropdown':
            hint = intent === 'random'
              ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. Distribute randomly.`
              : `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}.`;
            break;
          case 'checkbox':
            hint = intent === 'negative'
              ? `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick only negative options.`
              : intent === 'random'
              ? `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: vary randomly.`
              : `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick positive options.`;
            break;
          case 'linear_scale':
            hint = intent === 'negative'
              ? `Integer between ${f.low ?? 1} and ${f.high ?? 5}${f.lowLabel ? ` (${f.low}=${f.lowLabel})` : ''}${f.highLabel ? ` (${f.high}=${f.highLabel})` : ''}. IMPORTANT [${label}]: pick LOW value.`
              : intent === 'random'
              ? `Integer between ${f.low ?? 1} and ${f.high ?? 5}. IMPORTANT [${label}]: distribute randomly.`
              : `Integer between ${f.low ?? 1} and ${f.high ?? 5}${f.lowLabel ? ` (${f.low}=${f.lowLabel})` : ''}${f.highLabel ? ` (${f.high}=${f.highLabel})` : ''}. IMPORTANT [${label}]: pick HIGH value.`;
            break;
          case 'rating':
            hint = intent === 'negative'
              ? `Integer 1–${f.high ?? 5}. IMPORTANT [${label}]: pick 1 or 2.`
              : intent === 'random'
              ? `Integer 1–${f.high ?? 5}. IMPORTANT [${label}]: distribute randomly.`
              : `Integer 1–${f.high ?? 5}. IMPORTANT [${label}]: pick ${f.high ?? 5} or ${Number(f.high ?? 5) - 1}.`;
            break;
          case 'radio_grid':
            hint = intent === 'negative'
              ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: MUST pick "Strongly Disagree" or "Disagree".`
              : intent === 'random'
              ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: distribute randomly.`
              : `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Agree" or "Strongly Agree".`;
            break;
          case 'checkbox_grid':
            hint = intent === 'negative'
              ? `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick only "Strongly Disagree" or "Disagree".`
              : intent === 'random'
              ? `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: vary randomly.`
              : `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick positive options.`;
            break;
          case 'date':
            hint = 'Date string in YYYY-MM-DD format.';
            break;
          case 'time':
            hint = 'Time string in HH:MM (24-hour) format.';
            break;
          default:
            hint = 'Text answer.';
        }

        return { name: f.name, title: f.title, type: f.type, intent, hint };
      });

    const overrideLines = fieldGuide
      .filter(f => f.intent !== 'positive')
      .map(f => `  - "${f.name}" (${f.title}): ${f.intent.toUpperCase()}`);

    const overrideCallout = overrideLines.length > 0
      ? `\nFIELD OVERRIDES:\n` + overrideLines.join('\n') + '\n'
      : '';

    const excludedCallout = excludedOptions.length > 0
      ? `\nNEVER select these options for any field: ${JSON.stringify(excludedOptions)}\n`
      : '';

    // ── Step 5: Generate responses for non-overridden fields ──────────────────────
    const prompt = `
You are a realistic mock form-response generator.

Generate exactly ${count} diverse, realistic sets of form responses.

Persona / context for respondents: "${context || 'General realistic users'}"

Default: answer positively unless a field's hint says otherwise.
${overrideCallout}${excludedCallout}
Fields (follow each field's hint and intent exactly):
${JSON.stringify(fieldGuide, null, 2)}

Rules:
- Output ONLY a raw JSON array of ${count} objects — no markdown, no preamble.
- Each object's keys must exactly match the "name" values above.
- For checkbox / checkbox_grid the value must be a JSON array of strings.
- For radio_grid the value must be a plain string.
- For date use YYYY-MM-DD. For time use HH:MM (24-hour).
- For linear_scale / rating use a plain integer (string is fine).
- NEVER use any of these options: ${JSON.stringify(excludedOptions)}.
`.trim();

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.85,
    });

    let content = chatCompletion.choices[0]?.message?.content ?? '[]';
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    let generatedData: any[];
    try {
      generatedData = JSON.parse(content);
    } catch {
      console.error('Groq returned invalid JSON:', content);
      return NextResponse.json({ error: 'LLM returned invalid JSON.' }, { status: 500 });
    }

    if (!Array.isArray(generatedData)) {
      return NextResponse.json({ error: 'LLM did not return a JSON array.' }, { status: 500 });
    }

    // ── Step 6: Inject hard overrides + enforce negative fields ───────────────────

    const findMostNegative = (options: string[]): string | undefined =>
      options.find(o => /strongly.{0,5}disagree/i.test(o))
      ?? options.find(o => /disagree/i.test(o))
      ?? options.find(o => /never/i.test(o))
      ?? options[0];

    const findMostPositive = (options: string[]): string | undefined =>
      options.find(o => /strongly.{0,5}agree/i.test(o))
      ?? options.find(o => /agree/i.test(o))
      ?? options.find(o => /always/i.test(o))
      ?? options[options.length - 1];

    const isExcluded = (value: string) =>
      excludedOptions.some(ex => ex.toLowerCase().trim() === value.toLowerCase().trim());

    for (const row of generatedData) {

      // Inject hard overrides for every row — completely deterministic
      for (const [entryName, rawValue] of Object.entries(hardOverrides)) {
        const fieldMeta = cleanedFields.find((f: any) => f.name === entryName);
        const opts: string[] = fieldMeta?.options ?? [];
        const type: string   = fieldMeta?.type ?? '';
        let resolvedValue: string | string[];

        if (rawValue === '__MIN__') {
          resolvedValue = String(fieldMeta?.low ?? 1);
        } else if (rawValue === '__MAX__') {
          resolvedValue = String(fieldMeta?.high ?? 5);
        } else if (rawValue === '__RANDOM__') {
          const available = opts.filter(o => !isExcluded(o));
          resolvedValue = available.length > 0
            ? available[Math.floor(Math.random() * available.length)]
            : opts[0] ?? '';
        } else {
          // Find the closest matching option in the field's actual options list
          // so casing differences between "Strongly Disagree" vs "strongly disagree" don't matter
          const matched = opts.find(o => o.toLowerCase().trim() === rawValue.toLowerCase().trim());
          resolvedValue = matched ?? rawValue;
        }

        // Apply as array for checkbox types, string for everything else
        if (type === 'checkbox' || type === 'checkbox_grid') {
          row[entryName] = Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue];
        } else {
          row[entryName] = Array.isArray(resolvedValue) ? resolvedValue[0] : resolvedValue;
        }
      }

      // LLM-classified negative fields — enforce via post-processing
      for (const field of fieldGuide) {
        if (field.intent !== 'negative') continue;
        const key = field.name;
        if (!(key in row)) continue;

        const opts: string[] = cleanedFields.find((f: any) => f.name === key)?.options ?? [];

        if (field.type === 'radio_grid' || field.type === 'radio') {
          const negOpt = findMostNegative(opts);
          if (negOpt) row[key] = negOpt;
        } else if (field.type === 'checkbox_grid' || field.type === 'checkbox') {
          const negOpt = findMostNegative(opts);
          if (negOpt) row[key] = [negOpt];
        } else if (field.type === 'linear_scale' || field.type === 'rating') {
          row[key] = String(cleanedFields.find((f: any) => f.name === key)?.low ?? 1);
        }
      }

      // Remove any excluded options that slipped through
      for (const field of fieldGuide) {
        const key = field.name;
        if (!(key in row)) continue;
        const opts: string[] = cleanedFields.find((f: any) => f.name === key)?.options ?? [];

        const currentValue = row[key];
        if (typeof currentValue === 'string' && isExcluded(currentValue)) {
          const available = opts.filter(o => !isExcluded(o));
          row[key] = field.intent === 'random'
            ? available[Math.floor(Math.random() * available.length)] ?? currentValue
            : findMostPositive(available) ?? available[0] ?? currentValue;
        }
        if (Array.isArray(currentValue)) {
          row[key] = currentValue.filter((v: string) => !isExcluded(v));
          if (row[key].length === 0) {
            const available = opts.filter(o => !isExcluded(o));
            if (available.length > 0) row[key] = [available[0]];
          }
        }
      }
    }

    // ── Step 7: Schedule via QStash ───────────────────────────────────────────────

    const protocol  = req.headers.get('x-forwarded-proto') ?? 'https';
    const host      = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;

    const qstash = new Client({ token: qstashToken });
    const maxDelayMinutes = (timeWindowHours ?? 0) * 60;

    const promises = generatedData.map((mockData) => {
      const delayMinutes = maxDelayMinutes > 0
        ? Math.floor(Math.random() * maxDelayMinutes)
        : 0;

      const payload: any = {
        url: submitUrl,
        body: {
          formUrl,
          data: mockData,
          fbzx,
          fields: dedupedFields,
        },
      };

      if (delayMinutes > 0) payload.delay = `${delayMinutes}m`;
      return qstash.publishJSON(payload);
    });

    const chunkSize = 10;
    for (let i = 0; i < promises.length; i += chunkSize) {
      await Promise.all(promises.slice(i, i + chunkSize));
    }

    return NextResponse.json({
      success: true,
      message: `Successfully generated and scheduled ${generatedData.length} responses.`,
      scheduledCount: generatedData.length,
    });

  } catch (error: any) {
    console.error('Error in generate-and-schedule:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}