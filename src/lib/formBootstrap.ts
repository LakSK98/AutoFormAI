/**
 * Extracts the `FB_PUBLIC_LOAD_DATA_` bootstrap payload that Google Forms
 * embeds in every viewform page. Kept separate from the route so it can be
 * unit tested.
 */

/**
 * Pull the bootstrap array out of the page by matching brackets rather than
 * with a lazy regex — the payload contains `];` inside string values, which
 * truncates a naive match.
 */
export function extractBootstrapArray(html: string): any | null {
  const marker = 'FB_PUBLIC_LOAD_DATA_';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf('[', markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
