// Per-guest relay send backpressure.
//
// The relay forwards the host's `sim_state` to every guest with no flow control
// (`g.send(payload)` unconditionally). A guest that stops draining its socket grows
// an unbounded buffer inside the relay process (`g.bufferedAmount`), a memory risk on
// the hosting instance; and if the relay→guest hop is the saturated one, that guest
// jams even when the host's own send buffer is empty (so the host-side guard can't see
// it). Mirrors world-of-claudecraft's `server/ws_backpressure.ts`, but with a two-tier
// verdict rather than a single kill switch:
//   - skip: drop a superseded `sim_state` frame at a soft cap — lossless in the limit,
//     since the next snapshot replaces it. Only `sim_state` is skippable; other frames
//     (roster/lifecycle) are not superseded by later ones and must always be delivered.
//   - kill: past a hard cap the guest is provably not draining; terminate the socket
//     (which fires the relay's existing `close` handler → `guest_left` bookkeeping).
//
// Pure function (no socket/ws import) so the verdict math is unit-testable in plain node.

export const RELAY_GUEST_SKIP_BYTES = 1 * 1024 * 1024; // ≈ 10–20 frames buffered
export const RELAY_GUEST_KILL_BYTES = 8 * 1024 * 1024; // matches claudecraft's dead-socket cap

/**
 * @param {number} bufferedAmount  the guest socket's unflushed outbound bytes
 * @param {boolean} isSimState     whether the frame being forwarded is a `sim_state`
 * @returns {'send'|'skip'|'kill'}
 */
export function guestSendVerdict(
  bufferedAmount,
  isSimState,
  skipLimit = RELAY_GUEST_SKIP_BYTES,
  killLimit = RELAY_GUEST_KILL_BYTES,
) {
  if (bufferedAmount > killLimit) return 'kill';
  if (isSimState && bufferedAmount > skipLimit) return 'skip';
  return 'send';
}
