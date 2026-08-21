// traversal-lab-layout.js — deterministic, renderer-independent descriptor for
// Base Game's permanent pre-terrain 3D traversal and collision test world.

export const TRAVERSAL_LAB_LAYOUT_VERSION = 1;

const MATERIALS = Object.freeze({
  floor: Object.freeze({ color: 0x536273, roughness: 0.88, metalness: 0.02 }),
  walkable: Object.freeze({ color: 0x3d8ba8, roughness: 0.78, metalness: 0.02 }),
  structure: Object.freeze({ color: 0x68758b, roughness: 0.82, metalness: 0.05 }),
  warning: Object.freeze({ color: 0xd98b38, roughness: 0.72, metalness: 0.02 }),
  overhead: Object.freeze({ color: 0x765c9b, roughness: 0.82, metalness: 0.02 }),
  distant: Object.freeze({ color: 0x3f9b73, roughness: 0.8, metalness: 0.02 }),
});

function box(id, zone, material, cx, cy, cz, sx, sy, sz, rotation = null) {
  return Object.freeze({
    id, zone, material, cx, cy, cz, sx, sy, sz,
    rx: rotation?.[0] ?? 0,
    ry: rotation?.[1] ?? 0,
    rz: rotation?.[2] ?? 0,
  });
}

export function createTraversalLabLayout() {
  const primitives = [];
  const add = (...args) => primitives.push(box(...args));

  // Origin platform. Its segmented edge leaves real drops instead of one hidden
  // world floor underneath every test.
  add('origin-floor', 'origin', 'floor', 0, -0.5, 0, 32, 1, 24);
  add('origin-north-link', 'origin', 'walkable', 0, -0.5, 15, 8, 1, 6);
  add('origin-east-link', 'origin', 'walkable', 19, -0.5, 0, 6, 1, 8);
  add('origin-west-link', 'origin', 'walkable', -19, -0.5, 0, 6, 1, 8);
  add('origin-south-link', 'origin', 'walkable', 0, -0.5, -15, 8, 1, 6);

  // Walkable and deliberately too-steep ramps. Thin rotated slabs expose both
  // slope handling and underside/ceiling contacts.
  add('ramp-walkable', 'slopes', 'walkable', 28, 2.9, -3.5, 17, 0.8, 6, [0, 0, Math.atan2(6, 17)]);
  add('ramp-walkable-top', 'slopes', 'floor', 38.5, 5.55, -3.5, 5, 1, 7);
  add('ramp-steep', 'slopes', 'warning', 27, 4.2, 8.5, 11, 0.8, 6, [0, 0, Math.PI * 0.31]);
  add('ramp-steep-top', 'slopes', 'warning', 34.5, 8.2, 8.5, 5, 1, 7);

  // Stairs and isolated step-height probes.
  for (let i = 0; i < 7; i++) {
    const h = (i + 1) * 0.5;
    add(`stair-${i}`, 'stairs', 'walkable', -7, h / 2, 20 + i * 2, 7, h, 2);
  }
  add('stair-top', 'stairs', 'floor', -7, 1.25, 35, 9, 2.5, 5);
  add('step-probe-floor', 'steps', 'floor', 8, -0.5, 21, 14, 1, 10);
  add('step-low', 'steps', 'walkable', 4, 0.15, 21, 3, 0.3, 3);
  add('step-standard', 'steps', 'walkable', 8, 0.3, 21, 3, 0.6, 3);
  add('step-high', 'steps', 'warning', 12, 0.65, 21, 3, 1.3, 3);

  // Bridge: two standable surfaces at the same X/Z plus open space between.
  add('bridge-ground', 'bridge', 'floor', -34, -0.5, 0, 22, 1, 12);
  add('bridge-deck', 'bridge', 'walkable', -34, 5.75, 0, 18, 0.5, 6);
  add('bridge-support-west', 'bridge', 'structure', -41.5, 2.5, 0, 1, 5, 6);
  add('bridge-support-east', 'bridge', 'structure', -26.5, 2.5, 0, 1, 5, 6);
  add('bridge-ramp', 'bridge', 'walkable', -23, 2.75, 0, 8, 0.6, 6, [0, 0, -Math.atan2(5.5, 8)]);

  // Tunnel and low-clearance doorway. The floor, ceiling, and hillside roof are
  // separate surfaces in one X/Z column.
  add('tunnel-floor', 'tunnel', 'floor', 0, -0.5, -31, 12, 1, 22);
  add('tunnel-wall-west', 'tunnel', 'structure', -5.5, 2, -31, 1, 4, 22);
  add('tunnel-wall-east', 'tunnel', 'structure', 5.5, 2, -31, 1, 4, 22);
  add('tunnel-ceiling', 'tunnel', 'overhead', 0, 4.5, -31, 12, 1, 22);
  add('tunnel-roof', 'tunnel', 'walkable', 0, 7, -31, 16, 4, 24);
  add('door-left', 'clearance', 'warning', -3.5, 1.75, -19.5, 3, 3.5, 1);
  add('door-right', 'clearance', 'warning', 3.5, 1.75, -19.5, 3, 3.5, 1);
  add('door-header', 'clearance', 'warning', 0, 3.25, -19.5, 4, 0.5, 1);
  add('low-ceiling', 'clearance', 'overhead', 0, 2.25, -38, 8, 0.5, 5);

  // Three stacked floors, deliberately sharing X/Z. Open sides make every
  // level visible before a player exists.
  add('stack-ground', 'stacked-floors', 'floor', 47, -0.5, -23, 14, 1, 14);
  add('stack-floor-1', 'stacked-floors', 'walkable', 47, 4.75, -23, 14, 0.5, 14);
  add('stack-floor-2', 'stacked-floors', 'walkable', 47, 9.75, -23, 14, 0.5, 14);
  add('stack-column-a', 'stacked-floors', 'structure', 41, 5, -29, 0.8, 10, 0.8);
  add('stack-column-b', 'stacked-floors', 'structure', 53, 5, -29, 0.8, 10, 0.8);
  add('stack-column-c', 'stacked-floors', 'structure', 41, 5, -17, 0.8, 10, 0.8);
  add('stack-column-d', 'stacked-floors', 'structure', 53, 5, -17, 0.8, 10, 0.8);

  // Ledges, floating platform, and concave corner contacts.
  add('ledge-base', 'ledges', 'floor', -19, -0.5, -28, 16, 1, 10);
  add('ledge-narrow', 'ledges', 'walkable', -19, 3.85, -28, 15, 0.3, 1.2);
  add('floating-platform', 'ledges', 'warning', -19, 10, -36, 7, 0.5, 7);
  add('corner-floor', 'corners', 'floor', 26, -0.5, 27, 14, 1, 14);
  add('corner-wall-x', 'corners', 'structure', 32.5, 3, 27, 1, 6, 14);
  add('corner-wall-z', 'corners', 'structure', 26, 3, 33.5, 14, 6, 1);

  // A faceted cave-like passage: angled side blocks create non-axis-aligned wall
  // contacts while retaining deterministic box geometry.
  add('cave-floor', 'cave', 'floor', -48, -0.5, -28, 18, 1, 18);
  add('cave-wall-left', 'cave', 'structure', -55, 3, -28, 2, 7, 19, [0, 0, -0.18]);
  add('cave-wall-right', 'cave', 'structure', -41, 3, -28, 2, 7, 19, [0, 0, 0.18]);
  add('cave-roof-left', 'cave', 'overhead', -52, 6.2, -28, 8, 1.5, 19, [0, 0, 0.28]);
  add('cave-roof-right', 'cave', 'overhead', -44, 6.2, -28, 8, 1.5, 19, [0, 0, -0.28]);

  // This is intentionally outside the initial camera range. It becomes the
  // stable target for render-origin and long-distance traversal tests.
  add('distant-rebase-platform', 'distance', 'distant', 9216, -0.5, 0, 48, 1, 48);
  add('distant-rebase-pillar', 'distance', 'distant', 9216, 12, 0, 2, 24, 2);

  const probes = Object.freeze([
    Object.freeze({ id: 'bridge-stack', origin: Object.freeze([-34, 12, 0]), expectedY: Object.freeze([6, 0]) }),
    Object.freeze({ id: 'building-stack', origin: Object.freeze([47, 15, -23]), expectedY: Object.freeze([10, 5, 0]) }),
    Object.freeze({ id: 'tunnel-stack', origin: Object.freeze([0, 12, -31]), expectedY: Object.freeze([9, 5, 0]) }),
  ]);

  return Object.freeze({
    version: TRAVERSAL_LAB_LAYOUT_VERSION,
    materials: MATERIALS,
    primitives: Object.freeze(primitives),
    probes,
    spawn: Object.freeze([0, 1.2, 6]),
    // Falling below this global Y respawns the player. Well under the lowest solid (-1).
    killPlaneY: -40,
    initialView: Object.freeze({
      camera: Object.freeze([48, 34, 58]),
      target: Object.freeze([0, 3, 0]),
    }),
  });
}
