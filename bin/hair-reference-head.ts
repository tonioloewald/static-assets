#!/usr/bin/env bun
/**
 * hair-reference-head — the heads Quaternius' hairstyles were modelled on, as
 * plain (unskinned) models in the hairstyles folder, so the hairstyles
 * library carries them as `Reference_Head_Male` and `Reference_Head_Female`.
 *
 * tosijs-3d fits hair to another body by fitting THIS skin to that body's
 * skin and carrying each hair vertex with the skull under it. Fitting the
 * hair itself does not work: a style is one outer shell with no underside, so
 * laying it on the skin sinks it by the hair's thickness.
 *
 * Two heads: the men's styles sit on Regular_Male_OnlyHead (its brows are
 * Eyebrows_Regular vertex for vertex; the buzz cut clears its crown by 4 mm),
 * the women's on Regular_Female_OnlyHead (4.4 cm lower at the crown; Bob and
 * Long clear it by 1.1 cm and would sink into the man's).
 * Only the head's geometry is kept: positions, normals and triangles, as
 * they are in the file (the bind pose, which is the pose the hair was made in).
 *
 *   bun bin/hair-reference-head.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'assets/quaternius/hairstyles')

for (const [from, mesh, name] of [
  ['Regular_Male_OnlyHead', 'RegularMale.001', 'Reference_Head_Male'],
  ['Regular_Female_OnlyHead', null, 'Reference_Head_Female'],
] as const) {
const j = JSON.parse(readFileSync(join(ROOT, 'assets/quaternius/characters', from + '.gltf'), 'utf8'))
const bin = readFileSync(join(ROOT, 'assets/quaternius/characters', j.buffers[0].uri))
// The head is the mesh that is not the brows or the eyes.
const node =
  j.nodes.find((n: any) => n.name === mesh) ??
  j.nodes.find((n: any) => n.mesh != null && !/Eye/i.test(n.name))
if (node == null) throw new Error(`no head mesh in ${from}`)
const prim = j.meshes[node.mesh].primitives[0]

function read(index: number): Uint8Array {
  const a = j.accessors[index]
  const v = j.bufferViews[a.bufferView]
  const size = { 5123: 2, 5125: 4, 5126: 4 }[a.componentType as 5123 | 5125 | 5126]!
  const n = { SCALAR: 1, VEC3: 3 }[a.type as 'SCALAR' | 'VEC3']!
  if (v.byteStride && v.byteStride !== size * n) throw new Error('interleaved data')
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return new Uint8Array(bin.subarray(start, start + a.count * size * n))
}

const pos = j.accessors[prim.attributes.POSITION]
const nrm = j.accessors[prim.attributes.NORMAL]
const idx = j.accessors[prim.indices]
const parts = [read(prim.attributes.POSITION), read(prim.attributes.NORMAL), read(prim.indices)]
let offset = 0
const views = parts.map((p, i) => {
  const view = { buffer: 0, byteOffset: offset, byteLength: p.length, target: i < 2 ? 34962 : 34963 }
  offset += Math.ceil(p.length / 4) * 4
  return view
})
const out = new Uint8Array(offset)
parts.forEach((p, i) => out.set(p, views[i].byteOffset))

const gltf = {
  asset: { version: '2.0', generator: 'static-assets hair-reference-head' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name, mesh: 0 }],
  meshes: [
    {
      name,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }],
    },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.count, type: 'VEC3', min: pos.min, max: pos.max },
    { bufferView: 1, componentType: 5126, count: nrm.count, type: 'VEC3' },
    { bufferView: 2, componentType: idx.componentType, count: idx.count, type: 'SCALAR' },
  ],
  bufferViews: views,
  buffers: [{ uri: name + '.bin', byteLength: out.length }],
}
writeFileSync(join(OUT, name + '.gltf'), JSON.stringify(gltf, null, 1))
writeFileSync(join(OUT, name + '.bin'), out)
console.log(`${name}: ${pos.count} vertices, ${idx.count / 3} triangles, ${out.length} bytes`)
}
