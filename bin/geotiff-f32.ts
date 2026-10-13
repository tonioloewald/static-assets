#!/usr/bin/env bun
/**
 * geotiff-f32 — read a tiled, Deflate-compressed, float32 GeoTIFF, one band of
 * rows at a time.
 *
 * Written because ffmpeg cannot read one. ETOPO 2022 is 21600x10800 IEEE float32
 * in 256x256 tiles with Deflate and the floating-point predictor, and ffmpeg's
 * TIFF decoder answers "Could not find codec parameters: unspecified size". GDAL
 * would of course do this, but it is not installed and a 443 MB dependency to
 * read one file is a poor trade when the format is this well specified.
 *
 * It is deliberately narrow: tiled, single-sample, float32, Deflate, predictor 1
 * or 3. Anything else throws by name rather than guessing, because a silently
 * misread elevation model still looks like terrain.
 *
 * Rows arrive a tile-band at a time (256 rows), so a 933 MB raster never exists
 * in memory at once — the caller can stream it straight out to disk.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'
// node:zlib, not Bun.inflateSync: TIFF's Deflate is zlib-WRAPPED (tiles start
// 0x78 0x9c) and Bun's is raw-only, which fails as 'invalid stored block lengths'.
import { inflateSync } from 'node:zlib'

export interface Float32Raster {
  width: number
  height: number
  /** Calls back with each horizontal band: y0, the row count, and width*rows samples. */
  bands: (cb: (y0: number, rows: number, data: Float32Array) => void) => void
}

const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
} as const

/**
 * Undo libtiff's floating-point predictor (tag 317 = 3).
 *
 * Two steps, and both matter. The bytes of a row are first a running sum — each
 * byte holds its difference from the one `stride` back — and once that is undone
 * they are still arranged in BYTE PLANES: every sample's most significant byte
 * first, then every second byte, and so on. That layout is the point of the
 * predictor (it puts similar magnitudes next to each other so Deflate has
 * something to chew on), and it has to be transposed back to interleaved before
 * the bytes mean anything as floats.
 */
function unpredictFloat(row: Uint8Array, samples: number, bytesPerSample: number): void {
  const stride = 1 // one sample per pixel
  for (let i = stride; i < row.length; i++) row[i] = (row[i] + row[i - stride]) & 0xff

  const tmp = row.slice()
  for (let s = 0; s < samples; s++) {
    for (let b = 0; b < bytesPerSample; b++) {
      // little-endian: the first plane in the stream is the MOST significant byte
      row[bytesPerSample * s + b] = tmp[(bytesPerSample - b - 1) * samples + s]
    }
  }
}

export function readFloat32Tiff(path: string): Float32Raster {
  const fd = openSync(path, 'r')
  const size = statSync(path).size
  const at = (offset: number, length: number): Buffer => {
    const b = Buffer.alloc(length)
    readSync(fd, b, 0, length, offset)
    return b
  }

  const head = at(0, 8)
  const le = head.toString('latin1', 0, 2) === 'II'
  if (!le && head.toString('latin1', 0, 2) !== 'MM') throw new Error(`${path}: not a TIFF`)
  const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  if (u16(head, 2) !== 42) throw new Error(`${path}: BigTIFF is not supported`)

  const ifdAt = u32(head, 4)
  const count = u16(at(ifdAt, 2), 0)
  const entries = at(ifdAt + 2, count * 12)
  const tags = new Map<number, { type: number; count: number; raw: Buffer }>()
  for (let i = 0; i < count; i++) {
    const e = entries.subarray(i * 12, i * 12 + 12)
    tags.set(u16(e, 0), { type: u16(e, 2), count: u32(e, 4), raw: e.subarray(8, 12) })
  }

  /** A tag's values, following the offset when they do not fit in four bytes. */
  const values = (tag: number): number[] => {
    const t = tags.get(tag)
    if (!t) return []
    const width = t.type === 3 ? 2 : 4 // SHORT or LONG; nothing here uses others
    const total = t.count * width
    const buf = total <= 4 ? t.raw : at(u32(t.raw, 0), total)
    const out: number[] = []
    for (let i = 0; i < t.count; i++) {
      out.push(width === 2 ? u16(buf, i * 2) : u32(buf, i * 4))
    }
    return out
  }
  const one = (tag: number, fallback?: number): number => {
    const v = values(tag)[0]
    if (v === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(`${path}: missing TIFF tag ${tag}`)
    }
    return v
  }

  const width = one(TAG.width)
  const height = one(TAG.height)
  const tileW = one(TAG.tileWidth, 0)
  const tileH = one(TAG.tileLength, 0)
  const bps = one(TAG.bitsPerSample)
  const spp = one(TAG.samplesPerPixel, 1)
  const compression = one(TAG.compression)
  const predictor = one(TAG.predictor, 1)
  const sampleFormat = one(TAG.sampleFormat, 1)

  // Narrow on purpose: refuse by name rather than quietly misread.
  if (!tileW || !tileH) throw new Error(`${path}: striped TIFF, only tiled is supported`)
  if (bps !== 32 || sampleFormat !== 3) {
    throw new Error(`${path}: ${bps}-bit sampleFormat ${sampleFormat}, expected 32-bit IEEE float`)
  }
  if (spp !== 1) throw new Error(`${path}: ${spp} samples per pixel, expected 1`)
  if (compression !== 8 && compression !== 32946) {
    throw new Error(`${path}: compression ${compression}, only Deflate (8/32946) is supported`)
  }
  if (predictor !== 1 && predictor !== 3) {
    throw new Error(`${path}: predictor ${predictor}, only 1 (none) and 3 (float) are supported`)
  }

  const offsets = values(TAG.tileOffsets)
  const counts = values(TAG.tileByteCounts)
  const across = Math.ceil(width / tileW)
  const down = Math.ceil(height / tileH)
  if (offsets.length !== across * down) {
    throw new Error(`${path}: ${offsets.length} tiles, expected ${across}x${down}`)
  }

  const bands = (cb: (y0: number, rows: number, data: Float32Array) => void): void => {
    const rowBytes = tileW * 4
    try {
      for (let ty = 0; ty < down; ty++) {
        const y0 = ty * tileH
        const rows = Math.min(tileH, height - y0)
        const band = new Float32Array(width * rows)
        for (let tx = 0; tx < across; tx++) {
          const i = ty * across + tx
          if (offsets[i] + counts[i] > size) throw new Error(`${path}: tile ${i} past EOF`)
          const raw = at(offsets[i], counts[i])
          const tile = new Uint8Array(inflateSync(raw))
          if (tile.length !== tileW * tileH * 4) {
            throw new Error(`${path}: tile ${i} inflated to ${tile.length}, expected ${tileW * tileH * 4}`)
          }
          const x0 = tx * tileW
          const cols = Math.min(tileW, width - x0) // right column is padded
          for (let r = 0; r < rows; r++) {
            const row = tile.subarray(r * rowBytes, (r + 1) * rowBytes)
            if (predictor === 3) unpredictFloat(row, tileW, 4)
            const view = new DataView(row.buffer, row.byteOffset, row.byteLength)
            for (let c = 0; c < cols; c++) {
              band[r * width + x0 + c] = view.getFloat32(c * 4, le)
            }
          }
        }
        cb(y0, rows, band)
      }
    } finally {
      closeSync(fd)
    }
  }

  return { width, height, bands }
}

if (import.meta.main) {
  const path = Bun.argv[2]
  if (!path) {
    console.error('usage: bun bin/geotiff-f32.ts <file.tif>   # summarise and sample')
    process.exit(1)
  }
  const r = readFloat32Tiff(path)
  let min = Infinity
  let max = -Infinity
  let nan = 0
  let seen = 0
  r.bands((y0, rows, data) => {
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      if (Number.isNaN(v)) { nan++; continue }
      if (v < min) min = v
      if (v > max) max = v
      seen++
    }
  })
  console.log(`${path}\n  ${r.width}x${r.height}  ${seen} samples, ${nan} NaN\n  range ${min} .. ${max}`)
}
