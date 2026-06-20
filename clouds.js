// clouds.js
// A sky-cloud plane for three.js. A large quad is patched (onBeforeCompile) onto
// MeshBasicMaterial so the diffuse color is driven by animated 2D simplex noise:
// two octaves scroll over time and are thresholded (smoothstep) into soft cloud
// cover, with alpha falling off by world distance so the plane fades toward the
// horizon. Fog-aware.
//
// Usage:
//   import { Clouds } from './clouds.js';
//   const clouds = new Clouds();
//   clouds.rotation.x = -Math.PI / 2;   // lay it flat overhead
//   clouds.position.y = 400;
//   scene.add(clouds);
//   // each frame:
//   clouds.update(performance.now() / 1000);

import * as THREE from 'three';

export class Clouds extends THREE.Mesh {
  constructor() {
    super();

    // drift speed multiplier + a self-accumulated clock, so changing speed at
    // runtime nudges the rate without jumping the noise phase
    this.speed = 1.0;
    this._scaledTime = 0;
    this._lastTime = undefined;
    this._coverage = 0.4;   // bias added to the noise before thresholding -> cloud cover
    this._puff = 1.0;       // divides the noise frequency -> larger = bigger cloud puffs
    this._softness = 0.3;   // half-width of the smoothstep band -> larger = softer edges
    this._fade = 0.01;      // distance-fade rate -> larger = clouds fade out nearer the horizon

    this.material = new THREE.MeshBasicMaterial({
      transparent: true, // Allow alpha blending if needed
      opacity: 0.9,
      fog: true,
      side: THREE.DoubleSide, // a ceiling viewed from below (and above)
    });

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0.0 };
      shader.uniforms.uCoverage = { value: this._coverage };
      shader.uniforms.uPuff = { value: this._puff };
      shader.uniforms.uSoftness = { value: this._softness };
      shader.uniforms.uFade = { value: this._fade };

      shader.vertexShader = `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        ` + shader.vertexShader;

      shader.fragmentShader = `
        uniform float uTime;
        uniform float uCoverage;
        uniform float uPuff;
        uniform float uSoftness;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        ` + shader.fragmentShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vUv = uv;
         vWorldPosition = worldPosition.xyz;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        `void main() {`,
        `// 2D Simplex noise function
        vec3 permute(vec3 x) {
          return mod(((x*34.0)+1.0)*x, 289.0);
        }

        float snoise(vec2 v){
          const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
          vec2 i  = floor(v + dot(v, C.yy) );
          vec2 x0 = v -   i + dot(i, C.xx);
          vec2 i1;
          i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod(i, 289.0);
          vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
          vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
          m = m*m ;
          m = m*m ;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
          vec3 g;
          g.x  = a0.x  * x0.x  + h.x  * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }

        void main() {`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        float n = snoise(vUv * (5.0 / uPuff) + uTime / 40.0) + snoise(vUv * (10.0 / uPuff) + uTime / 30.0);
        float cloud = smoothstep(0.5 - uSoftness, 0.5 + uSoftness, 0.5 * n + uCoverage);
        vec4 cloudColor = vec4(1.0, 1.0, 1.0, 1.0);
        diffuseColor = vec4(1.0, 1.0, 1.0, cloud * opacity / (uFade * length(vWorldPosition)));
        `
      );

      this.material.userData.shader = shader;
    };

    // Create a quad to apply the cloud shader to
    this.geometry = new THREE.PlaneGeometry(2000, 2000);
  }

  update(elapsedTime) {
    // accumulate scaled time from the frame delta so speed changes don't jump phase
    if (this._lastTime !== undefined) this._scaledTime += (elapsedTime - this._lastTime) * this.speed;
    this._lastTime = elapsedTime;
    const shader = this.material.userData.shader;
    if (shader) shader.uniforms.uTime.value = this._scaledTime;
  }

  setSpeed(speed) { this.speed = speed; }
  setOpacity(opacity) { this.material.opacity = opacity; }
  setCoverage(coverage) { this._coverage = coverage; this._setUniform('uCoverage', coverage); }
  setPuff(puff) { this._puff = puff; this._setUniform('uPuff', puff); }
  setSoftness(softness) { this._softness = softness; this._setUniform('uSoftness', softness); }
  setFade(fade) { this._fade = fade; this._setUniform('uFade', fade); }

  _setUniform(name, value) {
    const shader = this.material.userData.shader;
    if (shader) shader.uniforms[name].value = value;
  }
}

export default Clouds;
