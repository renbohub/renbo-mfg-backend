"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();
function scopedClient(client) {
  return new Proxy(client, {
    get(target, property) {
      const scope = storage.getStore();
      if (scope && property === "$transaction") return async work => typeof work === "function" ? work(scope.client) : Promise.all(work);
      const owner = scope?.client || target;
      const value = owner[property];
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
}
async function atomic(client, work, { preview = false, timeout = 120000 } = {}) {
  if (storage.getStore()) throw new Error("Integrated planning cannot open a second outer transaction");
  let output, effects = [];
  const rollback = new Error("PPIC_PREVIEW_ROLLBACK");
  try {
    output = await client.$transaction(async tx => storage.run({ client: tx, preview, effects }, async () => {
      const result = await work(tx);
      if (preview) { output = result; throw rollback; }
      return result;
    }), { isolationLevel: "Serializable", timeout });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!preview) for (const effect of effects) { try { effect(); } catch (_) { /* committed result remains authoritative */ } }
  return output;
}
function afterCommit(effect) {
  const scope = storage.getStore();
  if (scope) { if (!scope.preview) scope.effects.push(effect); }
  else effect();
}
module.exports = { scopedClient, atomic, afterCommit, isPreview: () => storage.getStore()?.preview === true, active: () => Boolean(storage.getStore()) };
