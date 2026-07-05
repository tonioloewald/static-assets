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

## Open questions / to-map (living log)

- [ ] **Accessory snap correctness** — origin/orientation of Bundle accessories vs
  bone space (see Equip ⚠️). Record any offsets/rotations needed per accessory kind.
- [ ] **Cross-anim bone identity** — are Bundle bone names byte-identical to the
  themed-pack model? (enables reusing the 17 clips everywhere)
- [ ] **2D assets** — spritesheet/tilemap conventions (`Tilesheet.txt`, `.tsx`/`.tmx`
  seen in 1-Bit packs). Atlas layout / naming.
- [ ] **Audio** — SFX/music categories + formats.
- [ ] **UI assets / Icons** — nine-slice? sprite naming?
- [ ] **Kit packs** (vehicles, buildings, nature) — do they snap on a modular grid?
  Kenney "kit" packs typically tile on a fixed unit; capture the grid size when found.
