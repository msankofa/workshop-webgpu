// Node tests for the per-bot contact memory module.
// Run: node test-bot-contacts.mjs
import {
  createContactMemory, recordContactSighting, markContactsUnseen, pruneContacts, contactRecency,
  deleteContact, CONTACT_MEMORY_MAX_ENTRIES, CONTACT_MEMORY_MAX_AGE_MS,
} from './bot-contacts.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// ---- recordContactSighting: upsert, marks visible, overwrites position ----
{
  const contacts = createContactMemory();
  recordContactSighting(contacts, 'e1', 5, 5, 1000);
  const rec = contacts.get('e1');
  ok(rec.x === 5 && rec.z === 5 && rec.lastSeenAt === 1000 && rec.visible === true, 'first sighting recorded as visible');
  recordContactSighting(contacts, 'e1', 9, 9, 1100);
  const rec2 = contacts.get('e1');
  ok(rec2.x === 9 && rec2.z === 9 && rec2.lastSeenAt === 1100, 're-sighting overwrites position and timestamp');
  ok(contacts.size === 1, 're-sighting the same id does not grow the map');
}

// ---- overflow: least-recently-seen evicted first ----
{
  const contacts = createContactMemory();
  for (let i = 0; i < CONTACT_MEMORY_MAX_ENTRIES; i++) recordContactSighting(contacts, `e${i}`, i, 0, 1000 + i);
  ok(contacts.size === CONTACT_MEMORY_MAX_ENTRIES, 'fills to the cap exactly');
  recordContactSighting(contacts, 'newcomer', 99, 99, 2000);
  ok(contacts.size === CONTACT_MEMORY_MAX_ENTRIES, 'overflow does not grow past the cap');
  ok(!contacts.has('e0'), 'oldest (first-seen) entry is the one evicted');
  ok(contacts.has('newcomer'), 'the new sighting survives the eviction it triggered');
  // Re-sighting an existing contact should refresh its recency order, protecting it from eviction.
  recordContactSighting(contacts, 'e1', 1, 0, 2100); // e1 already exists from the fill loop
  for (let i = 2; i < CONTACT_MEMORY_MAX_ENTRIES; i++) recordContactSighting(contacts, `f${i}`, i, 0, 3000 + i);
  ok(contacts.has('e1'), 're-sighting an entry moves it to the back, protecting it from the next overflow sweep');
}

// ---- markContactsUnseen: only un-confirmed contacts flip to hidden; position/time untouched ----
{
  const contacts = createContactMemory();
  recordContactSighting(contacts, 'e1', 1, 1, 1000);
  recordContactSighting(contacts, 'e2', 2, 2, 1000);
  markContactsUnseen(contacts, new Set(['e1']), 1100);
  ok(contacts.get('e1').visible === true, 're-confirmed contact stays visible');
  ok(contacts.get('e2').visible === false, 'un-confirmed contact flips to hidden');
  ok(contacts.get('e2').x === 2 && contacts.get('e2').lastSeenAt === 1000, 'hidden contact keeps its last known position/time, not overwritten');
}

// ---- pruneContacts / markContactsUnseen aging out ----
{
  const contacts = createContactMemory();
  recordContactSighting(contacts, 'stale', 0, 0, 1000);
  pruneContacts(contacts, 1000 + CONTACT_MEMORY_MAX_AGE_MS - 1);
  ok(contacts.has('stale'), 'not yet pruned just under the max age');
  pruneContacts(contacts, 1000 + CONTACT_MEMORY_MAX_AGE_MS + 1);
  ok(!contacts.has('stale'), 'pruned once past the max age');

  const contacts2 = createContactMemory();
  recordContactSighting(contacts2, 'e1', 0, 0, 1000);
  markContactsUnseen(contacts2, new Set(), 1000 + CONTACT_MEMORY_MAX_AGE_MS + 1);
  ok(!contacts2.has('e1'), 'markContactsUnseen also prunes forgotten contacts, not just flips them hidden');
}

// ---- contactRecency: 1 when fresh, decays linearly to 0, floors at 0, backwards clock reads fresh ----
{
  const contacts = createContactMemory();
  recordContactSighting(contacts, 'e1', 0, 0, 1000);
  const rec = contacts.get('e1');
  ok(contactRecency(rec, 1000, 4000) === 1, 'recency is 1 at the moment of sighting');
  ok(Math.abs(contactRecency(rec, 3000, 4000) - 0.5) < 1e-9, 'recency decays linearly (halfway through the window = 0.5)');
  ok(contactRecency(rec, 5000, 4000) === 0, 'recency floors at 0 past the window, does not go negative');
  ok(contactRecency(rec, 900, 4000) === 1, 'a clock that runs backwards reads as fully fresh, not > 1 or NaN');
  ok(contactRecency(null, 1000, 4000) === 0, 'a missing record reads as zero confidence, not a throw');
}

// ---- deleteContact ----
{
  const contacts = createContactMemory();
  recordContactSighting(contacts, 'e1', 0, 0, 1000);
  deleteContact(contacts, 'e1');
  ok(!contacts.has('e1'), 'deleteContact removes the entry outright');
  deleteContact(contacts, 'never-existed'); // must not throw
  deleteContact(null, 'e1'); // must not throw on a null map
  ok(true, 'deleteContact is a no-op-safe on missing map/id');
}

if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('test-bot-contacts: all passing');
