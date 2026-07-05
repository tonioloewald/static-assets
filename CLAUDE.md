# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Mirror source for **static.tosijs.net** — a shared static-asset CDN (3D models,
textures, audio, …) for tosijs.net projects. It keeps heavy binaries OUT of every
consuming repo (e.g. `tosijs-3d`), which reference assets by URL instead. One repo
holds the assets + the tooling to publish them; everything else just links in.

## Commands

- `bun run build` — stage `assets/` → `public/` and regenerate `firebase.json`.
- `bun run deploy` — build, then `firebase deploy --only hosting`.

Deploying needs the Firebase CLI and a selected project (`firebase use <project>`).
The whole publish is driven by `metadata.json` — you rarely touch anything else.

## Layout

| Path | Role |
| --- | --- |
| `assets/` | **Source** tree, namespaced: `assets/kenney/…`, `assets/<pack>/…`. |
| `assets/**/metadata.json` | Per-directory config (attribution + filtering). **Committed.** |
| `assets/**` (binaries) | The actual asset files. **NOT committed** (see `.gitignore`) — they live on disk locally and are mirrored to the host. |
| `public/` | **Generated** deployable (gitignored). `build` hardlinks the included assets here. |
| `firebase.json` | **Generated** (attribution headers derived from metadata). Don't hand-edit. |
| `bin/mirror.ts` | The build/generator. |

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
setAssetBase('https://static.tosijs.net')
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
