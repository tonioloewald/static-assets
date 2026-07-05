# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Mirror source for **cdn.tosijs.net** — a shared static-asset CDN (3D models,
textures, audio, …) for tosijs.net projects. It keeps heavy binaries OUT of every
consuming repo (e.g. `tosijs-3d`), which reference assets by URL instead. One repo
holds the assets + the tooling to publish them; everything else just links in.

See **`CONTENT-MAP.md`** for a living map of the *content* (how Kenney's assets are
organized and snap together — reskin/equip conventions, the character kit, etc.).
This file is about the *tooling*.

## Commands

- `bun run scan` — discover source models with no glb and write `convert` specs into
  each pack's `metadata.json` (dry-run; add `--write` to apply). See Conversion below.
- `bun run convert` — execute those specs via Blender (cached) → `derived/`.
- `bun run build` — `convert`, then stage `assets/` + `derived/` → `public/` and
  regenerate the host config (`public/_headers` + `public/robots.txt` + `firebase.json`).
- `bun run deploy` — build, then `wrangler pages deploy public` (**Cloudflare Pages**).
- `bun run deploy:firebase` — build, then `firebase deploy --only hosting` (fallback).

**Host is a deploy/DNS choice, not a rebuild.** `public/` is identical either way;
`mirror.ts` emits both a Cloudflare `_headers` file and a `firebase.json` from the same
metadata rules. Cloudflare Pages is primary (free egress suits a public asset CDN);
Firebase Hosting also works (billed egress beyond a small free tier). Deploying needs
the respective CLI logged in (`wrangler login`, or `firebase use <project>`). The whole
publish is driven by `metadata.json` — you rarely touch anything else.

## Layout

| Path | Role |
| --- | --- |
| `assets/` | **Source** tree, namespaced: `assets/kenney/…`, `assets/<pack>/…`. |
| `assets/**/metadata.json` | Per-directory config (attribution + filtering). **Committed.** |
| `assets/**` (binaries) | The actual asset files. **NOT committed** (see `.gitignore`) — they live on disk locally and are mirrored to the host. |
| `public/` | **Generated** deployable (gitignored). `build` hardlinks the included assets here. |
| `public/_headers` | **Generated** Cloudflare Pages/Netlify header rules (from metadata). |
| `public/robots.txt` | **Generated** `Disallow: /` (reinforces the `noindex` header). |
| `firebase.json` | **Generated** Firebase Hosting config + headers (fallback host). Don't hand-edit. |
| `derived/` | **Generated** glb from conversion (gitignored); overlaid into `public/`. |
| `.cache/` | Blender conversion cache keyed by input signature (gitignored). |
| `bin/mirror.ts` | Stages `assets/` + `derived/` → `public/`, generates `firebase.json`. |
| `bin/scan-conversions.ts` | Discovers uncovered models, writes `convert` specs into metadata. |
| `bin/convert.ts` | Runs `convert` specs via Blender (cached) → `derived/`. |
| `bin/blender-export.py` | Blender headless: fbx/blend → glb, with animation merging. |
| `CONTENT-MAP.md` | Living map of the *content* + how it snaps together. |

Because binaries aren't in git, a fresh clone has the *manifest* (metadata.json +
structure) but not the payload — re-populate `assets/**` from the original bundle
on disk before deploying.

## `metadata.json` — the one thing to understand

A `metadata.json` may sit in **any** directory under `assets/` and is **overlaid as
you descend the tree**: a child's values merge over its ancestors' (headers merge
per-key, excludes accumulate). All fields optional; add more over time.

| Field | Effect |
| --- | --- |
| `exclude: string[]` | Globs (relative to the declaring dir; `**` spans `/`) of files/dirs NOT to mirror. Accumulate down the tree. Use to drop engine junk (`**/Unity/**`, `**/*.unitypackage`). |
| `copyright` / `credit` / `attribution` / `license` | Convenience attribution; each becomes a literal response header of the same (lowercase) name on every file served from this namespace. |
| `link` | A URL → a proper `Link: <url>; rel="author"` response header. |
| `headers: { name: value }` | Escape hatch — **any** key→value is emitted as a response header verbatim (overrides the convenience fields on key collision). |

**The core idea:** whatever ends up in a path's effective header set IS set as a
response header — so credit/copyright/license/link travel with every byte,
inspectable via `curl -I`, with zero per-file work.

Root `assets/metadata.json` holds the global excludes (engine junk). Each pack dir
(e.g. `assets/kenney/metadata.json`) holds its attribution.

`metadata.json` is also the home for **app-level semantics** the filenames don't
capture — e.g. modular-kit `grid` + tile connectivity (`tileRules`/`tiles`) so maps
can be assembled from tile names + scale regardless of Kenney's naming consistency.
Same overlay rules apply. See `CONTENT-MAP.md` for those conventions.

## Conversion (source → glb)

Some models ship only as fbx/blend with no glb equivalent (Kenney: just the animated
characters). Conversion is **metadata-driven and cached** so it's automated and
reproducible — the *spec* is versioned even though the binaries aren't:

1. `bun run scan` walks `assets/kenney/3D assets/<pack>/` with **pack-scoped**
   coverage (an fbx is "covered" if a same-basename glb/gltf exists anywhere in the
   pack — Kenney's parallel `FBX format/` + `GLB format/` folders). For each uncovered
   pack it writes a `convert` array into the pack's `metadata.json`:

   ```json
   "convert": [
     { "output": "characterMedium.glb", "model": "Model/characterMedium.fbx",
       "animations": ["Animations/idle.fbx", "Animations/run.fbx"] },
     { "output": "Accessories/hat.glb", "input": "Accessories/hat.fbx" }
   ]
   ```
   - `merge` (`model` + `animations[]`) → one glb with the clips as **named
     animations** (idle/run/jump…), via `bin/blender-export.py` (imports the model,
     stashes each clip's action on the shared rig, exports GLB). Ready for
     `b3dBiped`'s animation state machine.
   - `single` (`input`) → a one-to-one glb (static accessories, etc.).

2. `bun run convert` executes each spec with **Blender headless** (`BLENDER` env var
   overrides the path), caches by input signature (`.cache/`), and writes results to
   `derived/<same path>/…glb`. Re-runs are near-instant. Limit to a pack:
   `bun bin/convert.ts Protagonists`.

3. `bin/mirror.ts` overlays `derived/` into `public/`, so converted glb serve at
   their logical path (`/kenney/3D assets/…/characterMedium.glb`) with the pack's
   attribution headers — same as any other asset.

`derived/` and `.cache/` are generated (gitignored). The 23 `.blend` files are the
Bundle's *sources* for its fbx (already exported), so we convert the fbx and ignore
the blends. Requires Blender (`/Applications/Blender.app` on macOS).

## Ethics — why it's built this way (keep it this way)

Assets like Kenney's are typically **CC0** — legally redistributable — but we do NOT
want to become a free *mirror* of a creator's paid bundle. The safeguards, all cheap:

- **No front door.** Static hosting 404s on directories (no listing), and every
  response carries `X-Robots-Tag: noindex` — so the assets aren't browsable or
  searchable as a set.
- **No public catalog.** Never publish a complete manifest/index of a namespace.
  Consuming apps reference only the specific assets they use — so you'd need the
  original bundle to know the paths. Files are *usable* by apps, not *harvestable*.
- **Attribution travels.** Credit + license + author link ride in the response
  headers of every file; consumer docs should credit and link the creators too.

When you add a pack, preserve this: attribution in `metadata.json`, no public
catalog, and only mirror what's actually used/wanted.

## Adding a pack

1. `mkdir assets/<name>/` and drop the asset files in (binaries stay local).
2. Add `assets/<name>/metadata.json` with `copyright`/`credit`/`link`/`license`
   (+ `exclude` for anything you don't want served, on top of the global excludes).
3. `bun run build`, then `curl -I` a staged file (or check `firebase.json`) to
   confirm the headers, then `bun run deploy`.

## Consuming side (`tosijs-3d`)

Consumers set the base once and reference assets by logical path:

```js
import { setAssetBase, assetUrl, b3dLoader } from 'tosijs-3d'
setAssetBase('https://cdn.tosijs.net')
b3dLoader({ url: assetUrl('kenney/vehicles/car.glb') })
```

Loaders fetch cross-origin, so `Access-Control-Allow-Origin: *` is required — it's
set for every file by the generated config.

## Assumption to verify on first deploy

`bin/mirror.ts` assumes Firebase applies **all** matching `headers` blocks (the
common `**` block + each namespace rule cascade/union, deeper winning on a key
collision). If a namespaced file is missing CORS or attribution after deploy, that
assumption is wrong — fold the common headers into each namespace rule in
`bin/mirror.ts`.
