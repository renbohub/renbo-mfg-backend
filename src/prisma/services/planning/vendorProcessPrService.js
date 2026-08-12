const { generateDocNumber } = require("../../controllers/purchasing/utils/purchasingHelpers");

const EPSILON = 0.000001;
const MONTH_PRICE_FIELDS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const optionalNumber = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const dayKey = (value) => {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};
const processMatches = (vendorProcess, process) => {
  const values = [vendorProcess?.vendorProcessCode, vendorProcess?.vendorProcessName]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const targets = [process?.processCode, process?.processName]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  return targets.some((target) => values.includes(target));
};

function capacityVendorPrMarker(planNumber, vendorCode) {
  return `[CAPACITY-VENDOR-PR:${planNumber}:${vendorCode}]`;
}

function capacityAllocationMarker(allocationId) {
  return `[CAPACITY-ALLOCATION:${allocationId}]`;
}

function groupVendorAllocations(allocations = []) {
  const groups = new Map();
  for (const allocation of allocations) {
    if (String(allocation.routingMode || "").toUpperCase() !== "VENDOR" || !allocation.vendor?.vendorCode) continue;
    if (number(allocation.plannedQty) <= EPSILON) continue;
    const key = allocation.vendor.vendorCode;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(allocation);
  }
  for (const rows of groups.values()) rows.sort((left, right) =>
    String(left.vendorSendDate || left.scheduleDate).localeCompare(String(right.vendorSendDate || right.scheduleDate))
    || number(left.lineNumber) - number(right.lineNumber)
    || String(left.mbomProcess?.sequence || "").localeCompare(String(right.mbomProcess?.sequence || ""))
    || String(left.id).localeCompare(String(right.id)));
  return groups;
}

function effectiveVendorRate(priceList, process, date) {
  if (!priceList) return null;
  const matchingDetail = (priceList.details || []).find((row) => processMatches(row.vendorProcess, process))
    || (priceList.details || [])[0]
    || null;
  if (!matchingDetail) return null;
  const monthRate = optionalNumber(matchingDetail[MONTH_PRICE_FIELDS[(date || new Date()).getUTCMonth()]]);
  const unitPrice = monthRate != null && monthRate > 0 ? monthRate : optionalNumber(matchingDetail.unitPrice);
  if (unitPrice == null || unitPrice < 0) return null;
  return {
    unitPrice,
    currencyCode: priceList.currencyCode || "IDR",
    priceListId: priceList.id,
    vendorProcessId: matchingDetail.vendorProcessId,
    priceSource: monthRate > 0 ? `MONTH_${MONTH_PRICE_FIELDS[(date || new Date()).getUTCMonth()].toUpperCase()}` : "UNIT_PRICE",
  };
}

async function resolveVendorPrices(client, allocations) {
  const prices = new Map();
  const vendorIds = [...new Set(allocations.map((row) => row.vendorId).filter(Boolean))];
  const partIds = [...new Set(allocations.map((row) => row.planDetail?.partId || row.mbomProcess?.mbomDetail?.partId).filter(Boolean))];
  if (!vendorIds.length) return prices;
  const lists = await client.vendorPriceList.findMany({
    where: {
      vendorId: { in: vendorIds }, isDeleted: false, isActive: true,
      ...(partIds.length ? { OR: [{ partId: { in: partIds } }, { partId: null }] } : {}),
    },
    include: { details: { where: { isDeleted: false }, include: { vendorProcess: true } } },
    orderBy: [{ effectiveFrom: "desc" }, { pricingYear: "desc" }, { updatedAt: "desc" }],
  });
  for (const allocation of allocations) {
    const priceDate = allocation.vendorSendDate || allocation.scheduleDate || new Date();
    const partId = allocation.planDetail?.partId || allocation.mbomProcess?.mbomDetail?.partId || null;
    const eligible = lists.filter((row) => row.vendorId === allocation.vendorId
      && (!row.partId || !partId || row.partId === partId)
      && (!row.effectiveFrom || row.effectiveFrom <= priceDate)
      && (!row.effectiveUntil || row.effectiveUntil >= priceDate));
    const exact = eligible.find((row) => row.partId && row.partId === partId && (row.details || []).some((detail) => processMatches(detail.vendorProcess, allocation.mbomProcess?.process)));
    const matched = exact
      || eligible.find((row) => (row.details || []).some((detail) => processMatches(detail.vendorProcess, allocation.mbomProcess?.process)))
      || eligible.find((row) => row.partId === partId)
      || eligible[0];
    prices.set(allocation.id, effectiveVendorRate(matched, allocation.mbomProcess?.process, priceDate));
  }
  return prices;
}

function buildDetailData({ allocation, plan, planDetail, mpsNumber, mrpRunNumber, demandSources, price }) {
  const process = allocation.mbomProcess?.process || {};
  const part = allocation.mbomProcess?.mbomDetail?.part || {};
  const vendor = allocation.vendor || {};
  const sentQty = number(allocation.plannedQty);
  const returnedQty = number(allocation.expectedReturnQty ?? allocation.plannedQty);
  const uomCode = allocation.uomCode || planDetail?.uomCode || "PCS";
  const sendDate = allocation.vendorSendDate || allocation.scheduleDate;
  const returnDate = allocation.vendorReturnDate || sendDate;
  const source = (demandSources || [])[0] || null;
  const allocationMarker = capacityAllocationMarker(allocation.id);
  const description = [process.processCode, process.processName].filter(Boolean).join(" - ") || "Vendor Process";
  const traceNote = `${allocationMarker} ${description}; kirim ${dayKey(sendDate)}; kembali ${dayKey(returnDate)}; qty kembali ${returnedQty} ${uomCode}`;
  const metadata = {
    allocationId: allocation.id,
    planNumber: plan.planNumber,
    planLineNumber: allocation.lineNumber,
    mbomProcessId: allocation.mbomProcessId,
    processCode: process.processCode || null,
    processName: process.processName || null,
    vendorCode: vendor.vendorCode,
    vendorName: vendor.vendorName || null,
    vendorSendDate: sendDate,
    vendorReturnDate: returnDate,
    vendorLeadTimeDays: allocation.vendorLeadTimeDays,
    expectedReturnQty: returnedQty,
    deliveryPhaseId: allocation.deliveryPhaseId,
    deliveryPhaseNumber: allocation.deliveryPhaseNumber,
    customerCode: allocation.customerCode || planDetail?.customerCode || null,
    customerTargetDate: allocation.customerTargetDate || planDetail?.customerTargetDate || null,
    priceListId: price?.priceListId || null,
    vendorProcessId: price?.vendorProcessId || null,
    priceSource: price?.priceSource || "PRICE_NOT_FOUND",
  };
  return {
    lineNumber: 0,
    procurementCategory: "VENDOR_PROCESS",
    partCode: planDetail?.partCode || part.partCode || null,
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    description,
    qty: sentQty,
    orderedQty: 0,
    uomCode,
    estimatedPrice: number(price?.unitPrice),
    totalAmount: sentQty * number(price?.unitPrice),
    preferredVendor: vendor.vendorCode,
    plannedOrderNumber: planDetail?.plannedOrderNumber || null,
    sourcePlannedOrderNumbers: planDetail?.plannedOrderNumber ? [planDetail.plannedOrderNumber] : null,
    notes: traceNote,
    sources: {
      create: [{
        plannedOrderNumber: planDetail?.plannedOrderNumber || null,
        mrpRunNumber: mrpRunNumber || null,
        mpsNumber: mpsNumber || null,
        mpsDetailId: planDetail?.mpsDetailId || null,
        forecastNumber: source?.sourceType === "FORECAST" ? source.sourceNumber : null,
        soNumber: source?.sourceType === "SALES_ORDER" ? source.sourceNumber : null,
        sourceType: "CAPACITY_ALLOCATION",
        sourceNumber: allocation.id,
        demandMonth: source?.periodMonth || plan.planMonth || plan.periodStart,
        requiredDate: sendDate,
        partCode: planDetail?.partCode || part.partCode || null,
        fgPartCode: planDetail?.partCode || null,
        qty: sentQty,
        uomCode,
        metadata,
      }],
    },
    sourcingAllocations: {
      create: [{
        supplierCode: null,
        vendorCode: vendor.vendorCode,
        demandCoveredQty: sentQty,
        demandUomCode: uomCode,
        deliveryDate: returnDate,
        currencyCode: price?.currencyCode || "IDR",
        unitPrice: price?.unitPrice ?? null,
        totalAmount: price?.unitPrice == null ? null : sentQty * number(price.unitPrice),
        status: "Confirmed",
        confirmedBy: "capacity-planning",
        confirmedAt: new Date(),
        notes: `${allocationMarker} Vendor dan delivery dipilih PPIC di Capacity Planning.`,
      }],
    },
  };
}

async function replaceDraftDetails(client, pr, detailRows) {
  const ids = (pr.details || []).map((row) => row.id);
  if (ids.length) {
    await client.purchaseRequisitionSource.updateMany({ where: { prDetailId: { in: ids }, isDeleted: false }, data: { isDeleted: true } });
    await client.purchaseRequisitionSourcingAllocation.updateMany({ where: { prDetailId: { in: ids }, isDeleted: false }, data: { isDeleted: true } });
    await client.purchaseRequisitionDetail.updateMany({ where: { id: { in: ids }, isDeleted: false }, data: { isDeleted: true } });
  }
  for (let index = 0; index < detailRows.length; index += 1) {
    await client.purchaseRequisitionDetail.create({ data: { ...detailRows[index], prNumber: pr.prNumber, lineNumber: index + 1 } });
  }
}

async function syncVendorProcessDraftPrForPlan(client, planId, actor = "system") {
  if (!client || !planId) return { created: [], updated: [], removed: [], warnings: [] };
  const plan = await client.monthlyProductionPlan.findFirst({
    where: { id: planId, isDeleted: false },
    select: {
      id: true, planNumber: true, planMonth: true, periodStart: true, sourceType: true,
      details: { where: { isDeleted: false }, select: { id: true, lineNumber: true, plannedOrderNumber: true, partCode: true, partId: true, mpsDetailId: true, uomCode: true, customerCode: true, customerTargetDate: true } },
      manualAllocations: {
        where: { isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode: "PRODUCTION", routingMode: "VENDOR", vendorId: { not: null }, plannedQty: { gt: EPSILON } },
        include: {
          vendor: { select: { id: true, vendorCode: true, vendorName: true } },
          mbomProcess: { include: { process: true, mbomDetail: { include: { part: { select: { partCode: true, partNumber: true, partName: true } } } } } },
        },
        orderBy: [{ vendorSendDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!plan) return { created: [], updated: [], removed: [], warnings: ["MPP tidak ditemukan."] };
  const detailByLine = new Map(plan.details.map((row) => [number(row.lineNumber), row]));
  const allocations = plan.manualAllocations.map((row) => ({ ...row, planDetail: detailByLine.get(number(row.lineNumber)) || null }));
  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  const mpsDetailIds = [...new Set(plan.details.map((row) => row.mpsDetailId).filter(Boolean))];
  const [currentMrp, demandSources, existingPrs, priceByAllocation] = await Promise.all([
    mpsNumber ? client.mRPRun.findFirst({ where: { mpsNumber, isDeleted: false, isCurrentPlan: true }, orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }], select: { runNumber: true } }) : null,
    mpsDetailIds.length ? client.mPSDemandSource.findMany({ where: { mpsDetailId: { in: mpsDetailIds } }, orderBy: [{ targetDeliveryDate: "asc" }, { createdAt: "asc" }] }) : [],
    client.purchaseRequisition.findMany({
      where: { isDeleted: false, sourceType: "SYSTEM", notes: { contains: `[CAPACITY-VENDOR-PR:${plan.planNumber}:` } },
      include: { details: { where: { isDeleted: false }, include: { sources: { where: { isDeleted: false } } } } },
    }),
    resolveVendorPrices(client, allocations),
  ]);
  const sourceByMpsDetail = new Map();
  for (const source of demandSources) {
    if (!sourceByMpsDetail.has(source.mpsDetailId)) sourceByMpsDetail.set(source.mpsDetailId, []);
    sourceByMpsDetail.get(source.mpsDetailId).push(source);
  }
  const protectedAllocationIds = new Set(existingPrs
    .filter((pr) => pr.status !== "Draft")
    .flatMap((pr) => pr.details || [])
    .flatMap((detail) => detail.sources || [])
    .filter((source) => source.sourceType === "CAPACITY_ALLOCATION")
    .map((source) => source.sourceNumber));
  const availableAllocations = allocations.filter((row) => !protectedAllocationIds.has(row.id));
  const groups = groupVendorAllocations(availableAllocations);
  const drafts = existingPrs.filter((pr) => pr.status === "Draft");
  const result = { created: [], updated: [], removed: [], warnings: [] };

  for (const draft of drafts) {
    const remains = [...groups.keys()].some((vendorCode) => String(draft.notes || "").includes(capacityVendorPrMarker(plan.planNumber, vendorCode)));
    if (!remains) {
      await client.purchaseRequisition.update({ where: { id: draft.id }, data: { isDeleted: true, notes: `${draft.notes || ""}; dibatalkan otomatis karena allocation vendor sudah tidak aktif.` } });
      result.removed.push(draft.prNumber);
    }
  }

  for (const [vendorCode, rows] of groups) {
    const marker = capacityVendorPrMarker(plan.planNumber, vendorCode);
    const vendor = rows[0].vendor;
    const detailRows = rows.map((allocation) => buildDetailData({
      allocation,
      plan,
      planDetail: allocation.planDetail,
      mpsNumber,
      mrpRunNumber: currentMrp?.runNumber,
      demandSources: sourceByMpsDetail.get(allocation.planDetail?.mpsDetailId) || [],
      price: priceByAllocation.get(allocation.id),
    }));
    const requiredDate = rows.map((row) => row.vendorSendDate || row.scheduleDate).filter(Boolean).sort((a, b) => a - b)[0] || new Date();
    const totalAmount = detailRows.reduce((sum, row) => sum + number(row.totalAmount), 0);
    const priceMissing = detailRows.filter((row) => number(row.estimatedPrice) <= 0).length;
    const notes = `${marker} Draft PR Vendor Process otomatis dari ${plan.planNumber}; vendor ${vendorCode} - ${vendor.vendorName || "-"}; ${rows.length} allocation; ${priceMissing ? `${priceMissing} harga belum tersedia di Vendor Price List.` : "harga dari Vendor Price List."}`;
    const existing = drafts.find((pr) => String(pr.notes || "").includes(marker));
    if (existing) {
      await replaceDraftDetails(client, existing, detailRows);
      await client.purchaseRequisition.update({ where: { id: existing.id }, data: { requiredDate, totalAmount, requestedBy: actor, priority: "Urgent", poType: "Out Process", procurementGroup: "VENDOR_PROCESS", notes } });
      result.updated.push({ prNumber: existing.prNumber, vendorCode, itemCount: detailRows.length, totalQty: rows.reduce((sum, row) => sum + number(row.plannedQty), 0) });
    } else {
      const prNumber = await generateDocNumber("purchaseRequisition", "PR", "prNumber", client);
      const created = await client.purchaseRequisition.create({
        data: {
          prNumber, prDate: new Date(), requestedBy: actor, requiredDate, priority: "Urgent", poType: "Out Process",
          sourceType: "SYSTEM", procurementGroup: "VENDOR_PROCESS", status: "Draft", totalAmount, notes,
          details: { create: detailRows.map((row, index) => ({ ...row, lineNumber: index + 1 })) },
        },
        select: { prNumber: true },
      });
      result.created.push({ prNumber: created.prNumber, vendorCode, itemCount: detailRows.length, totalQty: rows.reduce((sum, row) => sum + number(row.plannedQty), 0) });
    }
  }
  if (protectedAllocationIds.size) result.warnings.push(`${protectedAllocationIds.size} allocation sudah terhubung PR non-Draft dan tidak diubah otomatis.`);
  return result;
}

module.exports = {
  syncVendorProcessDraftPrForPlan,
  capacityVendorPrMarker,
  capacityAllocationMarker,
  groupVendorAllocations,
  processMatches,
  effectiveVendorRate,
};
