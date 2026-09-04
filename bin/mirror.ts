#!/usr/bin/env bun
/**
 * mirror — assemble the deployable tree and regenerate the host config, both
 * driven by `metadata.json` files so there's ONE source of truth.
 *
 * `derived/` is the shipped tree. Two things put files in it: `bin/convert.ts`
 * BUILDS into it (libraries, conversions, subsets), and a `publish` glob in a
 * metadata.json PUSHES source files into it. `public/` is then that tree plus the
 * generated host config. Source trees are never walked for content to serve — if
 * it is not built and not pushed, it does not exist as far as the CDN is
 * concerned, which is the property that keeps a creator's bundle off the web by
 * construction rather than by vigilance.
 *
 * `metadata.json` may sit in ANY directory under `assets/` and is OVERLAID as you
 * descend the tree — a child's values merge over its ancestors' (headers per-key;
 * excludes accumulate). Fields (all optional):
 *
 *   publish: string[]   globs (relative to the declaring dir; double-star spans
 *                       `/`) of files TO ship — e.g. `*.mp3`, `characters/**`.
 *                       Nothing ships unless a publish glob names it. Accumulate.
 *   exclude: string[]   globs carving holes out of an inherited `publish`.
 *                       Accumulate.
 *   copyright/credit/   convenience attribution; each becomes a literal response
 *   attribution/license header of the same (lowercase) name.
 *   link: string        a URL → a proper `Link: <url>; rel="author"` header.
 *   headers: {k: v}     escape hatch — ANY key→value emitted as a response header
 *                       verbatim (wins over the convenience fields on collision).
 *
 * The rule: whatever ends up in a path's effective `headers` IS set as a response
 * header — so credit/copyright/license/link travel with every byte, inspectable
 * via `curl -I`, no per-file work.
 *
 * Included files are HARDLINKED (no disk duplication on one volume; copy
 * fallback). `derived/`, `public/` and `firebase.json` are all generated — edit
 * the `metadata.json` files, not them. Run `bun run build`.
 */
import {
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
  linkSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

type Meta = {
  publish?: string[]
  exclude?: string[]
  headers?: Record<string, string>
  copyright?: string
  credit?: string
  attribution?: string
  link?: string
  license?: string
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'assets')
const OUT = join(ROOT, 'public')
const DERIVED = join(ROOT, 'derived') // generated glb from bin/convert.ts

const toPosix = (p: string) => p.split(/[\\/]/).join('/')
const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

// Glob → RegExp with gitignore-ish semantics, rooted at `base` (the declaring
// dir). A pattern with NO `/` FLOATS (matches that name at any depth below base);
// one WITH a `/` is anchored to base. `double-star/` spans zero-or-more segments,
// `*` stays within a segment. A plain name also matches everything beneath it, so
// it prunes the whole folder. esc() leaves `*` intact, so translate it here.
const globToRe = (glob: string, base: string): RegExp => {
  const floating = !glob.replace(/\/+$/, '').includes('/')
  const body = esc(glob)
    .replace(/\*\*\//g, '\x00')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '(?:.*/)?')
    .replace(/\x01/g, '.*')
  const prefix = base ? esc(base) + '/' : ''
  const mid = floating ? '(?:.*/)?' : ''
  // case-insensitive: asset extensions/folders vary in case across libraries.
  return new RegExp('^' + prefix + mid + body + '(?:/.*)?$', 'i')
}

const loadMeta = (dir: string): Meta | null => {
  const p = join(dir, 'metadata.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Meta) : null
}

// Fold convenience fields + explicit `headers` into a flat header map. Everything
// here becomes a literal response header; explicit `headers` overrides.
const foldHeaders = (m: Meta): Record<string, string> => {
  const h: Record<string, string> = {}
  if (m.copyright) h.copyright = m.copyright
  if (m.credit) h.credit = m.credit
  if (m.attribution) h.attribution = m.attribution
  if (m.license) h.license = m.license
  if (m.link)
    h.Link = `<${m.link}>; rel="author"${m.credit ? `; title="${m.credit}"` : ''}`
  return { ...h, ...(m.headers ?? {}) }
}

type Rule = { path: string; headers: Record<string, string> }
const rules: Rule[] = []
/**
 * Everything `publish` pushed into derived/ THIS run.
 *
 * Needed because pushing made deletion silent: a source file that is removed, or
 * that a narrowed `publish` glob stops matching, leaves its copy sitting in
 * derived/ — and derived/ is the shipped tree, so the file goes on being served
 * forever. Only a full `rm -rf derived` cleaned it, which is exactly what an
 * incremental publish exists to avoid.
 *
 * Compared against the manifest from last time, so a push that stops happening
 * becomes a deletion. Built output is never in this set and is never touched.
 */
const pushedPaths = new Set<string>()
const PUSHED_MANIFEST = join(DERIVED, '.pushed.json')
let pushed = 0
let unpublished = 0
let files = 0
let hardlinked = 0

const link = (from: string, to: string): void => {
  mkdirSync(dirname(to), { recursive: true })
  try {
    rmSync(to, { force: true })
    linkSync(from, to)
    hardlinked++
  } catch {
    copyFileSync(from, to)
  }
}

/**
 * Walk `assets/` to collect the header rules and to PUSH published files into
 * `derived/`.
 *
 * Publishing is an ALLOWLIST: a file ships only because a `publish` glob named
 * it. Nothing is served for merely existing. This used to be the other way round
 * — everything shipped unless an `exclude` caught it — which put a creator's
 * entire bundle one forgotten pattern away from the CDN, and quietly published
 * whatever new folder appeared in a pack. `exclude` survives only to carve holes
 * out of a `publish` glob.
 *
 * Both accumulate down the tree, anchored to the directory that declared them.
 */
const walk = (
  dir: string,
  inheritedHeaders: Record<string, string>,
  publishes: RegExp[],
  excludes: RegExp[]
): void => {
  const rel = toPosix(relative(SRC, dir))
  const local = loadMeta(dir)

  const localPub = (local?.publish ?? []).map((g) => globToRe(g, rel))
  const localEx = (local?.exclude ?? []).map((g) => globToRe(g, rel))
  const activePub = localPub.length ? [...publishes, ...localPub] : publishes
  const activeEx = localEx.length ? [...excludes, ...localEx] : excludes

  const localHeaders = local ? foldHeaders(local) : {}
  const effective = { ...inheritedHeaders, ...localHeaders }
  if (rel !== '' && Object.keys(localHeaders).length > 0) {
    rules.push({ path: rel, headers: effective })
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name
    if (name === 'metadata.json') continue // build input, not a served asset
    if (name.startsWith('.')) continue // .DS_Store and friends are never assets
    const abs = join(dir, name)
    if (entry.isDirectory()) {
      walk(abs, effective, activePub, activeEx)
    } else {
      const relChild = toPosix(relative(SRC, abs))
      if (!activePub.some((re) => re.test(relChild))) continue
      if (activeEx.some((re) => re.test(relChild))) continue
      link(abs, join(DERIVED, relChild))
      pushedPaths.add(relChild)
      pushed++
    }
  }
}

/**
 * `derived/` IS the shipped tree — built output plus whatever `publish` pushed
 * into it — so staging it is a copy, with no second opinion about what belongs.
 * To stop serving something, stop building or pushing it; there is no filter
 * here to forget.
 */
const stageTree = (root: string): void => {
  if (!existsSync(root)) return
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) rec(abs)
      else {
        link(abs, join(OUT, toPosix(relative(root, abs))))
        files++
      }
    }
  }
  rec(root)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
if (existsSync(SRC)) walk(SRC, {}, [], [])
else console.warn('mirror: no assets/ directory yet — nothing to stage.')

// Retire pushes that no longer happen, BEFORE staging, so a deletion reaches
// public/ in the same run rather than one run late.
if (existsSync(PUSHED_MANIFEST)) {
  const previous: string[] = JSON.parse(readFileSync(PUSHED_MANIFEST, 'utf8'))
  for (const rel of previous) {
    if (pushedPaths.has(rel)) continue
    const stale = join(DERIVED, rel)
    if (!existsSync(stale)) continue
    rmSync(stale, { force: true })
    unpublished++
    // Take the directory with it if that was the last thing in it, so an
    // abandoned namespace leaves no empty shell behind.
    let dir = dirname(stale)
    while (dir.startsWith(DERIVED) && dir !== DERIVED && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true })
      dir = dirname(dir)
    }
  }
}
if (pushedPaths.size || existsSync(PUSHED_MANIFEST)) {
  mkdirSync(DERIVED, { recursive: true })
  writeFileSync(PUSHED_MANIFEST, JSON.stringify([...pushedPaths].sort(), null, 0) + '\n')
}

stageTree(DERIVED)

// ---- generate host config (Cloudflare _headers + firebase.json) -----------
// Shallow rules first so deeper (more specific) namespace rules cascade last and
// win on any key collision. The common block carries CORS/cache/noindex; both host
// formats are generated from the SAME rules so the deploy target is a DNS choice.
rules.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
const COMMON: [string, string][] = [
  ['Access-Control-Allow-Origin', '*'],
  ['Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'],
  ['Cache-Control', 'public, max-age=31536000, immutable'],
  ['X-Robots-Tag', 'noindex'],
]

// Cloudflare Pages / Netlify `_headers` (+ robots.txt) live INSIDE public/.
const block = (pattern: string, hs: [string, string][]) =>
  pattern + '\n' + hs.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n'
const headersFile = [
  block('/*', COMMON),
  ...rules.map((r) => block(`/${r.path}/*`, Object.entries(r.headers))),
].join('\n')
writeFileSync(join(OUT, '_headers'), headersFile)
writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n')

// firebase.json (Firebase Hosting) at repo root — the alternate deploy target.
const firebase = {
  hosting: {
    public: 'public',
    cleanUrls: false,
    trailingSlash: false,
    ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
    headers: [
      { source: '**', headers: COMMON.map(([key, value]) => ({ key, value })) },
      ...rules.map((r) => ({
        source: `/${r.path}/**`,
        headers: Object.entries(r.headers).map(([key, value]) => ({ key, value })),
      })),
    ],
  },
}
writeFileSync(join(ROOT, 'firebase.json'), JSON.stringify(firebase, null, 2) + '\n')

console.log(
  `mirror: ${pushed} pushed → derived/, ` +
    (unpublished ? `${unpublished} stale push(es) removed, ` : '') +
    `${files} file(s) staged → public/ ` +
    `(${hardlinked} hardlinked) · ${rules.length} attributed namespace(s) ` +
    `→ _headers + firebase.json`
)
