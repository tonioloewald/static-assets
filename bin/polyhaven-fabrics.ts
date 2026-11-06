#!/usr/bin/env bun
/**
 * polyhaven-fabrics — Poly Haven's CC0 fabric textures as a small, curated
 * pack for tosijs-3d's materials (cloth prints and weaves).
 *
 *   bun bin/polyhaven-fabrics.ts
 *
 * Poly Haven's maps are big (a 1K colour JPEG is ~0.9 MB), so each fabric
 * ships in two tiers, re-encoded from the 1K originals:
 *
 *   <id>/lite/albedo.jpg, normal.jpg              512, colour + weave
 *   <id>/full/albedo.jpg, normal.jpg, roughness.jpg   1024, and how shiny
 *                                   (roughness at 512, greyscale: it is noise,
 *                                   and was the biggest file at 1024)
 *
 * plus `fabrics.json`, the manifest: each fabric's name, authors, the size one
 * tile covers in metres (Poly Haven's `dimensions`, so a print repeats at its
 * real size), and its files. The originals are cached under `source/` (not
 * published). Normals are Poly Haven's OpenGL ones (`nor_gl`, glTF's
 * convention). Uses macOS `sips` for resizing.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK = join(ROOT, 'assets', 'polyhaven', 'fabrics')

/** The curated set: a range of weaves and finishes, not five denims. */
const FABRICS = [
  'cotton_jersey',
  'bi_stretch',
  'crepe_satin',
  'crepe_georgette',
  'caban',
  'curly_teddy_natural',
  'curly_teddy_checkered',
  'brown_leather',
  'denim_fabric',
  'denim_fabric_03',
  'denim_fabric_05',
]

/** Map kind → Poly Haven's file key. */
const MAPS = { albedo: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' } as const
type MapKind = keyof typeof MAPS
const TIERS: Record<'lite' | 'full', { size: number; maps: MapKind[] }> = {
  lite: { size: 512, maps: ['albedo', 'normal'] },
  full: { size: 1024, maps: ['albedo', 'normal', 'roughness'] },
}
/** JPEG quality: normals a little higher (banding shows as facets). */
const QUALITY: Record<MapKind, number> = { albedo: 80, normal: 88, roughness: 70 }
/** At most this size whatever the tier, and greyscale. */
const ROUGHNESS_MAX = 512
const GREY = '/System/Library/ColorSync/Profiles/Generic Gray Gamma 2.2 Profile.icc'

const json = async (url: string) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json()
}

async function fetchCached(url: string, to: string, md5: string) {
  if (existsSync(to)) {
    const have = createHash('md5')
      .update(new Uint8Array(await Bun.file(to).arrayBuffer()))
      .digest('hex')
    if (have === md5) return
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  await Bun.write(to, await r.arrayBuffer())
}

function sips(
  from: string,
  to: string,
  size: number,
  quality: number,
  grey = false
) {
  const p = Bun.spawnSync([
    'sips',
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(quality),
    '-Z', String(size),
    ...(grey ? ['--matchTo', GREY] : []),
    from,
    '--out', to,
  ])
  if (p.exitCode !== 0) throw new Error(`sips ${from}: ${p.stderr.toString()}`)
}

const manifest: any[] = []
for (const id of FABRICS) {
  const info = await json(`https://api.polyhaven.com/info/${id}`)
  const files = await json(`https://api.polyhaven.com/files/${id}`)
  const src = join(PACK, 'source', id)
  mkdirSync(src, { recursive: true })
  const original: Partial<Record<MapKind, string>> = {}
  for (const kind of Object.keys(MAPS) as MapKind[]) {
    const f = files[MAPS[kind]]?.['1k']?.jpg
    if (!f) throw new Error(`${id}: no 1k ${MAPS[kind]}`)
    const to = join(src, `${kind}.jpg`)
    await fetchCached(f.url, to, f.md5)
    original[kind] = to
  }
  const entry: any = {
    id,
    name: info.name,
    authors: Object.keys(info.authors ?? {}),
    link: `https://polyhaven.com/a/${id}`,
    // Poly Haven gives millimetres; one tile covers this much cloth.
    size: (info.dimensions ?? [1000, 1000]).map(
      (mm: number) => Math.round(mm) / 1000
    ),
    tiers: {},
  }
  for (const [tier, t] of Object.entries(TIERS)) {
    const dir = join(PACK, id, tier)
    mkdirSync(dir, { recursive: true })
    const out: Record<string, string> = {}
    let bytes = 0
    for (const kind of t.maps) {
      const to = join(dir, `${kind}.jpg`)
      const rough = kind === 'roughness'
      sips(
        original[kind]!,
        to,
        rough ? Math.min(t.size, ROUGHNESS_MAX) : t.size,
        QUALITY[kind],
        rough
      )
      bytes += statSync(to).size
      out[kind] = `polyhaven/fabrics/${id}/${tier}/${kind}.jpg`
    }
    entry.tiers[tier] = { ...out, bytes }
  }
  manifest.push(entry)
  console.log(
    `${id}: lite ${(entry.tiers.lite.bytes / 1024).toFixed(0)} KB, full ${(
      entry.tiers.full.bytes / 1024
    ).toFixed(0)} KB, tile ${entry.size.join(' × ')} m`
  )
}

writeFileSync(
  join(PACK, 'fabrics.json'),
  JSON.stringify(
    {
      format: 'tosijs-fabrics',
      version: 1,
      source: 'Poly Haven (https://polyhaven.com)',
      license: 'CC0',
      tiers: {
        lite: '512 px: colour and normal',
        full: '1024 px: colour, normal and roughness',
      },
      fabrics: manifest,
    },
    null,
    1
  ) + '\n'
)
console.log(`fabrics.json: ${manifest.length} fabrics`)
