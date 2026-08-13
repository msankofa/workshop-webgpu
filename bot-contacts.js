// bot-contacts.js — pure, THREE-free per-bot contact memory: what ONE bot personally remembers about
// each enemy it has recently perceived (last known x/z, when, and whether it's visible right now).
// Node-tested in test-bot-contacts.mjs; consumed by bot-viewer-v2.html's selectBotTarget.
// A record is {x, z, lastSeenAt, visible}; recency decay is computed on read (no timers), same
// convention as bot-danger.js. Per-bot, not team-scoped: squad-wide sighting sharing already has its
// own channel (recordContact/latestContactNear in bot-alert.js) -- this is one bot's own eyes only.

export const CONTACT_MEMORY_MAX_ENTRIES = 12;   // per bot; overflow evicts the least-recently-seen
export const CONTACT_MEMORY_MAX_AGE_MS = 20000; // a contact not re-seen this long is forgotten outright

export function createContactMemory() { return new Map(); }

// Upsert a confirmed sighting of `id` at (x, z). Re-inserting keeps Map order = sight recency, so
// the overflow evictor below can just drop the head. `visible: true` is the caller's assertion that
// this really is a this-instant sighting, not a inferred/aged position.
export function recordContactSighting(contacts, id, x, z, now) {
  if (!contacts || id == null) return;
  contacts.delete(id);
  contacts.set(id, { x, z, lastSeenAt: now, visible: true });
  while (contacts.size > CONTACT_MEMORY_MAX_ENTRIES) {
    const oldest = contacts.keys().next();
    if (oldest.done) break;
    contacts.delete(oldest.value);
  }
}

// Flip every remembered contact NOT confirmed this scan to hidden (position/lastSeenAt untouched --
// visibility is a this-instant fact; only the confidence in WHERE decays from here). `seenIds` is
// this scan's confirmed-sighting id set. Also prunes anything too old to matter.
export function markContactsUnseen(contacts, seenIds, now, maxAgeMs = CONTACT_MEMORY_MAX_AGE_MS) {
  if (!contacts) return;
  for (const [id, rec] of contacts) {
    if (seenIds?.has(id)) continue;
    rec.visible = false;
  }
  pruneContacts(contacts, now, maxAgeMs);
}

// Drop contacts not re-seen in maxAgeMs. Mirrors bot-danger.js's prune-on-write convention.
export function pruneContacts(contacts, now, maxAgeMs = CONTACT_MEMORY_MAX_AGE_MS) {
  if (!contacts) return;
  for (const [id, rec] of contacts) if (now - rec.lastSeenAt > maxAgeMs) contacts.delete(id);
}

// Recency confidence in [0, 1]: 1 when just seen, decaying linearly to 0 over windowMs. Backwards
// clocks (age <= 0) read as fully fresh, same guard as bot-alert.js's dangerDecay-style helpers.
export function contactRecency(rec, now, windowMs) {
  if (!rec || !(windowMs > 0)) return 0;
  const age = now - rec.lastSeenAt;
  if (!(age > 0)) return 1;
  return Math.max(0, 1 - age / windowMs);
}

export function deleteContact(contacts, id) { contacts?.delete(id); }
