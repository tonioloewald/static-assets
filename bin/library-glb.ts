#!/usr/bin/env bun
/**
 * library-glb — pack a whole Kenney kit into ONE glb, no Blender.
 *
 * A kit ships as hundreds of individual glb: Nature Kit is 329 files, Brick Kit
 * 296. Every one of them re-declares the same material and points at the same
 * `Textures/colormap.png` — which means they are not even self-contained; they
 * only work because that texture folder ships beside them. A consuming app that
 * wants a forest pays 60 requests for 60 trees and re-parses the same material
 * table 60 times.
 *
 * A library is that same content as one file: each source model becomes ONE
 * named root node, and everything they share — textures, materials, samplers,
 * and any byte-identical geometry — is stored once. Consumers load the library
 * and clone the node they want by name.
 *
 * WHY glTF SURGERY AND NOT BLENDER. Same reason as `subset-glb.ts`: a glTF is a
 * JSON header over a binary blob, so merging is index remapping plus buffer
 * concatenation — exact, fast, lossless. Round-tripping 4,700 models through an
 * importer and an exporter would be slow and would silently reinterpret
 * materials. Nothing here resamples, requantises or re-authors anything: every
 * byte of geometry that survives is bit-identical to its source.
 *
 * ORIGINALS ARE NEVER TOUCHED. Sources are read-only; output goes to `derived/`.
 *
 *   bun bin/library-glb.ts <out.glb> <dir...>      pack every model in those dirs
 *   bun bin/library-glb.ts <library.glb> --list    what is in a built library
 *
 * The scope of what is safe to merge was measured, not assumed — across all 50
 * kits the only extensions in use are KHR_materials_unlit and
 * KHR_texture_transform, both purely material-level, and there are no cameras,
 * morph targets, multi-scene files or node matrices. Anything outside that set
 * throws rather than producing a file that loads and is quietly wrong.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'

export interface Gltf {
  asset?: any
  scene?: number
  scenes?: any[]
  nodes?: any[]
  meshes?: any[]
  materials?: any[]
  textures?: any[]
  samplers?: any[]
  images?: any[]
  accessors?: any[]
  bufferViews?: any[]
  buffers?: any[]
  animations?: any[]
  skins?: any[]
  cameras?: any[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  extras?: any
  [k: string]: any
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/**
 * Extensions this merger has been verified against. Both are material-level:
 * they ride along inside the material/textureInfo JSON that is copied verbatim
 * and reference no accessor, bufferView or node index that would need remapping.
 * An extension NOT on this list may hold such an index (KHR_draco_mesh_compression
 * and KHR_lights_punctual both do), so it fails the build rather than silently
 * producing a corrupt file.
 */
const SAFE_EXTENSIONS = new Set(['KHR_materials_unlit', 'KHR_texture_transform'])

const align4 = (n: number): number => n + ((4 - (n % 4)) % 4)
const hash = (b: Uint8Array): string =>
  createHash('sha256').update(b).digest('hex').slice(0, 24)

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

// ---------------------------------------------------------------- loading ---

export interface Source {
  /** Where relative `uri` references (external .bin, textures) resolve from. */
  dir: string
  json: Gltf
  bin: Uint8Array
  /** For error messages only — never written into the output. */
  label: string
}

/** Read a .glb, or a .gltf with its external buffers folded in. */
export function loadModel(path: string): Source {
  const dir = dirname(path)
  const label = basename(path)
  if (extname(path).toLowerCase() === '.gltf') {
    const json = JSON.parse(readFileSync(path, 'utf8')) as Gltf
    // Concatenate the external buffers and rebase every view onto the result,
    // so downstream code only ever deals with a single binary blob.
    const parts: Uint8Array[] = []
    const bases: number[] = []
    let total = 0
    for (const b of json.buffers ?? []) {
      let bytes: Uint8Array
      if (typeof b.uri !== 'string') {
        throw new Error(`${label}: .gltf buffer with no uri`)
      } else if (b.uri.startsWith('data:')) {
        bytes = Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64')
      } else {
        bytes = readFileSync(join(dir, decodeURIComponent(b.uri)))
      }
      bases.push(total)
      parts.push(bytes)
      total = align4(total + bytes.byteLength)
    }
    const bin = new Uint8Array(total)
    parts.forEach((p, i) => bin.set(p, bases[i]))
    for (const v of json.bufferViews ?? []) {
      v.byteOffset = (v.byteOffset ?? 0) + bases[v.buffer ?? 0]
      v.buffer = 0
    }
    return { dir, json, bin, label }
  }
  const buf = readFileSync(path)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${label}: not a GLB`)
  let off = 12
  let json: Gltf | null = null
  let bin = new Uint8Array(0)
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = new Uint8Array(buf.buffer, buf.byteOffset + off + 8, len)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body))
    else if (type === CHUNK_BIN) bin = body
    off += 8 + len
    off += (4 - (off % 4)) % 4
  }
  if (json == null) throw new Error(`${label}: no JSON chunk`)
  return { dir, json, bin, label }
}

// ------------------------------------------------------------ naming/tags ---

/**
 * Kenney names models in tokens: `road-slant-high`, `tile_028`, `tentRoofDouble`.
 * The FIRST token is nearly always the thing itself and the rest are variants,
 * so it makes a serviceable automatic category, and the whole token list makes
 * serviceable tags (`hq`, `2x6`, `slant`). Kits where that heuristic picks the
 * wrong token — Brick Kit leads with a bevel style, not the part — override it
 * per-kit in metadata rather than special-casing anything here.
 */
export function tokenize(name: string): string[] {
  return name
    .replace(/\.(glb|gltf)$/i, '')
    .split(/[-_.\s]+/)
    .flatMap((t) => t.replace(/([a-z])([A-Z0-9])/g, '$1 $2').split(' '))
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

/** Glob → RegExp, `*` spanning anything. Mirrors the metadata exclude style. */
const globToRe = (glob: string): RegExp =>
  new RegExp(
    '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i'
  )

export function categoryFor(
  name: string,
  rules: Record<string, string> = {}
): string {
  for (const [glob, category] of Object.entries(rules)) {
    if (globToRe(glob).test(name)) return category
  }
  return tokenize(name)[0] ?? 'misc'
}

// ------------------------------------------------------------------ maths ---

type Mat4 = number[]
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}

/** Column-major TRS to matrix, matching the glTF node convention (T * R * S). */
const trs = (node: any): Mat4 => {
  if (node.matrix) return node.matrix as Mat4
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

const apply = (m: Mat4, p: number[]): number[] => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
]

// ---------------------------------------------------------------- builder ---

export interface LibraryItem {
  /** Node name in the library — the handle a consumer clones by. */
  name: string
  category: string
  tags: string[]
  /** World-space bounding-box size, rounded. Absent if the model has no geometry. */
  size?: number[]
  /** Clip names contributed by this model, already namespaced. */
  clips?: string[]
}

/**
 * Accumulates source documents into one output document, sharing everything
 * shareable. Every `add()` appends one named root node to the single scene.
 */
export class Builder {
  json: Gltf = {
    asset: { version: '2.0', generator: 'tosijs static-assets/library-glb' },
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    samplers: [],
    images: [],
    accessors: [],
    bufferViews: [],
    animations: [],
    skins: [],
  }
  private chunks: Uint8Array[] = []
  private offset = 0
  private viewByKey = new Map<string, number>()
  private accByKey = new Map<string, number>()
  private meshByKey = new Map<string, number>()
  private byKey = new Map<string, number>() // images/samplers/textures/materials
  private extUsed = new Set<string>()
  private extRequired = new Set<string>()
  private names = new Set<string>()
  items: LibraryItem[] = []

  /**
   * Append raw bytes as a bufferView, reusing an identical one if it exists.
   *
   * This dedupe is the quiet win of the whole exercise. Kits repeat geometry
   * across models constantly — the same collision box, the same rig's
   * inverse-bind matrices in all 26 Mini Characters — and byte-identical views
   * are safe to share because a view is just an extent of bytes.
   */
  private addView(bytes: Uint8Array, byteStride?: number, target?: number): number {
    // byteStride and target participate in the key: identical bytes read as a
    // different array under a different stride.
    const key = `${hash(bytes)}:${byteStride ?? ''}:${target ?? ''}`
    const seen = this.viewByKey.get(key)
    if (seen !== undefined) return seen
    const pad = align4(this.offset) - this.offset
    if (pad) {
      this.chunks.push(new Uint8Array(pad))
      this.offset += pad
    }
    const view: any = {
      buffer: 0,
      byteOffset: this.offset,
      byteLength: bytes.byteLength,
    }
    if (byteStride !== undefined) view.byteStride = byteStride
    if (target !== undefined) view.target = target
    this.chunks.push(bytes)
    this.offset += bytes.byteLength
    const index = this.json.bufferViews!.length
    this.json.bufferViews!.push(view)
    this.viewByKey.set(key, index)
    return index
  }

  /** Dedupe any JSON-comparable object (image, sampler, texture, material). */
  private addUnique(list: any[], value: any, kind: string): number {
    const key = kind + ':' + JSON.stringify(value)
    const seen = this.byKey.get(key)
    if (seen !== undefined) return seen
    const index = list.length
    list.push(value)
    this.byKey.set(key, index)
    return index
  }

  add(
    src: Source,
    roots: number[],
    name: string,
    extras: Record<string, any>
  ): LibraryItem {
    if (this.names.has(name)) {
      // Fatal: the node name IS the consumer's handle on the model. Two models
      // answering to one name is a bug you would only find at runtime, as the
      // wrong mesh.
      throw new Error(`duplicate model name "${name}" (from ${src.label})`)
    }
    this.names.add(name)
    const j = src.json

    for (const e of j.extensionsUsed ?? []) {
      if (!SAFE_EXTENSIONS.has(e)) {
        throw new Error(
          `${src.label}: unsupported extension ${e} — this merger has only been ` +
            `verified for ${[...SAFE_EXTENSIONS].join(', ')}`
        )
      }
      this.extUsed.add(e)
    }
    for (const e of j.extensionsRequired ?? []) this.extRequired.add(e)

    // ---- images: embed anything external, share by content ----------------
    const imgMap = new Map<number, number>()
    const images = j.images ?? []
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      let bytes: Uint8Array
      let mime: string | undefined = img.mimeType
      if (typeof img.bufferView === 'number') {
        const v = j.bufferViews![img.bufferView]
        bytes = src.bin.subarray(
          v.byteOffset ?? 0,
          (v.byteOffset ?? 0) + v.byteLength
        )
      } else if (typeof img.uri === 'string' && img.uri.startsWith('data:')) {
        bytes = Buffer.from(img.uri.slice(img.uri.indexOf(',') + 1), 'base64')
        mime = mime ?? img.uri.slice(5, img.uri.indexOf(';'))
      } else if (typeof img.uri === 'string') {
        // The common case: `Textures/colormap.png`, shared by every model in the
        // kit and not part of any of them. Embedding it once is what makes the
        // library self-contained where the sources were not.
        const p = join(src.dir, decodeURIComponent(img.uri))
        if (!existsSync(p)) throw new Error(`${src.label}: missing texture ${img.uri}`)
        bytes = readFileSync(p)
        mime = mime ?? MIME_BY_EXT[extname(p).toLowerCase()]
      } else {
        throw new Error(`${src.label}: image ${i} has neither uri nor bufferView`)
      }
      const view = this.addView(bytes)
      const value: any = { mimeType: mime, bufferView: view }
      if (img.name) value.name = img.name
      imgMap.set(i, this.addUnique(this.json.images!, value, 'image'))
    }

    const sampMap = new Map<number, number>()
    const samplers = j.samplers ?? []
    for (let i = 0; i < samplers.length; i++) {
      sampMap.set(i, this.addUnique(this.json.samplers!, samplers[i], 'sampler'))
    }

    const texMap = new Map<number, number>()
    const textures = j.textures ?? []
    for (let i = 0; i < textures.length; i++) {
      const t = textures[i]
      const copy = { ...t }
      if (typeof t.source === 'number') copy.source = imgMap.get(t.source)
      if (typeof t.sampler === 'number') copy.sampler = sampMap.get(t.sampler)
      texMap.set(i, this.addUnique(this.json.textures!, copy, 'texture'))
    }

    // Materials carry texture indices in several nested places (and inside
    // KHR_texture_transform), so remap by walking for `index` keys rather than
    // enumerating the known slots and missing one.
    const remapTextures = (value: any): any => {
      if (Array.isArray(value)) return value.map(remapTextures)
      if (value && typeof value === 'object') {
        const out: any = {}
        for (const [k, v] of Object.entries(value)) {
          out[k] =
            k === 'index' && typeof v === 'number'
              ? texMap.get(v) ?? v
              : remapTextures(v)
        }
        return out
      }
      return value
    }
    const matMap = new Map<number, number>()
    const materials = j.materials ?? []
    for (let i = 0; i < materials.length; i++) {
      matMap.set(
        i,
        this.addUnique(this.json.materials!, remapTextures(materials[i]), 'material')
      )
    }

    // ---- accessors (and the views they read) ------------------------------
    const accMap = new Map<number, number>()
    const copyAccessor = (i: number): number => {
      const cached = accMap.get(i)
      if (cached !== undefined) return cached
      const a = j.accessors![i]
      if (a.sparse) throw new Error(`${src.label}: sparse accessor ${i} not supported`)
      const copy: any = { ...a }
      if (typeof a.bufferView === 'number') {
        const v = j.bufferViews![a.bufferView]
        const start = v.byteOffset ?? 0
        copy.bufferView = this.addView(
          src.bin.subarray(start, start + v.byteLength),
          v.byteStride,
          v.target
        )
      }
      const key = JSON.stringify(copy)
      const shared = this.accByKey.get(key)
      const index = shared ?? this.json.accessors!.length
      if (shared === undefined) {
        this.json.accessors!.push(copy)
        this.accByKey.set(key, index)
      }
      accMap.set(i, index)
      return index
    }

    const meshMap = new Map<number, number>()
    const copyMesh = (i: number): number => {
      const cached = meshMap.get(i)
      if (cached !== undefined) return cached
      const m = j.meshes![i]
      const copy = {
        ...m,
        primitives: (m.primitives ?? []).map((p: any) => {
          if (p.mode !== undefined && p.mode !== 4) {
            throw new Error(`${src.label}: primitive mode ${p.mode} not supported`)
          }
          if (p.targets) throw new Error(`${src.label}: morph targets not supported`)
          const q: any = {
            ...p,
            attributes: Object.fromEntries(
              Object.entries(p.attributes ?? {}).map(([k, v]) => [
                k,
                copyAccessor(v as number),
              ])
            ),
          }
          if (typeof p.indices === 'number') q.indices = copyAccessor(p.indices)
          if (typeof p.material === 'number') q.material = matMap.get(p.material)
          return q
        }),
      }
      const key = JSON.stringify(copy)
      const shared = this.meshByKey.get(key)
      const index = shared ?? this.json.meshes!.length
      if (shared === undefined) {
        this.json.meshes!.push(copy)
        this.meshByKey.set(key, index)
      }
      meshMap.set(i, index)
      return index
    }

    // ---- nodes: copy the subtree(s) under `roots` -------------------------
    const nodeMap = new Map<number, number>()
    const pendingSkins: { node: number; skin: number }[] = []
    const copyNode = (i: number): number => {
      const cached = nodeMap.get(i)
      if (cached !== undefined) return cached
      const n = j.nodes![i]
      if (typeof n.camera === 'number') throw new Error(`${src.label}: cameras not supported`)
      const index = this.json.nodes!.length
      const copy: any = { ...n }
      delete copy.skin
      this.json.nodes!.push(copy)
      nodeMap.set(i, index)
      if (typeof n.mesh === 'number') copy.mesh = copyMesh(n.mesh)
      if (n.children) copy.children = n.children.map(copyNode)
      if (typeof n.skin === 'number') pendingSkins.push({ node: index, skin: n.skin })
      return index
    }
    const copiedRoots = roots.map(copyNode)

    const skinMap = new Map<number, number>()
    for (const { node, skin } of pendingSkins) {
      if (!skinMap.has(skin)) {
        const s = j.skins![skin]
        const joints = (s.joints ?? []).map((joint: number) => {
          const mapped = nodeMap.get(joint)
          // A joint outside the copied subtree would bind the skin to the wrong
          // node — silently, and visible only as a mangled pose.
          if (mapped === undefined) {
            throw new Error(`${src.label}: skin joint ${joint} outside the model subtree`)
          }
          return mapped
        })
        const copy: any = { ...s, joints }
        if (typeof s.skeleton === 'number') copy.skeleton = nodeMap.get(s.skeleton)
        if (typeof s.inverseBindMatrices === 'number') {
          copy.inverseBindMatrices = copyAccessor(s.inverseBindMatrices)
        }
        skinMap.set(skin, this.json.skins!.length)
        this.json.skins!.push(copy)
      }
      this.json.nodes![node].skin = skinMap.get(skin)
    }

    // ---- animations: namespaced, so 26 characters can all have "walk" -----
    const clips: string[] = []
    const anims = j.animations ?? []
    for (let i = 0; i < anims.length; i++) {
      const anim = anims[i]
      const channels = (anim.channels ?? [])
        .filter((c: any) => nodeMap.has(c.target?.node))
        .map((c: any) => ({
          ...c,
          target: { ...c.target, node: nodeMap.get(c.target.node) },
        }))
      if (!channels.length) continue
      // Samplers are copied wholesale (channels index into this array), so the
      // channel sampler indices stay valid and need no renumbering.
      const samplers = (anim.samplers ?? []).map((s: any) => ({
        ...s,
        input: copyAccessor(s.input),
        output: copyAccessor(s.output),
      }))
      // Namespaced ONCE. Subsetting re-adds models that are already namespaced,
      // and prefixing again would rename every clip the moment an app switched
      // from the full library to a subset of it — the clip name is part of the
      // contract, so it has to survive the round trip unchanged.
      const raw = anim.name || `clip${i}`
      const clip = raw.startsWith(`${name}/`) ? raw : `${name}/${raw}`
      clips.push(clip)
      this.json.animations!.push({ ...anim, name: clip, channels, samplers })
    }

    // ---- wrap: one named root node per model ------------------------------
    // Always wrapped, even when the source has a single root, so the library has
    // the same shape for every model and scene.nodes maps 1:1 to the index.
    const wrapper = this.json.nodes!.length
    this.json.nodes!.push({
      name,
      children: copiedRoots,
      extras: { ...extras, ...(clips.length ? { clips } : {}) },
    })
    this.json.scenes![0].nodes.push(wrapper)

    const item: LibraryItem = {
      name,
      category: extras.category,
      tags: extras.tags,
      ...(clips.length ? { clips } : {}),
    }
    const size = this.measure(wrapper)
    if (size) item.size = size
    this.items.push(item)
    return item
  }

  /** World-space bbox of a subtree, from the POSITION min/max glTF requires. */
  private measure(root: number): number[] | undefined {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    const visit = (i: number, parent: Mat4): void => {
      const n = this.json.nodes![i]
      const m = multiply(parent, trs(n))
      if (typeof n.mesh === 'number') {
        for (const p of this.json.meshes![n.mesh].primitives ?? []) {
          const a = this.json.accessors![p.attributes?.POSITION]
          if (!a?.min || !a?.max) continue
          for (let corner = 0; corner < 8; corner++) {
            const local = [
              corner & 1 ? a.max[0] : a.min[0],
              corner & 2 ? a.max[1] : a.min[1],
              corner & 4 ? a.max[2] : a.min[2],
            ]
            const w = apply(m, local)
            for (let c = 0; c < 3; c++) {
              if (w[c] < min[c]) min[c] = w[c]
              if (w[c] > max[c]) max[c] = w[c]
            }
          }
        }
      }
      for (const child of n.children ?? []) visit(child, m)
    }
    visit(root, IDENTITY)
    if (!Number.isFinite(min[0])) return undefined
    return [0, 1, 2].map((c) => Math.round((max[c] - min[c]) * 1000) / 1000)
  }

  /** Serialise to a GLB. `sceneExtras` is where the library index lands. */
  finish(assetExtras: any, sceneExtras: any): Uint8Array {
    const bin = new Uint8Array(align4(this.offset))
    let at = 0
    for (const c of this.chunks) {
      bin.set(c, at)
      at += c.byteLength
    }
    const json: Gltf = { ...this.json }
    json.buffers = [{ byteLength: bin.byteLength }]
    json.asset = { ...json.asset, extras: assetExtras }
    json.scenes = [{ ...this.json.scenes![0], extras: sceneExtras }]
    if (this.extUsed.size) json.extensionsUsed = [...this.extUsed]
    if (this.extRequired.size) json.extensionsRequired = [...this.extRequired]
    for (const k of ['animations', 'skins', 'images', 'samplers', 'textures'] as const) {
      if (!json[k]?.length) delete json[k]
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
    const jsonChunk = new Uint8Array(align4(jsonBytes.length))
    jsonChunk.set(jsonBytes)
    jsonChunk.fill(0x20, jsonBytes.length) // spaces, per the spec
    const total = 12 + 8 + jsonChunk.length + 8 + bin.length
    const glb = new Uint8Array(total)
    const dv = new DataView(glb.buffer)
    dv.setUint32(0, GLB_MAGIC, true)
    dv.setUint32(4, 2, true)
    dv.setUint32(8, total, true)
    dv.setUint32(12, jsonChunk.length, true)
    dv.setUint32(16, CHUNK_JSON, true)
    glb.set(jsonChunk, 20)
    const binHeader = 20 + jsonChunk.length
    dv.setUint32(binHeader, bin.length, true)
    dv.setUint32(binHeader + 4, CHUNK_BIN, true)
    glb.set(bin, binHeader + 8)
    return glb
  }
}

// ------------------------------------------------------------- entrypoints ---

export interface LibrarySpec {
  /** Directories of source models, relative to the kit dir. Later wins on a name clash. */
  from: string[]
  /** name-glob → category, first match wins; otherwise the first name token. */
  categories?: Record<string, string>
  /** Models NOT to include (name globs, no extension). */
  exclude?: string[]
}

const MODEL_RE = /\.(glb|gltf)$/i

/**
 * Collect the model files of a kit, deduped by model name.
 *
 * Some kits ship BOTH a `GLB format` and a `GLTF format` folder holding largely
 * DIFFERENT models (Retro Fantasy: 105 and 55, only 9 in common), so a library
 * takes the union rather than picking a folder and quietly dropping half the kit.
 */
export function collectModels(
  kitDir: string,
  from: string[],
  exclude: string[] = []
): { name: string; path: string }[] {
  const excluded = exclude.map(globToRe)
  const byName = new Map<string, string>()
  for (const rel of from) {
    const dir = join(kitDir, rel)
    if (!existsSync(dir)) throw new Error(`no such model dir: ${dir}`)
    for (const entry of readdirSync(dir).sort()) {
      if (!MODEL_RE.test(entry)) continue
      const name = entry.replace(MODEL_RE, '')
      if (excluded.some((re) => re.test(name))) continue
      byName.set(name, join(dir, entry))
    }
  }
  return [...byName.entries()]
    .map(([name, path]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface BuildResult {
  glb: Uint8Array
  items: LibraryItem[]
  /** Total bytes of the sources, for the size report. */
  from: number
}

/**
 * Absolute paths of the files a source references but does not contain — a
 * .gltf's `.bin` sidecar, a kit's shared `Textures/colormap.png`.
 *
 * These count toward what a consumer of the ORIGINALS actually has to download,
 * which is the only honest baseline to measure a library against: comparing a
 * self-contained library to .gltf files whose geometry lives in sidecars made
 * the build look like it had tripled the size when it had not.
 */
function externalRefs(src: Source): string[] {
  const uris = [...(src.json.buffers ?? []), ...(src.json.images ?? [])]
    .map((x: any) => x.uri)
    .filter((u: any): u is string => typeof u === 'string' && !u.startsWith('data:'))
  return uris.map((u) => join(src.dir, decodeURIComponent(u)))
}

/**
 * Build a library from a kit directory.
 *
 * `attribution` is written to `asset.extras` — credit, licence and author link,
 * so the file carries its provenance the same way the response headers do.
 * Source PATHS are deliberately not recorded: the library needs to say who made
 * this content, not how to go looking for the rest of it.
 */
export function buildLibrary(opts: {
  kitDir: string
  spec: LibrarySpec
  attribution?: Record<string, string>
}): BuildResult {
  const models = collectModels(opts.kitDir, opts.spec.from, opts.spec.exclude)
  if (!models.length) throw new Error(`${opts.kitDir}: no models found`)
  const b = new Builder()
  let from = 0
  const counted = new Set<string>() // shared sidecars count once, as a consumer pays once
  for (const m of models) {
    const src = loadModel(m.path)
    from += statSync(m.path).size
    for (const ref of externalRefs(src)) {
      if (counted.has(ref) || !existsSync(ref)) continue
      counted.add(ref)
      from += statSync(ref).size
    }
    const scene = src.json.scenes?.[src.json.scene ?? 0]
    const roots: number[] = scene?.nodes ?? []
    if (!roots.length) throw new Error(`${m.path}: no scene nodes`)
    const tags = tokenize(m.name)
    b.add(src, roots, m.name, {
      category: categoryFor(m.name, opts.spec.categories),
      tags,
    })
  }
  return { glb: finishLibrary(b, opts.attribution), items: b.items, from }
}

/**
 * The index lives in `scenes[0].extras` — which three.js hands back as
 * `gltf.scene.userData` — and per-model copies live on each node's `extras`
 * (`object.userData`). It sits in the JSON chunk at the FRONT of the glb, so a
 * consumer that only wants the catalogue can range-request the head of the file
 * and never fetch the geometry.
 */
function finishLibrary(b: Builder, attribution?: Record<string, string>): Uint8Array {
  const categories: Record<string, number> = {}
  for (const item of b.items) {
    categories[item.category] = (categories[item.category] ?? 0) + 1
  }
  return b.finish(
    { ...attribution },
    {
      library: {
        count: b.items.length,
        categories,
        items: b.items,
      },
    }
  )
}

/**
 * Build a smaller library from a built one, keeping whole models.
 *
 * The same idea as subsetting Quaternius' animation megafiles, one level up: a
 * kit library is the complete kit, and an app usually wants a slice of it. Each
 * pattern is a name glob (`tree_*`) or `category:<name>`; everything the kept
 * models reference is carried over and everything else is dropped.
 */
export function subsetLibrary(
  src: Source,
  keep: string[]
): { glb: Uint8Array; items: LibraryItem[]; kept: number; total: number } {
  const scene = src.json.scenes?.[src.json.scene ?? 0]
  const roots: number[] = scene?.nodes ?? []
  const wanted = keep.map((k) =>
    k.startsWith('category:')
      ? { category: k.slice('category:'.length).toLowerCase() }
      : { re: globToRe(k) }
  )
  const b = new Builder()
  const missing = new Set(keep)
  for (const root of roots) {
    const node = src.json.nodes![root]
    const extras = node.extras ?? {}
    const name: string = node.name ?? ''
    const hit = keep.filter((k, i) => {
      const w = wanted[i]
      return 'category' in w
        ? String(extras.category ?? '').toLowerCase() === w.category
        : (w as any).re.test(name)
    })
    if (!hit.length) continue
    for (const h of hit) missing.delete(h)
    b.add(src, node.children ?? [], name, {
      category: extras.category,
      tags: extras.tags,
    })
  }
  if (missing.size) {
    // Fatal for the same reason a missing animation clip is: a silently absent
    // model shows up as a hole in a scene, long after the build.
    throw new Error(`no models matched: ${[...missing].join(', ')}`)
  }
  const attribution = src.json.asset?.extras
  return {
    glb: finishLibrary(b, attribution),
    items: b.items,
    kept: b.items.length,
    total: roots.length,
  }
}

// -------------------------------------------------------------------- cli ---

async function main(): Promise<void> {
  const [out, ...rest] = Bun.argv.slice(2)
  if (!out) {
    console.error(
      'usage: bun bin/library-glb.ts <out.glb> <model-dir...>\n' +
        '       bun bin/library-glb.ts <library.glb> --list'
    )
    process.exit(1)
  }
  if (rest[0] === '--list') {
    const { json } = loadModel(out)
    const lib = json.scenes?.[json.scene ?? 0]?.extras?.library
    if (!lib) {
      console.error(`${out}: no library index (not built by library-glb?)`)
      process.exit(1)
    }
    for (const item of lib.items as LibraryItem[]) {
      const size = item.size ? `  [${item.size.join(' x ')}]` : ''
      const clips = item.clips?.length ? `  ${item.clips.length} clips` : ''
      console.log(`${item.category.padEnd(14)} ${item.name}${size}${clips}`)
    }
    const cats = Object.entries(lib.categories as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} ${n}`)
      .join(', ')
    console.error(`\n${lib.count} models in ${out}\n${cats}`)
    return
  }
  if (!rest.length) {
    console.error('usage: bun bin/library-glb.ts <out.glb> <model-dir...>')
    process.exit(1)
  }
  // Dirs are given absolute-ish on the CLI, so the "kit dir" is the cwd and the
  // spec paths are whatever the caller typed.
  const r = buildLibrary({ kitDir: '.', spec: { from: rest } })
  await Bun.write(out, r.glb)
  console.log(
    `${r.items.length} models → ${out}\n` +
      `  size       ${(r.from / 1048576).toFixed(2)} MB → ${(
        r.glb.byteLength / 1048576
      ).toFixed(2)} MB  (${((1 - r.glb.byteLength / r.from) * 100).toFixed(0)}% smaller)`
  )
}

if (import.meta.main) await main()
