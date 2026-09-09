"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isVendorPrProtected, syncVendorProcessDraftPrForPlan } = require("../src/prisma/services/planning/vendorProcessPrService");
const { fingerprint, decorate } = require("../src/prisma/services/purchasing/etaConfirmationStore");
const { loaders, period } = require("../src/prisma/services/purchasing/etaMonitorService");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/production/VendorProcessOrderController.js"), "utf8");
const generationSource = controller.slice(controller.indexOf("async function generateVendorProcessOrdersFromRouting("), controller.indexOf("async function resolveVendorSendReadiness("));
const routeId = "route-paint";
const operation = {
  process: { id: routeId }, detail: { id: "detail", uomCode: "PCS" }, sequence: 10,
  vendor: { vendorCode: "BOM-VENDOR" }, qtyPlanned: 1000,
  inputPart: { id: "part", partCode: "CHILD" }, outputPart: { id: "part", partCode: "CHILD" },
  inputIdentity: {}, outputIdentity: {}, stockType: "WIP",
};
const makeAllocation = (id, routingMode, qty = 400) => ({
  id, mbomProcessId: routeId, lineNumber: 1, routingMode, plannedQty: qty, expectedReturnQty: qty,
  scheduleDate: new Date("2026-09-10T00:00:00Z"), vendorReturnDate: new Date("2026-09-12T00:00:00Z"),
  vendorId: routingMode === "VENDOR" ? "vendor" : null,
  vendor: routingMode === "VENDOR" ? { id: "vendor", vendorCode: "ACTUAL-VENDOR", vendorName: "Actual" } : null,
  mbomProcess: { processId: "PAINT", process: { processCode: "PAINT" }, mbomDetail: { part: { partCode: "CHILD" } } },
});

async function generate(allocations, options = {}) {
  let allocationQuery;
  const created = [];
  const context = {
    Set, Map, Date,
    toNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    roundQuantity: (value) => Math.round(Number(value) * 1e6) / 1e6,
    inferStartSequenceFromSourcePartCode: () => 0,
    getVendorRoutingOperations: async () => ({ mbomHeader: { id: "bom", noReg: "BOM" }, operations: [operation] }),
    getRoutingOperations: async () => ({ operations: [] }),
    generateVendorProcessOrderNumber: async () => `VPO-${created.length + 1}`,
    resolveVendorPriceSnapshot: async () => ({}), WIP_STOCK_TYPE: "WIP",
  };
  vm.createContext(context);
  vm.runInContext(`${generationSource}\nthis.generate = generateVendorProcessOrdersFromRouting;`, context);
  const tx = {
    productionPlanAllocation: { findMany: async (query) => { allocationQuery = query; return allocations; } },
    vendorProcessOrder: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return data; } },
  };
  const result = await context.generate(tx, { id: "mo", moNumber: "MO", partId: "fg", qtyPlanned: 1000, monthlyProductionPlanNumber: "MPP", monthlyProductionPlanLineNumber: 1 }, options);
  assert.equal(allocationQuery.where.planningMode, "PRODUCTION", "simulation allocations cannot choose the actual executor");
  assert.equal(allocationQuery.where.routingMode, undefined, "both modes must suppress BOM fallback");
  assert(allocationQuery.where.OR.some((scope) => scope.mbomProcess?.noReg === "BOM"), "exploded child lines stay scoped to the exact BOM");
  return result.created;
}

function basePr(overrides = {}) {
  return { id: "pr", prNumber: "PR", status: "Draft", notes: "[CAPACITY-VENDOR-PR:MPP:ACTUAL-VENDOR]", details: [{ id: "detail", orderedQty: 0, sources: [{ sourceType: "CAPACITY_ALLOCATION", sourceNumber: "a" }] }], ...overrides };
}

function autoProposalPr() {
  return basePr({ sourceType: "SYSTEM", details: [{
    id: "detail", orderedQty: 0, notes: "[CAPACITY-ALLOCATION:a] Vendor process",
    sources: [{ sourceType: "CAPACITY_ALLOCATION", sourceNumber: "a" }],
    sourcingAllocations: [{ status: "Confirmed", confirmedBy: "capacity-planning", confirmedAt: new Date(), notes: "[CAPACITY-ALLOCATION:a] Vendor dan delivery dipilih PPIC di Capacity Planning." }],
  }] });
}

async function syncAutomaticProposal() {
  const original = autoProposalPr();
  const writes = [];
  const capture = (model) => async ({ data }) => { writes.push({ model, data }); return data; };
  const tx = {
    monthlyProductionPlan: { findFirst: async () => ({ id: "plan", planNumber: "MPP", details: [{ lineNumber: 1, partId: "part", partCode: "CHILD" }], manualAllocations: [makeAllocation("b", "VENDOR", 250)] }) },
    vendorPriceList: { findMany: async () => [] },
    purchaseRequisition: { findMany: async () => [original], update: capture("pr"), create: async () => { throw new Error("refresh should preserve the existing Draft PR"); } },
    purchaseRequisitionDetail: { updateMany: capture("retire-detail"), create: capture("detail") },
    purchaseRequisitionSource: { updateMany: capture("retire-source") },
    purchaseRequisitionSourcingAllocation: { updateMany: capture("retire-sourcing") },
  };
  const result = await syncVendorProcessDraftPrForPlan(tx, "plan", "tester");
  assert.equal(result.updated[0].prNumber, "PR");
  assert.equal(result.warnings.length, 0);
  const replacement = writes.find(write => write.model === "detail").data;
  assert.equal(replacement.qty, 250, "unconfirmed PPIC proposal follows revised vendor quantity");
  assert.equal(replacement.sources.create[0].sourceNumber, "b", "draft PR tracks the replacement allocation");
  assert(writes.some(write => write.model === "retire-sourcing" && write.data.isDeleted), "old system proposal is retired with the old PR detail");
}

async function syncProtectedPr() {
  const original = basePr({ details: [{ id: "detail", orderedQty: 0, sources: [{ sourceType: "CAPACITY_ALLOCATION", sourceNumber: "a" }], poDetails: [{ po: { status: "Draft", poNumber: "PO" } }] }] });
  let writes = 0;
  const forbidden = async () => { writes += 1; throw new Error("protected PR must not be rewritten"); };
  const tx = {
    monthlyProductionPlan: { findFirst: async () => ({ id: "plan", planNumber: "MPP", details: [{ lineNumber: 1, partId: "part" }], manualAllocations: [makeAllocation("a", "VENDOR")] }) },
    vendorPriceList: { findMany: async () => [] },
    purchaseRequisition: { findMany: async () => [original], update: forbidden, create: forbidden },
    purchaseRequisitionDetail: { updateMany: forbidden, create: forbidden },
    purchaseRequisitionSource: { updateMany: forbidden },
    purchaseRequisitionSourcingAllocation: { updateMany: forbidden },
  };
  const result = await syncVendorProcessDraftPrForPlan(tx, "plan", "tester");
  assert.equal(writes, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.created.length + result.updated.length + result.removed.length, 0);
  // Removing the original vendor allocation must still preserve its purchasing history.
  tx.monthlyProductionPlan.findFirst = async () => ({ id: "plan", planNumber: "MPP", details: [], manualAllocations: [] });
  await syncVendorProcessDraftPrForPlan(tx, "plan", "tester");
  assert.equal(writes, 0);
}

(async () => {
  assert.equal((await generate([makeAllocation("a", "INHOUSE", 1000)])).length, 0, "full in-house replacement must not generate a vendor order");
  const split = await generate([makeAllocation("a", "INHOUSE", 600), makeAllocation("b", "VENDOR", 400)]);
  assert.equal(split.length, 1);
  assert.equal(split[0].qtyPlanned, 400, "600 internal + 400 vendor must generate only the outsourced 400");
  assert.equal(split[0].vendorCode, "ACTUAL-VENDOR");
  assert.match(split[0].notes, /\[CAPACITY-VENDOR:b\]/);
  assert.equal((await generate([makeAllocation("a", "VENDOR", 0)])).length, 0, "explicit zero allocation must never fall back to 1000");
  assert.equal((await generate([], { capacityAllocationIds: ["missing"] })).length, 0, "selected publish must not generate unrelated BOM work");
  const selected = await generate([makeAllocation("a", "VENDOR", 100), makeAllocation("b", "VENDOR", 300)], { capacityAllocationIds: ["b"] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].qtyPlanned, 300);
  assert.equal((await generate([]))[0].qtyPlanned, 1000, "legacy MO without explicit planning retains BOM default");

  assert.equal(isVendorPrProtected(basePr()), false);
  assert.equal(isVendorPrProtected(basePr({ status: "Approved" })), true);
  assert.equal(isVendorPrProtected(basePr({ status: "Cancelled" })), false, "cancelled PR no longer reserves the allocation");
  assert.equal(isVendorPrProtected(basePr({ status: "Rejected" })), false);
  assert.equal(isVendorPrProtected(basePr({ details: [{ orderedQty: 1 }] })), true, "legacy ordered counter protects demand");
  assert.equal(isVendorPrProtected(basePr({ purchaseOrders: [{ po: { status: "Draft" } }] })), true, "header-only PO links protect legacy PRs");
  assert.equal(isVendorPrProtected(basePr({ details: [{ poDetails: [{ po: { status: "Draft" } }] }] })), true);
  assert.equal(isVendorPrProtected(basePr({ details: [{ poDetails: [{ po: { status: "Cancelled" } }, { po: { status: "Approved", isDeleted: true } }] }] })), false);
  assert.equal(isVendorPrProtected(basePr({ details: [{ sourcingAllocations: [{ status: "Confirmed" }] }] })), true);
  assert.equal(isVendorPrProtected(basePr({ details: [{ sourcingAllocations: [{ status: "Cancelled", confirmedAt: new Date() }, { status: "Ordered", isDeleted: true }] }] })), false);
  assert.equal(isVendorPrProtected(autoProposalPr()), false, "automatic PPIC choice is a refreshable proposal");
  for (const change of [
    row => { row.details[0].sourcingAllocations[0].confirmedBy = "purchasing-user"; },
    row => { row.details[0].sourcingAllocations[0].status = "Ordered"; },
    row => { row.details[0].sourcingAllocations[0].poNumber = "PO-1"; },
    row => { row.details[0].orderedQty = 1; },
    row => { row.details[0].supplierConfirmedAt = new Date(); },
    row => { row.details[0].supplierConfirmedBy = "purchasing-user"; },
    row => { row.details[0].sourcingAllocations[0].notes = "manual confirmation"; },
    row => { row.details[0].sourcingAllocations[0].notes = "[CAPACITY-ALLOCATION:other] unrelated allocation"; },
    row => { row.purchaseOrders = [{ po: { status: "Draft" } }]; },
  ]) {
    const changed = autoProposalPr(); change(changed);
    assert.equal(isVendorPrProtected(changed), true, "real commitment or mismatched system provenance must stay protected");
  }
  await syncProtectedPr();
  await syncAutomaticProposal();

  const vendor = { ...makeAllocation("a", "VENDOR", 400), planId: "plan", plan: { planNumber: "MPP", periodStart: new Date("2026-09-01T00:00:00Z") }, updatedAt: new Date("2026-09-01T00:00:00Z"), latestFinishDate: "2026-09-15" };
  const vendorRows = await loaders["vendor-plans"]({ productionPlanAllocation: { findMany: async () => [vendor] } }, period("2026-09"));
  assert.equal(vendorRows[0].href, "/modules/planning-ppic/monthly-production-plans?planNumber=MPP&month=2026-09");
  const previous = { sourceFingerprint: fingerprint(vendorRows[0]), qty: 400, eta: new Date("2026-09-12T00:00:00Z") };
  assert.equal(decorate(vendorRows[0], previous).confirmed, true);
  assert.equal(decorate({ ...vendorRows[0], sourceVersion: "changed-after-replan" }, previous).confirmed, false, "a replan must invalidate the old ETA commitment");
  console.log("PASS Monthly executor documents: vendor-only quantities, BOM fallback, exact batch publish, purchasing commitments, ETA link and confirmation invalidation.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
