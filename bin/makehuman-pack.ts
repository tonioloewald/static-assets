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
 * - REGIONS are per-vertex masks, uint8 (lips: what the lip volume targets
 *   move), for tinting without UVs.
 * - PARTS are extra geometry on the body's own vertices (eyes, eyelashes), so
 *   every target moves them with the body.
 * - No skin weights: tosijs-3d binds UAL's skeleton by bone heat.
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

// ---- regions: per-vertex masks (0..255) -----------------------------------
//
// LIPS are the vertices MakeHuman's lip VOLUME targets move, weighted by how
// far: exactly the lips' flesh. (All 24 lip targets also move the border
// skin, and painted that way the colour smears onto the chin and philtrum.)

async function regionFrom(paths: string[]): Promise<Uint8Array> {
  const out = new Float32Array(vertexCount)
  for (const path of paths) {
    for (const line of (await source(path)).split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      const [i, x, y, z] = line.trim().split(/\s+/).map(Number)
      out[i] = Math.max(out[i], Math.hypot(x, y, z))
    }
  }
  let max = 0
  for (const v of out) max = Math.max(max, v)
  return Uint8Array.from(out, (v) => Math.round((v / max) * 255))
}

const regions = {
  lips: await regionFrom(
    ['upperlip-volume-incr', 'upperlip-volume-decr', 'lowerlip-volume-incr', 'lowerlip-volume-decr'].map(
      (t) => `targets/mouth/mouth-${t}.target`
    )
  ),
}

// ---- parts: eyes and eyelashes ---------------------------------------------
//
// A PART is extra geometry on the body's own vertices: `vertices` lists the
// pack vertices it uses (so the targets move it too), `triangles` index that
// list, and `uvs` (two floats per part vertex) map a texture when it has one.
//
// EYES are MakeHuman's low-poly eye proxy. It is bound rigidly (`verts 0`):
// every proxy vertex IS one of the base mesh's helper eye vertices, so it is
// just faces and UVs over vertices the pack already has. Its UVs are per face
// corner, so a vertex with two UVs becomes two part vertices.
// EYELASHES are the base mesh's helper eyelash cards, untextured.

async function eyesPart() {
  const clo = await source('eyes/low-poly/low-poly.mhclo')
  const lines = clo.split('\n')
  const at = lines.findIndex((l) => l.startsWith('verts'))
  if (!/^verts 0\b/.test(lines[at])) throw new Error('eyes: expected a rigid (verts 0) proxy')
  const map = lines.slice(at + 1).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number)
  const eo = await source('eyes/low-poly/low-poly.obj')
  const vt: number[][] = []
  const corners = new Map<string, number>()
  const vertices: number[] = []
  const uvs: number[] = []
  const triangles: number[] = []
  for (const line of eo.split('\n')) {
    if (line.startsWith('vt ')) vt.push(line.slice(3).trim().split(/\s+/).map(Number))
    else if (line.startsWith('f ')) {
      const c = line.slice(2).trim().split(/\s+/).map((t) => {
        let k = corners.get(t)
        if (k == null) {
          const [v, u] = t.split('/').map((n) => parseInt(n, 10) - 1)
          k = vertices.length
          corners.set(t, k)
          vertices.push(map[v])
          uvs.push(vt[u][0], vt[u][1])
        }
        return k
      })
      for (let i = 1; i + 1 < c.length; i++) triangles.push(c[0], c[i], c[i + 1])
    }
  }
  return { vertices, uvs, triangles }
}

function helperPart(names: string[]) {
  const remap = new Map<number, number>()
  const vertices: number[] = []
  const triangles: number[] = []
  for (const n of names) {
    for (const v of groups.get(n) ?? []) {
      let k = remap.get(v)
      if (k == null) {
        k = vertices.length
        remap.set(v, k)
        vertices.push(v)
      }
      triangles.push(k)
    }
  }
  return { vertices, triangles }
}

const eyes = await eyesPart()
const eyelashes = helperPart(['l', 'r'].flatMap((s) => [1, 2].map((n) => `helper-${s}-eyelashes-${n}`)))

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
  regions: Object.fromEntries(Object.entries(regions).map(([n, r]) => [n, blob(r)])),
  parts: Object.fromEntries(
    Object.entries({ eyes, eyelashes } as Record<string, { vertices: number[]; triangles: number[]; uvs?: number[] }>).map(
      ([n, p]) => [
        n,
        {
          count: p.vertices.length,
          vertices: blob(bytesOf(new Uint32Array(p.vertices))),
          triangles: blob(bytesOf(new Uint32Array(p.triangles))),
          ...(p.uvs ? { uvs: blob(bytesOf(new Float32Array(p.uvs))) } : {}),
        },
      ]
    )
  ),
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
