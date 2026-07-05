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
import { execFileSync } from 'node:child_process'
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

let built = 0
let cached = 0
let done = 0
for (const { dir, specs } of jobs) {
  const rel = relative(SRC, dir)
  if (only && !rel.includes(only)) continue
  for (const spec of specs) {
    const inputs = (spec.model ? [spec.model, ...(spec.animations ?? [])] : [spec.input!]).map(
      (i) => join(dir, i)
    )
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
    const outAbs = join(DERIVED, rel, spec.output)
    mkdirSync(dirname(outAbs), { recursive: true })

    if (!existsSync(cacheGlb)) {
      mkdirSync(CACHE, { recursive: true })
      const args = spec.model
        ? ['merge', cacheGlb, ...inputs]
        : ['single', inputs[0], cacheGlb]
      console.log(`  build ${rel}/${spec.output} (${inputs.length} input(s))`)
      try {
        execFileSync(
          BLENDER,
          ['--background', '--factory-startup', '--python', PY, '--', ...args],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )
      } catch (e: any) {
        console.error(`  FAILED ${rel}/${spec.output}\n${e.stderr?.toString?.() ?? e}`)
        continue
      }
      built++
    } else cached++

    try {
      rmSync(outAbs, { force: true })
      linkSync(cacheGlb, outAbs)
    } catch {
      copyFileSync(cacheGlb, outAbs)
    }
    done++
  }
}
console.log(
  `convert: ${done} output(s) — ${built} built, ${cached} cached → derived/`
)
