import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, data } = body;

    if (!formUrl || !data) {
      return NextResponse.json({ error: 'Missing formUrl or data' }, { status: 400 });
    }

    const params = new URLSearchParams();
    
    // Core parameters for Google Forms
    if (body.fbzx) params.append('fbzx', body.fbzx);
    params.append('fvv', '1');
    params.append('pageHistory', '0');
    
    // Convert object properties to form-encoded parameters
    for (const key of Object.keys(data)) {
        const value = data[key];
        
        // Handle checkbox fields or fields with multiple selections where LLM might output an array
        if (Array.isArray(value)) {
            value.forEach((v) => params.append(key, String(v)));
        } else {
            params.append(key, String(value));
        }
    }

    // Google Forms expects the request to be submitted to /formResponse
    // It will return status 200 with HTML, or 302 if redirecting (e.g. if success is set to show another page)
    const formResponse = await fetch(formUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: params.toString()
    });

    if (!formResponse.ok) {
        // For Google Forms, 400 means bad request normally, but often it still works 
        // We will just log it out.
        console.error(`Google Form returned status: ${formResponse.status}`);
        return NextResponse.json({ error: `Google Form submission failed with status ${formResponse.status}` }, { status: formResponse.status > 400 ? formResponse.status : 500 });
    }

    console.log(`Successfully submitted to ${formUrl}.`);
    
    return NextResponse.json({ success: true, message: 'Submitted successfully to Google Forms.' });
  } catch (error: any) {
    console.error('Error submitting to Google Forms:', error);
    return NextResponse.json({ error: error.message || 'Server error during submission' }, { status: 500 });
  }
}
