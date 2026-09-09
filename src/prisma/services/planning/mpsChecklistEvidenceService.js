"use strict";

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const qty = (value) => finite(value) ? Number(value) : 0;
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
const minutes = (later, earlier) => date(later) && date(earlier) ? (date(later) - date(earlier)) / 60000 : null;
const EPSILON = 0.000001;

function firmSupplyEvidence(components = [], current = false) {
  if (!current || !components.length) return { externalDependent: null };
  const incomplete = components.some((row) => !finite(row.qty ?? row.requiredComponentQty) || !finite(row.openingQty) || !Array.isArray(row.eligibleSupply));
  if (incomplete) return { externalDependent: true, missingFields: ["materialCoverage.receiptAllocation"] };
  const rows = components.map((row) => {
    const requiredQty = Math.max(qty(row.qty ?? row.requiredComponentQty) - qty(row.openingQty), 0);
    const onTime = row.eligibleSupply.filter((receipt) => date(receipt.availableDate) && date(row.requiredDate) && date(receipt.availableDate) <= date(row.requiredDate));
    const onTimeFirmQty = onTime.filter((receipt) => receipt.confidence === "FIRM").reduce((sum, receipt) => sum + qty(receipt.qty), 0);
    const unconfirmedQty = onTime.filter((receipt) => receipt.confidence !== "FIRM").reduce((sum, receipt) => sum + qty(receipt.qty), 0);
    const gapQty = Math.max(requiredQty - onTimeFirmQty, 0);
    const lateFirmQty = (row.lateSupply || []).filter((receipt) => receipt.confidence === "FIRM").reduce((sum, receipt) => sum + qty(receipt.qty), 0);
    return { partCode: row.partCode, uomCode: row.uomCode, requiredDate: row.requiredDate, requiredQty, onTimeFirmQty, unconfirmedQty, gapQty, lateQty: Math.min(gapQty, lateFirmQty), receipts: [...row.eligibleSupply, ...(row.lateSupply || [])] };
  }).filter((row) => row.requiredQty > EPSILON);
  if (!rows.length) return { externalDependent: false };
  // Components can have different UOMs. Count covered components; retain exact
  // per-material quantities and PO references in evidence, never add kg to pcs.
  return {
    externalDependent: true, unit: "component", requiredReceiptQty: rows.length,
    firmReceiptQty: rows.filter((row) => row.onTimeFirmQty + row.lateQty > EPSILON).length,
    onTimeFirmReceiptQty: rows.filter((row) => row.gapQty <= EPSILON).length,
    lateReceiptQty: rows.filter((row) => row.lateQty > EPSILON).length,
    unconfirmedReceiptQty: rows.filter((row) => row.gapQty > EPSILON && row.unconfirmedQty > EPSILON).length,
    causesDeliveryMiss: rows.some((row) => row.gapQty - row.unconfirmedQty > EPSILON),
    affectedPoNumbers: [...new Set(rows.flatMap((row) => row.receipts.filter((receipt) => receipt.sourceType === "PO").map((receipt) => receipt.sourceNumber)).filter(Boolean))],
    evidence: rows,
  };
}

function operationalEvidence({ snapshot, requiredAt, phaseQty, dueQty, stockUsedQty, qcHoldQty, routeProcesses = [], deliverySchedules = [] }) {
  const detail = snapshot?.assessmentDetail || {};
  const current = snapshot?.sourceCurrent === true && !["STALE", "UNKNOWN"].includes(snapshot.feasibilityStatus);
  const trace = current ? detail.earliestFgCalculation || {} : {};
  const forward = current ? detail.solver?.forward : null;
  const solved = ["OPTIMAL", "FEASIBLE"].includes(String(forward?.status).toUpperCase());
  const tasks = solved ? forward.tasks || [] : [];
  const timeline = current ? detail.processTimeline || [] : [];
  const qualityProcesses = timeline.filter((row) => /(^|[^A-Z])(QC|INS|INSPECTION|INSPEKSI|QUALITY)([^A-Z]|$)/i.test(row.processCode || ""));
  const qualityTasks = qualityProcesses.map((row) => tasks.find((task) => task.id === row.solverTaskId));
  const latestAllowedReleaseAt = date(requiredAt) && finite(trace.dispatchDays)
    ? new Date(date(requiredAt).getTime() - Number(trace.dispatchDays) * 86400000) : null;
  let quality = { evaluated: false, missingFields: current ? ["routing.qcOperation", "solver.forward.qcReleaseAt"] : ["currentDeliverySnapshot"] };
  if (phaseQty <= EPSILON && finite(stockUsedQty) && stockUsedQty + EPSILON >= dueQty) {
    quality = { evaluated: true, stockReleased: true, qcHoldQty, qcDelayMinutes: 0, causesDeliveryMiss: false, latestAllowedReleaseAt: requiredAt, evidence: [{ sourceType: "MPS_STOCK_NETTING", usableStockUsedQty: stockUsedQty, excludedQcHoldQty: qcHoldQty }] };
  } else if (qualityProcesses.length && qualityTasks.every((task) => date(task?.endDate)) && latestAllowedReleaseAt) {
    const expectedReleaseAt = new Date(Math.max(...qualityTasks.map((task) => date(task.endDate).getTime())));
    const delay = Math.max(minutes(expectedReleaseAt, latestAllowedReleaseAt), 0);
    quality = { evaluated: true, planningOnly: true, expectedReleaseAt, latestAllowedReleaseAt, qcHoldQty, qcDelayMinutes: delay, causesDeliveryMiss: delay > 0, evidence: qualityTasks.map((task) => ({ sourceType: "CP_SAT_QC_OPERATION", ...task })) };
  }
  // A calculated dispatch duration is not a confirmed vehicle/dispatch booking.
  // Expose the timing as evidence but keep the missing booking as an open check.
  let delivery = { evaluated: false, missingFields: current && date(trace.earliestFeasibleDeliveryDate) ? ["deliverySchedule", "deliverySchedule.carrierOrVehicle"] : ["currentDeliverySnapshot", "deliverySchedule"], evidence: current ? [{ sourceType: "CP_SAT_DELIVERY_TIMING", projectedCustomerArrivalAt: trace.earliestFeasibleDeliveryDate || null, plannedDispatchAt: trace.earliestFeasibleFgDate || null, dispatchDays: finite(trace.dispatchDays) ? trace.dispatchDays : null }] : [] };
  // Same SO line AND customer appointment date: never reuse another batch's
  // vehicle/quantity just because it has the same part or SO number.
  const bookings = deliverySchedules.filter((row) => snapshot?.sourceType === "SALES_ORDER"
    && row.soNumber === snapshot.sourceNumber && row.soDetailId === snapshot.sourceLineId
    && date(row.plannedDate) && date(requiredAt)
    && date(row.plannedDate).toISOString().slice(0, 10) === date(requiredAt).toISOString().slice(0, 10)
    && !["Cancelled", "Canceled"].includes(row.status));
  if (bookings.length) {
    const delivered = bookings.every((row) => row.status === "Delivered" && date(row.actualDate));
    const missingFields = [!delivered && !date(trace.earliestFeasibleDeliveryDate) ? "currentDeliverySnapshot.projectedArrival" : null,
      !delivered && bookings.some((row) => !row.carrier && !row.vehicle) ? "deliverySchedule.carrierOrVehicle" : null].filter(Boolean);
    const arrivals = bookings.map((row) => date(delivered ? row.actualDate : row.plannedDate));
    const projected = date(trace.earliestFeasibleDeliveryDate);
    if (!delivered && projected) arrivals.push(projected);
    delivery = { evaluated: missingFields.length === 0, missingFields,
      requiredDeliveryAt: requiredAt, projectedCustomerArrivalAt: new Date(Math.max(...arrivals.map((value) => value.getTime()))),
      slotAvailable: bookings.reduce((sum, row) => sum + qty(delivered ? row.deliveredQty : row.plannedQty), 0) + EPSILON >= dueQty,
      carrierOrVehicle: [...new Set(bookings.map((row) => row.carrier || row.vehicle).filter(Boolean))].join(", ") || null,
      evidence: bookings.map((row) => ({ sourceType: "DELIVERY_SCHEDULE", ...row })),
    };
  }
  const operations = routeProcesses.filter((row) => row.routingOperation);
  // Yield is a manufacturing constraint; purchase MOQ is not an FG lot policy.
  const missingYield = !operations.length || operations.some((row) => !finite(row.routingOperation.yieldPercent));
  const yieldRisk = operations.some((row) => qty(row.routingOperation.yieldPercent) < 100);
  const invalidYield = operations.some((row) => qty(row.routingOperation.yieldPercent) <= 0 || qty(row.routingOperation.yieldPercent) > 100);
  const lot = missingYield ? { evaluated: false, missingFields: ["routingOperation.yieldPercent"] } : {
    evaluated: true, valid: !invalidYield, deliverable: !invalidYield, requiresYieldAllowance: yieldRisk,
    roundedMpsQty: phaseQty, evidence: operations.map((row) => ({ sourceType: "ROUTING_OPERATION", operationId: row.routingOperation.id, yieldPercent: row.routingOperation.yieldPercent })),
  };
  return { quality, delivery, lot, firmSupply: firmSupplyEvidence(detail.materialCoverage || [], current), current };
}

module.exports = { firmSupplyEvidence, operationalEvidence };
