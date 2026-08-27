// Remote diagnostic capsules for Base Game. One pooled capsule per roster player other than the
// local ID, rendered from a server-time buffer ~100 ms behind so ordinary jitter interpolates.
// Positions stay global until each render and pass through this client's own render origin.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { sanitizeBaseGamePlayerState } from './base-game-protocol.mjs';

const _local = [0, 0, 0];

export function remotePlayerColor(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  const hue = ((hash >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.62, 0.56);
}

// Pure per-player sample buffer. Samples are keyed by server time (ms).
export function createRemoteTrack({ maxSamples = 32 } = {}) {
  const samples = [];
  let spawnRevision = null;
  let lastState = null;
  return {
    get spawnRevision() { return spawnRevision; },
    get sampleCount() { return samples.length; },
    get latest() { return samples[samples.length - 1] ?? null; },
    push(serverTime, state) {
      if (!Number.isFinite(serverTime)) return false;
      if (spawnRevision !== state.spawnRevision) {
        spawnRevision = state.spawnRevision;
        samples.length = 0;
      }
      const last = samples[samples.length - 1];
      if (last && serverTime <= last.t) return false;
      samples.push({ t: serverTime, ...state });
      if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
      lastState = state;
      return true;
    },
    // Returns {position, yaw, pitch, grounded, mode} for a render time, or null with no samples.
    sample(renderTime, { maxExtrapolationMs = 250 } = {}, out = { position: [0, 0, 0] }) {
      if (samples.length === 0) return null;
      const last = samples[samples.length - 1];
      if (renderTime >= last.t) {
        const ahead = Math.min(renderTime - last.t, maxExtrapolationMs) / 1000;
        for (let axis = 0; axis < 3; axis++) out.position[axis] = last.position[axis] + last.velocity[axis] * ahead;
        out.yaw = last.yaw; out.pitch = last.pitch; out.grounded = last.grounded;
        out.mode = renderTime - last.t > maxExtrapolationMs ? 'hold' : ahead > 0 ? 'extrapolate' : 'exact';
        return out;
      }
      let upper = 0;
      while (upper < samples.length && samples[upper].t < renderTime) upper++;
      const b = samples[Math.min(upper, samples.length - 1)];
      const a = samples[Math.max(0, upper - 1)];
      const span = b.t - a.t;
      const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.t) / span)) : 1;
      for (let axis = 0; axis < 3; axis++) out.position[axis] = a.position[axis] + (b.position[axis] - a.position[axis]) * t;
      let yawDelta = b.yaw - a.yaw;
      yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
      out.yaw = a.yaw + yawDelta * t;
      out.pitch = a.pitch + (b.pitch - a.pitch) * t;
      out.grounded = t < 0.5 ? a.grounded : b.grounded;
      out.mode = 'interpolate';
      return out;
    },
    clear() { samples.length = 0; lastState = null; },
    get lastState() { return lastState; },
  };
}

export function createBaseGameRemotePlayers({ scene, worldCoordinates, radius = 0.35, height = 1.8 } = {}) {
  if (!scene?.add || !worldCoordinates?.toRenderLocal) {
    throw new TypeError('remote players require a scene and world-coordinate service');
  }
  const geometry = new THREE.CapsuleGeometry(radius, height - radius * 2, 5, 10);
  const group = new THREE.Group();
  group.name = 'base-game-remote-players';
  scene.add(group);
  const players = new Map();
  const pool = [];
  let enabled = true;
  let serverTimeOffsetMs = null;
  let lastRenderTime = null;
  const sampleOut = { position: [0, 0, 0] };

  function acquireMesh(id) {
    let mesh = pool.pop();
    if (!mesh) {
      const material = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.05, transparent: true, opacity: 0.85 });
      mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    mesh.name = `remote-player-${id}`;
    mesh.material.color.copy(remotePlayerColor(id));
    mesh.visible = true;
    return mesh;
  }

  function releaseMesh(mesh) {
    mesh.visible = false;
    pool.push(mesh);
  }

  function ingestSnapshot(snapshot, localId, receivedAt) {
    if (!Array.isArray(snapshot?.players)) return 0;
    if (Number.isFinite(snapshot.serverTime) && Number.isFinite(receivedAt)) {
      const offset = snapshot.serverTime - receivedAt;
      serverTimeOffsetMs = serverTimeOffsetMs == null ? offset : serverTimeOffsetMs + (offset - serverTimeOffsetMs) * 0.1;
    }
    const seen = new Set();
    let accepted = 0;
    for (const entry of snapshot.players) {
      if (!entry || entry.id === localId) continue;
      const state = sanitizeBaseGamePlayerState(entry);
      if (!state) continue;
      seen.add(entry.id);
      let record = players.get(entry.id);
      if (!record) {
        record = { id: entry.id, track: createRemoteTrack(), mesh: acquireMesh(entry.id), connected: true };
        players.set(entry.id, record);
      }
      record.connected = entry.connected !== false;
      if (record.track.push(snapshot.serverTime, state)) accepted++;
    }
    for (const [id, record] of players) {
      if (seen.has(id)) continue;
      releaseMesh(record.mesh);
      players.delete(id);
    }
    return accepted;
  }

  // Samples are always computed so body presentation can consume them; `enabled` only governs
  // whether the diagnostic capsules are drawn.
  function update(now, { interpolationDelayMs = 100, maxExtrapolationMs = 250 } = {}) {
    group.visible = enabled;
    if (serverTimeOffsetMs == null) return;
    const renderTime = now + serverTimeOffsetMs - interpolationDelayMs;
    lastRenderTime = renderTime;
    for (const record of players.values()) {
      const sample = record.track.sample(renderTime, { maxExtrapolationMs }, sampleOut);
      if (!sample) { record.mesh.visible = false; record.sample = null; continue; }
      const latest = record.track.latest;
      record.sample = {
        position: [...sample.position],
        velocity: latest ? [...latest.velocity] : [0, 0, 0],
        yaw: sample.yaw, pitch: sample.pitch, grounded: sample.grounded, mode: sample.mode,
        // Weapon state is not interpolated: the latest authoritative values ride along.
        weapon: latest?.weapon ?? null, slot: latest?.slot ?? 0, aiming: latest?.aiming === true,
        loadout: latest?.loadout ?? null,   // the slots not in hand hang on the body
        stance: latest?.stance ?? 0,
        action: latest?.action ?? 0, actionTick: latest?.actionTick ?? 0, health: latest?.health ?? 100,
        bodyModel: latest?.bodyModel ?? 'default', hitProfile: latest?.hitProfile ?? 'humanoid-default',
        poseEpoch: latest?.poseEpoch ?? 0,
      };
      if (!enabled) { record.mesh.visible = false; record.mode = sample.mode; continue; }
      worldCoordinates.toRenderLocal(sample.position, _local);
      record.mesh.visible = true;
      record.mesh.position.set(_local[0], _local[1] + height * 0.5, _local[2]);
      record.mesh.rotation.y = sample.yaw;
      record.mesh.material.opacity = record.connected ? 0.85 : 0.3;
      record.mode = sample.mode;
    }
  }

  return {
    group,
    ingestSnapshot,
    update,
    setEnabled(value) { enabled = !!value; group.visible = enabled; },
    get count() { return players.size; },
    get players() { return players; },
    get diagnostics() {
      const modes = {};
      for (const record of players.values()) modes[record.mode ?? 'none'] = (modes[record.mode ?? 'none'] ?? 0) + 1;
      return { remoteCount: players.size, serverTimeOffsetMs, lastRenderTime, modes };
    },
    clear() {
      for (const record of players.values()) releaseMesh(record.mesh);
      players.clear();
      serverTimeOffsetMs = null;
    },
    dispose() {
      for (const record of players.values()) releaseMesh(record.mesh);
      players.clear();
      for (const mesh of pool) mesh.material.dispose();
      group.removeFromParent();
      geometry.dispose();
    },
  };
}
