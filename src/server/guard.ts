// The API has no login of its own, so any website open in the same browser
// could otherwise drive it. Browsers mark cross-site requests with
// Sec-Fetch-Site, and a page on another site can't send a JSON body without a
// CORS preflight this server never answers. Writes need both checks to pass.
export function isCrossSiteWrite(method: string, header: (name: string) => string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  const site = header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return true
  return !/^application\/json\b/i.test(header('content-type') ?? '')
}

export const isSteamId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
