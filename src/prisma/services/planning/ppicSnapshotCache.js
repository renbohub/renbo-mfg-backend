"use strict";

// Validation is always read from the source. Only expensive seed construction is
// reused. Pending builds are shared, and a source change during a build prevents
// that result from becoming a reusable snapshot.
function createSnapshotCache({ fingerprint, build, now = Date.now, ttlMs = 30 * 60 * 1000, maxEntries = 8 }) {
  const entries = new Map(), pending = new Map();
  return async function get(key, input, { force = false } = {}) {
    const started = now(), source = await fingerprint(input), checked = now();
    for (const [id, entry] of entries) if (checked-entry.created >= ttlMs) entries.delete(id);
    const previous = entries.get(key);
    const respond = (entry, hit, shared = false) => ({ ...entry.value, cache: {
      hit, shared, createdAt: new Date(entry.created).toISOString(), checkedAt: new Date(checked).toISOString(),
      validationMs: checked-started, requestMs: now()-started
    } });
    if (!force && previous?.source === source) {
      entries.delete(key); entries.set(key, previous);
      return respond(previous, true);
    }
    const pendingKey = JSON.stringify([key, source]);
    if (pending.has(pendingKey)) return respond(await pending.get(pendingKey), false, true);
    entries.delete(key);
    const work = (async () => {
      const value = await build(input), after = await fingerprint(input);
      const entry = { source, value, created: now() };
      if (source === after) {
        entries.delete(key); entries.set(key, entry);
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      return entry;
    })();
    pending.set(pendingKey, work);
    try { return respond(await work, false); }
    finally { pending.delete(pendingKey); }
  };
}
module.exports = { createSnapshotCache };
