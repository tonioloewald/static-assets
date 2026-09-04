# CLAUDE.md

> **Shared engineering practices** live at
> **https://github.com/tonioloewald/tosijs-coding-practices** — and, when checked out beside
> this repo, at [`../tosijs-coding-practices`](../tosijs-coding-practices/README.md). Read that
> index first for the cross-project defaults (development, testing, code quality, performance,
> review, releasing, deployment, and the **observant** tosijs/tjs stack). This file records only
> what is **specific to or divergent from** those defaults — when they conflict, this file wins.
>
> Those docs are **living, not graven in stone.** Don't rewrite them unprompted, but do speak up:
> voice concerns, flag inconsistencies, and suggest improvements as you work. Continuous
> improvement is the goal — see the repo's `CONTRIBUTING.md`.


This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Mirror source for **cdn.tosijs.net** — a shared static-asset CDN (3D models,
textures, audio, …) for tosijs.net projects. It keeps heavy binaries OUT of every
consuming repo (e.g. `tosijs-3d`), which reference assets by URL instead. One repo
holds the assets + the tooling to publish them; everything else just links in.

See **`CONTENT-MAP.md`** for a living map of the *content* (how the Kenney and
Quaternius assets are organized and snap together — reskin/equip conventions, the
character kit, modular-kit grids, which animation clips the subsets keep).
This file is about the *tooling*.

## Commands

- `bun run scan` — discover source models with no glb and write `convert` specs into
  each pack's `metadata.json` (dry-run; add `--write` to apply). Hard-coded to
  `assets/kenney/3D assets/` (`PACKS_ROOT` in the script). See Conversion below.
- `bun run scan --libraries` — the same tree, different question: every pack that
  ships a folder of individual models gets a `library` spec so it publishes as ONE
  glb. Fills in `slug`/`from` only; hand-authored curation survives. See Libraries.
- `bun run convert` — execute those specs via Blender (cached) → `derived/`.
- `bun run build` — `convert`, then push `publish`-ed sources into `derived/`, stage
  `derived/` → `public/`, and regenerate the host config (`public/_headers` +
  `public/robots.txt` + `firebase.json`).
- `bun run publish [target] [--deploy]` — **the everyday path.** Rebuild just what
  `target` matches, then show exactly which URLs would change before shipping. See
  Targeted updates.
- `bun run deploy` — rebuild EVERYTHING, then `bunx wrangler pages deploy public
  --project-name cdn-tosijs` (**Cloudflare Pages**). Correct, and a blunt
  instrument — see Targeted updates before reaching for it.
- `bun run deploy:firebase` — build, then `bunx firebase-tools deploy --only hosting`
  (fallback).

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
| `public/` | **Generated** deployable (gitignored) — `derived/` plus the host config, nothing else. |
| `public/_headers` | **Generated** Cloudflare Pages/Netlify header rules (from metadata). |
| `public/robots.txt` | **Generated** `Disallow: /` (reinforces the `noindex` header). |
| `firebase.json` | **Generated** Firebase Hosting config + headers (fallback host). Don't hand-edit. |
| `derived/` | **Generated, and IS the shipped tree** (gitignored): built output + `publish`-ed sources. If it's here, it ships. |
| `derived/<pack>/libraries/` | **Generated** per-kit libraries — the main thing served. |
| `.cache/` | Blender conversion cache keyed by input signature (gitignored). |
| `bin/mirror.ts` | Pushes `publish`-ed sources into `derived/`, stages `derived/` → `public/`, generates host config. |
| `bin/scan-conversions.ts` | Discovers uncovered models, writes `convert` specs into metadata. |
| `bin/convert.ts` | Runs `convert` specs via Blender (cached) → `derived/`. |
| `bin/blender-export.py` | Blender headless: fbx/blend → glb, with animation merging. |
| `bin/subset-glb.ts` | glTF surgery: drop animations from a glb (no Blender). Library + CLI. |
| `bin/publish.ts` | Targeted rebuild + a diff of what would change on the CDN, then deploy. |
| `bin/library-glb.ts` | glTF surgery: merge a pack of models into one glb, and cut subsets of it. Library + CLI. |
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
| `publish: string[]` | Globs (relative to the declaring dir; `**` spans `/`) of files TO ship — pushed into `derived/`. **Nothing is served unless a publish glob names it.** Accumulate down the tree. |
| `exclude: string[]` | Globs carving holes out of an inherited `publish`. Accumulate. Not a safety net — the allowlist is. |
| `shelved: true` | This pack is deliberately not built or shipped; `scan` skips it instead of regenerating its specs. |
| `copyright` / `credit` / `attribution` / `license` | Convenience attribution; each becomes a literal response header of the same (lowercase) name on every file served from this namespace. |
| `link` | A URL → a proper `Link: <url>; rel="author"` response header. |
| `headers: { name: value }` | Escape hatch — **any** key→value is emitted as a response header verbatim (overrides the convenience fields on key collision). |
| `convert: Spec[]` | Conversion specs for this directory — see Conversion below. Not inherited (each declaring dir owns its own). |
| `library: { slug, from[], categories?, exclude?, subsets? }` | Pack this directory's models into one glb at `/<namespace>/libraries/<slug>.glb`. See Libraries below. Not inherited. |
| `scale: number` | Uniform factor baked into every **Blender-built** glb of this pack (Kenney's Bundle is `0.48` → ~1 unit/metre). Applied by scaling the exported scene's root nodes; deliberately **not** applied to `subset` specs, whose input is an already-built glb. |

**The core idea:** whatever ends up in a path's effective header set IS set as a
response header — so credit/copyright/license/link travel with every byte,
inspectable via `curl -I`, with zero per-file work.

Each pack dir (e.g. `assets/kenney/metadata.json`) holds its attribution. Packs
today: `kenney` (3D — publishes nothing from source, only built libraries),
`quaternius` (animation libraries; UAL megafiles are inputs, characters/hairstyles
are pushed as-is), `speech` (placeholder VO). Root `assets/metadata.json` needs no
rules at all now: under an allowlist, junk does not have to be enumerated to be
kept off the CDN.

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
   - `subset` (`input` + `clips[]`) → a glb keeping only those animations,
     **without Blender** — `bin/subset-glb.ts` rewrites the glTF JSON and rebuilds
     the binary chunk, dropping the accessors/bufferViews nothing live references.
     Clip names may end in `*` to keep a family (`Climb_*`). This is how the
     Quaternius animation megafiles are cut down (20.4 MB → 5 MB); see
     `CONTENT-MAP.md` for which clips and why. As a CLI:
     `bun bin/subset-glb.ts <src.glb> --list` / `… <src.glb> <out.glb> <clip…>`.

2. `bun run convert` executes each spec — `merge`/`single` through **Blender headless**
   (`BLENDER` env var overrides the path), `subset` in-process — caching by input signature (`.cache/`), and writes results to
   `derived/<same path>/…glb`. Re-runs are near-instant. Limit to a pack:
   `bun bin/convert.ts Protagonists` (arg = substring match on the spec's dir path).
   A *full* run wipes `derived/` first, so a spec deleted from `metadata.json`
   stops being served instead of lingering as an orphan — a pack-filtered run
   does not, so re-run without the arg when you remove specs.

3. `bin/mirror.ts` stages `derived/` into `public/`, so converted glb serve at their
   logical path with the pack's attribution headers — same as any other asset.
   Note this means **building something publishes it**; see Publishing.

`derived/` and `.cache/` are generated (gitignored). The 23 `.blend` files are the
Bundle's *sources* for its fbx (already exported), so we convert the fbx and ignore
the blends. The fbx paths need Blender (`/Applications/Blender.app` on macOS);
`subset` needs nothing but Bun.

## Publishing — `derived/` IS what ships

There are exactly two ways a byte reaches the CDN:

1. **Built** — `bin/convert.ts` writes it into `derived/` (a library, a conversion,
   a subset).
2. **Pushed** — a `publish` glob in some `metadata.json` hardlinks it from
   `assets/` into `derived/`.

`public/` is then `derived/` plus the generated host config, and nothing else.
Source trees are never walked for content to serve. **To stop shipping something,
stop building or pushing it** — there is no filter to remember.

This replaced a blocklist, and the reason is worth keeping: everything used to ship
*unless* an `exclude` caught it, which put a creator's paid bundle one forgotten
pattern away from the CDN and silently published whatever new folder appeared in a
pack. Concretely, the old rules would have served **15,020 files** from Kenney
alone; the allowlist serves **206** — libraries, the Quaternius character/hairstyle
models, and the speech clips. That is also a hosting fact, not just a tidiness one:
Cloudflare Pages caps a deployment at **20,000 files** (and 25 MiB per file), so the
old model was at 75% of a hard limit from one pack, with every new pack pushing
toward a failed deploy. The largest thing we now ship is a 7.5 MB library.

**Un-publishing works too, but it needs bookkeeping.** Pushing copies a source
file INTO `derived/`, so deleting the source — or narrowing a `publish` glob so it
stops matching — would otherwise leave the copy sitting in the shipped tree and
serving forever. `mirror.ts` therefore records what it pushed in
`derived/.pushed.json` and deletes anything that was pushed last time and is not
pushed now (built output is never in that set and is never touched), pruning empty
directories behind it. It reports `N stale push(es) removed` when it does.

That manifest only knows about pushes made since it existed, so a file orphaned
before it was introduced is invisible to it. The recovery for any suspected
orphan is a full `rm -rf derived && bun run build` — cheap, since libraries
relink from `.cache/` in about a second.

`exclude` still exists, but only to carve a hole out of an inherited `publish` — it
is a refinement, not a safeguard. And a pack marked `"shelved": true` is skipped by
`scan`, so a later `--write` cannot quietly regenerate specs for content that was
deliberately withdrawn (which, now that building means shipping, would republish it).

## Targeted updates — change as few URLs as possible

Everything is served `Cache-Control: public, max-age=31536000, immutable`, which is
right for asset bytes and unforgiving about mistakes: **rewrite a file and every
consumer keeps the old copy for a year.**

`bun run build` regenerates the whole tree, so a change to a *builder* shifts the
bytes of every file it produces even when no asset changed. That has happened:
adding `size` to node extras rewrote all 56 libraries — 7,788 bytes of new JSON in
nature-kit — while its geometry stayed bit-identical (verified by diffing the GLB
chunks; the BIN chunk hash was unchanged).

The obvious fix — hashed or versioned filenames — is worse. Every URL then churns
on every rebuild, so pinned paths rot and consumers chase a moving target. Long
cache lifetimes have this property whatever you name things, and a consumer who
needs a fresh copy can force-refresh or add a query string. **Keep the URLs stable
and change as few of them as possible:**

```
bun run publish                     # what would change if I staged right now
bun run publish "Nature Kit"        # rebuild only that, then show the change
bun run publish "Nature Kit" --deploy
bun run publish --deploy            # ship pending source additions only
```

It hashes `public/` before and after, so the report is what *did* change, not what
was meant to. Additions are listed but never block — nobody holds a URL that did
not exist. A `--deploy` that would **change or remove** files outside the named
target refuses and asks for `--force`, because that is the signature of an
accidental mass invalidation. Removals are called out as `this URL stops resolving`.

It compares against `.publish-state.json` — the hashes it recorded at its last
successful deploy, written only on success and gitignored, since it describes what
a machine pushed rather than what the repo says. Without that file the diff would
only cover changes made in the same run, so a full `build` beforehand would leave
nothing to report and ship the whole tree silently. When the file is absent it says
so rather than pretending the tree is clean.

Cloudflare Pages has no partial deploy — a deployment is a whole-tree snapshot, and
uploading "just one file" would delete the rest of the site. That costs nothing:
Pages skips content it already holds, so a targeted *build* yields a targeted
upload. `Uploaded 1 files (63 already uploaded)` is the CDN confirming the diff.

## Ethics — why it's built this way (keep it this way)

Assets like Kenney's are typically **CC0** — legally redistributable — but we do NOT
want to become a free *mirror* of a creator's paid bundle. The safeguards, all cheap:

- **Allowlist, not blocklist.** Nothing is served for merely existing on disk; it
  ships because it was built or explicitly pushed. Keeping a creator's bundle off
  the web is a property of the design, not a matter of remembering to exclude it.
- **No front door.** Static hosting 404s on directories (no listing), and every
  response carries `X-Robots-Tag: noindex` — so the assets aren't browsable or
  searchable as a set.
- **No public catalog.** Never publish a complete manifest/index of a namespace —
  no index file, no directory listing, nothing that enumerates what exists.
  Consuming apps reference only the specific assets they use. Files are *usable*
  by apps, not *harvestable*.
- **A library indexes itself, and nothing else.** Each library glb carries a
  catalogue of its OWN contents in `extras` — which adds no exposure, since you
  already hold that content once you have the file — and it is deliberately
  written as part of the glb rather than as a sidecar `.json`, which WOULD be a
  published manifest. Source paths are never recorded in it: a library says who
  made this content, not where to go looking for the rest of it.
- **Consolidation is a real trade, made knowingly.** 5,108 obscure paths became 48
  guessable ones, which is the point (that is what makes them usable) and does
  raise the payoff of a lucky guess. It stays acceptable because none of it is
  listed, indexed or linked, and every byte carries its attribution. If that ever
  feels too generous, the cheap next step is a content-hash in the filename —
  unguessable URLs, with consumers getting them from a pinned constant.
- **Attribution travels.** Credit + license + author link ride in the response
  headers of every file; consumer docs should credit and link the creators too.

When you add a pack, preserve this: attribution in `metadata.json`, no public
catalog, and only ship what's actually used/wanted. The default for a new pack is
a library and no `publish` at all.

## Libraries (a pack → one glb)

**This is what `/kenney/` actually serves.** Kenney ships a kit as hundreds of
individual glb — Nature Kit is 329 files, Brick Kit 296 — and those files are not
even self-contained: each one re-declares the same material and points at an
*external* `Textures/colormap.png` that only resolves because the texture folder
ships beside it. A library is that same content as one file: every source model
becomes ONE named root node, and everything they share (textures, materials,
samplers, byte-identical geometry) is stored once.

Measured over all 48 kits: **5,108 models in 48 files, 101 MB** — 18% fewer bytes
than the 124 MB of source model folders, and two orders of magnitude fewer
requests. The bytes are the small win; the request count and the shared texture
are the real ones. Kits repeat themselves most where it counts: Blocky Characters
70% smaller, Cube Pets 50%, Car Kit 45%.

`bin/library-glb.ts` does it as **glTF surgery, not Blender** — same reasoning as
`subset-glb.ts`: a glTF is a JSON header over a binary blob, so merging is index
remapping plus buffer concatenation. Exact, fast, lossless; nothing is resampled
or re-authored, and every surviving byte of geometry is bit-identical to source.
Builds are deterministic (verified: wiping the cache reproduces all 49 outputs
byte-for-byte).

### The spec

Lives in the kit's own `metadata.json`, written by `bun run scan --libraries --write`:

```json
"library": {
  "slug": "nature-kit",
  "from": ["Models/GLTF format"],
  "include": ["tree_*"],
  "exclude": ["*_collider"],
  "categories": { "*-brick-*": "brick" },
  "subsets": [
    { "slug": "nature-kit-core", "keep": ["category:tree", "category:rock", "stump_*"] }
  ]
}
```

A metadata.json may declare **an array** of these, which is how one folder becomes
several libraries: `include` narrows each one. Quaternius' characters are split
that way (below).

- **Output path is a convention, not a setting**: `derived/<namespace>/libraries/<slug>.glb`,
  so it serves at `/kenney/libraries/nature-kit.glb`. The source layout is Kenney's
  (spaces, `Models/GLB format/`, a folder per pack); the published layout is ours.
- **`from` takes the union.** Some kits ship BOTH a `GLB format` and a `GLTF format`
  folder holding largely *different* models (Retro Fantasy: 105 and 55, 9 in common),
  so picking one folder would silently drop half the kit. Later entries win a name clash.
- **`include` / `exclude`** narrow which models go in (name globs, no extension).
  `include` is how one folder yields several libraries.
- **`subsets`** cut a smaller library out of the built one — the same idea as
  subsetting Quaternius' animation megafiles, one level up. Each pattern is a name
  glob or `category:<name>`; a pattern matching nothing is fatal, like a missing clip.
- Builds run in-process and cache like everything else. The signature covers **every
  file** in the `from` dirs, not just the models — a kit's shared texture and a
  `.gltf`'s `.bin` sidecar are inputs too. It does **not** cover the builder's own
  code (true of the Blender path as well), so after editing `bin/library-glb.ts`,
  `rm .cache/library-*.glb .cache/libsubset-*.glb` or you will keep shipping the
  output of the version you just changed.

### Metadata inside the glb

The point of a library is being able to use part of it, so each one carries its own
index in `extras` — standard glTF, no extension:

| Where | What | three.js |
| --- | --- | --- |
| `scenes[0].extras.library` | `{ count, categories: {name: n}, items: [...] }` | `gltf.scene.userData.library` |
| each root node's `extras` | `{ category, tags[], size[], clips[]? }` | `object.userData` (Babylon: `node.metadata`) |
| `asset.extras` | credit / license / link | `gltf.asset.extras` |

Each item is `{ name, category, tags[], size[], clips[]? }` — `size` being the
world-space bounding box, which is what you need to place a thing on a grid.
**The same fields ride on each node**, deliberately duplicated: engines differ on
what they expose. three.js hands back scene extras as `gltf.scene.userData`, but
Babylon surfaces extras per-node as `metadata`, so a consumer holding a node could
otherwise read its category and not its dimensions — the one field that answers
"does this fit in that gap" without instantiating candidates to find out.
`extras` is in the JSON chunk at the FRONT of the glb (9% of the bytes), so a
consumer can range-request the head of the file and read the whole catalogue
without pulling any geometry.

**Categories are derived, then corrected.** The default is the first name token
(`road-slant-high` → `road`), with the whole token list as `tags` — which is
excellent for most kits (Nature: tree 61, cliff 56, rock 30) and wrong where the
leading token is a style rather than a thing. Brick Kit is the worked example:
names read `<edge>-<quality>-<part>-<size>`, so the automatic answer was
bevel/none/round/square ×74, and two `categories` rules turn it into brick 184 /
plate 112. Look at a new kit with `bun bin/library-glb.ts <lib>.glb --list` before
deciding it needs rules.

### When a library will not fit

Kenney kits merge to 0.4–7.8 MB because their textures are 8 KB atlases. Quaternius'
characters are the opposite case — 2048² PBR maps at 3–4 MB apiece, ~8.5 MB of
geometry against 88 MB of textures — and the whole folder in one file is **67 MB**,
past Cloudflare's 25 MiB per-file cap. Splitting by style leaves 30 MB, still over.

So they ship split by **style+gender** (~15 MB each), which is not an arbitrary cut:
it is exactly how the textures are shared, one Normal/BaseColor/Roughness set per
style+gender plus the hair and eye maps every character uses. Those shared maps are
consequently re-embedded in all six files, so the six total *more* than the single
67 MB file would — the trade buys a shape that fits the host and can be cached per
character type.

Content-hash dedupe pays for itself here regardless: the pack ships 36 PNGs of which
only 24 are distinct (`T_Hair_1_Normal.png` and `T_Hair_1_Normal_png.png` are
byte-identical), so a build sheds ~30% before any splitting.

Nothing is resampled to achieve this. **Re-encoding those 2K PNGs would shrink it far
more than any packing decision, and is a content change nobody has approved** — if
the size ever matters more than fidelity, that is the lever, not a finer split.

### What is NOT published

Everything raw — and not because a rule catches it, but because nothing pushed it.
`assets/kenney/metadata.json` has no `publish` at all, so `/kenney/` serves only
what was *built*: the libraries. Same for Quaternius' UAL megafiles — they are
inputs, they are not in `publish`, so they cannot reach the CDN. See Publishing.

## Adding a pack

1. `mkdir assets/<name>/` and drop the asset files in (binaries stay local).
2. Add `assets/<name>/metadata.json` with `copyright`/`credit`/`link`/`license`.
   Add **nothing else** and the pack ships nothing — that is the correct default.
3. Decide how it ships. For a folder of many models, a `library` spec (see above)
   is almost always right. Only reach for `publish` when files must ship as-is.
4. `bun run build`, check `find public -type f | wc -l` is what you expected, then
   `curl -I` a staged file (or check `firebase.json`) for the headers, then
   `bun run deploy`.

## Consuming side (`tosijs-3d`)

Consumers set the base once and reference assets by logical path:

```js
import { setAssetBase, assetUrl, b3dLoader } from 'tosijs-3d'
setAssetBase('https://cdn.tosijs.net')
b3dLoader({ url: assetUrl('kenney/libraries/nature-kit.glb') })
```

A library arrives as one scene whose children ARE the models, so you pick by name
and clone, and filter on the index the file carries:

```js
const kit = gltf.scene                       // 329 children, one per model
const tree = kit.getObjectByName('tree_pineDefaultA').clone()
const { items, categories } = kit.userData.library   // {tree: 61, cliff: 56, ...}
const rocks = items.filter((i) => i.category === 'rock')
```

Loaders fetch cross-origin, so `Access-Control-Allow-Origin: *` is required — it's
set for every file by the generated config.

## Assumption to verify on first deploy

`bin/mirror.ts` assumes Firebase applies **all** matching `headers` blocks (the
common `**` block + each namespace rule cascade/union, deeper winning on a key
collision). If a namespaced file is missing CORS or attribution after deploy, that
assumption is wrong — fold the common headers into each namespace rule in
`bin/mirror.ts`.
