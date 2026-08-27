#!/usr/bin/env bun
/**
 * Subset a GLB's ANIMATIONS — no Blender involved.
 *
 * Quaternius ships one megafile per animation library: `UAL1.glb` is 20.4 MB, of
 * which **15.4 MB is animation accessor data** across 120 clips, with a single
 * mesh and no images at all. A consumer that plays a dozen of those clips is
 * downloading and parsing an order of magnitude more than it uses, on every
 * page load.
 *
 * Re-exporting a subset from Blender is the obvious route and a bad one: it is
 * slow, it crashes on packs this size, and it round-trips the data through an
 * importer and an exporter that each have opinions. A glTF is a JSON header over
 * a binary blob, so dropping animations is surgery on that header plus a rebuild
 * of the blob — exact, fast, and lossless for everything it keeps.
 *
 * ORIGINALS ARE NEVER TOUCHED. Sources are read-only; output goes to `derived/`,
 * which is what this repo already does with Blender conversions.
 *
 *   bun bin/subset-glb.ts <source.glb> <out.glb> <clip> [clip …]
 *   bun bin/subset-glb.ts <source.glb> --list
 *
 * Clip names may end in `*` to keep a family (`Climb_*`).
 */

interface Gltf {
  accessors?: any[]
  bufferViews?: any[]
  buffers?: any[]
  animations?: any[]
  meshes?: any[]
  skins?: any[]
  images?: any[]
  [k: string]: any
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

async function loadGlb(path: string): Promise<{ json: Gltf; bin: Uint8Array }> {
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer())
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${path}: not a GLB`)
  let off = 12
  let json: Gltf | null = null
  let bin = new Uint8Array(0)
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body))
    else if (type === CHUNK_BIN) bin = body
    off += 8 + len
    off += (4 - (off % 4)) % 4
  }
  if (json == null) throw new Error(`${path}: no JSON chunk`)
  return { json, bin }
}

/** Every accessor the kept content still refers to. Miss one and the file is corrupt. */
function liveAccessors(json: Gltf, keptAnimations: any[]): Set<number> {
  const live = new Set<number>()
  const add = (i: unknown) => {
    if (typeof i === 'number') live.add(i)
  }
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const a of Object.values(prim.attributes ?? {})) add(a)
      add(prim.indices)
      for (const target of prim.targets ?? []) {
        for (const a of Object.values(target)) add(a)
      }
    }
  }
  for (const skin of json.skins ?? []) add(skin.inverseBindMatrices)
  for (const anim of keptAnimations) {
    for (const s of anim.samplers ?? []) {
      add(s.input)
      add(s.output)
    }
  }
  return live
}


const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/**
 * **Collapse channels that never change.**
 *
 * Exporters write every bone's translation, rotation and scale at the full
 * sample rate whether or not the value moves. Measured on Quaternius' UAL1
 * core subset: scale is **99.9% constant**, translation **98.6%**, rotation
 * **55%** — together **82% of all animation bytes** are keyframes repeating a
 * value that is already known.
 *
 * This is why there is no "precision" setting here and no resampling. Both
 * trade accuracy for size; this trades nothing. The clips come out
 * bit-identical where they move and 30× smaller where they do not, and
 * quantising afterwards would only shrink what is left.
 *
 * **OFF by default, and honestly so.** The finding is solid — 82% of animation
 * bytes are constant channels — but this implementation does not yet cash it in:
 * on a 27-clip subset it produced 5.11 MB against 5.00 MB without it, because
 * each collapsed channel takes a bufferView of its own and the orphaned views
 * and JSON outweigh the keyframes removed. It wins on small subsets (1.21 →
 * 1.13 MB on three clips) and loses on large ones.
 *
 * What it needs before being turned on: share one bufferView across deduplicated
 * constants instead of allocating per channel, and drop views that no accessor
 * references. Left in place rather than deleted because the measurement is worth
 * keeping and the fix is bookkeeping, not discovery.
 *
 * Collapsed to TWO keyframes rather than one, at the original first and last
 * times. A single key would leave a clip whose samplers all report zero
 * duration if every channel happens to be constant (`A_TPose` is exactly
 * that), and a player deriving clip length from its samplers would call it
 * empty.
 */
function collapseConstant(
  json: Gltf,
  bin: Uint8Array,
  kept: any[],
  overrides: Map<number, Float32Array>
): { removed: number } {
  const accs = json.accessors ?? []
  const views = json.bufferViews ?? []
  const floats = (accIndex: number): Float32Array | null => {
    const a = accs[accIndex]
    if (a == null || a.componentType !== 5126 || a.bufferView == null) return null
    const v = views[a.bufferView]
    const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const n = a.count * (COMPONENTS[a.type] ?? 0)
    if (!n) return null
    return new Float32Array(bin.buffer.slice(
      bin.byteOffset + off,
      bin.byteOffset + off + n * 4
    ))
  }
  let removed = 0
  for (const anim of kept) {
    for (const s of anim.samplers ?? []) {
      const out = accs[s.output]
      const inp = accs[s.input]
      if (out == null || inp == null || out.count < 3) continue
      const data = floats(s.output)
      const times = floats(s.input)
      if (data == null || times == null) continue
      const nc = COMPONENTS[out.type] ?? 0
      let constant = true
      for (let i = 1; i < out.count && constant; i++) {
        for (let c = 0; c < nc; c++) {
          if (Math.abs(data[i * nc + c] - data[c]) > 1e-6) {
            constant = false
            break
          }
        }
      }
      if (!constant) continue
      // Two keys spanning the original range, same value at both.
      const t0 = times[0]
      const t1 = times[times.length - 1]
      const newOut = new Float32Array(nc * 2)
      for (let c = 0; c < nc; c++) {
        newOut[c] = data[c]
        newOut[nc + c] = data[c]
      }
      overrides.set(s.input, new Float32Array([t0, t1]))
      overrides.set(s.output, newOut)
      removed++
    }
  }
  return { removed }
}

function align4(n: number): number {
  return n + ((4 - (n % 4)) % 4)
}

/**
 * Rebuild a GLB from `json`/`bin` keeping only `kept` animations.
 *
 * Everything the kept content still references is carried over and REMAPPED —
 * mesh attributes, indices, morph targets, skin inverse-bind matrices, and the
 * kept clips' samplers. Missing one of those does not fail loudly; it produces a
 * file that loads and is quietly wrong, which is why `remap` throws rather than
 * returning undefined.
 */
function buildSubset(
  json: Gltf,
  bin: Uint8Array,
  kept: any[],
  collapse = false
): Uint8Array {
// Replacement data for channels that never change. Computed FIRST so the
// rebuild below emits the two-key version and skips the original entirely.
const overrides = new Map<number, Float32Array>()
if (collapse) {
  const r = collapseConstant(json, bin, kept, overrides)
  if (process.env.SUBSET_DEBUG)
    console.log(`    [debug] collapsed ${r.removed} samplers, ${overrides.size} accessors`)
}
const live = liveAccessors(json, kept)
const accessors = json.accessors ?? []
const views = json.bufferViews ?? []

// Keep the bufferViews the live accessors need, plus any an image points at.
const liveViews = new Set<number>()
for (const i of live) {
  const bv = accessors[i]?.bufferView
  if (typeof bv === 'number') liveViews.add(bv)
}
for (const img of json.images ?? []) {
  if (typeof img.bufferView === 'number') liveViews.add(img.bufferView)
}

// Rebuild the binary blob from just those views, remapping as we go.
const viewMap = new Map<number, number>()
const chunks: Uint8Array[] = []
const newViews: any[] = []
let offset = 0
for (const oldIndex of [...liveViews].sort((a, b) => a - b)) {
  const v = views[oldIndex]
  const start = v.byteOffset ?? 0
  const slice = bin.subarray(start, start + v.byteLength)
  const pad = align4(offset) - offset
  if (pad) chunks.push(new Uint8Array(pad))
  offset += pad
  viewMap.set(oldIndex, newViews.length)
  newViews.push({ ...v, byteOffset: offset, buffer: 0 })
  chunks.push(slice)
  offset += slice.byteLength
}

const accMap = new Map<number, number>()
const newAccessors: any[] = []
/** content key → accessor index, so identical constant channels share one. */
const constantPool = new Map<string, number>()
for (const oldIndex of [...live].sort((a, b) => a - b)) {
  const a = { ...accessors[oldIndex] }
  const replacement = overrides.get(oldIndex)
  if (replacement) {
    /*
    DEDUPE BY CONTENT — the whole win lives here.

    Constant channels are not merely repetitive within themselves, they are
    identical to EACH OTHER: every bone's scale is (1,1,1), and most bones'
    translation never leaves its bind pose. Emitting one accessor and one
    bufferView per channel turned a 5.00 MB file into 6.02 MB, because
    thousands of tiny views plus their JSON cost more than the keyframes they
    removed. Sharing one accessor between every channel with the same value
    removes both the bytes and the bookkeeping.
    */
    const key = a.type + ':' + new Uint8Array(replacement.buffer).join(',')
    const shared = constantPool.get(key)
    if (shared !== undefined) {
      accMap.set(oldIndex, shared)
      continue
    }
    constantPool.set(key, newAccessors.length)
    /*
    A collapsed channel: two keys of identical value, in a bufferView of its
    own. min/max are recomputed because the spec REQUIRES them on a sampler's
    input accessor, and a stale pair would misreport the clip's length to
    anything that derives duration from the accessor rather than the keys.
    */
    const nc = COMPONENTS[a.type] ?? 1
    const pad = align4(offset) - offset
    if (pad) chunks.push(new Uint8Array(pad))
    offset += pad
    a.bufferView = newViews.length
    newViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: replacement.byteLength,
    })
    chunks.push(new Uint8Array(replacement.buffer.slice(0)))
    offset += replacement.byteLength
    a.count = replacement.length / nc
    a.byteOffset = 0
    if (a.min || a.max) {
      // Only where the original carried them. The spec requires min/max on a
      // sampler's INPUT accessor; adding them to every output was pure JSON
      // weight, and at this accessor count that was megabytes of decimals.
      const min = Array.from({ length: nc }, (_, c) => replacement[c])
      const max = [...min]
      for (let i = 1; i < a.count; i++) {
        for (let c = 0; c < nc; c++) {
          const v = replacement[i * nc + c]
          if (v < min[c]) min[c] = v
          if (v > max[c]) max[c] = v
        }
      }
      a.min = min
      a.max = max
    }
  } else if (typeof a.bufferView === 'number') {
    const mapped = viewMap.get(a.bufferView)
    // Silently undefined here produced a file that loaded and was WRONG — the
    // exact failure this catch exists for. Never let a dropped view through.
    if (mapped === undefined) {
      throw new Error(`accessor ${oldIndex}: bufferView ${a.bufferView} dropped`)
    }
    a.bufferView = mapped
  }
  accMap.set(oldIndex, newAccessors.length)
  newAccessors.push(a)
}

const remap = (i: number) => {
  const n = accMap.get(i)
  if (n === undefined) throw new Error(`accessor ${i} dropped but still used`)
  return n
}
const newAnims = kept.map((a) => ({
  ...a,
  samplers: (a.samplers ?? []).map((s: any) => ({
    ...s,
    input: remap(s.input),
    output: remap(s.output),
  })),
}))
const newMeshes = (json.meshes ?? []).map((m) => ({
  ...m,
  primitives: (m.primitives ?? []).map((p: any) => ({
    ...p,
    attributes: Object.fromEntries(
      Object.entries(p.attributes ?? {}).map(([k, v]) => [k, remap(v as number)])
    ),
    ...(typeof p.indices === 'number' ? { indices: remap(p.indices) } : {}),
    ...(p.targets
      ? {
          targets: p.targets.map((t: any) =>
            Object.fromEntries(
              Object.entries(t).map(([k, v]) => [k, remap(v as number)])
            )
          ),
        }
      : {}),
  })),
}))
const newSkins = (json.skins ?? []).map((s) => ({
  ...s,
  ...(typeof s.inverseBindMatrices === 'number'
    ? { inverseBindMatrices: remap(s.inverseBindMatrices) }
    : {}),
}))
const newImages = (json.images ?? []).map((img) => ({
  ...img,
  ...(typeof img.bufferView === 'number'
    ? { bufferView: viewMap.get(img.bufferView) }
    : {}),
}))

const binOut = new Uint8Array(align4(offset))
let at = 0
for (const c of chunks) {
  binOut.set(c, at)
  at += c.byteLength
}

const outJson: Gltf = {
  ...json,
  accessors: newAccessors,
  bufferViews: newViews,
  buffers: [{ byteLength: binOut.byteLength }],
  animations: newAnims,
  meshes: newMeshes,
  ...(json.skins ? { skins: newSkins } : {}),
  ...(json.images ? { images: newImages } : {}),
}

if (process.env.SUBSET_DEBUG)
  console.log(`    [debug] accessors ${newAccessors.length}, views ${newViews.length}, bin ${(offset/1048576).toFixed(2)} MB`)
const jsonBytes = new TextEncoder().encode(JSON.stringify(outJson))
const jsonPad = align4(jsonBytes.length) - jsonBytes.length
const jsonChunk = new Uint8Array(jsonBytes.length + jsonPad)
jsonChunk.set(jsonBytes)
jsonChunk.fill(0x20, jsonBytes.length) // spaces, per the spec

const total = 12 + 8 + jsonChunk.length + 8 + binOut.length
const glb = new Uint8Array(total)
const dv = new DataView(glb.buffer)
dv.setUint32(0, GLB_MAGIC, true)
dv.setUint32(4, 2, true)
dv.setUint32(8, total, true)
dv.setUint32(12, jsonChunk.length, true)
dv.setUint32(16, CHUNK_JSON, true)
glb.set(jsonChunk, 20)
const binHeader = 20 + jsonChunk.length
dv.setUint32(binHeader, binOut.length, true)
dv.setUint32(binHeader + 4, CHUNK_BIN, true)
glb.set(binOut, binHeader + 8)


  return glb
}

/**
 * Write a GLB containing only the named clips. Returns what it did, so a caller
 * (the convert pipeline) can report without re-reading the file.
 *
 * Exported so `bin/convert.ts` can run subsets in-process: they need no Blender,
 * so spawning one would be the slowest part of an otherwise instant operation.
 */
export async function subsetGlb(
  src: string,
  out: string,
  clips: string[]
): Promise<{ from: number; to: number; kept: number; total: number }> {
  const { json, bin } = await loadGlb(src)
  const anims = json.animations ?? []
  const wanted = (name: string) =>
    clips.some((c) =>
      c.endsWith('*') ? name.startsWith(c.slice(0, -1)) : name === c
    )
  const kept = anims.filter((a) => wanted(a.name ?? ''))
  const missing = clips
    .filter((c) => !c.endsWith('*'))
    .filter((c) => !anims.some((a) => a.name === c))
  if (missing.length) {
    // Fatal, not a warning. A silently-missing clip becomes a character frozen
    // in one state at runtime, and tracing that back to a typo is miserable.
    throw new Error(`${src}: no such clip(s): ${missing.join(', ')}`)
  }
  const glb = buildSubset(json, bin, kept)
  await Bun.write(out, glb)
  const from = (await Bun.file(src).arrayBuffer()).byteLength
  return { from, to: glb.byteLength, kept: kept.length, total: anims.length }
}

async function main() {
  const [src, out, ...clips] = Bun.argv.slice(2)
  if (!src) {
    console.error('usage: bun bin/subset-glb.ts <src.glb> <out.glb> <clip…>')
    process.exit(1)
  }
  if (out === '--list') {
    const { json } = await loadGlb(src)
    for (const a of json.animations ?? []) console.log(a.name ?? '(unnamed)')
    console.error(`\n${(json.animations ?? []).length} animations in ${src}`)
    return
  }
  if (!out || clips.length === 0) {
    console.error('usage: bun bin/subset-glb.ts <src.glb> <out.glb> <clip…>')
    process.exit(1)
  }
  try {
    const r = await subsetGlb(src, out, clips)
    console.log(
      `${src} → ${out}\n` +
        `  clips      ${r.total} → ${r.kept}\n` +
        `  size       ${(r.from / 1048576).toFixed(1)} MB → ${(
          r.to / 1048576
        ).toFixed(2)} MB  (${((1 - r.to / r.from) * 100).toFixed(0)}% smaller)`
    )
  } catch (e: any) {
    console.error(String(e.message ?? e))
    process.exit(1)
  }
}

if (import.meta.main) await main()
