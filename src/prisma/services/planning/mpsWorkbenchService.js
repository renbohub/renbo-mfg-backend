"use strict";

const { planningMonthKey, utcMonthStart, utcMonthEnd, nextPlanningMonthKey } = require("../../utils/planningMonth");
const { buildFgCompStockTraceability } = require("../inventory/fgCompStockTraceabilityService");
const { buildYearlyDemand } = require("./yearlyDemandService");
const { buildDeliveryPerformance, phaseDeliveryStatus } = require("./deliveryPerformanceService");
const { getMpsDeliveryGate } = require("./mpsDeliveryFeasibilityService");
const { loadAdditionalDemandCoverage } = require("./additionalDemandCoverageService");

const EPSILON = 0.000001;
const WORKING_HOURS_PER_DAY = 14;
const MINIMUM_WIP_LEAD_TIME_HOURS = 2;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const text = (value) => String(value ?? "").trim();
const isSalesReservation = (row) => ["SO", "SALES_ORDER", "SALES ORDER"].includes(text(row?.referenceType).toUpperCase());
const remainingReservation = (row) => Math.max(number(row?.qtyReserved) - number(row?.qtyReleased), 0);
const remainingMo = (row) => Math.max(number(row?.qtyPlanned) - Math.max(number(row?.qtyGood), number(row?.qtyProduced)) - number(row?.qtyReject), 0);
const dateValue = (value, fallback) => value ? new Date(value) : new Date(fallback);
const leadTimeInDays = (value, unit) => {
  const duration = number(value);
  switch (text(unit).toUpperCase()) {
    case "HOUR": return duration / 24;
    case "WEEK": return duration * 7;
    case "MONTH": return duration * 30;
    default: return duration;
  }
};
const planningProcess = (row, category, fallbackVendorLeadTimeDays = 0) => {
  const routingMode = text(row?.routingMode || "INHOUSE").toUpperCase();
  const isVendor = routingMode === "VENDOR"
    || text(category).toUpperCase() === "VENDOR"
    || row?.routingOperation?.isSubcontract === true;
  return {
    id: row.id, sequence: number(row.sequence), processCode: row.process?.processCode || null,
    processName: row.process?.processName || row.process?.processCode || "Process",
    occurrenceCode: row.occurrenceCode || null, routingNumber: row.routingNumber || null,
    routingMode: isVendor ? "VENDOR" : routingMode,
    isVendor,
    cycleTimeSeconds: number(row.routingOperation?.cycleSeconds) || number(row.cycleTime),
    vendorCode: row.vendor?.vendorCode || null,
    vendorName: row.vendor?.vendorName || null,
    vendorLeadTimeDays: isVendor ? (number(row.vendor?.leadTimeDays) || number(fallbackVendorLeadTimeDays)) : 0,
  };
};
const operationalRequirementQty = (value, uomCode) => {
  const qty = Math.max(number(value), 0);
  return ["PCS", "PC", "UNIT", "EA"].includes(text(uomCode).toUpperCase())
    ? Math.ceil(qty - EPSILON)
    : round(qty, 3);
};
const componentRequirementMatchesPhase = (requirement, phase) => {
  if (phase.deliveryTargetId) return requirement.deliveryTargetId === phase.deliveryTargetId;
  const phaseReference = text(phase.sourceNumber);
  return Boolean(phaseReference && [requirement.rootDemandSourceNumber, requirement.sourceNumber].some((value) => text(value) === phaseReference));
};
const bufferAllocationMode = (value) => String(value || "").toUpperCase() === "DISTRIBUTE_TO_PHASES"
  ? "DISTRIBUTE_TO_PHASES"
  : "SEPARATE_END_MONTH";
const buildComponentPhaseNetting = ({ component, phases, receipts, officialRequirements = [] }) => {
  let stockPool = number(component.availableStockQty);
  let receiptPool = 0;
  let receiptIndex = 0;
  const receiptEvents = receipts
    .map((row) => ({ date: row.plannedEndDate, qty: remainingMo(row), reference: row.moNumber }))
    .filter((row) => row.qty > EPSILON)
    .sort((left, right) => dateValue(left.date, new Date(0)) - dateValue(right.date, new Date(0)));
  return phases.map((phase, phaseIndex) => {
    const phaseDate = dateValue(phase.fgRequiredDate || phase.targetDeliveryDate, new Date(8640000000000000));
    while (receiptIndex < receiptEvents.length && dateValue(receiptEvents[receiptIndex].date, phaseDate) <= phaseDate) {
      receiptPool += receiptEvents[receiptIndex].qty;
      receiptIndex += 1;
    }
    const openingStockQty = round(stockPool);
    const openingFirmReceiptQty = round(receiptPool);
    const previewGrossQty = operationalRequirementQty(number(component.qtyPerFg) * number(phase.plannedProductionQty || phase.qty), component.uomCode);
    const stockUsedQty = Math.min(stockPool, previewGrossQty);
    stockPool -= stockUsedQty;
    const afterStockQty = Math.max(previewGrossQty - stockUsedQty, 0);
    const firmReceiptUsedQty = Math.min(receiptPool, afterStockQty);
    receiptPool -= firmReceiptUsedQty;
    const previewNetQty = round(Math.max(afterStockQty - firmReceiptUsedQty, 0));
    const official = officialRequirements.filter((row) => componentRequirementMatchesPhase(row, phase)
      && [row.grossRequirement, row.netRequirement, row.plannedOrderQty].some((value) => number(value) > EPSILON));
    if (official.length) {
      const grossRequirementQty = round(official.reduce((sum, row) => sum + number(row.grossRequirement), 0));
      const netRequirementQty = round(official.reduce((sum, row) => sum + number(row.netRequirement), 0));
      const officialPlannedQty = round(official.reduce((sum, row) => sum + number(row.plannedOrderQty), 0));
      return {
        phaseId: phase.id || String(phaseIndex), phaseIndex, source: "OFFICIAL_MRP",
        grossRequirementQty: previewGrossQty, stockUsedQty: round(stockUsedQty), firmReceiptUsedQty: round(firmReceiptUsedQty),
        netRequirementQty: previewNetQty, plannedOrderQty: previewNetQty, projectedAvailableQty: round(stockPool + receiptPool),
        openingStockQty, openingFirmReceiptQty, endingStockQty: round(stockPool), endingFirmReceiptQty: round(receiptPool),
        officialGrossRequirementQty: grossRequirementQty, officialNetRequirementQty: netRequirementQty,
        officialPlannedOrderQty: officialPlannedQty > EPSILON ? officialPlannedQty : netRequirementQty,
      };
    }
    return {
      phaseId: phase.id || String(phaseIndex), phaseIndex, source: "WORKBENCH_PREVIEW",
      grossRequirementQty: previewGrossQty, stockUsedQty: round(stockUsedQty), firmReceiptUsedQty: round(firmReceiptUsedQty),
      netRequirementQty: previewNetQty, plannedOrderQty: previewNetQty, projectedAvailableQty: round(stockPool + receiptPool),
      openingStockQty, openingFirmReceiptQty, endingStockQty: round(stockPool), endingFirmReceiptQty: round(receiptPool),
    };
  });
};
const buildCascadingComponentNetting = ({ components, rootPartCode, phases, receipts }) => {
  const ordered = [...components].sort((left, right) => number(left.level) - number(right.level) || text(left.partCode).localeCompare(text(right.partCode), "id", { numeric: true }));
  const states = new Map();
  const phaseNettingByPart = new Map(ordered.map((component) => [component.partCode, []]));
  for (const component of ordered) {
    const receiptEvents = receipts.filter((row) => row.part?.partCode === component.partCode)
      .map((row) => ({ date: row.plannedEndDate, qty: remainingMo(row), reference: row.moNumber }))
      .filter((row) => row.qty > EPSILON)
      .sort((left, right) => dateValue(left.date, new Date(0)) - dateValue(right.date, new Date(0)));
    states.set(component.partCode, { stockPool: number(component.availableStockQty), receiptPool: 0, receiptIndex: 0, receiptEvents });
  }
  for (const [phaseIndex, phase] of phases.entries()) {
    const plannedByPart = new Map([[rootPartCode, number(phase.plannedProductionQty || phase.qty)]]);
    const phaseDate = dateValue(phase.fgRequiredDate || phase.targetDeliveryDate, new Date(8640000000000000));
    for (const component of ordered) {
      const state = states.get(component.partCode);
      while (state.receiptIndex < state.receiptEvents.length && dateValue(state.receiptEvents[state.receiptIndex].date, phaseDate) <= phaseDate) {
        state.receiptPool += state.receiptEvents[state.receiptIndex].qty;
        state.receiptIndex += 1;
      }
      const openingStockQty = round(state.stockPool);
      const openingFirmReceiptQty = round(state.receiptPool);
      const dependencies = Array.isArray(component.dependencies) && component.dependencies.length
        ? component.dependencies
        : [{ parentPartCode: rootPartCode, qtyPerParent: component.qtyPerFg }];
      const grossRequirementQty = operationalRequirementQty(dependencies.reduce((sum, dependency) => (
        sum + number(dependency.qtyPerParent) * number(plannedByPart.get(dependency.parentPartCode))
      ), 0), component.uomCode);
      const stockUsedQty = Math.min(state.stockPool, grossRequirementQty);
      state.stockPool -= stockUsedQty;
      const afterStockQty = Math.max(grossRequirementQty - stockUsedQty, 0);
      const firmReceiptUsedQty = Math.min(state.receiptPool, afterStockQty);
      state.receiptPool -= firmReceiptUsedQty;
      const plannedOrderQty = operationalRequirementQty(Math.max(afterStockQty - firmReceiptUsedQty, 0), component.uomCode);
      plannedByPart.set(component.partCode, plannedOrderQty);
      phaseNettingByPart.get(component.partCode).push({
        phaseId: phase.id || String(phaseIndex), phaseIndex, source: "CASCADE_NETTING",
        grossRequirementQty, stockUsedQty: round(stockUsedQty), firmReceiptUsedQty: round(firmReceiptUsedQty),
        netRequirementQty: plannedOrderQty, plannedOrderQty,
        openingStockQty, openingFirmReceiptQty, endingStockQty: round(state.stockPool), endingFirmReceiptQty: round(state.receiptPool),
        projectedAvailableQty: round(state.stockPool + state.receiptPool),
        dependencies: dependencies.map((dependency) => ({
          parentPartCode: dependency.parentPartCode,
          qtyPerParent: dependency.qtyPerParent,
          parentPlannedQty: number(plannedByPart.get(dependency.parentPartCode)),
        })),
      });
    }
  }
  return phaseNettingByPart;
};
const processLeadTimeForQty = (component, qty) => {
  const plannedQty = Math.max(number(qty), 0);
  const steps = (component.processes || []).map((process) => {
    if (process.isVendor) {
      const vendorLeadTimeDays = plannedQty > EPSILON ? Math.max(number(process.vendorLeadTimeDays), 0) : 0;
      return {
        partCode: component.partCode, processCode: process.processCode, processName: process.processName,
        routingMode: "VENDOR", qty: plannedQty, cycleTimeSeconds: 0, cycleLoadHours: 0,
        vendorCode: process.vendorCode || null, vendorLeadTimeDays,
        elapsedHours: round(vendorLeadTimeDays * WORKING_HOURS_PER_DAY),
      };
    }
    const cycleTimeSeconds = Math.max(number(process.cycleTimeSeconds), 0);
    const cycleLoadHours = cycleTimeSeconds * plannedQty / 3600;
    return {
      partCode: component.partCode, processCode: process.processCode, processName: process.processName,
      routingMode: "INHOUSE", qty: plannedQty, cycleTimeSeconds,
      cycleLoadHours: round(cycleLoadHours), vendorLeadTimeDays: 0, elapsedHours: round(cycleLoadHours),
    };
  });
  return {
    cycleTimeSeconds: round(steps.reduce((sum, step) => sum + number(step.cycleTimeSeconds), 0)),
    cycleLoadHours: round(steps.reduce((sum, step) => sum + number(step.cycleLoadHours), 0)),
    vendorLeadTimeDays: round(steps.reduce((sum, step) => sum + number(step.vendorLeadTimeDays), 0)),
    elapsedHours: round(steps.reduce((sum, step) => sum + number(step.elapsedHours), 0)),
    steps,
  };
};
const buildCumulativeComponentLeadTimes = ({ components, rootPartCode, phases }) => {
  const byPart = new Map(components.map((component) => [component.partCode, component]));
  const result = new Map(components.map((component) => [component.partCode, []]));
  for (const [phaseIndex, phase] of phases.entries()) {
    const plannedByPart = new Map([[rootPartCode, number(phase.plannedProductionQty || phase.qty)]]);
    for (const component of components) {
      const netting = component.phaseNetting?.find((row) => number(row.phaseIndex) === phaseIndex);
      plannedByPart.set(component.partCode, number(netting?.plannedOrderQty));
    }
    const memo = new Map();
    const calculate = (partCode, visiting = new Set()) => {
      if (partCode === rootPartCode || !byPart.has(partCode) || visiting.has(partCode)) {
        return { totalHours: 0, totalDays: 0, ownHours: 0, parentHours: 0, cycleLoadHours: 0, vendorLeadTimeDays: 0, steps: [] };
      }
      if (memo.has(partCode)) return memo.get(partCode);
      const component = byPart.get(partCode);
      const plannedQty = number(plannedByPart.get(partCode));
      if (plannedQty <= EPSILON) {
        const zero = {
          phaseId: phase.id || String(phaseIndex), phaseIndex, plannedQty: 0,
          ownHours: 0, parentHours: 0, totalHours: 0, totalDays: 0,
          cycleTimeSeconds: 0, cycleLoadHours: 0, vendorLeadTimeDays: 0,
          ownCycleLoadHours: 0, ownVendorLeadTimeDays: 0, minimumLeadTimeAdjustmentHours: 0,
          steps: [], calculationMethod: "ZERO_WHEN_MPS_ZERO",
        };
        memo.set(partCode, zero);
        return zero;
      }
      const own = processLeadTimeForQty(component, plannedQty);
      const nextVisiting = new Set(visiting).add(partCode);
      const parents = (component.dependencies || []).map((dependency) => calculate(dependency.parentPartCode, nextVisiting));
      const criticalParent = parents.sort((left, right) => number(right.totalHours) - number(left.totalHours))[0]
        || { totalHours: 0, cycleLoadHours: 0, vendorLeadTimeDays: 0, steps: [] };
      const rawTotalHours = round(own.elapsedHours + criticalParent.totalHours);
      const totalHours = round(Math.max(rawTotalHours, MINIMUM_WIP_LEAD_TIME_HOURS));
      const minimumLeadTimeAdjustmentHours = round(totalHours - rawTotalHours);
      const value = {
        phaseId: phase.id || String(phaseIndex), phaseIndex, plannedQty: round(plannedQty),
        ownHours: round(own.elapsedHours), parentHours: round(criticalParent.totalHours), totalHours,
        totalDays: round(totalHours / WORKING_HOURS_PER_DAY, 3),
        cycleTimeSeconds: own.cycleTimeSeconds,
        cycleLoadHours: round(own.cycleLoadHours + criticalParent.cycleLoadHours),
        vendorLeadTimeDays: round(own.vendorLeadTimeDays + criticalParent.vendorLeadTimeDays),
        ownCycleLoadHours: own.cycleLoadHours, ownVendorLeadTimeDays: own.vendorLeadTimeDays,
        minimumLeadTimeAdjustmentHours,
        steps: [
          ...own.steps,
          ...criticalParent.steps,
          ...(minimumLeadTimeAdjustmentHours > EPSILON ? [{
            partCode, processCode: "MIN-LEAD-TIME", processName: "Minimum WIP lead time",
            routingMode: "POLICY", qty: plannedQty, elapsedHours: minimumLeadTimeAdjustmentHours,
          }] : []),
        ],
        calculationMethod: "CUMULATIVE_QTY_X_CYCLE_PLUS_VENDOR_MIN_2H_14H_DAY",
      };
      memo.set(partCode, value);
      return value;
    };
    for (const component of components) result.get(component.partCode).push(calculate(component.partCode));
  }
  return result;
};
const shiftMonth = (month, offset) => {
  const [year, value] = String(month || "").split("-").map(Number);
  const shifted = new Date(Date.UTC(year, value - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
};

async function efdWindow(tx, month) {
  const months = [shiftMonth(month, -1), month, shiftMonth(month, 1)];
  const years = [...new Set(months.map((key) => Number(key.slice(0, 4))))];
  const payloads = await Promise.all(years.map((year) => buildYearlyDemand(tx, { year, unpaginated: true })));
  const byPart = new Map();
  for (const payload of payloads) {
    for (const row of payload.items) {
      const values = byPart.get(row.partCode) || {};
      months.forEach((key) => { if (row.months[key]) values[key] = number(row.months[key].efd ?? row.months[key].eff); });
      byPart.set(row.partCode, values);
    }
  }
  const totals = Object.fromEntries(months.map((key) => [key, round([...byPart.values()].reduce((sum, values) => sum + number(values[key]), 0))]));
  return { months, byPart, totals, total: round(Object.values(totals).reduce((sum, value) => sum + number(value), 0)), rule: payloads[0]?.efdRule || null };
}

async function blockedForecastSources(tx, month) {
  const rows = await tx.forecast.findMany({
    where: { isDeleted: false, isCurrentVersion: true, status: { notIn: ["Confirmed", "Consumed", "Partial Product"] } },
    select: { forecastNumber: true, status: true, customerCode: true, details: { where: { isDeleted: false }, select: { M1Forecast: true, M1Qty: true, M2Forecast: true, M2Qty: true, M3Forecast: true, M3Qty: true, deliveryTargets: { where: { isDeleted: false, status: "ACTIVE" }, select: { targetDate: true, qty: true } } } } },
  });
  return rows.map((forecast) => {
    const qty = forecast.details.reduce((sum, detail) => {
      if (detail.deliveryTargets?.length) return sum + detail.deliveryTargets.filter((target) => planningMonthKey(target.targetDate) === month).reduce((targetSum, target) => targetSum + number(target.qty), 0);
      return sum + [[detail.M1Forecast, detail.M1Qty], [detail.M2Forecast, detail.M2Qty], [detail.M3Forecast, detail.M3Qty]].filter(([date, value]) => planningMonthKey(date) === month && number(value) > 0).reduce((periodSum, [, value]) => periodSum + number(value), 0);
    }, 0);
    return { forecastNumber: forecast.forecastNumber, status: forecast.status, customerCode: forecast.customerCode, qty: round(qty) };
  }).filter((row) => row.qty > EPSILON);
}

function demandPhases(detail) {
  const phases = [];
  const previousEfd = detail.calculationTrace?.previousEfd;
  const carryoverQty = Math.max(number(previousEfd?.shortageQty), 0);
  if (carryoverQty > EPSILON) {
    phases.push({
      id: `${detail.id}:CARRYOVER:${previousEfd?.month || "M-1"}`,
      sourceType: "CARRYOVER",
      sourceNumber: `EFD ${previousEfd?.month || "M-1"}`,
      customerCode: detail.customerCode || null,
      qty: carryoverQty,
      phaseNumber: 1,
      targetDeliveryDate: detail.startDate,
      fgRequiredDate: detail.startDate,
      carryoverFromMonth: previousEfd?.month || null,
    });
  }
  for (const source of detail.demandSources || []) {
    const peggingRows = Array.isArray(source.sourcePegging) ? source.sourcePegging : [];
    if (!peggingRows.length) {
      phases.push({
        id: `${source.id}:1`, sourceType: source.sourceType, sourceNumber: source.sourceNumber,
        customerCode: source.customerCode, qty: number(source.qty), phaseNumber: 1,
        targetDeliveryDate: source.targetDeliveryDate || source.effectiveRequiredDate || source.requiredDate,
        fgRequiredDate: source.fgRequiredDate || source.effectiveRequiredDate || source.requiredDate,
      });
      continue;
    }
    for (const pegging of peggingRows) {
      const splits = Array.isArray(pegging.fgFinishSplits) && pegging.fgFinishSplits.length
        ? pegging.fgFinishSplits
        : [{ phaseNumber: 1, targetFinishDate: source.fgRequiredDate || pegging.targetDeliveryDate, qty: pegging.qty }];
      for (const [index, split] of splits.entries()) {
        phases.push({
          id: `${source.id}:${pegging.deliveryTargetId || index}:${split.phaseNumber || index + 1}`,
          deliveryTargetId: pegging.deliveryTargetId || source.deliveryTargetId,
          sourceType: source.sourceType, sourceNumber: source.sourceNumber,
          customerCode: pegging.customerCode || source.customerCode,
          qty: number(split.qty), phaseNumber: number(split.phaseNumber) || index + 1,
          targetDeliveryDate: pegging.targetDeliveryDate || source.targetDeliveryDate,
          fgRequiredDate: split.targetFinishDate || source.fgRequiredDate || pegging.targetDeliveryDate,
        });
      }
    }
  }
  return phases.filter((row) => row.qty > EPSILON).sort((left, right) => dateValue(left.fgRequiredDate, detail.endDate) - dateValue(right.fgRequiredDate, detail.endDate)
    || (left.sourceType === "SALES_ORDER" ? -1 : 1)
    || text(left.sourceNumber).localeCompare(text(right.sourceNumber)));
}

function normalizedSourceType(value) {
  const type = text(value).toUpperCase();
  if (["SO", "SALES_ORDER", "SALES ORDER"].includes(type)) return "SALES_ORDER";
  return type || "DEMAND";
}

function isCustomerDeliveryPhase(detail, phase) {
  const sourceType = normalizedSourceType(phase?.sourceType);
  if (sourceType === "SALES_ORDER") return true;
  const efdSource = String(detail?.calculationTrace?.efd?.source || "").toUpperCase();
  const hasSalesOrderSource = (detail?.demandSources || []).some((source) => normalizedSourceType(source?.sourceType) === "SALES_ORDER" && number(source?.qty) > EPSILON);
  const hasForecastSource = (detail?.demandSources || []).some((source) => normalizedSourceType(source?.sourceType) === "FORECAST" && number(source?.qty) > EPSILON);
  // A FORECAST override keeps the SO-backed phase and the unconsumed
  // Forecast residual. Source pegging already reduces the Forecast phase by
  // the quantity consumed by SO, so excluding it here makes phase production
  // smaller than the official MPS quantity and causes RCCP to reject the run.
  const forecastSelected = efdSource.startsWith("FORECAST");
  const forecastDeliveryFallback = number(detail?.actualSalesOrderQty) <= EPSILON
    && !hasSalesOrderSource
    && (forecastSelected || (!efdSource && hasForecastSource));
  return sourceType === "FORECAST" && (forecastSelected || forecastDeliveryFallback);
}

function phaseSimulationKey(source = {}) {
  const type = normalizedSourceType(source.sourceType);
  const sourceNumber = text(source.sourceNumber);
  const phaseNumber = Math.max(Math.trunc(number(source.phaseNumber)) || 1, 1);
  const deliveryTargetId = text(source.deliveryTargetId);
  if (deliveryTargetId) return `TARGET:${deliveryTargetId}:PHASE:${phaseNumber}`;
  const targetDate = source.targetDeliveryDate || source.fgRequiredDate || source.targetFinishDate;
  const dateKey = targetDate && !Number.isNaN(new Date(targetDate).getTime()) ? new Date(targetDate).toISOString().slice(0, 10) : "NO_DATE";
  return `${type}:${sourceNumber}:${dateKey}:PHASE:${phaseNumber}`;
}

function requirementPhaseContributions(requirement) {
  const sources = Array.isArray(requirement.customerPegging) && requirement.customerPegging.length
    ? requirement.customerPegging
    : [{
        sourceType: requirement.rootDemandSourceType || requirement.sourceType,
        sourceNumber: requirement.rootDemandSourceNumber || requirement.sourceNumber,
        customerCode: requirement.customerCode,
        deliveryTargetId: requirement.deliveryTargetId,
        targetDeliveryDate: requirement.targetDeliveryDate,
        qty: requirement.grossRequirement,
      }];
  const rows = sources.flatMap((source) => {
    const splits = Array.isArray(source.fgFinishSplits) && source.fgFinishSplits.length
      ? source.fgFinishSplits
      : [{ qty: source.qty, phaseNumber: source.fgFinishSplitNumber || 1, targetFinishDate: source.fgRequiredDate || source.targetDeliveryDate || requirement.targetDeliveryDate }];
    return splits.map((split, index) => ({
      key: phaseSimulationKey({
        sourceType: source.sourceType,
        sourceNumber: source.sourceNumber,
        deliveryTargetId: source.deliveryTargetId || requirement.deliveryTargetId,
        targetDeliveryDate: source.targetDeliveryDate || requirement.targetDeliveryDate,
        fgRequiredDate: split.targetFinishDate || source.fgRequiredDate,
        phaseNumber: split.phaseNumber || source.fgFinishSplitNumber || index + 1,
      }),
      weight: Math.max(number(split.qty ?? source.qty), 0),
    }));
  });
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map((row) => ({ ...row, factor: totalWeight > EPSILON ? row.weight / totalWeight : 1 / Math.max(rows.length, 1) }));
}

function requirementIdentity(requirement) {
  return text(requirement.part?.material?.materialCode || requirement.partCode).toUpperCase();
}

function buildPhasePurchaseSimulation({ detail, phases = [], requirements = [], mrp = null, inventoryTrace = null }) {
  const planningPhases = phases.filter((phase) => normalizedSourceType(phase.sourceType) !== "BUFFER" || number(phase.plannedProductionQty) > EPSILON || number(phase.bufferTargetQty) > EPSILON);
  if (!mrp || !planningPhases.length) {
    return {
      available: false,
      mrpRunNumber: mrp?.runNumber || null,
      suggestionNumber: null,
      phaseCount: planningPhases.length,
      tableCount: planningPhases.length * 4,
      phases: [],
      message: !mrp ? "Jalankan MRP untuk membentuk simulasi material per delivery dan buffer phase." : "Forecast/SO atau buffer phase belum tersedia.",
    };
  }
  const phaseKeys = new Set(planningPhases.map(phaseSimulationKey));
  const phaseRequirements = requirements.filter((row) => !row.mpsDetailId || row.mpsDetailId === detail.id);
  const purchaseRequirements = phaseRequirements.filter((row) => row.orderType === "Purchase");
  const productionRequirements = phaseRequirements.filter((row) => row.orderType === "Production");
  const initialBalance = new Map();
  const byPhase = new Map();
  const masterByIdentity = new Map();
  for (const requirement of purchaseRequirements) {
    const identity = requirementIdentity(requirement);
    if (!identity) continue;
    initialBalance.set(identity, Math.max(number(initialBalance.get(identity)), number(requirement.onHandQty)));
    const processes = (requirement.mbomDetail?.mbomProcesses?.length
      ? requirement.mbomDetail.mbomProcesses
      : requirement.mbomDetail?.parentDetail?.mbomProcesses || [])
      .map((row) => row.process?.processCode || row.occurrenceCode)
      .filter(Boolean);
    const parent = requirement.mbomDetail?.parentDetail?.part || requirement.mbomDetail?.mbomHeader?.part || null;
    const isMaterial = Boolean(requirement.part?.material) || text(requirement.part?.rawType).toUpperCase() === "MATERIAL";
    const uomCode = isMaterial ? "KG" : text(requirement.mbomDetail?.uomCode || requirement.part?.stockUomCode || requirement.part?.baseUomCode || "PCS").toUpperCase();
    const currentMaster = masterByIdentity.get(identity) || {
      identity,
      partCode: requirement.partCode,
      partNumber: requirement.part?.partNumber || null,
      partName: requirement.part?.material?.materialName || requirement.part?.partName || identity,
      materialCode: requirement.part?.material?.materialCode || null,
      itemKind: isMaterial ? "Raw Material" : "Purchase Part",
      uomCode,
      usedFor: new Set(),
      processes: new Set(),
    };
    if (parent) currentMaster.usedFor.add(`${parent.partNumber || parent.partCode || "-"} / ${parent.partCode || "-"}`);
    processes.forEach((process) => currentMaster.processes.add(process));
    masterByIdentity.set(identity, currentMaster);
    for (const contribution of requirementPhaseContributions(requirement)) {
      if (!phaseKeys.has(contribution.key)) continue;
      if (!byPhase.has(contribution.key)) byPhase.set(contribution.key, new Map());
      const phaseMap = byPhase.get(contribution.key);
      const row = phaseMap.get(identity) || { grossRequirement: 0, officialMrpNet: 0, firmSupplyQty: 0 };
      row.grossRequirement += number(requirement.grossRequirement) * contribution.factor;
      row.officialMrpNet += number(requirement.netRequirement) * contribution.factor;
      row.firmSupplyQty += number(requirement.firmSupplyQty) * contribution.factor;
      phaseMap.set(identity, row);
    }
  }

  const balances = new Map(initialBalance);
  const simulationPhases = planningPhases.map((phase, index) => {
    const aggregates = byPhase.get(phaseSimulationKey(phase)) || new Map();
    const beforeRows = [];
    const afterRows = [];
    for (const [identity, values] of aggregates) {
      const master = masterByIdentity.get(identity);
      const grossRequirement = round(values.grossRequirement);
      const officialMrpNet = round(values.officialMrpNet);
      if (grossRequirement <= EPSILON && officialMrpNet <= EPSILON) continue;
      const openingStock = round(number(balances.get(identity)));
      const firmSupplyQty = round(Math.max(number(values.firmSupplyQty), 0));
      const stockUsedQty = round(Math.min(openingStock, grossRequirement));
      const firmUsedQty = round(Math.min(firmSupplyQty, Math.max(grossRequirement - stockUsedQty, 0)));
      const simulatedNet = round(Math.max(grossRequirement - stockUsedQty - firmUsedQty, 0));
      const endingWithoutPurchase = round(Math.max(openingStock + firmSupplyQty - grossRequirement, 0));
      const purchaseReceiptQty = round(simulatedNet);
      const stockAfterPurchase = round(Math.max(openingStock + firmSupplyQty + purchaseReceiptQty, 0));
      const stockAfterProduction = round(Math.max(stockAfterPurchase - grossRequirement, 0));
      const common = {
        identity,
        partCode: master.partCode,
        partNumber: master.partNumber,
        partName: master.partName,
        materialCode: master.materialCode,
        itemKind: master.itemKind,
        uomCode: master.uomCode,
        usedFor: [...master.usedFor],
        processes: [...master.processes],
        openingStock,
        grossRequirement,
        firmSupplyQty,
        officialMrpNet,
      };
      beforeRows.push({ ...common, stockUsedQty, firmUsedQty, simulatedNet, endingStock: endingWithoutPurchase });
      afterRows.push({ ...common, simulatedNet, purchaseReceiptQty, stockAfterPurchase, stockAfterProduction, endingStock: stockAfterProduction });
      balances.set(identity, stockAfterProduction);
    }
    const productionRows = [];
    const productionMap = new Map();
    for (const requirement of productionRequirements) {
      // Root FG is supplied by the chronological net MPS quantity on the
      // phase itself. Keeping the root MRP production row here would count
      // the same output twice in the plan and after-production matrices.
      if (text(requirement.partCode).toUpperCase() === text(detail.partCode).toUpperCase()) continue;
      const contributions = requirementPhaseContributions(requirement).filter((row) => row.key === phaseSimulationKey(phase));
      if (!contributions.length) continue;
      const factor = contributions.reduce((sum, row) => sum + row.factor, 0);
      const identity = text(requirement.partCode).toUpperCase();
      const processes = (requirement.mbomDetail?.mbomProcesses?.length
        ? requirement.mbomDetail.mbomProcesses
        : requirement.mbomDetail?.parentDetail?.mbomProcesses || [])
        .map((row) => row.process?.processCode || row.occurrenceCode).filter(Boolean);
      const current = productionMap.get(identity) || {
        identity,
        partCode: requirement.partCode,
        partNumber: requirement.part?.partNumber || null,
        partName: requirement.part?.partName || requirement.partCode,
        itemKind: text(requirement.part?.itemType).toUpperCase() === "FG" ? "Component FG" : "WIP",
        uomCode: text(requirement.part?.stockUomCode || requirement.part?.baseUomCode || "PCS").toUpperCase(),
        processes: new Set(),
        grossRequirement: 0,
        openingStock: 0,
        plannedProductionQty: 0,
      };
      processes.forEach((process) => current.processes.add(process));
      current.grossRequirement += number(requirement.grossRequirement) * factor;
      current.openingStock = Math.max(current.openingStock, number(requirement.onHandQty));
      current.plannedProductionQty += Math.max(number(requirement.plannedOrderQty), number(requirement.netRequirement)) * factor;
      productionMap.set(identity, current);
    }
    for (const row of productionMap.values()) productionRows.push({ ...row, processes: [...row.processes], grossRequirement: round(row.grossRequirement), openingStock: round(row.openingStock), plannedProductionQty: round(row.plannedProductionQty) });
    const sortRows = (rows) => rows.sort((left, right) => left.itemKind.localeCompare(right.itemKind) || left.identity.localeCompare(right.identity));
    return {
      id: phase.id,
      sequence: index + 1,
      sourceType: normalizedSourceType(phase.sourceType),
      sourceNumber: phase.sourceNumber,
      customerCode: phase.customerCode,
      phaseNumber: phase.phaseNumber,
      targetDeliveryDate: phase.targetDeliveryDate,
      fgRequiredDate: phase.fgRequiredDate,
      fgQty: round(phase.qty),
      mpsProductionQty: round(phase.plannedProductionQty),
      isBuffer: normalizedSourceType(phase.sourceType) === "BUFFER",
      bufferTargetQty: round(phase.bufferTargetQty),
      bufferBaseQty: round(phase.bufferBaseQty),
      bufferPercent: round(phase.bufferPercent),
      nextForecastMonth: phase.nextForecastMonth || null,
      beforeRows: sortRows(beforeRows),
      afterRows: sortRows(afterRows),
      productionRows: sortRows(productionRows),
    };
  });
  return {
    available: true,
    mrpRunNumber: mrp.runNumber,
    mrpStatus: mrp.status,
    suggestionNumber: null,
    phaseCount: simulationPhases.length,
    tableCount: simulationPhases.length * 4,
    assumption: "Purchase receipt mengikuti net MRP tanpa MOQ; produksi diasumsikan tanpa NG dan material dipakai tepat sesuai gross requirement. Delivery mengurangi FG, sedangkan buffer phase disimpan sebagai opening stock bulan berikutnya.",
    moqRule: "MOQ dinonaktifkan; purchase receipt = net requirement MRP dan excess MOQ = 0.",
    inventoryTrace,
    phases: simulationPhases,
  };
}

function buildLedger({ detail, stockLines, reservations, receipts, comparePhysicalOpening = true }) {
  const soNumbers = new Set((detail.demandSources || []).filter((row) => row.sourceType === "SALES_ORDER").map((row) => text(row.sourceNumber)).filter(Boolean));
  const peggedReservations = reservations.filter((row) => isSalesReservation(row) && soNumbers.has(text(row.referenceNumber)));
  const otherReservations = reservations.filter((row) => !peggedReservations.includes(row));
  const reservationPools = new Map();
  peggedReservations.forEach((row) => reservationPools.set(text(row.referenceNumber), number(reservationPools.get(text(row.referenceNumber))) + remainingReservation(row)));
  // Carryover remains an internal demand obligation. For the current month,
  // however, netting must use the same source rule as Batch Delivery: SO wins
  // once present; Forecast is only the fallback while PO/SO is still zero.
  // Otherwise Forecast remainder and SO are both consumed, exhausting the
  // official MPS quantity before it can form the ending-buffer batch.
  const phases = demandPhases(detail).filter((phase) => normalizedSourceType(phase.sourceType) === "CARRYOVER"
    || isCustomerDeliveryPhase(detail, phase));
  const soDemandByReference = new Map();
  phases.filter((row) => row.sourceType === "SALES_ORDER").forEach((row) => soDemandByReference.set(text(row.sourceNumber), number(soDemandByReference.get(text(row.sourceNumber))) + number(row.qty)));
  const physicalFreeOpeningQty = stockLines.reduce((sum, row) => sum + Math.max(number(row.qtyAvailable), 0), 0);
  const onHandQty = stockLines.reduce((sum, row) => sum + Math.max(number(row.qtyOnHand), 0), 0);
  const qcQty = stockLines.reduce((sum, row) => sum + Math.max(number(row.qtyQC), 0), 0);
  const stockReservedQty = stockLines.reduce((sum, row) => sum + Math.max(number(row.qtyReserved), 0), 0);
  // A matching reference is necessary but not sufficient: reservation above
  // the outstanding SO quantity remains protected and cannot inflate opening.
  const peggedReservationQty = [...reservationPools.entries()].reduce((sum, [reference, qty]) => sum + Math.min(qty, number(soDemandByReference.get(reference))), 0);
  const otherReservationQty = otherReservations.reduce((sum, row) => sum + remainingReservation(row), 0);
  // Only the anchor month opens from today's physical stock. Following months
  // inherit the prior MPS projected ending, which is already persisted in the
  // official opening quantity and must not be compared to today's warehouse.
  const freeOpeningQty = comparePhysicalOpening
    ? physicalFreeOpeningQty
    : Math.max(number(detail.openingAvailableQty) - peggedReservationQty, 0);
  const receiptEvents = receipts.filter((row) => remainingMo(row) > EPSILON).map((row) => ({
    moNumber: row.moNumber, date: row.plannedEndDate || detail.startDate, qty: remainingMo(row), status: row.status,
    assumedDate: !row.plannedEndDate,
  })).sort((left, right) => dateValue(left.date, detail.startDate) - dateValue(right.date, detail.startDate));

  let freeAvailable = freeOpeningQty;
  let receiptIndex = 0;
  let officialProductionRemaining = Math.max(number(detail.qtyPlanned), 0);
  let grossDemandQty = 0;
  let reservationUsedQty = 0;
  let freeStockUsedQty = 0;
  let firmReceiptUsedQty = 0;
  let plannedProductionUsedQty = 0;
  let uncoveredQty = 0;
  const ledger = [];
  let cumulativeReceipts = 0;

  for (const phase of phases) {
    const requiredDate = dateValue(phase.fgRequiredDate, detail.endDate);
    while (receiptIndex < receiptEvents.length && dateValue(receiptEvents[receiptIndex].date, detail.startDate) <= requiredDate) {
      const receipt = receiptEvents[receiptIndex++];
      freeAvailable += receipt.qty;
      cumulativeReceipts += receipt.qty;
      ledger.push({ eventType: "FIRM_RECEIPT", eventDate: receipt.date, reference: receipt.moNumber, qtyIn: round(receipt.qty), qtyOut: 0, projectedFreeQty: round(freeAvailable), note: receipt.assumedDate ? "Tanggal MO kosong; diasumsikan awal bucket." : `Open MO ${receipt.status}` });
    }
    grossDemandQty += phase.qty;
    let remainingDemand = phase.qty;
    let reservedUsed = 0;
    if (phase.sourceType === "SALES_ORDER") {
      const pool = number(reservationPools.get(text(phase.sourceNumber)));
      reservedUsed = Math.min(pool, remainingDemand);
      reservationPools.set(text(phase.sourceNumber), Math.max(pool - reservedUsed, 0));
      remainingDemand -= reservedUsed;
      reservationUsedQty += reservedUsed;
    }
    const freeUsed = Math.min(freeAvailable, remainingDemand);
    freeAvailable -= freeUsed;
    remainingDemand -= freeUsed;
    freeStockUsedQty += freeUsed;
    const plannedUsed = Math.min(officialProductionRemaining, remainingDemand);
    officialProductionRemaining -= plannedUsed;
    remainingDemand -= plannedUsed;
    plannedProductionUsedQty += plannedUsed;
    uncoveredQty += remainingDemand;
    ledger.push({
      eventType: "GROSS_DEMAND", eventDate: phase.fgRequiredDate || phase.targetDeliveryDate,
      targetDeliveryDate: phase.targetDeliveryDate, reference: phase.sourceNumber, sourceType: phase.sourceType,
      customerCode: phase.customerCode, phaseNumber: phase.phaseNumber, qtyIn: round(plannedUsed), qtyOut: round(phase.qty),
      reservedUsedQty: round(reservedUsed), freeUsedQty: round(freeUsed), plannedProductionQty: round(plannedUsed),
      uncoveredQty: round(remainingDemand), projectedFreeQty: round(freeAvailable),
      formula: `${round(phase.qty)} demand - ${round(reservedUsed)} pegged - ${round(freeUsed)} free FG - ${round(plannedUsed)} planned production = ${round(remainingDemand)} uncovered`,
    });
  }
  while (receiptIndex < receiptEvents.length && dateValue(receiptEvents[receiptIndex].date, detail.startDate) <= dateValue(detail.endDate, detail.endDate)) {
    const receipt = receiptEvents[receiptIndex++];
    freeAvailable += receipt.qty;
    cumulativeReceipts += receipt.qty;
    ledger.push({ eventType: "FIRM_RECEIPT", eventDate: receipt.date, reference: receipt.moNumber, qtyIn: round(receipt.qty), qtyOut: 0, projectedFreeQty: round(freeAvailable), note: "Receipt setelah demand phase terakhir; hanya membantu ending stock." });
  }
  const bufferNeeded = Math.max(number(detail.targetEndingStockQty) - freeAvailable, 0);
  const bufferProduction = Math.min(officialProductionRemaining, bufferNeeded);
  freeAvailable += bufferProduction;
  officialProductionRemaining -= bufferProduction;
  plannedProductionUsedQty += bufferProduction;
  if (number(detail.targetEndingStockQty) > EPSILON || bufferProduction > EPSILON) ledger.push({ eventType: "BUFFER_TARGET", eventDate: detail.endDate, reference: "TARGET_ENDING", qtyIn: round(bufferProduction), qtyOut: 0, plannedProductionQty: round(bufferProduction), projectedFreeQty: round(freeAvailable), formula: `max(${round(detail.targetEndingStockQty)} target - ${round(freeAvailable - bufferProduction)} projected, 0) = ${round(bufferNeeded)} kebutuhan buffer` });
  if (officialProductionRemaining > EPSILON) {
    freeAvailable += officialProductionRemaining;
    ledger.push({ eventType: "PLANNED_BALANCE", eventDate: detail.endDate, reference: detail.mpsNumber, qtyIn: round(officialProductionRemaining), qtyOut: 0, plannedProductionQty: round(officialProductionRemaining), projectedFreeQty: round(freeAvailable), note: "Sisa planned production resmi setelah seluruh demand dan buffer." });
    plannedProductionUsedQty += officialProductionRemaining;
    officialProductionRemaining = 0;
  }
  const firmReceiptQty = receiptEvents.filter((row) => dateValue(row.date, detail.startDate) <= dateValue(detail.endDate, detail.endDate)).reduce((sum, row) => sum + row.qty, 0);
  const expectedOpening = comparePhysicalOpening ? freeOpeningQty + peggedReservationQty : number(detail.openingAvailableQty);
  const officialOpening = number(detail.openingAvailableQty);
  const openingVarianceQty = officialOpening - expectedOpening;
  const projectedEndingVarianceQty = number(detail.projectedEndingStockQty) - freeAvailable;
  const status = uncoveredQty > EPSILON ? "SHORTAGE"
    : Math.abs(openingVarianceQty) > EPSILON || Math.abs(projectedEndingVarianceQty) > EPSILON ? "REVIEW_VARIANCE"
      : number(detail.qtyPlanned) > EPSILON ? "PRODUCTION_REQUIRED" : "STOCK_COVERED";
  // Rebuild a simple per-row allocation for display. The chronological ledger
  // above has already consumed its own pools; this map is UI-only.
  const reservationEligibility = new Map();
  for (const [reference, demandQty] of soDemandByReference) {
    const reservedQty = peggedReservations.filter((row) => text(row.referenceNumber) === reference).reduce((sum, row) => sum + remainingReservation(row), 0);
    reservationEligibility.set(reference, Math.min(reservedQty, demandQty));
  }
  const reservationLines = reservations.map((row) => {
    const remainingQty = remainingReservation(row);
    const reference = text(row.referenceNumber);
    const eligible = isSalesReservation(row) ? number(reservationEligibility.get(reference)) : 0;
    const nettableQty = Math.min(remainingQty, eligible);
    if (nettableQty > 0) reservationEligibility.set(reference, Math.max(eligible - nettableQty, 0));
    return { ...row, remainingQty: round(remainingQty), nettableQty: round(nettableQty), protectedQty: round(remainingQty - nettableQty), peggedToCurrentDemand: nettableQty > EPSILON };
  });

  return {
    status,
    metrics: {
      onHandQty: round(onHandQty), qcQty: round(qcQty), stockReservedQty: round(stockReservedQty), physicalFreeOpeningQty: round(physicalFreeOpeningQty), freeOpeningQty: round(freeOpeningQty),
      peggedReservationQty: round(peggedReservationQty), otherReservationQty: round(otherReservationQty), openingNettableQty: round(expectedOpening),
      officialOpeningQty: round(officialOpening), openingVarianceQty: round(openingVarianceQty), grossDemandQty: round(grossDemandQty),
      firmReceiptQty: round(firmReceiptQty), officialFirmReceiptQty: round(detail.firmScheduledReceiptQty), plannedProductionQty: round(detail.qtyPlanned),
      targetEndingStockQty: round(detail.targetEndingStockQty), projectedEndingQty: round(freeAvailable), officialProjectedEndingQty: round(detail.projectedEndingStockQty),
      projectedEndingVarianceQty: round(projectedEndingVarianceQty), reservationUsedQty: round(reservationUsedQty), freeStockUsedQty: round(freeStockUsedQty),
      plannedProductionUsedQty: round(plannedProductionUsedQty), uncoveredQty: round(uncoveredQty), unusedPeggedReservationQty: round([...reservationPools.values()].reduce((sum, qty) => sum + qty, 0)),
    },
    formula: {
      openingNettable: "free FG (qtyAvailable) + active reservation yang reference SO-nya ada di gross demand",
      phaseNetting: "phase demand - pegged SO reservation - free FG/firm receipt yang tersedia sebelum FG required date - planned production",
      ending: "opening free + firm receipts + planned production - demand yang memakai free supply; pegged reservation tidak boleh menjadi buffer",
    },
    phases, ledger, stockLines, reservations: reservationLines, receipts: receiptEvents,
  };
}

async function getMpsWorkbench(tx, options = {}) {
  const month = planningMonthKey(options.month || new Date());
  const demandWindow = await efdWindow(tx, month);
  const page = Math.max(Math.trunc(number(options.page)) || 1, 1);
  const pageSize = Math.min(Math.max(Math.trunc(number(options.pageSize)) || 25, 10), 100);
  const includeSimulation = ["1", "true", "yes"].includes(text(options.includeSimulation).toLowerCase());
  const detailId = text(options.detailId);
  const doc = await tx.mPS.findFirst({
    where: { sourceKey: `MONTH:${month}`, isDeleted: false, status: { not: "Superseded" } },
    orderBy: { updatedAt: "desc" },
    include: {
      details: {
        where: { isDeleted: false, NOT: { notes: { startsWith: "[MRP-PRODUCTION]" } } },
        orderBy: { lineNumber: "asc" },
        include: {
          part: true,
          demandSources: { orderBy: [{ effectiveRequiredDate: "asc" }, { sourceNumber: "asc" }] },
          mbom: {
            include: {
              details: {
                where: { isDeleted: false },
                orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
                include: {
                  part: true,
                  mbomProcesses: {
                    where: { isDeleted: false },
                    orderBy: { sequence: "asc" },
                    select: {
                      id: true, sequence: true, occurrenceCode: true, routingNumber: true, routingMode: true, cycleTime: true,
                      process: { select: { processCode: true, processName: true } },
                      vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } },
                      routingOperation: { select: { cycleSeconds: true, isSubcontract: true } },
                    },
                  },
                  parentDetail: {
                    select: {
                      category: true, leadTime: true, leadTimeUnit: true,
                      mbomProcesses: {
                        where: { isDeleted: false },
                        orderBy: { sequence: "asc" },
                        select: {
                          id: true, sequence: true, occurrenceCode: true, routingNumber: true, routingMode: true, cycleTime: true,
                          process: { select: { processCode: true, processName: true } },
                          vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } },
                          routingOperation: { select: { cycleSeconds: true, isSubcontract: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!doc) return { period: month, efdWindow: { months: demandWindow.months, totals: demandWindow.totals, total: demandWindow.total, rule: demandWindow.rule }, mps: null, rccp: null, mrp: null, items: [], blockedForecasts: await blockedForecastSources(tx, month), summary: { partCount: 0, grossDemandQty: 0, bufferBaseQty: 0, bufferQty: 0, freeOpeningQty: 0, peggedReservationQty: 0, firmReceiptQty: 0, plannedProductionQty: 0, uncoveredQty: 0, varianceCount: 0, shortageCount: 0 }, pagination: { page: 1, pageSize, filtered: 0, pages: 1 }, statuses: [] };
  const additionalCoverage = await loadAdditionalDemandCoverage(tx, {
    year: Number(month.slice(0, 4)),
    partCodes: doc.details.map((row) => row.partCode),
  });
  const coverageByPart = new Map([...additionalCoverage.byPartMonth.entries()]
    .filter(([key]) => key.startsWith(`${month}|`))
    .map(([key, value]) => [key.slice(month.length + 1), value]));
  const lockIds = additionalCoverage.items.filter((row) => row.month === month).map((row) => row.baselineLockId);
  const [deltaDocuments, cutDocuments] = await Promise.all([
    tx.mPS.findMany({
      where: { planKind: "DELTA", baselineMpsNumber: doc.mpsNumber, isDeleted: false, status: { notIn: ["Cancelled", "Superseded"] } },
      include: { details: { where: { isDeleted: false }, select: { partCode: true, qtyPlanned: true } } },
      orderBy: { createdAt: "asc" },
    }),
    lockIds.length ? tx.planningAdjustment.findMany({
      where: { baselineLockId: { in: lockIds }, adjustmentType: "PRODUCTION_CUT", status: { in: ["APPROVED", "APPLIED"] } },
      include: { lines: true },
      orderBy: { createdAt: "asc" },
    }) : [],
  ]);
  const deltaQtyByPart = new Map();
  const deltaDocumentsByPart = new Map();
  for (const delta of deltaDocuments) for (const detail of delta.details || []) {
    deltaQtyByPart.set(detail.partCode, round((deltaQtyByPart.get(detail.partCode) || 0) + number(detail.qtyPlanned)));
    if (!deltaDocumentsByPart.has(detail.partCode)) deltaDocumentsByPart.set(detail.partCode, []);
    deltaDocumentsByPart.get(detail.partCode).push(delta.mpsNumber);
  }
  const cutQtyByPart = new Map();
  const cutDocumentsByPart = new Map();
  for (const adjustment of cutDocuments) for (const line of adjustment.lines || []) {
    const cutQty = number(line.appliedCutQty) || number(line.approvedCutQty);
    cutQtyByPart.set(line.partCode, round((cutQtyByPart.get(line.partCode) || 0) + cutQty));
    if (!cutDocumentsByPart.has(line.partCode)) cutDocumentsByPart.set(line.partCode, []);
    cutDocumentsByPart.get(line.partCode).push(adjustment.adjustmentNumber);
  }
  const deliveryGate = await getMpsDeliveryGate(tx, doc);
  const planningCycleMonth = planningMonthKey(doc.planningAnchorMonth || doc.periodStart);
  const mrp = await tx.mRPRun.findFirst({
    where: {
      isDeleted: false,
      planKind: { not: "DELTA" },
      OR: [
        { mpsNumber: doc.mpsNumber },
        { planningMonth: utcMonthStart(planningCycleMonth) },
      ],
    },
    select: {
      runNumber: true, planNumber: true, planRevision: true, status: true, scenarioStatus: true, planKind: true, isCurrentPlan: true,
      totalRequirements: true, totalPlannedOrders: true, runDate: true,
      createdAt: true, updatedAt: true, errorMessage: true,
    },
    orderBy: [{ isCurrentPlan: "desc" }, { planRevision: "desc" }, { createdAt: "desc" }],
  });
  const rccp = await tx.rccpRun.findFirst({
    where: { mpsId: doc.id, invalidatedAt: null },
    include: { loads: { orderBy: { loadPercentage: "desc" } }, overrides: { orderBy: { approvedAt: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  const selectedDetail = detailId ? doc.details.find((row) => row.id === detailId) : null;
  const traceSearch = selectedDetail?.partCode || text(options.q);
  const [mrpRequirements, traceability] = mrp && includeSimulation ? await Promise.all([
    tx.mRPRequirement.findMany({
      where: { runNumber: mrp.runNumber, orderType: { in: ["Purchase", "Production"] }, isDeleted: false, ...(detailId ? { mpsDetailId: detailId } : {}) },
      orderBy: [{ requiredDate: "asc" }, { treePath: "asc" }],
      select: {
        id: true, mpsDetailId: true, partCode: true, requiredDate: true,
        orderType: true, levelMBOM: true, plannedOrderQty: true, projectedAvailableQty: true,
        targetDeliveryDate: true, deliveryTargetId: true, rootDemandSourceType: true,
        rootDemandSourceNumber: true, sourceType: true, sourceNumber: true,
        customerCode: true, customerPegging: true, grossRequirement: true,
        onHandQty: true, firmSupplyQty: true, netRequirement: true,
        part: {
          select: {
            partCode: true, partNumber: true, partName: true, itemType: true, rawType: true,
            baseUomCode: true, stockUomCode: true,
            material: { select: { materialCode: true, materialName: true } },
          },
        },
        mbomDetail: {
          select: {
            uomCode: true,
            mbomHeader: { select: { part: { select: { partCode: true, partNumber: true, partName: true } } } },
            parentDetail: {
              select: {
                part: { select: { partCode: true, partNumber: true, partName: true } },
                mbomProcesses: {
                  where: { isDeleted: false }, orderBy: { sequence: "asc" },
                  select: { occurrenceCode: true, process: { select: { processCode: true } } },
                },
              },
            },
            mbomProcesses: {
              where: { isDeleted: false }, orderBy: { sequence: "asc" },
              select: { occurrenceCode: true, process: { select: { processCode: true } } },
            },
          },
        },
      },
    }),
    buildFgCompStockTraceability(tx, { q: traceSearch }),
  ]) : [[], null];
  const childMrpRequirements = mrp?.runNumber ? await tx.mRPRequirement.findMany({
    where: { runNumber: mrp.runNumber, isDeleted: false, orderType: { in: ["Purchase", "Production"] } },
    orderBy: [{ requiredDate: "asc" }, { treePath: "asc" }],
    select: {
      mpsDetailId: true, partCode: true, requiredDate: true, orderType: true, levelMBOM: true, treePath: true,
      grossRequirement: true, onHandQty: true, firmSupplyQty: true, netRequirement: true,
      plannedOrderQty: true, projectedAvailableQty: true, targetDeliveryDate: true,
      deliveryTargetId: true, rootDemandSourceNumber: true, sourceNumber: true,
      part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, canManufacture: true, productionUomCode: true, baseUomCode: true } },
      mbomDetail: {
        select: {
          category: true, qty: true, uomCode: true, leadTime: true, leadTimeUnit: true,
          mbomProcesses: {
            where: { isDeleted: false }, orderBy: { sequence: "asc" },
            select: {
              id: true, sequence: true, occurrenceCode: true, routingNumber: true, routingMode: true, cycleTime: true,
              process: { select: { processCode: true, processName: true } },
              vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } },
              routingOperation: { select: { cycleSeconds: true, isSubcontract: true } },
            },
          },
          parentDetail: {
            select: {
              category: true, leadTime: true, leadTimeUnit: true,
              mbomProcesses: {
                where: { isDeleted: false }, orderBy: { sequence: "asc" },
                select: {
                  id: true, sequence: true, occurrenceCode: true, routingNumber: true, routingMode: true, cycleTime: true,
                  process: { select: { processCode: true, processName: true } },
                  vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } },
                  routingOperation: { select: { cycleSeconds: true, isSubcontract: true } },
                },
              },
            },
          },
        },
      },
    },
  }) : [];
  const partCodes = [...new Set(doc.details.map((row) => row.partCode).filter(Boolean))];
  const componentPartCodes = [...new Set(doc.details.flatMap((row) => (row.mbom?.details || []).map((component) => component.part?.partCode)).filter(Boolean))];
  const explodedPartCodes = [...new Set(childMrpRequirements.map((row) => row.partCode).filter(Boolean))];
  const stockPartCodes = [...new Set([...partCodes, ...componentPartCodes, ...explodedPartCodes])];
  const [stockLines, reservations, receipts, deliveryPerformance] = await Promise.all([
    stockPartCodes.length ? tx.stockBalance.findMany({ where: { partCode: { in: stockPartCodes }, isDeleted: false, warehouse: { isDeleted: false, availableForProduction: true } }, select: { id: true, partCode: true, warehouseCode: true, rackCode: true, lotNumber: true, stockType: true, uomCode: true, qtyOnHand: true, qtyAvailable: true, qtyReserved: true, qtyQC: true }, orderBy: [{ partCode: "asc" }, { warehouseCode: "asc" }, { lotNumber: "asc" }] }) : [],
    partCodes.length ? tx.stockReservation.findMany({ where: { partCode: { in: partCodes }, isDeleted: false, status: { equals: "Active", mode: "insensitive" }, warehouse: { isDeleted: false, availableForProduction: true } }, select: { id: true, reservationNumber: true, reservationDate: true, stockBalanceId: true, partCode: true, warehouseCode: true, rackCode: true, lotNumber: true, qtyReserved: true, qtyReleased: true, referenceType: true, referenceNumber: true, status: true, expiryDate: true }, orderBy: [{ partCode: "asc" }, { reservationDate: "asc" }] }) : [],
    stockPartCodes.length ? tx.manufacturingOrder.findMany({ where: { isDeleted: false, part: { partCode: { in: stockPartCodes } }, OR: [{ status: { in: ["Released", "In Progress", "Completed"] } }, { status: "Draft", referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] } }] }, select: { id: true, moNumber: true, status: true, referenceType: true, plannedOrderNumber: true, monthlyProductionPlanNumber: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, plannedStartDate: true, plannedEndDate: true, uomCode: true, part: { select: { partCode: true } } }, orderBy: [{ plannedEndDate: "asc" }, { moNumber: "asc" }] }) : [],
    buildDeliveryPerformance(tx, { month, partCodes }),
  ]);
  const stockTotalsByPart = new Map();
  for (const line of stockLines) {
    const current = stockTotalsByPart.get(line.partCode) || { onHandQty: 0, availableQty: 0, reservedQty: 0, qcQty: 0 };
    current.onHandQty += number(line.qtyOnHand);
    current.availableQty += number(line.qtyAvailable);
    current.reservedQty += number(line.qtyReserved);
    current.qcQty += number(line.qtyQC);
    stockTotalsByPart.set(line.partCode, current);
  }
  const rows = doc.details.map((detail) => {
    const netting = buildLedger({ detail, stockLines: stockLines.filter((row) => row.partCode === detail.partCode), reservations: reservations.filter((row) => row.partCode === detail.partCode), receipts: receipts.filter((row) => row.part?.partCode === detail.partCode), comparePhysicalOpening: planningMonthKey(doc.planningAnchorMonth || doc.periodStart) === month });
    const demandEvents = netting.ledger.filter((row) => row.eventType === "GROSS_DEMAND");
    const performance = deliveryPerformance.byPart.get(detail.partCode) || null;
    // Forecast dates are provisional while PO/SO is still zero. Once an SO
    // exists, only SO-backed phases remain visible as Batch Delivery.
    const phasesWithProduction = netting.phases
      .map((phase, index) => ({ ...phase, plannedProductionQty: number(demandEvents[index]?.plannedProductionQty), deliveryStatus: phaseDeliveryStatus(performance, phase) }))
      .filter((phase) => isCustomerDeliveryPhase(detail, phase));
    const bufferEvent = netting.ledger.find((row) => row.eventType === "BUFFER_TARGET");
    const allocationMode = bufferAllocationMode(detail.calculationTrace?.bufferAllocationMode);
    const rawBufferPhase = number(detail.bufferQty) > EPSILON ? {
      id: `${detail.id}:BUFFER`,
      sourceType: "BUFFER",
      sourceNumber: doc.mpsNumber,
      customerCode: null,
      qty: 0,
      phaseNumber: 1,
      targetDeliveryDate: detail.endDate,
      fgRequiredDate: detail.endDate,
      plannedProductionQty: number(bufferEvent?.plannedProductionQty),
      bufferTargetQty: number(detail.bufferQty),
      bufferBaseQty: number(detail.bufferBaseQty),
      bufferPercent: number(detail.bufferPercent),
      nextForecastMonth: nextPlanningMonthKey(month),
      deliveryStatus: phaseDeliveryStatus(performance, { sourceType: "BUFFER" }),
    } : null;
    const distributeBuffer = allocationMode === "DISTRIBUTE_TO_PHASES" && phasesWithProduction.length > 0 && number(rawBufferPhase?.plannedProductionQty) > EPSILON;
    let distributedBufferQty = 0;
    const weightedProductionQty = phasesWithProduction.reduce((sum, phase) => sum + Math.max(number(phase.plannedProductionQty), number(phase.qty)), 0);
    const allocatedPhases = distributeBuffer ? phasesWithProduction.map((phase, index) => {
      const customerProductionQty = number(phase.plannedProductionQty);
      const weight = weightedProductionQty > EPSILON
        ? Math.max(number(phase.plannedProductionQty), number(phase.qty)) / weightedProductionQty
        : 1 / phasesWithProduction.length;
      const allocation = index === phasesWithProduction.length - 1
        ? round(number(rawBufferPhase.plannedProductionQty) - distributedBufferQty)
        : round(number(rawBufferPhase.plannedProductionQty) * weight);
      distributedBufferQty = round(distributedBufferQty + allocation);
      return {
        ...phase,
        customerProductionQty: round(customerProductionQty),
        bufferAllocatedQty: allocation,
        plannedProductionQty: round(customerProductionQty + allocation),
        bufferAllocationMode: allocationMode,
      };
    }) : phasesWithProduction.map((phase) => ({ ...phase, customerProductionQty: number(phase.plannedProductionQty), bufferAllocatedQty: 0, bufferAllocationMode: allocationMode }));
    const bufferPhase = distributeBuffer ? null : rawBufferPhase;
    const planningPhases = bufferPhase ? [...allocatedPhases, bufferPhase] : allocatedPhases;
    const inventoryTrace = traceability?.items?.find((row) => row.fgPartCode === detail.partCode) || null;
    const phasePurchaseSimulation = includeSimulation && (!detailId || detailId === detail.id) ? buildPhasePurchaseSimulation({
      detail,
      phases: planningPhases,
      requirements: mrp?.isCurrentPlan ? mrpRequirements : [],
      mrp: mrp?.isCurrentPlan ? mrp : null,
      inventoryTrace,
    }) : null;
    const window = demandWindow.byPart.get(detail.partCode) || {};
    const componentMap = new Map();
    const mbomDetails = detail.mbom?.details || [];
    const mbomById = new Map(mbomDetails.map((row) => [row.id, row]));
    const cumulativeQtyPerFg = (component) => {
      let qty = number(component.qty);
      let parentId = component.parentDetailId;
      const visited = new Set([component.id]);
      while (parentId && mbomById.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = mbomById.get(parentId);
        qty *= number(parent.qty) || 1;
        parentId = parent.parentDetailId;
      }
      return round(qty);
    };
    for (const component of mbomDetails) {
      const componentCode = component.part?.partCode || component.id;
      if (!componentCode || componentCode === detail.partCode) continue;
      const parentPartCode = component.parentDetailId
        ? mbomById.get(component.parentDetailId)?.part?.partCode
        : detail.partCode;
      const dependency = {
        structureKey: `ROOT:${component.id}`,
        parentPartCode: parentPartCode || detail.partCode,
        qtyPerParent: number(component.qty) || 1,
      };
      const componentStock = stockTotalsByPart.get(componentCode) || {};
      const routeOwner = component.mbomProcesses?.length ? component : component.parentDetail;
      const route = routeOwner?.mbomProcesses || [];
      const routeVendorLeadTimeDays = leadTimeInDays(routeOwner?.leadTime, routeOwner?.leadTimeUnit);
      const processes = route.map((row) => planningProcess(row, routeOwner?.category, routeVendorLeadTimeDays));
      const existing = componentMap.get(componentCode);
      if (existing) {
        existing.qtyPerFg = round(existing.qtyPerFg + cumulativeQtyPerFg(component));
        existing.level = Math.min(existing.level, component.levelComponent);
        if (!existing.dependencies.some((row) => row.structureKey === dependency.structureKey)) existing.dependencies.push(dependency);
        for (const process of processes) if (!existing.processes.some((row) => row.id === process.id)) existing.processes.push(process);
        if (existing.type !== "INHOUSE" && String(component.category || "").toUpperCase() === "INHOUSE") existing.type = "INHOUSE";
        if (!existing.itemType && component.part?.itemType) existing.itemType = String(component.part.itemType).toUpperCase();
        if (component.part?.canManufacture === true) existing.canManufacture = true;
        continue;
      }
      componentMap.set(componentCode, {
        id: component.id, level: component.levelComponent, partCode: component.part?.partCode || null,
        partNumber: component.part?.partNumber || component.part?.partCode || null, partName: component.part?.partName || "-",
        type: String(component.category || "").toUpperCase(), qtyPerFg: cumulativeQtyPerFg(component),
        itemType: String(component.part?.itemType || "").toUpperCase() || null,
        canManufacture: component.part?.canManufacture === true,
        currentStockQty: round(componentStock.onHandQty), availableStockQty: round(componentStock.availableQty),
        leadTime: number(component.leadTime), leadTimeUnit: component.leadTimeUnit || null,
        uomCode: component.uomCode || component.part?.productionUomCode || component.part?.baseUomCode || null,
        processes, dependencies: [dependency],
      });
    }
    const explodedByPart = new Map();
    const detailMrpRequirements = childMrpRequirements.filter((row) => row.mpsDetailId === detail.id);
    const requirementByTreePath = new Map(detailMrpRequirements.filter((row) => row.treePath).map((row) => [row.treePath, row]));
    const structuralQtyForPath = (treePath) => {
      const segments = text(treePath).split(".").filter(Boolean);
      if (segments.length < 2) return 0;
      let qtyPerFg = 1;
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = requirementByTreePath.get(segments.slice(0, index + 1).join("."));
        qtyPerFg *= number(ancestor?.mbomDetail?.qty) || 1;
      }
      return round(qtyPerFg);
    };
    for (const requirement of detailMrpRequirements.filter((row) => row.partCode && row.partCode !== detail.partCode)) {
      const group = explodedByPart.get(requirement.partCode) || [];
      group.push(requirement);
      explodedByPart.set(requirement.partCode, group);
    }
    for (const [componentCode, requirements] of explodedByPart) {
      const first = requirements.find((row) => row.part) || requirements[0];
      const itemType = String(first.part?.itemType || "").toUpperCase();
      const isProductionChild = requirements.some((row) => String(row.orderType || "").toUpperCase() === "PRODUCTION");
      const componentLevels = requirements.map((row) => number(row.levelMBOM)).filter((value) => value > 0);
      const explodedLevel = componentLevels.length ? Math.min(...componentLevels) : 1;
      const meaningful = requirements.filter((row) => number(row.grossRequirement) > EPSILON);
      const grossQty = meaningful.reduce((sum, row) => sum + number(row.grossRequirement), 0);
      const targetIds = [...new Set(meaningful.map((row) => row.deliveryTargetId).filter(Boolean))];
      const rootQty = targetIds.reduce((sum, targetId) => {
        const phase = planningPhases.find((row) => row.deliveryTargetId === targetId);
        return sum + number(phase?.plannedProductionQty || phase?.qty);
      }, 0);
      const officialQtyPerFg = rootQty > EPSILON ? round(grossQty / rootQty) : 0;
      const structuralPaths = new Map();
      for (const requirement of requirements) {
        const path = text(requirement.treePath);
        const structureKey = path.split(".").slice(1).join(".");
        if (!structureKey || structuralPaths.has(structureKey)) continue;
        structuralPaths.set(structureKey, structuralQtyForPath(path));
      }
      const structuralQtyPerFg = round([...structuralPaths.values()].reduce((sum, value) => sum + number(value), 0));
      const dependencyMap = new Map();
      for (const requirement of requirements) {
        const segments = text(requirement.treePath).split(".").filter(Boolean);
        const structureKey = segments.slice(1).join(".");
        if (!structureKey || dependencyMap.has(structureKey)) continue;
        const parentPath = segments.slice(0, -1).join(".");
        const parentRequirement = requirementByTreePath.get(parentPath);
        dependencyMap.set(structureKey, {
          structureKey: `MRP:${structureKey}`,
          parentPartCode: parentRequirement?.partCode || detail.partCode,
          qtyPerParent: number(requirement.mbomDetail?.qty) || 1,
        });
      }
      const requirementDependencies = [...dependencyMap.values()];
      const processes = [];
      for (const requirement of requirements) {
        const routeOwner = requirement.mbomDetail?.mbomProcesses?.length
          ? requirement.mbomDetail
          : requirement.mbomDetail?.parentDetail;
        const route = routeOwner?.mbomProcesses || [];
        const routeVendorLeadTimeDays = leadTimeInDays(routeOwner?.leadTime, routeOwner?.leadTimeUnit);
        for (const row of route) {
          if (processes.some((process) => process.id === row.id)) continue;
          processes.push(planningProcess(row, routeOwner?.category, routeVendorLeadTimeDays));
        }
      }
      const existing = componentMap.get(componentCode);
      if (existing) {
        existing.level = Math.min(number(existing.level) || explodedLevel, explodedLevel);
        for (const process of processes) if (!existing.processes.some((row) => row.id === process.id)) existing.processes.push(process);
        existing.itemType = itemType || existing.itemType;
        existing.canManufacture = first.part?.canManufacture === true || existing.canManufacture;
        existing.isProductionChild = isProductionChild || existing.isProductionChild;
        existing.explosionSource = "MRP";
        continue;
      }
      const componentStock = stockTotalsByPart.get(componentCode) || {};
      const mbomDetail = first.mbomDetail || {};
      componentMap.set(componentCode, {
        id: `MRP:${detail.id}:${componentCode}`, level: explodedLevel,
        partCode: componentCode, partNumber: first.part?.partNumber || componentCode, partName: first.part?.partName || componentCode,
        type: String(mbomDetail.category || (first.orderType === "Production" ? "INHOUSE" : "PURCHASE")).toUpperCase(),
        itemType: itemType || null, canManufacture: first.part?.canManufacture === true, isProductionChild,
        qtyPerFg: structuralQtyPerFg > EPSILON ? structuralQtyPerFg : (number(first.mbomDetail?.qty) || officialQtyPerFg), currentStockQty: round(componentStock.onHandQty), availableStockQty: round(componentStock.availableQty),
        leadTime: number(mbomDetail.leadTime), leadTimeUnit: mbomDetail.leadTimeUnit || null,
        uomCode: mbomDetail.uomCode || first.part?.productionUomCode || first.part?.baseUomCode || null,
        processes, dependencies: requirementDependencies, explosionSource: "MRP",
      });
    }
    const componentRows = [...componentMap.values()]
      .filter((component) => ["WIP", "FG"].includes(String(component.itemType || "").toUpperCase())
        && (component.isProductionChild === true || component.canManufacture === true))
      .sort((left, right) => number(left.level) - number(right.level) || text(left.partCode).localeCompare(text(right.partCode), "id", { numeric: true }));
    const phaseNettingByPart = buildCascadingComponentNetting({
      components: componentRows,
      rootPartCode: detail.partCode,
      phases: planningPhases,
      receipts,
    });
    const nettedComponents = componentRows.map((component) => ({
      ...component,
      phaseNetting: phaseNettingByPart.get(component.partCode) || [],
    }));
    const cumulativeLeadTimeByPart = buildCumulativeComponentLeadTimes({
      components: nettedComponents,
      rootPartCode: detail.partCode,
      phases: planningPhases,
    });
    const components = nettedComponents.map((component) => ({
      ...component,
      phaseNetting: component.phaseNetting.map((netting, index) => ({
        ...netting,
        leadTime: cumulativeLeadTimeByPart.get(component.partCode)?.[index] || null,
      })),
    }));
    const stock = stockTotalsByPart.get(detail.partCode) || {};
    const efdM1 = number(window[demandWindow.months[0]]);
    const delivery = performance ? { deliveredPreviousQty: round(performance.deliveredPreviousQty), scheduledPreviousQty: round(performance.scheduledPreviousQty), previousOutstandingQty: round(performance.previousOutstandingQty), currentPlannedQty: round(performance.currentPlannedQty), currentDeliveredQty: round(performance.currentDeliveredQty), scheduleCount: performance.scheduleCount, status: performance.status, statusLabel: performance.statusLabel, statusTone: performance.statusTone, lastScheduleNumber: performance.lastScheduleNumber } : { deliveredPreviousQty: 0, scheduledPreviousQty: 0, previousOutstandingQty: 0, currentPlannedQty: 0, currentDeliveredQty: 0, scheduleCount: 0, status: "NOT_SCHEDULED", statusLabel: "Not Scheduled", statusTone: "muted", lastScheduleNumber: null };
    const leadTimeDays = components.reduce((max, component) => Math.max(
      max,
      ...(component.phaseNetting || []).map((row) => number(row.leadTime?.totalDays)),
    ), 0);
    const capacitySummary = (Array.isArray(rccp?.partSummaries) ? rccp.partSummaries : []).find((row) => row.partCode === detail.partCode);
    const coverage = coverageByPart.get(detail.partCode) || null;
    const baselineMpsQty = number(netting.metrics?.plannedProductionQty);
    const deltaMpsQty = number(deltaQtyByPart.get(detail.partCode));
    const approvedCutQty = number(cutQtyByPart.get(detail.partCode));
    return { id: detail.id, mpsNumber: doc.mpsNumber, mpsStatus: doc.status, lifecycleStatus: doc.lifecycleStatus, lineNumber: detail.lineNumber, partCode: detail.partCode, partNumber: detail.part?.partNumber, partName: detail.part?.partName, uomCode: detail.uomCode || detail.part?.productionUomCode || detail.part?.baseUomCode, customerCode: detail.customerCode, demandPolicy: detail.demandPolicy, productionPercent: detail.productionPercent, efdM1, deliveredM1: delivery.deliveredPreviousQty, shortageM1: round(Math.max(efdM1 - delivery.deliveredPreviousQty, 0)), efdM: number(window[demandWindow.months[1]]), efdMPlus1: number(window[demandWindow.months[2]]), bufferBaseQty: number(detail.bufferBaseQty), bufferPercent: number(detail.bufferPercent), bufferQty: number(detail.bufferQty), bufferAllocationMode: allocationMode, currentStockQty: round(stock.onHandQty), availableStockQty: round(stock.availableQty), stockReservedQty: round(stock.reservedQty), stockQcQty: round(stock.qcQty), leadTimeDays: round(leadTimeDays), delivery, capacity: { status: rccp?.status === "OVERRIDDEN" && capacitySummary?.capacityStatus === "OVERLOAD" ? "OVERRIDDEN" : capacitySummary?.capacityStatus || doc.capacityStatus || "NOT_CHECKED", maxLoadPercentage: number(capacitySummary?.maxLoadPercentage), rccpRunId: rccp?.id || null }, bufferTargetDate: detail.endDate, nextForecastMonth: nextPlanningMonthKey(month), bufferSource: detail.bufferOverridden ? "OVERRIDE" : "GENERAL_RULE", masterBufferPercent: number(detail.part?.bufferStock), bufferPhase, components, earliestFgRequiredDate: detail.fgRequiredDate, earliestCustomerTargetDate: detail.customerTargetDate, calculationTrace: detail.calculationTrace, planningLock: coverage ? { locked: true, lockIds: coverage.locks.map((row) => row.id), lockedAt: coverage.locks.map((row) => row.lockedAt).filter(Boolean).sort()[0] || null, lockedBy: [...new Set(coverage.locks.map((row) => row.lockedBy).filter(Boolean))].join(", ") || null } : { locked: false, lockIds: [] }, planMetrics: { baselineMpsQty: round(baselineMpsQty), deltaMpsQty: round(deltaMpsQty), approvedCutQty: round(approvedCutQty), totalPlanQty: round(Math.max(baselineMpsQty + deltaMpsQty - approvedCutQty, 0)), additionalQty: number(coverage?.additionalQty), pendingDeltaQty: number(coverage?.pendingDeltaQty), lockedPoQty: number(coverage?.poQtyLocked), currentPoQty: number(coverage?.currentSoQty), poDeltaQty: round(coverage?.poDeltaQty) }, planningDocuments: { baselineMpsNumbers: [doc.mpsNumber], deltaMpsNumbers: [...new Set(deltaDocumentsByPart.get(detail.partCode) || [])], cutNumbers: [...new Set(cutDocumentsByPart.get(detail.partCode) || [])] }, ...netting, phases: allocatedPhases, phasePurchaseSimulation };
  });
  const query = text(options.q).toLowerCase();
  const statusFilter = text(options.status).toUpperCase();
  const filtered = rows.filter((row) => (!detailId || row.id === detailId) && (!query || [row.partCode, row.partNumber, row.partName, row.customerCode, row.mpsNumber, row.delivery?.statusLabel, row.delivery?.lastScheduleNumber].some((value) => text(value).toLowerCase().includes(query))) && (!statusFilter || row.status === statusFilter || row.delivery?.status === statusFilter));
  const summary = rows.reduce((acc, row) => { acc.partCount += 1; ["grossDemandQty", "freeOpeningQty", "peggedReservationQty", "firmReceiptQty", "plannedProductionQty", "uncoveredQty"].forEach((key) => { acc[key] += number(row.metrics[key]); }); acc.bufferBaseQty += number(row.bufferBaseQty); acc.bufferQty += number(row.bufferQty); if (row.status === "REVIEW_VARIANCE") acc.varianceCount += 1; if (row.status === "SHORTAGE") acc.shortageCount += 1; return acc; }, { partCount: 0, grossDemandQty: 0, bufferBaseQty: 0, bufferQty: 0, freeOpeningQty: 0, peggedReservationQty: 0, firmReceiptQty: 0, plannedProductionQty: 0, uncoveredQty: 0, varianceCount: 0, shortageCount: 0 });
  Object.keys(summary).forEach((key) => { if (key !== "partCount" && key !== "varianceCount" && key !== "shortageCount") summary[key] = round(summary[key]); });
  const pages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const safePage = Math.min(page, pages);
  const rccpApprovalAllowed = rccp?.status === "FEASIBLE" || (rccp?.status === "WARNING" && Boolean(rccp.acknowledgedAt)) || (rccp?.status === "OVERRIDDEN" && (rccp.overrides || []).length > 0);
  const monthCoverage = [...additionalCoverage.byPartMonth.values()].filter((row) => row.month === month);
  const monthLockItems = additionalCoverage.items.filter((row) => row.month === month);
  const poDeltaQty = round(monthCoverage.reduce((sum, row) => sum + number(row.poDeltaQty), 0));
  const planningLock = { locked: monthLockItems.length > 0, lockIds, lockedAt: monthLockItems.map((row) => row.lock?.lockedAt).filter(Boolean).sort()[0] || null, lockedBy: [...new Set(monthLockItems.map((row) => row.lock?.lockedBy).filter(Boolean))].join(", ") || null, fingerprint: [...new Set(monthLockItems.map((row) => row.lock?.sourceFingerprint).filter(Boolean))].join(",") || null, poDeltaQty, changedPartCount: monthCoverage.filter((row) => Math.abs(number(row.poDeltaQty)) > EPSILON).length, hasPoDelta: monthCoverage.some((row) => Math.abs(number(row.poDeltaQty)) > EPSILON) };
  return { period: month, efdWindow: { months: demandWindow.months, totals: demandWindow.totals, total: demandWindow.total, rule: demandWindow.rule }, planningLock, mps: { mpsNumber: doc.mpsNumber, status: doc.status, lifecycleStatus: doc.lifecycleStatus, revision: doc.revision, planKind: doc.planKind, lockedAt: doc.lockedAt, lockedBy: doc.lockedBy, capacityStatus: doc.capacityStatus, capacityCheckedAt: doc.capacityCheckedAt, planningAnchorMonth: doc.planningAnchorMonth, periodStart: doc.periodStart, periodEnd: doc.periodEnd, updatedAt: doc.updatedAt, replanRequired: doc.replanRequired, replanReason: doc.replanReason, deliveryFeasibilityStatus: doc.deliveryFeasibilityStatus, deliveryDispositionStatus: doc.deliveryDispositionStatus, officialGateStatus: doc.officialGateStatus, deliveryFeasibilityCheckedAt: doc.deliveryFeasibilityCheckedAt, deliveryFeasibilityReason: doc.deliveryFeasibilityReason }, deliveryGate, rccp: rccp ? { id: rccp.id, status: rccp.status, overallLoadStatus: rccp.overallLoadStatus, mpsRevision: rccp.mpsRevision, mpsQtySnapshot: rccp.mpsQtySnapshot, warningThreshold: rccp.warningThreshold, overloadThreshold: rccp.overloadThreshold, partSummaries: rccp.partSummaries, exceptions: rccp.exceptions, acknowledgedAt: rccp.acknowledgedAt, acknowledgedBy: rccp.acknowledgedBy, approvalAllowed: rccpApprovalAllowed, maxLoadPercentage: Math.max(0, ...(rccp.loads || []).map((row) => number(row.loadPercentage))) } : null, mrp, items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize), summary, pagination: { page: safePage, pageSize, filtered: filtered.length, pages }, statuses: [...new Set(rows.map((row) => row.delivery?.status).filter(Boolean))].sort(), nettingStatuses: [...new Set(rows.map((row) => row.status))].sort(), generatedAt: new Date().toISOString(), periodStart: utcMonthStart(month), periodEnd: utcMonthEnd(month) };
}

module.exports = { getMpsWorkbench, buildLedger, demandPhases, isCustomerDeliveryPhase, blockedForecastSources, buildPhasePurchaseSimulation, phaseSimulationKey, requirementPhaseContributions };
