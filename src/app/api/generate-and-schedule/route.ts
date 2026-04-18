import { NextResponse } from 'next/server';
import OpenAI from 'openai'; // DeepSeek uses OpenAI-compatible SDK
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

// ── Parsing Logic ───────────────────────────────────────────────────────────
function parseFieldOverrides(context: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  const sectionMatch = context.match(/field\s+overrides\s*:([\s\S]*?)(?:\n\n|\n[A-Z]|$)/i);
  if (!sectionMatch) return overrides;

  const pairRegex = /(entry\.\d+)\s*=\s*([a-z_]+)/gi;
  let match;
  while ((match = pairRegex.exec(sectionMatch[1])) !== null) {
    const name = match[1].toLowerCase();
    const resolved = OVERRIDE_VALUE_MAP[match[2].toLowerCase()];
    if (resolved) overrides[name] = resolved[0];
  }
  return overrides;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, fields, context, count, timeWindowHours, fbzx } = body;

    // Check environment variables
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const qstashToken = process.env.QSTASH_TOKEN;
    if (!deepseekKey || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys.' }, { status: 500 });
    }

    // Initialize DeepSeek Client
    const deepseek = new OpenAI({
      apiKey: deepseekKey,
      baseURL: 'https://api.deepseek.com',
    });

    // 1. Dedupe fields
    const seenNames = new Set<string>();
    const dedupedFields = (fields as any[]).filter(f => !seenNames.has(f.name) && seenNames.add(f.name));

    // 2. Parse Hard Overrides
    const hardOverrides = parseFieldOverrides(context ?? '');
    const fieldsToClassify = dedupedFields.filter(f => !(f.name in hardOverrides));

    // 3. Step 1: LLM Classification (DeepSeek)
    let intentMap: Record<string, FieldIntent> = {};
    let excludedOptions: string[] = [];

    if (fieldsToClassify.length > 0) {
      const classification = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are a data classifier. Return ONLY raw JSON.'
          },
          {
            role: 'user',
            content: `Analyze this context: "${context}"\nFields: ${JSON.stringify(fieldsToClassify)}\n\nAssign intent (positive/negative/random) and list excluded options. Shape: {"intents": {"entry.123": "positive"}, "excludedOptions": []}`
          }
        ],
        response_format: { type: 'json_object' }
      });

      const parsed = JSON.parse(classification.choices[0].message.content || '{}');
      intentMap = parsed.intents || {};
      excludedOptions = parsed.excludedOptions || [];
    }

    // 4. Build Field Guide for Generation
    const fieldGuide = dedupedFields
      .filter(f => !(f.name in hardOverrides))
      .map(f => ({
        name: f.name,
        type: f.type,
        intent: intentMap[f.name] ?? 'positive',
        options: (f.options ?? []).filter((o: string) => !excludedOptions.includes(o))
      }));

    // 5. Step 2: Response Generation (DeepSeek)
    const generation = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `Generate ${count} realistic form responses as a JSON array. Follow intents strictly.`
        },
        {
          role: 'user',
          content: `Context: ${context}\nFields: ${JSON.stringify(fieldGuide)}`
        }
      ],
      response_format: { type: 'json_object' } // DeepSeek ensures valid JSON
    });

    let generatedData = JSON.parse(generation.choices[0].message.content || '{"data": []}').data || [];

    // 6. Post-Processing (Inject Overrides & Logic)
    const processedData = generatedData.map((row: any) => {
      // Apply Hard Overrides
      for (const [name, val] of Object.entries(hardOverrides)) {
        const meta = dedupedFields.find(f => f.name === name);
        if (val === '__MIN__') row[name] = String(meta?.low ?? 1);
        else if (val === '__MAX__') row[name] = String(meta?.high ?? 5);
        else row[name] = val;
      }
      return row;
    });

    // 7. QStash Scheduling
    const qstash = new Client({ token: qstashToken });
    const protocol = req.headers.get('x-forwarded-proto') ?? 'https';
    const submitUrl = `${protocol}://${req.headers.get('host')}/api/submit`;

    const qstashPromises = processedData.map((mockData: any) => {
      const delay = (timeWindowHours ?? 0) > 0 
        ? Math.floor(Math.random() * timeWindowHours * 60) 
        : 0;

      return qstash.publishJSON({
        url: submitUrl,
        body: { formUrl, data: mockData, fbzx, fields: dedupedFields },
        delay: delay > 0 ? `${delay}m` : undefined,
      });
    });

    // Chunked execution to avoid timeout
    for (let i = 0; i < qstashPromises.length; i += 10) {
      await Promise.all(qstashPromises.slice(i, i + 10));
    }

    return NextResponse.json({ success: true, count: processedData.length });

  } catch (error: any) {
    console.error('DeepSeek/QStash Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
