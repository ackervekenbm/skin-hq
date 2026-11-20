import { isIP } from 'node:net'

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

// DNS rebinding: a hostile page can point its own name at this server, and the
// browser then treats it as same-origin. The name it uses still arrives in the
// Host header, so only answer to localhost, IP addresses (a rebound page always
// sends its own name, never an IP) and names the operator listed in
// SKINHQ_ALLOWED_HOSTS.
export function parseAllowedHosts(env: string | undefined): Set<string> {
  return new Set((env ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
}

export function isAllowedHost(host: string | undefined, allowed: Set<string>): boolean {
  if (!host) return false
  // Strip the port: "[::1]:3000" → "::1", "nas:8090" → "nas". IPv6 always comes bracketed.
  const name = (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')).toLowerCase()
  return name === 'localhost' || isIP(name) !== 0 || allowed.has(name)
}
