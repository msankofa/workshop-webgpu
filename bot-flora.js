// bot-flora.js — growth over a bot-viewer arena: a ground grass field, understory plants, and
// vines hanging off the tops of walls. Built for the eco-brutalism theme (see
// references/eco-brutalism), but it is theme-agnostic: it grows whatever the active theme's
// `flora` block asks for, and a theme without one grows nothing.
//
// Everything here is ported from the environment viewer's vegetation subsystem — grass.js for
// the blade field, plants.js/plants-placement.js/plants-gpu.js for the understory — with one
// deliberate simplification: env-viewer streams chunks around a moving player across an infinite
// world, and a bot arena is a small bounded box fully in view, so this places the whole map in a
// single pass and never streams. The vines have no env-viewer counterpart and are built here.
//
// Usage (note `parent: scene`, NOT the viewer's mapRoot — see the root group inside):
//   const flora = createBotFlora({ THREE, renderer, camera, parent: scene });
//   flora.rebuild({ bounds, wallBoxes, coverBoxes, pads, groundHeight, flora: floraFor(theme) });
//   await flora.update(dt, seconds);   // per frame, before the draw (plants run a GPU cull)
//   flora.dispose();                   // on layout teardown
import {
  Fn, attribute, positionLocal, uniform, time, vec3, sin, cos,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { createGrass } from './grass.js';
import { createFloraOcclusion } from './flora-occlusion.js';
import {
  makeRng, blockerRects, padRects, buildBlockerIndex, isBlocked,
  vineAnchors, floraChunk, wallAffinityMask, inRect, BLADE_CAP, rasterizeGrowth,
} from './bot-flora-place.js';

// Ground extends a little past the layout bounds (the viewer pads its terrain sheet the same
// way), so the field has to as well or the arena sits on a visible square of bare dirt.
const FIELD_PAD = 3;
const VINE_SEGS = 6;          // ribbon segments per strand
const VINE_LEAVES = 8;        // leaf cards per strand at leafiness 1
const LEAF_RING = 5;          // boundary points per leaf; a pentagon reads round at this size
const PLANT_VARIANTS = 3;     // baked geometries per species; env-viewer uses 4 over a whole world
const PLANT_CAP = 256;        // instance slots per variant

// `clearFn(x, z)` returns true where nothing may grow. Roads use it to keep their surface bare;
// the default lets everything grow, so a host that passes nothing behaves exactly as before.
export function createBotFlora({
  THREE, renderer, camera, parent, seed = 1, onStats = () => {}, clearFn = null, occluders = null, occlusionSize = 256,
}) {
  // Flora owns its own group rather than joining the viewer's mapRoot: applyLayout tears mapRoot
  // down by disposing every geometry it finds, which would destroy the plant palette's shared
  // baked geometries — they are built once and reused across every layout.
  const root = new THREE.Group();
  parent.add(root);

  let grassTiles = [];   // one Grass mesh per tile; a single tile when flora.grassTile is 0
  // The compute path: grass-compute.js culls per frame from two painted textures. Lazily imported
  // like the plants, because it needs storage buffers the CPU path never touches.
  let computeGrass = null, computeTex = null, computePending = null;
  // Occluder depth for the GPU culls. Built only when the host names its occluders, because the
  // kernels compile the test in at creation and the mesh grass path has no use for it.
  const occlusion = occluders ? createFloraOcclusion({ renderer, scene: parent, camera, size: occlusionSize }) : null;
  if (occlusion) occlusion.markOccluders(occluders);
  function loadComputeGrass() {
    if (!computePending) computePending = import('./grass-compute.js').then((m) => m.createComputeGrass);
    return computePending;
  }
  const _frustum = new THREE.Frustum();
  const _proj = new THREE.Matrix4();
  let sunDir = null;   // world direction toward the sun, kept across rebuilds for the translucency toggle
  let vineMeshes = [];   // one per cell when flora.vineChunk > 0, else one for the map
  let plants = null;                 // the plants-gpu host, lazily imported on first use
  let plantsPending = null;          // in-flight import, so two fast rebuilds don't double-load
  let plantsKey = '';                // height-map signature the current palette was baked at
  let enabled = true;
  let rebuildToken = 0;
  // The plants host is built once but every layout has its own ground; this indirection lets the
  // host's heightAt follow the current layout without being rebuilt.
  let groundAt = () => 0;
  // Blades collapse over the last third of the view distance. grass.js has always had setFade and
  // it was never wired here, so distant blades were drawn at full size and sub-pixel wide.
  let fadeEnd = 0;
  // askedDensity vs builtDensity diverge exactly when BLADE_CAP binds, which is the only way the
  // density slider can lie. The panel reports both.
  const stats = { blades: 0, vines: 0, plants: 0, tiles: 0, askedDensity: 0, builtDensity: 0, capped: false };

  // ── vines ────────────────────────────────────────────────────────────────
  // A strand is a tapering ribbon walking down a wall face with leaf cards along it. Wind rides
  // on a per-vertex weight the same way grass.js does it: 0 where the strand meets the wall, 1 at
  // the free tip, squared in the shader so the anchor stays pinned and the tip whips.
  const uVineWind = uniform(0.12);
  const uVineSpeed = uniform(1.1);

  const vineMat = new MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
  });
  vineMat.positionNode = Fn(() => {
    const w = attribute('aWind', 'float');
    const phase = attribute('aPhase', 'float');
    const t = time.mul(uVineSpeed).add(phase);
    const amp = w.mul(w).mul(uVineWind);
    // Two axes at different rates so a strand rolls rather than swinging like a pendulum.
    return positionLocal.add(vec3(sin(t).mul(amp), 0, cos(t.mul(0.77)).mul(amp).mul(0.6)));
  })();

  function buildVines(anchors, colors, opts) {
    if (!anchors.length) return null;
    const pos = [], nrm = [], col = [], wind = [], phase = [], idx = [];
    const baseC = new THREE.Color(colors.base);
    const tipC = new THREE.Color(colors.tip);
    const stemC = new THREE.Color(0x5a3a2a);   // woody red-brown
    const c = new THREE.Color();
    const leafiness = Math.max(0, opts.leafiness ?? 1);
    const branch = Math.min(1, Math.max(0, opts.branch ?? 0));

    // One strand: ribbon + leaf cards, hanging from `origin`. `t0` is where this strand sits in
    // its parent's wind weighting, so a branch keeps swaying with the strand it grew from.
    function strand(a, origin, len, widthScale, t0, rng, depth) {
      const nodes = [];
      // Outward drift: the strand leaves the edge, bellies away from the face, then falls back
      // against it — one that hung straight down read as a wire, not a plant.
      const belly = (0.06 + rng() * 0.10) * widthScale;
      const lateral = (rng() - 0.5) * 0.25;
      for (let i = 0; i <= VINE_SEGS; i++) {
        const t = i / VINE_SEGS;
        const out = Math.sin(t * Math.PI) * belly + 0.02;
        nodes.push([
          origin[0] + a.nx * out + (a.nx !== 0 ? 0 : lateral * t),
          origin[1] - t * len,
          origin[2] + a.nz * out + (a.nz !== 0 ? 0 : lateral * t),
        ]);
      }
      const ph = (a.seed % 1000) / 159;   // ~0..2pi, so neighbouring strands sway out of step
      // `stem` routes a vertex to the woody colour instead of the leaf gradient (reference 12's
      // vines run red-brown at the stem and green at the growing tip).
      const push = (x, y, z, nx, ny, nz, mix, w, stem = false) => {
        pos.push(x, y, z); nrm.push(nx, ny, nz);
        if (stem) c.copy(stemC).lerp(tipC, mix * 0.45);
        else c.copy(baseC).lerp(tipC, mix);
        col.push(c.r, c.g, c.b);
        wind.push(w); phase.push(ph);
      };

      const halfW = 0.012 * widthScale;
      for (let i = 0; i < VINE_SEGS; i++) {
        const ta = i / VINE_SEGS, tb = (i + 1) / VINE_SEGS;
        const w0 = halfW * (1 - ta * 0.5), w1 = halfW * (1 - tb * 0.5);
        // Ribbon width runs along the wall face, i.e. perpendicular to the face normal.
        const sx = a.nx !== 0 ? 0 : 1, sz = a.nx !== 0 ? 1 : 0;
        const base = pos.length / 3;
        for (const [n, w, t] of [[nodes[i], -w0, ta], [nodes[i], w0, ta], [nodes[i + 1], w1, tb], [nodes[i + 1], -w1, tb]]) {
          push(n[0] + sx * w, n[1], n[2] + sz * w, a.nx, 0.35, a.nz, t, t0 + (1 - t0) * t, true);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }

      // Leaf cards. Ivy lies flat AGAINST the wall facing outward (reference 12), which is both
      // more faithful and what stops leaves rendering black: a horizontal card seen from below
      // gets a downward normal and no key light, whereas a wall-plane card is always viewed from
      // the lit side because the wall is opaque behind it.
      const sxL = a.nx !== 0 ? 0 : 1, szL = a.nx !== 0 ? 1 : 0;
      const nrmX = a.nx * 0.88, nrmY = 0.48, nrmZ = a.nz * 0.88;
      const leaves = Math.round(VINE_LEAVES * leafiness);
      for (let i = 0; i < leaves; i++) {
        const t = (i + 1) / (leaves + 1);
        const n = nodes[Math.min(VINE_SEGS, Math.round(t * VINE_SEGS))];
        const size = (0.035 + rng() * 0.035) * widthScale * Math.min(1.5, 0.8 + leafiness * 0.2);
        const roll = rng() * Math.PI * 2;
        const out = 0.015 + rng() * 0.02;                 // clear of the wall, and of the ribbon
        const side = (rng() - 0.5) * size * 1.6;          // scatter across the strand, not on it
        const cx0 = n[0] + sxL * side + a.nx * out;
        const cy0 = n[1];
        const cz0 = n[2] + szL * side + a.nz * out;
        const w = t0 + (1 - t0) * t;
        const mix0 = Math.min(1, t * 0.8 + 0.2);
        const base = pos.length / 3;
        push(cx0, cy0, cz0, nrmX, nrmY, nrmZ, mix0, w);   // fan centre
        for (let k = 0; k < LEAF_RING; k++) {
          const ang = roll + (k / LEAF_RING) * Math.PI * 2;
          // Mild lobing so the outline reads as a rounded leaf rather than a regular polygon.
          const r = size * (1 + 0.2 * Math.sin(ang * 2));
          push(cx0 + sxL * Math.cos(ang) * r, cy0 + Math.sin(ang) * r * 1.15, cz0 + szL * Math.cos(ang) * r,
            nrmX, nrmY, nrmZ, mix0, w);
        }
        for (let k = 0; k < LEAF_RING; k++) idx.push(base, base + 1 + k, base + 1 + ((k + 1) % LEAF_RING));
      }

      // Fork: a shorter, thinner strand hanging from a node partway down. One level only —
      // branches of branches double the geometry for something nobody can pick out at this size.
      if (depth === 0 && rng() < branch) {
        const at = 0.3 + rng() * 0.35;
        const n = nodes[Math.max(1, Math.round(at * VINE_SEGS))];
        strand(a, n, len * (0.35 + rng() * 0.3), widthScale * 0.72, at, rng, 1);
      }
    }

    for (const a of anchors) strand(a, [a.x, a.y, a.z], a.len, 1, 0, makeRng(a.seed), 0);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aWind', new THREE.BufferAttribute(new Float32Array(wind), 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(phase), 1));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, vineMat);
    mesh.castShadow = false;      // strands are thin enough that their shadows are pure noise
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  // ── understory plants ────────────────────────────────────────────────────
  // plants-gpu.js runs a compute cull into an indirect draw, so it needs the renderer and a
  // camera. Imported lazily: a theme with no plants never pays the module load or the buffers.
  async function loadPlantMods() {
    if (!plantsPending) {
      plantsPending = Promise.all([
        import('./plants.js'), import('./plants-placement.js'), import('./plants-gpu.js'),
      ]).then(([p, pl, gpu]) => ({
        createPlantPalette: p.createPlantPalette,
        plantPlacementRecords: pl.plantPlacementRecords,
        createPlantsGPU: gpu.createPlantsGPU,
      }));
    }
    return plantsPending;
  }

  // Per-species height is baked into the palette geometry, so a change means a whole new host.
  // Keyed on the height map so a rebuild that didn't touch it reuses what's already there.
  async function ensurePlants(heightScale, cap = PLANT_CAP, cull = 90) {
    const mods = await loadPlantMods();
    const key = JSON.stringify([heightScale || {}, cap, cull]);
    if (plants && plantsKey === key) return plants;
    if (plants) {
      for (const m of plants.gpu.meshes) { m.parent?.remove(m); m.geometry.dispose(); m.material.dispose(); }
      for (const g of plants.palette.variants) g.dispose();
    }
    const palette = mods.createPlantPalette({
      variantsPerSpecies: PLANT_VARIANTS, masterSeed: seed, heightScale,
    });
    const gpu = mods.createPlantsGPU({
      renderer, camera, palette, heightAt: (x, z) => groundAt(x, z), occlusion: occlusion ? occlusion.state : null,
      cullRadius: cull, cullStart: cull * 0.72, capPerVariant: cap,
      variationStrength: 1.0, windStrength: 0.35, windSpeed: 1.0,
    });
    plants = { gpu, palette, plantPlacementRecords: mods.plantPlacementRecords };
    plantsKey = key;
    return plants;
  }

  // Per-species density reweights selection, so it rides on a copy of the palette's own table.
  function weightedSpeciesTable(tags, speciesDensity) {
    if (!speciesDensity) return tags;
    return tags.map((t) => {
      const k = speciesDensity[t.key];
      return k > 0 && k !== 1 ? { ...t, tag: { ...t.tag, density: t.tag.density * k } } : t;
    });
  }

  function clearPlants() {
    if (!plants) return;
    plants.gpu.clearChunk('arena');
    for (const m of plants.gpu.meshes) m.visible = false;
    stats.plants = 0;
  }

  // ── rebuild ──────────────────────────────────────────────────────────────
  // Called once per layout. `wallBoxes`/`coverBoxes` are the RENDERED boxes (post
  // boxTransformOnTerrain), so vines hang off a wall's real top on a hillside.
  function rebuild({ bounds, wallBoxes = [], coverBoxes = [], vineBoxes = [], pads = [], groundHeight, flora }) {
    // Snapshot the token BEFORE any await point below, so the async plant placement can tell
    // whether it is still the current layout's placement or a superseded one.
    const token = ++rebuildToken;
    groundAt = groundHeight;
    disposeGrowth();
    if (!enabled || !flora) return;

    const solid = [...wallBoxes, ...coverBoxes];
    const rects = [
      ...blockerRects(solid, flora.clearance),
      // Pads get no extra clearance: they are already generous, and widening them further
      // strips growth out of exactly the open ground the arena is fought over.
      ...padRects(pads, 0),
    ];
    const padded = {
      minX: bounds.minX - FIELD_PAD, maxX: bounds.maxX + FIELD_PAD,
      minZ: bounds.minZ - FIELD_PAD, maxZ: bounds.maxZ + FIELD_PAD,
    };
    const index = buildBlockerIndex(rects, padded, 2);
    const cx = (padded.minX + padded.maxX) / 2, cz = (padded.minZ + padded.maxZ) / 2;
    const extent = Math.max(padded.maxX - padded.minX, padded.maxZ - padded.minZ);

    // grass: the field is cut into square tiles so the renderer can frustum-cull the ones the
    // camera is not looking at; grassTile 0 keeps the old single mesh. createGrass scatters around
    // the origin, so each tile carries its own offset and the callbacks map back to world.
    const cap = flora.bladeCap > 0 ? flora.bladeCap : BLADE_CAP;
    stats.askedDensity = flora.grassDensity;
    const mode = flora.grassMode === 'compute' ? 'compute' : 'mesh';
    stats.grassMode = mode;
    if (mode === 'compute') buildComputeGrass({ token, padded, index, groundHeight, flora, extent });
    const tile = flora.grassTile > 0 ? Math.min(flora.grassTile, extent) : extent;
    const nTiles = Math.max(1, Math.ceil(extent / tile));
    // Budget by the ground that can actually grow, not the whole square: each tile is sampled on
    // a coarse grid against the same rejections the blades face, so a tile under a building or
    // outside the host's clearFn asks for nothing and the cap binds only on real lawn.
    const grow = new Float32Array(nTiles * nTiles);
    let growArea = 0;
    const GRID = 12;
    for (let tz = 0; tz < nTiles; tz++) for (let tx = 0; tx < nTiles; tx++) {
      const tcx = cx - extent / 2 + (tx + 0.5) * tile, tcz = cz - extent / 2 + (tz + 0.5) * tile;
      let hit = 0;
      for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
        const wx = tcx + ((i + 0.5) / GRID - 0.5) * tile, wz = tcz + ((j + 0.5) / GRID - 0.5) * tile;
        if (wx < padded.minX || wx > padded.maxX || wz < padded.minZ || wz > padded.maxZ) continue;
        if (clearFn && clearFn(wx, wz)) continue;
        if (!isBlocked(index, wx, wz)) hit++;
      }
      grow[tz * nTiles + tx] = hit / (GRID * GRID);
      growArea += grow[tz * nTiles + tx] * tile * tile;
    }
    const wanted = flora.grassDensity * growArea;
    const scale = wanted > cap ? cap / wanted : 1;
    if (mode === 'mesh') stats.growArea = growArea;   // the compute path reports its own area and never caps
    if (mode === 'mesh') stats.capped = wanted > cap;
    if (mode === 'mesh') stats.builtDensity = flora.grassDensity * scale;
    if (mode === 'mesh') stats.blades = 0;
    if (mode === 'mesh' && wanted > 0) for (let tz = 0; tz < nTiles; tz++) for (let tx = 0; tx < nTiles; tx++) {
      const tcx = cx - extent / 2 + (tx + 0.5) * tile, tcz = cz - extent / 2 + (tz + 0.5) * tile;
      // Asked per tile over the tile's growable share; createGrass scatters the whole tile and
      // the rejections thin it back to that share, so the request is inflated by 1 / fraction.
      const f = grow[tz * nTiles + tx];
      if (f <= 0) continue;
      const tileCount = Math.round(flora.grassDensity * scale * tile * tile);
      if (tileCount <= 0) continue;
      const g = createGrass({
        seed: seed + tx * 131 + tz * 7919, count: tileCount, size: tile,
        bladeHeight: flora.grassHeight, heightVariation: flora.grassHeightVar,
        baseColor: flora.grassBase, tipColor: flora.grassTip, bladeStyle: flora.grassStyle,
        look: flora.grassLook || null,
        lighting: flora.grassLighting || 'standard',
        heightFn: (x, z) => groundHeight(x + tcx, z + tcz),
        acceptFn: (x, z) => {
          const wx = x + tcx, wz = z + tcz;
          // Outside the padded rectangle is the square's overspill, not ground (see bladeBudget).
          if (wx < padded.minX || wx > padded.maxX || wz < padded.minZ || wz > padded.maxZ) return false;
          if (clearFn && clearFn(wx, wz)) return false;
          return !isBlocked(index, wx, wz);
        },
      });
      // buildGeometry trims its arrays to the blades actually placed, so this is the count that
      // survived the blockers, not the count that was asked for.
      const placed = (g.geometry.getAttribute('position')?.count || 0) / 5;
      if (placed === 0) { g.dispose(); continue; }
      g.position.set(tcx, 0, tcz);
      g.userData.blades = placed;
      if (nTiles > 1) {
        g.geometry.computeBoundingSphere();
        g.geometry.boundingSphere.radius += flora.grassHeight * 2 + 0.5;   // wind sway headroom
        g.frustumCulled = true;
      }
      if (fadeEnd > 0) g.setFade(fadeEnd * 0.65, fadeEnd);
      if (sunDir) g.setSunDir(sunDir);
      root.add(g);
      grassTiles.push(g);
      stats.blades += placed;
    }
    stats.tiles = grassTiles.length;

    // vines off the wall tops
    // Slabs are vine hosts but not ground keep-outs, which is why they arrive as their own list.
    const anchors = vineAnchors([...wallBoxes, ...vineBoxes], {
      density: flora.vineDensity, length: flora.vineLength, clump: flora.vineClump, seed: seed + 7717,
    });
    // Chunked by anchor position so a cell of strands behind the camera is one skipped draw. The
    // bounding sphere is padded by the strand length: a strand hangs below its anchor and sways.
    const cell = flora.vineChunk > 0 ? flora.vineChunk : 0;
    const groups = new Map();
    for (const a of anchors) {
      const key = cell ? `${Math.floor(a.x / cell)}:${Math.floor(a.z / cell)}` : 'all';
      let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push(a);
    }
    for (const group of groups.values()) {
      const m = buildVines(group, { base: flora.grassBase, tip: flora.grassTip },
        { leafiness: flora.vineLeafiness, branch: flora.vineBranch });
      if (!m) continue;
      m.geometry.boundingSphere.radius += flora.vineLength * (1 + 0.5) + 0.5;
      m.frustumCulled = cell > 0;
      m.userData.strands = group.length;
      root.add(m);
      vineMeshes.push(m);
    }
    stats.vines = anchors.length;
    stats.vineChunks = vineMeshes.length;

    // After the meshes exist, so the new grass field picks up the theme's wind rather than
    // grass.js's generator default.
    setWind(flora.wind);

    // understory plants
    if (flora.plantDensity > 0) {
      ensurePlants(flora.speciesHeight, flora.plantCap > 0 ? flora.plantCap : PLANT_CAP, flora.plantCullRadius > 0 ? flora.plantCullRadius : 90).then((p) => {
        // A newer rebuild may have landed while the import was in flight; its own call will
        // place the records, so this one must not write a stale chunk over them.
        if (!enabled || rebuildToken !== token) return;
        const chunk = floraChunk(bounds, FIELD_PAD);
        const records = p.plantPlacementRecords([chunk], {
          masterSeed: seed,
          // The arena has no water, and plants-placement gates on `waterLevel + shoreMargin`;
          // an undefined waterLevel would make that gate NaN and reject every plant.
          waterLevel: -1e6,
          plantDensity: flora.plantDensity,
          plantSpeciesTable: weightedSpeciesTable(p.palette.speciesTags, flora.speciesDensity),
          // Plants mass against the concrete rather than scattering evenly (see the references).
          // This only removes, so flora.plantDensity is the NEAR-WALL density, not the average.
          densityAt: wallAffinityMask(index, flora.plantReach, flora.plantOpenFloor),
          // Explicit clump size. The default is `chunk.size * 0.16`, which on one arena-sized
          // chunk is metres across — at that radius a dozen clumps overlap into flat scatter, so
          // the clumping silently does nothing. An arena wants clumps you can see the edge of.
          clumpRadius: flora.plantClumpRadius, clumpChildrenTarget: 5,
          // Light noise gating on top; the wall mask is now doing the structural work, so this
          // only needs to break up the remainder rather than carry the whole pattern.
          clusterStrength: 0.35, clusterScale: 9,
        }, groundHeight, null)
          // Two separate rejections, and both are needed: OFF THE MAP (the square placement area
          // overspills the rectangular arena) and INSIDE GEOMETRY. `isBlocked` cannot answer the
          // first — outside the index it correctly reports nothing blocking, because out there
          // is nothing at all.
          .filter((r) => inRect(padded, r.x, r.z) && !isBlocked(index, r.x, r.z)
            && !(clearFn && clearFn(r.x, r.z)));
        p.gpu.setChunk('arena', records);
        for (const m of p.gpu.meshes) { m.visible = true; if (!m.parent) root.add(m); }
        stats.plants = records.length;
        onStats();   // placement is async; the host's readout would otherwise lag a rebuild
      }).catch(() => { /* plants are decoration; a failed import must not take the map down */ });
    }
  }

  // Live wind, no rebuild — matches grass.js's own setWind contract. The three systems sway at
  // different amplitudes (a vine strand is held by the wall at one end, a blade is not), so
  // `strength` scales each one's own tuned value rather than setting all three to it. Declared
  // here rather than inline on the returned object because rebuild() calls it too: a rebuild
  // replaces the grass mesh, which resets its wind to the generator default.
  function setWind(strength) {
    const s = Math.max(0, strength) / 0.7;
    for (const g of grassTiles) g.setWind(strength);
    if (computeGrass) computeGrass.setWind(strength);
    uVineWind.value = 0.12 * s;
    if (plants) plants.gpu.setWindStrength(0.35 * s);
  }

  // Density and height textures from the same rules the mesh path applies per blade, then a
  // compute field over the whole padded rect: radius covers it all, so nothing streams, and the
  // per-frame cull is the only thing deciding what exists.
  function buildComputeGrass({ token, padded, index, groundHeight, flora, extent }) {
    const raster = rasterizeGrowth({ padded, texel: flora.grassTexel > 0 ? flora.grassTexel : 0.25, clearFn, index, groundHeight });
    stats.growArea = raster.growArea;
    stats.capped = false;
    stats.builtDensity = flora.grassDensity;
    // Nearest filtering: a bilinear density texel would ramp blades across a planter rim, and a
    // bilinear height would slope them up its wall.
    const mk = (arr) => {
      const t = new THREE.DataTexture(arr, raster.res, raster.res, THREE.RedFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    };
    const tex = { density: mk(raster.density), height: mk(raster.height) };
    loadComputeGrass().then((createComputeGrass) => {
      if (!enabled || rebuildToken !== token) { tex.density.dispose(); tex.height.dispose(); return; }
      computeTex = tex;
      // The radius is a view radius, not the field: the compute grass culls by distance, so a
      // whole-field radius would keep every blade alive and size the buffer past the 128 MB
      // storage binding limit (the field at 1 m cells and 64/m² asked for 252 MB).
      const radius = Math.max(4, flora.grassRadius > 0 ? flora.grassRadius : 60);
      computeGrass = createComputeGrass({
        renderer, camera, occlusion: occlusion ? occlusion.state : null,
        density: flora.grassDensity, radius, maxRadius: radius, maxInstances: 2_000_000,
        cellSize: 1, Kmax: Math.max(64, Math.ceil(flora.grassDensity)),
        cullStart: radius * 0.7,
        bladeHeight: flora.grassHeight / 0.8, bladeStyle: flora.grassStyle, look: flora.grassLook || null,
        heightTex: tex.height, heightTexBounds: raster.bounds,
        densityTex: tex.density, densityTexBounds: raster.bounds,
        waterLevel: -1e6,   // the arena has no water gate; the density texture is the only mask
      });
      computeGrass.setColors(flora.grassBase, flora.grassTip);
      computeGrass.setWind(flora.wind);
      if (sunDir) computeGrass.setSunDir(sunDir);
      root.add(computeGrass.mesh);
      stats.blades = Math.round(flora.grassDensity * raster.growArea);   // asked; readBladeCount() says drawn
      onStats();
    });
  }

  function disposeGrowth() {
    if (computeGrass) { root.remove(computeGrass.mesh); computeGrass.dispose(); computeGrass = null; }
    if (computeTex) { computeTex.density.dispose(); computeTex.height.dispose(); computeTex = null; }
    for (const g of grassTiles) { root.remove(g); g.dispose(); }
    grassTiles = [];
    stats.tiles = 0;
    for (const m of vineMeshes) { root.remove(m); m.geometry.dispose(); }
    vineMeshes = [];
    stats.vineChunks = 0;
    clearPlants();
    stats.blades = 0; stats.vines = 0;
  }

  return {
    stats,
    rebuild,
    setWind,
    // grass-look.js toggles (windDir/curl/translucency/rootShade/coverage); live, no rebuild.
    setLook(partial) { for (const g of grassTiles) g.setLook(partial); if (computeGrass) computeGrass.setLook(partial); },
    setSunDir(v) { sunDir = v; for (const g of grassTiles) g.setSunDir(v); if (computeGrass) computeGrass.setSunDir(v); },

    setEnabled(on) {
      enabled = !!on;
      root.visible = enabled;
    },

    // What the frustum leaves of the grass tiles right now, and what the last plant cull kept.
    // The frustum test mirrors the renderer's own (bounding sphere against the camera planes).
    cullStats(camera) {
      _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_proj);
      let tilesVisible = 0, bladesVisible = 0, bladesTotal = 0;
      for (const g of grassTiles) {
        const n = g.userData.blades || 0;
        bladesTotal += n;
        if (!g.frustumCulled || _frustum.intersectsObject(g)) { tilesVisible++; bladesVisible += n; }
      }
      let vineChunksVisible = 0, vinesVisible = 0;
      for (const m of vineMeshes) {
        if (!m.frustumCulled || _frustum.intersectsObject(m)) { vineChunksVisible++; vinesVisible += m.userData.strands || 0; }
      }
      return {
        mode: stats.grassMode, tilesVisible, tilesTotal: grassTiles.length, bladesVisible, bladesTotal,
        vines: stats.vines, vinesVisible, vineChunks: vineMeshes.length, vineChunksVisible, plantsTotal: stats.plants,
      };
    },
    async plantsVisible() { return plants && stats.plants > 0 ? plants.gpu.readSurvivors() : 0; },
    // Compute path only: blades the last cull kept. The mesh path answers through cullStats.
    async grassVisible() { return computeGrass ? computeGrass.readBladeCount() : null; },
    // Occlusion: re-mark after a layout rebuild (new meshes), toggle live, read whether it exists.
    markOccluders(root) { return occlusion ? occlusion.markOccluders(root) : 0; },
    setOcclusionEnabled(on) { if (occlusion) occlusion.setEnabled(on); },
    get occlusion() { return occlusion ? occlusion.state : null; },

    // Live, no rebuild — the host calls this when the view-distance slider moves.
    setViewDistance(d) {
      fadeEnd = Math.max(0, d);
      if (fadeEnd > 0) for (const g of grassTiles) g.setFade(fadeEnd * 0.65, fadeEnd);
      // the compute path fades at 0.7 of its own radius; the view distance does not reach it
    },

    // Awaited by the caller: the plant cull is a compute pass whose results this frame's draw
    // reads, and an unawaited compute races the draw (env-viewer hit exactly this with terrain).
    async update(dt, seconds) {
      if (!enabled) return;
      if (occlusion && occlusion.state.enabled && (computeGrass || (plants && stats.plants > 0))) occlusion.update();
      for (const g of grassTiles) g.update(seconds);
      if (computeGrass) await computeGrass.update(seconds);
      if (plants && stats.plants > 0) await plants.gpu.update();
    },

    dispose() {
      disposeGrowth();
      if (plants) { for (const m of plants.gpu.meshes) m.parent?.remove(m); plants = null; }
      vineMat.dispose();
      if (occlusion) occlusion.dispose();
      parent.remove(root);
    },
  };
}
