import { NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { Client } from '@upstash/qstash';

// Vercel serverless functions usually timeout after 15s on free tier.
// We might want to use Edge runtime, but Groq and Qstash usually work fine on Node runtime.
// export const runtime = 'edge'; 

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
      formUrl, 
      fields, 
      context, 
      count, 
      timeWindowHours, 
      groqApiKey, 
      qstashToken 
    } = body;

    if (!formUrl || !fields || !count || !groqApiKey || !qstashToken) {
      return NextResponse.json({ error: 'Missing required configuration parameters.' }, { status: 400 });
    }

    const groq = new Groq({ apiKey: groqApiKey });

    // Ask Groq to generate a JSON array
    const prompt = `
You are a mock data generator. 
Generate exactly ${count} realistic, diverse but matching sets of responses for a form. 
The form has the following fields:
${JSON.stringify(fields, null, 2)}

Context/Theme for the responses: "${context || 'General realistic answers'}"

Output exactly a single JSON array of objects. 
Each object in the array must represent one person's full response.
The keys in the object MUST exactly match the "name" property of the fields (e.g. "entry.123456").
If a field is a radio, checkbox, or dropdown, choose realistic options. If the field is a text area, provide an appropriate paragraph.

Return ONLY the raw JSON array, without any markdown formatting like \`\`\`json.
`;

    // Fetch from Groq
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
    });

    let content = chatCompletion.choices[0]?.message?.content || '[]';
    // Clean up potential markdown formatting if the model still includes it
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let generatedData: any[];
    try {
      generatedData = JSON.parse(content);
    } catch (e) {
      console.error('Groq returned invalid JSON:', content);
      return NextResponse.json({ error: 'LLM returned invalid JSON. Try generating fewer responses or adjusting the context.' }, { status: 500 });
    }

    if (!Array.isArray(generatedData)) {
      return NextResponse.json({ error: 'LLM did not return a JSON array as requested.' }, { status: 500 });
    }

    // Prepare QStash payload
    const protocol = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('host');
    const submitUrl = `${protocol}://${host}/api/submit`;

    const qstash = new Client({ token: qstashToken });

    const maxDelayMinutes = (timeWindowHours || 0) * 60;
    
    // Create publish promises
    const promises = generatedData.map((mockData) => {
      // If timeWindowHours is 0, submit immediately (no delay)
      const delayMinutes = maxDelayMinutes > 0 ? Math.floor(Math.random() * maxDelayMinutes) : 0;
      
      const payload: any = {
        url: submitUrl,
        body: { formUrl, data: mockData }
      };

      if (delayMinutes > 0) {
        payload.delay = `${delayMinutes}m`;
      }

      return qstash.publishJSON(payload);
    });

    // We chunk the requests to avoid hitting rate limits or taking up too much memory all at once.
    // However, Upstash is pretty fast. We will just execute them in parallel chunks.
    const chunkSize = 10;
    for (let i = 0; i < promises.length; i += chunkSize) {
      await Promise.all(promises.slice(i, i + chunkSize));
    }

    return NextResponse.json({ 
      success: true, 
      message: `Successfully generated and scheduled ${generatedData.length} responses.`,
      scheduledCount: generatedData.length 
    });

  } catch (error: any) {
    console.error('Error generating and scheduling:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
