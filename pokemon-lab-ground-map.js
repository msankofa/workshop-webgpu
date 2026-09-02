// Convert authored Pokemon Lab semantics into the measured map consumed by ground movement.
// Pure: no THREE, DOM, renderer, storage, or old semantic guessing.

import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import { boneGeometry, pivotTree, measureStadiumLeg } from './stadium-rig-map.js';

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });

function sourceParts(gltf) {
  if (gltf?.json && gltf?.bin) return gltf;
  if (gltf instanceof ArrayBuffer || ArrayBuffer.isView(gltf)) return parseGLB(gltf);
  return null;
}

function weightedCentroid(nodes, geometry) {
  let count = 0, x = 0, y = 0, z = 0;
  for (const node of new Set(nodes)) {
    const g = geometry.get(node);
    if (!g?.count) continue;
    count += g.count;
    x += g.centroid.x * g.count;
    y += g.centroid.y * g.count;
    z += g.centroid.z * g.count;
  }
  return count ? V(x / count, y / count, z / count) : null;
}

function depthOf(node, parent) {
  let depth = 0, current = node;
  while ((current = parent.get(current)) >= 0) depth++;
  return depth;
}

/**
 * Build a ground-movement map from resolved Lab data and measured glTF geometry.
 *
 * `annotationRig` is the result of `pokemon-lab-runtime.js`'s `rigFor()`: semantics already resolved to
 * glTF node ids. `measuredRig` is its `.facts` object. `gltf` is either GLB bytes or `{ json, bin }`.
 */
export function mapLabRigForGroundMovement({ annotationRig, measuredRig = annotationRig?.facts, gltf } = {}) {
  const findings = [];
  const say = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
  const trace = {
    locomotion: { value: annotationRig?.locomotion ?? null, source: 'annotation' },
    root: { value: annotationRig?.root ?? null, source: 'annotation' },
    spine: { value: [...(annotationRig?.spine || [])], source: 'annotation' },
    neutral: { present: !!Object.keys(annotationRig?.neutral?.bones || {}).length, source: 'annotation' },
    forward: null,
    bodyCentroid: null,
    legs: [],
  };

  const parts = sourceParts(gltf);
  if (!parts) {
    say('error', 'missing-gltf', 'Ground movement needs the loaded model bytes or its parsed glTF data.');
    return { map: null, findings, trace };
  }
  if (!measuredRig?.bones || !measuredRig?.units) {
    say('error', 'missing-measured-rig', 'Ground movement needs the Lab rig measurements for this model.');
    return { map: null, findings, trace };
  }
  if (annotationRig?.locomotion !== 'walker') {
    say('error', 'not-ground-movement', 'This adapter only maps species whose movement class is Walking.');
    return { map: null, findings, trace };
  }

  const { json, bin } = parts;
  const ctx = nodeWorldMatrices(json);
  const geometry = boneGeometry(json, bin, ctx);
  const tree = pivotTree(json, ctx);
  const pivots = new Set(tree.pivots);
  const parent = tree.parent;
  const nodeExists = (node) => Number.isInteger(node) && pivots.has(node);

  if (!nodeExists(annotationRig.root)) say('error', 'missing-root', 'Assign the body root before previewing movement.');
  if (!annotationRig?.spine?.length) say('error', 'missing-spine', 'Assign the spine before previewing movement.');

  const bodyNodes = [annotationRig?.root, ...(annotationRig?.spine || [])].filter(nodeExists);
  const bodyCentroid = weightedCentroid(bodyNodes, geometry)
    ?? V(0, measuredRig.units.floorY + measuredRig.units.height * 0.5, 0);
  trace.bodyCentroid = {
    value: bodyCentroid,
    source: bodyNodes.some(node => geometry.has(node)) ? 'measured-root-and-spine-geometry' : 'measured-extents-fallback',
  };

  const headCentroid = weightedCentroid((annotationRig?.head || []).filter(nodeExists), geometry);
  let forwardAxis = 'z', forward = 1, forwardSource = 'deterministic-default';
  if (headCentroid) {
    const dx = headCentroid.x - bodyCentroid.x;
    const dz = headCentroid.z - bodyCentroid.z;
    if (Math.hypot(dx, dz) > measuredRig.units.height * 1e-5) {
      forwardAxis = Math.abs(dz) >= Math.abs(dx) ? 'z' : 'x';
      forward = Math.sign(forwardAxis === 'z' ? dz : dx) || 1;
      forwardSource = 'measured-annotated-head';
    }
  }
  if (forwardSource === 'deterministic-default') {
    say('warn', 'forward-default', 'No annotated head geometry establishes forward; using the model default +z.');
  }
  trace.forward = { value: { axis: forwardAxis, sign: forward }, source: forwardSource };

  const appendages = (annotationRig?.appendages || []).filter(ap => ap.type === 'leg');
  if (!appendages.length) say('error', 'missing-legs', 'Assign at least one leg before previewing ground movement.');

  const owners = new Map();
  for (const ap of appendages) {
    for (const node of ap.chain || []) {
      if (owners.has(node) && owners.get(node) !== ap.id) {
        say('error', 'shared-limb-bone', `Legs ${owners.get(node)} and ${ap.id} both contain the same bone.`,
          { appendage: ap.id, node });
      } else owners.set(node, ap.id);
    }
  }

  const legs = [];
  for (const ap of appendages) {
    const before = findings.length;
    const chain = [...new Set(ap.chain || [])].filter(nodeExists);
    const contacts = [...new Set(ap.contacts || [])].filter(nodeExists);
    if (!chain.length) say('error', 'missing-limb-chain', `Leg ${ap.id} has no bones.`, { appendage: ap.id });
    if (!contacts.length) say('error', 'missing-foot', `Leg ${ap.id} has no foot bone.`, { appendage: ap.id });
    if (ap.side !== 'L' && ap.side !== 'R') {
      say('error', 'missing-side', `Leg ${ap.id} needs a left or right side.`, { appendage: ap.id });
    }
    if (!Number.isInteger(ap.row) || ap.row < 0) {
      say('error', 'missing-row', `Leg ${ap.id} needs a non-negative row.`, { appendage: ap.id });
    }
    if (!chain.length || !contacts.length) continue;

    const selected = new Set(chain);
    const mainFoot = [...contacts].sort((a, b) => depthOf(b, parent) - depthOf(a, parent) || a - b)[0];
    const jointBones = [];
    let current = mainFoot;
    // Mark feet is deliberately separate from assigning a limb. Walk up through toe/sole bones until
    // reaching the authored driven chain, then collect that chain back to its body attachment.
    while (current >= 0 && !selected.has(current)) current = parent.get(current) ?? -1;
    while (selected.has(current)) {
      jointBones.unshift(current);
      current = parent.get(current) ?? -1;
    }
    const attach = current;
    const jointGeometry = jointBones.filter(node => geometry.has(node));
    if (jointGeometry.length < 2 || attach < 0) {
      say('error', 'short-limb-chain', `Leg ${ap.id} needs at least two connected bones below its attachment.`,
        { appendage: ap.id });
    }
    if (findings.slice(before).some(f => f.severity === 'error')) continue;

    try {
      const measured = measureStadiumLeg({
        bones: jointBones,
        drivenBones: chain,
        footBones: contacts,
        attach,
        tip: mainFoot,
      }, {
        row: ap.row,
        side: ap.side === 'L' ? -1 : 1,
        geo: geometry,
        tree,
        ctx,
        json,
        forwardAxis,
        forward,
        floorY: measuredRig.units.floorY,
      });
      measured.annotationId = ap.id;
      measured.mirror = ap.mirror ?? null;
      legs.push(measured);
      trace.legs.push({
        id: ap.id,
        semantics: {
          side: { value: ap.side, source: 'annotation' },
          row: { value: ap.row, source: 'annotation' },
          mirror: { value: ap.mirror ?? null, source: 'annotation' },
          chain: { value: chain, source: 'annotation' },
          footBones: { value: contacts, source: 'annotation' },
        },
        geometry: {
          jointBones: { value: measured.jointBones, source: 'measured-topology' },
          hip: { value: measured.hip, source: 'measured-geometry' },
          knee: { value: measured.knee, source: 'deterministic-equal-reach-split' },
          foot: { value: measured.foot, source: 'measured-contact-sole' },
          pole: { value: measured.pole, source: measured.poleSource, confidence: measured.poleConfidence },
        },
      });
      if (measured.poleConfidence < 0.5) {
        say('warn', 'low-confidence-knee', `Leg ${ap.id} is too straight at rest to establish a reliable knee side.`,
          { appendage: ap.id });
      }
    } catch (error) {
      say('error', 'leg-measurement-failed', `Leg ${ap.id} could not be measured: ${error.message}`,
        { appendage: ap.id });
    }
  }

  if (findings.some(f => f.severity === 'error')) return { map: null, findings, trace };

  const names = Object.fromEntries(tree.pivots.map(node => [node, json.nodes?.[node]?.name ?? `node${node}`]));
  const restWorld = Object.fromEntries(tree.pivots.map(node => [node, Array.from(ctx.world[node])]));
  const map = {
    source: measuredRig.source ?? annotationRig?.species ?? null,
    units: {
      floorY: measuredRig.units.floorY,
      height: measuredRig.units.height,
      halfWidth: measuredRig.units.halfWidth,
    },
    forward: { axis: forwardAxis, sign: forward },
    root: annotationRig.root,
    body: annotationRig.root,
    bodyCentroid,
    rideHeight: bodyCentroid.y - measuredRig.units.floorY,
    legs,
    head: annotationRig.head?.length ? { bones: [...annotationRig.head] } : null,
    tail: null,
    spine: [...annotationRig.spine],
    names,
    restWorld,
    warnings: findings.filter(f => f.severity === 'warn').map(f => f.message),
  };
  return { map, findings, trace };
}
