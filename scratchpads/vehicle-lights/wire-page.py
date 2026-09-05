import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))
rd = lambda p: open(p, encoding='utf-8', newline='').read()
wr = lambda p, s: open(p, 'w', encoding='utf-8', newline='').write(s)
p = 'base-game.html'
s = rd(p)

NL = '\r\n' if s.count('\r\n') > s.count('\n') / 2 else '\n'
def rep(old, new, n=1):
    global s
    old = old.replace('\n', NL); new = new.replace('\n', NL)
    assert s.count(old) == n, (old[:80], s.count(old))
    s = s.replace(old, new)

rep("import { createWeaponLaser, WEAPON_LASER_DEFAULTS, tapKind } from './weapon-laser.js';\n",
    "import { createWeaponLaser, WEAPON_LASER_DEFAULTS, tapKind } from './weapon-laser.js';\nimport { createVehicleLights } from './base-game-vehicle-lights.js';\nimport { BASE_GAME_VEHICLE_LIGHTS } from './base-game-protocol.mjs';\n")
rep("damageBaseGameVehicle, dueVehicleBlasts } from './base-game-vehicles.js';",
    "damageBaseGameVehicle, dueVehicleBlasts, setVehicleLights } from './base-game-vehicles.js';")
rep("const weaponLaser = createWeaponLaser({ THREE, scene });\n",
    "const weaponLaser = createWeaponLaser({ THREE, scene });\n// Vehicle lights: a resident pool handed to the nearest lit hulls, for the same WebGPU reason.\nconst vehicleLights = createVehicleLights({ THREE, scene });\n")
rep("updateProjectiles(fxNow, dt); updateVehicleDamageFx(dt); updateShotEffects(fxNow);",
    "updateProjectiles(fxNow, dt); updateVehicleDamageFx(dt); vehicleLights.update(dt, droneView.drones, camera.position); updateShotEffects(fxNow);")

rep("""  if (rec.def.turret) {
    if (di.aim) rec.aim = di.aim;
    rec.firing = di.mode === 1 && di.fire === true;
  }
  if (di.mode === 1 && playerController.controlledId !== rec.id) {""",
"""  if (Number.isInteger(di.lights) && di.mode === 1) setVehicleLights(rec, di.lights);
  if (rec.def.turret) {
    if (di.aim) rec.aim = di.aim;
    rec.firing = di.mode === 1 && di.fire === true;
  }
  if (di.mode === 1 && playerController.controlledId !== rec.id) {""")

rep("""  droneCtl.fireEdge = false;
  return applyLocalVehicleControl(di);
}""", """  if (droneCtl.active && BASE_GAME_VEHICLE_DEFS[droneView.drones.get(id)?.kind]) {
    di.lights = vehicleSwitchMask(droneView.drones.get(id));   // absolute, so a dropped tick cannot invert a switch
  }
  droneCtl.fireEdge = false;
  return applyLocalVehicleControl(di);
}""")

rep("""const devWheel = createWheelMenu({
  getGroups: devWheelGroups,
  getActive: devWheelActive,
  onCommit: devWheelCommit,
});
""", """const devWheel = createWheelMenu({
  getGroups: devWheelGroups,
  getActive: devWheelActive,
  onCommit: devWheelCommit,
});
// The light wheel (hold L): the switches for whatever you are in, each wedge a toggle. On foot
// that is the flashlight and the laser; at a vehicle's stick it is the hull's own switches, kept
// as a local mask that the stick sends every tick and the vehicle keeps when you get out.
const LIGHT_SWITCH_LABELS = { head: 'Headlights', lamp: 'Lamp', high: 'High beams', turretLight: 'Turret light', turretLaser: 'Turret laser' };
const vehicleSwitches = { forId: null, mask: 0 };
function lightSwitchVehicle() {
  if (!droneCtl.active) return null;
  const rec = droneView.drones.get(droneCtl.id);
  return rec && BASE_GAME_VEHICLE_DEFS[rec.kind] ? rec : null;
}
// The local mask starts from what the hull already has, so a vehicle left with its lights on is
// taken over with them on rather than snapped dark by the first tick.
function vehicleSwitchMask(rec) {
  if (!rec) return 0;
  if (vehicleSwitches.forId !== rec.id) { vehicleSwitches.forId = rec.id; vehicleSwitches.mask = rec.latest?.lights ?? 0; }
  return vehicleSwitches.mask;
}
function lightWheelGroups() {
  const rec = lightSwitchVehicle();
  if (!rec) {
    return [
      { id: 'flashlight', label: 'Flashlight', sublabel: settings.flashlightOn ? 'on' : 'off' },
      { id: 'laser', label: 'Laser', sublabel: settings.laserOn ? 'on' : 'off' },
    ];
  }
  const def = BASE_GAME_VEHICLE_DEFS[rec.kind], mask = vehicleSwitchMask(rec);
  return def.lights.map((name) => ({
    id: name,
    label: name === 'head' && def.kind === VEHICLE_UGV ? 'Headlight' : LIGHT_SWITCH_LABELS[name],
    sublabel: mask & BASE_GAME_VEHICLE_LIGHTS[name] ? 'on' : 'off',
  }));
}
function toggleLightSwitch(id) {
  const rec = lightSwitchVehicle();
  if (!rec) {
    if (id === 'flashlight') settings.flashlightOn = !settings.flashlightOn;
    else if (id === 'laser') settings.laserOn = !settings.laserOn;
    else return;
    // The key writes the SETTINGS, so the panel toggles and the key are one switch, not two.
    syncAllControls();
    changed(id === 'laser' ? 'laserOn' : 'flashlightOn');   // applies both
    scheduleAutosaveSafe();
    return;
  }
  const bit = BASE_GAME_VEHICLE_LIGHTS[id];
  if (!bit) return;
  vehicleSwitchMask(rec);
  vehicleSwitches.mask ^= bit;
}
const lightWheel = createWheelMenu({
  getGroups: lightWheelGroups,
  getActive: () => ({ groupId: lightWheelGroups()[0]?.id ?? null, optionId: null }),   // a tap flips the first switch
  onCommit: ({ groupId }) => { if (groupId) toggleLightSwitch(groupId); },
});
""")

rep("let lastLightTapMs = null;   // the L key's double-tap clock\n",
    "let lastLightTapMs = null;   // the L key's double-tap clock\nlet lightTap = null;         // what this press of L was, decided on the way down and spent on the way up\n")

rep("""  if (event.code === 'KeyL' && !event.repeat) {
    // One key, two switches: a tap is the flashlight, a double tap is the laser. The first tap of a
    // pair has already flipped the light by the time the second arrives, so a double tap flips it
    // back — the light blinks for a fraction of a second rather than the tap waiting on a timer to
    // find out what it was. A third tap starts a fresh pair instead of reading as a triple.
    const now = performance.now();
    const kind = tapKind(lastLightTapMs, now);
    lastLightTapMs = kind === 'double' ? null : now;
    settings.flashlightOn = !settings.flashlightOn;
    if (kind === 'double') settings.laserOn = !settings.laserOn;
    // The key writes the SETTINGS, so the panel toggles and the key are one switch, not two.
    syncAllControls();
    changed(kind === 'double' ? 'laserOn' : 'flashlightOn');   // applies both
    scheduleAutosaveSafe();
  }
""", """  if (event.code === 'KeyL' && !event.repeat) {
    // Hold L for the light wheel; releasing it flips the wedge under the mouse. A tap that never
    // moved flips the first switch (the flashlight on foot, the headlights in a vehicle). A double
    // tap flips the laser as well: its first tap has already flipped the first switch by the time
    // the second arrives, so the second flips it back and the light blinks rather than the tap
    // waiting on a timer. A third tap starts a fresh pair instead of reading as a triple.
    const now = performance.now();
    lightTap = tapKind(lastLightTapMs, now);
    lastLightTapMs = lightTap === 'double' ? null : now;
    lightWheel.open();
  }
""")

rep("""  if (event.code === 'Digit9' && devWheel.isOpen) devWheel.close(true);
});""", """  if (event.code === 'Digit9' && devWheel.isOpen) devWheel.close(true);
  if (event.code === 'KeyL' && lightWheel.isOpen) {
    lightWheel.close(true);
    if (lightTap === 'double') { const rec = lightSwitchVehicle(); toggleLightSwitch(!rec ? 'laser' : rec.kind === VEHICLE_UGV ? 'turretLaser' : null); }
    lightTap = null;
  }
});""")

rep("  if (devWheel.isOpen) devWheel.close(false);\n",
    "  if (devWheel.isOpen) devWheel.close(false);\n  if (lightWheel.isOpen) lightWheel.close(false);\n")
rep("  if (event.button === 0 && devWheel.isOpen) return;   // picking a tool is not placing one\n",
    "  if (event.button === 0 && (devWheel.isOpen || lightWheel.isOpen)) return;   // picking a tool is not placing one\n")
rep("  if (document.pointerLockElement !== renderer.domElement && devWheel.isOpen) devWheel.close(false);\n",
    "  if (document.pointerLockElement !== renderer.domElement) { if (devWheel.isOpen) devWheel.close(false); if (lightWheel.isOpen) lightWheel.close(false); }\n")
rep("  if (devWheel.isOpen) { devWheel.handleMouseMove(event); return; }   // the wheel wins the mouse\n",
    "  if (devWheel.isOpen) { devWheel.handleMouseMove(event); return; }   // the wheel wins the mouse\n  if (lightWheel.isOpen) { lightWheel.handleMouseMove(event); return; }\n")
rep("  if (devWheel.isOpen) return;   // the capture-phase handler above is driving the wheel with it\n",
    "  if (devWheel.isOpen || lightWheel.isOpen) return;   // the capture-phase handler above is driving the wheel with it\n")
rep("""  const keys = seated ? '[E] get out'
    : !droneCtl.active ? '[F] take the wheel · [B] send · [N] recall'""",
"""  const keys = seated ? '[E] get out · [L] lights'
    : !droneCtl.active ? '[F] take the wheel · [B] send · [N] recall'""")
rep("""    : atTurretStick() ? '[mouse] aim · [click] fire · [F] release · [B] send · [N] recall'""",
"""    : atTurretStick() ? '[mouse] aim · [click] fire · [L] lights · [F] release · [B] send · [N] recall'""")
wr(p, s)
print('ok')
