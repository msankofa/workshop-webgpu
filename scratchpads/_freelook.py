import io
p = 'base-game.html'
s = io.open(p, encoding='utf-8').read()

def sub(old, new, tag):
    global s
    assert old in s, 'MISSING: ' + tag
    s = s.replace(old, new, 1)

# ── the state ───────────────────────────────────────────────────────────────
sub("const SENSOR_FOV = [10, 20, 30, 45];",
"""const SENSOR_FOV = [10, 20, 30, 45];
// Free look at the stick. The mouse used to be captured and thrown away while flying -- pointer
// lock held it and nothing read it, which reads as a dead mouse rather than as a decision. Now a
// drag swings the view around the craft while it keeps flying its heading, and a double click puts
// it back behind the nose. Held on the button rather than always on, so a stray hand does not
// leave the camera pointing at the tail.
const freeLook = { yaw: 0, pitch: 0, dragging: false, lastClickMs: 0 };
const FREE_LOOK_RATE = 0.0022;
function freeLookActive() { return freeLook.yaw !== 0 || freeLook.pitch !== 0; }
function recentreFreeLook() { freeLook.yaw = 0; freeLook.pitch = 0; }""", 'state')

# ── the mouse drives it ─────────────────────────────────────────────────────
sub("""addEventListener('mousemove', event => {
  if (devWheel.isOpen) { devWheel.handleMouseMove(event); return; }   // the wheel wins the mouse
  if (!droneCtl.active || droneCtl.seat !== 'missile' || document.pointerLockElement !== renderer.domElement) return;""",
"""addEventListener('mousemove', event => {
  if (devWheel.isOpen) { devWheel.handleMouseMove(event); return; }   // the wheel wins the mouse
  // Flying the craft: a drag is free look. The sensor seat keeps the mouse for its own slew.
  if (droneCtl.active && droneCtl.seat === 'craft' && freeLook.dragging
    && document.pointerLockElement === renderer.domElement) {
    const k = FREE_LOOK_RATE * settings.cameraSensitivity;
    const y = freeLook.yaw - event.movementX * k;
    freeLook.yaw = Math.atan2(Math.sin(y), Math.cos(y));   // the protocol's own wrap idiom
    freeLook.pitch = Math.max(-1.2, Math.min(1.2, freeLook.pitch - event.movementY * k));
    return;
  }
  if (!droneCtl.active || droneCtl.seat !== 'missile' || document.pointerLockElement !== renderer.domElement) return;""", 'mousemove')

# ── the button: drag to look, double click to recentre ──────────────────────
sub("""  if (event.button === 0 && devWheel.isOpen) return;   // picking a tool is not placing one""",
"""  if (event.button === 0 && devWheel.isOpen) return;   // picking a tool is not placing one
  // At the stick the left button is not a trigger: there is nothing to shoot with. It drags the
  // view, and two clicks inside the double-click window put the view back behind the nose.
  if (event.button === 0 && droneCtl.active && droneCtl.seat === 'craft') {
    const now = performance.now();
    if (tapKind(freeLook.lastClickMs, now) === 'double') { recentreFreeLook(); freeLook.lastClickMs = 0; }
    else { freeLook.lastClickMs = now; freeLook.dragging = true; }
    return;
  }""", 'mousedown')

sub("""addEventListener('mouseup', (event) => {
  if (event.button === 2) weaponState.aiming = false;""",
"""addEventListener('mouseup', (event) => {
  if (event.button === 0) freeLook.dragging = false;
  if (event.button === 2) weaponState.aiming = false;""", 'mouseup')

# ── leaving the stick, or a seat change, drops the offset ───────────────────
sub("""function enterSeat(seat) {
  if (seat === 'missile' && !seatHasRack()) return;
  droneCtl.seat = seat;""",
"""function enterSeat(seat) {
  if (seat === 'missile' && !seatHasRack()) return;
  recentreFreeLook();   // a seat change starts looking forward, not wherever the last one left off
  droneCtl.seat = seat;""", 'enterSeat')

sub("""function leaveSeat() {
  droneCtl.active = false;""",
"""function leaveSeat() {
  recentreFreeLook();
  freeLook.dragging = false;
  droneCtl.active = false;""", 'leaveSeat')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('free look state and input wired')
