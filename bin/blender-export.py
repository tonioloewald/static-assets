# blender-export.py — headless FBX/blend/obj → GLB, with animation merging.
#
# Run via:
#   Blender --background --factory-startup --python blender-export.py -- <mode> ...
#
# Modes:
#   single <input> <output.glb>
#       Import one fbx/blend/obj/gltf and export a GLB.
#   merge  <output.glb> <model.fbx> <anim1.fbx> [anim2.fbx ...]
#       Import a skinned model, then import each animation clip, rename its action
#       after the clip's filename, stash it on the model's armature, and export ONE
#       GLB whose animations are named idle/run/jump/... — ready for a Babylon
#       animation state machine (b3dBiped). All clips must share the model's rig
#       (true for Kenney's animated characters).
import bpy, sys, os


def args():
    a = sys.argv
    return a[a.index("--") + 1 :] if "--" in a else []


def reset():
    bpy.ops.wm.read_homefile(use_empty=True)


def import_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = list(src.objects)
        for obj in dst.objects:
            if obj is not None:
                bpy.context.scene.collection.objects.link(obj)
    else:
        raise SystemExit(f"blender-export: unsupported input {path}")


def force_opaque():
    # Kenney character skin materials import from FBX with base-color alpha 0 and
    # export as glTF alphaMode MASK → the whole mesh is clipped away (invisible).
    # They're opaque characters, so force opaque blending + full alpha before export.
    for mat in bpy.data.materials:
        try:
            mat.blend_method = "OPAQUE"
        except Exception:
            pass
        if getattr(mat, "use_nodes", False) and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED" and "Alpha" in node.inputs:
                    try:
                        node.inputs["Alpha"].default_value = 1.0
                    except Exception:
                        pass


def export_glb(path):
    force_opaque()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_apply=False,
    )


def armatures():
    return [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]


def main():
    a = args()
    if not a:
        raise SystemExit("blender-export: no mode")
    mode = a[0]

    if mode == "single":
        inp, out = a[1], a[2]
        reset()
        import_any(inp)
        export_glb(out)

    elif mode == "merge":
        out, model, anims = a[1], a[2], a[3:]
        reset()
        import_any(model)
        arms = armatures()
        if not arms:
            raise SystemExit(f"blender-export: no armature in model {model}")
        arm = arms[0]
        arm.animation_data_create()

        kept = []
        for clip in anims:
            name = os.path.splitext(os.path.basename(clip))[0]
            before_actions = set(bpy.data.actions)
            before_objs = set(bpy.context.scene.objects)
            import_any(clip)
            new_objs = [o for o in bpy.context.scene.objects if o not in before_objs]

            # Each Kenney animation FBX imports TWO actions: the real clip (~33 frames)
            # AND a 2-frame "0.Targeting Pose". The armature's ACTIVE action is often
            # the targeting pose, which would stash a static pose and drop the motion.
            # So pick the NEW action with the LONGEST frame range — the real clip.
            new_actions = [ac for ac in bpy.data.actions if ac not in before_actions]
            action = max(
                new_actions,
                key=lambda a: a.frame_range[1] - a.frame_range[0],
                default=None,
            )
            if action is not None:
                action.name = name
                action.use_fake_user = True
                track = arm.animation_data.nla_tracks.new()
                track.name = name
                track.strips.new(name, int(action.frame_range[0]), action)
                kept.append(action)

            # Drop the imported duplicate mesh/armature; keep only the kept action.
            for o in new_objs:
                bpy.data.objects.remove(o, do_unlink=True)

        # Purge any stray actions (bind poses, dup takes) so ACTIONS export mode
        # emits exactly one animation per clip.
        for ac in list(bpy.data.actions):
            if ac not in kept:
                bpy.data.actions.remove(ac)

        # The glTF ACTIONS exporter samples over the SCENE frame range. Our empty
        # scene + animation-less model left it at the default ~2 frames, collapsing
        # every clip to a single static pose. Widen it to cover the longest clip so
        # the motion is actually captured.
        if kept:
            scene = bpy.context.scene
            scene.frame_start = min(int(a.frame_range[0]) for a in kept)
            scene.frame_end = max(int(a.frame_range[1]) for a in kept)

        export_glb(out)

    else:
        raise SystemExit(f"blender-export: unknown mode {mode}")


main()
