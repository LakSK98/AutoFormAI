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
    if (resolved) overrides[name] = resolved[0];
  }
  return overrides;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, fields, context, count, timeWindowHours, fbzx } = body;

    if (!formUrl || !fields || !count) {
      return NextResponse.json({ error: 'Missing required parameters.' }, { status: 400 });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!githubToken || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys.' }, { status: 500 });
    }

    const client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: githubToken,
    });

    const seenNames = new Set<string>();
    const dedupedFields = (fields as any[]).filter((f: any) => !seenNames.has(f.name) && seenNames.add(f.name));
    const hardOverrides = parseFieldOverrides(context ?? '');
    
    // Step 1: Classification
    let intentMap: Record<string, FieldIntent> = {};
    let excludedOptions: string[] = [];

    const fieldTitleList = dedupedFields
      .filter(f => !(f.name in hardOverrides))
      .map(f => ({ name: f.name, title: f.title, type: f.type, options: f.options ?? [] }));

    if (fieldTitleList.length > 0) {
      const classifyCompletion = await client.chat.completions.create({
        messages: [{ role: 'user', content: `Context: ${context}\nFields: ${JSON.stringify(fieldTitleList)}\nReturn JSON with "intents" (entry.id: positive/negative/random) and "excludedOptions" (string array).` }],
        model: "gpt-4o",
        response_format: { type: "json_object" }
      });

      const parsed = JSON.parse(classifyCompletion.choices[0]?.message?.content ?? '{}');
      intentMap = parsed.intents || {};
      excludedOptions = Array.isArray(parsed.excludedOptions) ? parsed.excludedOptions : [];
    }

    // Step 2: Generation
    const fieldGuide = dedupedFields
      .filter(f => !(f.name in hardOverrides))
      .map(f => ({ name: f.name, title: f.title, type: f.type, intent: intentMap[f.name] || 'positive', options: f.options }));

    const genCompletion = await client.chat.completions.create({
      messages: [{ role: 'user', content: `Generate ${count} responses for: ${JSON.stringify(fieldGuide)}. Exclude: ${JSON.stringify(excludedOptions)}. Return JSON object with a "responses" key containing the array.` }],
      model: "gpt-4o",
      response_format: { type: "json_object" }
    });

    const rawContent = JSON.parse(genCompletion.choices[0]?.message?.content ?? '{}');
    // FIX: Handle different LLM output structures to prevent "not iterable"
    let generatedData = Array.isArray(rawContent) ? rawContent : (rawContent.responses || rawContent.data || []);

    if (!Array.isArray(generatedData)) {
        throw new Error("LLM failed to return an array of responses.");
    }

    // Step 3: Post-processing
    const processedData = generatedData.map((row: any) => {
      // Inject Hard Overrides
      for (const [name, rawValue] of Object.entries(hardOverrides)) {
        const meta = dedupedFields.find(f => f.name === name);
        let val: any = rawValue;
        if (rawValue === '__MIN__') val = String(meta?.low ?? 1);
        else if (rawValue === '__MAX__') val = String(meta?.high ?? 5);
        else if (rawValue === '__RANDOM__' && meta?.options) val = meta.options[Math.floor(Math.random() * meta.options.length)];
        
        row[name] = (meta?.type === 'checkbox' || meta?.type === 'checkbox_grid') ? [val] : val;
      }
      return row;
    });

    // Step 4: QStash Scheduling
    const qstash = new Client({ token: qstashToken });
    const host = req.headers.get('host');
    const submitUrl = `https://${host}/api/submit`;
    const maxDelay = (timeWindowHours ?? 0) * 60;

    const promises = processedData.map((data: any) => {
      const delay = maxDelay > 0 ? Math.floor(Math.random() * maxDelay) : 0;
      return qstash.publishJSON({
        url: submitUrl,
        body: { formUrl, data, fbzx, fields: dedupedFields },
        delay: delay > 0 ? `${delay}m` : undefined,
      });
    });

    // Final safety check on iterable
    if (promises.length > 0) {
      for (let i = 0; i < promises.length; i += 10) {
        await Promise.all(promises.slice(i, i + 10));
      }
    }

    return NextResponse.json({ success: true, count: processedData.length });

  } catch (error: any) {
    console.error('Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}