// node scratchpads/spawn-atrium/check-grass-lambert.mjs -- compile both grass lighting models headlessly.
import { buildMaterial } from '../../tsl-build-check.mjs';
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, fillRect() {}, drawImage() {},
}) }) };
const { createGrass } = await import('../../grass.js');
for (const lighting of ['standard', 'lambert']) {
  const g = createGrass({ count: 8, size: 4, lighting });
  const out = await buildMaterial(g.material, g.geometry);
  const specular = /GGX/i.test(out.fragment);
  const shadow = /shadow/i.test(out.fragment);
  console.log(`${lighting}: ${g.material.type}, fragment ${out.fragment.length} chars, GGX specular ${specular ? 'yes' : 'no'}, shadow term ${shadow ? 'yes' : 'no'}`);
}
