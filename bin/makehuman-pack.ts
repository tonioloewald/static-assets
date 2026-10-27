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
import { tmpdir } from 'node:os'
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

/** Write an image under its own hash, keeping its extension (browsers sniff, Babylon picks a loader by it). */
function imageBlob(bytes: Uint8Array, ext: string): string {
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.' + ext
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

// MakeHuman's skin weights for its own rig: used only to bake expressions.
const mhw = JSON.parse(await source('rigs/default_weights.mhw')) as {
  weights: Record<string, [number, number][]>
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

if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

// ---- proxies: MakeHuman's CC0 system assets ---------------------------------
//
// Clothes, hair and eyebrows made for hm08, each bound to it by a `.mhclo`:
// per proxy vertex, three base vertices, barycentric weights and an offset
// (decimetres) scaled per axis by how far apart two reference vertices are on
// the body being fitted. Fitting is tosijs-3d's `proxy-fit`. The pack is
// MakeHuman's "system assets", CC0, from their asset-pack site (the old
// makehuman-assets repo is gone).
//
// Each proxy keeps its binding per OBJ vertex, and its drawn vertices are the
// OBJ's corners split by UV (`source` maps one to the other). Textures are
// resized to 1024 (macOS `sips`): JPEG, or PNG where they carry alpha (hair).

const SYSTEM_URL =
  'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip'
const SYSTEM = join(SRC, 'packs/system')
if (!existsSync(join(SYSTEM, 'clothes'))) {
  const zip = join(SRC, 'packs/makehuman_system_assets_cc0.zip')
  mkdirSync(dirname(zip), { recursive: true })
  if (!existsSync(zip)) {
    const res = await fetch(SYSTEM_URL)
    if (!res.ok) throw new Error(`system assets: ${res.status}`)
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()))
  }
  Bun.spawnSync(['unzip', '-q', '-o', zip, '-d', SYSTEM])
}

function resized(file: string, alpha: boolean): { bytes: Uint8Array; ext: string } {
  const ext = alpha ? 'png' : 'jpg'
  const out = join(tmpdir(), `mhpack-${createHash('sha1').update(file).digest('hex')}.${ext}`)
  const args = ['sips', '-Z', '1024', ...(alpha ? [] : ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82']), file, '--out', out]
  const r = Bun.spawnSync(args)
  if (r.exitCode !== 0) throw new Error(`sips failed on ${file}`)
  return { bytes: new Uint8Array(readFileSync(out)), ext }
}

function hasAlpha(file: string): boolean {
  const r = Bun.spawnSync(['sips', '-g', 'hasAlpha', file])
  return /hasAlpha: yes/.test(new TextDecoder().decode(r.stdout))
}

/*
WHAT A GARMENT IS, from where it sits on the body, not from the pack it came
in: the packs file a monk's hood and viking boots under "suits". The binding
places each vertex on the base body, so its extent is known before any body is
made. Heights are fractions of the body's (feet 0, crown 1).
- bodysuits and skinsuits: a base layer; ARMOUR: an overlay, worn over anything
- glasses and masks keep the slot their pack gave them (they sit on the face)
- feet only: shoes; hands only (wide, arm height): gloves; above the neck: hat
- upper body only: top; lower body only: bottom; both: outfit

`SLOT_DEBUG=1` prints each garment's low, high and width, which is how the
thresholds were set: audit a new pack with it rather than trusting a name.
Gloves are the one pair that nearly collide. A long-sleeved top reaches the
same hands, so it is as wide and as high as a glove is; what separates them is
that a glove covers the fingers and a sleeve stops at the wrist. Measured over
all 107 garments that is a real gap but a narrow one — every glove is at least
0.505 wide and the widest non-glove (a cyborg suit, and the men's casualsuits)
is 0.480 — so the cut sits at 0.49. At the 0.4 it started from, a fisherman
sweater missed being classified as gloves by 0.029 of body height, on the
`high` test alone; now it fails on width too.
*/
let bodyLow = Infinity
let bodyHigh = -Infinity
for (const v of body) {
  bodyLow = Math.min(bodyLow, positions[v * 3 + 1])
  bodyHigh = Math.max(bodyHigh, positions[v * 3 + 1])
}
function clothesSlot(name: string, slot: string, rows: number[][]): string {
  if (slot === 'glasses' || slot === 'mask') return slot
  if (/armou?r/i.test(name)) return 'armour'
  if (/bodysuit|skinsuit/i.test(name)) return 'bodysuit'
  let lo = Infinity
  let hi = -Infinity
  let wide = 0
  for (const r of rows) {
    const y =
      r.length === 1
        ? positions[r[0] * 3 + 1]
        : r[3] * positions[r[0] * 3 + 1] + r[4] * positions[r[1] * 3 + 1] + r[5] * positions[r[2] * 3 + 1] + r[7] * SCALE
    const x =
      r.length === 1
        ? positions[r[0] * 3]
        : r[3] * positions[r[0] * 3] + r[4] * positions[r[1] * 3] + r[5] * positions[r[2] * 3] + r[6] * SCALE
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
    wide = Math.max(wide, Math.abs(x))
  }
  const H = bodyHigh - bodyLow
  const a = (lo - bodyLow) / H
  const b = (hi - bodyLow) / H
  if (process.env.SLOT_DEBUG) console.error(`SLOT\t${name}\t${a.toFixed(3)}\t${b.toFixed(3)}\t${(wide / (H / 1.7)).toFixed(3)}`)
  if (a > 0.7) return 'hat'
  if (b < 0.5 && a < 0.05) return 'shoes'
  if (a > 0.5 && b < 0.82 && wide > 0.49 * (H / 1.7)) return 'gloves'
  // Ends below the waist: a bottom (shorts and miniskirts start high).
  if (b < 0.66) return 'bottom'
  if (a > 0.35) return 'top'
  return 'outfit'
}

type Proxy = Record<string, unknown>
const proxies: Record<string, Proxy> = {}
let proxyBytes = 0
// More CC0 packs from the same site, unpacked beside the system assets.
const PACK_URL = (p: string) =>
  `https://files.makehumancommunity.org/asset_packs/${p}/${p}_cc0.zip`
const EXTRA_PACKS: Record<string, string> = {
  // Beards and moustaches, bound to hm08 like any garment.
  bodyparts05: PACK_URL('bodyparts05'),
  // Alternate textures (colourways) for the system clothes.
  clothes_materials01: PACK_URL('system_clothes_materials01'),
  // Separate garments and accessories, each in a SLOT.
  shirts01: PACK_URL('shirts01'),
  pants01: PACK_URL('pants01'),
  skirts01: PACK_URL('skirts01'),
  suits01: PACK_URL('suits01'),
  shoes01: PACK_URL('shoes01'),
  hats01: PACK_URL('hats01'),
  glasses01: PACK_URL('glasses01'),
  gloves01: PACK_URL('gloves01'),
  // Sci-fi and fantasy: armour, a cyborg suit, bodysuits, robes; helmets; masks.
  suits02: PACK_URL('suits02'),
  hats02: PACK_URL('hats02'),
  masks01: PACK_URL('masks01'),
}
const EXCLUDED = new Set(['toigo_maga_hat'])
/** The slot each pack's garments fill: one of each slot is worn at a time. */
const PACK_SLOT: Record<string, string> = {
  bodyparts05: 'beard',
  shirts01: 'top',
  pants01: 'bottom',
  skirts01: 'bottom',
  suits01: 'outfit',
  shoes01: 'shoes',
  hats01: 'hat',
  glasses01: 'glasses',
  gloves01: 'gloves',
  suits02: 'outfit',
  hats02: 'hat',
  masks01: 'mask',
}
for (const [pack, url] of Object.entries(EXTRA_PACKS)) {
  const dir = join(SRC, 'packs', pack)
  if (existsSync(join(dir, 'clothes'))) continue
  const zip = join(SRC, 'packs', `${pack}_cc0.zip`)
  if (!existsSync(zip)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${pack}: ${res.status}`)
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()))
  }
  Bun.spawnSync(['unzip', '-q', '-o', zip, '-d', dir])
}
// [category, name, folder, slot]
const sources: [string, string, string, string][] = []
const systemSlot = (category: string, name: string) =>
  category === 'hair' ? 'hair' : category === 'eyebrows' ? 'brows' : category === 'teeth' ? 'teeth' : category === 'tongue' ? 'tongue' : name.startsWith('shoes') ? 'shoes' : name.startsWith('fedora') ? 'hat' : 'outfit'
// Teeth and tongue: always worn, bound to the mouth's helpers (which the
// jaw and tongue expressions move). Only the base teeth; the shapes are
// alternatives nobody has asked for yet.
for (const category of ['clothes', 'hair', 'eyebrows', 'teeth', 'tongue']) {
  for (const name of readdirSync(join(SYSTEM, category)).sort()) {
    if (category === 'teeth' && name !== 'teeth_base') continue
    sources.push([category, name, join(SYSTEM, category, name), systemSlot(category, name)])
  }
}
for (const [pack, slot] of Object.entries(PACK_SLOT)) {
  const root = join(SRC, 'packs', pack, 'clothes')
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    if (!existsSync(join(root, name)) || !readdirSync(join(root, name)).some((f) => f.endsWith('.mhclo'))) continue
    // Curated out: political merchandise is not neutral content for a library.
    if (EXCLUDED.has(name)) continue
    sources.push([slot === 'beard' ? 'beard' : 'clothes', name, join(root, name), slot])
  }
}
{
  for (const [category, name, dir, slot] of sources) {
    const cloFile = existsSync(join(dir, `${name}.mhclo`))
      ? `${name}.mhclo`
      : readdirSync(dir).find((f) => f.endsWith('.mhclo'))!
    const clo = readFileSync(join(dir, cloFile), 'utf8').split('\n')
    const head = new Map<string, string>()
    const rows: number[][] = []
    const deleted: number[] = []
    let section = ''
    for (const raw of clo) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      if (/^verts\b/.test(line)) { section = 'verts'; continue }
      if (/^delete_verts\b/.test(line)) { section = 'delete'; continue }
      if (section === 'verts' && /^[\d.\-\s]+$/.test(line)) {
        rows.push(line.split(/\s+/).map(Number))
      } else if (section === 'delete' && /^[\d\s-]+$/.test(line)) {
        const t = line.split(/\s+/)
        for (let i = 0; i < t.length; i++) {
          if (t[i + 1] === '-') {
            for (let v = Number(t[i]); v <= Number(t[i + 2]); v++) deleted.push(v)
            i += 2
          } else deleted.push(Number(t[i]))
        }
      } else {
        // A header line (some files put `material` after `verts 0`).
        const [k, ...rest] = line.split(/\s+/)
        if (!head.has(k)) head.set(k, rest.join(' '))
      }
    }
    // Binding per OBJ vertex: three base vertices, weights, offset (metres).
    const n = rows.length
    const idx = new Uint32Array(n * 3)
    const w = new Float32Array(n * 3)
    const d = new Float32Array(n * 3)
    rows.forEach((r, i) => {
      if (r.length === 1) {
        idx.set([r[0], r[0], r[0]], i * 3)
        w.set([1, 0, 0], i * 3)
      } else {
        idx.set(r.slice(0, 3), i * 3)
        w.set(r.slice(3, 6), i * 3)
        d.set(r.slice(6, 9).map((x) => x * SCALE), i * 3)
      }
    })
    const bind = new Uint8Array(idx.byteLength + w.byteLength + d.byteLength)
    bind.set(bytesOf(idx), 0)
    bind.set(bytesOf(w), idx.byteLength)
    bind.set(bytesOf(d), idx.byteLength + w.byteLength)
    // The mesh: corners split by UV.
    const obj = readFileSync(join(dir, head.get('obj_file') ?? cloFile.replace(/\.mhclo$/, '.obj')), 'utf8')
    const vt: number[][] = []
    let objVerts = 0
    const corners = new Map<string, number>()
    const source: number[] = []
    const uvs: number[] = []
    const tris: number[] = []
    for (const line of obj.split('\n')) {
      if (line.startsWith('v ')) objVerts++
      else if (line.startsWith('vt ')) vt.push(line.slice(3).trim().split(/\s+/).map(Number))
      else if (line.startsWith('f ')) {
        const c = line.slice(2).trim().split(/\s+/).map((t) => {
          let k = corners.get(t)
          if (k == null) {
            const [v, u] = t.split('/').map((x) => parseInt(x, 10) - 1)
            k = source.length
            corners.set(t, k)
            source.push(v)
            uvs.push(...(Number.isFinite(u) && vt[u] ? vt[u].slice(0, 2) : [0, 0]))
          }
          return k
        })
        for (let i = 1; i + 1 < c.length; i++) tris.push(c[0], c[i], c[i + 1])
      }
    }
    if (objVerts !== n) throw new Error(`${name}: ${objVerts} OBJ vertices, ${n} bindings`)
    const scale: Record<string, [number, number, number]> = {}
    for (const axis of ['x', 'y', 'z']) {
      const t = head.get(`${axis}_scale`)?.split(/\s+/).map(Number)
      if (t) scale[axis] = [t[0], t[1], t[2] * SCALE]
    }
    // The material: its textures, resized.
    const mat = new Map<string, string>()
    const matFile = [head.get('material'), cloFile.replace(/\.mhclo$/, '.mhmat')].find((f) => f && existsSync(join(dir, f)))
    for (const line of (matFile ? readFileSync(join(dir, matFile), 'utf8') : '').split('\n')) {
      const m = line.trim().match(/^(\w+)\s+(.*)$/)
      if (m) mat.set(m[1], m[2])
    }
    const texture = (key: string, alpha: boolean) => {
      const f = mat.get(key)
      if (f == null || !existsSync(join(dir, f))) return undefined
      // PNG only where the material is transparent AND the image has alpha:
      // most clothes carry an unused alpha channel.
      // Hair, brows and beards are cards: their alpha IS the hair, whatever
      // the material says. Glasses' lenses are see-through the same way.
      const keepAlpha =
        alpha &&
        (mat.get('transparent') === 'True' || category !== 'clothes' || slot === 'glasses') &&
        hasAlpha(join(dir, f))
      const r = resized(join(dir, f), keepAlpha)
      proxyBytes += r.bytes.length
      return imageBlob(r.bytes, r.ext)
    }
    const diffuse = texture('diffuseTexture', true)
    const normal = texture('normalmapTexture', false)
    proxies[name] = {
      category,
      slot: category === 'clothes' ? clothesSlot(name, slot, rows) : slot,
      rows: n,
      count: source.length,
      binding: blob(bind),
      source: blob(bytesOf(Uint32Array.from(source))),
      triangles: blob(bytesOf(Uint32Array.from(tris))),
      uvs: blob(bytesOf(Float32Array.from(uvs))),
      ...(deleted.length ? { delete: blob(bytesOf(Uint32Array.from(deleted))) } : {}),
      scale,
      material: {
        ...(diffuse ? { diffuse } : {}),
        ...(normal ? { normal } : {}),
        alpha: diffuse?.endsWith('.png') ?? false,
        twoSided: mat.get('backfaceCull') === 'False',
      },
    }
    proxyBytes += bind.length + (tris.length + uvs.length + source.length + deleted.length) * 4
  }
}

// ---- looks: alternate textures for a proxy (its colourways) ----------------
{
  const root = join(SRC, 'packs/clothes_materials01/clothes')
  for (const proxy of existsSync(root) ? readdirSync(root).sort() : []) {
    const entry = proxies[proxy] as { material: Record<string, unknown> } | undefined
    if (entry == null) continue
    const looks: Record<string, { diffuse: string; normal?: string }> = {}
    for (const look of readdirSync(join(root, proxy)).sort()) {
      const dir = join(root, proxy, look)
      const matFile = readdirSync(dir).find((f) => f.endsWith('.mhmat'))
      if (matFile == null) continue
      const mat = new Map<string, string>()
      for (const line of readFileSync(join(dir, matFile), 'utf8').split('\n')) {
        const m = line.trim().match(/^(\w+)\s+(.*)$/)
        if (m) mat.set(m[1], m[2])
      }
      const file = (key: string) => {
        const f = mat.get(key)
        if (f == null) return undefined
        const path = [join(dir, f), join(dir, f.split('/').pop()!)].find((p) => existsSync(p))
        if (path == null) return undefined
        const r = resized(path, false)
        proxyBytes += r.bytes.length
        return imageBlob(r.bytes, r.ext)
      }
      const diffuse = file('diffuseTexture')
      if (diffuse == null) continue
      const normal = file('normalmapTexture')
      // `toigo_male_elegant_suit_teal` → `teal`: the garment's own name is noise here.
      const name = look.replace(/^toigo_male_(elegant|casual)_suit(_\d+)?_/, '').replace(/_/g, ' ')
      looks[name] = { diffuse, ...(normal ? { normal } : {}) }
    }
    if (Object.keys(looks).length) entry.material.looks = looks
  }
}

// ---- expressions: MakeHuman's face pose units, baked to shape targets -------
//
// MakeHuman's CC0 face pose units (blink, jaw drop, kiss, mouth corners, brows,
// cheeks...) are poses of its 163-bone face rig, one BVH frame each. Baked
// here, offline, with its own skin weights (`default_weights.mhw`): pose the
// rig, skin the base mesh, keep each unit's movement from the rest frame as a
// sparse target (`expression/<Unit>`). At runtime they are morph targets on
// the body, so a face is weights, and the body keeps UAL's skeleton.
//
// The BVH is Z-up: its (x, y, z) is the mesh's (x, z, -y). Joint frames are
// axis-aligned at rest (BVH convention), so a joint's world rotation is its
// parent's times its own (channels in the listed order, degrees).

type Mat3 = number[]
const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}
const rot = (axis: number, deg: number): Mat3 => {
  const c = Math.cos((deg * Math.PI) / 180)
  const s_ = Math.sin((deg * Math.PI) / 180)
  if (axis === 0) return [1, 0, 0, 0, c, -s_, 0, s_, c]
  if (axis === 1) return [c, 0, s_, 0, 1, 0, -s_, 0, c]
  return [c, -s_, 0, s_, c, 0, 0, 0, 1]
}
// BVH axes to the mesh's: x→x, y→-z, z→y.
const A: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0]
const At: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0]
const apply3 = (m: Mat3, v: number[]) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])

const POSE_RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/makehuman/data/poseunits`
async function poseSource(name: string): Promise<string> {
  const file = join(SRC, 'poseunits', name)
  if (!existsSync(file)) {
    const res = await fetch(`${POSE_RAW}/${name}`)
    if (!res.ok) throw new Error(`fetch poseunits/${name}: ${res.status}`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()))
  }
  return readFileSync(file, 'utf8')
}
const unitNames = (JSON.parse(await poseSource('face-poseunits.json')) as { framemapping: string[] }).framemapping
const bvhTokens = (await poseSource('face-poseunits.bvh')).split(/\s+/).filter(Boolean)
type BvhJoint = { name: string; parent: number; channels: string[] }
const bvhJoints: BvhJoint[] = []
{
  let i = 0
  const stack: number[] = []
  while (bvhTokens[i] !== 'MOTION') {
    const w = bvhTokens[i++]
    if (w === 'ROOT' || w === 'JOINT') bvhJoints.push({ name: bvhTokens[i++], parent: stack.length ? stack[stack.length - 1] : -1, channels: [] })
    else if (w === 'End') { i++; bvhJoints.push({ name: '', parent: stack[stack.length - 1], channels: [] }) }
    else if (w === '{') stack.push(bvhJoints.length - 1)
    else if (w === '}') stack.pop()
    else if (w === 'OFFSET') i += 3
    else if (w === 'CHANNELS') { const n = +bvhTokens[i++]; bvhJoints[bvhJoints.length - 1].channels = bvhTokens.slice(i, i + n); i += n }
  }
  var motionAt = i
}
const frameCount = +bvhTokens[motionAt + 2]
const perFrame = bvhJoints.reduce((s_, j) => s_ + j.channels.length, 0)
const frameStart = motionAt + 6
const frame = (f: number) => bvhTokens.slice(frameStart + f * perFrame, frameStart + (f + 1) * perFrame).map(Number)

// The rig's rest joints on the base mesh (decimetres, the OBJ's frame).
const baseDm = positions.map((x) => x / SCALE)
const cubeCentre = (joint: string) => {
  const vs = skel.joints[joint]
  const c = [0, 0, 0]
  for (const v of vs) for (let k = 0; k < 3; k++) c[k] += baseDm[v * 3 + k] / vs.length
  return c
}
const restHead = bvhJoints.map((j) => (j.name && skel.bones[j.name] ? cubeCentre(skel.bones[j.name].head) : null))

// Skin weights: per vertex, (bone index into bvhJoints, weight), normalised.
const boneIndex = new Map(bvhJoints.map((j, k) => [j.name, k]))
const vw: [number, number][][] = Array.from({ length: vertexCount }, () => [])
for (const [bone, list] of Object.entries(mhw.weights)) {
  const k = boneIndex.get(bone)
  if (k == null) continue
  for (const [v, w] of list) vw[v].push([k, w])
}
for (const l of vw) {
  const sum = l.reduce((s_, [, w]) => s_ + w, 0)
  if (sum > 0) for (const e of l) e[1] /= sum
}

/** The base mesh skinned into frame `f` (decimetres). */
function skinFrame(f: number): Float64Array {
  const values = frame(f)
  const G: Mat3[] = []
  const P: number[][] = []
  let c = 0
  bvhJoints.forEach((j, k) => {
    let local: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    for (const ch of j.channels) {
      const v = values[c++]
      const axis = ch[0] === 'X' ? 0 : ch[0] === 'Y' ? 1 : 2
      if (ch.endsWith('rotation')) local = mul3(local, rot(axis, v))
    }
    // In the mesh's axes.
    local = mul3(mul3(A, local), At)
    const parentG = j.parent >= 0 ? G[j.parent] : [1, 0, 0, 0, 1, 0, 0, 0, 1]
    G[k] = mul3(parentG, local)
    const rest = restHead[k]
    if (rest == null) { P[k] = j.parent >= 0 ? P[j.parent] : [0, 0, 0]; return }
    if (j.parent >= 0 && restHead[j.parent] != null) {
      const pr = restHead[j.parent]!
      const off = apply3(parentG, [rest[0] - pr[0], rest[1] - pr[1], rest[2] - pr[2]])
      P[k] = [P[j.parent][0] + off[0], P[j.parent][1] + off[1], P[j.parent][2] + off[2]]
    } else P[k] = rest
  })
  const out = new Float64Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) {
    const p = [baseDm[v * 3], baseDm[v * 3 + 1], baseDm[v * 3 + 2]]
    if (vw[v].length === 0) { out.set(p, v * 3); continue }
    for (const [k, w] of vw[v]) {
      const rest = restHead[k] ?? [0, 0, 0]
      const q = apply3(G[k], [p[0] - rest[0], p[1] - rest[1], p[2] - rest[2]])
      out[v * 3] += w * (q[0] + P[k][0])
      out[v * 3 + 1] += w * (q[1] + P[k][1])
      out[v * 3 + 2] += w * (q[2] + P[k][2])
    }
  }
  return out
}

const expressions: Record<string, { file: string; step: number; dense: boolean; count: number }> = {}
{
  const rest = skinFrame(0)
  for (let f = 1; f < Math.min(frameCount, unitNames.length); f++) {
    const posed = skinFrame(f)
    const rows: [number, number, number, number][] = []
    for (let v = 0; v < vertexCount; v++) {
      const d = [0, 1, 2].map((k) => (posed[v * 3 + k] - rest[v * 3 + k]) * SCALE)
      if (Math.hypot(d[0], d[1], d[2]) > 1e-5) rows.push([v, d[0], d[1], d[2]])
    }
    if (rows.length === 0) continue
    let max = 0
    for (const r of rows) max = Math.max(max, Math.abs(r[1]), Math.abs(r[2]), Math.abs(r[3]))
    const step = max / 32767
    const idx = new Uint32Array(rows.length)
    const d = new Int16Array(rows.length * 3)
    rows.forEach(([v, x, y, z], k) => {
      idx[k] = v
      d[k * 3] = Math.round(x / step)
      d[k * 3 + 1] = Math.round(y / step)
      d[k * 3 + 2] = Math.round(z / step)
    })
    const bytes = new Uint8Array(idx.byteLength + d.byteLength)
    bytes.set(bytesOf(idx), 0)
    bytes.set(bytesOf(d), idx.byteLength)
    expressions[`expression/${unitNames[f]}`] = { file: blob(bytes), step, dense: false, count: rows.length }
  }
}

// ---- the macro targets ------------------------------------------------------

const macroFiles = [
  ...(await listDir('targets/macrodetails')),
  ...(await listDir('targets/macrodetails/height')),
  ...(await listDir('targets/macrodetails/proportions')),
  // The bust: corners like the macros, plus cup and firmness (female only).
  ...(await listDir('targets/breast')).filter((p) => /\/female-/.test(p)),
  // Chest depth and pectorals.
  ...(await listDir('targets/torso')).filter((p) => /torso-(scale-depth|muscle-pectoral)-/.test(p)),
  // The waist: MakeHuman's Measure tab, its circumference alone (the weight
  // macros barely narrow a woman's waist).
  ...(await listDir('targets/measure')).filter((p) => /measure-waist-circ-/.test(p)),
].filter((p) => p.endsWith('.target'))


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
  proxies,
  bones: Object.fromEntries(
    Object.entries(skel.bones).map(([n, b]) => [n, { parent: b.parent, head: b.head, tail: b.tail }])
  ),
  targets: { ...targets, ...expressions },
}
writeFileSync(join(OUT, 'hm08.json'), JSON.stringify(manifest))

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`
const total = readdirSync(OUT).reduce((s, f) => s + readFileSync(join(OUT, f)).length, 0)
console.log(
  `hm08: ${vertexCount} vertices, ${body.length / 3} body triangles, ${Object.keys(skel.bones).length} bones\n` +
    `targets: ${macroFiles.length} (${dense} dense ${kb(denseBytes)}, ${macroFiles.length - dense} sparse ${kb(sparseBytes)})\n` +
    `proxies: ${Object.keys(proxies).length} (${kb(proxyBytes)})\n` +
    `pack: ${kb(total)} in ${readdirSync(OUT).length} files → ${OUT}`
)
