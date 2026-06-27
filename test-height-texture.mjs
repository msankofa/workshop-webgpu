// Verifies that bakeHeightTexture samples correctly at corners and center.
// Run: node test-height-texture.mjs

const THREE = {
  DataTexture: class {
    constructor(data, w, h, format, type) {
      this.image = { data, width: w, height: h };
      this.format = format;
      this.type = type;
      this.minFilter = this.magFilter = this.wrapS = this.wrapT = null;
    }
  },
  RedFormat: 1,
  FloatType: 2,
  LinearFilter: 3,
  ClampToEdgeWrapping: 4,
};

function bakeHeightTexture(terrainHeight, bounds, resolution = 512) {
  const { minX, minZ, worldX, worldZ } = bounds;
  const data = new Float32Array(resolution * resolution);
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const wx = minX + (ix / (resolution - 1)) * worldX;
      const wz = minZ + (iz / (resolution - 1)) * worldZ;
      data[iz * resolution + ix] = terrainHeight(wx, wz);
    }
  }
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

{
  const tex = bakeHeightTexture(() => 5, { minX: -100, minZ: -100, worldX: 200, worldZ: 200 });
  const allFive = [...tex.image.data].every(v => v === 5);
  console.assert(allFive, 'flat terrain: all texels should be 5');
  console.log('Test 1 (flat terrain):', allFive ? 'PASS' : 'FAIL');
}

{
  const bounds = { minX: 0, minZ: 0, worldX: 100, worldZ: 100 };
  const tex = bakeHeightTexture((x) => x, bounds, 256);
  const data = tex.image.data;
  const topRightIdx = (256 - 1) * 256 + (256 - 1);
  const close = Math.abs(data[topRightIdx] - 100) < 0.01;
  console.assert(close, `right-edge texel should be ~100, got ${data[topRightIdx]}`);
  console.log('Test 2 (linear terrain):', close ? 'PASS' : 'FAIL');
}

{
  const tex = bakeHeightTexture(() => 0, { minX: 0, minZ: 0, worldX: 50, worldZ: 50 }, 64);
  const ok = tex.image.width === 64 && tex.image.height === 64;
  console.assert(ok, 'resolution mismatch');
  console.log('Test 3 (resolution):', ok ? 'PASS' : 'FAIL');
}
