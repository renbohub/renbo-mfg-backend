"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value) => Number(number(value).toFixed(6));
const unique = (values = []) => [...new Set(values.filter(Boolean))];

function roundedPurchaseQty(netRequirement, moq, orderMultiple) {
  const net = Math.max(number(netRequirement), 0);
  if (net <= 0) return 0;
  const minimum = Math.max(net, number(moq));
  const multiple = number(orderMultiple);
  return round(multiple > 0 ? Math.ceil(minimum / multiple) * multiple : minimum);
}

function splitSourcesForCoverage(sources = [], requestedQty, context = {}) {
  let remaining = Math.max(number(requestedQty), 0);
  const pulled = [];
  const retained = [];
  for (const source of sources) {
    const sourceQty = Math.max(number(source.qty), 0);
    const takeQty = Math.min(sourceQty, remaining);
    const grossQty = Math.max(number(source.grossQty), sourceQty);
    if (takeQty > 0) {
      const ratio = sourceQty > 0 ? takeQty / sourceQty : 0;
      pulled.push({
        ...source,
        qty: round(takeQty),
        grossQty: round(grossQty * ratio),
        originalDemandQty: number(source.originalDemandQty || sourceQty),
        allocationQty: round(takeQty),
        allocationType: "MOQ_PULL_FORWARD",
        pulledFromRequiredDate: context.futureRequiredDate || source.requiredDate || null,
        coveredByRequiredDate: context.purchaseRequiredDate || null,
      });
      remaining = round(remaining - takeQty);
    }
    const retainedQty = round(sourceQty - takeQty);
    if (retainedQty > 0) {
      const ratio = sourceQty > 0 ? retainedQty / sourceQty : 0;
      retained.push({
        ...source,
        qty: retainedQty,
        grossQty: round(grossQty * ratio),
        originalDemandQty: number(source.originalDemandQty || sourceQty),
        allocationQty: retainedQty,
        allocationType: source.allocationType || "DIRECT_DEMAND",
      });
    }
    if (remaining <= 0 && sourceQty <= 0) retained.push(source);
  }
  return { pulled, retained, coveredQty: round(Math.max(number(requestedQty) - remaining, 0)) };
}

function allocationIdentity(item = {}) {
  return [
    item.materialCode || item.partCode || "-",
    item.suggestedSupplierCode || "",
    item.warehouseCode || "",
    item.uomCode || "",
  ].join("|");
}

function sourceRequirementKey(source = {}, index = 0) {
  return String(source.id || [source.sourceType, source.sourceNumber, source.partCode, source.requiredDate, index].filter(Boolean).join("|") || index);
}

function buildMoqAllocationCandidates(items = [], currentItemId, externalCandidates = []) {
  const current = items.find((item) => String(item.id) === String(currentItemId));
  if (!current) return [];
  const currentDate = new Date(current.materialRequiredDate).getTime();
  const candidateByRequirement = new Map();
  const rememberedPool = Array.isArray(current.productionLeadTimeBreakdown?.moqAllocation?.allocationPool)
    ? current.productionLeadTimeBreakdown.moqAllocation.allocationPool
    : [];
  const existingPulled = (Array.isArray(current.sourceRequirements) ? current.sourceRequirements : [])
    .filter((source) => source.allocationType === "MOQ_PULL_FORWARD");
  const currentDemandSources = (Array.isArray(current.sourceRequirements) ? current.sourceRequirements : [])
    .filter((source) => source.allocationType !== "MOQ_PULL_FORWARD" && source.allocationType !== "MOQ_ALLOCATION_POOL");
  for (const [index, source] of currentDemandSources.entries()) {
    const sourceRequirementId = sourceRequirementKey(source, index);
    const demandQty = Math.max(number(source.demandCoveredQty ?? source.qty), 0);
    candidateByRequirement.set(sourceRequirementId, {
      sourceItemId: current.id,
      sourceRequirementId,
      availableQty: demandQty,
      currentDemandQty: demandQty,
      allocatedQty: Math.max(number(source.reservedAllocationQty), 0),
      coveredDemandQty: demandQty,
      reservedAllocationQty: Math.max(number(source.reservedAllocationQty), 0),
      isCurrentDemand: true,
      isExistingAllocation: number(source.reservedAllocationQty) > 0,
      partCode: source.partCode || current.partCode || null,
      partNumber: source.partNumber || current.partNumber || null,
      customerCode: source.customerCode || null,
      sourceType: source.sourceType || null,
      sourceNumber: source.sourceNumber || null,
      deliveryTargetId: source.deliveryTargetId || null,
      targetDeliveryDate: source.targetDeliveryDate || current.customerDeliveryDate || null,
      requiredDate: source.requiredDate || current.materialRequiredDate || null,
      materialRequiredDate: current.materialRequiredDate,
      uomCode: current.uomCode || null,
    });
  }
  for (const [index, source] of [...rememberedPool, ...existingPulled].entries()) {
    const sourceRequirementId = sourceRequirementKey(source, index);
    const originalDemandQty = number(source.originalDemandQty) > 0 ? number(source.originalDemandQty) : number(source.qty);
    const existing = existingPulled.find((candidate, candidateIndex) => sourceRequirementKey(candidate, candidateIndex) === sourceRequirementId);
    const allocatedQty = number(existing?.allocationQty ?? existing?.qty);
    const coveredDemandQty = Math.min(number(existing?.demandCoveredQty ?? allocatedQty), originalDemandQty);
    candidateByRequirement.set(sourceRequirementId, {
      sourceItemId: current.id,
      sourceRequirementId,
      availableQty: originalDemandQty,
      allocatedQty,
      coveredDemandQty,
      reservedAllocationQty: round(Math.max(allocatedQty - coveredDemandQty, 0)),
      isExistingAllocation: true,
      partCode: source.partCode || current.partCode || null,
      partNumber: source.partNumber || null,
      customerCode: source.customerCode || null,
      sourceType: source.sourceType || null,
      sourceNumber: source.sourceNumber || null,
      deliveryTargetId: source.deliveryTargetId || null,
      targetDeliveryDate: source.targetDeliveryDate || current.customerDeliveryDate || null,
      requiredDate: source.requiredDate || source.pulledFromRequiredDate || null,
      materialRequiredDate: source.pulledFromRequiredDate || source.requiredDate || null,
      uomCode: current.uomCode || null,
    });
  }
  const futureCandidates = items
    .filter((item) => String(item.id) !== String(current.id)
      && !item.isDeleted
      && allocationIdentity(item) === allocationIdentity(current)
      && new Date(item.materialRequiredDate).getTime() > currentDate
      && Math.max(number(item.netRequirement), 0) > 0
      && !["Converted to PR", "Partially Converted to PR", "Cancelled"].includes(item.status))
    .sort((left, right) => new Date(left.materialRequiredDate) - new Date(right.materialRequiredDate))
    .flatMap((item) => {
      let remainingItemQty = Math.max(number(item.netRequirement), 0);
      return (Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).map((source, index) => {
        const availableQty = round(Math.min(Math.max(number(source.qty), 0), remainingItemQty));
        remainingItemQty = round(Math.max(remainingItemQty - availableQty, 0));
        return {
          sourceItemId: item.id,
          sourceRequirementId: sourceRequirementKey(source, index),
          availableQty,
          allocatedQty: 0,
          coveredDemandQty: 0,
          reservedAllocationQty: 0,
          isExistingAllocation: false,
          partCode: source.partCode || item.partCode || null,
          partNumber: source.partNumber || item.partNumber || null,
          customerCode: source.customerCode || null,
          sourceType: source.sourceType || null,
          sourceNumber: source.sourceNumber || null,
          deliveryTargetId: source.deliveryTargetId || null,
          targetDeliveryDate: source.targetDeliveryDate || item.customerDeliveryDate || null,
          requiredDate: source.requiredDate || item.materialRequiredDate || null,
          materialRequiredDate: item.materialRequiredDate,
          uomCode: item.uomCode || current.uomCode || null,
        };
      }).filter((candidate) => candidate.availableQty > 0);
    });
  for (const candidate of futureCandidates) {
    if (!candidateByRequirement.has(candidate.sourceRequirementId)) candidateByRequirement.set(candidate.sourceRequirementId, candidate);
  }
  for (const candidate of externalCandidates) {
    if (!candidate?.sourceRequirementId || candidateByRequirement.has(String(candidate.sourceRequirementId))) continue;
    candidateByRequirement.set(String(candidate.sourceRequirementId), { allocatedQty: 0, coveredDemandQty: 0, reservedAllocationQty: 0, isExistingAllocation: false, ...candidate });
  }
  return [...candidateByRequirement.values()].sort((left, right) => {
    if (Boolean(left.isCurrentDemand) !== Boolean(right.isCurrentDemand)) return left.isCurrentDemand ? -1 : 1;
    return new Date(left.targetDeliveryDate || left.materialRequiredDate || 0) - new Date(right.targetDeliveryDate || right.materialRequiredDate || 0);
  });
}

function applyConfirmedMoqPullForward({ items = [], currentItemId, confirmedPurchaseQty = 0, selections = [] } = {}) {
  const rows = items.map((item) => ({
    ...item,
    sourceRequirements: (Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).map((source) => ({ ...source })),
  }));
  const current = rows.find((item) => String(item.id) === String(currentItemId));
  if (!current) throw Object.assign(new Error("Item Purchase Suggestion tidak ditemukan."), { status: 404 });
  if (number(current.qtyConvertedToPr) > 0 && selections.length) {
    throw Object.assign(new Error("Alokasi kelebihan MOQ tidak dapat diubah setelah sebagian qty dibuat menjadi PR."), { status: 409 });
  }
  const existingPulledSources = current.sourceRequirements.filter((source) => source.allocationType === "MOQ_PULL_FORWARD");
  const directSources = current.sourceRequirements.filter((source) => source.allocationType !== "MOQ_PULL_FORWARD");
  const directSourceIndexByRequirement = new Map(directSources.map((source, index) => [sourceRequirementKey(source, index), index]));
  const existingPulledDemandQty = existingPulledSources.reduce((sum, source) => {
    const originalDemandQty = number(source.originalDemandQty) > 0 ? number(source.originalDemandQty) : number(source.qty);
    return sum + Math.min(number(source.demandCoveredQty ?? source.qty), originalDemandQty);
  }, 0);
  const directDemandQty = round(Math.max(number(current.netRequirement) - existingPulledDemandQty, 0));
  const capacity = round(Math.max(number(confirmedPurchaseQty) - directDemandQty, 0));
  const explicitSelectionTotal = (selection) => {
    const hasExplicitSplit = Object.prototype.hasOwnProperty.call(selection || {}, "demandCoveredQty")
      || Object.prototype.hasOwnProperty.call(selection || {}, "reservedAllocationQty");
    return hasExplicitSplit
      ? Math.max(number(selection.demandCoveredQty), 0) + Math.max(number(selection.reservedAllocationQty), 0)
      : Math.max(number(selection.qty), 0);
  };
  const requested = selections.reduce((sum, selection) => sum + explicitSelectionTotal(selection), 0);
  if (requested > capacity + 0.000001) {
    throw Object.assign(new Error(`Total alokasi kebutuhan berikutnya (${round(requested)}) melebihi kelebihan qty pembelian (${capacity}).`), { status: 400 });
  }

  const rememberedPool = Array.isArray(current.productionLeadTimeBreakdown?.moqAllocation?.allocationPool)
    ? current.productionLeadTimeBreakdown.moqAllocation.allocationPool.map((source) => ({ ...source }))
    : [];
  const poolByRequirement = new Map();
  for (const [index, source] of [...rememberedPool, ...existingPulledSources].entries()) {
    const key = sourceRequirementKey(source, index);
    const existing = poolByRequirement.get(key);
    const originalDemandQty = number(source.originalDemandQty) > 0
      ? number(source.originalDemandQty)
      : number(existing?.originalDemandQty) > 0 ? number(existing.originalDemandQty) : number(source.qty);
    poolByRequirement.set(key, { ...(existing || {}), ...source, qty: originalDemandQty, originalDemandQty, allocationQty: originalDemandQty, allocationType: "MOQ_ALLOCATION_POOL" });
  }
  current.sourceRequirements = directSources.map((source) => ({
    ...source,
    allocationQty: number(source.demandCoveredQty ?? source.qty),
    reservedAllocationQty: 0,
  }));
  let pulledAllocationQty = 0;
  let pulledDemandQty = 0;
  let reservedAllocationQty = 0;
  let currentDemandReserveQty = 0;
  let futureDemandReserveQty = 0;
  const coveredDates = new Set();
  for (const selection of selections) {
    const hasExplicitSplit = Object.prototype.hasOwnProperty.call(selection || {}, "demandCoveredQty")
      || Object.prototype.hasOwnProperty.call(selection || {}, "reservedAllocationQty");
    if (String(selection.sourceItemId) === String(current.id)) {
      const pooled = poolByRequirement.get(String(selection.sourceRequirementId));
      if (!pooled) {
        const directSourceIndex = directSourceIndexByRequirement.get(String(selection.sourceRequirementId));
        if (directSourceIndex == null) throw Object.assign(new Error("Sumber alokasi MOQ sudah berubah. Muat ulang Purchase Suggestion."), { status: 409 });
        const directSource = current.sourceRequirements[directSourceIndex];
        const reserveQty = round(hasExplicitSplit ? Math.max(number(selection.reservedAllocationQty), 0) : Math.max(number(selection.qty), 0));
        if (hasExplicitSplit && number(selection.demandCoveredQty) > 0.000001) {
          throw Object.assign(new Error("Coverage kebutuhan pengiriman ini sudah dialokasikan otomatis; tambahan qty harus dimasukkan ke Custom Reserve."), { status: 400 });
        }
        if (reserveQty <= 0) continue;
        directSource.originalDemandQty = number(directSource.originalDemandQty || directSource.qty);
        directSource.demandCoveredQty = number(directSource.qty);
        directSource.reservedAllocationQty = reserveQty;
        directSource.allocationQty = round(number(directSource.qty) + reserveQty);
        directSource.allocationType = directSource.allocationType || "DIRECT_DEMAND";
        pulledAllocationQty = round(pulledAllocationQty + reserveQty);
        reservedAllocationQty = round(reservedAllocationQty + reserveQty);
        currentDemandReserveQty = round(currentDemandReserveQty + reserveQty);
        continue;
      }
      const demandLimit = number(pooled.originalDemandQty);
      const demandCoveredQty = round(hasExplicitSplit ? Math.max(number(selection.demandCoveredQty), 0) : Math.min(Math.max(number(selection.qty), 0), demandLimit));
      const reserveQty = round(hasExplicitSplit ? Math.max(number(selection.reservedAllocationQty), 0) : Math.max(number(selection.qty) - demandCoveredQty, 0));
      const qty = round(demandCoveredQty + reserveQty);
      if (demandCoveredQty > demandLimit + 0.000001) throw Object.assign(new Error("Coverage Demand tidak boleh melebihi demand asli. Masukkan kelebihan qty ke Custom Reserve."), { status: 400 });
      if (qty <= 0) continue;
      const ratio = number(pooled.originalDemandQty) > 0 ? demandCoveredQty / number(pooled.originalDemandQty) : 0;
      current.sourceRequirements.push({ ...pooled, qty, grossQty: round(number(pooled.grossQty || pooled.originalDemandQty) * ratio), allocationQty: qty, demandCoveredQty, reservedAllocationQty: reserveQty, allocationType: "MOQ_PULL_FORWARD" });
      pulledAllocationQty = round(pulledAllocationQty + qty);
      pulledDemandQty = round(pulledDemandQty + demandCoveredQty);
      reservedAllocationQty = round(reservedAllocationQty + reserveQty);
      futureDemandReserveQty = round(futureDemandReserveQty + reserveQty);
      const sourceDate = pooled.pulledFromRequiredDate || pooled.requiredDate;
      if (sourceDate) coveredDates.add(new Date(sourceDate).toISOString().slice(0, 10));
      continue;
    }
    const future = rows.find((item) => String(item.id) === String(selection.sourceItemId));
    if (!future || allocationIdentity(future) !== allocationIdentity(current)
      || new Date(future.materialRequiredDate) <= new Date(current.materialRequiredDate)
      || ["Converted to PR", "Partially Converted to PR", "Cancelled"].includes(future.status)) {
      throw Object.assign(new Error("Kandidat alokasi MOQ tidak valid atau bukan kebutuhan berikutnya untuk material yang sama."), { status: 400 });
    }
    const sourceIndex = future.sourceRequirements.findIndex((source, index) => sourceRequirementKey(source, index) === String(selection.sourceRequirementId));
    if (sourceIndex < 0) throw Object.assign(new Error("Sumber kebutuhan yang dipilih sudah berubah. Muat ulang Purchase Suggestion."), { status: 409 });
    const source = future.sourceRequirements[sourceIndex];
    const availableQty = Math.min(number(source.qty), number(future.netRequirement));
    const demandCoveredQty = round(hasExplicitSplit ? Math.max(number(selection.demandCoveredQty), 0) : Math.min(Math.max(number(selection.qty), 0), availableQty));
    const reserveQty = round(hasExplicitSplit ? Math.max(number(selection.reservedAllocationQty), 0) : Math.max(number(selection.qty) - demandCoveredQty, 0));
    const qty = round(demandCoveredQty + reserveQty);
    if (demandCoveredQty > availableQty + 0.000001) throw Object.assign(new Error("Coverage Demand tidak boleh melebihi demand asli. Masukkan kelebihan qty ke Custom Reserve."), { status: 400 });
    if (qty <= 0) continue;
    const grossRatio = number(source.qty) > 0 ? demandCoveredQty / number(source.qty) : 0;
    const pulledSource = {
      ...source,
      qty,
      grossQty: round(number(source.grossQty || source.qty) * grossRatio),
      originalDemandQty: number(source.originalDemandQty || source.qty),
      allocationQty: qty,
      demandCoveredQty,
      reservedAllocationQty: reserveQty,
      allocationType: "MOQ_PULL_FORWARD",
      pulledFromRequiredDate: future.materialRequiredDate,
      coveredByRequiredDate: current.materialRequiredDate,
    };
    poolByRequirement.set(String(selection.sourceRequirementId), { ...pulledSource, qty: number(source.originalDemandQty || source.qty), originalDemandQty: number(source.originalDemandQty || source.qty), allocationQty: number(source.originalDemandQty || source.qty), allocationType: "MOQ_ALLOCATION_POOL" });
    const existingPulled = current.sourceRequirements.find((candidate, index) => sourceRequirementKey(candidate, index) === String(selection.sourceRequirementId) && candidate.allocationType === "MOQ_PULL_FORWARD");
    if (existingPulled) {
      existingPulled.qty = round(number(existingPulled.qty) + qty);
      existingPulled.grossQty = round(number(existingPulled.grossQty) + number(pulledSource.grossQty));
      existingPulled.allocationQty = existingPulled.qty;
    } else current.sourceRequirements.push(pulledSource);
    const retainedQty = round(number(source.qty) - demandCoveredQty);
    if (retainedQty > 0) {
      future.sourceRequirements[sourceIndex] = {
        ...source,
        qty: retainedQty,
        grossQty: round(number(source.grossQty || source.qty) * (retainedQty / number(source.qty))),
        originalDemandQty: number(source.originalDemandQty || source.qty),
        allocationQty: retainedQty,
        allocationType: source.allocationType || "DIRECT_DEMAND",
      };
    } else future.sourceRequirements.splice(sourceIndex, 1);
    future.netRequirement = round(Math.max(number(future.netRequirement) - demandCoveredQty, 0));
    future.grossRequirement = round(future.sourceRequirements.reduce((sum, candidate) => sum + number(candidate.grossQty || candidate.qty), 0));
    future.recommendedPurchaseQty = roundedPurchaseQty(future.netRequirement, future.moq, future.orderMultiple);
    future.excessQty = round(Math.max(future.recommendedPurchaseQty - future.netRequirement, 0));
    future.projectedStockAfterOrder = round(number(future.availableStock) + number(future.openPoQty) + future.recommendedPurchaseQty - future.netRequirement);
    if (future.netRequirement <= 0) {
      future.status = "Covered by MOQ";
      future.shortageQty = 0;
      future.confirmedQty = null;
    }
    pulledAllocationQty = round(pulledAllocationQty + qty);
    pulledDemandQty = round(pulledDemandQty + demandCoveredQty);
    reservedAllocationQty = round(reservedAllocationQty + reserveQty);
    futureDemandReserveQty = round(futureDemandReserveQty + reserveQty);
    coveredDates.add(new Date(future.materialRequiredDate).toISOString().slice(0, 10));
  }

  current.netRequirement = round(directDemandQty + pulledDemandQty);
  current.grossRequirement = round(current.sourceRequirements.reduce((sum, source) => sum + number(source.grossQty || source.qty), 0));
  current.excessQty = round(Math.max(number(confirmedPurchaseQty) - current.netRequirement, 0));
  current.projectedStockAfterOrder = round(number(current.availableStock) + number(current.openPoQty) + number(confirmedPurchaseQty) - current.netRequirement);
  const existingAllocation = current.productionLeadTimeBreakdown?.moqAllocation || {};
  current.productionLeadTimeBreakdown = {
    ...(current.productionLeadTimeBreakdown && typeof current.productionLeadTimeBreakdown === "object" ? current.productionLeadTimeBreakdown : {}),
    moqAllocation: {
      ...existingAllocation,
      directDemandQty,
      pulledFutureDemandQty: pulledDemandQty,
      reservedFutureAllocationQty: futureDemandReserveQty,
      reservedCurrentDemandQty: currentDemandReserveQty,
      reservedTotalAllocationQty: reservedAllocationQty,
      totalFutureAllocationQty: round(pulledDemandQty + futureDemandReserveQty),
      totalLinkedAllocationQty: pulledAllocationQty,
      residualBufferQty: round(Math.max(number(confirmedPurchaseQty) - directDemandQty - pulledAllocationQty, 0)),
      coveredRequiredDates: unique([...(existingAllocation.coveredRequiredDates || []), ...coveredDates]),
      allocationPool: [...poolByRequirement.values()],
      policy: "CURRENT_DEMAND_RESERVE_THEN_FIFO_FUTURE_DEMAND_SAME_MATERIAL_SUPPLIER_UOM",
    },
  };
  return { current, changed: rows.filter((item) => String(item.id) === String(current.id) || selections.some((selection) => String(selection.sourceItemId) === String(item.id))), pulledQty: pulledDemandQty, pulledAllocationQty, reservedAllocationQty, residualBufferQty: current.productionLeadTimeBreakdown.moqAllocation.residualBufferQty };
}

function allocatePurchaseQtyToSources(sources = [], purchaseQty = 0) {
  const sourceTotal = sources.reduce((sum, source) => sum + Math.max(number(source.allocationQty ?? source.qty), 0), 0);
  const sourceDemandTotal = sources.reduce((sum, source) => sum + Math.max(number(source.demandCoveredQty ?? source.qty), 0), 0);
  const allocatedSourceQty = round(Math.min(Math.max(number(purchaseQty), 0), sourceTotal));
  const demandCoveredQty = round(Math.min(Math.max(number(purchaseQty), 0), sourceDemandTotal));
  const moqBufferQty = round(Math.max(number(purchaseQty) - allocatedSourceQty, 0));
  return {
    sourceTotal,
    demandCoveredQty,
    moqBufferQty,
    allocations: sources.map((source) => ({
      ...source,
      allocatedPrQty: round(sourceTotal > 0 ? allocatedSourceQty * number(source.allocationQty ?? source.qty) / sourceTotal : 0),
    })),
  };
}

function applyMoqCarryForward(items = []) {
  const groups = new Map();
  for (const sourceItem of items) {
    const item = {
      ...sourceItem,
      sourceRequirements: (Array.isArray(sourceItem.sourceRequirements) ? sourceItem.sourceRequirements : []).map((source) => ({
        ...source,
        originalDemandQty: number(source.originalDemandQty || source.qty),
        allocationQty: number(source.qty),
        allocationType: source.allocationType || "DIRECT_DEMAND",
      })),
    };
    const key = allocationIdentity(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const result = [];
  for (const rows of groups.values()) {
    rows.sort((left, right) => new Date(left.materialRequiredDate) - new Date(right.materialRequiredDate)
      || new Date(left.customerDeliveryDate || left.materialRequiredDate) - new Date(right.customerDeliveryDate || right.materialRequiredDate));
    for (let index = 0; index < rows.length; index += 1) {
      const item = rows[index];
      const directNetRequirement = Math.max(number(item.netRequirement), 0);
      if (directNetRequirement <= 0) continue;
      const purchaseQty = roundedPurchaseQty(directNetRequirement, item.moq, item.orderMultiple);
      let pullCapacity = round(Math.max(purchaseQty - directNetRequirement, 0));
      let pulledDemandQty = 0;
      const coveredDates = new Set();

      for (let futureIndex = index + 1; futureIndex < rows.length && pullCapacity > 0; futureIndex += 1) {
        const future = rows[futureIndex];
        const futureNetRequirement = Math.max(number(future.netRequirement), 0);
        if (futureNetRequirement <= 0) continue;
        const requestedCoverage = Math.min(pullCapacity, futureNetRequirement);
        const split = splitSourcesForCoverage(future.sourceRequirements, requestedCoverage, {
          futureRequiredDate: future.materialRequiredDate,
          purchaseRequiredDate: item.materialRequiredDate,
        });
        const coveredQty = split.coveredQty;
        if (coveredQty <= 0) continue;
        future.sourceRequirements = split.retained;
        future.netRequirement = round(futureNetRequirement - coveredQty);
        future.grossRequirement = round(split.retained.reduce((sum, source) => sum + number(source.grossQty || source.qty), 0));
        item.sourceRequirements.push(...split.pulled);
        item.customerCodes = unique([...(item.customerCodes || []), ...(future.customerCodes || [])]);
        item.salesOrderNumbers = unique([...(item.salesOrderNumbers || []), ...(future.salesOrderNumbers || [])]);
        item.forecastNumbers = unique([...(item.forecastNumbers || []), ...(future.forecastNumbers || [])]);
        item.productionOrderNumbers = unique([...(item.productionOrderNumbers || []), ...(future.productionOrderNumbers || [])]);
        pulledDemandQty = round(pulledDemandQty + coveredQty);
        pullCapacity = round(pullCapacity - coveredQty);
        if (coveredQty > 0 && future.materialRequiredDate) coveredDates.add(new Date(future.materialRequiredDate).toISOString().slice(0, 10));
      }

      item.netRequirement = round(directNetRequirement + pulledDemandQty);
      item.grossRequirement = round(item.sourceRequirements.reduce((sum, source) => sum + number(source.grossQty || source.qty), 0) || item.grossRequirement);
      item.recommendedPurchaseQty = purchaseQty;
      item.excessQty = round(Math.max(purchaseQty - item.netRequirement, 0));
      item.projectedStockAfterOrder = round(number(item.availableStock) + number(item.openPoQty) + purchaseQty - item.netRequirement);
      item.productionLeadTimeBreakdown = {
        ...(item.productionLeadTimeBreakdown && typeof item.productionLeadTimeBreakdown === "object" ? item.productionLeadTimeBreakdown : {}),
        moqAllocation: {
          directDemandQty: round(directNetRequirement),
          pulledFutureDemandQty: pulledDemandQty,
          residualBufferQty: item.excessQty,
          coveredRequiredDates: [...coveredDates],
          policy: "FIFO_FUTURE_DEMAND_SAME_MATERIAL_SUPPLIER_UOM",
        },
      };
      result.push(item);
    }
  }
  return result.sort((left, right) => new Date(left.materialRequiredDate) - new Date(right.materialRequiredDate));
}

module.exports = { allocatePurchaseQtyToSources, allocationIdentity, applyConfirmedMoqPullForward, applyMoqCarryForward, buildMoqAllocationCandidates, roundedPurchaseQty, sourceRequirementKey, splitSourcesForCoverage };
