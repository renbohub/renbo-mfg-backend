"use strict";

const { planningMonthKey, utcMonthStart, utcMonthEnd, nextPlanningMonthKey } = require("../../utils/planningMonth");
const { buildFgCompStockTraceability } = require("../inventory/fgCompStockTraceabilityService");

const EPSILON = 0.000001;
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
    const processes = (requirement.mbomDetail?.parentDetail?.mbomProcesses?.length
      ? requirement.mbomDetail.parentDetail.mbomProcesses
      : requirement.mbomDetail?.mbomProcesses || [])
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
      const processes = (requirement.mbomDetail?.parentDetail?.mbomProcesses?.length
        ? requirement.mbomDetail.parentDetail.mbomProcesses
        : requirement.mbomDetail?.mbomProcesses || [])
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
  const phases = demandPhases(detail);
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
  const page = Math.max(Math.trunc(number(options.page)) || 1, 1);
  const pageSize = Math.min(Math.max(Math.trunc(number(options.pageSize)) || 25, 10), 100);
  const includeSimulation = ["1", "true", "yes"].includes(text(options.includeSimulation).toLowerCase());
  const detailId = text(options.detailId);
  const doc = await tx.mPS.findFirst({
    where: { sourceKey: `MONTH:${month}`, isDeleted: false, status: { not: "Superseded" } },
    orderBy: { updatedAt: "desc" },
    include: { details: { where: { isDeleted: false, NOT: { notes: { startsWith: "[MRP-PRODUCTION]" } } }, orderBy: { lineNumber: "asc" }, include: { part: true, demandSources: { orderBy: [{ effectiveRequiredDate: "asc" }, { sourceNumber: "asc" }] } } } },
  });
  if (!doc) return { period: month, mps: null, mrp: null, items: [], blockedForecasts: await blockedForecastSources(tx, month), summary: { partCount: 0, grossDemandQty: 0, bufferBaseQty: 0, bufferQty: 0, freeOpeningQty: 0, peggedReservationQty: 0, firmReceiptQty: 0, plannedProductionQty: 0, uncoveredQty: 0, varianceCount: 0, shortageCount: 0 }, pagination: { page: 1, pageSize, filtered: 0, pages: 1 }, statuses: [] };
  const planningCycleMonth = planningMonthKey(doc.planningAnchorMonth || doc.periodStart);
  const mrp = await tx.mRPRun.findFirst({
    where: {
      isDeleted: false,
      isCurrentPlan: true,
      OR: [
        { mpsNumber: doc.mpsNumber },
        { planningMonth: utcMonthStart(planningCycleMonth) },
      ],
    },
    select: {
      runNumber: true, planNumber: true, planRevision: true, status: true,
      totalRequirements: true, totalPlannedOrders: true, runDate: true,
      createdAt: true, updatedAt: true, errorMessage: true,
    },
    orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }],
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
  const partCodes = [...new Set(doc.details.map((row) => row.partCode).filter(Boolean))];
  const [stockLines, reservations, receipts] = await Promise.all([
    partCodes.length ? tx.stockBalance.findMany({ where: { partCode: { in: partCodes }, isDeleted: false, warehouse: { isDeleted: false, availableForProduction: true } }, select: { id: true, partCode: true, warehouseCode: true, rackCode: true, lotNumber: true, stockType: true, uomCode: true, qtyOnHand: true, qtyAvailable: true, qtyReserved: true, qtyQC: true }, orderBy: [{ partCode: "asc" }, { warehouseCode: "asc" }, { lotNumber: "asc" }] }) : [],
    partCodes.length ? tx.stockReservation.findMany({ where: { partCode: { in: partCodes }, isDeleted: false, status: { equals: "Active", mode: "insensitive" }, warehouse: { isDeleted: false, availableForProduction: true } }, select: { id: true, reservationNumber: true, reservationDate: true, stockBalanceId: true, partCode: true, warehouseCode: true, rackCode: true, lotNumber: true, qtyReserved: true, qtyReleased: true, referenceType: true, referenceNumber: true, status: true, expiryDate: true }, orderBy: [{ partCode: "asc" }, { reservationDate: "asc" }] }) : [],
    partCodes.length ? tx.manufacturingOrder.findMany({ where: { isDeleted: false, part: { partCode: { in: partCodes } }, OR: [{ status: { in: ["Released", "In Progress", "Completed"] } }, { status: "Draft", referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] } }] }, select: { id: true, moNumber: true, status: true, referenceType: true, plannedOrderNumber: true, monthlyProductionPlanNumber: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, plannedStartDate: true, plannedEndDate: true, uomCode: true, part: { select: { partCode: true } } }, orderBy: [{ plannedEndDate: "asc" }, { moNumber: "asc" }] }) : [],
  ]);
  const rows = doc.details.map((detail) => {
    const netting = buildLedger({ detail, stockLines: stockLines.filter((row) => row.partCode === detail.partCode), reservations: reservations.filter((row) => row.partCode === detail.partCode), receipts: receipts.filter((row) => row.part?.partCode === detail.partCode), comparePhysicalOpening: planningMonthKey(doc.planningAnchorMonth || doc.periodStart) === month });
    const demandEvents = netting.ledger.filter((row) => row.eventType === "GROSS_DEMAND");
    const phasesWithProduction = netting.phases.map((phase, index) => ({ ...phase, plannedProductionQty: number(demandEvents[index]?.plannedProductionQty) }));
    const bufferEvent = netting.ledger.find((row) => row.eventType === "BUFFER_TARGET");
    const bufferPhase = number(detail.bufferQty) > EPSILON ? {
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
    } : null;
    const planningPhases = bufferPhase ? [...phasesWithProduction, bufferPhase] : phasesWithProduction;
    const inventoryTrace = traceability?.items?.find((row) => row.fgPartCode === detail.partCode) || null;
    const phasePurchaseSimulation = includeSimulation && (!detailId || detailId === detail.id) ? buildPhasePurchaseSimulation({ detail, phases: planningPhases, requirements: mrpRequirements, mrp, inventoryTrace }) : null;
    return { id: detail.id, mpsNumber: doc.mpsNumber, mpsStatus: doc.status, lifecycleStatus: doc.lifecycleStatus, lineNumber: detail.lineNumber, partCode: detail.partCode, partNumber: detail.part?.partNumber, partName: detail.part?.partName, uomCode: detail.uomCode || detail.part?.productionUomCode || detail.part?.baseUomCode, customerCode: detail.customerCode, demandPolicy: detail.demandPolicy, productionPercent: detail.productionPercent, bufferBaseQty: number(detail.bufferBaseQty), bufferPercent: number(detail.bufferPercent), bufferQty: number(detail.bufferQty), bufferTargetDate: detail.endDate, nextForecastMonth: nextPlanningMonthKey(month), bufferSource: detail.bufferOverridden ? "OVERRIDE" : "MASTER_PART", masterBufferPercent: number(detail.part?.bufferStock), bufferPhase, earliestFgRequiredDate: detail.fgRequiredDate, earliestCustomerTargetDate: detail.customerTargetDate, calculationTrace: detail.calculationTrace, ...netting, phasePurchaseSimulation };
  });
  const query = text(options.q).toLowerCase();
  const statusFilter = text(options.status).toUpperCase();
  const filtered = rows.filter((row) => (!detailId || row.id === detailId) && (!query || [row.partCode, row.partNumber, row.partName, row.customerCode, row.mpsNumber].some((value) => text(value).toLowerCase().includes(query))) && (!statusFilter || row.status === statusFilter));
  const summary = rows.reduce((acc, row) => { acc.partCount += 1; ["grossDemandQty", "freeOpeningQty", "peggedReservationQty", "firmReceiptQty", "plannedProductionQty", "uncoveredQty"].forEach((key) => { acc[key] += number(row.metrics[key]); }); acc.bufferBaseQty += number(row.bufferBaseQty); acc.bufferQty += number(row.bufferQty); if (row.status === "REVIEW_VARIANCE") acc.varianceCount += 1; if (row.status === "SHORTAGE") acc.shortageCount += 1; return acc; }, { partCount: 0, grossDemandQty: 0, bufferBaseQty: 0, bufferQty: 0, freeOpeningQty: 0, peggedReservationQty: 0, firmReceiptQty: 0, plannedProductionQty: 0, uncoveredQty: 0, varianceCount: 0, shortageCount: 0 });
  Object.keys(summary).forEach((key) => { if (key !== "partCount" && key !== "varianceCount" && key !== "shortageCount") summary[key] = round(summary[key]); });
  const pages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const safePage = Math.min(page, pages);
  return { period: month, mps: { mpsNumber: doc.mpsNumber, status: doc.status, lifecycleStatus: doc.lifecycleStatus, planningAnchorMonth: doc.planningAnchorMonth, updatedAt: doc.updatedAt, replanRequired: doc.replanRequired, replanReason: doc.replanReason }, mrp, items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize), summary, pagination: { page: safePage, pageSize, filtered: filtered.length, pages }, statuses: [...new Set(rows.map((row) => row.status))].sort(), generatedAt: new Date().toISOString(), periodStart: utcMonthStart(month), periodEnd: utcMonthEnd(month) };
}

module.exports = { getMpsWorkbench, buildLedger, demandPhases, blockedForecastSources, buildPhasePurchaseSimulation, phaseSimulationKey, requirementPhaseContributions };
