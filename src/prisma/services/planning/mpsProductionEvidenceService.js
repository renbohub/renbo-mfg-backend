"use strict";

const { createHash } = require("node:crypto");
const { businessNow } = require("../../utils/businessClock");
const { assessDemandFeasibility } = require("./demandFeasibilityService");
const VERSION = "MPS_PRODUCTION_EVIDENCE_V3_CUSTOMER_SUPPLY";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value) => value ? new Date(value).toISOString() : null;
const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function phaseKey(phase) {
  return hash([phase.id, n(phase.plannedProductionQty), iso(phase.fgRequiredDate || phase.targetDeliveryDate), phase.sourceType]);
}

// Conservative invalidation: a change to any calculation input requires a new
// evaluation. Do not reuse a green check after stock, routing or supplier edits.
async function sourceKey(db) {
  const models = ["stockBalance", "stockReservation", "purchaseOrder", "purchaseOrderDetail", "purchaseRequisition", "purchaseRequisitionDetail", "part", "material", "mBOMHeader", "mBOMDetail", "mBOMProcess", "process", "supplierItem", "supplier", "vendor", "machine", "workCenter", "workCenterMachine", "rccpResourceProfile", "workingHourProfile", "workingHourRule", "shiftMaster", "capacityCalendarOverride", "systemSetting"];
  const versions = [];
  models.push("customerSupplyRequest", "customerSupplyShipment", "customerSupplyReceipt", "customerSupplyIssue");
  for (const model of models) {
    // Issue records are append-only and have createdAt, not updatedAt.
    // Keep their count in the fingerprint, including issues with equal timestamps.
    const timestamp = model === "customerSupplyIssue" ? "createdAt" : "updatedAt";
    versions.push([model, await db[model].aggregate({ _max: { [timestamp]: true }, _count: { _all: true } })]);
  }
  return hash([VERSION, businessNow().toISOString().slice(0, 10), versions]);
}

// Net shared stock/firm receipts once across all production phases, including
// buffer and carryover. A PR or a planned PO is never firm coverage.
function allocateMaterials(entries) {
  const groups = new Map();
  for (const entry of entries) for (const row of entry.materialCoverage || []) {
    const key = row.materialSupplyType === "CUSTOMER_SUPPLIED"
      ? require("./customerSupplyService").poolKey(row)
      : `${row.materialCode || row.partCode}|${String(row.uomCode || "").toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    let stock = Math.max(0, Math.min(...rows.map((row) => n(row.openingQty))));
    const supplies = new Map();
    for (const row of rows) for (const supply of row.supplyEvents || []) {
      if (supply.confidence !== "FIRM") continue;
      const ownedSupply = ["CUSTOMER_SHIPMENT", "CUSTOMER_STOCK"].includes(supply.sourceType);
      if (row.materialSupplyType === "CUSTOMER_SUPPLIED"
        ? !ownedSupply || !row.supplyCustomerCode || supply.supplyCustomerCode !== row.supplyCustomerCode
        : ownedSupply) continue;
      const key = supply.id || `${supply.sourceType}|${supply.sourceNumber}|${iso(supply.availableDate)}|${supply.qty}`;
      if (!supplies.has(key)) supplies.set(key, { ...supply, remaining: Math.max(n(supply.qty), 0) });
    }
    for (const row of rows.sort((a, b) => new Date(a.requiredDate) - new Date(b.requiredDate))) {
      if (!row.requiredDate || !Number.isFinite(new Date(row.requiredDate).getTime())) {
        row.shortageQty = null;
        delete row.supplyEvents;
        continue;
      }
      let shortage = Math.max(n(row.qty), 0);
      const used = Math.min(stock, shortage);
      stock -= used;
      shortage -= used;
      const allocated = [];
      {
        for (const supply of supplies.values()) {
          if (!supply.availableDate || !Number.isFinite(new Date(supply.availableDate).getTime()) || new Date(supply.availableDate) > new Date(row.requiredDate)) continue;
          const receipt = Math.min(supply.remaining, shortage);
          supply.remaining -= receipt;
          shortage -= receipt;
          if (receipt > 0) allocated.push({ ...supply, qty: receipt, remaining: undefined });
        }
      }
      row.shortageQty = Math.max(shortage, 0);
      row.eligibleSupply = allocated;
      row.eligibleSupplyQty = allocated.reduce((sum, s) => sum + s.qty, 0);
      row.requiredComponentQty = row.qty;
      row.coverageSource = "MPS_TIME_PHASED_FIRM_NETTING";
      delete row.supplyEvents;
    }
  }
  return entries;
}

function currentEvidence(detail, doc, phase, inputKey) {
  const saved = detail.calculationTrace?.productionChecksheet;
  if (!saved || saved.version !== VERSION || saved.mpsRevision !== doc.revision || saved.sourceKey !== inputKey || saved.mbomHeaderId !== detail.mbomHeaderId) return null;
  return saved.phases?.[phaseKey(phase)] || null;
}

// Persist the supplier milestones that the feasibility result otherwise drops.
// This runs in the existing calculation lifecycle, never in an ETA GET request.
function customerSupplyLeadTime(row) {
  const raw = row.customerSupplyLeadTimeDays ?? row.supplierLeadTimeDays;
  if (raw == null || raw === "" || typeof raw === "boolean" || !Number.isFinite(Number(raw))) return null;
  const days = Number(raw);
  // Feasibility coerces absent/default BOM lead time to zero. That is not
  // evidence of an explicit zero-day customer supply agreement.
  return days > 0 || (days === 0 && row.customerSupplyLeadTimeSource === "EXPLICIT") ? days : null;
}

async function materialEtaEvidence(materialCoverage, schedule = require("./procurementSchedulingService").procurementSchedule, cache = new Map()) {
  return Promise.all((materialCoverage || []).map(async (row) => {
    if (row.materialSupplyType === "CUSTOMER_SUPPLIED") return { ...row, customerSupplyLeadTimeDays: customerSupplyLeadTime(row) };
    const breakdown = row.procurementLeadTimeBreakdown;
    const fields = ["prApprovalDays", "poProcessingDays", "transitDays", "receivingQcDays", "safetyLeadTimeDays"];
    if (!row.requiredDate || !breakdown || fields.some((key) => breakdown[key] == null || !Number.isFinite(Number(breakdown[key])))) return row;
    const procurementPolicy = { ...Object.fromEntries(fields.map((key) => [key, Number(breakdown[key])])), holidays: row.procurementPolicy?.holidays || [] };
    const input = { ...procurementPolicy, materialRequiredDate: row.requiredDate,
      supplierLeadTimeDays: breakdown.supplierLeadTimeDays ?? row.supplierLeadTimeDays };
    const key = JSON.stringify(input);
    if (!cache.has(key)) cache.set(key, schedule(input));
    const dates = await cache.get(key);
    return { ...row, procurementPolicy, supplierRequiredArrivalDate: iso(dates.supplierRequiredArrivalDate), latestPoDate: iso(dates.latestPoDate) };
  }));
}

async function refreshProductionEvidence(db, mpsNumber, options = {}) {
  // Lazy import avoids a service cycle: the workbench only reads these snapshots.
  const { getMpsWorkbench } = require("./mpsWorkbenchService");
  const doc = await db.mPS.findUniqueOrThrow({ where: { mpsNumber }, include: { details: { where: { isDeleted: false } } } });
  const inputKey = await sourceKey(db);
  const workbench = await getMpsWorkbench(db, { month: iso(doc.periodStart).slice(0, 7), page: 1, pageSize: 100, allItemsForEvaluation: true });
  if (workbench.mps?.mpsNumber !== mpsNumber) throw new Error("MPS kanonis berubah saat pemeriksaan produksi.");
  const entries = [];
  const supplyCache = new Map();
  const procurementCache = new Map();
  for (const item of workbench.items) {
    const detail = doc.details.find((row) => row.id === item.id);
    if (!detail) continue;
    const phases = [...item.phases, ...(item.bufferPhase ? [item.bufferPhase] : [])];
    if (Math.abs(phases.reduce((sum, phase) => sum + n(phase.plannedProductionQty), 0) - n(detail.qtyPlanned)) > 0.0001) {
      throw Object.assign(new Error(`Jumlah fase produksi ${detail.partCode} belum sama dengan qty MPS; seluruh produksi harus diperiksa.`), { code: "PRODUCTION_PHASE_QTY_MISMATCH" });
    }
    for (const phase of phases) {
      if (n(phase.plannedProductionQty) <= 0) continue;
      const entry = { detailId: detail.id, key: phaseKey(phase), phaseId: phase.id, sourceType: phase.sourceType,
        customerDeliveryDate: ["BUFFER", "CARRYOVER"].includes(phase.sourceType) ? null : iso(phase.targetDeliveryDate),
        plannedProductionQty: n(phase.plannedProductionQty), fgRequiredDate: iso(phase.fgRequiredDate || phase.targetDeliveryDate), evaluatedAt: new Date().toISOString(), asOf: businessNow().toISOString(), materialCoverage: [], processTimeline: [], solver: null };
      try {
        if (!detail.mbomHeaderId) throw new Error("Pilihan BOM MPS belum tersedia.");
        const result = await assessDemandFeasibility(db, {
          partCode: detail.partCode, mbomHeaderId: detail.mbomHeaderId,
          quantity: n(phase.plannedProductionQty), requestedDeliveryDate: phase.fgRequiredDate || phase.targetDeliveryDate,
          customerCode: detail.customerCode, sourceType: "MPS_PRODUCTION", sourceNumber: mpsNumber,
          dispatchDays: 0, includeSupplyEvents: true, materialSupplyCache: supplyCache,
        });
        const evidence = result.constraintDetails || {};
        Object.assign(entry, { materialCoverage: await materialEtaEvidence(evidence.materialCoverage, undefined, procurementCache), bomTrace: evidence.bomTrace || [],
          processTimeline: evidence.processTimeline || [], solver: evidence.solver || null, bomNumber: evidence.bomNumber, complete: true });
      } catch (error) {
        entry.error = { code: error.code || "PRODUCTION_EVALUATION_FAILED", message: error.message };
      }
      entries.push(entry);
    }
  }
  allocateMaterials(entries);
  await db.$transaction(async (tx) => {
    const current = await tx.mPS.findUniqueOrThrow({ where: { mpsNumber } });
    if (current.revision !== doc.revision || (await sourceKey(tx)) !== inputKey) throw new Error("Data MPS/material/BOM berubah selama pemeriksaan. Jalankan pemeriksaan ulang.");
    for (const detail of doc.details) {
      const phases = entries.filter((entry) => entry.detailId === detail.id);
      if (!phases.length) continue;
      const latest = await tx.mPSDetail.findUniqueOrThrow({ where: { id: detail.id } });
      if (latest.updatedAt.getTime() !== detail.updatedAt.getTime()) throw new Error("Baris MPS berubah selama pemeriksaan.");
      await tx.mPSDetail.update({ where: { id: detail.id }, data: { calculationTrace: {
        ...(latest.calculationTrace || {}), productionChecksheet: {
          version: VERSION, mpsRevision: doc.revision, mbomHeaderId: detail.mbomHeaderId, sourceKey: inputKey,
          evaluatedBy: options.runBy || "system", evaluatedAt: new Date().toISOString(),
          phases: Object.fromEntries(phases.map((entry) => [entry.key, entry])),
        },
      } } });
    }
  }, { timeout: 120000 });
  return { phaseCount: entries.length, failedPhaseCount: entries.filter((row) => row.error).length };
}

module.exports = { VERSION, sourceKey, phaseKey, currentEvidence, allocateMaterials, customerSupplyLeadTime, materialEtaEvidence, refreshProductionEvidence };
