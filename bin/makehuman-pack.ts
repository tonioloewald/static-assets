#!/usr/bin/env bun
/**
 * makehuman-pack — convert MakeHuman's hm08 base mesh, its skeleton and its
 * macro targets into a HUMAN PACK, the format tosijs-3d's `human-pack` reads
 * (see tosijs-3d's CHARACTER-DESIGN.md).
 *
 * MakeHuman's bundled ASSETS are CC0 (their LICENSE.md, section C, and the
 * header of every target file). Their CODE is AGPL, so this reads the file
 * formats and copies no code.
 *
 * Sources are fetched from a PINNED commit, so a rebuild is reproducible, into
 * assets/makehuman/source/, which no `publish` glob names. The pack lands in
 * assets/makehuman/hm08/:
 *
 *   hm08.json            the manifest: counts, joints, bones, and a file per target
 *   <sha256-16>.bin      every binary, named by its content, so it can be cached forever
 *
 * Decisions, measured on the real files:
 *
 * - UNITS: MakeHuman is in decimetres; everything here is scaled to metres.
 * - POSITIONS keep all 19,158 vertices (body, helpers, joint cubes), because the
 *   targets move all of them and the joints are centroids of cube vertices. The
 *   BODY triangles index into that array; helpers are listed, not drawn.
 * - TARGETS are int16 per axis with one step per target (max |delta| / 32767; at
 *   the macros' ±1.07 m that is a 0.03 mm step). A target that moves more than
 *   half the vertices is stored DENSE (every vertex, in order); otherwise SPARSE
 *   (uint32 indices, then the int16 deltas). The race macros are dense; many
 *   universal ones are nearly empty.
 * - The mesh is RIGHT-HANDED, as OBJ is. tosijs-3d's rig-build mirrors it the
 *   way the glTF loader does.
 * - No UVs yet: step 0 draws a grey body. They come with the skin (step 5).
 * - SKIN WEIGHTS are MakeHuman's own, hand-tuned for its 163-bone rig, stored
 *   per bone (uint32 vertices, then uint16 weights / 65535). tosijs-3d folds
 *   them onto UAL's skeleton.
 *
 *   bun bin/makehuman-pack.ts           fetch what is missing, build the pack
 *   bun bin/makehuman-pack.ts --force   refetch nothing, rebuild everything
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMIT = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
const REPO = 'makehumancommunity/makehuman'
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/makehuman/data`
const SRC = join(ROOT, 'assets/makehuman/source')
const OUT = join(ROOT, 'assets/makehuman/hm08')
const SCALE = 0.1 // decimetres → metres

async function listDir(path: string): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/makehuman/data/${path}?ref=${COMMIT}`,
    { headers: process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} }
  )
  if (!res.ok) throw new Error(`list ${path}: ${res.status}`)
  return ((await res.json()) as { name: string; type: string }[])
    .filter((e) => e.type === 'file')
    .map((e) => `${path}/${e.name}`)
}

/** Fetch `path` into the source tree unless it is already there. */
async function source(path: string): Promise<string> {
  const file = join(SRC, path)
  if (!existsSync(file)) {
    const res = await fetch(`${RAW}/${path}`)
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()))
  }
  return readFileSync(file, 'utf8')
}

/** Write bytes under their own hash; return the file name. */
function blob(bytes: Uint8Array): string {
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.bin'
  writeFileSync(join(OUT, name), bytes)
  return name
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

// ---- the base mesh ----------------------------------------------------------

const obj = await source('3dobjs/base.obj')
const positions: number[] = []
const groups = new Map<string, number[]>() // group → triangle indices
let group = ''
for (const line of obj.split('\n')) {
  if (line.startsWith('v ')) {
    const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number)
    positions.push(x * SCALE, y * SCALE, z * SCALE)
  } else if (line.startsWith('g ')) {
    group = line.slice(2).trim()
  } else if (line.startsWith('f ')) {
    const v = line.slice(2).trim().split(/\s+/).map((t) => parseInt(t, 10) - 1)
    const tris = groups.get(group) ?? []
    for (let i = 1; i + 1 < v.length; i++) tris.push(v[0], v[i], v[i + 1])
    groups.set(group, tris)
  }
}
const vertexCount = positions.length / 3
const body = groups.get('body')
if (body == null) throw new Error('base.obj has no body group')

// ---- the skeleton -----------------------------------------------------------

const skel = JSON.parse(await source('rigs/default.mhskel')) as {
  bones: Record<string, { head: string; tail: string; parent: string | null }>
  joints: Record<string, number[]>
}

// ---- MakeHuman's skin weights, for its own 163-bone rig -------------------
//
// Stored as they are (one list per bone), so the fold onto another skeleton
// (tosijs-3d's human-rig) is policy kept with that skeleton's joint table.

const mhw = JSON.parse(await source('rigs/default_weights.mhw')) as {
  weights: Record<string, [number, number][]>
}

// ---- the macro targets ------------------------------------------------------

const macroFiles = [
  ...(await listDir('targets/macrodetails')),
  ...(await listDir('targets/macrodetails/height')),
  ...(await listDir('targets/macrodetails/proportions')),
].filter((p) => p.endsWith('.target'))

if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

type TargetEntry = { file: string; step: number; dense: boolean; count: number }
const targets: Record<string, TargetEntry> = {}
let dense = 0
let denseBytes = 0
let sparseBytes = 0
for (const path of macroFiles) {
  const rows: [number, number, number, number][] = []
  for (const line of (await source(path)).split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [i, x, y, z] = line.trim().split(/\s+/).map(Number)
    rows.push([i, x * SCALE, y * SCALE, z * SCALE])
  }
  let max = 0
  for (const r of rows) max = Math.max(max, Math.abs(r[1]), Math.abs(r[2]), Math.abs(r[3]))
  const step = max > 0 ? max / 32767 : 1
  const name = path.replace('targets/', '').replace(/\.target$/, '')
  const isDense = rows.length > vertexCount / 2
  let bytes: Uint8Array
  if (isDense) {
    const d = new Int16Array(vertexCount * 3)
    for (const [i, x, y, z] of rows) {
      d[i * 3] = Math.round(x / step)
      d[i * 3 + 1] = Math.round(y / step)
      d[i * 3 + 2] = Math.round(z / step)
    }
    bytes = bytesOf(d)
    dense++
    denseBytes += bytes.length
  } else {
    const idx = new Uint32Array(rows.length)
    const d = new Int16Array(rows.length * 3)
    rows.forEach(([i, x, y, z], k) => {
      idx[k] = i
      d[k * 3] = Math.round(x / step)
      d[k * 3 + 1] = Math.round(y / step)
      d[k * 3 + 2] = Math.round(z / step)
    })
    bytes = new Uint8Array(idx.byteLength + d.byteLength)
    bytes.set(bytesOf(idx), 0)
    bytes.set(bytesOf(d), idx.byteLength)
    sparseBytes += bytes.length
  }
  targets[name] = { file: blob(bytes), step, dense: isDense, count: isDense ? vertexCount : rows.length }
}

// ---- the manifest -----------------------------------------------------------

const manifest = {
  format: 'tosijs-human-pack',
  version: 1,
  base: 'hm08',
  license: 'CC0-1.0',
  source: { repo: `https://github.com/${REPO}`, commit: COMMIT },
  units: 'm',
  handedness: 'right',
  vertexCount,
  positions: blob(bytesOf(new Float32Array(positions))),
  body: { triangles: blob(bytesOf(new Uint32Array(body))), count: body.length / 3 },
  helpers: [...groups.keys()].filter((g) => g.startsWith('helper-')),
  joints: skel.joints,
  weights: (() => {
    // Per bone, its vertices then (after every bone's) the weights, uint16.
    const bones = Object.keys(mhw.weights)
    const counts = bones.map((b) => mhw.weights[b].length)
    const total = counts.reduce((a, b) => a + b, 0)
    const idx = new Uint32Array(total)
    const w = new Uint16Array(total)
    let k = 0
    for (const b of bones) {
      for (const [v, x] of mhw.weights[b]) {
        idx[k] = v
        w[k++] = Math.round(Math.min(1, x) * 65535)
      }
    }
    const bytes = new Uint8Array(idx.byteLength + w.byteLength)
    bytes.set(bytesOf(idx), 0)
    bytes.set(bytesOf(w), idx.byteLength)
    return { bones, counts, file: blob(bytes) }
  })(),
  bones: Object.fromEntries(
    Object.entries(skel.bones).map(([n, b]) => [n, { parent: b.parent, head: b.head, tail: b.tail }])
  ),
  targets,
}
writeFileSync(join(OUT, 'hm08.json'), JSON.stringify(manifest))

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`
const total = readdirSync(OUT).reduce((s, f) => s + readFileSync(join(OUT, f)).length, 0)
console.log(
  `hm08: ${vertexCount} vertices, ${body.length / 3} body triangles, ${Object.keys(skel.bones).length} bones\n` +
    `targets: ${macroFiles.length} (${dense} dense ${kb(denseBytes)}, ${macroFiles.length - dense} sparse ${kb(sparseBytes)})\n` +
    `pack: ${kb(total)} in ${readdirSync(OUT).length} files → ${OUT}`
)
