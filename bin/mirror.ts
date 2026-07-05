#!/usr/bin/env bun
/**
 * mirror — stage `assets/` → `public/` (the deployable tree) and regenerate
 * `firebase.json`, both driven by `metadata.json` files so there's ONE source of
 * truth.
 *
 * `metadata.json` may sit in ANY directory under `assets/` and is OVERLAID as you
 * descend the tree — a child's values merge over its ancestors' (headers per-key;
 * excludes accumulate). Fields (all optional):
 *
 *   exclude: string[]   globs (relative to the declaring dir; double-star spans
 *                       `/`) of files/dirs NOT to mirror — e.g. `Archive`,
 *                       `Unity/**`. A plain name prunes the whole folder. Accumulate.
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
 * Included files are HARDLINKED into `public/` (no disk duplication on one volume;
 * copy fallback). `public/` and `firebase.json` are generated — edit the
 * `metadata.json` files, not them. Run `bun run build`.
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
  return new RegExp('^' + prefix + mid + body + '(?:/.*)?$')
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
let files = 0
let hardlinked = 0

const walk = (
  dir: string,
  inheritedHeaders: Record<string, string>,
  excludes: RegExp[]
): void => {
  const rel = toPosix(relative(SRC, dir))
  const local = loadMeta(dir)

  const localEx = (local?.exclude ?? []).map((g) => globToRe(g, rel))
  const activeEx = localEx.length ? [...excludes, ...localEx] : excludes
  const excluded = (p: string) => activeEx.some((re) => re.test(p))
  // Prune the whole dir if it — or its contents — are excluded.
  if (rel !== '' && (excluded(rel) || excluded(rel + '/__probe__'))) return

  const localHeaders = local ? foldHeaders(local) : {}
  const effective = { ...inheritedHeaders, ...localHeaders }
  if (rel !== '' && Object.keys(localHeaders).length > 0) {
    rules.push({ path: rel, headers: effective })
  }

  for (const name of readdirSync(dir)) {
    if (name === 'metadata.json') continue // build input, not a served asset
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      walk(abs, effective, activeEx)
    } else {
      const relChild = toPosix(relative(SRC, abs))
      if (excluded(relChild)) continue
      const dest = join(OUT, relChild)
      mkdirSync(dirname(dest), { recursive: true })
      try {
        linkSync(abs, dest)
        hardlinked++
      } catch {
        copyFileSync(abs, dest)
      }
      files++
    }
  }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
if (existsSync(SRC)) walk(SRC, {}, [])
else console.warn('mirror: no assets/ directory yet — nothing to stage.')

// ---- generate firebase.json ----------------------------------------------
// Shallow rules first so deeper (more specific) namespace rules cascade last and
// win on any key collision. The common `**` block carries CORS/cache/noindex.
rules.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
const firebase = {
  hosting: {
    public: 'public',
    cleanUrls: false,
    trailingSlash: false,
    ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
    headers: [
      {
        source: '**',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, HEAD, OPTIONS' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'X-Robots-Tag', value: 'noindex' },
        ],
      },
      ...rules.map((r) => ({
        source: `/${r.path}/**`,
        headers: Object.entries(r.headers).map(([key, value]) => ({ key, value })),
      })),
    ],
  },
}
writeFileSync(join(ROOT, 'firebase.json'), JSON.stringify(firebase, null, 2) + '\n')

console.log(
  `mirror: ${files} file(s) staged (${hardlinked} hardlinked) · ` +
    `${rules.length} attributed namespace(s) → firebase.json`
)
