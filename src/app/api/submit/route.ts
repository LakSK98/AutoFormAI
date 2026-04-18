import * as cheerio from 'cheerio';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string' || !url.startsWith('https://docs.google.com/forms/')) {
      return NextResponse.json({ error: 'A valid Google Form URL is required.' }, { status: 400 });
    }

    const viewUrl = url.replace(/\/formResponse$/, '/viewform').split('?')[0];

    const res = await fetch(viewUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch the form URL.' }, { status: res.status });
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const fields: {
      name: string;
      title: string;
      type: string;
      pageIndex: number;
      options?: string[];
      low?: string;
      high?: string;
      lowLabel?: string;
      highLabel?: string;
      rows?: string[];
      columns?: string[];
    }[] = [];

    // ✅ Corrected TYPE_MAP
    const TYPE_MAP: Record<number, string> = {
      0:  'text',
      1:  'textarea',
      2:  'radio',
      3:  'dropdown',
      4:  'checkbox',
      5:  'linear_scale',
      6:  'title_description', // Not a page break
      7:  'grid',              // Handles BOTH radio and checkbox grids
      8:  'page_break',        // 👈 This is the actual Section Header/Page Break
      9:  'date',
      10: 'time',
      11: 'image',
      12: 'video',
      13: 'file_upload',
      18: 'rating',
    };

    const match = html.match(/var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);\s*<\/script>/s);
    if (match && match[1]) {
      try {
        const data = JSON.parse(match[1]);
        const questionsArray = data[1]?.[1] || [];

        let currentPage = 0;

        for (const q of questionsArray) {
          const title = typeof q[1] === 'string' ? q[1].replace(/\*$/, '').trim() : '';
          const typeCode: number = q[3];
          const type = TYPE_MAP[typeCode] ?? 'text';

          // ✅ Correct Page Break Logic
          if (type === 'page_break') {
            currentPage++;
            continue;
          }

          if (['title_description', 'file_upload', 'image', 'video'].includes(type)) continue;

          const entryArr = q[4];
          if (!entryArr || !entryArr[0]) continue;

          if (type === 'linear_scale') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            const scaleData = entryArr[0][3];
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              pageIndex: currentPage,
              low:      String(scaleData?.[0] ?? 1),
              high:     String(scaleData?.[1] ?? 5),
              lowLabel: String(scaleData?.[2] ?? ''),
              highLabel:String(scaleData?.[3] ?? ''),
            });
            continue;
          }

          if (type === 'rating') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              pageIndex: currentPage,
              low:  '1',
              high: String(entryArr[0][3]?.[0] ?? 5),
            });
            continue;
          }

          // ✅ Updated Grid Logic (differentiates checkbox vs radio internally)
          if (type === 'grid') {
            // In Google Forms, checkbox grids set an array with `1` at index 11
            const isCheckboxGrid = entryArr[0][11]?.[0] === 1;
            const actualGridType = isCheckboxGrid ? 'checkbox_grid' : 'radio_grid';

            const rawCols: string[] = (entryArr[0][1] ?? []).map((c: any) =>
              typeof c[0] === 'string' ? c[0] : String(c[0])
            );
            const rowLabels = entryArr.map((r: any, j: number) =>
              typeof r[3] === 'string' ? r[3] : `Row ${j + 1}`
            );
            entryArr.forEach((row: any, i: number) => {
              const entryId = row[0];
              if (!entryId) return;
              const rowLabel = typeof row[3] === 'string' ? row[3] : `Row ${i + 1}`;
              fields.push({
                name: `entry.${entryId}`,
                title: `${title} → ${rowLabel}`,
                type: actualGridType,
                pageIndex: currentPage,
                options: rawCols,
                rows: rowLabels,
                columns: rawCols,
              });
            });
            continue;
          }

          if (type === 'date' || type === 'time') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              pageIndex: currentPage,
            });
            continue;
          }

          if (['radio', 'dropdown', 'checkbox'].includes(type)) {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            const rawOptions: any[] = entryArr[0][1] ?? [];
            const options = rawOptions
              .map((o: any) => (typeof o[0] === 'string' ? o[0] : null))
              .filter((o): o is string => o !== null && o !== '__other_option__');
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              pageIndex: currentPage,
              options,
            });
            continue;
          }

          // text / textarea
          const entryId = entryArr[0][0];
          if (!entryId) continue;
          fields.push({
            name: `entry.${entryId}`,
            title: title || `Field ${entryId}`,
            type,
            pageIndex: currentPage,
          });
        }
      } catch (e) {
        console.error('Failed to parse FB_PUBLIC_LOAD_DATA_', e);
      }
    }

    // Cheerio fallback (no page detection, all page 0)
    if (fields.length === 0) {
      $('div[role="listitem"], div.geS5n').each((_, elem) => {
        let title = $(elem).find('div[role="heading"], span.M7eMe').text().trim().replace(/\*$/, '').trim();
        let name = $(elem).find('input[name^="entry."], textarea[name^="entry."]').attr('name');
        if (!name) name = $(elem).find('input[type="hidden"][name^="entry."]').attr('name');

        if (name && !fields.find(f => f.name === name)) {
          let type = 'text';
          if ($(elem).find('textarea').length)              type = 'textarea';
          else if ($(elem).find('div[role="radio"]').length)    type = 'radio';
          else if ($(elem).find('div[role="checkbox"]').length) type = 'checkbox';
          else if ($(elem).find('div[role="listbox"]').length)  type = 'dropdown';
          const options: string[] = [];
          $(elem).find('div[data-value], span[data-value]').each((_, opt) => {
            const val = $(opt).attr('data-value');
            if (val) options.push(val);
          });
          fields.push({
            name,
            title: title || `Unknown (${name})`,
            type,
            pageIndex: 0,
            ...(options.length ? { options } : {}),
          });
        }
      });
    }

    // Basic regex fallback
    if (fields.length === 0) {
      $('input[name^="entry."], textarea[name^="entry."]').each((_, el) => {
        const name = $(el).attr('name');
        if (name && !fields.find(f => f.name === name)) {
          fields.push({
            name,
            title: `Unknown (${name})`,
            type: el.name === 'textarea' ? 'textarea' : 'text',
            pageIndex: 0,
          });
        }
      });
    }

    // ✅ Deduplicate fields by name — keeps first occurrence (correct pageIndex)
    const seenNames = new Set<string>();
    const dedupedFields = fields.filter((f) => {
      if (seenNames.has(f.name)) return false;
      seenNames.add(f.name);
      return true;
    });

    const fbzxMatch = html.match(/name="fbzx" value="(.*?)"/);
    const fbzx = fbzxMatch ? fbzxMatch[1] : '';

    let formTitle =
      $('div[role="heading"][aria-level="1"]').text().trim() ||
      $('title').text().replace(' - Google Forms', '').trim() ||
      'Untitled Form';

    if (html.includes('ServiceLogin') || html.includes('accounts.google.com/v3/signin')) {
      return NextResponse.json({ error: 'This form requires login. Please make it public.' }, { status: 403 });
    }

    if (dedupedFields.length === 0 && !html.includes('entry.')) {
      return NextResponse.json({ error: 'No fields found. Check the URL and ensure the form is public.' }, { status: 404 });
    }

    const pageCount = Math.max(...dedupedFields.map(f => f.pageIndex), 0) + 1;
    const submitUrl = viewUrl.replace('/viewform', '/formResponse');

    console.log(`Scraped form: "${formTitle}", ${dedupedFields.length} fields, ${pageCount} pages`);

    return NextResponse.json({ title: formTitle, submitUrl, fields: dedupedFields, fbzx, pageCount });

  } catch (error: any) {
    console.error('Error scraping form:', error);
    return NextResponse.json({ error: 'Unexpected error while extracting form fields.' }, { status: 500 });
  }
}