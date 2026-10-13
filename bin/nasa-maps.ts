#!/usr/bin/env bun
/**
 * nasa-maps — fetch NASA planetary colour and elevation maps and cut them to
 * web-deliverable sizes.
 *
 * Equirectangular (2:1) sphere textures for the Moon, Mars and Earth at 1k, 2k
 * and 4k, which is where this stops: 4096x2048 is a sharp sphere on a 4K display
 * and the sources go to 16k and beyond, which nobody is shipping over a network.
 *
 * TWO DELIBERATE FORMAT CHOICES, both measured rather than assumed:
 *
 * COLOUR IS JPEG, not WebP. On this content WebP lost at every size point —
 * at ~0.95 MB for the 4k lunar map, jpeg q4 scored SSIM 0.970 against webp q82's
 * 0.957, and the same ordering held at 0.6 MB. Low-contrast grey terrain is not
 * what WebP's chroma path is good at. JPEG is also decodable everywhere.
 *
 * HEIGHT IS 16-BIT PNG, lossless. 8 bits is 256 steps over tens of kilometres of
 * relief — about 78 m a step on Earth — which terraces visibly the moment a
 * displacement map is used for anything. Lossy compression is out for the same
 * reason: a block artefact in a height field is a dent in the terrain.
 *
 * ONE ELEVATION ENCODING FOR EVERY BODY: a uint16 big-endian sample is
 *
 *     elevation_metres = value - 32768
 *
 * 1 m a step, which at 4k covers a pixel 2.7 km wide on the Moon — far finer
 * than anything visible. The sources disagree with each other (MOLA ships signed
 * metres; the lunar DEM ships unsigned half-metres offset by 10 km), so they are
 * normalised here to spare every consumer that arithmetic. The transform is
 * affine, and interpolation is linear, so scaling before or after it gives the
 * same answer.
 *
 * Earth is the exception and says so: NASA publishes its global elevation image
 * as 8-bit with no documented metre mapping, so it ships 8-bit and is labelled a
 * RELATIVE bump map. Inventing a scale for it would be worse than admitting it.
 *
 *   bun bin/nasa-maps.ts              fetch what is missing, build what is stale
 *   bun bin/nasa-maps.ts moon         one body
 *   bun bin/nasa-maps.ts --force      rebuild outputs that already exist
 *
 * Needs ffmpeg (decode + scale). Sources land in assets/nasa/source/, which no
 * `publish` glob names, so they stay off the CDN — see CLAUDE.md, Publishing.
 */

import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NASA = join(ROOT, 'assets', 'nasa')
const SRC = join(NASA, 'source')
const TMP = join(SRC, 'tmp')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const only = args.find((a) => !a.startsWith('--'))

/** Output widths. Height is always half the width (equirectangular 2:1). */
const SIZES = [
  { tag: '4k', w: 4096 },
  { tag: '2k', w: 2048 },
  { tag: '1k', w: 1024 },
]

/** Where every stored height sample is anchored: metres = value - OFFSET. */
const HEIGHT_OFFSET = 32768

const SVS = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720'
const EO = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000'
const PDS = 'https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived'
const TREK =
  'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm'

interface ColourSource {
  /** A single downloadable image. */
  file?: string
  url?: string
  /** Or a WMTS level to stitch: 2^(z+1) x 2^z tiles of 256 px. */
  tiles?: { base: string; z: number }
  /** JPEG quality for ffmpeg's mjpeg encoder: 2 is best, 31 worst. */
  q: number
}

interface HeightSource {
  file: string
  url: string
  /** A headerless PDS image: raw big-endian samples, no container. */
  raw?: { w: number; h: number }
  /**
   * Source sample -> metres, as (scale, bias): metres = v * scale + bias.
   * Composed with the output offset so only one pass over the pixels is needed.
   */
  toMetres?: { scale: number; bias: number }
  /** 8-bit source with no documented elevation scale: ships as a relative map. */
  relative?: boolean
  /**
   * Rotate by half the width, to put longitude 0 in the middle.
   *
   * The sources disagree about where a map starts. The SVS lunar kit, Blue
   * Marble and Mars Trek all centre on 0 and run -180..180; MOLA's MEGDR starts
   * at 0 and runs eastward to 360 (the `90n000` in its filename is the top-left
   * corner). Shipped as-is, Mars' elevation would sit HALF A PLANET away from
   * its own colour map — Olympus Mons rendered over Terra Cimmeria — and it
   * would look like plausible terrain the whole time, which is how a bug like
   * this survives to production.
   */
  rollHalf?: boolean
}

const BODIES: Record<string, { colour: ColourSource; height: HeightSource }> = {
  moon: {
    colour: { file: 'lroc_color_poles_4k.tif', url: `${SVS}/lroc_color_poles_4k.tif`, q: 4 },
    height: {
      file: 'ldem_16_uint.tif',
      url: `${SVS}/ldem_16_uint.tif`,
      // unsigned half-metres, offset by +20000 (10 km) to keep it positive
      toMetres: { scale: 0.5, bias: -10000 },
    },
  },
  mars: {
    colour: { tiles: { base: TREK, z: 3 }, q: 4 },
    height: {
      file: 'megt90n000eb.img',
      url: `${PDS}/meg016/megt90n000eb.img`,
      raw: { w: 5760, h: 2880 }, // MSB signed int16, metres above the areoid
      toMetres: { scale: 1, bias: 0 },
      rollHalf: true, // MEGDR runs 0..360 east; everything else here is -180..180
    },
  },
  earth: {
    colour: {
      file: 'world.topo.bathy.5400x2700.jpg',
      url: `${EO}/73909/world.topo.bathy.200412.3x5400x2700.jpg`,
      q: 4,
    },
    height: {
      file: 'gebco_elev_21600x10800.png',
      url: `${EO}/73934/gebco_08_rev_elev_21600x10800.png`,
      relative: true,
    },
  },
}

// --------------------------------------------------------------------- utils ---

const sh = async (cmd: string[]): Promise<void> => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const code = await p.exited
  if (code !== 0) {
    const err = await new Response(p.stderr).text()
    throw new Error(`${cmd[0]} failed (${code}):\n${err.trim().split('\n').slice(-4).join('\n')}`)
  }
}

const mb = (n: number) => (n / 1048576).toFixed(2) + ' MB'

const fetchTo = async (url: string, path: string): Promise<void> => {
  if (existsSync(path)) return
  mkdirSync(join(path, '..'), { recursive: true })
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  writeFileSync(path, new Uint8Array(await r.arrayBuffer()))
  console.log(`    fetched ${path.replace(ROOT, '')} (${mb(statSync(path).size)})`)
}

/** Read a binary PGM (P5). ffmpeg writes these; so do we. */
function readPgm(path: string): { w: number; h: number; max: number; data: Uint8Array } {
  const buf = readFileSync(path)
  let at = 0
  const token = (): string => {
    while (at < buf.length && /\s/.test(String.fromCharCode(buf[at]))) at++
    const start = at
    while (at < buf.length && !/\s/.test(String.fromCharCode(buf[at]))) at++
    return buf.subarray(start, at).toString('latin1')
  }
  const magic = token()
  if (magic !== 'P5') throw new Error(`${path}: not a binary PGM (${magic})`)
  const w = Number(token())
  const h = Number(token())
  const max = Number(token())
  at++ // the single whitespace byte before the raster
  return { w, h, max, data: new Uint8Array(buf.subarray(at)) }
}

const writePgm16 = (path: string, w: number, h: number, samples: Uint8Array): void => {
  const header = Buffer.from(`P5\n${w} ${h}\n65535\n`, 'latin1')
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples)]))
}

/** SSIM of an encoded image against its lossless reference, as a sanity check. */
async function ssim(encoded: string, reference: string): Promise<string> {
  const p = Bun.spawn(
    ['ffmpeg', '-hide_banner', '-i', encoded, '-i', reference, '-lavfi', 'ssim', '-f', 'null', '-'],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  await p.exited
  const text = await new Response(p.stderr).text()
  return text.match(/All:([0-9.]+)/)?.[1] ?? '?'
}

// ------------------------------------------------------------------- colour ---

/**
 * Stitch a WMTS level into one image: 2^(z+1) x 2^z tiles of 256 px.
 *
 * Mars has no web-sized colour mosaic to download — the Viking MDIM21 global
 * mosaic is a 12.7 GB GeoTIFF — but Mars Trek serves that same mosaic as tiles,
 * and level 3 is exactly 16x8 tiles, which is exactly 4096x2048. Rows are
 * assembled first and then stacked, because one ffmpeg call with 128 inputs is
 * a command line nobody can debug.
 */
async function stitchTiles(base: string, z: number, out: string): Promise<void> {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  mkdirSync(TMP, { recursive: true })
  console.log(`    stitching ${cols}x${rows} tiles from Mars Trek (level ${z})`)
  const rowFiles: string[] = []
  for (let y = 0; y < rows; y++) {
    const tiles: string[] = []
    for (let x = 0; x < cols; x++) {
      const t = join(TMP, `t_${z}_${y}_${x}.jpg`)
      await fetchTo(`${base}/${z}/${y}/${x}.jpg`, t)
      tiles.push(t)
    }
    const rowFile = join(TMP, `row_${y}.png`)
    if (!existsSync(rowFile)) {
      await sh([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        ...tiles.flatMap((t) => ['-i', t]),
        '-filter_complex', `hstack=inputs=${cols}`,
        rowFile,
      ])
    }
    rowFiles.push(rowFile)
  }
  await sh([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    ...rowFiles.flatMap((r) => ['-i', r]),
    '-filter_complex', `vstack=inputs=${rows}`,
    out,
  ])
}

async function buildColour(body: string, spec: ColourSource): Promise<void> {
  // One lossless master, then every size from it — so the scale happens once and
  // SSIM has something honest to measure against.
  const master = join(TMP, `${body}_colour_master.png`)
  mkdirSync(TMP, { recursive: true })
  if (!existsSync(master)) {
    if (spec.tiles) {
      await stitchTiles(spec.tiles.base, spec.tiles.z, master)
    } else {
      const src = join(SRC, spec.file!)
      await fetchTo(spec.url!, src)
      await sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, master])
    }
  }
  for (const { tag, w } of SIZES) {
    const out = join(NASA, body, `color-${tag}.jpg`)
    if (existsSync(out) && !FORCE) continue
    mkdirSync(join(NASA, body), { recursive: true })
    const scaled = join(TMP, `${body}_c_${tag}.png`)
    await sh([
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', master,
      '-vf', `scale=${w}:${w / 2}:flags=lanczos`, scaled,
    ])
    await sh([
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', scaled,
      '-q:v', String(spec.q), out,
    ])
    console.log(
      `    color-${tag}.jpg  ${w}x${w / 2}  ${mb(statSync(out).size)}  SSIM ${await ssim(out, scaled)}`
    )
  }
}

// ------------------------------------------------------------------- height ---

async function buildHeight(body: string, spec: HeightSource): Promise<void> {
  const src = join(SRC, spec.file)
  await fetchTo(spec.url, src)
  mkdirSync(TMP, { recursive: true })

  // A headerless PDS image becomes a PGM first: signed big-endian metres offset
  // into unsigned, which IS the output encoding, so no second pass is needed.
  let decodable = src
  if (spec.raw) {
    const pgm = join(TMP, `${body}_raw.pgm`)
    if (!existsSync(pgm)) {
      const { w, h } = spec.raw
      const raw = readFileSync(src)
      if (raw.length !== w * h * 2) {
        throw new Error(`${spec.file}: ${raw.length} bytes, expected ${w * h * 2} for ${w}x${h}`)
      }
      const out = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i += 2) {
        // MSB signed -> unsigned, +32768: the sign bit flip IS the offset
        out[i] = raw[i] ^ 0x80
        out[i + 1] = raw[i + 1]
      }
      writePgm16(pgm, w, h, out)
      console.log(`    decoded ${spec.file} (raw int16be ${w}x${h}) -> pgm`)
    }
    decodable = pgm
  }

  for (const { tag, w } of SIZES) {
    const out = join(NASA, body, `height-${tag}.png`)
    if (existsSync(out) && !FORCE) continue
    mkdirSync(join(NASA, body), { recursive: true })

    if (spec.relative) {
      // 8-bit in, 8-bit out. Promoting it to 16 bits would add bytes and no
      // information, and would imply a precision the source does not have.
      await sh([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', decodable,
        '-vf', `scale=${w}:${w / 2}:flags=lanczos`, '-pix_fmt', 'gray', out,
      ])
      console.log(`    height-${tag}.png  ${w}x${w / 2}  ${mb(statSync(out).size)}  8-bit relative`)
      continue
    }

    const scaled = join(TMP, `${body}_h_${tag}.pgm`)
    await sh([
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', decodable,
      '-vf', `scale=${w}:${w / 2}:flags=lanczos`, '-pix_fmt', 'gray16be', scaled,
    ])

    const { w: pw, h: ph, data } = readPgm(scaled)
    if (spec.rollHalf) {
      // Exact: an even width means half of it is a whole number of pixels, so
      // this is a rotation, not a resample — no filtering, no seam.
      const half = (pw / 2) * 2 // bytes per half row (2 bytes a sample)
      const stride = pw * 2
      for (let y = 0; y < ph; y++) {
        const row = data.subarray(y * stride, (y + 1) * stride)
        const copy = row.slice()
        row.set(copy.subarray(half), 0)
        row.set(copy.subarray(0, half), stride - half)
      }
    }
    const { scale, bias } = spec.toMetres!
    let min = Infinity
    let max = -Infinity
    // stored = metres + OFFSET = (v * scale + bias) + OFFSET
    const needsTransform = !(scale === 1 && bias + HEIGHT_OFFSET === 32768)
    for (let i = 0; i < pw * ph; i++) {
      const v = (data[i * 2] << 8) | data[i * 2 + 1]
      const metres = spec.raw ? v - HEIGHT_OFFSET : v * scale + bias
      if (metres < min) min = metres
      if (metres > max) max = metres
      if (needsTransform) {
        const stored = Math.max(0, Math.min(65535, Math.round(metres + HEIGHT_OFFSET)))
        data[i * 2] = stored >> 8
        data[i * 2 + 1] = stored & 0xff
      }
    }
    const encoded = join(TMP, `${body}_h_${tag}_enc.pgm`)
    writePgm16(encoded, pw, ph, data)
    await sh([
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', encoded,
      '-pix_fmt', 'gray16be', out,
    ])
    console.log(
      `    height-${tag}.png  ${w}x${w / 2}  ${mb(statSync(out).size)}  ` +
        `16-bit, ${Math.round(min)}..${Math.round(max)} m`
    )
  }
}

// --------------------------------------------------------------------- main ---

const wanted = only ? [only] : Object.keys(BODIES)
for (const body of wanted) {
  const spec = BODIES[body]
  if (!spec) {
    console.error(`no such body: ${body} (have ${Object.keys(BODIES).join(', ')})`)
    process.exit(1)
  }
  console.log(`\n${body}:`)
  await buildColour(body, spec.colour)
  await buildHeight(body, spec.height)
}
console.log(
  `\nnasa-maps: ${wanted.join(', ')} -> assets/nasa/. Sources kept in assets/nasa/source/ ` +
    `(unpublished). Elevation: metres = uint16be value - ${HEIGHT_OFFSET}.`
)
