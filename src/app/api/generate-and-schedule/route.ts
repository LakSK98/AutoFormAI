import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Client } from '@upstash/qstash';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, fields, context, count, timeWindowHours, fbzx } = body;

    if (!formUrl || !fields || !count) {
      return NextResponse.json({ error: 'Missing required configuration parameters.' }, { status: 400 });
    }

    const geminiKey = process.env.GOOGLE_AI_API_KEY;
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!geminiKey || !qstashToken) {
      return NextResponse.json({ error: 'Missing API keys.' }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Build a human-readable field guide so the LLM knows exactly what format each type needs
    const fieldGuide = fields.map((f: any) => {
      let hint = '';
      switch (f.type) {
        case 'text':        hint = 'Short text answer.'; break;
        case 'textarea':    hint = 'Longer paragraph answer.'; break;
        case 'radio':       hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}.`; break;
        case 'dropdown':    hint = `Pick exactly ONE from: ${JSON.stringify(f.options ?? [])}.`; break;
        case 'checkbox':    hint = `Pick one OR MORE from: ${JSON.stringify(f.options ?? [])}. Return as a JSON array e.g. ["A","B"].`; break;
        case 'linear_scale':
          hint = `Integer between ${f.low ?? 1} and ${f.high ?? 5}.`
               + (f.lowLabel  ? ` (${f.low} = ${f.lowLabel})` : '')
               + (f.highLabel ? ` (${f.high} = ${f.highLabel})` : '') + '.';
          break;
        case 'rating':      hint = `Integer between 1 and ${f.high ?? 5}.`; break;
        case 'radio_grid':  hint = `Pick exactly ONE column value from: ${JSON.stringify(f.options ?? [])}. This is one row of a grid.`; break;
        case 'checkbox_grid': hint = `Pick one OR MORE column values from: ${JSON.stringify(f.options ?? [])}. Return as a JSON array.`; break;
        case 'date':        hint = 'Date string in YYYY-MM-DD format.'; break;
        case 'time':        hint = 'Time string in HH:MM (24-hour) format.'; break;
        default:            hint = 'Text answer.';
      }
      return { name: f.name, title: f.title, type: f.type, hint };
    });

    const prompt = `
You are a realistic mock form-response generator.

Generate exactly ${count} diverse, realistic sets of form responses.

Persona / context for respondents: "${context || 'General realistic users'}"

Fields (follow the hint for each field exactly):
${JSON.stringify(fieldGuide, null, 2)}

Rules:
- Output ONLY a raw JSON array of ${count} objects — no markdown, no preamble, no backticks.
- Each object's keys must exactly match the "name" values above (e.g. "entry.123456").
- For checkbox / checkbox_grid fields, the value must be a JSON array of strings.
- For date fields use YYYY-MM-DD. For time fields use HH:MM (24-hour).
- For linear_scale / rating fields use a plain integer (as a string is fine).
- Vary answers realistically across the ${count} responses.
`.trim();

    const result = await model.generateContent(prompt);
    let content = result.response.text();

    // Strip markdown fences if Gemini includes them
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    let generatedData: any[];
    try {
      generatedData = JSON.parse(content);
    } catch {
      console.error('Gemini returned invalid JSON:', content);
      return NextResponse.json({ error: 'AI returned invalid JSON. Try fewer responses or a simpler context.' }, { status: 500 });
    }

    if (!Array.isArray(generatedData)) {
      return NextResponse.json({ error: 'AI did not return a JSON array.' }, { status: 500 });
    }

    const protocol = req.headers.get('x-forwarded-proto') ?? 'https';
    const host     = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;

    const qstash = new Client({ token: qstashToken });
    const maxDelayMinutes = (timeWindowHours ?? 0) * 60;

    const promises = generatedData.map((mockData) => {
      const delayMinutes = maxDelayMinutes > 0 ? Math.floor(Math.random() * maxDelayMinutes) : 0;
      const payload: any = { url: submitUrl, body: { formUrl, data: mockData, fbzx } };
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