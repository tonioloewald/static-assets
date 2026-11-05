/*
Tonio's test weapons (made for omnidude) as a held-item library: each weapon
a `.model` export whose ORIGIN IS ITS MAIN-HAND GRIP, at a real size, with
marker nodes for what the engine reads.

  bun bin/tonio-weapons.ts [source.glb] [out.glb]

Default: assets/tonio/weapons/source/weapons.glb → assets/tonio/weapons/weapons.glb.

The convention (glTF axes, metres): +Y up along the grip, +Z forward (a gun's
muzzle, a blade's edge), the left hand on +X. The source already holds every
weapon that way; this moves each origin onto its grip and sets its size,
baking both into the vertices (a library load drops the top node's own
transform). Markers, children of each weapon:

- `<name>_grip`: the main hand (the origin, so a reader need not guess);
- `<name>_muzzle`: where a gun's shot leaves, on its axis;
- `<name>_tip`: a blade's or a spear's point.

The grip is found by rule, not by hand: a gun's is its rearmost handle under
the body; a blade's is half a hand below its guard; a spear's two fifths of
the way up from its butt; a shield's is the middle of its back.
*/
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Kind = 'gun' | 'blade' | 'spear' | 'shield' | 'prop'
/** Each weapon: its kind, and its size along its longest axis in metres. */
const WEAPONS: Record<string, { kind: Kind; size: number }> = {
  Pistol: { kind: 'gun', size: 0.264 },
  SMG: { kind: 'gun', size: 0.536 },
  'Assault Rifle': { kind: 'gun', size: 0.9 },
  'Rocket Launcher': { kind: 'gun', size: 0.994 },
  Dagger: { kind: 'blade', size: 0.42 },
  'Short Sword': { kind: 'blade', size: 0.75 },
  'Long Sword': { kind: 'blade', size: 1.15 },
  'Hand and a Half': { kind: 'blade', size: 1.3 },
  Spear: { kind: 'spear', size: 2.32 },
  Buckler: { kind: 'shield', size: 0.4 },
  'Game Controller': { kind: 'prop', size: 0.16 },
}
/** Half a hand's width: a blade's grip centre below its guard. */
const HALF_HAND = 0.05

const root = join(import.meta.dir, '..', 'assets', 'tonio', 'weapons')
const [input = join(root, 'source', 'weapons.glb'), output = join(root, 'weapons.glb')] =
  process.argv.slice(2)

// --- the GLB ---
const file = readFileSync(input)
const jsonLength = file.readUInt32LE(12)
const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8'))
const binStart = 20 + jsonLength + 8
const bin = file.subarray(binStart, binStart + file.readUInt32LE(20 + jsonLength))
const parts: Buffer[] = [Buffer.from(bin)]
let binLength = bin.length

function readFloats(accessor: number): Float32Array {
  const a = json.accessors[accessor]
  const v = json.bufferViews[a.bufferView]
  // Cheetah 3D interleaves position, normal and uv: read each element by stride.
  const stride = v.byteStride ?? 12
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const out = new Float32Array(a.count * 3)
  for (let e = 0; e < a.count; e++)
    for (let k = 0; k < 3; k++) out[e * 3 + k] = bin.readFloatLE(start + e * stride + k * 4)
  return out
}
/** A new POSITION accessor with these values (the old one is left unused). */
function writePositions(values: Float32Array): number {
  const pad = (4 - (binLength % 4)) % 4
  if (pad) parts.push(Buffer.alloc(pad))
  binLength += pad
  json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: values.byteLength, target: 34962 })
  parts.push(Buffer.from(values.buffer))
  binLength += values.byteLength
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < values.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], values[i + k])
      max[k] = Math.max(max[k], values[i + k])
    }
  json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: values.length / 3, type: 'VEC3', min, max })
  return json.accessors.length - 1
}

// --- transforms (column-major) ---
type V3 = [number, number, number]
function trs(n: any): (p: V3) => V3 {
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  return ([px, py, pz]) => {
    const a = px * sx, b = py * sy, c = pz * sz
    // q * v * q^-1
    const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c
    return [
      ix * w + iw * -x + iy * -z - iz * -y + tx,
      iy * w + iw * -y + iz * -x - ix * -z + ty,
      iz * w + iw * -z + ix * -y - iy * -x + tz,
    ]
  }
}
const meshPositions = (n: any): Float32Array[] =>
  n.mesh == null ? [] : json.meshes[n.mesh].primitives.map((p: any) => readFloats(p.attributes.POSITION))

/** A weapon's points in its own frame, its own scale left out (children placed). */
function pointsOf(i: number): V3[] {
  const n = json.nodes[i]
  const pts: V3[] = []
  for (const f of meshPositions(n)) for (let k = 0; k < f.length; k += 3) pts.push([f[k], f[k + 1], f[k + 2]])
  for (const c of n.children ?? []) {
    const place = trs(json.nodes[c])
    for (const f of meshPositions(json.nodes[c]))
      for (let k = 0; k < f.length; k += 3) pts.push(place([f[k], f[k + 1], f[k + 2]]))
  }
  return pts
}

const range = (pts: V3[], k: number) => {
  let lo = Infinity, hi = -Infinity
  for (const p of pts) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]) }
  return [lo, hi] as const
}

/** The grip, by kind (see the header). `own` leaves out its parts (a stock). */
function gripOf(kind: Kind, pts: V3[], own: V3[]): V3 {
  const [y0, y1] = range(pts, 1)
  const [z0, z1] = range(pts, 2)
  if (kind === 'gun') {
    // Under the body; the rearmost handle (a magazine is further forward).
    // Clusters are found well under the body, then the handle is taken up
    // to where it meets the body (y = 0, the source's origin).
    const low = own.filter((p) => p[1] < -0.02).sort((a, b) => a[2] - b[2])
    const cluster: V3[] = [low[0]]
    for (let i = 1; i < low.length && low[i][2] - low[i - 1][2] < 0.05; i++) cluster.push(low[i])
    const [cz0, cz1] = range(cluster, 2)
    const handle = own.filter((p) => p[1] < 0 && p[2] >= cz0 - 0.005 && p[2] <= cz1 + 0.005)
    const [cy0] = range(handle, 1)
    return [0, cy0 / 2, (cz0 + cz1) / 2]
  }
  if (kind === 'blade') {
    // The guard is the widest part across the edge.
    const reach = Math.max(...pts.map((p) => Math.abs(p[2])))
    const guard = Math.min(...pts.filter((p) => Math.abs(p[2]) >= 0.9 * reach).map((p) => p[1]))
    return [0, guard - HALF_HAND, 0]
  }
  if (kind === 'spear') return [0, y0 + 0.4 * (y1 - y0), 0]
  if (kind === 'shield') return [0, (y0 + y1) / 2, z0]
  const [x0, x1] = range(pts, 0)
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
}

/** A gun's muzzle: the front face's middle, on its axis. A point's tip: the top. */
function markerOf(kind: Kind, pts: V3[]): { name: string; at: V3 } | null {
  if (kind === 'gun') {
    const [, z1] = range(pts, 2)
    const front = pts.filter((p) => p[2] >= z1 - 0.005)
    const [fy0, fy1] = range(front, 1)
    return { name: 'muzzle', at: [0, (fy0 + fy1) / 2, z1] }
  }
  if (kind === 'blade' || kind === 'spear') return { name: 'tip', at: [0, range(pts, 1)[1], 0] }
  return null
}

const report: string[] = []
for (const [i, node] of (json.nodes as any[]).entries()) {
  const spec = WEAPONS[node.name]
  if (spec == null) continue
  const pts = pointsOf(i)
  const own: V3[] = []
  for (const f of meshPositions(node)) for (let k = 0; k < f.length; k += 3) own.push([f[k], f[k + 1], f[k + 2]])
  const extent = Math.max(...[0, 1, 2].map((k) => { const [a, b] = range(pts, k); return b - a }))
  const f = spec.size / extent
  const g = gripOf(spec.kind, pts, own)
  const marker = markerOf(spec.kind, pts)
  const move = ([x, y, z]: V3): V3 => [(x - g[0]) * f, (y - g[1]) * f, (z - g[2]) * f]
  // The weapon's own vertices: about the grip, at size.
  for (const p of node.mesh != null ? json.meshes[node.mesh].primitives : []) {
    const v = readFloats(p.attributes.POSITION)
    for (let k = 0; k < v.length; k += 3) v.set(move([v[k], v[k + 1], v[k + 2]]), k)
    p.attributes.POSITION = writePositions(v)
  }
  // Its parts (a scope, a stock): placed from the grip, their vertices at size.
  for (const c of node.children ?? []) {
    const child = json.nodes[c]
    child.translation = move(child.translation ?? [0, 0, 0])
    for (const p of child.mesh != null ? json.meshes[child.mesh].primitives : []) {
      const v = readFloats(p.attributes.POSITION)
      for (let k = 0; k < v.length; k += 3) { v[k] *= f; v[k + 1] *= f; v[k + 2] *= f }
      p.attributes.POSITION = writePositions(v)
    }
  }
  // Size is in the vertices now; the scene's layout stays.
  delete node.scale
  const markers: Array<[string, V3]> = [['grip', [0, 0, 0]]]
  if (marker) markers.push([marker.name, move(marker.at)])
  for (const [m, at] of markers) {
    json.nodes.push({ name: `${node.name}_${m}`, translation: at.map((x) => Number(x.toFixed(5))) })
    node.children = [...(node.children ?? []), json.nodes.length - 1]
  }
  report.push(`${node.name}: ${extent.toFixed(3)} → ${spec.size} m, grip at ${g.map((x) => x.toFixed(3)).join(', ')}${marker ? `, ${marker.name} ${move(marker.at).map((x) => x.toFixed(3)).join(', ')}` : ''}`)
  node.name = `${node.name}.model`
}

// --- write ---
const newBin = Buffer.concat(parts)
const binPad = (4 - (newBin.length % 4)) % 4
const fullBin = Buffer.concat([newBin, Buffer.alloc(binPad)])
json.buffers[0].byteLength = fullBin.length
let text = Buffer.from(JSON.stringify(json), 'utf8')
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
const chunk = (type: number, data: Buffer) => {
  const h = Buffer.alloc(8)
  h.writeUInt32LE(data.length, 0)
  h.writeUInt32LE(type, 4)
  return Buffer.concat([h, data])
}
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0)
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + text.length + 8 + fullBin.length, 8)
writeFileSync(output, Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, fullBin)]))
console.log(report.join('\n'))
console.log(`${input} → ${output}`)
