import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { Client } from '@upstash/qstash';

type FieldIntent = 'positive' | 'negative' | 'random';

// ── Supported override values and what they resolve to ───────────────────────
const OVERRIDE_VALUE_MAP: Record<string, string[]> = {
  strongly_disagree: ['Strongly Disagree'],
  disagree:          ['Disagree'],
  neutral:           ['Neutral'],
  agree:             ['Agree'],
  strongly_agree:    ['Strongly Agree'],
  min:               ['__MIN__'],
  max:               ['__MAX__'],
  random:            ['__RANDOM__'],
};

// ── Parse "Field overrides:" block from context string ───────────────────────
function parseFieldOverrides(context: string): Record<string, string | '__MIN__' | '__MAX__' | '__RANDOM__'> {
  const overrides: Record<string, string> = {};
  const sectionMatch = context.match(/field\s+overrides\s*:([\s\S]*?)(?:\n\n|\n[A-Z]|$)/i);
  if (!sectionMatch) return overrides;

  const section = sectionMatch[1];
  const pairRegex = /(entry\.\d+)\s*=\s*([a-z_]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pairRegex.exec(section)) !== null) {
    const entryId  = match[1].toLowerCase().replace('entry.', '');
    const keyword  = match[2].toLowerCase();
    const name     = `entry.${entryId}`;
    const resolved = OVERRIDE_VALUE_MAP[keyword];

    if (resolved) {
      overrides[name] = resolved[0];
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

    // GitHub Models uses a GitHub PAT as the API Key
    const githubToken = process.env.GITHUB_TOKEN;
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!githubToken || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys (GITHUB_TOKEN or QSTASH_TOKEN).' }, { status: 500 });
    }

    const seenNames = new Set<string>();
    const dedupedFields = (fields as any[]).filter((f: any) => {
      if (seenNames.has(f.name)) return false;
      seenNames.add(f.name);
      return true;
    });

    // Initialize GitHub Models Client
    const githubModels = new OpenAI({
      apiKey: githubToken,
      baseURL: "https://models.inference.ai.azure.com",
    });

    // ── Step 1: Parse hard overrides ─────────────────────────────────────────────
    const hardOverrides = parseFieldOverrides(context ?? '');

    // ── Step 2: LLM classification for everything else ────────────────────────────
    const fieldsToClassify = dedupedFields.filter(f => !(f.name in hardOverrides));
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

Context: "${context || ''}"
Fields: ${JSON.stringify(fieldTitleList, null, 2)}

Return ONLY a raw JSON object:
{
  "intents": { "entry.123": "positive" | "negative" | "random" },
  "excludedOptions": ["string"]
}
`.trim();

      const classifyCompletion = await githubModels.chat.completions.create({
        messages: [{ role: 'user', content: classifyPrompt }],
        model: 'gpt-4o', // You can also use 'meta-llama-3-70b-instruct'
        temperature: 0,
      });

      let classifyContent = classifyCompletion.choices[0]?.message?.content ?? '{}';
      classifyContent = classifyContent.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        const parsed = JSON.parse(classifyContent);
        if (parsed.intents) {
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
        console.warn('Could not parse classification response');
      }
    }

    // ── Step 3: Strip excluded options ────────────────────────────────────────────
    const cleanedFields = dedupedFields.map((f: any) => {
      if (!Array.isArray(f.options) || excludedOptions.length === 0) return f;
      return {
        ...f,
        options: f.options.filter(
          (o: string) => !excludedOptions.some(ex => ex.toLowerCase().trim() === o.toLowerCase().trim())
        ),
      };
    });

    // ── Step 4: Build field guide ────────────────────────────────────────────────
    const fieldGuide = cleanedFields
      .filter((f: any) => !(f.name in hardOverrides))
      .map((f: any) => {
        const intent: FieldIntent = intentMap[f.name] ?? 'positive';
        let hint = '';
        // ... (Keep your existing switch case logic for 'hint' generation here)
        switch (f.type) {
            case 'text': hint = 'Short text.'; break;
            case 'radio': hint = `Pick ONE from ${JSON.stringify(f.options)}. Intent: ${intent}`; break;
            case 'linear_scale': hint = `Value ${f.low}-${f.high}. Intent: ${intent}`; break;
            default: hint = 'Generic answer.';
        }
        return { name: f.name, title: f.title, type: f.type, intent, hint };
      });

    // ── Step 5: Generate responses ────────────────────────────────────────────────
    const prompt = `
Generate exactly ${count} diverse, realistic sets of form responses as a JSON array.
Persona: "${context || 'General users'}"
Fields: ${JSON.stringify(fieldGuide, null, 2)}
Never use: ${JSON.stringify(excludedOptions)}
Return ONLY the raw JSON array.
`.trim();

    const chatCompletion = await githubModels.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o',
      temperature: 0.85,
    });

    let content = chatCompletion.choices[0]?.message?.content ?? '[]';
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    let generatedData = JSON.parse(content);

    // ── Step 6: Inject hard overrides + Post-processing ───────────────────────────
    const findMostNegative = (options: string[]) => options.find(o => /disagree|never/i.test(o)) ?? options[0];
    const findMostPositive = (options: string[]) => options.find(o => /agree|always/i.test(o)) ?? options[options.length - 1];
    const isExcluded = (val: string) => excludedOptions.some(ex => ex.toLowerCase().trim() === val.toLowerCase().trim());

    for (const row of generatedData) {
      // Apply deterministic overrides
      for (const [entryName, rawValue] of Object.entries(hardOverrides)) {
        const fieldMeta = cleanedFields.find((f: any) => f.name === entryName);
        const opts = fieldMeta?.options ?? [];
        if (rawValue === '__MIN__') row[entryName] = String(fieldMeta?.low ?? 1);
        else if (rawValue === '__MAX__') row[entryName] = String(fieldMeta?.high ?? 5);
        else row[entryName] = opts.find(o => o.toLowerCase().trim() === rawValue.toLowerCase().trim()) ?? rawValue;
      }

      // Enforce negative intent post-process
      for (const field of fieldGuide) {
        if (field.intent !== 'negative') continue;
        const opts = cleanedFields.find((f: any) => f.name === field.name)?.options ?? [];
        if (['radio', 'radio_grid'].includes(field.type)) row[field.name] = findMostNegative(opts);
      }
    }

    // ── Step 7: Schedule via QStash ───────────────────────────────────────────────
    const protocol  = req.headers.get('x-forwarded-proto') ?? 'https';
    const host      = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;
    const qstash = new Client({ token: qstashToken });
    const maxDelayMinutes = (timeWindowHours ?? 0) * 60;

    const promises = generatedData.map((mockData: any) => {
      const delayMinutes = maxDelayMinutes > 0 ? Math.floor(Math.random() * maxDelayMinutes) : 0;
      const payload: any = {
        url: submitUrl,
        body: { formUrl, data: mockData, fbzx, fields: dedupedFields },
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
      message: `Scheduled ${generatedData.length} responses via GitHub Models.`,
    });

  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
