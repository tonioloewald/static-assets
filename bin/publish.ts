#!/usr/bin/env bun
/**
 * publish — update ONE thing on the CDN and prove that is all you updated.
 *
 * `bun run build` regenerates everything. That is correct and it is also how you
 * accidentally rewrite the whole CDN: a change to a builder shifts the bytes of
 * every file it produces, every URL gets new content, and every cached copy in
 * every browser is stale — for a year, under our `immutable` cache policy. It
 * has happened once already (adding `size` to node extras rewrote all 56
 * libraries, 7,788 bytes of new JSON in nature-kit alone, while the geometry
 * stayed bit-identical).
 *
 * The alternative — hashed or versioned filenames — trades one problem for a
 * worse one: every consumer URL churns on every rebuild, so links rot and
 * pinned paths break. Long cache lifetimes have this property no matter what
 * you name things.
 *
 * So: keep the URLs stable, and change as few of them as possible.
 *
 *   bun run publish                     what would change if I staged right now
 *   bun run publish "Nature Kit"        rebuild just that, then show the change
 *   bun run publish "Nature Kit" --deploy
 *   bun run publish --deploy            push pending source additions
 *
 * It hashes `public/` before and after, so the report is what actually changed
 * on disk rather than what was supposed to. A `--deploy` that would touch files
 * OUTSIDE the named target refuses and asks for `--force`, because that is the
 * signature of an accidental mass invalidation rather than a targeted update.
 *
 * The generated host config (`_headers`, `robots.txt`) is exempt from that
 * guard: mirror rewrites it from the metadata on every run, so ADDING a
 * namespace changes it without a single asset URL moving. Blocking on that
 * taught you to pass `--force` for the safest operation there is.
 *
 * Cloudflare Pages has no partial deploy — a deployment is a whole-tree
 * snapshot, and an upload of "just one file" would delete the rest of the site.
 * That is fine: Pages skips files whose content it already holds, so a targeted
 * BUILD gives a targeted upload for free. `Uploaded 1 files (63 already
 * uploaded)` is the CDN agreeing with this script.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public')
/**
 * Hashes as of the last deploy THIS script made.
 *
 * Without it the diff only covers changes this run caused, so a full
 * `bun run build` beforehand would leave nothing to report and the whole tree
 * would ship silently — the exact accident this script exists to prevent.
 * Local and gitignored: it records what a machine pushed, not what the repo says.
 */
const STATE = join(ROOT, '.publish-state.json')

const args = process.argv.slice(2)
const DEPLOY = args.includes('--deploy')
const FORCE = args.includes('--force')
const target = args.find((a) => !a.startsWith('--'))

const toPosix = (p: string) => p.split(/[\\/]/).join('/')

/** path → content hash for every file in the deployable tree. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(OUT)) return out
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) rec(abs)
      else {
        out.set(
          toPosix(relative(OUT, abs)),
          createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16)
        )
      }
    }
  }
  rec(OUT)
  return out
}

const run = async (cmd: string[]): Promise<number> => {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}

const mb = (p: string) => {
  try {
    return (statSync(join(OUT, p)).size / 1048576).toFixed(2) + ' MB'
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------

const recorded = existsSync(STATE)
  ? new Map<string, string>(Object.entries(JSON.parse(readFileSync(STATE, 'utf8'))))
  : null
if (!recorded) {
  console.log(
    'publish: no record of a previous deploy from this machine — comparing\n' +
      '         against the tree as it stands, so anything already built and\n' +
      '         staged will not show up as a change.'
  )
}
const before = recorded ?? snapshot()

if (target) {
  console.log(`publish: rebuilding specs matching "${target}"`)
  // convert.ts only wipes derived/ on an UNFILTERED run, so a targeted rebuild
  // leaves every other generated file exactly where it was.
  if ((await run(['bun', 'bin/convert.ts', target])) !== 0) process.exit(1)
} else {
  console.log('publish: staging only (no rebuild) — pass a target to rebuild one')
}
// mirror always re-walks: it is what picks up newly `publish`-ed source files.
if ((await run(['bun', 'bin/mirror.ts'])) !== 0) process.exit(1)

const after = snapshot()

/*
Generated host config, not content.

`mirror.ts` rewrites these from the metadata on EVERY run, so they change
whenever a namespace is ADDED — precisely the case where nothing a consumer
holds has moved at all. Counting them as changed URLs made
`publish <new pack> --deploy` refuse and demand `--force`, which trains you to
reach for `--force` during a routine, safe operation and so blunts the one
guard that matters. They are reported on their own line and never block.

They still count as something to deploy, though: shipping a `_headers`-only
change is exactly how the CORS fix (#3269) reached the CDN.

`firebase.json` is generated the same way, but it lands at the repo root rather
than in `public/`, so it was never part of this diff.
*/
const CONFIG = new Set(['_headers', 'robots.txt'])
const assets = (paths: string[]): string[] => paths.filter((p) => !CONFIG.has(p))

const added = [...after.keys()].filter((p) => !before.has(p)).sort()
const removed = [...before.keys()].filter((p) => !after.has(p)).sort()
const changed = [...after.keys()]
  .filter((p) => before.has(p) && before.get(p) !== after.get(p))
  .sort()
const unchanged = after.size - added.length - changed.length
const touched = [...added, ...changed, ...removed]
const config = touched.filter((p) => CONFIG.has(p)).sort()

console.log('\nchanges to the deployable tree:')
for (const p of assets(added)) console.log(`  + ${p}  ${mb(p)}`)
for (const p of assets(changed)) console.log(`  ~ ${p}  ${mb(p)}`)
for (const p of assets(removed)) console.log(`  - ${p}   (this URL stops resolving)`)
if (!touched.length) {
  console.log('  (nothing — the tree is identical)')
} else if (!assets(touched).length) {
  console.log('  (no asset changed)')
}
if (config.length) {
  console.log(`  host config regenerated: ${config.join(', ')} — no asset URL moves`)
}
console.log(
  `  ${unchanged} file(s) unchanged — their URLs keep serving the same bytes, ` +
    `and stay in cache`
)

/*
Anything modified that the target did not name is the interesting case: it means
a builder changed, not an asset, so EVERY consumer's cached copy of those URLs
just went stale. Worth stopping for, since the whole point of naming a target is
that you expected a small blast radius.
*/
// Compared with punctuation stripped: a target names a SOURCE directory
// ("Nature Kit") while the output it produces is a slug
// ("kenney/libraries/nature-kit.glb"), so a literal substring test calls every
// targeted rebuild a miss.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
// Only CHANGED and REMOVED count as out-of-scope danger. A new file cannot
// invalidate a cache or break a link — nobody holds it yet — so additions
// outside the target are reported but never block.
const outside = target
  ? assets([...changed, ...removed]).filter((p) => !squash(p).includes(squash(target)))
  : []
if (outside.length) {
  console.log(
    `\n  !! ${outside.length} path(s) changed OUTSIDE "${target}" — a builder ` +
      `change rewrites files whose assets did not change:`
  )
  for (const p of outside.slice(0, 8)) console.log(`     ${p}`)
  if (outside.length > 8) console.log(`     … +${outside.length - 8} more`)
}

if (!DEPLOY) {
  console.log('\nnot deployed. Re-run with --deploy to ship this.')
  process.exit(0)
}
if (outside.length && !FORCE) {
  console.error(
    '\nrefusing to deploy: the change is wider than the target.\n' +
      'Re-run with --force if rewriting those URLs is what you meant.'
  )
  process.exit(1)
}
if (!added.length && !changed.length && !removed.length) {
  console.log('\nnothing to deploy.')
  process.exit(0)
}

console.log('\ndeploying…')
const code = await run([
  'bunx',
  'wrangler',
  'pages',
  'deploy',
  'public',
  '--project-name',
  'cdn-tosijs',
])
if (code === 0) {
  // Only on success: a failed upload leaves the CDN on the old tree, and
  // recording the new one would hide the difference from the next run.
  Bun.write(STATE, JSON.stringify(Object.fromEntries(after), null, 0) + '\n')
  console.log(`\nrecorded ${after.size} file hashes for the next publish diff.`)
}
process.exit(code)
