// Runs in Node.js. Imports only the pure host-broadcast backpressure logic.
import { shouldSendSnapshot, hostBroadcastTick, HOST_MAX_BUFFERED_BYTES } from './multiplayer.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// --- shouldSendSnapshot boundaries -----------------------------------------
assert(shouldSendSnapshot(0) === true, 'empty buffer should send');
assert(shouldSendSnapshot(HOST_MAX_BUFFERED_BYTES) === true, 'buffer at the limit should still send');
assert(shouldSendSnapshot(HOST_MAX_BUFFERED_BYTES + 1) === false, 'buffer past the limit should skip');
assert(shouldSendSnapshot(100, 64) === false, 'honors a caller-supplied limit (over)');
assert(shouldSendSnapshot(64, 64) === true, 'honors a caller-supplied limit (at)');

// --- hostBroadcastTick: send-or-skip decision + ordering -------------------
let getStateCalls = 0;
const getState = () => { getStateCalls++; return { creatures: [], players: [] }; };
const ws = {
  readyState: 1,
  bufferedAmount: 0,
  sent: [],
  send(p) { this.sent.push(p); },
};
let skips = 0;
const onSkip = () => { skips++; };
const sendFrame = state => ws.send(JSON.stringify({ type: 'sim_state', ...state }));

// healthy: drained buffer -> sends, getState called
ws.bufferedAmount = 0;
let sent = hostBroadcastTick(ws, getState, sendFrame, onSkip);
assert(sent === true, 'healthy tick should report a send');
assert(ws.sent.length === 1, 'healthy tick should push one frame');
assert(getStateCalls === 1, 'healthy tick should call getState once');
assert(skips === 0, 'healthy tick should not count a skip');

// saturated: buffer over the limit -> skip, and getState must NOT be called
ws.bufferedAmount = HOST_MAX_BUFFERED_BYTES + 1;
sent = hostBroadcastTick(ws, getState, sendFrame, onSkip);
assert(sent === false, 'saturated tick should report a skip');
assert(ws.sent.length === 1, 'saturated tick should push no new frame');
assert(getStateCalls === 1, 'saturated tick must NOT call getState (skip precedes getState — pins send-marking side-effect safety)');
assert(skips === 1, 'saturated tick should count exactly one skip');

// recovery: buffer drops back -> sends again
ws.bufferedAmount = 0;
sent = hostBroadcastTick(ws, getState, sendFrame, onSkip);
assert(sent === true, 'recovered tick should resume sending');
assert(ws.sent.length === 2, 'recovered tick should push a second frame');
assert(getStateCalls === 2, 'recovered tick should call getState again');

// closed socket: never sends, never skips
const closed = { readyState: 3, bufferedAmount: 0, sent: [], send(p) { this.sent.push(p); } };
sent = hostBroadcastTick(closed, getState, sendFrame, onSkip);
assert(sent === false, 'closed socket tick should not send');
assert(getStateCalls === 2, 'closed socket tick should not call getState');

if (failed) { console.error('host backpressure tests FAILED.'); process.exit(1); }
console.log('Host backpressure tests passed.');
process.exit(0);
