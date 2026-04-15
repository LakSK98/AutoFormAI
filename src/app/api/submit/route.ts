import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, data, fbzx } = body;

    if (!formUrl || !data) {
      return NextResponse.json({ error: 'Missing formUrl or data' }, { status: 400 });
    }

    const params = new URLSearchParams();

    if (fbzx) params.append('fbzx', fbzx);
    params.append('fvv', '1');
    params.append('pageHistory', '0');

    for (const key of Object.keys(data)) {
      const value = data[key];

      // ── Checkbox / checkbox_grid → multiple values for same key ──
      if (Array.isArray(value)) {
        value.forEach((v) => params.append(key, String(v)));
        continue;
      }

      const strVal = String(value);

      // ── Date: "YYYY-MM-DD" → entry.XXXX_year, _month, _day ──
      if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
        const [year, month, day] = strVal.split('-');
        params.append(`${key}_year`,  year);
        params.append(`${key}_month`, String(parseInt(month, 10)));   // no leading zero
        params.append(`${key}_day`,   String(parseInt(day,   10)));
        continue;
      }

      // ── Time: "HH:MM" → entry.XXXX_hour, _minute ──
      if (/^\d{1,2}:\d{2}$/.test(strVal)) {
        const [hour, minute] = strVal.split(':');
        params.append(`${key}_hour`,   String(parseInt(hour,   10)));
        params.append(`${key}_minute`, String(parseInt(minute, 10)));
        continue;
      }

      // ── Everything else (text, radio, dropdown, scale, rating) ──
      params.append(key, strVal);
    }

    const formResponse = await fetch(formUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': formUrl.replace('/formResponse', '/viewform'),
        'Origin': 'https://docs.google.com',
      },
      body: params.toString(),
      redirect: 'manual',   // 302 redirect = successful submission on many forms
    });

    // Google Forms returns 200 (with "Thank you" HTML) or 302 (redirect to confirmation)
    // Both indicate success. Anything ≥ 400 is an actual error.
    if (formResponse.status >= 400) {
      console.error(`Google Form returned status: ${formResponse.status}`);
      return NextResponse.json(
        { error: `Google Form submission failed with status ${formResponse.status}` },
        { status: 500 }
      );
    }

    console.log(`Successfully submitted to ${formUrl} (HTTP ${formResponse.status}).`);
    return NextResponse.json({ success: true, message: 'Submitted successfully.' });

  } catch (error: any) {
    console.error('Error submitting to Google Forms:', error);
    return NextResponse.json({ error: error.message || 'Server error during submission' }, { status: 500 });
  }
}