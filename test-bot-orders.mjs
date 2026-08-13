// Node tests for bot-orders.js (the order book: plurality, lifecycle, inheritance, compliance).
// Run: node test-bot-orders.mjs
import {
  ORDER_MOVE, ORDER_HOLD, SCOPE_SQUAD, SCOPE_BOT,
  createOrderBook, issueOrder, getOrder, cancelOrder, resolveOrderFor, orderMoverId,
  completeOrder, pruneOrders, transferOrderOnMerge, inheritOrderForNewSquad, ordersForTeam,
  describeCompliance, COMPLY_NO_ORDER, COMPLY_MOVING, COMPLY_HOLDING, COMPLY_FIGHTING,
  COMPLY_PINNED, COMPLY_BROKEN, COMPLY_NO_PATH,
} from './bot-orders.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const at = (x, z) => ({ x, z });

// ---- plurality: the whole point of replacing the single command slot ----
{
  const book = createOrderBook();
  issueOrder(book, { addressee: 'squad-1', goal: at(10, 0), teamId: 'red' });
  issueOrder(book, { addressee: 'squad-2', goal: at(-10, 0), teamId: 'red' });
  issueOrder(book, { addressee: 'squad-3', goal: at(0, 20), teamId: 'blue' });
  ok(book.orders.size === 3, 'three squads hold three orders at once');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-1').goal.x === 10, 'ordering squad 2 does not erase squad 1');
  ok(ordersForTeam(book, 'red').length === 2, 'orders can be listed per team');

  const re = issueOrder(book, { addressee: 'squad-1', goal: at(99, 0), kind: ORDER_HOLD });
  ok(book.orders.size === 3 && re.goal.x === 99 && re.kind === ORDER_HOLD,
    're-ordering the same squad replaces rather than stacks');
  ok(re.id > 3, 'every issue gets a fresh id, so a late ack can be told from a live one');
}

// ---- validation ----
{
  const book = createOrderBook();
  ok(issueOrder(book, { addressee: 'squad-1' }) === null, 'an order with no goal is refused');
  ok(issueOrder(book, { addressee: 'squad-1', goal: at(NaN, 0) }) === null, 'a NaN goal is refused');
  ok(issueOrder(book, { addressee: 'squad-1', goal: at(1, 1), kind: 'nuke' }) === null,
    'an unknown order kind is refused rather than stored as a no-op');
  ok(issueOrder(book, { addressee: null, goal: at(1, 1) }) === null, 'an order needs an addressee');
  ok(book.orders.size === 0, 'nothing invalid reached the book');
}

// ---- resolution: who an order applies to ----
{
  const book = createOrderBook();
  issueOrder(book, { addressee: 'squad-1', goal: at(5, 5) });
  ok(resolveOrderFor(book, 'bot-a', 'squad-1').addressee === 'squad-1',
    'a squad order reaches every member, not just the one that was clicked');
  ok(resolveOrderFor(book, 'bot-z', 'squad-9') === null, 'an unordered squad resolves to nothing');
  ok(resolveOrderFor(book, 'bot-z', null) === null, 'a loose bot with no order of its own resolves to nothing');

  issueOrder(book, { scope: SCOPE_BOT, addressee: 'bot-a', goal: at(-3, -3) });
  ok(resolveOrderFor(book, 'bot-a', 'squad-1').scope === SCOPE_BOT,
    'a personal order outranks the squad order -- detaching one bot is deliberate');
  ok(resolveOrderFor(book, 'bot-b', 'squad-1').scope === SCOPE_SQUAD,
    'that personal order does not leak to the rest of the squad');
}

// ---- who actually walks ----
{
  const book = createOrderBook();
  const squadOrder = issueOrder(book, { addressee: 'squad-1', goal: at(5, 5) });
  ok(orderMoverId(squadOrder, { leaderId: 'bot-lead' }) === 'bot-lead',
    'a squad order is walked by the leader; the rest arrive on their formation slots');
  ok(orderMoverId(squadOrder, { leaderId: null }) === null,
    'a leaderless squad has nobody to walk the order, and must not pick one arbitrarily');
  const botOrder = issueOrder(book, { scope: SCOPE_BOT, addressee: 'bot-a', goal: at(1, 1) });
  ok(orderMoverId(botOrder, { leaderId: 'bot-lead' }) === 'bot-a',
    'a personal order is walked by that bot regardless of who leads it');
  ok(orderMoverId(null, { leaderId: 'bot-lead' }) === null, 'no order, no mover');
}

// ---- arrival ----
{
  const book = createOrderBook();
  const move = issueOrder(book, { addressee: 'squad-1', goal: at(5, 5), kind: ORDER_MOVE });
  ok(completeOrder(book, move) === true, 'arriving finishes a move order');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-1') === null, 'a finished move order leaves the book');

  const hold = issueOrder(book, { addressee: 'squad-2', goal: at(5, 5), kind: ORDER_HOLD });
  ok(completeOrder(book, hold) === false, 'arriving does not finish a hold order');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-2') !== null, 'a hold order stays live once reached');
  ok(hold.arrived === true, 'the hold is marked arrived so it stops re-pathing');
  ok(cancelOrder(book, SCOPE_SQUAD, 'squad-2') === true, 'a hold is released by cancelling it');
  ok(cancelOrder(book, SCOPE_SQUAD, 'squad-2') === false, 'cancelling twice reports nothing to cancel');
}

// ---- lifecycle: the dead-commander bug this module exists to kill ----
{
  const book = createOrderBook();
  // The old system keyed the order on one bot and cleared it only on arrival. A hold on a bot that
  // died stayed live forever, and its whole squad kept break-contacting.
  issueOrder(book, { scope: SCOPE_BOT, addressee: 'bot-a', goal: at(5, 5), kind: ORDER_HOLD, breakContact: true });
  const alive = new Set(['bot-b']);
  pruneOrders(book, { hasBot: id => alive.has(id), hasSquad: () => true });
  ok(getOrder(book, SCOPE_BOT, 'bot-a') === null, 'a personal order dies with the bot it named');

  // A squad order must NOT die with its leader: the squad still exists and succession names a new one.
  issueOrder(book, { addressee: 'squad-1', goal: at(5, 5), kind: ORDER_HOLD });
  const liveSquads = new Set(['squad-1']);
  pruneOrders(book, { hasBot: () => false, hasSquad: id => liveSquads.has(id) });
  ok(getOrder(book, SCOPE_SQUAD, 'squad-1') !== null,
    'a squad order outlives the leader that received it -- the successor inherits it');

  liveSquads.delete('squad-1');
  pruneOrders(book, { hasSquad: id => liveSquads.has(id) });
  ok(getOrder(book, SCOPE_SQUAD, 'squad-1') === null, 'a wiped-out squad takes its order with it');
}

// ---- expiry ----
{
  const book = createOrderBook();
  issueOrder(book, { addressee: 'squad-1', goal: at(5, 5), issuedAt: 1000, ttlMs: 500 });
  issueOrder(book, { addressee: 'squad-2', goal: at(5, 5), issuedAt: 1000 });   // no ttl
  pruneOrders(book, { now: 1400 });
  ok(book.orders.size === 2, 'an order inside its ttl survives');
  pruneOrders(book, { now: 1500 });
  ok(getOrder(book, SCOPE_SQUAD, 'squad-1') === null, 'an order past its ttl is dropped');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-2') !== null, 'ttl 0 means the order never expires on its own');
}

// ---- inheritance: merge ----
{
  const book = createOrderBook();
  issueOrder(book, { addressee: 'squad-into', goal: at(1, 1) });
  issueOrder(book, { addressee: 'squad-from', goal: at(9, 9) });
  transferOrderOnMerge(book, 'squad-into', 'squad-from');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-into').goal.x === 1, 'the surviving squad keeps its own order');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-from') === null, 'the absorbed squad leaves no dangling order');

  const book2 = createOrderBook();
  issueOrder(book2, { addressee: 'squad-from', goal: at(9, 9) });
  const moved = transferOrderOnMerge(book2, 'squad-into', 'squad-from');
  ok(moved.addressee === 'squad-into' && getOrder(book2, SCOPE_SQUAD, 'squad-into').goal.x === 9,
    'an unordered squad adopts the order of the one it swallows, so the advance continues');
  ok(book2.orders.size === 1, 'the order moved rather than being duplicated');
  ok(transferOrderOnMerge(book2, 'squad-x', 'squad-nothing') === null, 'merging an unordered squad is a no-op');
}

// ---- inheritance: split and detachments ----
{
  const book = createOrderBook();
  issueOrder(book, { addressee: 'squad-old', goal: at(4, 4), kind: ORDER_HOLD, breakContact: true, teamId: 'red' });
  const child = inheritOrderForNewSquad(book, 'squad-new', ['squad-old']);
  ok(child.goal.x === 4 && child.kind === ORDER_HOLD && child.breakContact === true && child.teamId === 'red',
    'a detachment splitting off carries the order it was already carrying out');
  ok(getOrder(book, SCOPE_SQUAD, 'squad-old') !== null, 'the parent keeps its order too -- a split disarms nobody');
  ok(child.id !== getOrder(book, SCOPE_SQUAD, 'squad-old').id, 'parent and child hold distinct orders');
  child.goal.x = 77;
  ok(getOrder(book, SCOPE_SQUAD, 'squad-old').goal.x === 4, 'the child goal is a copy, not a shared reference');

  const parentHold = getOrder(book, SCOPE_SQUAD, 'squad-old');
  parentHold.arrived = true;
  const child2 = inheritOrderForNewSquad(book, 'squad-new2', ['squad-old']);
  ok(child2.arrived === false, 'the child has not arrived just because its parent had');

  // mergeDetachments has several parents; oldest-first, first one holding an order wins.
  const book3 = createOrderBook();
  issueOrder(book3, { addressee: 'squad-younger', goal: at(8, 8) });
  const picked = inheritOrderForNewSquad(book3, 'squad-child', ['squad-older', 'squad-younger']);
  ok(picked.goal.x === 8, 'a parent with no order is skipped rather than blocking inheritance');
  ok(inheritOrderForNewSquad(book3, 'squad-orphan', ['squad-a', 'squad-b']) === null,
    'no ordered parent means the new squad starts free');
}

// ---- compliance readout ----
{
  const book = createOrderBook();
  const move = issueOrder(book, { addressee: 'squad-1', goal: at(5, 5) });
  ok(describeCompliance(null) === COMPLY_NO_ORDER, 'no order reads as no order, not as disobedience');
  ok(describeCompliance(move, {}) === COMPLY_MOVING, 'a bot with a clear road is moving');
  ok(describeCompliance(move, { engaged: true }) === COMPLY_FIGHTING,
    'an engaged bot is fighting, not deaf -- this is the readout that makes orders feel heard');
  ok(describeCompliance(move, { engaged: true, pinned: true }) === COMPLY_FIGHTING,
    'fighting outranks pinned when both are true');
  ok(describeCompliance(move, { pinned: true }) === COMPLY_PINNED, 'pinned in cover is its own reason');
  ok(describeCompliance(move, { fleeing: true, engaged: true }) === COMPLY_BROKEN,
    'a broken bot outranks every other reason: flee is immune to orders by design');
  ok(describeCompliance(move, { pathFailed: true }) === COMPLY_NO_PATH,
    'heard it and cannot reach it is different from ignoring it');

  const breakOrder = issueOrder(book, { addressee: 'squad-2', goal: at(5, 5), breakContact: true });
  ok(describeCompliance(breakOrder, { engaged: true }) === COMPLY_MOVING,
    'break contact is what lets an order pull a bot out of a fight');

  const hold = issueOrder(book, { addressee: 'squad-3', goal: at(5, 5), kind: ORDER_HOLD });
  ok(describeCompliance(hold, {}) === COMPLY_MOVING, 'a hold order still reads as moving until it arrives');
  hold.arrived = true;
  ok(describeCompliance(hold, {}) === COMPLY_HOLDING, 'once arrived, a hold reads as holding');
}

if (failed) { console.error(`bot-orders: ${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-orders: all assertions passed');
