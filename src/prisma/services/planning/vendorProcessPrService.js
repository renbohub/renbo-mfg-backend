const { businessNow } = require("../../utils/businessClock");
const { generateDocNumber } = require("../../controllers/purchasing/utils/purchasingHelpers");
const { legacyPriceValue } = require("../pricing/effectivePriceService");

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
  const vendorCode = String(vendorProcess?.vendorProcessCode || "").trim().toLowerCase();
  const processCode = String(process?.processCode || "").trim().toLowerCase();
  if (vendorCode && processCode) return vendorCode === processCode;
  const vendorName = String(vendorProcess?.vendorProcessName || "").trim().toLowerCase();
  const processName = String(process?.processName || "").trim().toLowerCase();
  return Boolean(vendorName && processName && vendorName === processName);
};

function capacityVendorPrMarker(planNumber, vendorCode) {
  return `[CAPACITY-VENDOR-PR:${planNumber}:${vendorCode}]`;
}

function capacityAllocationMarker(allocationId) {
  return `[CAPACITY-ALLOCATION:${allocationId}]`;
}

const inactiveCommercialStatuses = new Set(["CANCELLED", "CANCELED", "REJECTED"]);
const activeCommercialRecord = (row) => Boolean(row && !row.isDeleted
  && !inactiveCommercialStatuses.has(String(row.status || "").toUpperCase()));

function isAutomaticCapacityProposal(row, detail, pr) {
  const marker = String(row.notes || "").match(/\[CAPACITY-ALLOCATION:([^\]]+)\]/)?.[0];
  return pr.sourceType === "SYSTEM"
    && String(pr.notes || "").includes("[CAPACITY-VENDOR-PR:")
    && row.status === "Confirmed" && row.confirmedBy === "capacity-planning"
    && Boolean(marker) && String(detail.notes || "").includes(marker)
    && !row.poNumber && number(detail.orderedQty) <= EPSILON
    && !detail.supplierConfirmedAt && !detail.supplierConfirmedBy;
}

function isVendorPrProtected(pr = {}) {
  // A Draft header may already own a PO or a confirmed sourcing decision.
  // Treat those commitments as immutable during automatic plan synchronization.
  const liveHeader = activeCommercialRecord(pr);
  if (liveHeader && String(pr.status || "").toUpperCase() !== "DRAFT") return true;
  if ((pr.purchaseOrders || []).some((link) => activeCommercialRecord(link.po))) return true;
  return (pr.details || []).filter((detail) => !detail.isDeleted).some((detail) => {
    if ((detail.poDetails || []).some((row) => !row.isDeleted && activeCommercialRecord(row.po))) return true;
    if ((detail.sourcingAllocations || []).some((row) => activeCommercialRecord(row)
      && (["CONFIRMED", "ORDERED"].includes(String(row.status || "").toUpperCase()) || row.confirmedAt || row.poNumber)
      // PPIC's generated choice uses the legacy Confirmed status, but is still
      // a planning proposal until Purchasing confirms or orders the demand.
      && !isAutomaticCapacityProposal(row, detail, pr))) return true;
    // The counter also protects legacy orders without an exact PO-detail FK.
    return liveHeader && number(detail.orderedQty) > EPSILON;
  });
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
  const matchingDetail = (priceList.details || []).find((row) => processMatches(row.vendorProcess, process)) || null;
  if (!matchingDetail) return null;
  const monthRate = optionalNumber(matchingDetail[MONTH_PRICE_FIELDS[(date || businessNow()).getUTCMonth()]]);
  const directRate = optionalNumber(matchingDetail.unitPrice);
  const unitPrice = legacyPriceValue(matchingDetail, date || businessNow());
  if (unitPrice == null || unitPrice < 0) return null;
  return {
    unitPrice,
    currencyCode: priceList.currencyCode || "IDR",
    priceListId: priceList.id,
    vendorProcessId: matchingDetail.vendorProcessId,
    priceSource: directRate != null ? "UNIT_PRICE" : monthRate > 0 ? `MONTH_${MONTH_PRICE_FIELDS[(date || businessNow()).getUTCMonth()].toUpperCase()}` : "PRICE_NOT_FOUND",
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
    const priceDate = allocation.vendorSendDate || allocation.scheduleDate || businessNow();
    const partId = allocation.planDetail?.partId || allocation.mbomProcess?.mbomDetail?.partId || null;
    const eligible = lists.filter((row) => row.vendorId === allocation.vendorId
      && (!row.partId || !partId || row.partId === partId)
      && (!row.effectiveFrom || row.effectiveFrom <= priceDate)
      && (!row.effectiveUntil || row.effectiveUntil >= priceDate));
    const exact = eligible.find((row) => row.partId && row.partId === partId && (row.details || []).some((detail) => processMatches(detail.vendorProcess, allocation.mbomProcess?.process)));
    const matched = exact
      || eligible.find((row) => (row.details || []).some((detail) => processMatches(detail.vendorProcess, allocation.mbomProcess?.process)));
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
      include: {
        purchaseOrders: { include: { po: { select: { poNumber: true, status: true, isDeleted: true } } } },
        details: { where: { isDeleted: false }, include: {
          sources: { where: { isDeleted: false } },
          poDetails: { where: { isDeleted: false }, include: { po: { select: { poNumber: true, status: true, isDeleted: true } } } },
          sourcingAllocations: { where: { isDeleted: false } },
        } },
      },
    }),
    resolveVendorPrices(client, allocations),
  ]);
  const sourceByMpsDetail = new Map();
  for (const source of demandSources) {
    if (!sourceByMpsDetail.has(source.mpsDetailId)) sourceByMpsDetail.set(source.mpsDetailId, []);
    sourceByMpsDetail.get(source.mpsDetailId).push(source);
  }
  const protectedPrIds = new Set(existingPrs.filter(isVendorPrProtected).map((pr) => pr.id));
  const protectedAllocationIds = new Set(existingPrs
    .filter((pr) => protectedPrIds.has(pr.id))
    .flatMap((pr) => pr.details || [])
    .flatMap((detail) => detail.sources || [])
    .filter((source) => source.sourceType === "CAPACITY_ALLOCATION")
    .map((source) => source.sourceNumber));
  const availableAllocations = allocations.filter((row) => !protectedAllocationIds.has(row.id));
  const groups = groupVendorAllocations(availableAllocations);
  const drafts = existingPrs.filter((pr) => pr.status === "Draft" && !protectedPrIds.has(pr.id));
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
    const requiredDate = rows.map((row) => row.vendorSendDate || row.scheduleDate).filter(Boolean).sort((a, b) => a - b)[0] || businessNow();
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
          prNumber, prDate: businessNow(), requestedBy: actor, requiredDate, priority: "Urgent", poType: "Out Process",
          sourceType: "SYSTEM", procurementGroup: "VENDOR_PROCESS", status: "Draft", totalAmount, notes,
          details: { create: detailRows.map((row, index) => ({ ...row, lineNumber: index + 1 })) },
        },
        select: { prNumber: true },
      });
      result.created.push({ prNumber: created.prNumber, vendorCode, itemCount: detailRows.length, totalQty: rows.reduce((sum, row) => sum + number(row.plannedQty), 0) });
    }
  }
  if (protectedPrIds.size) result.warnings.push(`${protectedPrIds.size} PR vendor memiliki status atau komitmen purchasing yang terlindungi; ${protectedAllocationIds.size} allocation tidak diubah otomatis. Gunakan Replan untuk perubahan pelaksana.`);
  return result;
}

module.exports = {
  syncVendorProcessDraftPrForPlan,
  capacityVendorPrMarker,
  capacityAllocationMarker,
  groupVendorAllocations,
  processMatches,
  effectiveVendorRate,
  isVendorPrProtected,
};
