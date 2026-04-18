import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { Client } from '@upstash/qstash';

type FieldIntent = 'positive' | 'negative' | 'random';

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

    const githubToken = process.env.GITHUB_TOKEN;
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!githubToken || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys (GITHUB_TOKEN or QSTASH_TOKEN).' }, { status: 500 });
    }

    const client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: githubToken,
    });

    const seenNames = new Set<string>();
    const dedupedFields = (fields as any[]).filter((f: any) => {
      if (seenNames.has(f.name)) return false;
      seenNames.add(f.name);
      return true;
    });

    const hardOverrides = parseFieldOverrides(context ?? '');
    const fieldsToClassify = dedupedFields.filter((f: any) => !(f.name in hardOverrides));

    const fieldTitleList = fieldsToClassify.map((f: any) => ({
      name:    f.name,
      title:   f.title,
      type:    f.type,
      options: f.options ?? [],
    }));

    const intentMap: Record<string, FieldIntent> = {};
    for (const f of dedupedFields) intentMap[f.name] = 'positive';
    let excludedOptions: string[] = [];

    // ── Step 1: LLM classification for intent ──────────────────────────────────
    if (fieldTitleList.length > 0) {
      const classifyPrompt = `
        Analyze this survey context: "${context || ''}"
        Fields: ${JSON.stringify(fieldTitleList)}
        
        TASK:
        1. Assign intent ("positive", "negative", or "random") for each field.
        2. List strings to NEVER select (e.g. "None", "N/A").
        
        Return ONLY raw JSON:
        { "intents": { "entry.123": "positive" }, "excludedOptions": [] }
      `.trim();

      const classifyCompletion = await client.chat.completions.create({
        messages: [{ role: 'user', content: classifyPrompt }],
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" }
      });

      const parsed = JSON.parse(classifyCompletion.choices[0]?.message?.content ?? '{}');
      if (parsed.intents) {
        Object.entries(parsed.intents).forEach(([name, intent]) => {
          if (['positive', 'negative', 'random'].includes(intent as string)) intentMap[name] = intent as FieldIntent;
        });
      }
      excludedOptions = Array.isArray(parsed.excludedOptions) ? parsed.excludedOptions : [];
    }

    // ── Step 2: Build Field Guide ─────────────────────────────────────────────
    const cleanedFields = dedupedFields.map((f: any) => ({
      ...f,
      options: Array.isArray(f.options) ? f.options.filter((o: string) => !excludedOptions.includes(o)) : f.options
    }));

    const fieldGuide = cleanedFields
      .filter((f: any) => !(f.name in hardOverrides))
      .map((f: any) => {
        const intent = intentMap[f.name] ?? 'positive';
        return { name: f.name, title: f.title, type: f.type, intent, options: f.options };
      });

    // ── Step 3: Generate Mock Responses ───────────────────────────────────────
    const genPrompt = `
      Generate exactly ${count} realistic form responses.
      Context: "${context || 'General'}"
      Fields Logic: ${JSON.stringify(fieldGuide)}
      Excluded: ${JSON.stringify(excludedOptions)}

      Rules:
      - Return ONLY a JSON array of ${count} objects.
      - Keys must be field "name".
      - checkbox/checkbox_grid must be string arrays.
      - date: YYYY-MM-DD, time: HH:MM.
    `.trim();

    const genCompletion = await client.chat.completions.create({
      messages: [{ role: 'user', content: genPrompt }],
      model: "gpt-4o",
      temperature: 0.8,
      response_format: { type: "json_object" }
    });

    const content = genCompletion.choices[0]?.message?.content ?? '{"data": []}';
    let generatedData = JSON.parse(content);
    // Handle both { "data": [...] } and [...] responses
    if (!Array.isArray(generatedData) && generatedData.data) generatedData = generatedData.data;

    // ── Step 4: Inject Overrides & Post-Process ───────────────────────────────
    const findOpt = (opts: string[], regex: RegExp) => opts.find(o => regex.test(o)) || opts[0];

    for (const row of generatedData) {
      // Hard Overrides
      for (const [name, rawValue] of Object.entries(hardOverrides)) {
        const meta = cleanedFields.find((f: any) => f.name === name);
        const opts = meta?.options ?? [];
        let val: any = rawValue;

        if (rawValue === '__MIN__') val = String(meta?.low ?? 1);
        else if (rawValue === '__MAX__') val = String(meta?.high ?? 5);
        else if (rawValue === '__RANDOM__') val = opts[Math.floor(Math.random() * opts.length)];
        
        row[name] = (meta?.type === 'checkbox' || meta?.type === 'checkbox_grid') ? [val] : val;
      }

      // Enforce Intent Logic (Fallback)
      fieldGuide.forEach(f => {
        if (f.intent === 'negative' && row[f.name]) {
          const opts = f.options || [];
          if (['radio', 'radio_grid', 'dropdown'].includes(f.type)) row[f.name] = findOpt(opts, /disagree|negative|never/i);
          if (['linear_scale', 'rating'].includes(f.type)) row[f.name] = String(f.low ?? 1);
        }
      });
    }

    // ── Step 5: Schedule via QStash ──────────────────────────────────────────
    const qstash = new Client({ token: qstashToken });
    const protocol = req.headers.get('x-forwarded-proto') ?? 'https';
    const host = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;
    const maxDelay = (timeWindowHours ?? 0) * 60;

    const promises = generatedData.map((data: any) => {
      const delay = maxDelay > 0 ? Math.floor(Math.random() * maxDelay) : 0;
      return qstash.publishJSON({
        url: submitUrl,
        body: { formUrl, data, fbzx, fields: dedupedFields },
        delay: delay > 0 ? `${delay}m` : undefined,
      });
    });

    for (let i = 0; i < promises.length; i += 10) {
      await Promise.all(promises.slice(i, i + 10));
    }

    return NextResponse.json({ success: true, count: generatedData.length });

  } catch (error: any) {
    console.error('Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}