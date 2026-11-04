export function unescapeJsString(s: string): string {
  return s.replace(/\\(["\\])/g, '$1')
}

export const JSON_STRING_CHAR = String.raw`(?:[^"\\]|\\.)`

export function decodeJsonString(body: string): string {
  try { return JSON.parse(`"${body}"`) as string } catch { return body }
}
