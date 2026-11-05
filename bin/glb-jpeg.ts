/*
Re-encode a GLB's PNG textures as JPEG (macOS `sips`), leaving everything
else as it was. AI mesh generators (Meshy, Tripo) write their baked colour,
normal and metallic-roughness maps as PNG: about 15 MB of a 10k-triangle
model. JPEG is core glTF, so every engine reads the result with no extension
(WebP would need EXT_texture_webp).

  bun bin/glb-jpeg.ts in.glb out.glb [--quality 88] [--max 2048]

Images larger than --max are scaled down. A PNG with an alpha channel that
is used is left alone: JPEG has none.
*/
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [input, output, ...rest] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: bun bin/glb-jpeg.ts in.glb out.glb [--quality 88] [--max 2048]')
  process.exit(1)
}
const opt = (name: string, d: number) => {
  const i = rest.indexOf(name)
  return i >= 0 ? Number(rest[i + 1]) : d
}
const quality = opt('--quality', 88)
const max = opt('--max', 2048)

const glb = readFileSync(input)
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${input}: not a GLB`)
const jsonLength = glb.readUInt32LE(12)
const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'))
const binStart = 20 + jsonLength + 8
const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength))

const view = (i: number) => {
  const v = json.bufferViews[i]
  return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
}

// PNG colour type 4 or 6 has alpha; whether any pixel uses it is not
// checked, so such images stay PNG.
const hasAlpha = (png: Buffer) => png[25] === 4 || png[25] === 6

const work = mkdtempSync(join(tmpdir(), 'glb-jpeg-'))
const replaced = new Map<number, Buffer>()
try {
  for (const [i, image] of (json.images ?? []).entries()) {
    if (image.mimeType !== 'image/png' || image.bufferView == null) continue
    const png = Buffer.from(view(image.bufferView))
    if (hasAlpha(png)) {
      console.log(`  ${image.name ?? i}: has alpha, kept as PNG`)
      continue
    }
    const a = join(work, `${i}.png`)
    const b = join(work, `${i}.jpg`)
    writeFileSync(a, png)
    execFileSync('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      '-Z', String(max),
      a, '--out', b,
    ], { stdio: 'ignore' })
    const jpg = readFileSync(b)
    replaced.set(image.bufferView, jpg)
    image.mimeType = 'image/jpeg'
    console.log(`  ${image.name ?? i}: ${(png.length / 1e6).toFixed(1)} → ${(jpg.length / 1e6).toFixed(1)} MB`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

// Rebuild the binary chunk: every view in order, 4-byte aligned.
const parts: Buffer[] = []
let offset = 0
for (const [i, v] of json.bufferViews.entries()) {
  const bytes = replaced.get(i) ?? Buffer.from(view(i))
  const pad = (4 - (offset % 4)) % 4
  if (pad) parts.push(Buffer.alloc(pad))
  offset += pad
  v.byteOffset = offset
  v.byteLength = bytes.length
  parts.push(bytes)
  offset += bytes.length
}
const tail = (4 - (offset % 4)) % 4
if (tail) parts.push(Buffer.alloc(tail))
const newBin = Buffer.concat(parts)
json.buffers[0].byteLength = newBin.length

let text = Buffer.from(JSON.stringify(json), 'utf8')
const jsonPad = (4 - (text.length % 4)) % 4
text = Buffer.concat([text, Buffer.alloc(jsonPad, 0x20)])
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0)
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + text.length + 8 + newBin.length, 8)
const chunk = (type: number, data: Buffer) => {
  const h = Buffer.alloc(8)
  h.writeUInt32LE(data.length, 0)
  h.writeUInt32LE(type, 4)
  return Buffer.concat([h, data])
}
writeFileSync(output, Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, newBin)]))
console.log(`${input} → ${output}: ${(glb.length / 1e6).toFixed(1)} → ${((12 + 16 + text.length + newBin.length) / 1e6).toFixed(1)} MB`)
