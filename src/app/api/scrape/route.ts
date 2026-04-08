import * as cheerio from 'cheerio';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string' || !url.startsWith('https://docs.google.com/forms/')) {
      return NextResponse.json({ error: 'A valid Google Form URL is required (must start with https://docs.google.com/forms/).' }, { status: 400 });
    }

    // Ensure it's the viewform link for scraping
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

    const fields: { name: string; title: string; type: string }[] = [];

    // Approach 1: Extremely robust extraction using Google's raw form data object
    const match = html.match(/var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);\s*<\/script>/s);
    if (match && match[1]) {
      try {
        const data = JSON.parse(match[1]);
        const questionsArray = data[1]?.[1] || [];
        
        for (const q of questionsArray) {
           const title = q[1];
           const typeCode = q[3];
           const type = typeCode === 0 ? 'text' : typeCode === 1 ? 'textarea' : typeCode === 2 || typeCode === 3 ? 'radio' : typeCode === 4 ? 'checkbox' : 'text';
           
           const entryArr = q[4];
           if (entryArr && entryArr[0] && entryArr[0][0]) {
              const entryId = entryArr[0][0];
              const cleanTitle = typeof title === 'string' ? title.replace(/\*$/, '').trim() : `Field ${entryId}`;
              fields.push({
                 name: `entry.${entryId}`,
                 title: cleanTitle || `Field ${entryId}`,
                 type
              });
           }
        }
      } catch(e) {
        console.error("Failed to parse FB_PUBLIC_LOAD_DATA_", e);
      }
    }

    // Approach 2: Fallback to Cheerio if Approach 1 failed
    if (fields.length === 0) {
      $('div[role="listitem"], div.geS5n').each((_, elem) => {
        let titleElement = $(elem).find('div[role="heading"], span.M7eMe');
        let title = titleElement.text().trim();
  
        let input = $(elem).find('input[name^="entry."], textarea[name^="entry."]');
        let name = input.attr('name');
  
        if (!name) {
           const hiddenInput = $(elem).find('input[type="hidden"][name^="entry."]');
           if (hiddenInput.length && hiddenInput.attr('name')) {
              name = hiddenInput.attr('name');
           }
        }

      if (name && !fields.find(f => f.name === name)) {
        // Determine input type
        let type = 'text';
        if ($(elem).find('textarea').length > 0) type = 'textarea';
        else if ($(elem).find('div[role="radio"]').length > 0 || $(elem).find('input[type="radio"]').length > 0) type = 'radio';
        else if ($(elem).find('div[role="checkbox"]').length > 0 || $(elem).find('input[type="checkbox"]').length > 0) type = 'checkbox';
        else if ($(elem).find('div[role="listbox"]').length > 0 || $(elem).find('select').length > 0) type = 'dropdown';

        // Clean up the trailing required asterisk from the title
        if (title.endsWith('*')) title = title.slice(0, -1).trim();

        fields.push({ 
          name, 
          title: title || `Unknown Field (${name})`, 
          type 
        });
      }
    });
    }

    // Fallback if listitem failed, very basic regex or Cheerio scanning
    if (fields.length === 0) {
      const inputs = $('input[name^="entry."], textarea[name^="entry."]');
      inputs.each((_, el) => {
         const name = $(el).attr('name');
         if (name && !fields.find(f => f.name === name)) {
            fields.push({
               name,
               title: `Unknown Field (${name})`,
               type: el.name === 'textarea' ? 'textarea' : 'text'
            });
         }
      });
    }

    // Extract form tokens like fbzx
    const fbzxMatch = html.match(/name="fbzx" value="(.*?)"/);
    const fbzx = fbzxMatch ? fbzxMatch[1] : "";

    let formTitle = $('div[role="heading"][aria-level="1"]').text().trim() || $('title').text().replace(' - Google Forms', '').trim() || 'Untitled Form';
    
    // Check if we were redirected to a login page (only check for actual login page URLs)
    if (formTitle.toLowerCase().includes('sign-in') || html.includes('ServiceLogin') || html.includes('accounts.google.com/v3/signin')) {
       return NextResponse.json({ 
          error: 'This form seems to be private or requires login. Please make sure the form is public and "Restrict to users in [Organization]" is unchecked in form settings.' 
       }, { status: 403 });
    }

    if (fields.length === 0 && !html.includes('entry.')) {
        return NextResponse.json({ 
          error: 'No fields could be discovered. Please ensure the form URL is correct and public.' 
       }, { status: 404 });
    }

    // We also need the exact form submission action URL
    // Basically it's the viewform URL with `viewform` replaced by `formResponse`
    const submitUrl = viewUrl.replace('/viewform', '/formResponse');

    return NextResponse.json({ 
      title: formTitle, 
      submitUrl,
      fields,
      fbzx
    });

  } catch (error: any) {
    console.error('Error scraping form:', error);
    return NextResponse.json({ error: 'An unexpected error occurred while extracting form fields.' }, { status: 500 });
  }
}
