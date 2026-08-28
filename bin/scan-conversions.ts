#!/usr/bin/env bun
/**
 * scan-conversions — discover source models with no glb/gltf equivalent and write
 * `convert` specs into each pack's `metadata.json`, so the build can run them
 * automatically (see bin/convert.ts). Idempotent, reviewable, hand-editable.
 *
 * Coverage is PACK-SCOPED: an fbx is "covered" if a glb/gltf with the same
 * basename exists anywhere in the same top-level pack (Kenney ships parallel
 * `FBX format/` + `GLB format/` folders, so a model's glb isn't next to its fbx).
 *
 * Two spec shapes are emitted:
 *   - merge  { output, model, animations[] }  — a pack laid out as Model(s)/ +
 *              Animations/ becomes ONE glb per model with named animation clips.
 *   - single { output, input }                — any other uncovered fbx (e.g.
 *              static accessories) → a one-to-one glb.
 *
 * Dry-run by default (prints what it WOULD write). Pass `--write` to apply.
 *
 * Scans `assets/kenney/3D assets/<pack>/…`; point PACKS_ROOT elsewhere for other
 * libraries.
 *
 * `--libraries` runs a different scan over the same tree: every pack that ships
 * a folder of individual models gets a `library` spec (see bin/library-glb.ts)
 * so the pack publishes as ONE glb instead of a few hundred. It only ever fills
 * in `slug` and `from` — hand-authored `categories`, `exclude` and `subsets`
 * survive a re-scan untouched, because those are the parts a person curates.
 */
import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKS_ROOT = join(ROOT, 'assets', 'kenney', '3D assets')
const WRITE = process.argv.includes('--write')

type Spec =
  | { output: string; model: string; animations: string[] }
  | { output: string; input: string }

const toPosix = (p: string) => p.split(/[\\/]/).join('/')
const stem = (p: string) => basename(p, extname(p))
const ext = (p: string) => extname(p).toLowerCase()

const walk = (dir: string, pred: (p: string) => boolean, out: string[] = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
// fbx directly inside a dir (non-recursive), sorted.
const fbxIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => ext(n) === '.fbx' && statSync(join(dir, n)).isFile())
        .sort()
        .map((n) => join(dir, n))
    : []

const scanPack = (pack: string): Spec[] => {
  const glbNames = new Set(
    walk(pack, (p) => ['.glb', '.gltf'].includes(ext(p))).map((p) =>
      stem(p).toLowerCase()
    )
  )
  const allFbx = walk(pack, (p) => ext(p) === '.fbx')
  const uncovered = new Set(
    allFbx.filter((f) => !glbNames.has(stem(f).toLowerCase()))
  )
  if (uncovered.size === 0) return []

  const rel = (p: string) => toPosix(relative(pack, p))
  const specs: Spec[] = []
  const consumed = new Set<string>()

  // Character MERGE generation (Model/ + Animations/ → one animated glb) is DISABLED:
  // Kenney's animation FBX are mesh-less clips with a different bind pose than the
  // model FBX, so the merge produces rest-pose retargeting garbage (T-pose + partial
  // motion). Use omnidude for animated characters; re-enable (flip GENERATE_MERGES)
  // if the source is fixed or driven from the .blend files. Accessories (single
  // conversions below) are unaffected — they're static props. See CONTENT-MAP.md.
  const GENERATE_MERGES = false
  if (GENERATE_MERGES) {
    const modelDir = ['Model', 'Models']
      .map((d) => join(pack, d))
      .find((d) => fbxIn(d).length > 0)
    const anims = fbxIn(join(pack, 'Animations')).filter((f) => uncovered.has(f))
    if (modelDir && anims.length > 0) {
      for (const model of fbxIn(modelDir)) {
        specs.push({
          output: `${stem(model)}.glb`,
          model: rel(model),
          animations: anims.map(rel),
        })
        consumed.add(model)
      }
      anims.forEach((a) => consumed.add(a))
    }
  }

  // everything else uncovered → one-to-one
  for (const f of [...uncovered].sort()) {
    if (consumed.has(f)) continue
    specs.push({ output: rel(f).replace(/\.fbx$/i, '.glb'), input: rel(f) })
  }
  return specs
}

/**
 * A pack marked `"shelved": true` is content we deliberately do NOT ship, and
 * this scan must not undo that.
 *
 * Emptying a pack's `convert` array is not enough on its own: the next
 * `--write` would rediscover the same uncovered fbx and put the specs straight
 * back. That mattered little when a build only produced files; now that
 * `derived/` IS the shipped tree, a regenerated spec is a republished asset.
 */
const isShelved = (pack: string): boolean => {
  const mp = join(pack, 'metadata.json')
  return existsSync(mp) && JSON.parse(readFileSync(mp, 'utf8')).shelved === true
}

// ------------------------------------------------------------- libraries ---

/** `Nature Kit (Classic)` → `nature-kit-classic`, `City Kit - Commercial` → `city-kit-commercial`. */
export const slugify = (name: string): string =>
  name
    .replace(/[()]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

/** Folders of ready-to-merge models. Kenney names them inconsistently by vintage. */
const MODEL_DIR_RE = /^(glb|gltf) format$/i
const modelDirs = (pack: string): string[] => {
  const found: string[] = []
  const rec = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (!statSync(p).isDirectory()) continue
      if (
        MODEL_DIR_RE.test(n) &&
        readdirSync(p).some((f) => ['.glb', '.gltf'].includes(ext(f)))
      ) {
        found.push(toPosix(relative(pack, p)))
      } else rec(p)
    }
  }
  rec(pack)
  // `GLB format` last: where a pack ships both, the two hold largely DIFFERENT
  // models, and on the few names in common the GLB is the newer export.
  return found.sort((a, b) => Number(/glb format$/i.test(a)) - Number(/glb format$/i.test(b)))
}

if (process.argv.includes('--libraries')) {
  let packs = 0
  let models = 0
  for (const name of readdirSync(PACKS_ROOT).sort()) {
    const pack = join(PACKS_ROOT, name)
    if (!statSync(pack).isDirectory()) continue
    if (isShelved(pack)) {
      console.log(`${name}: shelved — skipped`)
      continue
    }
    const from = modelDirs(pack)
    if (!from.length) {
      console.log(`${name}: no model folder — skipped`)
      continue
    }
    const count = new Set(
      from.flatMap((d) =>
        readdirSync(join(pack, d))
          .filter((f) => ['.glb', '.gltf'].includes(ext(f)))
          .map(stem)
      )
    ).size
    packs++
    models += count

    const mp = join(pack, 'metadata.json')
    const meta = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {}
    // Preserve curation; only (re)assert what discovery owns.
    meta.library = { ...(meta.library ?? {}), slug: slugify(name), from }
    console.log(
      `${name}: ${count} models → ${meta.library.slug}.glb  [${from.join(', ')}]` +
        (meta.library.categories ? '  (+category rules)' : '') +
        (meta.library.subsets ? `  (+${meta.library.subsets.length} subset)` : '')
    )
    if (WRITE) writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n')
  }
  console.log(
    `\nscan: ${packs} librar${packs === 1 ? 'y' : 'ies'}, ${models} models. ` +
      (WRITE ? 'metadata.json written.' : 'dry-run — pass --write to apply.')
  )
  process.exit(0)
}

let touched = 0
for (const name of readdirSync(PACKS_ROOT)) {
  const pack = join(PACKS_ROOT, name)
  if (!statSync(pack).isDirectory()) continue
  if (isShelved(pack)) continue
  const specs = scanPack(pack)
  if (specs.length === 0) continue
  touched++

  const mp = join(pack, 'metadata.json')
  const meta = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {}
  const merges = specs.filter((s) => 'model' in s).length
  console.log(
    `\n${name}: ${specs.length} spec(s) — ${merges} merge, ${specs.length - merges} single`
  )
  for (const s of specs.slice(0, 6))
    console.log(
      '  ' +
        ('model' in s
          ? `merge  ${s.output}  ←  ${s.model} + ${s.animations.length} clips`
          : `single ${s.output}  ←  ${s.input}`)
    )
  if (specs.length > 6) console.log(`  … +${specs.length - 6} more`)

  if (WRITE) {
    meta.convert = specs
    writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n')
  }
}
console.log(
  `\nscan: ${touched} pack(s) need conversion. ${WRITE ? 'metadata.json written.' : 'dry-run — pass --write to apply.'}`
)
