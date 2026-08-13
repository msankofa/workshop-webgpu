// material-demo-api.js -- the contract every material demo in this folder implements.
//
// PORTABILITY IS THE POINT. A demo module imports only 'three', 'three/webgpu' and 'three/tsl'.
// It never touches the DOM, never adds anything to a scene, and never assumes a viewer exists.
// material-viewer.html and the game therefore consume the exact same module: the viewer wires
// the params to sliders, the game wires them to entity state (health, spawn timer, sun vector).
//
// A demo exports:
//   meta            -- id/name/blurb/targets/cost/base + a params table (see PARAM SHAPE below)
//   create(opts)    -> handle
//
// The handle is:
//   { meta, material, uniforms, params, setParam, setParams, update(dt, elapsed), dispose }
//
// PARAM SHAPE: { key, label, type, value, min, max, step, hint }
//   type 'float' -- uniform holds a number
//   type 'color' -- uniform holds a THREE.Color; set with a hex number or a css string
//   type 'vec3'  -- uniform holds a THREE.Vector3; set with {x,y,z} or [x,y,z]
// min/max/step only drive the viewer's sliders; the game ignores them.

import * as THREE from 'three';

// Plain {key: value} defaults lifted off a meta.params table.
export function paramDefaults(meta) {
  const out = {};
  for (const p of meta.params ?? []) out[p.key] = p.value;
  return out;
}

// Defaults merged with caller overrides, ignoring keys the demo does not declare.
export function resolveParams(meta, overrides = {}) {
  const out = paramDefaults(meta);
  for (const [k, v] of Object.entries(overrides)) {
    if (k in out) out[k] = v;
  }
  return out;
}

export function paramSpec(meta, key) {
  return (meta.params ?? []).find(p => p.key === key) ?? null;
}

// Writes a resolved value into an existing uniform node, respecting the declared type.
function applyToUniform(uniformNode, type, value) {
  if (type === 'color') uniformNode.value.set(value);
  else if (type === 'vec3') {
    if (Array.isArray(value)) uniformNode.value.set(value[0], value[1], value[2]);
    else uniformNode.value.set(value.x, value.y, value.z);
  } else uniformNode.value = value;
}

// Turns a resolved param value into the right constructor argument for uniform().
export function uniformSeed(type, value) {
  if (type === 'color') return new THREE.Color(value);
  if (type === 'vec3') {
    if (Array.isArray(value)) return new THREE.Vector3(value[0], value[1], value[2]);
    return new THREE.Vector3(value.x, value.y, value.z);
  }
  return value;
}

// Builds the handle so no demo has to reimplement setParam/dispose bookkeeping.
export function buildHandle({ meta, material, uniforms, params, update, dispose }) {
  const types = new Map((meta.params ?? []).map(p => [p.key, p.type ?? 'float']));

  function setParam(key, value) {
    if (!(key in params)) return false;
    params[key] = value;
    const u = uniforms[key];
    if (u) applyToUniform(u, types.get(key), value);
    return true;
  }

  function setParams(next = {}) {
    for (const [k, v] of Object.entries(next)) setParam(k, v);
  }

  return {
    meta,
    material,
    uniforms,
    params,
    setParam,
    setParams,
    update: update ?? (() => {}),
    dispose: dispose ?? (() => { material.dispose(); }),
  };
}
