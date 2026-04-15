import * as cheerio from 'cheerio';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string' || !url.startsWith('https://docs.google.com/forms/')) {
      return NextResponse.json({ error: 'A valid Google Form URL is required (must start with https://docs.google.com/forms/).' }, { status: 400 });
    }

    const viewUrl = url.replace(/\/formResponse$/, '/viewform').split('?')[0];

    const res = await fetch(viewUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch the provided form URL.' }, { status: res.status });
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const fields: {
      name: string;
      title: string;
      type: string;
      options?: string[];
      low?: string;
      high?: string;
      lowLabel?: string;
      highLabel?: string;
      rows?: string[];
      columns?: string[];
    }[] = [];

    // Type code → field type mapping (from Google's internal codes)
    const TYPE_MAP: Record<number, string> = {
      0:  'text',               // Short answer
      1:  'textarea',           // Paragraph
      2:  'radio',              // Multiple choice
      3:  'dropdown',           // Dropdown
      4:  'checkbox',           // Checkboxes
      5:  'linear_scale',       // Linear scale
      6:  'title_description',  // Section header (no entry id, skip)
      7:  'checkbox_grid',      // Checkbox grid
      8:  'radio_grid',         // Multiple choice grid
      9:  'date',               // Date
      10: 'time',               // Time
      11: 'file_upload',        // File upload (skip)
      13: 'image',              // Image (skip)
      18: 'rating',             // Rating (star)
    };

    const match = html.match(/var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);\s*<\/script>/s);
    if (match && match[1]) {
      try {
        const data = JSON.parse(match[1]);
        const questionsArray = data[1]?.[1] || [];

        for (const q of questionsArray) {
          const title = typeof q[1] === 'string' ? q[1].replace(/\*$/, '').trim() : '';
          const typeCode: number = q[3];
          const type = TYPE_MAP[typeCode] ?? 'text';

          // Skip non-input field types
          if (['title_description', 'file_upload', 'image'].includes(type)) continue;

          const entryArr = q[4];
          if (!entryArr || !entryArr[0]) continue;

          // ----- Linear scale -----
          if (type === 'linear_scale') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            const scaleData = entryArr[0][3]; // [[low, high, lowLabel, highLabel]]
            const low  = scaleData?.[0] ?? 1;
            const high = scaleData?.[1] ?? 5;
            const lowLabel  = scaleData?.[2] ?? '';
            const highLabel = scaleData?.[3] ?? '';
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              low:  String(low),
              high: String(high),
              lowLabel:  String(lowLabel),
              highLabel: String(highLabel),
            });
            continue;
          }

          // ----- Rating -----
          if (type === 'rating') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            // options[2] holds the max count
            const ratingMax = entryArr[0][3]?.[0] ?? 5;
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
              low:  '1',
              high: String(ratingMax),
            });
            continue;
          }

          // ----- Grid types (radio_grid / checkbox_grid) -----
          // Each row gets its own entry.XXXXXXX; columns are shared
          if (type === 'radio_grid' || type === 'checkbox_grid') {
            // Columns are stored on the first sub-entry's option list
            const rawCols: string[] = (entryArr[0][1] ?? []).map((c: any) =>
              typeof c[0] === 'string' ? c[0] : String(c[0])
            );
            const rows: string[] = entryArr.map((row: any, i: number) =>
              typeof row[3] === 'string' ? row[3] : (title ? `${title} – Row ${i + 1}` : `Row ${i + 1}`)
            );
            entryArr.forEach((row: any, i: number) => {
              const entryId = row[0];
              if (!entryId) return;
              const rowLabel = typeof row[3] === 'string' ? row[3] : `Row ${i + 1}`;
              fields.push({
                name: `entry.${entryId}`,
                title: `${title} → ${rowLabel}`,
                type,
                options: rawCols,
                rows,
                columns: rawCols,
              });
            });
            continue;
          }

          // ----- Date / Time -----
          if (type === 'date' || type === 'time') {
            const entryId = entryArr[0][0];
            if (!entryId) continue;
            fields.push({
              name: `entry.${entryId}`,
              title: title || `Field ${entryId}`,
              type,
            });
            continue;
          }

          // ----- Radio / Dropdown / Checkbox (with options) -----
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
              options,
            });
            continue;
          }

          // ----- Text / Textarea (default) -----
          const entryId = entryArr[0][0];
          if (!entryId) continue;
          fields.push({
            name: `entry.${entryId}`,
            title: title || `Field ${entryId}`,
            type,
          });
        }
      } catch (e) {
        console.error("Failed to parse FB_PUBLIC_LOAD_DATA_", e);
      }
    }

    // ---------- Cheerio fallback (if raw data parse failed) ----------
    if (fields.length === 0) {
      $('div[role="listitem"], div.geS5n').each((_, elem) => {
        const titleElement = $(elem).find('div[role="heading"], span.M7eMe');
        let title = titleElement.text().trim().replace(/\*$/, '').trim();

        let input = $(elem).find('input[name^="entry."], textarea[name^="entry."]');
        let name = input.attr('name');

        if (!name) {
          const hiddenInput = $(elem).find('input[type="hidden"][name^="entry."]');
          if (hiddenInput.length) name = hiddenInput.attr('name');
        }

        if (name && !fields.find(f => f.name === name)) {
          let type = 'text';
          if ($(elem).find('textarea').length > 0) type = 'textarea';
          else if ($(elem).find('div[role="radio"]').length > 0) type = 'radio';
          else if ($(elem).find('div[role="checkbox"]').length > 0) type = 'checkbox';
          else if ($(elem).find('div[role="listbox"]').length > 0) type = 'dropdown';
          else if ($(elem).find('input[type="date"]').length > 0) type = 'date';
          else if ($(elem).find('input[type="time"]').length > 0) type = 'time';

          const options: string[] = [];
          $(elem).find('div[data-value], span[data-value]').each((_, opt) => {
            const val = $(opt).attr('data-value');
            if (val) options.push(val);
          });

          fields.push({ name, title: title || `Unknown (${name})`, type, ...(options.length ? { options } : {}) });
        }
      });
    }

    // Basic regex fallback
    if (fields.length === 0) {
      $('input[name^="entry."], textarea[name^="entry."]').each((_, el) => {
        const name = $(el).attr('name');
        if (name && !fields.find(f => f.name === name)) {
          fields.push({ name, title: `Unknown (${name})`, type: el.name === 'textarea' ? 'textarea' : 'text' });
        }
      });
    }

    const fbzxMatch = html.match(/name="fbzx" value="(.*?)"/);
    const fbzx = fbzxMatch ? fbzxMatch[1] : '';

    let formTitle =
      $('div[role="heading"][aria-level="1"]').text().trim() ||
      $('title').text().replace(' - Google Forms', '').trim() ||
      'Untitled Form';

    if (
      formTitle.toLowerCase().includes('sign-in') ||
      html.includes('ServiceLogin') ||
      html.includes('accounts.google.com/v3/signin')
    ) {
      return NextResponse.json({
        error: 'This form requires login. Please make sure it is public.',
      }, { status: 403 });
    }

    if (fields.length === 0 && !html.includes('entry.')) {
      return NextResponse.json({
        error: 'No fields could be discovered. Check the URL and ensure the form is public.',
      }, { status: 404 });
    }

    const submitUrl = viewUrl.replace('/viewform', '/formResponse');

    return NextResponse.json({ title: formTitle, submitUrl, fields, fbzx });

  } catch (error: any) {
    console.error('Error scraping form:', error);
    return NextResponse.json({ error: 'Unexpected error while extracting form fields.' }, { status: 500 });
  }
}