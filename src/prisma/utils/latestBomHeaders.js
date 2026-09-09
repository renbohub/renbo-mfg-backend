"use strict";

// Master-list projection only. Planning must still resolve revisions by need date.
function latestBomHeaderIds(headers) {
  const latest = new Map();
  const timestamp = (value) => new Date(value || 0).getTime() || 0;
  function compare(a, b) {
    return Number(a.revision || 0) - Number(b.revision || 0)
      || Number(!a.expiryDate) - Number(!b.expiryDate)
      || timestamp(a.createdAt) - timestamp(b.createdAt)
      || String(a.noReg || a.id).localeCompare(String(b.noReg || b.id));
  }
  for (const row of headers) {
    if (row.isDeleted) continue;
    const key = row.partId ? `part:${row.partId}` : `bom:${row.id}`;
    const previous = latest.get(key);
    if (!previous || compare(row, previous) > 0) latest.set(key, row);
  }
  return [...latest.values()].map((row) => row.id);
}

module.exports = { latestBomHeaderIds };
