// Squad-scoped orders: the order book that replaces the viewer's single global command slot.
//
// What this fixes, in order of how much it matters:
//   1. Plurality. The game had exactly one `commandTargetId`, so ordering a second squad silently
//      erased the first order. A commander running four squads could hold one thought at a time.
//   2. Lifecycle. The old order was keyed on a bot id and only ever cleared on arrival, so a `hold`
//      on a bot that died stayed live forever -- and because `underCommand` matched by squad, the
//      dead bot's whole squad kept break-contacting for the rest of the match.
//   3. Addressability. An order could only be issued by looking at a bot. A squad id can be ordered
//      from a map, a script, or a network message, with nobody pointing at anything.
//   4. Inheritance. Squads merge, split and absorb every 700 ms. An order has to survive that.
//
// This module is pure: no THREE, no DOM, no time source of its own. Every mutation is a function of
// its arguments, which is what makes the lifecycle rules testable in Node.
//
// Orders never move a bot. They write the out-of-combat movement branch and two biases, exactly as
// the old command slot did. Flee, heal, knife, committed cover and medic duty stay immune -- an
// order is a bias source, never an override, same rule as squad state.

export const ORDER_MOVE = 'move';
export const ORDER_HOLD = 'hold';
export const ORDER_KINDS = [ORDER_MOVE, ORDER_HOLD];

export const SCOPE_SQUAD = 'squad';
export const SCOPE_BOT = 'bot';

export function createOrderBook() {
  return { orders: new Map(), seq: 0 };
}

function orderKey(scope, addressee) { return `${scope}:${addressee}`; }

// Replaces any live order on the same addressee -- one addressee, one order, always.
export function issueOrder(book, {
  scope = SCOPE_SQUAD, addressee, kind = ORDER_MOVE, goal = null, teamId = null,
  doubleTime = false, breakContact = false, issuedAt = 0, ttlMs = 0, source = 'player',
} = {}) {
  if (!book || addressee == null) return null;
  if (!ORDER_KINDS.includes(kind)) return null;
  if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return null;
  const order = {
    id: ++book.seq, scope, addressee, teamId, kind,
    goal: { x: goal.x, z: goal.z },
    doubleTime: doubleTime === true,
    breakContact: breakContact === true,
    issuedAt, expiresAt: ttlMs > 0 ? issuedAt + ttlMs : 0,
    source, arrived: false,
  };
  book.orders.set(orderKey(scope, addressee), order);
  return order;
}

export function getOrder(book, scope, addressee) {
  if (!book || addressee == null) return null;
  return book.orders.get(orderKey(scope, addressee)) ?? null;
}

export function cancelOrder(book, scope, addressee) {
  if (!book || addressee == null) return false;
  return book.orders.delete(orderKey(scope, addressee));
}

// A bot's own order outranks its squad's: ordering one bot out of a formation is a deliberate act,
// and the reconciler must not be able to undo it by folding that bot into a squad half a second later.
export function resolveOrderFor(book, botId, squadId) {
  if (!book || !book.orders.size) return null;
  const own = botId != null ? book.orders.get(orderKey(SCOPE_BOT, botId)) : null;
  if (own) return own;
  return (squadId != null ? book.orders.get(orderKey(SCOPE_SQUAD, squadId)) : null) ?? null;
}

// Only the addressed bot walks the goal; squadmates reach it by following the leader's formation.
export function orderMoverId(order, squad) {
  if (!order) return null;
  if (order.scope === SCOPE_BOT) return order.addressee;
  return squad?.leaderId ?? null;
}

// Arrival: a move order is finished, a hold order is only just starting.
export function completeOrder(book, order) {
  if (!book || !order) return false;
  if (order.kind === ORDER_HOLD) { order.arrived = true; return false; }
  book.orders.delete(orderKey(order.scope, order.addressee));
  return true;
}

// Drops orders whose addressee no longer exists, and orders past their TTL. `hasBot`/`hasSquad` are
// predicates rather than sets so the caller never has to build a collection per tick.
export function pruneOrders(book, { hasBot = () => true, hasSquad = () => true, now = 0 } = {}) {
  if (!book || !book.orders.size) return 0;
  let dropped = 0;
  for (const [key, order] of book.orders) {
    const gone = order.scope === SCOPE_BOT ? !hasBot(order.addressee) : !hasSquad(order.addressee);
    const expired = order.expiresAt > 0 && now >= order.expiresAt;
    if (gone || expired) { book.orders.delete(key); dropped++; }
  }
  return dropped;
}

// --- inheritance across the reconciler ---------------------------------------------------
// Squads are not stable objects: they merge, shed detachments and absorb loose bots every 700 ms.
// These three calls are what keeps an order attached to the bodies the player actually ordered.

// merge(from -> into): the survivor's own order wins. An unordered squad that swallows an ordered one
// picks the order up, so absorbing a squad mid-advance does not stop the advance.
export function transferOrderOnMerge(book, intoId, fromId) {
  if (!book) return null;
  const from = book.orders.get(orderKey(SCOPE_SQUAD, fromId));
  if (!from) return null;
  book.orders.delete(orderKey(SCOPE_SQUAD, fromId));
  const into = book.orders.get(orderKey(SCOPE_SQUAD, intoId));
  if (into) return into;
  from.addressee = intoId;
  book.orders.set(orderKey(SCOPE_SQUAD, intoId), from);
  return from;
}

// split / mergeDetachments: the new squad copies the order of the first listed parent that has one.
// Callers pass parents oldest-first, matching the codebase rule that older squads keep command.
// Parents keep their own orders -- a detachment leaving does not disarm the squad it left.
export function inheritOrderForNewSquad(book, newSquadId, parentIds = []) {
  if (!book || newSquadId == null) return null;
  for (const parentId of parentIds) {
    const parent = book.orders.get(orderKey(SCOPE_SQUAD, parentId));
    if (!parent) continue;
    const copy = {
      ...parent, id: ++book.seq, addressee: newSquadId,
      goal: { x: parent.goal.x, z: parent.goal.z }, arrived: false,
    };
    book.orders.set(orderKey(SCOPE_SQUAD, newSquadId), copy);
    return copy;
  }
  return null;
}

// A bot leaving one squad for another keeps nothing of its own; it inherits by resolving the new
// squad's order. Its personal order, if it has one, is untouched and still outranks that.
export function ordersForTeam(book, teamId) {
  const out = [];
  if (!book) return out;
  for (const order of book.orders.values()) if (order.teamId === teamId) out.push(order);
  return out;
}

// --- compliance --------------------------------------------------------------------------
// Why a squad is not doing what it was told. Without this an order that is being obeyed and an order
// that was never heard look identical from a map, which is the whole failure mode of commanding
// bodies you cannot see.
export const COMPLY_NO_ORDER = 'no-order';
export const COMPLY_MOVING = 'moving';
export const COMPLY_HOLDING = 'holding';
export const COMPLY_FIGHTING = 'fighting';   // engaged, and the order did not say break contact
export const COMPLY_PINNED = 'pinned';       // in cover under fire
export const COMPLY_BROKEN = 'broken';       // fleeing or wounded: immune to orders by design
export const COMPLY_NO_PATH = 'no-path';     // heard it, cannot reach it

export function describeCompliance(order, { engaged = false, fleeing = false, pinned = false,
  pathFailed = false } = {}) {
  if (!order) return COMPLY_NO_ORDER;
  if (fleeing) return COMPLY_BROKEN;
  if (pathFailed) return COMPLY_NO_PATH;
  if (engaged && !order.breakContact) return COMPLY_FIGHTING;
  if (pinned) return COMPLY_PINNED;
  if (order.kind === ORDER_HOLD && order.arrived) return COMPLY_HOLDING;
  return COMPLY_MOVING;
}
