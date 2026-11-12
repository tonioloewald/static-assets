"""refmodel — reference-driven, mirrored low-poly modelling in Blender (bpy + bmesh).

Conventions (same as the "Modeling a Biplane" tutorial): the nose at Y 0 with the craft running
toward +Y, the ground at Z 0, the centre line at X 0. Every symmetric part is built as its +X
half and closed by a Mirror modifier (Clipping + Merge) around the world origin.

    import refmodel as rm
    side = rm.Ref("refs/side.jpg", "RIGHT", m_per_px=0.0042, px=(220, 1254), at=(0, 0))
    rm.setup_refs([side, ...])
    Y, Z = side.y, side.z                       # measure in drawing pixels, convert here
    bm = bmesh.new()
    rm.loft(bm, [rm.section_ring(Y(u), ...) for u ...], half=True)
    rm.finish("hull", bm, mats, mirror=True)
    rm.check([side, ...], "checks/")            # ortho render per view over its drawing

Everything is deterministic and re-runnable: finish() replaces an existing object of that name.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

# view -> (screen right, screen up, toward the camera) in world axes
VIEWS = {
    "RIGHT": ((0, 1, 0), (0, 0, 1), (1, 0, 0)),          # Numpad 3: nose on the left
    "LEFT": ((0, -1, 0), (0, 0, 1), (-1, 0, 0)),          # Ctrl Numpad 3: nose on the right
    "FRONT": ((1, 0, 0), (0, 0, 1), (0, -1, 0)),          # Numpad 1: looking at the nose
    "BACK": ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),           # Ctrl Numpad 1
    "TOP": ((1, 0, 0), (0, 1, 0), (0, 0, 1)),             # Numpad 7: tail at the top
    "TOP_NOSE_UP": ((-1, 0, 0), (0, -1, 0), (0, 0, 1)),   # a top drawing with the nose at the top
    "BOTTOM": ((1, 0, 0), (0, -1, 0), (0, 0, -1)),
}
EPS = 1e-5


def _basis(view):
    return [Vector(c) for c in VIEWS[view]]


def _rot(view):
    r, u, n = _basis(view)
    return Matrix((r, u, n)).transposed()            # columns: local X, Y, Z


class Ref:
    """One drawing. px=(u, v) is a pixel in it (v down, as in any image viewer), at=(sx, sy)
    where that pixel goes in the view plane (metres along the view's right / up axes).
    Measure features as drawing pixels and convert with point()/y()/z()/x()/len()."""

    def __init__(self, path, view, m_per_px, px, at=(0.0, 0.0), name=None, perspective=False):
        self.path = os.path.abspath(path)
        self.img = bpy.data.images.load(self.path, check_existing=True)
        self.W, self.H = self.img.size
        self.view, self.m = view, m_per_px
        self.u0, self.v0 = px
        self.a0, self.b0 = at
        self.name = name or os.path.splitext(os.path.basename(path))[0]
        self.perspective = perspective      # a perspective render: use for shape, not position

    def sx(self, u):
        return self.a0 + (u - self.u0) * self.m

    def sy(self, v):
        return self.b0 - (v - self.v0) * self.m

    def point(self, u, v):
        """World point on the view plane (the depth axis is 0)."""
        r, up, _ = _basis(self.view)
        return r * self.sx(u) + up * self.sy(v)

    def x(self, u, v=0):
        return self.point(u, v).x

    def y(self, u, v=0):
        return self.point(u, v).y

    def z(self, v, u=0):
        return self.point(u, v).z

    def len(self, px):
        return px * self.m

    def centre(self):
        return self.point(self.W / 2, self.H / 2)

    def size(self):
        return max(self.W, self.H) * self.m


def setup_refs(refs, depth=8.0, opacity=0.5, collection="Reference"):
    """Image empties placed behind the model, visible only in their own orthographic view,
    unselectable (so clicks hit the model)."""
    coll = bpy.data.collections.get(collection) or bpy.data.collections.new(collection)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    for r in refs:
        name = "ref_" + r.name
        old = bpy.data.objects.get(name)
        if old:
            bpy.data.objects.remove(old)
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = "IMAGE"
        e.data = r.img
        e.empty_display_size = r.size()
        e.empty_image_offset = (-0.5, -0.5)
        e.empty_image_depth = "BACK"
        e.use_empty_image_alpha = True
        e.color[3] = opacity
        e.show_empty_image_perspective = False
        e.show_empty_image_only_axis_aligned = True
        n = _basis(r.view)[2]
        e.matrix_world = Matrix.Translation(r.centre() - n * depth) @ _rot(r.view).to_4x4()
        e.hide_select = True
        coll.objects.link(e)
    return coll


# ---------------------------------------------------------------- rings

def section_ring(y, top, bot, hw, top_w=0.6, waist=(0.35, 0.72), bot_w=0.75, shoulder=0.12):
    """Half cross-section at y (world units): 7 points from the top centre down the +X side to
    the bottom centre. top/bot are z; hw the half-width; top_w / bot_w the flat top and bottom
    as fractions of hw; waist the z band (fractions of the height, from the top) at full width."""
    h = top - bot
    return [Vector(p) for p in (
        (0, y, top), (top_w * hw, y, top),
        (hw * (top_w + (1 - top_w) * 0.7), y, top - shoulder * h),
        (hw, y, top - waist[0] * h), (hw, y, top - waist[1] * h),
        (bot_w * hw, y, bot), (0, y, bot))]


def box_ring(y, top, bot, hw, chamfer=0.15):
    """Half chamfered box section: 5 points, top centre to bottom centre."""
    h = top - bot
    return [Vector(p) for p in ((0, y, top), (hw * (1 - chamfer), y, top), (hw, y, top - h / 2),
                                (hw * (1 - chamfer), y, bot), (0, y, bot))]


def ellipse_ring(y, zc, rz, hw, n=6):
    """Half ellipse: n+1 points from the top (on the centre line) round the +X side."""
    return [Vector((hw * math.sin(math.pi * k / n), y, zc + rz * math.cos(math.pi * k / n)))
            for k in range(n + 1)]


def circle_ring(c, axis, r, sides, phase=0.5):
    """Full ring of `sides` points round centre c, perpendicular to axis."""
    axis = Vector(axis).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    return [c + (u * math.cos(a) + v * math.sin(a)) * r
            for a in (2 * math.pi * (k + phase) / sides for k in range(sides))]


# ---------------------------------------------------------------- builders

def loft(bm, rings, half=True, cap0=True, cap1=True, mat=0):
    """Faces between consecutive rings (equal point counts). half=True: rings are open half
    rings with both ends on the centre line; the Mirror closes them, so no face is made there.
    Caps are flat polygons (a half cap's open edge lies on the centre line, which is fine)."""
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(vs[0])
    span = n - 1 if half else n
    fs = []
    for a, b in zip(vs, vs[1:]):
        for k in range(span):
            j = (k + 1) % n
            q = [a[k], a[j], b[j], b[k]]
            if len({v.co.to_tuple(5) for v in q}) >= 3:
                fs.append(bm.faces.new(q))
    if cap0 and _area(vs[0]) > 1e-8:
        fs.append(bm.faces.new(vs[0][::-1]))
    if cap1 and _area(vs[-1]) > 1e-8:
        fs.append(bm.faces.new(vs[-1]))
    for f in fs:
        f.material_index = mat
    return vs, fs


def _area(verts):
    s = Vector()
    pts = [v.co for v in verts]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        s += a.cross(b)
    return s.length / 2


def lathe(bm, centre, profile, sides=12, axis=(0, 0, 1), mat=0, caps=(True, True), phase=0.5):
    """Revolved part: profile [(t, r), ...] along axis from centre (world units)."""
    axis = Vector(axis).normalized()
    rings = [circle_ring(Vector(centre) + axis * t, axis, r, sides, phase) for t, r in profile]
    return loft(bm, rings, half=False, cap0=caps[0], cap1=caps[1], mat=mat)


def half_lathe(bm, centre, profile, sides=8, mat=0, caps=(True, True)):
    """A vertical revolved part centred ON the centre line: only its +X half (sides/2 + 1
    points per ring, both ends at x = 0)."""
    rings = []
    for t, r in profile:
        c = Vector(centre) + Vector((0, 0, t))
        rings.append([c + Vector((r * math.sin(math.pi * k / (sides // 2)), -r * math.cos(math.pi * k / (sides // 2)), 0))
                      for k in range(sides // 2 + 1)])
    return loft(bm, rings, half=True, cap0=caps[0], cap1=caps[1], mat=mat)


def tube(bm, path, radii, sides=6, mat=0, square=False, caps=(True, True)):
    """Prism along a polyline (world points). square=True: a 4-sided bar, radii = half-widths."""
    rings = []
    for i, p in enumerate(path):
        d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        if square:
            u = d.orthogonal().normalized()
            v = d.cross(u)
            rings.append([p + (u * sx + v * sy) * radii[i] for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        else:
            rings.append(circle_ring(p, d, radii[i], sides))
    return loft(bm, rings, half=False, cap0=caps[0], cap1=caps[1], mat=mat)


def half_tube(bm, path, radii, sides=6, mat=0, caps=(True, True)):
    """A strut lying ON the centre line (path points with x = 0): its +X half only."""
    X = Vector((1, 0, 0))
    rings = []
    for i, p in enumerate(path):
        d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        q = X.cross(d).normalized()                   # in the centre plane, across the strut
        h = sides // 2
        rings.append([p + (q * math.cos(math.pi * k / h) + X * math.sin(math.pi * k / h)) * radii[i]
                      for k in range(h + 1)])
    return loft(bm, rings, half=True, cap0=caps[0], cap1=caps[1], mat=mat)


class placed:
    """Model a sub-part straight (axis-aligned, around the origin), then move it into place:

        with rm.placed(bm, rm.aim(hip, knee)):
            rm.lathe(bm, (0, 0, 0), [(0, r), (length, r)])   # along +Z, from the origin
    """

    def __init__(self, bm, matrix):
        self.bm, self.matrix = bm, matrix

    def __enter__(self):
        self.before = set(self.bm.verts)
        return self

    def __exit__(self, *exc):
        new = [v for v in self.bm.verts if v not in self.before]
        bmesh.ops.transform(self.bm, matrix=self.matrix, verts=new)


def aim(a, b, up=(0, 1, 0)):
    """Matrix taking the local +Z axis from point a toward point b (local origin at a).
    Returns (matrix, length) — model the part along +Z with that length."""
    a, b = Vector(a), Vector(b)
    d = b - a
    q = d.to_track_quat("Z", "Y" if abs(d.normalized().dot(Vector(up))) < 0.99 else "X")
    return Matrix.Translation(a) @ q.to_matrix().to_4x4(), d.length


def inset_extrude(bm, faces, inset, depth, wall_mat=None, floor_mat=None):
    """Inset a region (Boundary OFF, so a region touching the centre line stays open there and
    the Mirror closes it), then extrude it by depth along its normal (negative = into the part).
    Returns the floor faces."""
    faces = list(faces)
    n = sum((f.normal for f in faces), Vector()).normalized()
    bmesh.ops.inset_region(bm, faces=faces, thickness=inset, depth=0, use_boundary=False,
                           use_even_offset=True)
    ext = bmesh.ops.extrude_face_region(bm, geom=faces)
    new_faces = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMFace)]
    new_verts = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=new_verts, vec=n * depth)
    bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
    walls = {f for v in new_verts for f in v.link_faces if f not in new_faces}
    if wall_mat is not None:
        for f in walls:
            f.material_index = wall_mat
    if floor_mat is not None:
        for f in new_faces:
            f.material_index = floor_mat
    return new_faces


def clean_centre(bm):
    """Snap near-centre verts onto x = 0 and delete faces lying in the centre plane (they'd be
    inside the mirrored part)."""
    for v in bm.verts:
        if abs(v.co.x) < 1e-4:
            v.co.x = 0.0
    inside = [f for f in bm.faces if all(abs(v.co.x) < EPS for v in f.verts)]
    if inside:
        bmesh.ops.delete(bm, geom=inside, context="FACES_ONLY")


# ---------------------------------------------------------------- objects

def material(name, color, metallic=0.0, roughness=0.6, alpha=1.0, emission=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    m.diffuse_color = (*color[:3], alpha)
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*color[:3], 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Alpha"].default_value = alpha
    if alpha < 1:
        try:
            m.surface_render_method = "BLENDED"
        except AttributeError:
            m.blend_method = "BLEND"
    if emission:
        b.inputs["Emission Color"].default_value = (*emission[:3], 1)
        b.inputs["Emission Strength"].default_value = emission[3] if len(emission) > 3 else 1
    return m


def mirror_origin():
    """An empty at the world origin: the mirror plane for parts that are placed by transform."""
    e = bpy.data.objects.get("mirror_origin")
    if not e:
        e = bpy.data.objects.new("mirror_origin", None)
        e.empty_display_size = 0.3
        bpy.context.scene.collection.objects.link(e)
    return e


def finish(name, bm, mats, collection="model", mirror=True, smooth_angle=35, matrix=None):
    """bmesh -> object. Replaces a same-named object.

    matrix=None: the mesh is in world coordinates and the object sits at the origin (the Mirror
    plane). matrix=<Matrix>: the part was modelled STRAIGHT in its own frame (axis-aligned,
    origin at its pivot) and is put in place by the object transform; a mirrored copy then
    mirrors across the world origin via mirror_origin(). Never model a part at an angle."""
    if mirror and matrix is None:
        clean_centre(bm)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    coll = bpy.data.collections.get(collection) or bpy.data.collections.new(collection)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    old = bpy.data.objects.get(name)
    if old:
        me_old = old.data
        bpy.data.objects.remove(old)
        if me_old.users == 0:
            bpy.data.meshes.remove(me_old)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    if smooth_angle:                       # smooth shading, sharp edges above the angle
        try:
            me.set_sharp_from_angle(angle=math.radians(smooth_angle))
            for p in me.polygons:
                p.use_smooth = True
        except AttributeError:             # Blender < 4.1: stay flat
            pass
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    if matrix is not None:
        ob.matrix_world = matrix
    if mirror:
        md = ob.modifiers.new("Mirror", "MIRROR")
        md.use_axis = (True, False, False)
        if matrix is None:
            md.use_clip = True
            md.use_mirror_merge = True
            md.merge_threshold = 1e-3
        else:
            md.mirror_object = mirror_origin()
            md.use_mirror_merge = False
    return ob


def tris(objects):
    """Triangle count after modifiers."""
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for ob in objects:
        me = ob.evaluated_get(dg).to_mesh()
        n += sum(len(p.vertices) - 2 for p in me.polygons)
        ob.evaluated_get(dg).to_mesh_clear()
    return n


# ---------------------------------------------------------------- checking

def check(refs, out_dir, alpha=0.55, tint=(1.0, 0.15, 0.1), out_scale=0.5, hide=()):
    """For each Ref: an orthographic Workbench render framed exactly like the drawing (same
    size, centre, and axes), tinted and laid over it. Writes <out_dir>/<name>_check.jpg.
    Where the tint and the drawing disagree, fix the station that view controls."""
    import numpy as np
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    keep = (sc.render.engine, sc.camera, sc.render.resolution_x, sc.render.resolution_y,
            sc.render.resolution_percentage, sc.render.film_transparent, sc.render.filepath)
    try:
        sc.render.engine = "BLENDER_WORKBENCH"
    except TypeError:
        pass
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_cavity = "STUDIO", "SINGLE", True
    sc.render.film_transparent = True
    sc.render.resolution_percentage = 100
    cam = bpy.data.objects.get("check_cam") or bpy.data.objects.new("check_cam", bpy.data.cameras.new("check_cam"))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.clip_end = 500
    sc.camera = cam
    hidden = [o for o in bpy.data.objects if o.name.startswith("ref_") or o.name in hide]
    for o in hidden:
        o.hide_render = True
    outs = []
    for r in refs:
        n = _basis(r.view)[2]
        cam.matrix_world = Matrix.Translation(r.centre() + n * 100) @ _rot(r.view).to_4x4()
        cam.data.ortho_scale = r.size()
        sc.render.resolution_x, sc.render.resolution_y = r.W, r.H
        tmp = os.path.join(out_dir, f"_{r.name}_render.png")
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        rend = bpy.data.images.load(tmp, check_existing=False)
        a = np.array(r.img.pixels[:], dtype=np.float32).reshape(r.H, r.W, -1)[..., :3]
        b = np.array(rend.pixels[:], dtype=np.float32).reshape(r.H, r.W, 4)
        k = b[..., 3:4] * alpha
        o = a * (1 - k) + np.array(tint, dtype=np.float32) * k
        img = bpy.data.images.new(f"{r.name}_check", r.W, r.H)
        img.pixels[:] = np.concatenate([o, np.ones((r.H, r.W, 1), np.float32)], axis=2).ravel()
        img.scale(int(r.W * out_scale), int(r.H * out_scale))
        path = os.path.join(out_dir, f"{r.name}_check.jpg")
        img.filepath_raw = path
        img.file_format = "JPEG"
        img.save()
        bpy.data.images.remove(img)
        bpy.data.images.remove(rend)
        os.remove(tmp)
        outs.append(path)
    for o in hidden:
        o.hide_render = False
    (sc.render.engine, sc.camera, sc.render.resolution_x, sc.render.resolution_y,
     sc.render.resolution_percentage, sc.render.film_transparent, sc.render.filepath) = keep
    return outs
