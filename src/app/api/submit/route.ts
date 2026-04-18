import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { formUrl, data, fbzx, fields } = body;

    if (!formUrl || !data) {
      return NextResponse.json({ error: 'Missing formUrl or data' }, { status: 400 });
    }

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

    // Single Page Submission
    if (!hasPages) {
      const result = await submitPage(formUrl, data, fbzx, null, 0, false, null, dedupedFields);
      if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });
      return NextResponse.json({ success: true, message: 'Submitted successfully.' });
    }

    // Multi-Page Submission
    const pageMap: Record<number, string[]> = {};
    for (const field of dedupedFields) {
      const pg = field.pageIndex ?? 0;
      if (!pageMap[pg]) pageMap[pg] = [];
      pageMap[pg].push(field.name);
    }

    const sortedPages = Object.keys(pageMap).map(Number).sort((a, b) => a - b);
    let cookies: string | null = null;
    let currentFbzx: string | null = fbzx || null;
    let draftResponse: string | null = null;

    for (let i = 0; i < sortedPages.length; i++) {
      const pageIndex = sortedPages[i];
      const isLastPage = i === sortedPages.length - 1;

      const pageData: Record<string, any> = {};
      for (const name of pageMap[pageIndex]) {
        if (data[name] !== undefined) pageData[name] = data[name];
      }

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
        return NextResponse.json({ error: `Failed on page ${pageIndex}: ${result.error}` }, { status: 500 });
      }

      cookies = result.cookies || null;
      draftResponse = result.draftResponse || null;
      currentFbzx = result.fbzx || null;
    }

    return NextResponse.json({ success: true, message: 'All pages submitted successfully.' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
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
  if (draftResponse) params.append('draftResponse', draftResponse || "");
  
  params.append('fvv', '1');
  // pageHistory must include all pages visited including the current one
  params.append('pageHistory', Array.from({ length: pageIndex + 1 }, (_, i) => i).join(','));
  
  if (hasNextPage) {
    params.append('continue', '1');
  }

  // Improved Field Mapping
  for (const key of Object.keys(data)) {
    const value = data[key];
    const fieldMeta = allFields.find((f: any) => f.name === key);
    const fieldType = fieldMeta?.type ?? '';

    // Handle Checkboxes and Grids (Repeat the key for each value)
    if (Array.isArray(value)) {
      if (fieldType === 'radio_grid' || fieldType === 'radio') {
        params.append(key, String(value[0]));
      } else {
        value.forEach((v) => params.append(key, String(v)));
      }
      continue;
    }

    const strVal = String(value);

    // Date Support
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
      const [y, m, d] = strVal.split('-');
      params.append(`${key}_year`, y);
      params.append(`${key}_month`, String(parseInt(m)));
      params.append(`${key}_day`, String(parseInt(d)));
      continue;
    }

    // Time Support
    if (/^\d{1,2}:\d{2}$/.test(strVal)) {
      const [h, min] = strVal.split(':');
      params.append(`${key}_hour`, String(parseInt(h)));
      params.append(`${key}_minute`, String(parseInt(min)));
      continue;
    }

    params.append(key, strVal);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': formUrl.replace('/formResponse', '/viewform'),
  };

  if (incomingCookies) headers['Cookie'] = incomingCookies;

  const response = await fetch(formUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    redirect: 'manual',
  });

  // Check if we hit a redirect (common for successful final submission)
  if (response.status >= 400) {
    return { success: false, error: `Google rejected request with status ${response.status}` };
  }

  const setCookie = response.headers.get('set-cookie');
  const newCookies = setCookie 
    ? setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ') 
    : incomingCookies;

  let nextDraftResponse = draftResponse;
  let nextFbzx = fbzx;

  const html = await response.text();
  
  // Validation: If we are not on the last page, we MUST find a new draftResponse
  if (hasNextPage) {
    const draftMatch = html.match(/name="draftResponse" value="(.*?)"/);
    if (draftMatch && draftMatch[1]) {
      nextDraftResponse = draftMatch[1].replace(/&quot;/g, '"');
    } else {
      // If no draftResponse found on intermediate page, Google likely flagged a validation error
      return { success: false, error: "Validation error: Google did not advance to the next page. Check required fields." };
    }

    const fbzxMatch = html.match(/name="fbzx" value="(.*?)"/);
    if (fbzxMatch && fbzxMatch[1]) nextFbzx = fbzxMatch[1];
  } else {
    // Final Page Check: Look for the confirmation message
    if (!html.includes('recorded') && !html.includes('sent') && response.status !== 302) {
      return { success: false, error: "Form may not have submitted correctly. Success message not found." };
    }
  }

  return { 
    success: true, 
    cookies: newCookies, 
    draftResponse: nextDraftResponse, 
    fbzx: nextFbzx 
  };
}