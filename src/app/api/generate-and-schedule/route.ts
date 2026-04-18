import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { Client } from '@upstash/qstash';

// Intent assigned to each field based on context instructions
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

    // ── Step 1: Classify every field into positive / negative / random ────────────
    // The LLM reads the context and assigns an intent to each field based solely
    // on what the context says. No hardcoding — works for any form, any context.
    //
    // Examples of context phrases that drive classification:
    //   → "Agree / Strongly Agree for most items"          = positive (default)
    //   → "Disagree / Strongly Disagree for X"             = negative
    //   → "randomly distributed for section Y"             = random
    //   → "neutral responses for the pricing questions"    = random
    //   → "vary responses for demographic fields"          = random
    //   → "always select 5 for the satisfaction question"  = positive (forced)

    const fieldTitleList = dedupedFields.map((f: any) => ({
      name:  f.name,
      title: f.title,
      type:  f.type,
    }));

    const classifyPrompt = `
You are analyzing a survey form's context instructions to classify how each field should be answered.

Context instructions provided for this form:
"""
${context || ''}
"""

Here are all the form fields:
${JSON.stringify(fieldTitleList, null, 2)}

For each field, assign one of these intents based strictly on what the context says:
- "positive"  → should receive positive/agree/high-value responses
- "negative"  → should receive negative/disagree/low-value responses
- "random"    → should be varied, neutral, or randomly distributed

Rules:
- If the context gives no specific instruction for a field, default to "positive".
- If the context says responses should be randomized, varied, or neutral for a section or field, use "random".
- If the context says a field should receive disagree/negative/low responses, use "negative".
- If the context says a field should receive agree/positive/high responses explicitly, use "positive".

Return ONLY a raw JSON object mapping each field's "name" to its intent. No markdown, no explanation.

Example output:
{
  "entry.123456": "positive",
  "entry.789012": "negative",
  "entry.345678": "random"
}
`.trim();

    const classifyCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: classifyPrompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });

    let classifyContent = classifyCompletion.choices[0]?.message?.content ?? '{}';
    classifyContent = classifyContent.replace(/```json/g, '').replace(/```/g, '').trim();

    // Build intent map — default everything to 'positive' if parsing fails
    const intentMap: Record<string, FieldIntent> = {};
    for (const f of dedupedFields) intentMap[f.name] = 'positive';

    try {
      const parsed = JSON.parse(classifyContent);
      for (const [name, intent] of Object.entries(parsed)) {
        if (['positive', 'negative', 'random'].includes(intent as string)) {
          intentMap[name] = intent as FieldIntent;
        }
      }
    } catch {
      console.warn('Could not parse field classification, defaulting all to positive:', classifyContent);
    }

    console.log('Field intents identified from context:', intentMap);

    // ── Step 2: Build per-field hints driven by intent ────────────────────────────

    const fieldGuide = dedupedFields.map((f: any) => {
      const intent: FieldIntent = intentMap[f.name] ?? 'positive';

      const intentLabel = {
        positive: 'POSITIVE',
        negative: 'NEGATIVE',
        random:   'RANDOM',
      }[intent];

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
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: pick "Disagree" or "Strongly Disagree".`;
          } else if (intent === 'random') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: distribute randomly across all options — do not favour any particular option.`;
          } else {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: pick "Agree" or "Strongly Agree".`;
          }
          break;

        case 'dropdown':
          if (intent === 'random') {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}. Distribute randomly.`;
          } else {
            hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}.`;
          }
          break;

        case 'checkbox':
          if (intent === 'negative') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: pick only negative options like "Disagree" or "Strongly Disagree".`;
          } else if (intent === 'random') {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: vary selections randomly across respondents.`;
          } else {
            hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: pick positive options.`;
          }
          break;

        case 'linear_scale':
          if (intent === 'negative') {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${intentLabel}]: pick a LOW value (${f.low ?? 1} or ${Number(f.low ?? 1) + 1}).`;
          } else if (intent === 'random') {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${intentLabel}]: distribute randomly across the full range.`;
          } else {
            hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}`
                 + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})`  : '')
                 + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '')
                 + `. IMPORTANT [${intentLabel}]: pick a HIGH value (${f.high ?? 5} or ${Number(f.high ?? 5) - 1}).`;
          }
          break;

        case 'rating':
          if (intent === 'negative') {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${intentLabel}]: pick 1 or 2.`;
          } else if (intent === 'random') {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${intentLabel}]: distribute randomly across all values.`;
          } else {
            hint = `Integer between 1 and ${f.high ?? 5}. IMPORTANT [${intentLabel}]: pick ${f.high ?? 5} or ${Number(f.high ?? 5) - 1}.`;
          }
          break;

        case 'radio_grid':
          if (intent === 'negative') {
            hint = `Pick exactly ONE column value from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: MUST pick "Disagree" or "Strongly Disagree". Never pick Agree or Strongly Agree.`;
          } else if (intent === 'random') {
            hint = `Pick exactly ONE column value from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: distribute randomly — vary across all options.`;
          } else {
            hint = `Pick exactly ONE column value from: ${JSON.stringify(f.options ?? [])}. IMPORTANT [${intentLabel}]: pick "Agree" or "Strongly Agree".`;
          }
          break;

        case 'checkbox_grid':
          if (intent === 'negative') {
            hint = `Pick one OR MORE column values from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: pick only "Disagree" or "Strongly Disagree".`;
          } else if (intent === 'random') {
            hint = `Pick one OR MORE column values from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: vary selections randomly.`;
          } else {
            hint = `Pick one OR MORE column values from: ${JSON.stringify(f.options ?? [])}. Return as JSON array. IMPORTANT [${intentLabel}]: pick positive options.`;
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

      return {
        name:   f.name,
        title:  f.title,
        type:   f.type,
        intent,
        hint,
      };
    });

    // Build the overrides callout for the prompt
    const overrideLines = fieldGuide
      .filter(f => f.intent !== 'positive') // positive is default, no need to call out
      .map(f => `  - "${f.name}" (${f.title}): ${f.intent.toUpperCase()} — ${
        f.intent === 'negative'
          ? 'must pick disagree/low-value option'
          : 'must be randomly distributed, do not favour any direction'
      }`);

    const overrideCallout = overrideLines.length > 0
      ? `\nFIELD OVERRIDES — these deviate from the default positive weighting:\n`
        + overrideLines.join('\n') + '\n'
      : '';

    // ── Step 3: Generate responses ────────────────────────────────────────────────

    const prompt = `
You are a realistic mock form-response generator.

Generate exactly ${count} diverse, realistic sets of form responses.

Persona / context for respondents: "${context || 'General realistic users'}"

Default behaviour: answer positively ("Agree" / "Strongly Agree" or high scale values) unless a field's hint says otherwise.
${overrideCallout}
Fields (follow the hint and intent for each field exactly):
${JSON.stringify(fieldGuide, null, 2)}

Rules:
- Output ONLY a raw JSON array of ${count} objects — no markdown, no preamble.
- Each object's keys must exactly match the "name" values above.
- For checkbox / checkbox_grid the value must be a JSON array of strings.
- For radio_grid the value must be a plain string.
- For date fields use YYYY-MM-DD. For time fields use HH:MM (24-hour).
- For linear_scale / rating use a plain integer (string is also fine).
- Respect every field's [POSITIVE], [NEGATIVE], or [RANDOM] label exactly.
- For [RANDOM] fields, genuinely vary the answers — do not default to any single option.
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

    // ── Step 4: Post-processing enforcement for negative fields only ──────────────
    // Random fields are left as-is (that's the point).
    // Positive fields are left as-is (LLM handles them).
    // Only negative fields are hard-enforced.

    const findMostNegative = (options: string[]): string | undefined =>
      options.find(o => /strongly.{0,5}disagree/i.test(o))
      ?? options.find(o => /disagree/i.test(o))
      ?? options.find(o => /never/i.test(o))
      ?? options.find(o => /poor/i.test(o))
      ?? options[0];

    for (const row of generatedData) {
      for (const field of fieldGuide) {
        if (field.intent !== 'negative') continue;
        const key = field.name;
        if (!(key in row)) continue;

        const opts: string[] = (dedupedFields.find((f: any) => f.name === key) as any)?.options ?? [];

        if (field.type === 'radio_grid' || field.type === 'radio') {
          const negOpt = findMostNegative(opts);
          if (negOpt) row[key] = negOpt;

        } else if (field.type === 'checkbox_grid' || field.type === 'checkbox') {
          const negOpt = findMostNegative(opts);
          if (negOpt) row[key] = [negOpt];

        } else if (field.type === 'linear_scale' || field.type === 'rating') {
          row[key] = String((dedupedFields.find((f: any) => f.name === key) as any)?.low ?? 1);
        }
      }
    }

    // ── Step 5: Schedule via QStash ───────────────────────────────────────────────

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