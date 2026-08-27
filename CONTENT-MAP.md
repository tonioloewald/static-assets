# CONTENT-MAP.md

A **living map** of what's in the asset library and — more importantly — how the
pieces are *intended to snap together*. Add to it as we figure things out. This is
tribal knowledge that isn't obvious from a file listing; keep it current.

Companion to `CLAUDE.md` (how the mirror/conversion pipeline works). This file is
about the *content*, not the tooling.

---

## Kenney library — top-level

`assets/kenney/` (the paid all-in-one bundle, CC0). Categories:

`2D assets/` · `3D assets/` · `Audio/` · `UI assets/` · `Icons/` · `Other/` ·
`Early access/` · `Goodies/` (+ `assets.json` index, `Overview.html`, `Readme.html`).

### 3D format convention (why coverage looked weird)

Each 3D model pack ships **parallel format folders** — `FBX format/`, `GLB format/`,
`OBJ format/`, `glTF format/` — plus shared textures. So a model's glb sits in a
*sibling* folder, not next to its fbx. ~4,846 distinct models are already web-ready
glb. The **only** models lacking a glb were the animated characters (fbx/blend
source only) → we generate those (see `CLAUDE.md`).

---

## ⭐ Animated character system (the modular kit)

The clearest "designed to combine" content. **body × animation × skin × accessory**,
all on one shared rig.

> **⚠️ STATUS (2026-07-06): animated characters are SHELVED — accessories kept.**
> Kenney's `Animations/*.fbx` are **mesh-less clips** authored against a *different
> bind pose* than the `Model/` FBX, so merging them (model mesh + animation clips)
> yields rest-pose **retargeting garbage** — T-pose with only partial motion. Proper
> retargeting is real work for a low payoff (omnidude is cleaner, the skins are meh,
> equip is trivial to DIY). **Decision: use omnidude for animated characters.**
> - Character **MERGE** conversions are **off** (`scan-conversions.ts`
>   `GENERATE_MERGES = false`); the 3 pure-character packs are excluded from the
>   mirror, and the Bundle's `Models`/`Animations`/`Skins` too.
> - **Accessories ARE kept** — static props that convert cleanly (single mode) and
>   bone-attach to *any* character. The Bundle's `Accessories/` still convert + deploy.
> - Re-enable if Kenney fixes the source, or drive from the `.blend` files (Bundle
>   only). The reskin/equip/rig notes below stand as reference for whatever we do use.

### Packs

| Pack | Body models | Animations | Skins | Notes |
| --- | --- | --- | --- | --- |
| **Animated Characters Bundle** | 4 — `characterSmall`, `characterMedium`, `characterLargeMale`, `characterLargeFemale` | 17 — idle, run, walk, jump, attack, punch, kick, shoot, death, crouch(+Idle/Walk), interactGround/Standing, racingIdle/Left/Right | **51** — alien, astro, athlete (team colors), … | Master kit + Accessories. Also has `.blend` sources (redundant with the fbx). |
| **Animated Characters Protagonists** | 1 — `characterMedium` | 3 — idle, jump, run | 4 — criminal, cyborg, skater ×2 | Themed subset |
| **Animated Characters Retro** | 1 — `characterMedium` | 3 | 4 | Themed subset |
| **Animated Characters Survivors** | 1 — `characterMedium` | 3 | 4 | Themed subset |

### Shared rig (58-bone humanoid)

Standard, cleanly-named skeleton — the same across all animated-character packs:

```
Hips · Spine · Chest · UpperChest · Neck · Head
Left/Right: Shoulder → Arm → ForeArm → Hand (+ Index1-3, Thumb1-2)
Left/Right: UpLeg → Leg → Foot → Toes
IK/ctrl: HipsCtrl, FootIK, KneeCtrl, FootRollCtrl, Heel/ToeRoll
```

Because the rig is shared, **animations and skins are cross-compatible** — e.g. the
Bundle's 17 clips can drive the Protagonists/Retro/Survivors `characterMedium`, and
any skin fits any body. (Verify bone-name identity the first time you actually mix
Bundle anims onto a themed-pack model — almost certainly identical.)

### Reskin — HOW ✅ (obvious + clean)

- The converted glb ships **one mesh, one material named `skin`, and NO baked
  texture** (`images: []`).
- Skins live in `<pack>/Skins/*.png` (Bundle: 51; themed packs: 4), with editable
  `Skins/Source/*.svg`. All share one UV layout.
- **Reskin = assign the chosen png as the `skin` material's albedo at load time.**
  Babylon: load glb → `scene.getMaterialByName('skin')` → set `albedoTexture`.
- tosijs-3d: a `skin="…"` attribute on `b3dBiped` drops right out of this.

### Equip — HOW ✅ (standard bone attach)

- **Attach points** (bone nodes): `Head` (hats / ears / masks / mouths),
  `LeftHand` / `RightHand` (weapons / tools), `Hips`·`Spine` (tails).
- **Accessories**: `Animated Characters Bundle/Accessories/Animals/*.fbx` — ears,
  tails, mouths, etc. (uncovered → converted to glb one-to-one by the pipeline).
- **Equip = parent the accessory to the target bone node** (Babylon
  `attachToBone` / parent to the joint TransformNode).
- ⚠️ **OPEN:** confirm each accessory's authored *origin/orientation* sits correctly
  when parented to its bone (convert one, parent to `Head`/`RightHand`, eyeball).
  Kenney usually authors accessories at the character origin to drop onto the bone —
  verify, and note any per-accessory offset here when found.

---

---

## ⭐ Modular kit grids & scale (world-building)

Measured world-space footprints (glb, node transforms applied). **Two grid families:**

| Kit | Base footprint (X×Z) | Family |
| --- | --- | --- |
| **Nature Kit** | 1 × 1 | 1-unit ✅ |
| **City Kit** (Roads / Commercial / Suburban / Industrial) | 1 × 1 | 1-unit ✅ |
| **Road Pack** | 1 × 1 | 1-unit ✅ |
| **Mini Dungeon** (and Mini * kits) | 1 × 1 | 1-unit ✅ |
| **Hexagon Kit** | 1-unit hex (~1 × 1.15) | 1-unit (hex topology) |
| **Platformer Kit** | ~1 × 1 (beveled blocks) | 1-unit |
| **Building Kit** | 2 × 2 | its own unit |
| **Modular Space Kit** | 4 × 4 floor · walls 2w × ~4h | modular interior |
| **Modular Dungeon Kit** | 4×4 cell · walls 2w × ~4h · `template-*` | modular interior |
| Furniture Kit | real-scale props (table ≈ 0.84 m) | sits inside rooms |

- **1-unit family — Nature + City + Roads + Mini + Hexagon all share a 1×1 cell.** So
  you CAN assemble outdoor spaces from Nature and embed cities/roads/paths on the same
  grid. This is the headline: outdoor world-building is directly mixable.
- **Modular interior family — Modular Dungeon + Modular Space are the SAME system**
  (4×4 floors, 2-wide × ~4-tall walls, identical `template-floor/wall/*` names) at 4×
  the 1-unit cell. Mix within the family freely; **scale ×4** to bridge to 1-unit props.
- Always measure a base tile before mixing families — the 1-unit and 4-unit systems
  don't share a cell size.

## ⭐ Tile naming ↔ connectivity (auto-assembly from names)

Kenney names modular tiles by a **connectivity vocabulary** — words, but 1:1 mappable
to a binary open/closed edge model, so a map can be assembled knowing only the scale +
tile names. The SAME vocabulary repeats across sub-types and largely across kits:

| Connectivity | Nature (`ground_path*`/`ground_river*`) | City (`road-*`) | Edges open | Distinct rotations |
| --- | --- | --- | --- | --- |
| straight (2 opposite) | `Straight` | `road-straight` | N+S | 2 |
| turn 90° (2 adjacent) | `Bend` / `Corner` | `road-curve` / `road-bend` | N+E | 4 |
| T-junction (3) | `Split` | `road-intersection` | N+E+S | 4 |
| cross (4) | `Cross` | `road-crossroad` | N+E+S+W | 1 |
| dead-end (1) | `End` / `EndClosed` | `road-end` | N | 4 |
| filler / cap | `Tile` / `Open` / `Side` | — | 0 | — |

- Nature's `ground_path*` and `ground_river*` are **identical token sets** — one scheme,
  two skins. City roads use the same *concepts* with slightly different words → a small
  per-kit alias table (`bend/curve/corner`→turn, `split/intersection`→T,
  `cross/crossroad`→X, `end`→dead-end) unifies them.
- With `name → (edgeMask, symmetry)` + the 1-unit grid + 4 rotations, you can
  auto-assemble road/path/river networks from a binary open/closed map — the same
  workflow as our own tile naming.
- **Exceptions:** **Road Pack is numeric** (`tile000`–`tile293`) — NOT self-describing,
  needs a manual lookup (prefer City Kit - Roads, which is semantic). **Hexagon Kit**
  uses hex connectivity (`path-corner`, `-corner-sharp`, `-crossing`, `-intersectionA/B`,
  `-end`) → a 6-bit hex edge-mask, A/B disambiguating rotationally-distinct junctions.
- Cosmetic suffixes are **additive, same connectivity**: `-barrier`, `-sidewalk`,
  `-line`, `-pavement`, `-square`. Strip them to get the base connectivity token.

### Encoding it in metadata (so naming consistency doesn't matter)

Because `metadata.json` is overlaid down the tree and hand-editable, we encode the
grid + connectivity **there** — our metadata is the source of truth, not Kenney's
filenames. Consistent naming just lets us bulk-derive it via rules; inconsistent or
numeric kits get explicit entries. Proposed fields on a pack's `metadata.json`:

```json
{
  "grid": { "shape": "square", "unit": 1 },
  "tileRules": [
    { "match": "*Straight",        "edges": "NS" },
    { "match": "*Bend|*Corner",    "edges": "NE" },
    { "match": "*Split",           "edges": "NES" },
    { "match": "*Cross",           "edges": "NESW" },
    { "match": "*End",             "edges": "N" }
  ],
  "tiles": {
    "tile022": { "edges": "NS" },
    "tile047": { "edges": "NE", "rot": 90 }
  }
}
```

Resolution order for a tile's open edges: explicit `tiles[name]` → first matching
`tileRules` → (fallback) the name vocabulary above. So semantic kits (Nature, City)
need only a few `tileRules` — overlaid from a shared parent so path+river+roads reuse
one table — while the numeric **Road Pack** gets explicit `tiles` entries (authored
once, versioned), and any per-tile art quirk gets a `tiles` override with a `rot`.

Same principle as the `convert` specs: **metadata is the durable, shared source of
truth; the assets are just payload.** An assembler in tosijs-3d reads `grid` +
resolved edges and places rotated instances on the grid from a binary open/closed map.

---

## ⭐ Quaternius — Universal Animation Library (UAL)

**Every animation is already here.** Four megafiles under `assets/quaternius/`,
and nothing needs re-downloading or re-exporting to get a clip we are not using
yet — subset again with a longer list.

| file | clips | size | notes |
| --- | --- | --- | --- |
| `UAL1.glb` | **120** | 20.4 MB | library 1, in-place |
| `UAL1_RM.glb` | 120 | 20.4 MB | **root motion** — see below |
| `UAL2.glb` | **134** | 19.8 MB | library 2 |
| `UAL2_RM.glb` | 134 | 19.8 MB | root motion |

Each is **one mesh, zero images, and ~75% animation data** (15.4 MB of UAL1's
20.4 MB is animation accessors). That is why subsetting pays so well and why
texture optimisation would not: there are no textures.

### `_RM` is root motion, and is deliberately not used yet

Root motion means the CLIP translates the root node. A controller that also
moves that node — `tosijs-3d`'s `b3d-biped` moves it with `moveWithCollisions`
and writes `position.y` for its ground snap — will fight it: the animation
shoves one way, the controller the other. Symptoms are drift, stutter, or a
character travelling faster than its input says.

So the non-RM files are the ones to consume today. Keep the RM ones: they are
exactly what an intent-driven locomotion model wants, where the character's
movement comes FROM the animation rather than being painted over it (see
`tosijs-3d/MOBILITY-DESIGN.md`).

### Subsetting — a `convert` spec, no Blender

It is part of the normal pipeline: a third spec shape alongside `merge` and
`single`, so `bun run convert` (and therefore `bun run build`) produces it,
cached by input signature and spec like everything else.

```jsonc
// assets/quaternius/metadata.json
{ "convert": [
  { "output": "UAL1_core.glb", "input": "UAL1.glb",
    "clips": ["Idle_Loop", "Walk_Loop", "Jump_*"] }
] }
```

`bin/subset-glb.ts` is also a CLI, which is how you explore:

```sh
bun bin/subset-glb.ts assets/quaternius/UAL1.glb --list          # every clip name
bun bin/subset-glb.ts assets/quaternius/UAL1.glb \
  derived/quaternius/UAL1_core.glb  Idle_Loop Walk_Loop 'Jump_*'  # ad-hoc subset
```

A glTF is a JSON header over a binary blob, so dropping animations is surgery on
the header plus a rebuild of the blob — exact, fast, lossless for what it keeps,
and it does not round-trip through Blender's importer and exporter. It also does
not crash on packs this size, which a Blender re-export does.

Names may end in `*` to keep a family. A name that matches nothing is a **fatal
error**, not a warning: a silently-missing clip becomes a character frozen in one
state at runtime, and tracing that back to a typo is miserable.

Output goes to `derived/`, which is **gitignored** — subsets are build artifacts,
the megafiles are the source of truth. Originals are opened read-only.

### The current core subset

`derived/quaternius/UAL1_core.glb` — **27 of 120 clips, 20.4 MB → 5.00 MB (75%
smaller)**, structurally validated (accessors in bounds, skin and mesh intact):

- locomotion: `Idle_Loop`, `Walk_Loop`, `Jog_Fwd/Bwd/Left/Right_Loop`,
  `Sprint_Enter/Loop/Exit`, `Turn90_L/R`
- crouch: `Crouch_Idle/Fwd/Bwd/Left/Right_Loop`, `Crouch_Enter/Exit`
- jump: `Jump_Start`, `Jump_Loop`, `Jump_Land` — **split**, so a wind-up can hold,
  an airborne loop can last as long as the flight, and landings exist
- water: `Swim_Fwd_Loop`, `Swim_Idle_Loop`
- misc: `A_TPose`, `Interact`, `Dance_Loop`, `Driving_Loop`

**If a consumer needs a clip that is not in there, add it to the list and
regenerate.** The whole library is sitting in `assets/`.

### Worth knowing

- The libraries carry a full action vocabulary beyond locomotion — combat
  (`Sword_*`, `Punch_*`, `Pistol_*`, `Spell_*`, `Hit_*`, `Death01/02`),
  climbing (`ClimbLedge`, `Climb_Up/Down/Left/Right_Loop`), `Crawl_*`, `Roll`,
  `Dodge_Left/Right`, sitting, counter/shop interactions. Run `--list` before
  assuming something needs authoring.
- **Not yet done: precision and keyframe-rate reduction.** Rotations are float
  quaternions at the exported sample rate; quantising and/or resampling would cut
  the remaining animation bytes again. Subsetting was the order-of-magnitude win,
  so this is the next lever rather than the first.
- **`scale` is not applied to subsets.** The input is already a built glb at the
  scale it was authored; silently resizing it on the way through would be a
  surprise. Blender specs still honour it.

## Open questions / to-map (living log)

- [ ] **Edge-mask metadata** — author `grid` + `tileRules`/`tiles` (above) for Nature,
  City Roads, Road Pack, Hexagon. Metadata-driven, so Kenney's naming (in)consistency
  is irrelevant; this is what unlocks programmatic map assembly.
- [ ] **Rotation origin** — confirm base tiles are centered on their cell so 90°
  rotations align (measure center offset, not just footprint).
- [ ] **Road Pack `tile000`–`293`** → connectivity lookup, or deprecate for City Roads.
- [ ] **Cross-family scale** — verify ×4 exactly bridges 1-unit ↔ Modular interior.
- [ ] **Accessory snap correctness** — origin/orientation of Bundle accessories vs
  bone space (see Equip ⚠️). Record any offsets/rotations needed per accessory kind.
- [ ] **Cross-anim bone identity** — are Bundle bone names byte-identical to the
  themed-pack model? (enables reusing the 17 clips everywhere)
- [ ] **2D assets** — spritesheet/tilemap conventions (`Tilesheet.txt`, `.tsx`/`.tmx`
  in 1-Bit packs). Atlas layout / naming.
- [ ] **Audio** — SFX/music categories + formats.
- [ ] **UI assets / Icons** — nine-slice? sprite naming?
