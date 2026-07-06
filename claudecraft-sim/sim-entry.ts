// claudecraft-sim/sim-entry.ts
export { Sim } from './sim';
export { createMob } from './entity';
export { MOBS } from './data';
export { setActiveWorldContent, getActiveWorldContent } from './data';
// Seams added in later tasks (declared here now so the entry is stable):
export { setHeightProvider, setWaterLevelProvider } from './world';
export { setExternalColliderResolver } from './colliders';
export type { Entity, WorldContent, SimEvent } from './types';
