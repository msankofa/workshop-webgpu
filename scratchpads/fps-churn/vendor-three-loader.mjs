// Node loader hook: resolve 'three', 'three/webgpu' and 'three/tsl' to the vendored patched build the page serves.
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(process.cwd() + '/vendor/three-0.184/').href;
const map = { 'three': 'three.core.js', 'three/webgpu': 'three.webgpu.js', 'three/tsl': 'three.tsl.js' };
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: root + map[specifier], shortCircuit: true };
  return next(specifier, context);
}
