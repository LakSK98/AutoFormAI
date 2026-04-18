import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, data, fbzx, fields } = body;

    if (!formUrl || !data) {
      return NextResponse.json({ error: 'Missing formUrl or data' }, { status: 400 });
    }

    // ✅ Deduplicate fields by name — keeps first occurrence (correct pageIndex preserved)
    const seenNames = new Set<string>();
    const dedupedFields = Array.isArray(fields)
      ? (fields as any[]).filter((f) => {
          if (seenNames.has(f.name)) return false;
          seenNames.add(f.name);
          return true;
        })
      : [];

    const hasPages = dedupedFields.some(
      (f: any) => typeof f.pageIndex === 'number' && f.pageIndex > 0
    );

    if (!hasPages) {
      const result = await submitPage(formUrl, data, fbzx, null, 0, false, null, dedupedFields);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ success: true, message: 'Submitted successfully.' });
    }

    // Build page → field names map from deduplicated fields
    const pageMap: Record<number, string[]> = {};
    for (const field of dedupedFields) {
      const pg = field.pageIndex ?? 0;
      if (!pageMap[pg]) pageMap[pg] = [];
      pageMap[pg].push(field.name);
    }

    const sortedPages = Object.keys(pageMap).map(Number).sort((a, b) => a - b);

    // State trackers for multi-page forms
    let cookies: string | null = null;
    let currentFbzx: string | null = fbzx || null;
    let draftResponse: string | null = null;

    for (let i = 0; i < sortedPages.length; i++) {
      const pageIndex  = sortedPages[i];
      const isLastPage = i === sortedPages.length - 1;

      const pageData: Record<string, any> = {};
      for (const name of pageMap[pageIndex]) {
        if (data[name] !== undefined) pageData[name] = data[name];
      }

      console.log(`Submitting page ${pageIndex}, fields:`, Object.keys(pageData));

      const result = await submitPage(
        formUrl,
        pageData,
        currentFbzx,
        draftResponse,
        pageIndex,
        !isLastPage,
        cookies,
        dedupedFields
      );

      if (!result.success) {
        return NextResponse.json(
          { error: `Failed on page ${pageIndex}: ${result.error}` },
          { status: 500 }
        );
      }

      // Update state for the next page iteration
      if (result.cookies) cookies = result.cookies;
      if (result.draftResponse) draftResponse = result.draftResponse;
      if (result.fbzx) currentFbzx = result.fbzx;
    }

    return NextResponse.json({ success: true, message: 'All pages submitted successfully.' });

  } catch (error: any) {
    console.error('Error submitting to Google Forms:', error);
    return NextResponse.json({ error: error.message || 'Server error during submission' }, { status: 500 });
  }
}

async function submitPage(
  formUrl: string,
  data: Record<string, any>,
  fbzx: string | null,
  draftResponse: string | null,
  pageIndex: number,
  hasNextPage: boolean,
  incomingCookies: string | null,
  allFields: any[]
): Promise<{ success: boolean; cookies?: string | null; draftResponse?: string | null; fbzx?: string | null; error?: string }> {

  const params = new URLSearchParams();

  if (fbzx) params.append('fbzx', fbzx);
  if (draftResponse) params.append('draftResponse', draftResponse); // 👈 Critical for multi-page state

  params.append('fvv', '1');
  params.append('pageHistory', Array.from({ length: pageIndex + 1 }, (_, i) => i).join(','));
  if (hasNextPage) params.append('continue', '1');

  for (const key of Object.keys(data)) {
    const value = data[key];
    const fieldMeta = allFields.find((f: any) => f.name === key);
    const fieldType = fieldMeta?.type ?? '';

    if (Array.isArray(value)) {
      if (fieldType === 'radio_grid') {
        params.append(key, String(value[0]));
      } else {
        value.forEach((v) => params.append(key, String(v)));
      }
      continue;
    }

    const strVal = String(value);

    // Date
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
      const [year, month, day] = strVal.split('-');
      params.append(`${key}_year`,  year);
      params.append(`${key}_month`, String(parseInt(month, 10)));
      params.append(`${key}_day`,   String(parseInt(day,   10)));
      continue;
    }

    // Time
    if (/^\d{1,2}:\d{2}$/.test(strVal)) {
      const [hour, minute] = strVal.split(':');
      params.append(`${key}_hour`,   String(parseInt(hour,   10)));
      params.append(`${key}_minute`, String(parseInt(minute, 10)));
      continue;
    }

    params.append(key, strVal);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer':      formUrl.replace('/formResponse', '/viewform'),
    'Origin':       'https://docs.google.com',
  };

  if (incomingCookies) headers['Cookie'] = incomingCookies;

  const response = await fetch(formUrl, {
    method:   'POST',
    headers,
    body:     params.toString(),
    redirect: 'manual', // Prevents aggressive redirects on final submission
  });

  if (response.status >= 400) {
    return { success: false, error: `HTTP ${response.status}` };
  }

  const setCookie = response.headers.get('set-cookie');
  const newCookies = setCookie
    ? setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ')
    : incomingCookies;

  let nextDraftResponse = draftResponse;
  let nextFbzx = fbzx;

  // 👈 Extract updated draftResponse and fbzx from the intermediate HTML response
  if (hasNextPage && response.status === 200) {
    const html = await response.text();

    const draftMatch = html.match(/name="draftResponse" value="(.*?)"/);
    if (draftMatch && draftMatch[1]) {
      nextDraftResponse = draftMatch[1].replace(/&quot;/g, '"'); 
    }

    const fbzxMatch = html.match(/name="fbzx" value="(.*?)"/);
    if (fbzxMatch && fbzxMatch[1]) {
      nextFbzx = fbzxMatch[1];
    }
  }

  return { 
    success: true, 
    cookies: newCookies,
    draftResponse: nextDraftResponse,
    fbzx: nextFbzx
  };
}