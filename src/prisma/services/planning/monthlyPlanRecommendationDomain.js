"use strict";

const EPSILON = 1e-9;
const DEFAULT_MINIMUM_BATCH_MINUTES = 60;
const DEFAULT_TWO_SHIFT_BATCH_MINUTES = 14 * 60;

const REASON = Object.freeze({
  NEW_EARLIEST_DUE: "NEW_EARLIEST_DUE",
  MOVE_PROTECT_FG_DUE: "MOVE_PROTECT_FG_DUE",
  SPLIT_MATERIAL_BATCH: "SPLIT_MATERIAL_BATCH",
  PRESERVE_ON_TIME_ALLOCATION: "PRESERVE_ON_TIME_ALLOCATION",
  MATERIAL_NOT_AVAILABLE: "MATERIAL_NOT_AVAILABLE",
  CARRY_OVER_MATERIAL: "CARRY_OVER_MATERIAL",
  CAPACITY_OVERLOAD: "CAPACITY_OVERLOAD",
  VENDOR_MOQ_BLOCKED: "VENDOR_MOQ_BLOCKED",
});

function dateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${dateKey(value)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Tanggal tidak valid: ${value}`);
  }
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function nextAvailabilityDate(value) {
  return addDays(value, 1);
}

function createTemporalMaterialLedger(openingStock = {}, receipts = [], consumptions = []) {
  const events = [];
  const committed = [];

  Object.entries(openingStock || {}).forEach(([partCode, value]) => {
    const qty = Number(
      value && typeof value === "object"
        ? Number(value.warehouseQty || 0) + Number(value.wipQty || 0)
        : value,
    );
    if (qty > EPSILON) {
      events.push({
        partCode,
        date: "0000-01-01",
        delta: qty,
        sourceId: `OPENING:${partCode}`,
        sourceType: "OPENING_STOCK",
      });
    }
  });

  (receipts || []).forEach((row) => {
    const qty = Number(row.qty || 0);
    if (qty > EPSILON) {
      events.push({
        ...row,
        partCode: String(row.partCode || ""),
        date: dateKey(row.date),
        delta: qty,
      });
    }
  });

  (consumptions || []).forEach((row) => {
    const qty = Number(row.qty || 0);
    if (qty > EPSILON) {
      events.push({
        ...row,
        partCode: String(row.partCode || ""),
        date: dateKey(row.date),
        delta: -qty,
      });
    }
  });

  function available(partCode, date) {
    const cutoff = dateKey(date);
    const balance = [...events, ...committed]
      .filter((row) => row.partCode === partCode && row.date <= cutoff)
      .reduce((sum, row) => sum + Number(row.delta || 0), 0);
    return Math.max(balance, 0);
  }

  return {
    available,
    receipt(partCode, date, qty, sourceId, sourceType = "SCHEDULED_RECEIPT") {
      const amount = Number(qty || 0);
      if (amount > EPSILON) {
        events.push({
          partCode,
          date: dateKey(date),
          delta: amount,
          sourceId,
          sourceType,
        });
      }
    },
    consume(partCode, date, requestedQty, sourceId = null) {
      const requested = Math.max(Number(requestedQty || 0), 0);
      const allocatedQty = Math.min(available(partCode, date), requested);
      if (allocatedQty > EPSILON) {
        committed.push({
          partCode,
          date: dateKey(date),
          delta: -allocatedQty,
          sourceId,
          sourceType: "RECOMMENDATION_CONSUMPTION",
        });
      }
      return {
        allocatedQty,
        queuedQty: Math.max(requested - allocatedQty, 0),
      };
    },
    consumeDetailed(partCode, date, requestedQty, sourceId = null) {
      const cutoff = dateKey(date);
      const requested = Math.max(Number(requestedQty || 0), 0);
      const relevantEvents = events
        .filter(
          (row) =>
            row.partCode === partCode && row.date <= cutoff && Number(row.delta || 0) > EPSILON,
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            String(a.sourceId || "").localeCompare(String(b.sourceId || "")),
        );
      const usedBySource = new Map();
      const negativeEvents = [...events, ...committed]
        .filter(
          (row) =>
            row.partCode === partCode &&
            row.date <= cutoff &&
            Number(row.delta || 0) < -EPSILON,
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            String(a.sourceId || "").localeCompare(String(b.sourceId || "")),
        );
      for (const negative of negativeEvents) {
        let qtyToConsume = -Number(negative.delta || 0);
        if (negative.lotSourceId) {
          usedBySource.set(
            negative.lotSourceId,
            Number(usedBySource.get(negative.lotSourceId) || 0) + qtyToConsume,
          );
          continue;
        }
        for (const lot of relevantEvents) {
          if (qtyToConsume <= EPSILON || lot.date > negative.date) break;
          const lotKey = String(lot.sourceId || `${lot.partCode}:${lot.date}`);
          const lotAvailable = Math.max(
            Number(lot.delta || 0) - Number(usedBySource.get(lotKey) || 0),
            0,
          );
          const allocated = Math.min(lotAvailable, qtyToConsume);
          if (allocated <= EPSILON) continue;
          usedBySource.set(
            lotKey,
            Number(usedBySource.get(lotKey) || 0) + allocated,
          );
          qtyToConsume -= allocated;
        }
      }
      let remaining = requested;
      const allocations = [];
      for (const row of relevantEvents) {
        if (remaining <= EPSILON) break;
        const sourceKey = String(row.sourceId || `${row.partCode}:${row.date}`);
        const lotRemaining = Math.max(
          Number(row.delta || 0) - Number(usedBySource.get(sourceKey) || 0),
          0,
        );
        const qty = Math.min(lotRemaining, remaining);
        if (qty <= EPSILON) continue;
        allocations.push({
          qty,
          availableDate: row.date,
          sourceId: row.sourceId || null,
          sourceType: row.sourceType || "SCHEDULED_RECEIPT",
        });
        committed.push({
          partCode,
          date: cutoff,
          delta: -qty,
          sourceId,
          lotSourceId: sourceKey,
          sourceType: "RECOMMENDATION_CONSUMPTION",
        });
        usedBySource.set(sourceKey, Number(usedBySource.get(sourceKey) || 0) + qty);
        remaining -= qty;
      }
      const allocatedQty = requested - remaining;
      return {
        allocatedQty,
        queuedQty: Math.max(remaining, 0),
        allocations,
      };
    },
    nextAvailableDate(partCode, afterDate) {
      const cutoff = dateKey(afterDate);
      const candidateDates = [
        ...new Set(
          events
            .filter(
              (row) =>
                row.partCode === partCode &&
                row.date > cutoff &&
                Number(row.delta || 0) > EPSILON,
            )
            .map((row) => row.date),
        ),
      ].sort();
      return candidateDates.find((date) => available(partCode, date) > EPSILON) || null;
    },
    snapshot() {
      return [...events, ...committed].map((row) => ({ ...row }));
    },
  };
}

const routeCompare = (a, b) =>
  Number(a.sequence || 0) - Number(b.sequence || 0) ||
  String(a.occurrenceCode || "").localeCompare(String(b.occurrenceCode || "")) ||
  String(a.mbomProcessId || "").localeCompare(String(b.mbomProcessId || ""));

function deriveBackwardTargets(job) {
  let successorDate = dateKey(job.fgRequiredDate);
  return [...(job.routes || [])]
    .sort(routeCompare)
    .reverse()
    .map((route) => {
      const targetDate = successorDate;
      successorDate = addDays(
        targetDate,
        -Math.max(Number(route.leadDays || 1), 1),
      );
      return {
        route: { ...route, fgRequiredDate: route.fgRequiredDate || job.fgRequiredDate },
        targetDate,
        requestedQty: Number(job.qty || 0),
        jobLineNumber: Number(job.lineNumber || route.lineNumber || 0),
        priorityScore: Number(job.priorityScore || 0),
      };
    })
    .reverse();
}

function resourceIdentity(resource) {
  return String(
    resource.machineCode ||
      resource.vendorCode ||
      resource.machineId ||
      resource.vendorId ||
      resource.id ||
      "",
  );
}

function resourceKey(resource, targetDate) {
  return `${resource.machineId || resource.vendorId || resource.id || resourceIdentity(resource)}:${targetDate}`;
}

function availableMinutesFor(resource, targetDate) {
  const dated = resource.availableMinutesByDate?.[targetDate];
  return Number(dated == null ? resource.availableMinutes || 0 : dated);
}

function chooseResource(resources, targetDate, loadByCell, preferredId = null) {
  return [...(resources || [])]
    .map((resource) => ({ ...resource }))
    .sort((a, b) => {
      const preferredA = preferredId && [a.id, a.machineId, a.vendorId].includes(preferredId) ? 0 : 1;
      const preferredB = preferredId && [b.id, b.machineId, b.vendorId].includes(preferredId) ? 0 : 1;
      return (
        preferredA - preferredB ||
        Number(loadByCell.get(resourceKey(a, targetDate)) || a.projectedLoadMinutes || 0) -
          Number(loadByCell.get(resourceKey(b, targetDate)) || b.projectedLoadMinutes || 0) ||
        resourceIdentity(a).localeCompare(resourceIdentity(b)) ||
        String(a.id || "").localeCompare(String(b.id || ""))
      );
    })[0];
}

function vendorQuantityIsValid(route, qty) {
  const minimum = Number(route.minimumOrderQty || 0);
  const multiple = Number(route.orderMultipleQty || 0);
  if (minimum > EPSILON && qty + EPSILON < minimum) return false;
  if (multiple > EPSILON) {
    const units = qty / multiple;
    if (Math.abs(units - Math.round(units)) > EPSILON) return false;
  }
  return true;
}

function proposalSort(a, b) {
  const traceA = a.trace || {};
  const traceB = b.trace || {};
  const dateA = a.proposedValue?.targetDate || a.proposedValue?.earliestAvailableDate || "9999-12-31";
  const dateB = b.proposedValue?.targetDate || b.proposedValue?.earliestAvailableDate || "9999-12-31";
  return (
    String(traceA.fgRequiredDate || "").localeCompare(String(traceB.fgRequiredDate || "")) ||
    Number(traceA.routeSequence || 0) - Number(traceB.routeSequence || 0) ||
    dateA.localeCompare(dateB) ||
    String(a.itemType || "").localeCompare(String(b.itemType || "")) ||
    String(a.partCode || "").localeCompare(String(b.partCode || "")) ||
    String(a.sourceAllocationId || "").localeCompare(String(b.sourceAllocationId || "")) ||
    String(a.proposedValue?.materialSourceId || "").localeCompare(
      String(b.proposedValue?.materialSourceId || ""),
    )
  );
}

function commonItemFields(target) {
  return {
    lineNumber: target.route.lineNumber ?? target.jobLineNumber ?? null,
    mbomProcessId: target.route.mbomProcessId || null,
    partCode: target.route.outputPartCode || null,
    processCode: target.route.processCode || null,
  };
}

function makeVendorMoqException(target) {
  return {
    itemType: "VENDOR_MOQ_EXCEPTION",
    changeType: null,
    workCenterId: target.route.resources?.[0]?.workCenterId || null,
    sourceAllocationId: null,
    ...commonItemFields(target),
    proposedValue: {
      qty: Number(target.requestedQty || 0),
      targetDate: target.targetDate,
      minimumOrderQty: Number(target.route.minimumOrderQty || 0),
      orderMultipleQty: Number(target.route.orderMultipleQty || 0),
    },
    reasonCode: REASON.VENDOR_MOQ_BLOCKED,
    trace: {
      fgRequiredDate: dateKey(target.route.fgRequiredDate),
      routeSequence: Number(target.route.sequence || 0),
    },
    applyStatus: "PENDING",
  };
}

function makeMaterialQueue(target, queuedOutputQty, earliestAvailableDate, periodEnd) {
  const isCarryOver = Boolean(
    earliestAvailableDate && dateKey(earliestAvailableDate) > dateKey(periodEnd),
  );
  return {
    itemType: isCarryOver ? "CARRY_OVER" : "MATERIAL_QUEUE",
    changeType: null,
    workCenterId: target.route.resources?.[0]?.workCenterId || null,
    sourceAllocationId: null,
    ...commonItemFields(target),
    proposedValue: {
      qty: queuedOutputQty,
      earliestAvailableDate: earliestAvailableDate ? dateKey(earliestAvailableDate) : null,
      inputPartCode: target.route.inputPartCode || null,
    },
    reasonCode: isCarryOver
      ? REASON.CARRY_OVER_MATERIAL
      : REASON.MATERIAL_NOT_AVAILABLE,
    trace: {
      fgRequiredDate: dateKey(target.route.fgRequiredDate),
      routeSequence: Number(target.route.sequence || 0),
      requestedTargetDate: target.targetDate,
    },
    applyStatus: "PENDING",
  };
}

function makeOverloadException(proposal, loadMinutes, capacityMinutes) {
  return {
    itemType: "OVERLOAD_EXCEPTION",
    changeType: null,
    workCenterId: proposal.workCenterId,
    sourceAllocationId: proposal.sourceAllocationId,
    lineNumber: proposal.lineNumber,
    mbomProcessId: proposal.mbomProcessId,
    partCode: proposal.partCode,
    processCode: proposal.processCode,
    proposedValue: {
      ...proposal.proposedValue,
      loadMinutes,
      capacityMinutes,
    },
    reasonCode: REASON.CAPACITY_OVERLOAD,
    trace: { ...proposal.trace },
    applyStatus: "PENDING",
  };
}

function makeAllocationProposal({
  target,
  resource,
  existing,
  qty,
  scheduleDate,
  materialBatch,
  loadByCell,
}) {
  const existingQty = Number(existing?.plannedQty || 0);
  const preserved = Boolean(
    existing &&
      dateKey(existing.scheduleDate) <= target.targetDate &&
      Math.abs(existingQty - qty) <= EPSILON,
  );
  const changeType = preserved
    ? null
    : existing
      ? qty + EPSILON < existingQty
        ? "SPLIT_ALLOCATION"
        : "MOVE_ALLOCATION"
      : "ALLOCATE_REMAINING";
  const itemType = preserved
    ? "PRESERVED_ALLOCATION"
    : existing
      ? changeType
      : "NEW_ALLOCATION";
  const cellKey = resourceKey(resource, scheduleDate);
  const beforeLoad = Number(
    loadByCell.get(cellKey) || resource.projectedLoadMinutes || 0,
  );
  const addedMinutes = Number(target.route.minutesPerUnit || 0) * qty;
  const afterLoad = beforeLoad + addedMinutes;
  const capacityMinutes = availableMinutesFor(resource, scheduleDate);
  const overload = afterLoad > capacityMinutes + EPSILON;
  loadByCell.set(cellKey, afterLoad);
  return {
    itemType,
    changeType,
    workCenterId: resource.workCenterId || null,
    sourceAllocationId: existing?.id || null,
    ...commonItemFields(target),
    proposedValue: {
      qty,
      targetDate: scheduleDate,
      targetMachineId: resource.machineId || null,
      vendorId: resource.vendorId || null,
      vendorReturnDate: resource.vendorReturnDate || null,
      targetRowKey: resource.matrixRowKey || null,
      targetChildKey: resource.matrixChildKey || null,
      materialSourceId: materialBatch?.sourceId || null,
      materialAvailableDate:
        materialBatch && materialBatch.availableDate !== "0000-01-01"
          ? materialBatch.availableDate
          : null,
      overload,
      batchDurationMinutes: addedMinutes,
      minimumBatchMinutes: Number(materialBatch?.minimumBatchMinutes || DEFAULT_MINIMUM_BATCH_MINUTES),
      maximumBatchMinutes: Number(materialBatch?.maximumBatchMinutes || DEFAULT_TWO_SHIFT_BATCH_MINUTES),
    },
    reasonCode: preserved
      ? REASON.PRESERVE_ON_TIME_ALLOCATION
      : existing
        ? changeType === "SPLIT_ALLOCATION"
          ? REASON.SPLIT_MATERIAL_BATCH
          : REASON.MOVE_PROTECT_FG_DUE
        : REASON.NEW_EARLIEST_DUE,
    trace: {
      fgRequiredDate: dateKey(target.route.fgRequiredDate),
      routeSequence: Number(target.route.sequence || 0),
      materialAvailableDate:
        materialBatch && materialBatch.availableDate !== "0000-01-01"
          ? materialBatch.availableDate
          : null,
      capacityMinutes,
      loadMinutes: afterLoad,
      batchDurationMinutes: addedMinutes,
      batchPolicy: "MINIMUM_ONE_HOUR_MAXIMUM_TWO_SHIFTS_SOURCE_LIMITED",
    },
    applyStatus: "PENDING",
  };
}

function mergeMaterialBatches(rows) {
  const batches = (rows || []).filter((row) => Number(row.qty || 0) > EPSILON);
  if (!batches.length) return null;
  const datedRows = batches.filter((row) => row.availableDate !== "0000-01-01");
  const availableDate = datedRows.length
    ? datedRows.reduce((latest, row) => latest > row.availableDate ? latest : row.availableDate, datedRows[0].availableDate)
    : "0000-01-01";
  const sourceIds = batches.map((row) => row.sourceId).filter(Boolean);
  return {
    qty: batches.reduce((sum, row) => sum + Number(row.qty || 0), 0),
    availableDate,
    sourceId: sourceIds.length === 1
      ? sourceIds[0]
      : sourceIds.length
        ? `CONSOLIDATED:${sourceIds.join("+")}`
        : null,
    sourceType: batches.length === 1
      ? batches[0].sourceType
      : "CONSOLIDATED_MATERIAL_BATCH",
    sourceIds,
  };
}

function recommendationBatchQuantities(totalOutputQty, minutesPerUnit, options = {}) {
  const totalQty = Math.max(Number(totalOutputQty || 0), 0);
  const cycleMinutes = Math.max(Number(minutesPerUnit || 0), 0);
  if (totalQty <= EPSILON || cycleMinutes <= EPSILON) return totalQty > EPSILON ? [totalQty] : [];

  const minimumBatchMinutes = Math.max(
    Number(options.minimumBatchMinutes || DEFAULT_MINIMUM_BATCH_MINUTES),
    1,
  );
  const maximumBatchMinutes = Math.max(
    Number(options.maximumBatchMinutes || DEFAULT_TWO_SHIFT_BATCH_MINUTES),
    minimumBatchMinutes,
  );
  const maximumBatchQty = maximumBatchMinutes / cycleMinutes;
  if (totalQty * cycleMinutes <= maximumBatchMinutes + EPSILON) return [totalQty];

  const quantities = [];
  let remaining = totalQty;
  while (remaining > EPSILON) {
    const qty = Math.min(remaining, maximumBatchQty);
    quantities.push(qty);
    remaining -= qty;
  }

  // One hour is a recommendation minimum, not a stop target. If a two-shift
  // cut leaves a tiny tail, rebalance the last two daily lots. A complete need
  // below one hour remains valid and manual allocations stay unrestricted.
  if (quantities.length > 1) {
    const lastIndex = quantities.length - 1;
    const lastMinutes = quantities[lastIndex] * cycleMinutes;
    if (lastMinutes + EPSILON < minimumBatchMinutes) {
      const requiredQty = (minimumBatchMinutes - lastMinutes) / cycleMinutes;
      const previousIndex = lastIndex - 1;
      const previousMinutesAfterMove = (quantities[previousIndex] - requiredQty) * cycleMinutes;
      if (previousMinutesAfterMove + EPSILON >= minimumBatchMinutes) {
        quantities[previousIndex] -= requiredQty;
        quantities[lastIndex] += requiredQty;
      }
    }
  }
  return quantities.filter((qty) => qty > EPSILON);
}

function splitMaterialBatchesByProductionWindow(materialBatches, route, inputRatio, options = {}) {
  const batches = (materialBatches || []).filter((row) => Number(row.qty || 0) > EPSILON);
  const ratio = Math.max(Number(inputRatio || 1), EPSILON);
  const minutesPerUnit = Math.max(Number(route?.minutesPerUnit || 0), 0);
  const totalInputQty = batches.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const quantities = recommendationBatchQuantities(totalInputQty / ratio, minutesPerUnit, options);
  if (!quantities.length) return [];

  let sourceIndex = 0;
  let sourceRemaining = Number(batches[0]?.qty || 0);
  return quantities.map((outputQty) => {
    let requestedInputQty = outputQty * ratio;
    const fragments = [];
    while (requestedInputQty > EPSILON && sourceIndex < batches.length) {
      const source = batches[sourceIndex];
      const qty = Math.min(sourceRemaining, requestedInputQty);
      if (qty > EPSILON) fragments.push({ ...source, qty });
      sourceRemaining -= qty;
      requestedInputQty -= qty;
      if (sourceRemaining <= EPSILON) {
        sourceIndex += 1;
        sourceRemaining = Number(batches[sourceIndex]?.qty || 0);
      }
    }
    const merged = mergeMaterialBatches(fragments);
    return merged ? {
      ...merged,
      outputQty,
      batchDurationMinutes: outputQty * minutesPerUnit,
      minimumBatchMinutes: Math.max(Number(options.minimumBatchMinutes || DEFAULT_MINIMUM_BATCH_MINUTES), 1),
      maximumBatchMinutes: Math.max(Number(options.maximumBatchMinutes || DEFAULT_TWO_SHIFT_BATCH_MINUTES), 1),
    } : null;
  }).filter(Boolean);
}

function consolidateRecommendationBatches(materialBatches, route, inputRatio = 1, options = {}) {
  const batches = (materialBatches || []).filter((row) => Number(row.qty || 0) > EPSILON);
  const minutesPerUnit = Math.max(Number(route?.minutesPerUnit || 0), 0);
  const ratio = Math.max(Number(inputRatio || 1), EPSILON);
  if (
    String(route?.routingMode || "INHOUSE").toUpperCase() !== "INHOUSE"
    || minutesPerUnit <= EPSILON
  ) return batches;
  return splitMaterialBatchesByProductionWindow(batches, route, ratio, options);
}

function allocateForwardWithMaterial(targets, ledger, input, state = {}) {
  const items = [];
  const loadByCell = state.loadByCell || new Map();
  const existingAllocations = input.existingAllocations || [];
  for (const target of targets || []) {
    const route = target.route;
    const requestedQty = Number(target.requestedQty || 0);
    if (
      route.routingMode === "VENDOR" &&
      !vendorQuantityIsValid(route, requestedQty)
    ) {
      items.push(makeVendorMoqException(target));
      continue;
    }
    const ratio = Math.max(Number(route.inputQtyPerOutput || 1), EPSILON);
    const material = route.inputPartCode
      ? ledger.consumeDetailed(
          route.inputPartCode,
          target.targetDate,
          requestedQty * ratio,
          `ROUTE:${route.mbomProcessId}:${target.targetDate}`,
        )
      : {
          allocatedQty: requestedQty,
          queuedQty: 0,
          allocations: [
            {
              qty: requestedQty,
              availableDate: target.targetDate,
              sourceId: null,
              sourceType: "NO_INPUT_MATERIAL",
            },
          ],
        };
    const existing = existingAllocations.find(
      (row) =>
        Number(row.lineNumber) === Number(route.lineNumber ?? target.jobLineNumber) &&
        String(row.mbomProcessId || "") === String(route.mbomProcessId || ""),
    );
    let existingSourceRemainingQty = Math.max(Number(existing?.plannedQty || 0), 0);
    function scheduleMaterialAllocations(materialAllocations = []) {
      const recommendationBatches = consolidateRecommendationBatches(
        materialAllocations,
        route,
        ratio,
        {
          minimumBatchMinutes: input.minimumBatchMinutes,
          maximumBatchMinutes: input.maximumBatchMinutes,
        },
      );
      let previousScheduleDate = null;
      for (let batchIndex = 0; batchIndex < recommendationBatches.length; batchIndex += 1) {
        const materialBatch = recommendationBatches[batchIndex];
        const outputQty = Number(materialBatch.outputQty ?? Number(materialBatch.qty || 0) / ratio);
        if (outputQty <= EPSILON) continue;
        const backwardDate = addDays(target.targetDate, -(recommendationBatches.length - 1 - batchIndex));
        const materialDate = materialBatch.availableDate === "0000-01-01"
          ? dateKey(input.periodStart)
          : materialBatch.availableDate;
        let scheduleDate = backwardDate < materialDate ? materialDate : backwardDate;
        if (previousScheduleDate && scheduleDate <= previousScheduleDate) {
          scheduleDate = addDays(previousScheduleDate, 1);
        }
        previousScheduleDate = scheduleDate;
        if (scheduleDate > dateKey(input.periodEnd)) {
          items.push(makeMaterialQueue(target, outputQty, scheduleDate, input.periodEnd));
          continue;
        }
        const resource = chooseResource(
          route.resources,
          scheduleDate,
          loadByCell,
          existing?.machineId || existing?.vendorId || null,
        );
        if (!resource) {
          items.push(makeMaterialQueue(target, outputQty, scheduleDate, input.periodEnd));
          continue;
        }
        const proposalSlices = [];
        const existingQty = Math.min(outputQty, existingSourceRemainingQty);
        if (existing && existingQty > EPSILON) {
          proposalSlices.push({ qty: existingQty, source: existing });
          existingSourceRemainingQty -= existingQty;
        }
        const newQty = Math.max(outputQty - existingQty, 0);
        if (newQty > EPSILON) proposalSlices.push({ qty: newQty, source: null });

        for (const slice of proposalSlices) {
          const proposal = makeAllocationProposal({
            target,
            resource,
            existing: slice.source,
            qty: slice.qty,
            scheduleDate,
            materialBatch,
            loadByCell,
          });
          items.push(proposal);
          if (proposal.proposedValue.overload) {
            items.push(
              makeOverloadException(
                proposal,
                proposal.trace.loadMinutes,
                proposal.trace.capacityMinutes,
              ),
            );
          }
          const completionDate =
            route.routingMode === "VENDOR"
              ? proposal.proposedValue.vendorReturnDate || scheduleDate
              : scheduleDate;
          if (route.outputPartCode) {
            ledger.receipt(
              route.outputPartCode,
              nextAvailabilityDate(completionDate),
              slice.qty,
              `RECOMMENDATION:${route.mbomProcessId}:${scheduleDate}:${slice.source?.id || "NEW"}`,
              "RECOMMENDED_OUTPUT",
            );
          }
        }
      }
    }

    const deferredMaterial =
      route.inputPartCode && Number(material.queuedQty || 0) > EPSILON
        ? ledger.consumeDetailed(
            route.inputPartCode,
            input.periodEnd,
            material.queuedQty,
            `DEFERRED:${route.mbomProcessId}:${target.targetDate}`,
          )
        : { queuedQty: Number(material.queuedQty || 0), allocations: [] };
    scheduleMaterialAllocations([
      ...(material.allocations || []),
      ...(deferredMaterial.allocations || []),
    ]);

    const queuedOutputQty = Number(deferredMaterial.queuedQty || 0) / ratio;
    if (queuedOutputQty > EPSILON) {
      const earliestAvailableDate = ledger.nextAvailableDate(
        route.inputPartCode,
        input.periodEnd,
      );
      items.push(
        makeMaterialQueue(
          target,
          queuedOutputQty,
          earliestAvailableDate,
          input.periodEnd,
        ),
      );
    }
  }
  return items;
}

function finalizeRecommendation(items, periodEnd, jobs = []) {
  const sequencedItems = [...(items || [])]
    .sort(proposalSort)
    .map((item, index) => ({ ...item, sequence: index + 1 }));
  const overloadCells = new Set(
    sequencedItems
      .filter((item) => item.itemType === "OVERLOAD_EXCEPTION")
      .map(
        (item) =>
          `${item.proposedValue.targetMachineId || item.proposedValue.vendorId || item.workCenterId}:${item.proposedValue.targetDate}`,
      ),
  );
  const jobsWithOnTime = new Set(
    sequencedItems
      .filter(
        (item) =>
          ["NEW_ALLOCATION", "MOVE_ALLOCATION", "SPLIT_ALLOCATION", "PRESERVED_ALLOCATION"].includes(
            item.itemType,
          ) &&
          item.proposedValue?.targetDate <= item.trace?.fgRequiredDate,
      )
      .map((item) => String(item.lineNumber)),
  );
  const allJobLines = new Set(
    (jobs || []).map((job) => String(job.lineNumber || job.routes?.[0]?.lineNumber || "")),
  );
  const queueItems = sequencedItems.filter((item) =>
    ["MATERIAL_QUEUE", "CARRY_OVER"].includes(item.itemType),
  );
  const allocationItems = sequencedItems.filter((item) =>
    ["NEW_ALLOCATION", "MOVE_ALLOCATION", "SPLIT_ALLOCATION", "PRESERVED_ALLOCATION"].includes(item.itemType),
  );
  const allocatedQtyByRoute = new Map();
  for (const item of allocationItems) {
    const key = `${Number(item.lineNumber || 0)}|${String(item.mbomProcessId || "")}`;
    allocatedQtyByRoute.set(
      key,
      Number(allocatedQtyByRoute.get(key) || 0) + Number(item.proposedValue?.qty || 0),
    );
  }
  let remainingAllocationQty = 0;
  let fgCoveredCount = 0;
  let fgUncoveredCount = 0;
  for (const job of jobs || []) {
    let jobCovered = true;
    for (const route of job.routes || []) {
      const key = `${Number(route.lineNumber ?? job.lineNumber ?? 0)}|${String(route.mbomProcessId || "")}`;
      const routeDeficit = Math.max(Number(job.qty || 0) - Number(allocatedQtyByRoute.get(key) || 0), 0);
      remainingAllocationQty += routeDeficit;
      if (routeDeficit > EPSILON) jobCovered = false;
    }
    if (jobCovered) fgCoveredCount += 1;
    else fgUncoveredCount += 1;
  }
  return {
    summary: {
      fgOnTimeCount: jobsWithOnTime.size,
      fgLateCount: Math.max(allJobLines.size - jobsWithOnTime.size, 0),
      newAllocationCount: sequencedItems.filter(
        (item) => item.itemType === "NEW_ALLOCATION",
      ).length,
      movedOrSplitCount: sequencedItems.filter((item) =>
        ["MOVE_ALLOCATION", "SPLIT_ALLOCATION"].includes(item.itemType),
      ).length,
      overloadCellCount: overloadCells.size,
      materialQueueQty: queueItems
        .filter((item) => item.itemType === "MATERIAL_QUEUE")
        .reduce((sum, item) => sum + Number(item.proposedValue.qty || 0), 0),
      carryOverQty: queueItems
        .filter((item) => item.itemType === "CARRY_OVER")
        .reduce((sum, item) => sum + Number(item.proposedValue.qty || 0), 0),
      fgCoveredCount,
      fgUncoveredCount,
      fgCoverageReady: fgUncoveredCount === 0,
      remainingAllocationQty,
      periodEnd: dateKey(periodEnd),
    },
    items: sequencedItems,
  };
}

function buildMonthlyPlanRecommendation(input = {}) {
  const jobs = [...(input.jobs || [])].sort(
    (a, b) =>
      dateKey(a.fgRequiredDate).localeCompare(dateKey(b.fgRequiredDate)) ||
      Number(b.priorityScore || 0) - Number(a.priorityScore || 0) ||
      Number(a.lineNumber || 0) - Number(b.lineNumber || 0),
  );
  const ledger = createTemporalMaterialLedger(
    input.openingStock,
    input.receipts,
    input.consumptions,
  );
  const state = { loadByCell: new Map() };
  const items = [];
  for (const job of jobs) {
    items.push(
      ...allocateForwardWithMaterial(
        deriveBackwardTargets(job),
        ledger,
        input,
        state,
      ),
    );
  }
  return finalizeRecommendation(items, input.periodEnd, jobs);
}

module.exports = {
  REASON,
  addDays,
  allocateForwardWithMaterial,
  buildMonthlyPlanRecommendation,
  consolidateRecommendationBatches,
  createTemporalMaterialLedger,
  dateKey,
  deriveBackwardTargets,
  finalizeRecommendation,
  nextAvailabilityDate,
  recommendationBatchQuantities,
  splitMaterialBatchesByProductionWindow,
  DEFAULT_MINIMUM_BATCH_MINUTES,
  DEFAULT_TWO_SHIFT_BATCH_MINUTES,
};
