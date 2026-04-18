import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { Client } from '@upstash/qstash';

type FieldIntent = 'positive' | 'negative' | 'random';

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

    // ── Step 1: Single LLM call — classify intents AND detect excluded options ────
    // Combining both tasks into one call saves a round-trip and gives the model
    // full context to make both decisions together.

    const fieldTitleList = dedupedFields.map((f: any) => ({
      name:    f.name,
      title:   f.title,
      type:    f.type,
      options: f.options ?? [],
    }));

    const classifyPrompt = `
You are analyzing a survey form's context instructions to:
1. Classify how each field should be answered (intent).
2. Identify any specific option values that must NEVER be selected for any field.

Context instructions provided for this form:
"""
${context || ''}
"""

Here are all the form fields with their available options:
${JSON.stringify(fieldTitleList, null, 2)}

TASK 1 — Intent classification:
For each field assign one of:
- "positive"  → should receive positive/agree/high-value responses (default if unspecified)
- "negative"  → should receive negative/disagree/low-value responses
- "random"    → should be varied, neutral, or randomly distributed

TASK 2 — Excluded options:
List any specific option strings that must NEVER be selected across ANY field.
Examples: "Prefer not to say", "Not applicable", "Other", etc.
Only include options that the context explicitly says to avoid.
If none, return an empty array.

IMPORTANT matching rule for TASK 1:
- Grid questions have titles like "Section Name → Row statement".
- Match the row statement part against the context description, not the full title.
- If the context says to answer negatively for a statement, find ALL grid rows whose 
  row text semantically matches that statement, even if phrased slightly differently.

Return ONLY a raw JSON object in exactly this shape. No markdown, no explanation:
{
  "intents": {
    "entry.123456": "positive",
    "entry.789012": "negative",
    "entry.345678": "random"
  },
  "excludedOptions": ["Prefer not to say", "Not applicable"]
}
`.trim();

    const classifyCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: classifyPrompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });

    let classifyContent = classifyCompletion.choices[0]?.message?.content ?? '{}';
    classifyContent = classifyContent.replace(/```json/g, '').replace(/```/g, '').trim();

    // Defaults
    const intentMap: Record<string, FieldIntent> = {};
    for (const f of dedupedFields) intentMap[f.name] = 'positive';
    let excludedOptions: string[] = [];

    try {
      const parsed = JSON.parse(classifyContent);

      // Apply intents
      if (parsed.intents && typeof parsed.intents === 'object') {
        for (const [name, intent] of Object.entries(parsed.intents)) {
          if (['positive', 'negative', 'random'].includes(intent as string)) {
            intentMap[name] = intent as FieldIntent;
          }
        }
      }

      // Apply excluded options
      if (Array.isArray(parsed.excludedOptions)) {
        excludedOptions = parsed.excludedOptions.filter((o: any) => typeof o === 'string');
      }
    } catch {
      console.warn('Could not parse classification response, using defaults:', classifyContent);
    }

    console.log('Field intents:', intentMap);
    console.log('Excluded options:', excludedOptions);

    // ── Step 2: Strip excluded options from every field's available options ────────
    // This ensures the LLM never even sees "Prefer not to say" as a valid choice,
    // and the post-processing enforcer also never picks it.

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

    // ── Step 3: Build per-field hints ─────────────────────────────────────────────

    const fieldGuide = cleanedFields.map((f: any) => {
      const intent: FieldIntent = intentMap[f.name] ?? 'positive';
      const label = intent.toUpperCase();

      let hint = '';
      switch (f.type) {
        case 'text':
          hint = intent === 'random'
            ? 'Short text answer. Vary across respondents.'
            : 'Short text answer.';
          break;

        case 'textarea':
          hint = intent === 'random'
            ? 'Paragraph answer. Vary sentiment and length across respondents.'
            : 'Longer paragraph answer.';
          break;

        case 'radio':
          if (intent === 'negative') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Disagree" or "Strongly Disagree".`;
          } else if (intent === 'random') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: distribute randomly — do not favour any option.`;
          } else {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Agree" or "Strongly Agree".`;
          }
          break;

        case 'dropdown':
          hint = intent === 'random'
            ? `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. Distribute randomly.`
            : `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}.`;
          break;

        case 'checkbox':
          if (intent === 'negative') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick only negative options.`;
          } else if (intent === 'random') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: vary randomly.`;
          } else {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick positive options.`;
          }
          break;

        case 'linear_scale':
          if (intent === 'negative') {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${label}]: pick a LOW value (${f.low ?? 1} or ${Number(f.low ?? 1) + 1}).`;
          } else if (intent === 'random') {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${label}]: distribute randomly across the full range.`;
          } else {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${label}]: pick a HIGH value (${f.high ?? 5} or ${Number(f.high ?? 5) - 1}).`;
          }
          break;

        case 'rating':
          if (intent === 'negative') {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${label}]: pick 1 or 2.`;
          } else if (intent === 'random') {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${label}]: distribute randomly.`;
          } else {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${label}]: pick ${f.high ?? 5} or ${Number(f.high ?? 5) - 1}.`;
          }
          break;

        case 'radio_grid':
          if (intent === 'negative') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: MUST pick "Strongly Disagree" or "Disagree". Never pick Agree or Strongly Agree.`;
          } else if (intent === 'random') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: distribute randomly.`;
          } else {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${label}]: pick "Agree" or "Strongly Agree".`;
          }
          break;

        case 'checkbox_grid':
          if (intent === 'negative') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick only "Strongly Disagree" or "Disagree".`;
          } else if (intent === 'random') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: vary randomly.`;
          } else {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${label}]: pick positive options.`;
          }
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
      ? `\nNEVER select these options for any field under any circumstances: ${JSON.stringify(excludedOptions)}\n`
      : '';

    // ── Step 4: Generate responses ────────────────────────────────────────────────

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
- Respect every [POSITIVE], [NEGATIVE], [RANDOM] label exactly.
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
      return NextResponse.json({ error: 'LLM returned invalid JSON. Try fewer responses or a simpler context.' }, { status: 500 });
    }

    if (!Array.isArray(generatedData)) {
      return NextResponse.json({ error: 'LLM did not return a JSON array.' }, { status: 500 });
    }

    // ── Step 5: Post-processing enforcement ───────────────────────────────────────

    const findMostNegative = (options: string[]): string | undefined =>
      options.find(o => /strongly.{0,5}disagree/i.test(o))
      ?? options.find(o => /disagree/i.test(o))
      ?? options.find(o => /never/i.test(o))
      ?? options.find(o => /poor/i.test(o))
      ?? options[0];

    const findMostPositive = (options: string[]): string | undefined =>
      options.find(o => /strongly.{0,5}agree/i.test(o))
      ?? options.find(o => /agree/i.test(o))
      ?? options.find(o => /always/i.test(o))
      ?? options[options.length - 1];

    const isExcluded = (value: string) =>
      excludedOptions.some(ex => ex.toLowerCase().trim() === value.toLowerCase().trim());

    for (const row of generatedData) {
      for (const field of fieldGuide) {
        const key = field.name;
        if (!(key in row)) continue;

        const originalField = cleanedFields.find((f: any) => f.name === key);
        const opts: string[] = originalField?.options ?? [];

        // Hard-enforce negative fields
        if (field.intent === 'negative') {
          if (field.type === 'radio_grid' || field.type === 'radio') {
            const negOpt = findMostNegative(opts);
            if (negOpt) row[key] = negOpt;
          } else if (field.type === 'checkbox_grid' || field.type === 'checkbox') {
            const negOpt = findMostNegative(opts);
            if (negOpt) row[key] = [negOpt];
          } else if (field.type === 'linear_scale' || field.type === 'rating') {
            row[key] = String(originalField?.low ?? 1);
          }
          continue;
        }

        // For all fields: replace any excluded option with the appropriate fallback
        const currentValue = row[key];
        if (typeof currentValue === 'string' && isExcluded(currentValue)) {
          if (field.intent === 'random') {
            // Pick any non-excluded option randomly
            const available = opts.filter(o => !isExcluded(o));
            if (available.length > 0) {
              row[key] = available[Math.floor(Math.random() * available.length)];
            }
          } else {
            // Positive — pick the most positive non-excluded option
            const available = opts.filter(o => !isExcluded(o));
            row[key] = findMostPositive(available) ?? available[0] ?? currentValue;
          }
        }

        // Same for array values (checkbox / checkbox_grid)
        if (Array.isArray(currentValue)) {
          row[key] = currentValue.filter((v: string) => !isExcluded(v));
          if (row[key].length === 0) {
            const available = opts.filter(o => !isExcluded(o));
            if (available.length > 0) row[key] = [available[0]];
          }
        }
      }
    }

    // ── Step 6: Schedule via QStash ───────────────────────────────────────────────

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