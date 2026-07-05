// Runs in Node.js. Pure unit test of the relay per-guest send verdict.
import { guestSendVerdict, RELAY_GUEST_SKIP_BYTES, RELAY_GUEST_KILL_BYTES } from './backpressure.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// healthy socket: always send
assert(guestSendVerdict(0, true) === 'send', 'drained socket sends sim_state');
assert(guestSendVerdict(0, false) === 'send', 'drained socket sends other frames');
assert(guestSendVerdict(RELAY_GUEST_SKIP_BYTES, true) === 'send', 'at the skip cap (not over) still sends');

// backed-up sim_state between the two caps: skip (superseded by the next frame)
assert(guestSendVerdict(RELAY_GUEST_SKIP_BYTES + 1, true) === 'skip', 'sim_state past the soft cap skips');
assert(guestSendVerdict(RELAY_GUEST_KILL_BYTES, true) === 'skip', 'sim_state at the kill cap (not over) still only skips');

// non-sim_state between the caps: must still send (not superseded, must be delivered)
assert(guestSendVerdict(RELAY_GUEST_SKIP_BYTES + 1, false) === 'send', 'non-sim_state past the soft cap still sends');
assert(guestSendVerdict(RELAY_GUEST_KILL_BYTES, false) === 'send', 'non-sim_state at the kill cap still sends');

// past the hard cap: kill regardless of frame type
assert(guestSendVerdict(RELAY_GUEST_KILL_BYTES + 1, true) === 'kill', 'sim_state past the hard cap kills');
assert(guestSendVerdict(RELAY_GUEST_KILL_BYTES + 1, false) === 'kill', 'non-sim_state past the hard cap kills');

// caller-supplied limits
assert(guestSendVerdict(100, true, 64, 200) === 'skip', 'custom limits: over skip, under kill -> skip');
assert(guestSendVerdict(300, true, 64, 200) === 'kill', 'custom limits: over kill -> kill');
assert(guestSendVerdict(50, true, 64, 200) === 'send', 'custom limits: under skip -> send');

if (failed) { console.error('relay backpressure tests FAILED.'); process.exit(1); }
console.log('Relay backpressure tests passed.');
process.exit(0);
