"use strict";
const { createSnapshotCache } = require("./ppicSnapshotCache");
const integrated = require("./integratedPlanService");
const { businessNow } = require("../../utils/businessClock");
const clients = new WeakMap();
async function seed(prisma, input, options) {
  if (!clients.has(prisma)) clients.set(prisma, createSnapshotCache({
    fingerprint: input => prisma.$transaction(tx => integrated.sourceFingerprint(tx, input.mpsNumber, ["Vendor", "Supplier", "Process", "Customer"]), { isolationLevel: "RepeatableRead", timeout: 30000 }),
    build: input => require("./ppicSandboxService").seed(prisma, input)
  }));
  const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(businessNow());
  const key = JSON.stringify(["material-consumption-netting-v6-delivery-divisions", input.mpsNumber, input.user?.id, input.user?.username, input.user?.email, businessDate]);
  return clients.get(prisma)(key, input, options);
}
module.exports = { seed };
