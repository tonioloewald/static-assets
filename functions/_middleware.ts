/*
WHO MAY READ THE CDN FROM A PAGE (Cloudflare Pages middleware, runs on every request).

Cross-origin reads are allowed only from our own sites and from development:
*.tosijs.net, localhost / 127.0.0.1 / [::1] / tosi.local on any port, a private
network address (a headset loads the dev server by the Mac's LAN IP, which
changes), and this project's own *.pages.dev previews. Tonio, 2026-10-31: "They'll
all be on .tosijs.net sites for the time being." A new consumer on another domain
is added HERE.

This is NOT access control. CORS decides whether another site's JavaScript may READ
a file; anyone can still fetch the URL directly. It stops other sites building on
our CDN, nothing more. A licence that forbids extractable copies is not met by it
(see assets/awbmecreations/metadata.json).

`_headers` cannot do this: it sends one fixed value, and Access-Control-Allow-Origin
carries a single origin or `*`. So the origin is checked here and echoed back, with
`Vary: Origin` so a cache never hands one origin's answer to another. The rest of
the headers (credit, licence, Expose-Headers, Cache-Control) still come from
`_headers`, which mirror.ts generates.
*/

const ALLOWED: RegExp[] = [
  /^https:\/\/([a-z0-9-]+\.)*tosijs\.net$/,
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|tosi\.local)(:\d+)?$/,
  /^https?:\/\/(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?$/,
  /^https:\/\/([a-z0-9-]+\.)*cdn-tosijs\.pages\.dev$/,
]

export const allowedOrigin = (origin: string | null): boolean =>
  origin != null && ALLOWED.some((re) => re.test(origin))

interface Context {
  request: Request
  next: () => Promise<Response>
}

export const onRequest = async ({ request, next }: Context): Promise<Response> => {
  const origin = request.headers.get('Origin')
  const ok = allowedOrigin(origin)

  if (request.method === 'OPTIONS') {
    const headers = new Headers({ Vary: 'Origin' })
    if (ok) {
      headers.set('Access-Control-Allow-Origin', origin!)
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      const asked = request.headers.get('Access-Control-Request-Headers')
      if (asked) headers.set('Access-Control-Allow-Headers', asked)
      headers.set('Access-Control-Max-Age', '86400')
    }
    return new Response(null, { status: ok ? 204 : 403, headers })
  }

  const res = await next()
  const out = new Response(res.body, res)
  out.headers.delete('Access-Control-Allow-Origin')
  if (ok) out.headers.set('Access-Control-Allow-Origin', origin!)
  out.headers.append('Vary', 'Origin')
  return out
}
