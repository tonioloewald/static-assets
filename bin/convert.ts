#!/usr/bin/env bun
/**
 * convert — execute the `convert` specs found in `assets/**​/metadata.json` via
 * Blender headless (see bin/blender-export.py), CACHED by input signature. Outputs
 * land in a generated `derived/` tree mirroring the asset layout; `bin/mirror.ts`
 * overlays that into `public/`.
 *
 * Spec shapes (paths relative to the metadata.json's directory):
 *   merge  { output, model, animations[] }  → one glb with named animation clips
 *   single { output, input }                → one-to-one glb
 *   subset { output, input, clips[] }       → a glb with only those clips, NO Blender
 *
 * And, separately from the `convert` array, a `library` object packs a whole
 * pack of individual models into ONE glb (+ optional curated `subsets` cut from
 * it) — also no Blender. See bin/library-glb.ts.
 *
 * Caching: a spec is rebuilt only when its inputs (size+mtime) or the spec itself
 * change — so re-runs are near-instant. Set BLENDER to override the binary path.
 * Pass a substring to limit to matching packs: `bun bin/convert.ts Protagonists`.
 */
import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  linkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { subsetGlb } from './subset-glb'
import {
  buildLibrary,
  subsetLibrary,
  loadModel,
  type LibrarySpec,
} from './library-glb'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'assets')
const DERIVED = join(ROOT, 'derived')
const CACHE = join(ROOT, '.cache')
const PY = join(ROOT, 'bin', 'blender-export.py')
const BLENDER =
  process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender'
const only = process.argv[2]

type Spec = {
  output: string
  model?: string
  animations?: string[]
  input?: string
  /**
   * Clip names to keep from `input` (a GLB). Presence of this makes the spec a
   * SUBSET, which is glTF surgery rather than a Blender build — see
   * `bin/subset-glb.ts`. Names may end in `*` to keep a family.
   */
  clips?: string[]
  /**
   * Extra GLBs to take additional clips from, grafted onto `input`'s skeleton.
   *
   * For libraries split across several files: Quaternius' UAL ships as two
   * megafiles and the climb clips straddle them — `ClimbLedge` in UAL1,
   * `ClimbUp_1m`/`_2m` in UAL2 — so a curated set that wants both cannot come
   * from one source. The alternative was shipping two GLBs and making every
   * consumer load both.
   *
   * Only valid where the skeletons genuinely match; `graftClips` maps channels
   * by node NAME and throws rather than guessing, because a wrong index does
   * not fail, it animates the wrong bone. Verified for the UAL pair: identical
   * node and joint lists, identical order, zero bind-pose differences.
   */
  merge?: Array<{ input: string; clips: string[] }>
}

/**
 * A `library` spec packs a whole pack of individual models into one glb.
 * `subsets` cut smaller libraries out of that one — the same idea as subsetting
 * an animation megafile, one level up. See bin/library-glb.ts.
 */
type LibrarySpecFull = LibrarySpec & {
  slug: string
  subsets?: { slug: string; keep: string[] }[]
}
type LibJob = {
  dir: string
  spec: LibrarySpecFull
  /** credit/license/link inherited down the tree, written into asset.extras. */
  attribution: Record<string, string>
}

const jobs: { dir: string; specs: Spec[]; scale: number }[] = []
const libJobs: LibJob[] = []
const ATTRIBUTION_FIELDS = ['copyright', 'credit', 'attribution', 'license', 'link'] as const

const collect = (dir: string, attribution: Record<string, string> = {}) => {
  const mp = join(dir, 'metadata.json')
  let attr = attribution
  if (existsSync(mp)) {
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    // Attribution overlays as you descend, exactly as it does for the response
    // headers in mirror.ts — so a library carries its pack's credit even though
    // the credit is declared several directories above the spec.
    const local: Record<string, string> = {}
    for (const f of ATTRIBUTION_FIELDS) if (m[f]) local[f] = m[f]
    for (const f of ATTRIBUTION_FIELDS) if (m.headers?.[f]) local[f] = m.headers[f]
    if (Object.keys(local).length) attr = { ...attr, ...local }
    if (Array.isArray(m.convert) && m.convert.length)
      // pack-level `scale` (uniform factor) → applied to every model in the pack.
      jobs.push({ dir, specs: m.convert, scale: Number(m.scale) || 1 })
    if (m.library?.slug && m.library?.from?.length)
      libJobs.push({ dir, spec: m.library, attribution: attr })
  }
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) collect(p, attr)
  }
}
if (existsSync(SRC)) collect(SRC)

// A full run (no pack filter) regenerates the whole derived/ tree, so clear stale
// outputs first — otherwise specs removed from metadata (e.g. shelved character
// merges) would linger in derived/ and get mirrored past the excludes.
if (!only) rmSync(DERIVED, { recursive: true, force: true })

const sig = (files: string[]) =>
  createHash('sha256')
    .update(
      files.map((f) => `${f}:${statSync(f).size}:${statSync(f).mtimeMs}`).join('|')
    )
    .digest('hex')
    .slice(0, 16)

// Blender 5.0's glTF exporter won't scale on export (armature object scale is reset,
// scene unit scale ignored), so bake a uniform scale into the exported glb by scaling
// its scene ROOT nodes — a self-contained JSON edit that scales geometry, skeleton,
// and animation translations together.
const scaleGlb = (path: string, s: number): void => {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const scene = json.scenes[json.scene ?? 0]
  for (const idx of scene.nodes) {
    const node = json.nodes[idx]
    if (node.matrix) {
      for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) node.matrix[c * 4 + r] *= s
    } else {
      const cur = node.scale ?? [1, 1, 1]
      node.scale = [cur[0] * s, cur[1] * s, cur[2] * s]
      if (node.translation) node.translation = node.translation.map((v: number) => v * s)
    }
  }
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')])
  const bin = buf.subarray(20 + jsonLen) // bin chunk (header + data), unchanged
  const out = Buffer.alloc(20 + jsonBuf.length + bin.length)
  buf.copy(out, 0, 0, 12) // magic + version
  out.writeUInt32LE(out.length, 8) // total length
  out.writeUInt32LE(jsonBuf.length, 12) // JSON chunk length
  out.writeUInt32LE(0x4e4f534a, 16) // "JSON"
  jsonBuf.copy(out, 20)
  bin.copy(out, 20 + jsonBuf.length)
  writeFileSync(path, out)
}

// Flatten specs into a task list, tagging which need a Blender build (uncached).
type Task = {
  rel: string
  output: string
  /** Absolute source directory — merge inputs are resolved against it. */
  dir: string
  /** `subset` skips Blender entirely; see the note where the pool splits. */
  kind: 'blender' | 'subset'
  spec: Spec
  inputs: string[]
  args: string[]
  scale: number
  cacheGlb: string
  outAbs: string
  cached: boolean
  failed?: boolean
}
const tasks: Task[] = []
for (const { dir, specs, scale } of jobs) {
  const rel = relative(SRC, dir)
  if (only && !rel.includes(only)) continue
  for (const spec of specs) {
    const inputs = (
      spec.model ? [spec.model, ...(spec.animations ?? [])] : [spec.input!]
    ).map((i) => join(dir, i))
    // Merge sources are inputs in every sense that matters: their absence is a
    // failed build, and a change to one must invalidate the cached output.
    inputs.push(...(spec.merge ?? []).map((m) => join(dir, m.input)))
    if (inputs.some((f) => !existsSync(f))) {
      console.warn(`  skip ${rel}/${spec.output} — missing input`)
      continue
    }
    const kind: Task['kind'] = spec.clips ? 'subset' : 'blender'
    const key =
      (spec.clips ? 'subset' : spec.model ? 'merge' : 'single') +
      '-' +
      sig(inputs) +
      '-' +
      createHash('sha256')
        .update(JSON.stringify(spec) + '@' + scale)
        .digest('hex')
        .slice(0, 8)
    const cacheGlb = join(CACHE, key + '.glb')
    tasks.push({
      rel,
      output: spec.output,
      dir,
      kind,
      spec,
      inputs,
      scale,
      args: spec.model
        ? ['merge', cacheGlb, ...inputs]
        : ['single', inputs[0], cacheGlb],
      cacheGlb,
      outAbs: join(DERIVED, rel, spec.output),
      cached: existsSync(cacheGlb),
    })
  }
}

// Build the uncached specs through a pool of parallel Blender processes.
const pexec = promisify(execFile)
const JOBS =
  Number(process.env.CONVERT_JOBS) || Math.min(8, Math.max(1, os.cpus().length - 1))
const toBuild = tasks.filter((t) => !t.cached)
if (toBuild.length) mkdirSync(CACHE, { recursive: true })

let built = 0
const runPool = async <T>(items: T[], n: number, fn: (x: T) => Promise<void>) => {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++])
    })
  )
}
await runPool(toBuild, JOBS, async (t) => {
  console.log(`  build ${t.rel}/${t.output}`)
  try {
    if (t.kind === 'subset') {
      /*
      NO BLENDER. A subset is JSON surgery on a glTF plus a rebuild of its
      binary blob, so spawning Blender would be by far the slowest part of an
      otherwise instant operation — and Blender is exactly what falls over on
      packs this size (Quaternius' 20 MB / 120-clip libraries crash the
      exporter). It also cannot round-trip the data through an importer and an
      exporter that each have opinions about it.

      `scale` is deliberately NOT applied: the input is already a built glb at
      the scale it was authored, and a subset must not silently resize it.
      */
      const r = await subsetGlb(
        t.inputs[0],
        t.cacheGlb,
        t.spec.clips!,
        (t.spec.merge ?? []).map((m) => ({
          input: join(t.dir, m.input),
          clips: m.clips,
        }))
      )
      console.log(
        `    ${r.total} → ${r.kept} clips, ` +
          `${(r.from / 1048576).toFixed(1)} → ${(r.to / 1048576).toFixed(2)} MB`
      )
    } else {
      await pexec(
        BLENDER,
        ['--background', '--factory-startup', '--python', PY, '--', ...t.args],
        { maxBuffer: 1 << 26 }
      )
      if (t.scale !== 1) scaleGlb(t.cacheGlb, t.scale)
    }
    built++
  } catch (e: any) {
    t.failed = true
    const tail = (e.stderr?.toString?.() ?? String(e)).trim().split('\n').slice(-2).join(' ')
    console.error(`  FAILED ${t.rel}/${t.output} — ${tail}`)
  }
})

// Link every successful output (freshly built + previously cached) into derived/.
let done = 0
for (const t of tasks) {
  if (t.failed || !existsSync(t.cacheGlb)) continue
  mkdirSync(dirname(t.outAbs), { recursive: true })
  try {
    rmSync(t.outAbs, { force: true })
    linkSync(t.cacheGlb, t.outAbs)
  } catch {
    copyFileSync(t.cacheGlb, t.outAbs)
  }
  done++
}
console.log(
  `convert: ${done} output(s) — ${built} built (${JOBS}× parallel), ` +
    `${tasks.length - toBuild.length} cached → derived/`
)

// ---- libraries -------------------------------------------------------------
/*
Whole packs merged into one glb, then optional curated subsets cut from that.
No Blender: like `subset`, this is glTF surgery (see bin/library-glb.ts), so it
runs in-process and the cache makes re-runs instant.

Libraries land at `derived/<namespace>/libraries/<slug>.glb` — deliberately NOT
beside their sources. The source layout is Kenney's (spaces, `Models/GLB
format/`, a folder per pack); the published layout is ours, and a consumer
should not have to know the former to use the latter.
*/
const LIBRARY_DIR = 'libraries'
const toPosix = (p: string) => p.split(/[\\/]/).join('/')
const walkFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}
const linkOut = (from: string, to: string): void => {
  mkdirSync(dirname(to), { recursive: true })
  try {
    rmSync(to, { force: true })
    linkSync(from, to)
  } catch {
    copyFileSync(from, to)
  }
}
const mb = (n: number) => (n / 1048576).toFixed(2) + ' MB'

let libBuilt = 0
let libCached = 0
let libFailed = 0
let libModels = 0
for (const job of libJobs) {
  const rel = relative(SRC, job.dir)
  if (only && !rel.includes(only)) continue
  const namespace = toPosix(rel).split('/')[0]
  // Signature over EVERY file in the source dirs, not just the models: a kit's
  // shared texture and a .gltf's .bin sidecar are inputs to the library too, and
  // a change to either must invalidate the cache.
  const inputs = job.spec.from.flatMap((d) => walkFiles(join(job.dir, d))).sort()
  if (!inputs.length) {
    console.warn(`  skip ${job.spec.slug} — no source models`)
    continue
  }
  const specHash = createHash('sha256')
    .update(JSON.stringify({ spec: job.spec, attribution: job.attribution }))
    .digest('hex')
    .slice(0, 8)
  const key = `library-${sig(inputs)}-${specHash}`
  const cacheGlb = join(CACHE, key + '.glb')
  const outAbs = join(DERIVED, namespace, LIBRARY_DIR, job.spec.slug + '.glb')

  try {
    if (existsSync(cacheGlb)) {
      libCached++
    } else {
      mkdirSync(CACHE, { recursive: true })
      const r = buildLibrary({
        kitDir: job.dir,
        spec: job.spec,
        attribution: job.attribution,
      })
      writeFileSync(cacheGlb, r.glb)
      libBuilt++
      libModels += r.items.length
      console.log(
        `  library ${job.spec.slug}: ${r.items.length} models, ` +
          `${mb(r.from)} → ${mb(r.glb.byteLength)}` +
          ` (${((1 - r.glb.byteLength / r.from) * 100).toFixed(0)}% smaller)`
      )
    }
    linkOut(cacheGlb, outAbs)

    for (const sub of job.spec.subsets ?? []) {
      const subKey = `libsubset-${key}-${createHash('sha256')
        .update(JSON.stringify(sub))
        .digest('hex')
        .slice(0, 8)}`
      const subCache = join(CACHE, subKey + '.glb')
      if (!existsSync(subCache)) {
        const r = subsetLibrary(loadModel(cacheGlb), sub.keep)
        writeFileSync(subCache, r.glb)
        libBuilt++
        console.log(
          `  subset  ${sub.slug}: ${r.kept}/${r.total} models, ` +
            `${mb(statSync(cacheGlb).size)} → ${mb(r.glb.byteLength)}`
        )
      } else libCached++
      linkOut(subCache, join(DERIVED, namespace, LIBRARY_DIR, sub.slug + '.glb'))
    }
  } catch (e: any) {
    libFailed++
    console.error(`  FAILED library ${job.spec.slug} — ${e.message ?? e}`)
  }
}
if (libJobs.length) {
  console.log(
    `libraries: ${libBuilt} built${libModels ? ` (${libModels} models)` : ''}, ` +
      `${libCached} cached${libFailed ? `, ${libFailed} FAILED` : ''} → derived/`
  )
}
