const { calculateLiveMbomCosts } = require("./mbomLiveCostingService");
const {
  legacyPriceValue,
  resolveEffectiveRecord,
} = require("./pricing/effectivePriceService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const text = (value) => String(value || "").trim();

function normalizeSourceType(value) {
  const normalized = text(value).toUpperCase().replace(/[ -]+/g, "_");
  if (["SO", "SALES_ORDER", "SALESORDER"].includes(normalized)) return "SALES_ORDER";
  if (["FCT", "FORECAST"].includes(normalized)) return "FORECAST";
  return normalized || "UNALLOCATED";
}

function groupKey(sourceType, sourceNumber, partCode) {
  return [normalizeSourceType(sourceType), text(sourceNumber) || "UNALLOCATED", text(partCode) || "UNALLOCATED"].join("|");
}

function machineRatePerSecond(rate, rateType) {
  const value = number(rate);
  switch (text(rateType).toUpperCase() || "PER_HOUR") {
    case "PER_SECOND": return value;
    case "PER_MINUTE": return value / 60;
    case "PER_CYCLE": return value;
    default: return value / 3600;
  }
}

function durationSeconds(log) {
  if (number(log?.runningMinutes) > 0) return number(log.runningMinutes) * 60;
  if (!log?.startTime || !log?.endTime) return 0;
  const start = new Date(log.startTime).getTime();
  const end = new Date(log.endTime).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : 0;
}

function reportRange(options = {}) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text(options.month))) {
    const [year, month] = text(options.month).split("-").map(Number);
    return {
      start: new Date(year, month - 1, 1, 0, 0, 0, 0),
      end: new Date(year, month, 0, 23, 59, 59, 999),
      month: text(options.month),
    };
  }
  const now = new Date();
  const start = options.startDate ? new Date(`${text(options.startDate).slice(0, 10)}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = options.endDate ? new Date(`${text(options.endDate).slice(0, 10)}T23:59:59.999`) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end, month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}` };
}

function addEntityWeight(target, entityId, key, sequence, qty) {
  if (!entityId || !key) return;
  const entity = target.get(entityId) || new Map();
  const group = entity.get(key) || new Map();
  const seq = number(sequence);
  group.set(seq, number(group.get(seq)) + number(qty));
  entity.set(key, group);
  target.set(entityId, entity);
}

function normalizedWeights(entityMap) {
  if (!entityMap?.size) return [];
  const rows = [...entityMap.entries()].map(([key, bySequence]) => ({
    key,
    qty: Math.max(0, ...bySequence.values()),
  }));
  const total = rows.reduce((sum, row) => sum + row.qty, 0);
  if (total <= 0) return rows.map((row) => ({ key: row.key, factor: 1 / rows.length }));
  return rows.map((row) => ({ key: row.key, factor: row.qty / total }));
}

function priceIdentityMatches(detail, receipt) {
  if (detail.productId && receipt.poDetail?.productId === detail.productId) return true;
  const detailCode = text(detail.partCode || detail.partNumber);
  const receiptCode = text(receipt.poDetail?.partCode || receipt.poDetail?.partNumber);
  return Boolean(detailCode && detailCode === receiptCode);
}

function isEffective(row, date) {
  const at = new Date(date).getTime();
  const from = row?.effectiveFrom ? new Date(row.effectiveFrom).getTime() : -Infinity;
  const until = row?.effectiveUntil ? new Date(row.effectiveUntil).getTime() : Infinity;
  return from <= at && at <= until;
}

async function buildProductionCostReport(prisma, options = {}) {
  const { start, end, month } = reportRange(options);
  const requestedSourceType = normalizeSourceType(options.sourceType);
  const sourceFilter = requestedSourceType === "UNALLOCATED" || text(options.sourceType).toUpperCase() === "ALL"
    ? null
    : requestedSourceType;

  const [schedules, logs, issues, vendorOrders, currencies] = await Promise.all([
    prisma.dailyProductionSchedule.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, scheduleDate: { gte: start, lte: end } },
      select: {
        id: true, scheduleNumber: true, scheduleDate: true, status: true, sequence: true,
        moId: true, woId: true, partCode: true, plannedQty: true, actualQty: true,
        productionPlanId: true, demandSourceType: true, demandSourceNumber: true,
        customerCode: true, mpsNumber: true,
        productionPlanAllocation: { select: { lineNumber: true } },
      },
    }),
    prisma.productionLog.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, logDate: { gte: start, lte: end } },
      select: {
        id: true, logNumber: true, logDate: true, dpsId: true, moId: true, woId: true,
        machineCode: true, runningMinutes: true, startTime: true, endTime: true,
        qtyProduced: true, qtyGood: true, qtyReject: true,
        workOrder: { select: {
          woNumber: true, machineCostingRate: true, machineRateType: true, machineCurrency: true,
          machine: { select: { machineCode: true, machineName: true } },
        } },
        dailyProductionSchedule: { select: {
          id: true, sequence: true, moId: true, woId: true, partCode: true, plannedQty: true,
          productionPlanId: true, demandSourceType: true, demandSourceNumber: true,
          customerCode: true, mpsNumber: true,
          productionPlanAllocation: { select: { lineNumber: true } },
        } },
      },
    }),
    prisma.materialIssue.findMany({
      where: { isDeleted: false, status: { in: ["Issued", "Partially Returned", "Closed"] }, issueDate: { gte: start, lte: end } },
      select: {
        id: true, issueNumber: true, issueDate: true, moId: true, woId: true,
        details: { where: { isDeleted: false }, select: {
          id: true, partCode: true, partNumber: true, partName: true, productId: true,
          qtyIssued: true, qtyReturned: true, uomCode: true, lotNumber: true,
          stockBalanceId: true, requirementSource: true,
        } },
      },
    }),
    prisma.vendorProcessOrder.findMany({
      where: {
        isDeleted: false, status: { not: "Cancelled" },
        OR: [{ receivedAt: { gte: start, lte: end } }, { closedAt: { gte: start, lte: end } }],
      },
      select: { id: true, orderNumber: true, moId: true, processCode: true, processName: true, vendorCode: true, vendorName: true, qtyReceived: true, vendorRate: true, actualVendorCost: true },
    }),
    prisma.currency.findMany({ where: { isDeleted: false }, select: { currencyCode: true, exchangeRate: true } }),
  ]);

  const allScheduleRows = [...schedules];
  const knownScheduleIds = new Set(schedules.map((row) => row.id));
  for (const log of logs) {
    const schedule = log.dailyProductionSchedule;
    if (schedule?.id && !knownScheduleIds.has(schedule.id)) {
      knownScheduleIds.add(schedule.id);
      allScheduleRows.push(schedule);
    }
  }

  const planIds = [...new Set(allScheduleRows.map((row) => row.productionPlanId).filter(Boolean))];
  const plans = planIds.length ? await prisma.monthlyProductionPlan.findMany({
    where: { id: { in: planIds }, isDeleted: false },
    select: { id: true, planNumber: true, details: { where: { isDeleted: false }, select: { lineNumber: true, partId: true, partCode: true } } },
  }) : [];
  const planLine = new Map();
  for (const plan of plans) for (const detail of plan.details) planLine.set(`${plan.id}|${detail.lineNumber}`, { ...detail, planNumber: plan.planNumber });

  function scheduleIdentity(schedule) {
    const line = planLine.get(`${schedule.productionPlanId}|${schedule.productionPlanAllocation?.lineNumber}`);
    return {
      sourceType: normalizeSourceType(schedule.demandSourceType),
      sourceNumber: text(schedule.demandSourceNumber) || "UNALLOCATED",
      partCode: text(line?.partCode || schedule.partCode) || "UNALLOCATED",
      partId: line?.partId || null,
      customerCode: text(schedule.customerCode) || "-",
      planNumber: line?.planNumber || "-",
      mpsNumber: text(schedule.mpsNumber) || "-",
    };
  }

  const scheduleKeys = new Map();
  const groupMeta = new Map();
  const weightsByWo = new Map();
  const weightsByMo = new Map();
  const maxSequenceByGroup = new Map();
  for (const schedule of allScheduleRows) {
    const identity = scheduleIdentity(schedule);
    const key = groupKey(identity.sourceType, identity.sourceNumber, identity.partCode);
    scheduleKeys.set(schedule.id, key);
    if (!groupMeta.has(key)) groupMeta.set(key, identity);
    addEntityWeight(weightsByWo, schedule.woId, key, schedule.sequence, schedule.plannedQty);
    addEntityWeight(weightsByMo, schedule.moId, key, schedule.sequence, schedule.plannedQty);
    maxSequenceByGroup.set(key, Math.max(number(maxSequenceByGroup.get(key)), number(schedule.sequence)));
  }

  const sourceNumbers = [...new Set([...groupMeta.values()].map((row) => row.sourceNumber).filter((value) => value !== "UNALLOCATED"))];
  const mpsNumbers = [...new Set(allScheduleRows.map((row) => text(row.mpsNumber)).filter(Boolean))];
  const demandSources = sourceNumbers.length ? await prisma.mPSDemandSource.findMany({
    where: {
      sourceNumber: { in: sourceNumbers }, periodMonth: { gte: start, lte: end },
      ...(mpsNumbers.length ? { mpsDetail: { mpsNumber: { in: mpsNumbers }, isDeleted: false } } : {}),
    },
    select: {
      id: true, sourceType: true, sourceNumber: true, customerCode: true, qty: true,
      mpsDetail: { select: { partId: true, partCode: true, mbomHeaderId: true, mpsNumber: true } },
    },
  }) : [];

  for (const source of demandSources) {
    const identity = {
      sourceType: normalizeSourceType(source.sourceType), sourceNumber: source.sourceNumber,
      partCode: source.mpsDetail.partCode, partId: source.mpsDetail.partId,
      customerCode: source.customerCode || "-", planNumber: "-", mpsNumber: source.mpsDetail.mpsNumber,
    };
    const key = groupKey(identity.sourceType, identity.sourceNumber, identity.partCode);
    if (!groupMeta.has(key)) groupMeta.set(key, identity);
  }

  const partCodes = [...new Set([
    ...[...groupMeta.values()].map((row) => row.partCode),
    ...issues.flatMap((issue) => issue.details.map((detail) => detail.partCode)),
  ].filter((value) => value && value !== "UNALLOCATED"))];
  const parts = partCodes.length ? await prisma.part.findMany({
    where: { isDeleted: false, partCode: { in: partCodes } },
    select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, materialId: true },
  }) : [];
  const partByCode = new Map(parts.map((row) => [row.partCode, row]));
  for (const meta of groupMeta.values()) {
    const part = partByCode.get(meta.partCode);
    if (part) meta.partId = meta.partId || part.id;
    meta.partNumber = part?.partNumber || "-";
    meta.partName = part?.partName || meta.partCode;
  }

  const partIds = [...new Set([...groupMeta.values()].map((row) => row.partId).filter(Boolean))];
  const [liveCosts, mbomHeaders] = await Promise.all([
    partIds.length ? calculateLiveMbomCosts(prisma, { costingDate: end }) : Promise.resolve(new Map()),
    partIds.length ? prisma.mBOMHeader.findMany({
      where: { isDeleted: false, partId: { in: partIds } },
      select: { id: true, partId: true, revision: true, effectiveDate: true, updatedAt: true },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    }) : [],
  ]);
  const headerByPart = new Map();
  for (const header of mbomHeaders) if (!headerByPart.has(header.partId)) headerByPart.set(header.partId, header);

  const rows = new Map();
  function ensureRow(key) {
    if (rows.has(key)) return rows.get(key);
    const meta = groupMeta.get(key) || {};
    const row = {
      key, sourceType: meta.sourceType || "UNALLOCATED", sourceNumber: meta.sourceNumber || "UNALLOCATED",
      customerCode: meta.customerCode || "-", partCode: meta.partCode || "UNALLOCATED",
      partNumber: meta.partNumber || "-", partName: meta.partName || meta.partCode || "-",
      mpsNumber: meta.mpsNumber || "-", planNumber: meta.planNumber || "-", currencyCode: "IDR",
      plannedQty: 0, actualGoodQty: 0, runtimeSeconds: 0,
      plannedMaterialCost: 0, plannedPurchasePartCost: 0, plannedMachineCost: 0, plannedVendorCost: 0,
      actualMaterialCost: 0, actualPurchasePartCost: 0, actualMachineCost: 0, actualVendorCost: 0,
      materialLines: 0, pricedMaterialLines: 0, machineDetails: new Map(), materialDetails: new Map(), vendorDetails: new Map(),
      costingStatus: "NOT COSTED",
    };
    rows.set(key, row);
    return row;
  }
  for (const key of groupMeta.keys()) ensureRow(key);

  const demandQtyByKey = new Map();
  const demandMbomByKey = new Map();
  for (const source of demandSources) {
    const key = groupKey(source.sourceType, source.sourceNumber, source.mpsDetail.partCode);
    demandQtyByKey.set(key, number(demandQtyByKey.get(key)) + number(source.qty));
    if (source.mpsDetail.mbomHeaderId) demandMbomByKey.set(key, source.mpsDetail.mbomHeaderId);
  }
  for (const [key, row] of rows) {
    let plannedQty = number(demandQtyByKey.get(key));
    if (plannedQty <= 0) {
      const finalSequence = number(maxSequenceByGroup.get(key));
      plannedQty = allScheduleRows
        .filter((schedule) => scheduleKeys.get(schedule.id) === key && number(schedule.sequence) === finalSequence)
        .reduce((sum, schedule) => sum + number(schedule.plannedQty), 0);
    }
    row.plannedQty = plannedQty;
    const mbomId = demandMbomByKey.get(key) || headerByPart.get(groupMeta.get(key)?.partId)?.id;
    const cost = liveCosts.get(mbomId);
    if (cost) {
      row.plannedMaterialCost = number(cost.rawMaterialCost) * plannedQty;
      row.plannedPurchasePartCost = number(cost.purchasePartCost) * plannedQty;
      row.plannedVendorCost = number(cost.vendorCost) * plannedQty;
      row.plannedMachineCost = Math.max(0, number(cost.processCost) - number(cost.vendorCost)) * plannedQty;
      row.costingStatus = cost.status || "COSTED";
    }
  }

  const exchangeRates = new Map(currencies.map((row) => [row.currencyCode, number(row.exchangeRate) || 1]));
  const toIdr = (value, currencyCode) => number(value) * (!currencyCode || currencyCode === "IDR" ? 1 : number(exchangeRates.get(currencyCode)) || 1);

  for (const log of logs) {
    let allocations = [];
    const exactKey = log.dpsId ? scheduleKeys.get(log.dpsId) : null;
    if (exactKey) allocations = [{ key: exactKey, factor: 1 }];
    else allocations = normalizedWeights(weightsByWo.get(log.woId) || weightsByMo.get(log.moId));
    if (!allocations.length) continue;
    const seconds = durationSeconds(log);
    const cost = seconds * toIdr(machineRatePerSecond(log.workOrder?.machineCostingRate, log.workOrder?.machineRateType), log.workOrder?.machineCurrency);
    for (const allocation of allocations) {
      const row = ensureRow(allocation.key);
      row.runtimeSeconds += seconds * allocation.factor;
      row.actualMachineCost += cost * allocation.factor;
      const finalSequence = number(maxSequenceByGroup.get(allocation.key));
      if (!log.dailyProductionSchedule || number(log.dailyProductionSchedule.sequence) === finalSequence) row.actualGoodQty += number(log.qtyGood) * allocation.factor;
      const machineCode = log.machineCode || log.workOrder?.machine?.machineCode || "UNASSIGNED";
      const detail = row.machineDetails.get(machineCode) || { machineCode, machineName: log.workOrder?.machine?.machineName || "-", runtimeSeconds: 0, amount: 0, logCount: 0 };
      detail.runtimeSeconds += seconds * allocation.factor;
      detail.amount += cost * allocation.factor;
      detail.logCount += 1;
      row.machineDetails.set(machineCode, detail);
    }
  }

  const issueDetails = issues.flatMap((issue) => issue.details.map((detail) => ({ ...detail, issue })));
  const issuePartCodes = [...new Set(issueDetails.map((row) => row.partCode).filter(Boolean))];
  const issueProductIds = [...new Set(issueDetails.map((row) => row.productId).filter(Boolean))];
  const lotNumbers = [...new Set(issueDetails.map((row) => row.lotNumber).filter(Boolean))];
  const receiptWhere = [];
  if (issuePartCodes.length) receiptWhere.push({ poDetail: { partCode: { in: issuePartCodes } } });
  if (issueProductIds.length) receiptWhere.push({ poDetail: { productId: { in: issueProductIds } } });
  if (lotNumbers.length) receiptWhere.push({ lotNumber: { in: lotNumbers } });
  const receipts = receiptWhere.length ? await prisma.goodsReceiptDetail.findMany({
    where: { isDeleted: false, gr: { isDeleted: false, status: { not: "Cancelled" } }, OR: receiptWhere },
    select: {
      lotNumber: true, unitPrice: true,
      gr: { select: { grDate: true, po: { select: { currencyCode: true } } } },
      poDetail: { select: { partCode: true, partNumber: true, productId: true } },
      purchaseInvoiceDetails: { select: {
        unitPrice: true,
        invoice: { select: { invoiceDate: true, currencyCode: true, status: true } },
      } },
    },
  }) : [];

  const issueParts = new Map(parts.map((row) => [row.partCode, row]));
  const issuePartIds = [...new Set(issueDetails.map((row) => issueParts.get(row.partCode)?.id).filter(Boolean))];
  const issueMaterialIds = [...new Set(issueDetails.map((row) => issueParts.get(row.partCode)?.materialId).filter(Boolean))];
  const [partPrices, materialPrices] = await Promise.all([
    issuePartIds.length ? prisma.partPriceList.findMany({ where: { isDeleted: false, isActive: true, partId: { in: issuePartIds } } }) : [],
    issueMaterialIds.length ? prisma.materialPriceList.findMany({ where: { isDeleted: false, isActive: true, materialId: { in: issueMaterialIds } } }) : [],
  ]);

  function issueUnitCost(detail) {
    const datedReceipts = receipts
      .filter((receipt) => priceIdentityMatches(detail, receipt) && new Date(receipt.gr.grDate) <= new Date(detail.issue.issueDate))
      .sort((left, right) => {
        const exactLeft = detail.lotNumber && left.lotNumber === detail.lotNumber ? 1 : 0;
        const exactRight = detail.lotNumber && right.lotNumber === detail.lotNumber ? 1 : 0;
        return exactRight - exactLeft || new Date(right.gr.grDate) - new Date(left.gr.grDate);
      });
    const receipt = datedReceipts[0];
    const invoiceDetail = receipt?.purchaseInvoiceDetails
      ?.filter((row) => row.invoice.status !== "Cancelled" && new Date(row.invoice.invoiceDate) <= end)
      .sort((left, right) => new Date(right.invoice.invoiceDate) - new Date(left.invoice.invoiceDate))[0];
    if (number(invoiceDetail?.unitPrice) > 0) return { rate: toIdr(invoiceDetail.unitPrice, invoiceDetail.invoice.currencyCode), source: "PURCHASE_INVOICE" };
    if (number(receipt?.unitPrice) > 0) return { rate: toIdr(receipt.unitPrice, receipt.gr.po.currencyCode), source: "GOODS_RECEIPT" };

    const part = issueParts.get(detail.partCode);
    const partPrice = resolveEffectiveRecord(partPrices.filter((row) => row.partId === part?.id && isEffective(row, detail.issue.issueDate)), detail.issue.issueDate);
    const partValue = legacyPriceValue(partPrice, detail.issue.issueDate);
    if (partValue > 0) return { rate: toIdr(partValue, partPrice.currencyCode), source: "PART_PRICE_FALLBACK" };
    const materialPrice = resolveEffectiveRecord(materialPrices.filter((row) => row.materialId === part?.materialId && isEffective(row, detail.issue.issueDate)), detail.issue.issueDate);
    const materialValue = legacyPriceValue(materialPrice, detail.issue.issueDate);
    if (materialValue > 0) return { rate: toIdr(materialValue, materialPrice.currencyCode), source: "MATERIAL_PRICE_FALLBACK" };
    return { rate: 0, source: "PRICE_MISSING" };
  }

  for (const detail of issueDetails) {
    const qty = Math.max(0, number(detail.qtyIssued) - number(detail.qtyReturned));
    if (qty <= 0) continue;
    const allocations = normalizedWeights(weightsByWo.get(detail.issue.woId) || weightsByMo.get(detail.issue.moId));
    if (!allocations.length) continue;
    const valuation = issueUnitCost(detail);
    const amount = qty * valuation.rate;
    const part = issueParts.get(detail.partCode);
    const rawMaterial = /MATERIAL|RAW/.test(text(part?.itemType || part?.rawType).toUpperCase()) || Boolean(part?.materialId);
    for (const allocation of allocations) {
      const row = ensureRow(allocation.key);
      if (rawMaterial) row.actualMaterialCost += amount * allocation.factor;
      else row.actualPurchasePartCost += amount * allocation.factor;
      row.materialLines += 1;
      if (valuation.rate > 0) row.pricedMaterialLines += 1;
      const itemKey = `${rawMaterial ? "MATERIAL" : "PURCHASE_PART"}|${detail.partCode || detail.partNumber || detail.productId}`;
      const item = row.materialDetails.get(itemKey) || {
        type: rawMaterial ? "MATERIAL" : "PURCHASE_PART", itemCode: detail.partCode || detail.partNumber || "-",
        itemName: detail.partName || part?.partName || "-", uomCode: detail.uomCode || "-", qty: 0, amount: 0,
        rate: valuation.rate, priceSource: valuation.source,
      };
      item.qty += qty * allocation.factor;
      item.amount += amount * allocation.factor;
      row.materialDetails.set(itemKey, item);
    }
  }

  for (const order of vendorOrders) {
    const allocations = normalizedWeights(weightsByMo.get(order.moId));
    for (const allocation of allocations) {
      const row = ensureRow(allocation.key);
      const totalVendorCost = number(order.actualVendorCost) || number(order.vendorRate) * number(order.qtyReceived);
      const amount = totalVendorCost * allocation.factor;
      row.actualVendorCost += amount;
      const key = order.orderNumber;
      row.vendorDetails.set(key, {
        orderNumber: order.orderNumber, processCode: order.processCode || "-", processName: order.processName || "-",
        vendorCode: order.vendorCode || "-", vendorName: order.vendorName || "-", qtyReceived: number(order.qtyReceived) * allocation.factor, amount,
      });
    }
  }

  const result = [...rows.values()].map((row) => {
    const plannedTotalCost = row.plannedMaterialCost + row.plannedPurchasePartCost + row.plannedMachineCost + row.plannedVendorCost;
    const actualTotalCost = row.actualMaterialCost + row.actualPurchasePartCost + row.actualMachineCost + row.actualVendorCost;
    const varianceCost = actualTotalCost - plannedTotalCost;
    return {
      ...row,
      runtimeSeconds: round(row.runtimeSeconds), actualGoodQty: round(row.actualGoodQty), plannedQty: round(row.plannedQty),
      plannedMaterialCost: round(row.plannedMaterialCost), plannedPurchasePartCost: round(row.plannedPurchasePartCost), plannedMachineCost: round(row.plannedMachineCost), plannedVendorCost: round(row.plannedVendorCost),
      actualMaterialCost: round(row.actualMaterialCost), actualPurchasePartCost: round(row.actualPurchasePartCost), actualMachineCost: round(row.actualMachineCost), actualVendorCost: round(row.actualVendorCost),
      plannedTotalCost: round(plannedTotalCost), actualTotalCost: round(actualTotalCost), varianceCost: round(varianceCost),
      variancePercent: plannedTotalCost > 0 ? round((varianceCost / plannedTotalCost) * 100) : 0,
      actualCostPerGoodUnit: row.actualGoodQty > 0 ? round(actualTotalCost / row.actualGoodQty) : 0,
      materialPriceCoveragePercent: row.materialLines > 0 ? round((row.pricedMaterialLines / row.materialLines) * 100, 1) : 100,
      machineDetails: [...row.machineDetails.values()].map((item) => ({ ...item, runtimeSeconds: round(item.runtimeSeconds), amount: round(item.amount) })),
      materialDetails: [...row.materialDetails.values()].map((item) => ({ ...item, qty: round(item.qty, 4), rate: round(item.rate), amount: round(item.amount) })),
      vendorDetails: [...row.vendorDetails.values()].map((item) => ({ ...item, qtyReceived: round(item.qtyReceived, 4), amount: round(item.amount) })),
    };
  }).filter((row) => !sourceFilter || row.sourceType === sourceFilter);

  const q = text(options.q || options.search).toLowerCase();
  const filtered = q ? result.filter((row) => [row.sourceNumber, row.customerCode, row.partCode, row.partNumber, row.partName].some((value) => text(value).toLowerCase().includes(q))) : result;
  filtered.sort((left, right) => left.sourceType.localeCompare(right.sourceType) || left.sourceNumber.localeCompare(right.sourceNumber) || left.partCode.localeCompare(right.partCode));

  const summary = filtered.reduce((acc, row) => {
    acc.plannedCost += row.plannedTotalCost;
    acc.actualCost += row.actualTotalCost;
    acc.machineCost += row.actualMachineCost;
    acc.materialCost += row.actualMaterialCost;
    acc.purchasePartCost += row.actualPurchasePartCost;
    acc.vendorCost += row.actualVendorCost;
    acc.runtimeSeconds += row.runtimeSeconds;
    acc.actualGoodQty += row.actualGoodQty;
    acc.materialLines += row.materialLines;
    acc.pricedMaterialLines += row.pricedMaterialLines;
    return acc;
  }, { plannedCost: 0, actualCost: 0, machineCost: 0, materialCost: 0, purchasePartCost: 0, vendorCost: 0, runtimeSeconds: 0, actualGoodQty: 0, materialLines: 0, pricedMaterialLines: 0 });
  summary.varianceCost = summary.actualCost - summary.plannedCost;
  summary.variancePercent = summary.plannedCost > 0 ? (summary.varianceCost / summary.plannedCost) * 100 : 0;
  summary.materialPriceCoveragePercent = summary.materialLines > 0 ? (summary.pricedMaterialLines / summary.materialLines) * 100 : 100;
  Object.keys(summary).forEach((key) => { summary[key] = round(summary[key], key.includes("Percent") ? 1 : 2); });

  const page = Math.max(1, number(options.page) || 1);
  const limit = Math.min(500, Math.max(1, number(options.limit) || 100));
  const offset = (page - 1) * limit;
  return {
    period: { month, startDate: start, endDate: end }, currencyCode: "IDR",
    data: filtered.slice(offset, offset + limit), total: filtered.length, summary,
    filterOptions: { sourceTypes: ["SALES_ORDER", "FORECAST"] },
    methodology: {
      planned: "Qty demand x live exploded mBOM cost pada akhir periode.",
      machine: "Runtime aktual production log (detik) x snapshot machine cost rate pada Work Order.",
      purchased: "Qty net Material Issue x harga Purchase Invoice/GR; price list hanya fallback dan ditandai pada detail.",
    },
  };
}

module.exports = {
  buildProductionCostReport,
  durationSeconds,
  machineRatePerSecond,
  normalizeSourceType,
  reportRange,
};
