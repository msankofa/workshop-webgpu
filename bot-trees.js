// bot-trees.js — trees over a bot-viewer arena: automatic scatter, hand-placed and painted trees,
// species drawn at random or from a chosen tree-viewer family.
//
// Ported from the environment viewer's forest subsystem (trees.js generator, forest-palette.js
// baker, forest-placement.js scatter) with the same simplification bot-flora.js makes: env-viewer
// streams chunks around a moving player, a bot arena is a bounded box fully in view, so this places
// the whole map in one pass and never streams.
//
// Two things here are not in env-viewer's version:
//   - Trunks collide. Canopies do not. A rendered tree is 1,112-13,674 triangles (measured
//     2026-08-15) and createMapCollider THROWS above 250k, so render geometry in the BVH would cap
//     the forest near 27 trees. Each tree instead contributes one ~16-triangle cylinder to a
//     separate proxy mesh the host hands the collider as an `extraRoot`.
//   - The palette is cached across layout rebuilds. Baking all six families costs ~432ms (measured),
//     ten times a flora rebuild, so it must not run every time a wall moves.
//
// Usage (note `parent: scene`, NOT the viewer's mapRoot — see the root group below):
//   const trees = createBotTrees({ THREE, parent: scene, createTree });
//   trees.rebuild({ bounds, wallBoxes, coverBoxes, pads, groundHeight, speciesTable, settings });
//   createMapCollider(mapRoot, { extraRoots: [trees.colliderRoot] });
//   trees.navRects();      // feed into buildNavGrid's `blockers`
//   trees.dispose();
import { Fn, positionLocal, uniform, time, vec3, sin } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { createForestPalette } from './forest-palette.js';
import { placementRecords } from './forest-placement.js';
import {
  blockerRects, padRects, buildBlockerIndex, isBlocked, inRect, floraChunk, makeRng,
} from './bot-flora-place.js';
import {
  TRUNK_SIDES, trunkRadiusFor, trunkHeightFor, trunkNavRects, stampCluster,
  resolvePlacedRecords, tagAutoRecords, serializePlaced, nearestPlacedIndex,
  trunkTriangleCost, maxTreesForBudget, treeBudget, TREE_CAP,
} from './bot-trees-place.js';

const FIELD_PAD = 3;          // matches bot-flora: the arena's ground extends past the layout bounds
const TRUNK_CLEARANCE = 0.5;  // metres a trunk keeps off a wall face, so a canopy does not eat it

export const TREE_DEFAULTS = {
  enabled: false,             // off by default: an existing map should not sprout a forest on load
  // Trees per 100 m^2 of arena, not an absolute count. An absolute meant a different forest on
  // every map size, and it was never the number of trees you got either: placement runs over a
  // square covering the bounds and everything outside the arena or inside a wall is dropped after.
  density: 1.2,
  seed: 1,
  placement: 'clustered',     // 'random' | 'ring' | 'clustered' | 'scattered'
  clusterSize: 5,             // trees per clump, when placement is 'clustered'
  clusterSpread: 0.14,        // clump radius as a fraction of the arena extent
  // METRES, not a multiplier. Each species is measured at bake time and scaled to hit this, because
  // the stock presets range from 19.7 to 96.2 units tall and one multiplier cannot serve both.
  // A flat multiplier was also a trap: with a family speciesTable, sizeFor() uses the species'
  // own sizeRange and IGNORES maxSize, so a size knob routed through maxSize did nothing at all
  // and every tree rendered at full ez-tree scale.
  height: 7,
  sizeVar: 0.35,
  variants: 2,                // baked geometries per species; every extra one is 2 more draw calls
  // Both are MULTIPLIERS on whatever each species authored, never absolutes. forest-palette does
  // `count = params.leafCount ?? sp.leaves.count`, so passing an absolute silently flattens every
  // species to one value — pine's 21/30/18 and ash's 30/16/10 all became the same number, which
  // is most of what makes a pine read as a pine.
  leafDensity: 1,
  leafSize: 1,
  wind: 0.35,
  collide: true,              // trunks stop bullets and capsules
  blockNav: true,             // bots route around trunks
  followTheme: false,         // read density from the active theme instead of these settings
  familyIds: null,            // null = every family (random across all); an array = family-specific
};

// `clearFn(x, z)` returns true where no tree may stand — roads pass their own surface test through
// it, the same way they do for flora. Omitting it lets trees grow anywhere the walls allow.
export function createBotTrees({ THREE, parent, createTree, onStats = () => {}, clearFn = null }) {
  // Trees own their group rather than joining mapRoot: applyLayout tears mapRoot down by disposing
  // every geometry it finds, and the baked palette is far too expensive to rebuild per layout.
  const root = new THREE.Group();
  parent.add(root);

  // Detached on purpose. The collider traverses whatever roots it is handed and calls
  // updateMatrixWorld itself, so these proxies never need to be in the scene — and must not be,
  // or the arena fills with invisible cylinders that still cost draw calls.
  const colliderRoot = new THREE.Group();
  colliderRoot.matrixAutoUpdate = false;

  const windUniform = uniform(TREE_DEFAULTS.wind);

  let palette = null;
  let paletteKey = '';
  let speciesHeights = [];      // natural height per species, measured off the baked geometry
  let texSet = null;            // authored bark/leaf textures, or null until they finish loading
  let meshes = [];              // one InstancedMesh per (variant, branches|leaves) that has instances
  let trunkMesh = null;
  let records = [];             // live trees, auto and placed together
  let placed = [];              // hand-placed only, the serializable half
  let speciesTable = [];
  let settings = { ...TREE_DEFAULTS };
  let bounds = null;
  let blockerIndex = null;
  let groundAt = () => 0;
  let colliderVersion = 0;
  let branchMat = null;
  let leafMat = null;

  // ─── materials ────────────────────────────────────────────────────────────

  // Metalness stays near zero: bot-viewer runs with IBL off by default, and a metallic material
  // with no environment to reflect renders black (bot-viewer-visuals.js:486-489).
  function ensureMaterials() {
    if (branchMat) return;
    branchMat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
    leafMat = new MeshStandardNodeMaterial({
      vertexColors: true, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide,
    });
    // Canopy sway, scaled by height off the trunk base so the trunk stays planted. Uses only the
    // TSL nodes bot-flora.js already imports in this build.
    bindTextures();
    leafMat.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const lift = p.y.mul(0.02).mul(windUniform);
      return p.add(vec3(sin(time.mul(1.3).add(p.y.mul(0.35))).mul(lift), 0, sin(time.mul(0.9).add(p.x.mul(0.3))).mul(lift)));
    })();
  }

  // Bark and leaf maps onto the live materials. Separate from the bake because a texture can
  // arrive after the palette is already built, and rebinding is free where rebaking is not.
  // vertexColors stays on: the baked flat species colour tints the map, exactly as env-viewer does.
  function bindTextures() {
    if (!branchMat || !leafMat) return;
    const ready = texSet && texSet.ready;
    branchMat.map = ready ? (texSet.barkMap || null) : null;
    branchMat.normalMap = ready ? (texSet.barkNormalMap || null) : null;
    leafMat.map = ready ? (texSet.leafMap || null) : null;
    // Leaf cards are cut out by alpha, not blended: transparent:true would sort them per-draw and
    // an instanced canopy has no meaningful sort order.
    leafMat.alphaTest = ready ? (texSet.leafAlphaTest ?? 0.5) : 0;
    branchMat.needsUpdate = true;
    leafMat.needsUpdate = true;
  }

  // Authored textures load asynchronously (four leaf PNGs into a 2x2 atlas canvas, plus two bark
  // maps). Until they land the palette bakes 'simple' silhouette leaves; when they arrive the key
  // changes and the next rebuild re-bakes as atlas 'quad' cards.
  function setTextureSource(next) {
    if (texSet && texSet !== next) texSet.dispose?.();
    texSet = next;
    bindTextures();
  }

  // ─── palette ──────────────────────────────────────────────────────────────

  // Rebaking is the expensive step, so it is keyed on everything the bake actually reads. A layout
  // change touches none of these, which is the whole point.
  // texSet is in the key because it flips the leaves between 'simple' silhouettes and atlas
  // 'quad' cards, which is baked geometry, not a material swap.
  function keyFor(table, s) {
    return [table.map(sp => sp._tag?.id).join('|'), s.variants, s.leafDensity, s.leafSize, s.seed,
      texSet?.mode ?? 'none', texSet?.ready ? 1 : 0].join('::');
  }

  function ensurePalette() {
    const key = keyFor(speciesTable, settings);
    if (palette && key === paletteKey) return;
    disposePalette();
    if (!speciesTable.length) { palette = null; paletteKey = ''; speciesHeights = []; return; }
    const t0 = (globalThis.performance || Date).now();
    // Scaled into a COPY of the table, leaving params.leafCount undefined so leafOptsFor falls
    // through to each species' own count. Copied because speciesTable is shared with placement and
    // with the host's panel; mutating it here would leak the multiplier into both.
    const density = Math.max(0.05, settings.leafDensity ?? 1);
    const bakeTable = speciesTable.map(sp => ({
      ...sp,
      leaves: { ...sp.leaves, count: Math.max(1, Math.round((sp.leaves?.count ?? 10) * density)) },
    }));
    palette = createForestPalette({
      createTree,
      params: {
        speciesTable: bakeTable,
        leafSize: settings.leafSize,
        leafShadowPct: 0,          // the shadow proxy geometry is not used here; see buildMeshes
      },
      masterSeed: settings.seed,
      variantsPerSpecies: Math.max(1, Math.round(settings.variants)),
      texSet: texSet && texSet.ready ? texSet : null,
    });
    measureSpecies();
    bindTextures();
    paletteKey = key;
    onStats({ bakeMs: Math.round((globalThis.performance || Date).now() - t0), variants: palette.variants.length });
  }

  // Natural height per species, from the baked geometry rather than from length[0]: children reach
  // well past the trunk, so length[0] understates the real height by roughly half.
  function measureSpecies() {
    speciesHeights = [];
    if (!palette) return;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const variant of palette.variants) {
      const s = variant.speciesIdx;
      let hi = -Infinity, lo = Infinity;
      for (const geo of [variant.branches, variant.leaves]) {
        if (!geo?.attributes.position.count) continue;
        geo.computeBoundingBox();
        box.copy(geo.boundingBox);
        hi = Math.max(hi, box.max.y); lo = Math.min(lo, box.min.y);
      }
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
      const h = Math.max(0.01, hi - lo);
      // Variants of one species differ; the largest is what the eye reads as the tree's height.
      speciesHeights[s] = Math.max(speciesHeights[s] ?? 0, h);
      void v;
    }
  }

  // The one place the target height turns into a scale. Baked into the record so meshes, trunk
  // proxies and nav rects all read a single number and cannot disagree.
  function normalizeScales(recs) {
    let bad = 0;
    for (const r of recs) {
      const natural = speciesHeights[r.speciesIdx];
      const norm = natural > 0 ? Math.max(0.1, settings.height) / natural : 1;
      // Explicit rather than `r.scale || 1`: NaN is falsy, so that idiom silently rewrote a
      // poisoned scale as 1 and turned a real bug into trees that merely looked inconsistent.
      if (!Number.isFinite(r.scale)) { bad++; r.scale = 1; }
      r.scale *= norm;
    }
    if (bad) console.warn(`[bot-trees] ${bad} placement records had a non-finite scale; check the params passed to placementRecords`);
    return recs;
  }

  function disposePalette() {
    if (!palette) return;
    for (const v of palette.variants) {
      v.branches?.dispose(); v.leaves?.dispose(); v.shadow?.dispose(); v.leavesCoarse?.dispose();
    }
    palette = null;
    paletteKey = '';
  }

  // ─── placement ────────────────────────────────────────────────────────────

  function paddedBounds() {
    return {
      minX: bounds.minX - FIELD_PAD, maxX: bounds.maxX + FIELD_PAD,
      minZ: bounds.minZ - FIELD_PAD, maxZ: bounds.maxZ + FIELD_PAD,
    };
  }

  // True where a tree may stand. Shared by the auto scatter and by every manual click, so a painted
  // tree can never land somewhere the scatter would have refused.
  function canPlantAt(x, z) {
    if (!bounds) return false;
    if (!inRect(paddedBounds(), x, z) || isBlocked(blockerIndex, x, z)) return false;
    return !(clearFn && clearFn(x, z));
  }

  function scatter() {
    if (!settings.enabled || !speciesTable.length || !bounds) return [];
    const chunk = floraChunk(bounds, FIELD_PAD, 'arena');
    const raw = placementRecords([chunk], {
      masterSeed: settings.seed,
      count: treeBudget(paddedBounds(), settings.density),
      placement: settings.placement,
      clusterSize: settings.clusterSize,
      clusterSpread: settings.clusterSpread,
      // maxSize only applies when a species has no sizeRange of its own; the ez families all do.
      // skew and varPattern are NOT optional despite looking it: sizeFor computes
      // Math.exp(p.skew * 1.5), and an undefined skew makes that NaN, which poisons every scale.
      maxSize: 1,
      skew: 0,
      varPattern: 'random',
      sizeVar: settings.sizeVar,
      targetChunkCount: 1,
      speciesTable,
      // The bot arena has no water, but forest-placement still computes waterLevel + shoreMargin
      // and rejects anything below it. Leave either undefined and that sum is NaN, every
      // `height >= NaN` is false, and the forest comes out silently EMPTY.
      waterLevel: -1e6,
      shoreMargin: 0,
    }, groundAt);
    return tagAutoRecords(raw.filter(r => canPlantAt(r.x, r.z)), speciesTable, groundAt);
  }

  // ─── meshes ───────────────────────────────────────────────────────────────

  function clearMeshes() {
    for (const m of meshes) { root.remove(m); m.dispose?.(); }
    meshes = [];
  }

  function buildMeshes() {
    clearMeshes();
    if (!palette || !records.length) return;
    ensureMaterials();
    const V = palette.variantsPerSpecies;
    // Bucket by the variant each tree draws, so one InstancedMesh covers every tree sharing a
    // geometry. A per-tree Mesh would repeat exactly the mistake wall instancing fixed.
    const buckets = new Map();
    for (const r of records) {
      const vi = r.speciesIdx * V + (hashVariant(r) % V);
      let list = buckets.get(vi);
      if (!list) { list = []; buckets.set(vi, list); }
      list.push(r);
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [vi, list] of buckets) {
      const variant = palette.variants[vi];
      if (!variant) continue;
      for (const kind of ['branches', 'leaves']) {
        const geo = variant[kind];
        if (!geo || !geo.attributes.position.count) continue;
        const mesh = new THREE.InstancedMesh(geo, kind === 'branches' ? branchMat : leafMat, list.length);
        mesh.castShadow = kind === 'branches';   // leaf-card shadows are noisy and cost a lot
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          pos.set(r.x, r.y, r.z);
          q.setFromAxisAngle(up, r.yaw || 0);
          scl.setScalar(r.scale || 1);
          mesh.setMatrixAt(i, m4.compose(pos, q, scl));
        }
        mesh.instanceMatrix.needsUpdate = true;
        root.add(mesh);
        meshes.push(mesh);
      }
    }
  }

  // Which baked variant a tree draws. Derived from the record so it is stable across rebuilds
  // rather than reshuffling every time the map changes.
  function hashVariant(r) {
    const s = Math.abs(Math.round(r.x * 73856093) ^ Math.round(r.z * 19349663));
    return s >>> 0;
  }

  // ─── collision proxies ────────────────────────────────────────────────────

  function clearTrunks() {
    if (!trunkMesh) return;
    colliderRoot.remove(trunkMesh);
    trunkMesh.geometry.dispose();
    trunkMesh.material.dispose();
    trunkMesh = null;
  }

  function buildTrunks() {
    clearTrunks();
    if (!settings.collide || !records.length) { colliderVersion++; return; }
    // One open cylinder, unit height and radius, scaled per instance. Open-ended because a capsule
    // and a bullet both meet a trunk from the side; caps would cost 12 more triangles per tree.
    const geo = new THREE.CylinderGeometry(1, 1, 1, TRUNK_SIDES, 1, true);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, records.length);
    mesh.visible = false;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const sp = speciesTable[r.speciesIdx];
      if (!sp) { scl.setScalar(0); mesh.setMatrixAt(i, m4.compose(pos.set(0, -9999, 0), q, scl)); continue; }
      const rad = trunkRadiusFor(sp, r.scale);
      const h = trunkHeightFor(sp, r.scale);
      // The cylinder is centred on its own origin, so it lifts by half its height to stand on the
      // ground rather than sink to its waist.
      pos.set(r.x, r.y + h / 2, r.z);
      scl.set(rad, h, rad);
      mesh.setMatrixAt(i, m4.compose(pos, q, scl));
    }
    mesh.instanceMatrix.needsUpdate = true;
    colliderRoot.add(mesh);
    trunkMesh = mesh;
    colliderVersion++;
  }

  // ─── public ───────────────────────────────────────────────────────────────

  function rebuild(opts = {}) {
    bounds = opts.bounds || bounds;
    groundAt = opts.groundHeight || groundAt;
    speciesTable = opts.speciesTable || speciesTable;
    if (opts.settings) settings = { ...settings, ...opts.settings };
    windUniform.value = settings.wind;

    if (!bounds) return stats();
    const rects = [
      ...blockerRects(opts.wallBoxes || [], TRUNK_CLEARANCE),
      ...blockerRects(opts.coverBoxes || [], TRUNK_CLEARANCE),
      ...padRects(opts.pads || [], TRUNK_CLEARANCE),
    ];
    blockerIndex = buildBlockerIndex(rects, paddedBounds(), 2);

    if (!settings.enabled) {
      records = []; placed = [];
      clearMeshes(); clearTrunks(); colliderVersion++;
      return stats();
    }

    ensurePalette();
    // Placed trees are resolved against the CURRENT table, so a species removed in tree-viewer
    // drops its trees rather than silently repainting them as some other species.
    const placedLive = resolvePlacedRecords(placed, speciesTable, groundAt)
      .filter(r => canPlantAt(r.x, r.z));
    records = normalizeScales([...scatter(), ...placedLive]);
    buildMeshes();
    buildTrunks();
    return stats();
  }

  // Add one tree, or a jittered clump of them, at a clicked point. Returns how many landed —
  // fewer than asked when the brush overlaps a wall.
  function plantAt(x, z, opts = {}) {
    if (!speciesTable.length) return 0;
    const rng = makeRng(opts.seed ?? (placed.length * 2654435761 + 1));
    const pts = opts.radius > 0
      ? stampCluster({ x, z }, {
        count: Math.max(1, Math.round(opts.count ?? 1)),
        radius: opts.radius,
        falloff: opts.falloff ?? 0.35,
        minSeparation: opts.minSeparation ?? 0,
        accept: canPlantAt,
      }, rng)
      : (canPlantAt(x, z) ? [{ x, z }] : []);
    for (const p of pts) {
      // No speciesId means roll one per tree, so a clump comes out mixed. A pinned id that is no
      // longer in the table falls back to that roll rather than dropping the click: planting
      // nothing at all reads as a broken tool, and the id only goes stale on a family switch.
      const pinned = opts.speciesId ? speciesTable.find(s => s._tag?.id === opts.speciesId) : null;
      const sp = pinned || speciesTable[Math.floor(rng() * speciesTable.length)];
      if (!sp) continue;
      // Identical size math to forest-placement's sizeFor, so a planted tree and a scattered one of
      // the same species come out the same size. Drawing uniformly across the range instead looks
      // right until sizeVar is 0, where sizeFor returns the TOP of the range and a uniform draw
      // returns its middle — which is visibly two different trees.
      const [lo, hi] = sp._tag?.sizeRange || [1, 1];
      const frac = 1 - Math.max(0, settings.sizeVar) * (1 - rng());
      const jitter = lo + (hi - lo) * Math.max(0.12, frac);
      placed.push({
        // Stores the size VARIATION only. The height normalization is applied downstream in
        // normalizeScales, so a saved tree follows the height slider instead of freezing the one
        // it was planted under.
        x: p.x, z: p.z, speciesId: sp._tag.id,
        scale: jitter, yaw: rng() * Math.PI * 2,
      });
    }
    if (pts.length) refresh();
    return pts.length;
  }

  // Only hand-placed trees are erasable: an auto tree is a function of the seed and would come
  // straight back on the next rebuild.
  function eraseAt(x, z, radius = 1.5) {
    // Scanned 1:1 over `placed`, NOT over the resolved list: resolvePlacedRecords drops records
    // whose species is gone, which shifts every later index and would erase the wrong tree.
    const i = nearestPlacedIndex(placed.map(p => ({ ...p, origin: 'placed' })), x, z, radius);
    if (i < 0) return false;
    placed.splice(i, 1);
    refresh();
    return true;
  }

  function clearPlaced() {
    if (!placed.length) return 0;
    const n = placed.length;
    placed = [];
    refresh();
    return n;
  }

  // Re-derive the live set without redoing the blocker index or the palette.
  function refresh() {
    if (!bounds) return;
    ensurePalette();
    const placedLive = resolvePlacedRecords(placed, speciesTable, groundAt)
      .filter(r => canPlantAt(r.x, r.z));
    records = normalizeScales([...scatter(), ...placedLive]);
    buildMeshes();
    buildTrunks();
    onStats(stats());
  }

  function stats() {
    const auto = records.filter(r => r.origin === 'auto').length;
    const asked = settings.enabled ? treeBudget(paddedBounds(), settings.density) : 0;
    return {
      total: records.length,
      auto,
      // What the scatter ASKED for. Always >= auto, because the square overspills the arena and
      // walls and clear zones take their bite afterwards. Reported so the density slider is
      // readable rather than mysterious.
      asked,
      capped: asked >= TREE_CAP,
      placed: records.length - auto,
      draws: meshes.length,
      colliderTriangles: settings.collide ? trunkTriangleCost(records.length) : 0,
      species: speciesTable.length,
    };
  }

  return {
    root,
    colliderRoot,
    rebuild,
    refresh,
    plantAt,
    eraseAt,
    clearPlaced,
    stats,
    get colliderVersion() { return colliderVersion; },
    // Trunk footprints for nav-grid's `blockers`. Never for sightBlockers: bots.md:6709-6728
    // records that thin trunk rects occlude nothing at grid pitch while still emitting up to 8
    // corner records each. Bullets still stop on trunks, via the collider proxy.
    navRects(capsuleRadius = 0.4) {
      return settings.blockNav ? trunkNavRects(records, speciesTable, capsuleRadius) : [];
    },
    setWind(v) { settings.wind = v; windUniform.value = v; },
    // Swapping the texture set changes baked leaf geometry ('simple' silhouettes vs atlas 'quad'
    // cards), so the caller must rebuild afterwards for it to take effect.
    setTextureSource,
    get textureMode() { return texSet?.ready ? texSet.mode : 'procedural'; },
    get speciesHeights() { return speciesHeights.slice(); },
    // Serialized from `placed`, NOT from `records`: records have been through normalizeScales, so
    // saving them would bake the height normalization into the stored scale and reloading would
    // apply it a second time.
    serialize() { return serializePlaced(placed.map(p => ({ ...p, origin: 'placed' }))); },
    restore(list) { placed = Array.isArray(list) ? list.slice() : []; },
    maxTreesForBudget,
    dispose() {
      clearMeshes();
      clearTrunks();
      disposePalette();
      parent.remove(root);
      branchMat?.dispose(); leafMat?.dispose();
      branchMat = null; leafMat = null;
    },
  };
}
