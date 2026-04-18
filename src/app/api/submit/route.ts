import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, data, fbzx, fields } = body;

console.log('Submit received:', {
      formUrl,
      fbzx,
      hasFields: !!fields,
      fieldCount: fields?.length,
      dataKeys: Object.keys(data ?? {}),
    });

    if (!formUrl || !data) {
      return NextResponse.json({ error: 'Missing formUrl or data' }, { status: 400 });
    }

    // Check whether we have multi-page info
    const hasPages =
      Array.isArray(fields) &&
      fields.some((f: any) => typeof f.pageIndex === 'number' && f.pageIndex > 0);

    if (!hasPages) {
      // Single-page fast path
      const result = await submitPage(formUrl, data, fbzx, 0, false, null);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ success: true, message: 'Submitted successfully.' });
    }

    // ── Multi-page path ──────────────────────────────────────────────
    // Group field names by their pageIndex
    const pageMap: Record<number, string[]> = {};
    for (const field of fields as any[]) {
      const pg = field.pageIndex ?? 0;
      if (!pageMap[pg]) pageMap[pg] = [];
      pageMap[pg].push(field.name);
    }

    const sortedPages = Object.keys(pageMap).map(Number).sort((a, b) => a - b);
    let cookies: string | null = null;

    for (let i = 0; i < sortedPages.length; i++) {
      const pageIndex  = sortedPages[i];
      const isLastPage = i === sortedPages.length - 1;

      // Only send fields that belong to this page
      const pageData: Record<string, any> = {};
      for (const name of pageMap[pageIndex]) {
        if (data[name] !== undefined) pageData[name] = data[name];
      }

      const result = await submitPage(
        formUrl,
        pageData,
        fbzx,
        pageIndex,
        !isLastPage,   // continue=1 on every page except the last
        cookies
      );

      if (!result.success) {
        return NextResponse.json(
          { error: `Failed on page ${pageIndex}: ${result.error}` },
          { status: 500 }
        );
      }

      if (result.cookies) cookies = result.cookies;
    }

    return NextResponse.json({ success: true, message: 'All pages submitted successfully.' });

  } catch (error: any) {
    console.error('Error submitting to Google Forms:', error);
    return NextResponse.json({ error: error.message || 'Server error during submission' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: submit one page of the form
// ─────────────────────────────────────────────────────────────────────────────
async function submitPage(
  formUrl: string,
  data: Record<string, any>,
  fbzx: string | null,
  pageIndex: number,
  hasNextPage: boolean,
  incomingCookies: string | null
): Promise<{ success: boolean; cookies?: string | null; error?: string }> {

 console.log('submitPage called:', { formUrl, pageIndex, hasNextPage, paramCount: Object.keys(data).length });

  const params = new URLSearchParams();

  if (fbzx) params.append('fbzx', fbzx);
  params.append('fvv', '1');
  // pageHistory must list every page visited so far: "0", "0,1", "0,1,2" …
  params.append('pageHistory', Array.from({ length: pageIndex + 1 }, (_, i) => i).join(','));

  if (hasNextPage) params.append('continue', '1');

  for (const key of Object.keys(data)) {
    const value = data[key];

    // Checkbox / checkbox_grid → repeated key
    if (Array.isArray(value)) {
      value.forEach((v) => params.append(key, String(v)));
      continue;
    }

    const strVal = String(value);

    // Date: YYYY-MM-DD → _year / _month / _day
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
      const [year, month, day] = strVal.split('-');
      params.append(`${key}_year`,  year);
      params.append(`${key}_month`, String(parseInt(month, 10)));
      params.append(`${key}_day`,   String(parseInt(day,   10)));
      continue;
    }

    // Time: HH:MM → _hour / _minute
    if (/^\d{1,2}:\d{2}$/.test(strVal)) {
      const [hour, minute] = strVal.split(':');
      params.append(`${key}_hour`,   String(parseInt(hour,   10)));
      params.append(`${key}_minute`, String(parseInt(minute, 10)));
      continue;
    }

    params.append(key, strVal);
  }

console.log('Submitting params:', params.toString().substring(0, 500));


  const headers: Record<string, string> = {
    'Content-Type':  'application/x-www-form-urlencoded',
    'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer':       formUrl.replace('/formResponse', '/viewform'),
    'Origin':        'https://docs.google.com',
  };

  if (incomingCookies) headers['Cookie'] = incomingCookies;

  const response = await fetch(formUrl, {
    method:   'POST',
    headers,
    body:     params.toString(),
    redirect: 'manual',  // treat 302 as success
  });


  console.log('Google response status:', response.status);

  if (response.status >= 400) {
    return { success: false, error: `HTTP ${response.status}` };
  }

  // Carry cookies forward to the next page
  const setCookie   = response.headers.get('set-cookie');
  const newCookies  = setCookie
    ? setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ')
    : incomingCookies;

  return { success: true, cookies: newCookies };
}