"use strict";
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
const evidence = require("../src/prisma/services/planning/mpsProductionEvidenceService");
const eta = require("../src/prisma/services/planning/mpsEtaService");
const store = require("../src/prisma/services/purchasing/etaConfirmationStore");
const procurement = require("../src/prisma/services/planning/procurementSchedulingService");
const policy = { prApprovalDays: 1, poProcessingDays: 2, transitDays: 0, receivingQcDays: 1, safetyLeadTimeDays: 1, holidays: [] };
const material = { partCode: "RAW", materialCode: "STEEL", supplierCode: "S1", supplierItemId: "SI1", supplierLeadTimeDays: 7,
  qty: 12, shortageQty: 2, uomCode: "kg", materialSupplyType: "SUPPLIER_PURCHASE", requiredDate: "2026-09-18",
  latestPrDate: "2026-09-01", latestPoDate: "2026-09-04", supplierRequiredArrivalDate: "2026-09-16", procurementPolicy: policy };
const process = { sequence: 20, processCode: "PLATE", vendorCode: "V1", routingMode: "VENDOR", baselineDurationDays: 9,
  solverTaskId: "PROCESS_1", latestStartDate: "2026-09-18", latestFinishDate: "2026-09-21" };
const phase = { phaseId: "P1", complete: true, plannedProductionQty: 10, fgRequiredDate: "2026-09-22", customerDeliveryDate: "2026-09-25",
  materialCoverage: [material, { ...material, partCode: "BOLT", materialCode: null, supplierItemId: null, shortageQty: 3 },
    { ...material, partCode: "CUSTOMER-RAW", materialSupplyType: "CUSTOMER_SUPPLIED", supplyCustomerCode: "C1", supplierCode: null, supplierItemId: null, supplierLeadTimeDays: 4, shortageQty: 5 }],
  processTimeline: [process], solver: { forward: { tasks: [{ id: "PROCESS_1", endDate: "2026-09-20" }] } } };
function document(number = "MPS-SEP", changes = {}) {
  return { mpsNumber: number, sourceKey: "MONTH:2026-09", revision: 3, status: "Draft", isDeleted: false,
    periodStart: "2026-09-01", periodEnd: "2026-09-30", details: [{ id: `${number}-D`, partCode: "FG", qtyPlanned: 10, mbomHeaderId: "BOM1",
      calculationTrace: { productionChecksheet: { version: evidence.VERSION, mpsRevision: 3, sourceKey: "CURRENT", mbomHeaderId: "BOM1", phases: { PHASE: structuredClone(phase) } } } }], ...changes };
}
const header = { id: "BOM1", noReg: "MBOM-1", details: [
  { id: "PARENT", qty: 2, part: { partCode: "ASSEMBLY" }, mbomProcesses: [] },
  { id: "CHILD", parentDetailId: "PARENT", qty: 3, uomCode: "pcs", part: { partCode: "CHILD", partNumber: "CHILD-001", partName: "Plated child" },
    mbomProcesses: [{ id: "ROUTE", sequence: 20, process: { processCode: "PLATE" }, vendor: { vendorCode: "V1", vendorName: "Plating Co", leadTimeDays: 2 } }] },
] };
const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name[0].toLowerCase() + m.name.slice(1), m]));
function checkFields(model, selection) {
  for (const [name, option] of Object.entries(selection || {})) {
    const field = model.fields.find((f) => f.name === name);
    assert.ok(field, `${model.name}.${name} exists in generated Prisma schema`);
    if (option && typeof option === "object" && field.kind === "object") {
      const target = Prisma.dmmf.datamodel.models.find((m) => m.name === field.type);
      checkFields(target, option.select || option.include);
    }
  }
}
function mockDb(docs) {
  const reads = [], confirmations = [];
  const fixtures = {
    part: [{ partCode: "RAW", partNumber: "RAW-001", partName: "Raw strip", itemType: "RAW", rawType: "MATERIAL", category: "PD" },
      { partCode: "BOLT", partNumber: "BOLT-001", partName: "Bolt", itemType: "RAW", rawType: "PURCHASE_PART", hasDrawing: false }],
    material: [{ materialCode: "STEEL", materialName: "Steel sheet", itemCategory: "METAL" }],
    supplier: [{ supplierCode: "S1", supplierName: "Steel Supplier", leadTimeDays: 8 }],
    supplierItem: [{ id: "SI1", leadTimeDays: 7 }], customer: [{ customerCode: "C1", customerName: "Customer One" }],
    vendor: [{ vendorCode: "V1", vendorName: "Plating Co", leadTimeDays: 2 }], mBOMHeader: [header],
  };
  const db = new Proxy({}, { get(_target, name) {
    assert.ok(name === "mPS" || name === "etaConfirmation" || Object.hasOwn(fixtures, name), `unexpected DB model ${String(name)} (no MRP/PS/prerequisite reads)`);
    return new Proxy({}, { get(_model, operation) {
      assert.ok(["findMany", "findFirst"].includes(operation), `mutation forbidden: ${name}.${operation}`);
      return async (args) => {
        reads.push({ name, args }); checkFields(models.get(name), args.select || args.include);
        if (name === "mPS") return operation === "findFirst" ? docs.find((d) => d.mpsNumber === args.where.mpsNumber) : docs;
        if (name === "etaConfirmation") return confirmations;
        const [field, filter] = Object.entries(args.where).find(([, v]) => v?.in);
        return fixtures[name].filter((r) => filter.in.includes(r[field]));
      };
    } });
  } });
  return { db, reads, confirmations, fixtures };
}
(async () => {
  const originalKey = evidence.sourceKey, originalSchedule = procurement.procurementSchedule;
  evidence.sourceKey = async () => "CURRENT";
  try {
    const doc = document();
    const other = document("MPS-OTHER", { sourceKey: "LEGACY" });
    const mock = mockDb([other, doc]);
    const initial = await eta.list(mock.db, "2026-09");
    assert.equal(initial.selectedMpsNumber, "MPS-SEP");
    assert.equal(initial.documents.length, 2);
    assert.equal(initial.documents.find((d) => d.mpsNumber === "MPS-OTHER").eta, null, "unselected header must not claim ready");
    assert.equal(initial.items.length, 4);
    assert.ok(initial.items.every((r) => r.source === "MPS-SEP" && r.eta === null && !r.confirmed && !r.readiness.ready));
    const [raw, bolt, customer, vendor] = initial.items;
    assert.equal(raw.partNumber, "RAW-001"); assert.equal(raw.name, "Steel sheet"); assert.equal(raw.masterCategory, "PD");
    assert.equal(raw.partner, "Steel Supplier"); assert.equal(raw.leadTime, 7); assert.equal(raw.qty, 2);
    assert.equal(raw.purchaseMaxDate, "2026-09-04"); assert.notEqual(raw.purchaseMaxDate, material.latestPrDate);
    assert.equal(raw.targetArrivalDate, "2026-09-16"); assert.equal(raw.needDate, "2026-09-18");
    assert.equal(raw.customerDeliveryDate, "2026-09-25"); assert.notEqual(raw.customerDeliveryDate, raw.fgRequiredDate);
    assert.deepEqual(raw.procurementPolicy, policy);
    assert.equal(bolt.category, "UNIVERSAL_PART"); assert.equal(bolt.leadTime, 8);
    assert.equal(customer.category, "CUSTOMER"); assert.equal(customer.partner, "Customer One"); assert.equal(customer.leadTime, 4);
    assert.equal(customer.purchaseMaxDate, null); assert.deepEqual(customer.procurementPolicy, { transitDays: 0, receivingQcDays: 1, safetyLeadTimeDays: 1, holidays: [] });
    assert.equal(customer.supplyPoolKey, "CUSTOMER:C1|STEEL|kg");
    const noCustomerLeadTime = structuredClone(doc);
    const customerMaterial = noCustomerLeadTime.details[0].calculationTrace.productionChecksheet.phases.PHASE.materialCoverage[2];
    customerMaterial.supplierLeadTimeDays = 0;
    assert.equal(eta.buildRows(noCustomerLeadTime, "CURRENT")[2].leadTime, null, "default feasibility zero is not a customer master lead time");
    customerMaterial.customerSupplyLeadTimeDays = 0;
    assert.equal(eta.buildRows(noCustomerLeadTime, "CURRENT")[2].leadTime, null, "legacy copied zero still lacks explicit provenance");
    customerMaterial.customerSupplyLeadTimeSource = "EXPLICIT";
    assert.equal(eta.buildRows(noCustomerLeadTime, "CURRENT")[2].leadTime, 0, "explicit zero remains valid data");
    assert.equal(vendor.code, "CHILD"); assert.equal(vendor.partNumber, "CHILD-001"); assert.equal(vendor.qty, 60);
    assert.equal(vendor.leadTime, 2); assert.equal(vendor.eta, null); assert.equal(vendor.uom, "pcs"); assert.equal(vendor.canConfirm, true);
    const selected = await eta.list(mock.db, "2026-09", "MPS-OTHER");
    assert.equal(selected.selectedMpsNumber, "MPS-OTHER"); assert.ok(selected.items.every((r) => r.source === "MPS-OTHER"));
    await assert.rejects(() => eta.list(mock.db, "2026-09", "MISSING"), { code: "MPS_ETA_SELECTION_INVALID" });
    for (const invalid of [document("BAD", { isDeleted: true }), document("BAD", { periodStart: "2026-10-01", periodEnd: "2026-10-31" }), document("BAD", { status: "Cancelled" })]) {
      await assert.rejects(() => eta.list(mockDb([invalid]).db, "2026-09", "BAD"), { code: "MPS_ETA_SELECTION_INVALID" });
    }
    assert.equal((await eta.list(mockDb([]).db, "2026-09")).selectedMpsNumber, null);
    assert.equal((await eta.list(mockDb([other]).db, "2026-09")).selectedMpsNumber, "MPS-OTHER");
    const ambiguous = await eta.list(mockDb([other, document("LEGACY2", { sourceKey: "LEGACY2" })]).db, "2026-09");
    assert.equal(ambiguous.selectedMpsNumber, null); assert.deepEqual(ambiguous.items, []);
    assert.equal((await eta.list(mockDb([document("SIM", { simulationOnly: true })]).db, "2026-09")).selectedMpsNumber, null);
    await assert.rejects(() => eta.list(mock.db, "2026-13"));
    await assert.rejects(() => eta.list(mockDb(Array.from({ length: 101 }, (_, i) => document(`MPS-${i}`))).db, "2026-09"));

    for (const change of [d => { d.revision++; }, d => { d.replanRequired = true; }, d => { d.details[0].mbomHeaderId = "CHANGED"; },
      d => { d.details[0].qtyPlanned++; }, d => { d.details[0].calculationTrace.productionChecksheet.phases.PHASE.error = { message: "failed" }; },
      d => { d.details[0].calculationTrace.productionChecksheet.sourceKey = "OLD"; }]) {
      const changed = structuredClone(doc); change(changed);
      const rows = eta.buildRows(changed, "CURRENT");
      assert.equal(rows.length, 1); assert.equal(rows[0].category, "CHECKSHEET"); assert.equal(rows[0].canConfirm, false);
    }
    const noIdentity = eta.buildRows(doc, "CURRENT").find((r) => r.category === "VENDOR");
    assert.equal(noIdentity.qty, null); assert.equal(noIdentity.code, null); assert.equal(noIdentity.canConfirm, false);
    const duplicate = structuredClone(header); duplicate.details.push({ ...duplicate.details[1], id: "AMBIGUOUS" });
    const unresolved = eta.buildRows(doc, "CURRENT", { headers: new Map([[header.id, duplicate]]) }).find((r) => r.category === "VENDOR");
    assert.equal(unresolved.canConfirm, false);
    const legacy = structuredClone(doc); const oldPhase = legacy.details[0].calculationTrace.productionChecksheet.phases.PHASE;
    delete oldPhase.customerDeliveryDate; delete oldPhase.materialCoverage[0].latestPoDate; delete oldPhase.materialCoverage[0].supplierRequiredArrivalDate;
    const legacyRow = eta.buildRows(legacy, "CURRENT")[0];
    assert.equal(legacyRow.customerDeliveryDate, null); assert.equal(legacyRow.purchaseMaxDate, null); assert.equal(legacyRow.targetArrivalDate, null);
    const supplierMissing = mockDb([doc]); supplierMissing.fixtures.supplier[0].leadTimeDays = null; supplierMissing.fixtures.supplierItem[0].leadTimeDays = null;
    assert.equal((await eta.list(supplierMissing.db, "2026-09")).items[0].leadTime, null, "missing master LT must not turn into an estimated or zero commitment");

    let scheduled = 0;
    procurement.procurementSchedule = async (args) => {
      scheduled++; assert.equal(args.materialRequiredDate, raw.needDate); assert.equal(args.supplierLeadTimeDays, 3);
      for (const [k, v] of Object.entries(policy)) assert.deepEqual(args[k], v);
      return { latestPoDate: "2026-09-11", latestPrDate: "2026-09-08" };
    };
    mock.confirmations.push({ id: "CONF", sourceKey: raw.id, sourceFingerprint: raw.sourceFingerprint, qty: raw.qty,
      eta: "2026-09-15", readyDate: "2026-09-17", sourceSnapshot: { leadTimeDays: 3 } });
    const confirmed = (await eta.list(mock.db, "2026-09")).items[0];
    assert.equal(confirmed.leadTime, raw.leadTime); assert.equal(confirmed.sourceFingerprint, raw.sourceFingerprint);
    assert.equal(confirmed.needDate, raw.needDate); assert.equal(confirmed.targetArrivalDate, raw.targetArrivalDate);
    assert.equal(confirmed.confirmedLeadTimeDays, 3); assert.equal(confirmed.confirmationRecord.leadTimeDays, 3);
    assert.equal(confirmed.purchaseMaxDate, "2026-09-11"); assert.equal(confirmed.readiness.ready, true); assert.equal(scheduled, 1);
    assert.notEqual(store.fingerprint({ ...raw, requiredQty: 3 }), raw.sourceFingerprint);
    assert.notEqual(store.fingerprint({ ...raw, phaseKey: "NEW", id: `${raw.id}:NEW` }), raw.sourceFingerprint);
    const staleRecord = store.decorate({ ...raw, stale: true }, mock.confirmations[0]);
    assert.equal(staleRecord.confirmed, false); assert.equal(staleRecord.canConfirm, false);

    let schedules = 0;
    const coverage = [{ ...material, procurementLeadTimeBreakdown: { ...policy, supplierLeadTimeDays: 7 } },
      { ...material, materialSupplyType: "CUSTOMER_SUPPLIED", supplierLeadTimeDays: 4 }];
    const enriched = await evidence.materialEtaEvidence(coverage, async (args) => {
      schedules++; assert.equal(args.supplierLeadTimeDays, 7); assert.equal(args.materialRequiredDate, material.requiredDate);
      return { supplierRequiredArrivalDate: "2026-09-16", latestPoDate: "2026-09-04" };
    });
    assert.equal(schedules, 1); assert.equal(enriched[0].latestPoDate, "2026-09-04T00:00:00.000Z");
    assert.deepEqual(enriched[0].procurementPolicy, policy); assert.equal(enriched[0].latestPrDate, material.latestPrDate);
    assert.equal(enriched[1].customerSupplyLeadTimeDays, 4); assert.equal(coverage[0].requiredDate, material.requiredDate);
    const customerDefaults = await evidence.materialEtaEvidence([
      { materialSupplyType: "CUSTOMER_SUPPLIED", supplierLeadTimeDays: 0 },
      { materialSupplyType: "CUSTOMER_SUPPLIED" },
      { materialSupplyType: "CUSTOMER_SUPPLIED", customerSupplyLeadTimeDays: 0, customerSupplyLeadTimeSource: "EXPLICIT" },
    ], async () => { throw new Error("Customer supply must not use supplier scheduling"); });
    assert.deepEqual(customerDefaults.map((r) => r.customerSupplyLeadTimeDays), [null, null, 0]);
    const batch = await eta.forDocuments(mockDb([doc, other]).db, [doc, other], { inputKey: "CURRENT" });
    assert.deepEqual([...new Set(batch.map((r) => r.source))], [doc.mpsNumber, other.mpsNumber], "gate batch interface is preserved");
    console.log("PASS MPS header ETA: isolated selection, schema-valid master reads, supplier/customer/vendor identity and quantities, dates/policy, no fabricated ETA, stale/phase/confirmation invariants; all DB access mocked and read-only.");
  } finally { evidence.sourceKey = originalKey; procurement.procurementSchedule = originalSchedule; }
})().catch((error) => { console.error(error); process.exitCode = 1; });
