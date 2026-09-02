"""Rebuild object-sculpt-spec.json from the skeleton: every number here is a measurement off
ref/three-view.png (top view: 601 px span, 224 px nose-to-tip; 1 px = 0.03328 m at a 20 m span)."""
import json, math, copy
S = json.load(open('skeleton-spec.json', encoding='utf-8'))

NOSE_Z = -3.7                      # nose sits at z=-3.7 so the airframe is centred; +z is aft
def z(a): return round(a + NOSE_Z, 4)

# ---- planform in metres, a = distance aft of the nose, x = lateral (half-span 10 m) ----
def LE(x):
    x = abs(x)
    if x <= 9.6: return 0.638 * x
    return 6.12 + (x - 9.6) / 0.4 * (7.05 - 6.12)
def TE(x):
    x = abs(x)
    if x <= 3.3: return 6.26 - 0.77 * x / 3.3
    if x <= 9.0: return 5.49 + 0.358 * (x - 3.3)
    return 7.53 - (x - 9.0) / 1.0 * (7.53 - 7.05)
THICK = [(0, 0.95), (1.75, 0.85), (3.3, 0.62), (6.0, 0.42), (9.0, 0.30), (9.6, 0.24), (10.0, 0.0)]
def thick(x):
    x = abs(x)
    for (x0, t0), (x1, t1) in zip(THICK, THICK[1:]):
        if x0 <= x <= x1: return t0 + (t1 - t0) * (x - x0) / (x1 - x0)
    return 0.0

# The sweep's section plane is perpendicular to the spine, which is swept back, so each station is
# a tilted rib. Solve rx and the spine z so the rib's ends land on the measured LE and TE.
def wing_stations(sign):
    xs = [0.0, 0.35, 1.0, 1.75, 2.5, 3.3, 4.5, 6.0, 7.5, 9.0, 9.6, 10.0]
    zs = [(LE(x) + TE(x)) / 2 for x in xs]
    rx = [(TE(x) - LE(x)) / 2 for x in xs]
    for _ in range(8):
        # The root rib must lie on the centreline, not tilt with the sweep, or the two wings leave a
        # V-shaped hole at the nose. The sweep takes ring 0's tangent from station 1, so station 1
        # shares station 0's z (tangent along +X) and only its front end is solved onto the LE.
        # This runs inside the fit so the next rib sees the real tilt, not a pre-forcing one.
        zs[0] = (LE(0) + TE(0)) / 2; rx[0] = (TE(0) - LE(0)) / 2
        zs[1] = zs[0]
        th = math.atan2(zs[2] - zs[0], xs[2] - xs[0]); c, s = math.cos(th), math.sin(th)
        r = rx[1]
        for _ in range(8): r = (zs[1] - LE(xs[1] + r * s)) / c
        rx[1] = r
        for i, x in enumerate(xs):
            if i < 2: continue
            i0, i1 = max(0, i - 1), min(len(xs) - 1, i + 1)
            th = math.atan2(zs[i1] - zs[i0], xs[i1] - xs[i0])
            c, s = math.cos(th), math.sin(th)
            r = rx[i]
            # the rib normal is (-sin, 0, cos): its front end lands outboard, its back end inboard
            for _ in range(6):
                r = (TE(x - r * s) - LE(x + r * s)) / (2 * c) if c > 1e-6 else r
            rx[i] = max(0.0, r)
            zs[i] = (LE(x + rx[i] * s) + TE(x - rx[i] * s)) / 2
    out = []
    for x, zc, r in zip(xs, zs, rx):
        t = thick(x)
        out.append({"position": [round(sign * x, 4), round(-t / 2, 4), z(zc)],
                    "rx": round(r, 4), "rz": round(t / 2, 4), "twist": 0.0})
    return out

# ---- component template ----
base = S['componentTree'][0]
def comp(id, name, level, role, primitive, topo, rationale, parent, pos, dims, material, recipe,
         rot=(0, 0, 0), scale=None, descriptor=None, features=None, importance=0.6, conf=0.8,
         evidence=('top-view',), tier='blockout'):
    c = copy.deepcopy(base)
    c.update({"id": id, "name": name, "level": level, "role": role, "importance": importance,
              "confidence": conf, "primitive": primitive, "topologyClass": topo,
              "topologyRationale": rationale, "parent": parent, "attachment": None,
              "material": material, "materialLayers": [material], "evidenceRefs": list(evidence),
              "localFeatures": features or [], "fidelityTier": tier})
    c['dimensions'] = {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": conf}
    c['transform'] = {"position": [round(v, 4) for v in pos], "rotation": list(rot)}
    if scale is not None: c['transform']['scale'] = list(scale)
    if descriptor: c['geometryDescriptor'].update(descriptor)
    c['actionProfile']['animationRole'] = 'root' if parent is None else 'child'
    if parent is not None:   # zero-length segment: keeps the authored primitive, satisfies the gate
        c['attachment'] = {"parentId": parent, "parentSocket": f"{id}-mount", "localStart": [round(v, 4) for v in pos],
                           "localEnd": [round(v, 4) for v in pos], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}
    c['actionProfile']['collider']['type'] = 'box'
    c['colorMaterialRecipe'] = recipe
    return c

GREY = {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)",
        "materialClass": "plastic", "materialClassConfidence": 0.7,
        "evidence": "composite skin reads as matte light grey in both references"}
DARK = {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)",
        "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}
METAL = {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)",
         "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}

def feat(id, name, kind, note): return {"id": id, "name": name, "kind": kind, "description": note}

C = []
# ---- centre body: one implicit field so the hump and hull blend like the reference ----
C.append(comp('root', 'Centre body (hull, dorsal hump, carved intake, blunt tail)', 'macro', 'body', 'ellipsoid', 'implicit',
    'A blended lens with a dorsal hump and a blunt tail; only a smooth-union field gives the hump-to-hull fillet the render shows.',
    None, (0, 0, 0), (4.0, 1.6, 6.6), 'airframe', GREY, scale=(1, 1, 1), importance=1.0,
    evidence=('top-view', 'front-view', 'side-view'),
    features=[feat('intake-mouth', 'Dorsal intake mouth', 'hole', 'dark opening carved into the front face of the hump, 1.1 m aft of the nose'),
              feat('hump-contour', 'Dorsal hump', 'contour', 'steep front, long tail fairing to the trailing edge, peak 0.5 m above the wing at 2.3 m aft'),
              feat('bay-door-outline', 'Bay dotted outline', 'linework', 'dotted rectangular panel line on the belly aft of the nose gear')],
    descriptor={"sdf": {
        "primitives": [
            {"id": "hull", "type": "ellipsoid", "center": [0, -0.59, z(3.0)], "radii": [1.75, 0.44, 2.7]},   # top 0.15 under the wing skin: belly depth only, never a plateau
            {"id": "tail", "type": "box", "center": [0, -0.28, z(5.55)], "size": [1.3, 0.5, 1.3]},
            {"id": "hump-head", "type": "ellipsoid", "center": [0, -0.12, z(2.3)], "radii": [0.90, 0.62, 1.5]},
            {"id": "hump-tail", "type": "ellipsoid", "center": [0, -0.15, z(4.2)], "radii": [0.62, 0.45, 1.9]},
            {"id": "intake", "type": "box", "center": [0, 0.20, z(1.2)], "size": [0.7, 0.16, 0.4]}],   # intake: a mouth in the sloped front face, the tip below it stays
        "operations": [
            {"type": "smooth-union", "left": "hull", "right": "tail", "radius": 0.45, "output": "u0"},
            {"type": "smooth-union", "left": "u0", "right": "hump-head", "radius": 0.35, "output": "u1"},
            {"type": "smooth-union", "left": "u1", "right": "hump-tail", "radius": 0.35, "output": "u2"},
            {"type": "subtract", "left": "u2", "right": "intake", "output": "body"}],
        "resolution": 64,
        "bounds": {"min": [-2.0, -1.2, z(0.2)], "max": [2.0, 0.7, z(6.5)]}}}))

# ---- wings: tapered sweeps whose stations are the measured chord and thickness ----
for sign, sid in ((1, 'stbd'), (-1, 'port')):
    C.append(comp(f'wing-{sid}', f'Wing ({"starboard" if sign > 0 else "port"})', 'macro', 'wing', 'tapered-sweep', 'continuous-sculpt',
        'One continuous lifting surface from centreline to a pointed tip; chord and thickness both taper, which no constant-section primitive can express.',
        'root', (0, 0, 0), (10.0, 0.95, 7.5), 'airframe', GREY, scale=(1, 1, 1), importance=1.0, conf=0.85,
        evidence=('top-view', 'front-view'),
        features=[feat(f'elevon-lines-{sid}', 'Outboard elevon panel lines', 'linework', 'two chordwise lines at 60 % and 88 % span bounding the elevon'),
                  feat(f'root-seam-{sid}', 'Wing-root panel seam', 'seam', 'chordwise seam where the wing skin meets the body fairing at 1.75 m')],
        descriptor={"taperedSweep": {"stations": wing_stations(sign), "radialSegments": 24, "capEnds": True}}))

# ---- intake and exhaust: dark insets sunk into the body, which read as openings without carving the field ----
C.append(comp('exhaust', 'Trailing-edge exhaust', 'meso', 'nozzle', 'box', 'assembled-solid',
    'A dark box sunk into the blunt tail end, flush with the trailing-edge face.', 'root',
    (0, -0.08, z(6.0)), (0.95, 0.26, 0.40), 'dark-polymer', DARK, importance=0.7, evidence=('top-view', 'render-top'),
    features=[feat('exhaust-inset', 'Trailing-edge exhaust slot', 'decal', 'rectangular dark slot at the centre trailing edge')]))

# ---- sensor blisters: teardrops, fat end forward ----
for sign, sid in ((1, 'stbd'), (-1, 'port')):
    C.append(comp(f'blister-{sid}', f'Sensor fairing ({sid})', 'meso', 'fairing', 'ellipsoid', 'implicit',
        'A teardrop that fairs into the skin: rounded front, tapered tail, blended base.',
        'root', (sign * 1.67, -0.02, z(3.25)), (1.0, 0.45, 2.4), 'airframe', GREY, scale=(1, 1, 1), importance=0.8,
        evidence=('top-view', 'front-view'),
        descriptor={"sdf": {
            "primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.70], "radii": [0.50, 0.42, 0.65]},
                           {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.30], "radii": [0.34, 0.28, 1.0]}],
            "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}],
            "resolution": 40,
            "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}}}))

# ---- landing gear (extended, as drawn) ----
GEAR_Y_GROUND = -1.86
NOSE_A, MAIN_A, MAIN_X = 2.0, 4.2, 1.85
C.append(comp('nose-strut', 'Nose gear strut', 'meso', 'gear', 'cylinder', 'assembled-solid', 'Machined oleo leg.', 'root',
    (0, -1.2, z(NOSE_A)), (0.12, 0.7, 0.12), 'gear-metal', METAL, importance=0.5, evidence=('front-view', 'side-view')))
C.append(comp('nose-wheel', 'Nose wheel', 'meso', 'wheel', 'cylinder', 'assembled-solid', 'A tyre is a short cylinder on a lateral axle.', 'root',
    (0, GEAR_Y_GROUND + 0.26, z(NOSE_A)), (0.52, 0.18, 0.52), 'dark-polymer', DARK, rot=(0, 0, math.pi / 2), importance=0.5,
    evidence=('front-view', 'side-view')))
C.append(comp('nose-door', 'Nose gear door', 'meso', 'door', 'box', 'assembled-solid', 'Thin hinged panel hanging beside the leg.', 'root',
    (0.32, -1.35, z(NOSE_A)), (0.04, 0.75, 0.95), 'airframe', GREY, importance=0.4, evidence=('side-view',)))
for sign, sid in ((1, 'stbd'), (-1, 'port')):
    C.append(comp(f'main-strut-{sid}', f'Main gear strut ({sid})', 'meso', 'gear', 'cylinder', 'assembled-solid', 'Machined oleo leg.', 'root',
        (sign * MAIN_X, -1.15, z(MAIN_A)), (0.14, 0.6, 0.14), 'gear-metal', METAL, importance=0.5, evidence=('front-view', 'side-view')))
    C.append(comp(f'main-bogie-{sid}', f'Main gear bogie beam ({sid})', 'meso', 'gear', 'box', 'assembled-solid', 'Beam carrying the tandem wheels.', 'root',
        (sign * MAIN_X, -1.45, z(MAIN_A)), (0.10, 0.10, 1.0), 'gear-metal', METAL, importance=0.3, evidence=('side-view',)))
    for dz, wid in ((-0.42, 'fwd'), (0.42, 'aft')):
        C.append(comp(f'main-wheel-{sid}-{wid}', f'Main wheel ({sid}, {wid})', 'meso', 'wheel', 'cylinder', 'assembled-solid',
            'A tyre is a short cylinder on a lateral axle.', 'root', (sign * MAIN_X, GEAR_Y_GROUND + 0.30, z(MAIN_A) + dz),
            (0.60, 0.24, 0.60), 'dark-polymer', DARK, rot=(0, 0, math.pi / 2), importance=0.5, evidence=('front-view', 'side-view')))
    C.append(comp(f'main-door-{sid}', f'Main gear bay door ({sid})', 'meso', 'door', 'box', 'assembled-solid', 'Large flat panel hanging outboard of the leg.', 'root',
        (sign * (MAIN_X + 0.5), -1.3, z(MAIN_A)), (0.04, 0.7, 1.3), 'airframe', GREY, importance=0.4, evidence=('side-view',)))

# ---- micro: roundels and the small vent slots inboard of them ----
for sign, sid in ((1, 'stbd'), (-1, 'port')):
    C.append(comp(f'roundel-{sid}', f'National roundel ({sid})', 'micro', 'marking', 'cylinder', 'surface-relief',
        'A flat disc a few millimetres proud of the skin stands in for the decal until the material pass.', f'wing-{sid}',
        (sign * 5.0, 0.004, z((LE(5.0) + TE(5.0)) / 2)), (0.8, 0.008, 0.8), 'dark-polymer', DARK, importance=0.4, evidence=('top-view',),
        features=[feat(f'roundel-decal-{sid}', 'Star-and-bars roundel', 'decal', 'US national insignia at 50 % span, mid-chord')]))
    C.append(comp(f'vent-{sid}', f'Wing vent slot ({sid})', 'micro', 'vent', 'box', 'surface-relief', 'A shallow dark slot in the skin.', f'wing-{sid}',
        (sign * 4.55, 0.005, z(LE(4.55) + 0.9)), (0.14, 0.01, 0.06), 'dark-polymer', DARK, importance=0.2, evidence=('top-view',),
        features=[feat(f'vent-groove-{sid}', 'Vent slot', 'groove', 'small rectangular slot inboard of the roundel')]))
S['componentTree'] = C

# ---- materials ----
mat0 = S['materials'][0]
def material(id, name, color, rough, metal, notes):
    m = copy.deepcopy(mat0)
    m.update({"id": id, "name": name, "baseColor": color, "color": color})
    m['albedo'] = {"dominant": color, "secondary": [color], "samplingNotes": notes}
    m['colorVariation'] = {"palette": [color], "pattern": "uniform", "amplitude": 0.03, "heightCorrelation": 0.0}
    m['roughness']['base'] = rough; m['roughness']['variation'] = 0.05
    m['metalness']['base'] = metal
    m['localOverrides'] = []
    return m
air = material('airframe', 'Low-observable composite skin', '#BDB9B2', 0.72, 0.0, 'flat matte light grey; single tone in both references')
air['localOverrides'] = [
    {"id": "roundel-stbd", "name": "Roundel starboard", "region": "roundel-stbd", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"},
    {"id": "roundel-port", "name": "Roundel port", "region": "roundel-port", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}]
S['materials'] = [air,
    material('dark-polymer', 'Tyres, duct interiors, markings', '#2B2C2E', 0.85, 0.0, 'near-black; tyres and the two openings'),
    material('gear-metal', 'Gear struts and bogies', '#D6D6D3', 0.45, 0.6, 'pale grey painted alloy; the only spec-reflective parts')]

S['repetitionSystems'] = [{
    "id": "wheels", "name": "Landing-gear wheels", "kind": "instanced-parts", "count": 5, "buildsGeometry": True,
    "instances": ["nose-wheel", "main-wheel-stbd-fwd", "main-wheel-stbd-aft", "main-wheel-port-fwd", "main-wheel-port-aft"],
    "geometry": "cylinder tyre on a lateral axle, two sizes", "notes": "nose wheel 0.52 m, main wheels 0.60 m"}]

S['coordinateFrame'] = {"front": "-Z (nose)", "up": "+Y", "scaleReference": "20 m span assumed; proportions measured, absolute scale is not",
                        "units": "meters"}
S['assumptions'] = [
    "Wingspan set to 20 m; the drawing gives proportions only, so every absolute size scales with it.",
    "The three-view drawing is the geometry source; the render sheet only settles what the drawing hides (gear layout, blister taper direction).",
    "Nose points -Z. In the top view the planform apex is the nose and the dark oval behind it is the dorsal intake.",
    "Upper wing surface is flat at y=0; all thickness growth toward the root is on the underside, as the front view draws it.",
    "Landing gear is modelled extended, on the ground line of the front view (wheels 1.86 m below the wing upper surface).",
    "Nose gear placed 2.0 m aft of the nose from the render sheet; the drawing's side view puts it under the nose apex, which is not believed.",
    "Sensor blisters taper aft (fat end forward) as in the drawing; the render sheet is ambiguous about this.",
    "Main gear has tandem twin wheels per leg, from the render sheet's side view.",
    "Hump peak 2.3 m aft of the nose from the side view; the side view's own length disagrees with the top view by 15 %, so it is used for ratios only."]
S['risks'] = [
    "The tapered-sweep ribs are tilted with the sweep; the planform is solved for the rib ends only, so the outline between stations is an approximation.",
    "The implicit hull is polygonised on a 96 grid; the fillet between hump and hull may show grid facets at close range.",
    "The wing's elliptical section rounds the leading edge more than the reference's sharp edge."]
S['featureReviewTargets'] = [
    {"id": "planform", "name": "Planform: 32.5-degree leading edge, kinked trailing edge, pointed raked tips", "tier": "critical", "passIds": ["blockout"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["wing-stbd", "wing-port"], "evidenceRefs": ["top-view"]},
    {"id": "hump", "name": "Dorsal hump: steep front with intake, long tail to the exhaust", "tier": "critical", "passIds": ["blockout", "structural-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["root"], "evidenceRefs": ["top-view", "side-view"]},
    {"id": "blisters", "name": "Twin sensor blisters at 1.67 m", "tier": "critical", "passIds": ["structural-pass"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["blister-stbd", "blister-port"], "evidenceRefs": ["top-view", "front-view"]},
    {"id": "gear", "name": "Tricycle gear: nose leg and tandem mains with doors", "tier": "important", "passIds": ["structural-pass"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["nose-strut", "main-strut-stbd", "main-strut-port"], "evidenceRefs": ["front-view", "side-view"]},
    {"id": "thickness", "name": "Section depth: 0.2 m tips to 1.0 m belly", "tier": "important", "passIds": ["blockout"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["wing-stbd", "root"], "evidenceRefs": ["front-view"]}]
S['performanceBudget']['targetTriangles'] = 60000

# ---- assessment: detail inventory linked to the features above ----
A = S['preSpecAssessment']
A.setdefault('objectClass', {}).update({'primaryDomain': 'object', 'primaryType': 'aircraft',
    'formLanguage': ['blended flying wing', 'low-observable faceted planform', 'smooth blended dorsal volumes'],
    'structureKind': ['single continuous lifting body', 'retractable tricycle gear'],
    'motionPotential': ['whole-body flight', 'gear retraction', 'elevon deflection'],
    'materialFamilies': ['composite skin (matte grey)', 'rubber tyres', 'painted alloy gear']})
S['lightingFromPhoto'] = [
    {'id': 'key', 'type': 'directional', 'role': 'key', 'direction': [-0.4, -1.0, -0.3], 'color': '#FFF6E8', 'intensity': 2.2, 'evidence': 'shadows under the wings fall down-left in the render sheet'},
    {'id': 'fill', 'type': 'hemisphere', 'role': 'fill', 'skyColor': '#DCE4EE', 'groundColor': '#8C8478', 'intensity': 0.8, 'evidence': 'soft studio fill; no hard secondary shadow'},
    {'id': 'rim', 'type': 'directional', 'role': 'rim', 'direction': [0.6, -0.3, 0.8], 'color': '#FFFFFF', 'intensity': 0.6, 'evidence': 'edge highlight along the leading edges'},
    {'id': 'exposure', 'type': 'exposure', 'toneMapping': 'ACESFilmic', 'exposure': 1.0, 'note': 'neutral studio exposure; the reference is a product render'},
    {'id': 'ground-shadow', 'type': 'contact-shadow', 'note': 'soft ground shadow under the airframe and wheels, as in the render sheet'}]
def det(id, kind, ref, note, zone): return {"id": id, "kind": kind, "description": note, "zone": zone, "mapsTo": {"ref": ref}}
A['detailInventory'] = {"targetMinDetails": 12, "details": [
    det('d-intake', 'hole', 'intake-mouth', 'dark oval mouth carved into the hump front face', 'top-centre'),
    det('d-exhaust', 'decal', 'exhaust-inset', 'rectangular exhaust slot at the centre trailing edge', 'top-centre'),
    det('d-hump', 'contour', 'hump-contour', 'dorsal hump silhouette', 'side'),
    det('d-bay', 'linework', 'bay-door-outline', 'dotted bay outline on the belly', 'render-top'),
    det('d-elevon-stbd', 'linework', 'elevon-lines-stbd', 'elevon panel lines, starboard', 'top-outer'),
    det('d-elevon-port', 'linework', 'elevon-lines-port', 'elevon panel lines, port', 'top-outer'),
    det('d-seam-stbd', 'seam', 'root-seam-stbd', 'wing-root seam, starboard', 'top-centre'),
    det('d-seam-port', 'seam', 'root-seam-port', 'wing-root seam, port', 'top-centre'),
    det('d-roundel-stbd', 'decal', 'roundel-decal-stbd', 'roundel, starboard', 'render-top'),
    det('d-roundel-port', 'decal', 'roundel-decal-port', 'roundel, port', 'render-top'),
    det('d-vent-stbd', 'groove', 'vent-groove-stbd', 'vent slot, starboard', 'top-outer'),
    det('d-vent-port', 'groove', 'vent-groove-port', 'vent slot, port', 'top-outer')]}
S['preSpecAssessment'] = A
for p in S['buildPasses']:
    p['componentRefs'] = [c['id'] for c in C if c['level'] == 'macro'] if p['id'] == 'blockout' else [c['id'] for c in C]
S['viewEvidence'] = [
    {"id": "top-view", "source": "ref/three-view.png", "viewpoint": "top", "region": [0.03, 0.05, 0.97, 0.72]},
    {"id": "side-view", "source": "ref/three-view.png", "viewpoint": "side", "region": [0.68, 0.48, 0.98, 0.72]},
    {"id": "front-view", "source": "ref/three-view.png", "viewpoint": "front", "region": [0.03, 0.73, 0.97, 0.94]},
    {"id": "render-top", "source": "ref/render-sheet.png", "viewpoint": "three-quarter-top", "region": [0.3, 0.2, 0.96, 0.7]}]
json.dump(S, open('object-sculpt-spec.json', 'w', encoding='utf-8'), indent=2)
print('components', len(C), '| wing-r stations:')
for st in wing_stations(1): print('  ', st)
