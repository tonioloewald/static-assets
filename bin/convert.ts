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
} from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { createHash } from 'node:crypto'

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
}

const jobs: { dir: string; specs: Spec[] }[] = []
const collect = (dir: string) => {
  const mp = join(dir, 'metadata.json')
  if (existsSync(mp)) {
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    if (Array.isArray(m.convert) && m.convert.length)
      jobs.push({ dir, specs: m.convert })
  }
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) collect(p)
  }
}
if (existsSync(SRC)) collect(SRC)

const sig = (files: string[]) =>
  createHash('sha256')
    .update(
      files.map((f) => `${f}:${statSync(f).size}:${statSync(f).mtimeMs}`).join('|')
    )
    .digest('hex')
    .slice(0, 16)

// Flatten specs into a task list, tagging which need a Blender build (uncached).
type Task = {
  rel: string
  output: string
  args: string[]
  cacheGlb: string
  outAbs: string
  cached: boolean
  failed?: boolean
}
const tasks: Task[] = []
for (const { dir, specs } of jobs) {
  const rel = relative(SRC, dir)
  if (only && !rel.includes(only)) continue
  for (const spec of specs) {
    const inputs = (
      spec.model ? [spec.model, ...(spec.animations ?? [])] : [spec.input!]
    ).map((i) => join(dir, i))
    if (inputs.some((f) => !existsSync(f))) {
      console.warn(`  skip ${rel}/${spec.output} — missing input`)
      continue
    }
    const key =
      (spec.model ? 'merge' : 'single') +
      '-' +
      sig(inputs) +
      '-' +
      createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 8)
    const cacheGlb = join(CACHE, key + '.glb')
    tasks.push({
      rel,
      output: spec.output,
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
    await pexec(
      BLENDER,
      ['--background', '--factory-startup', '--python', PY, '--', ...t.args],
      { maxBuffer: 1 << 26 }
    )
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
