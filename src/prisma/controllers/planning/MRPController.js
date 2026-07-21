const { randomUUID } = require("crypto");
const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseDate } = require("../../utils/parseDate");
const { parseFilter } = require("../../utils/parseFilter");
const { getSoDemandTimeFenceSetting } = require("../../utils/systemSettings");
const {
  buildExcludeSpecialRackCondition,
} = require("../inventory/utils/stockReservationHelpers");
const {
  syncOperationalSalesOrderStatus,
} = require("../../services/production/sales-order/soStatusService");
const {
  emitPlanningMrpRunUpdate,
  emitPlanningPlannedOrderBulkUpdate,
} = require("./services/planningRealtimeService");
const { isSubAssemblyDetail } = require("../../utils/assemblyPolicy");
const { durationToWorkingDays } = require("../../utils/duration");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GENERATED_MPS_CHILD_NOTE_PREFIX = "[MRP-PRODUCTION]";

function createRequirementIdentity(parentRequirementId = null, rootRequirementId = null) {
  const id = randomUUID();
  return {
    id,
    parentRequirementId,
    rootRequirementId: rootRequirementId || id,
  };
}

function formatTreeSegment(value) {
  return String(Math.max(Number(value || 0), 0)).padStart(4, "0");
}

function buildRequirementTreePath(parentTreePath, level, sequence) {
  const segment = `${formatTreeSegment(level)}-${formatTreeSegment(sequence)}`;
  return parentTreePath ? `${parentTreePath}.${segment}` : segment;
}

function sortMbomDetailsParentFirst(details = []) {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const depthById = new Map();
  const getDepth = (detail, visiting = new Set()) => {
    if (depthById.has(detail.id)) return depthById.get(detail.id);
    if (!detail.parentDetailId || !detailById.has(detail.parentDetailId)) return 0;
    if (visiting.has(detail.id)) return 0;

    const nextVisiting = new Set(visiting).add(detail.id);
    const depth = getDepth(detailById.get(detail.parentDetailId), nextVisiting) + 1;
    depthById.set(detail.id, depth);
    return depth;
  };

  return details
    .map((detail, index) => ({ detail, index, depth: getDepth(detail) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ detail }) => detail);
}

function resolvePlanHorizonDays(planHorizonInput, periodStart, periodEnd) {
  const parsedInput = Number(planHorizonInput);
  if (Number.isFinite(parsedInput) && parsedInput > 0) {
    return Math.max(Math.trunc(parsedInput), 1);
  }

  const start = parseDate(periodStart);
  const end = parseDate(periodEnd);
  if (!start || !end) {
    return 90;
  }

  const diffDays = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
  return Math.max(diffDays, 1);
}

function buildMbomValidityWhere(targetDate) {
  const validOn = parseDate(targetDate);
  return {
    AND: [
      {
        OR: [{ effectiveDate: null }, { effectiveDate: { lte: validOn } }],
      },
      {
        OR: [{ expiryDate: null }, { expiryDate: { gte: validOn } }],
      },
    ],
  };
}

async function findActiveMbomHeader(tx, partId, targetDate) {
  if (!partId) return null;

  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      ...buildMbomValidityWhere(targetDate),
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
    select: { id: true, uomCode: true },
  });
}

async function supersedePreviousMrpArtifacts(tx, mpsNumber, currentRunNumber, runBy) {
  if (!mpsNumber) return;

  const previousRuns = await tx.mRPRun.findMany({
    where: {
      mpsNumber,
      isDeleted: false,
      runNumber: { not: currentRunNumber },
    },
    select: { runNumber: true },
  });

  const previousRunNumbers = previousRuns.map((row) => row.runNumber).filter(Boolean);
  if (previousRunNumbers.length === 0) return;

  await tx.mRPRequirement.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: previousRunNumbers },
    },
    data: {
      isDeleted: true,
      notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
    },
  });

  const plannedOrdersToSupersede = await tx.plannedOrder.findMany({
    where: {
      isDeleted: false,
      status: "Planned",
      referenceType: "MRP",
      runNumber: { in: previousRunNumbers },
    },
    select: { orderNumber: true },
  });
  const plannedOrderNumbersToSupersede = plannedOrdersToSupersede
    .map((order) => order.orderNumber)
    .filter(Boolean);

  // Soft delete planned order lama berstatus Planned agar run terbaru jadi baseline tunggal.
  await tx.plannedOrder.updateMany({
    where: {
      isDeleted: false,
      status: "Planned",
      referenceType: "MRP",
      runNumber: { in: previousRunNumbers },
    },
    data: {
      isDeleted: true,
      notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
    },
  });

  if (plannedOrderNumbersToSupersede.length > 0) {
    await tx.mRPPegging.updateMany({
      where: {
        supplyType: "PlannedOrder",
        supplyNumber: { in: plannedOrderNumbersToSupersede },
        status: "Active",
      },
      data: {
        status: "Closed",
        notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
      },
    });
  }

  await tx.mRPRun.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: previousRunNumbers },
    },
    data: {
      isDeleted: true,
      notes: `Superseded by MRP run ${currentRunNumber} (${runBy || "system"})`,
    },
  });
}

function buildMpsPlanNumber(mpsNumber) {
  return mpsNumber ? `MRP-${mpsNumber}` : null;
}

function buildSoPlanNumber(soNumber) {
  return soNumber ? `MRP-${soNumber}` : null;
}

async function supersedeSoOnlyPlansCoveredByMps(tx, soNumbers, currentRunNumber, currentPlanNumber, runBy) {
  const uniqueSoNumbers = [...new Set((soNumbers || []).filter(Boolean))];
  if (uniqueSoNumbers.length === 0) return;

  const soPlanNumbers = uniqueSoNumbers.map(buildSoPlanNumber).filter(Boolean);
  if (soPlanNumbers.length === 0) return;

  const soRuns = await tx.mRPRun.findMany({
    where: {
      isDeleted: false,
      planScope: "SO",
      planNumber: { in: soPlanNumbers },
      runNumber: { not: currentRunNumber },
    },
    select: {
      runNumber: true,
    },
  });
  const soRunNumbers = soRuns.map((run) => run.runNumber).filter(Boolean);
  if (soRunNumbers.length === 0) return;

  const notes = `Superseded by MPS MRP ${currentPlanNumber || currentRunNumber} (${runBy || "system"})`;

  await tx.mRPRequirement.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: soRunNumbers },
    },
    data: {
      isDeleted: true,
      notes,
    },
  });

  const plannedOrders = await tx.plannedOrder.findMany({
    where: {
      isDeleted: false,
      status: "Planned",
      runNumber: { in: soRunNumbers },
    },
    select: { orderNumber: true },
  });
  const plannedOrderNumbers = plannedOrders.map((order) => order.orderNumber).filter(Boolean);

  await tx.plannedOrder.updateMany({
    where: {
      isDeleted: false,
      status: "Planned",
      runNumber: { in: soRunNumbers },
    },
    data: {
      isDeleted: true,
      notes,
    },
  });

  if (plannedOrderNumbers.length > 0) {
    await tx.mRPPegging.updateMany({
      where: {
        demandType: "SO",
        demandNumber: { in: uniqueSoNumbers },
        supplyType: "PlannedOrder",
        supplyNumber: { in: plannedOrderNumbers },
        status: "Active",
      },
      data: {
        status: "Closed",
        notes,
      },
    });
  }

  await tx.mRPRun.updateMany({
    where: {
      isDeleted: false,
      runNumber: { in: soRunNumbers },
    },
    data: {
      isDeleted: true,
      isCurrentPlan: false,
      notes,
    },
  });
}

async function resolvePlanIdentity(tx, { mpsNumber, planNumber, planScope = "MPS" }) {
  const resolvedPlanNumber = planNumber || buildMpsPlanNumber(mpsNumber);
  if (!resolvedPlanNumber) {
    return {
      planNumber: null,
      planRevision: 1,
      planScope: planScope || "Manual",
      isCurrentPlan: true,
    };
  }

  const latestPlanRun = await tx.mRPRun.findFirst({
    where: { planNumber: resolvedPlanNumber },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    select: { planRevision: true },
  });

  return {
    planNumber: resolvedPlanNumber,
    planRevision: Number(latestPlanRun?.planRevision || 0) + 1,
    planScope,
    isCurrentPlan: true,
  };
}

async function retirePreviousPlanRevisions(tx, planNumber, currentRunNumber) {
  if (!planNumber) return;

  await tx.mRPRun.updateMany({
    where: {
      planNumber,
      runNumber: { not: currentRunNumber },
      isCurrentPlan: true,
    },
    data: { isCurrentPlan: false },
  });
}

async function findRunByNumberOrCurrentPlan(identifier, include = undefined) {
  if (!identifier) return null;

  const byRunNumber = await prisma.mRPRun.findUnique({
    where: { runNumber: identifier },
    ...(include ? { include } : {}),
  });
  if (byRunNumber && !byRunNumber.isDeleted) return byRunNumber;

  // Link run lama tetap berguna setelah recalculation. Jika revision lama sudah
  // superseded, tampilkan revision current dari plan yang sama.
  if (byRunNumber?.planNumber) {
    const currentRevision = await prisma.mRPRun.findFirst({
      where: {
        planNumber: byRunNumber.planNumber,
        isCurrentPlan: true,
        isDeleted: false,
      },
      orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
      ...(include ? { include } : {}),
    });
    if (currentRevision) return currentRevision;
  }

  return prisma.mRPRun.findFirst({
    where: {
      planNumber: identifier,
      isCurrentPlan: true,
    },
    orderBy: [{ planRevision: "desc" }, { runDate: "desc" }],
    ...(include ? { include } : {}),
  });
}

async function resolveCurrentRunNumber(identifier) {
  const run = await findRunByNumberOrCurrentPlan(identifier, undefined);
  return run?.runNumber || null;
}

async function enrichPlannedOrderDisplay(tx, orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const partCodes = [
    ...new Set(
      orders
        .map((order) => normalizePartCode(order.partCode || order.part?.partCode))
        .filter(Boolean),
    ),
  ];
  const mbomHeaderIds = [
    ...new Set(orders.map((order) => order.mbomHeaderId).filter(Boolean)),
  ];

  const [parts, mbomHeaders] = await Promise.all([
    partCodes.length > 0
      ? tx.part.findMany({
          where: { partCode: { in: partCodes }, isDeleted: false },
          select: { id: true, partCode: true, partNumber: true, partName: true },
        })
      : [],
    mbomHeaderIds.length > 0
      ? tx.mBOMHeader.findMany({
          where: { id: { in: mbomHeaderIds }, isDeleted: false },
          select: { id: true, noReg: true, revision: true, uomCode: true },
        })
      : [],
  ]);

  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const mbomById = new Map(mbomHeaders.map((mbom) => [mbom.id, mbom]));

  return orders.map((order) => {
    const part = order.part || partByCode.get(normalizePartCode(order.partCode)) || null;
    const mbomHeader = order.mbomHeaderId ? mbomById.get(order.mbomHeaderId) || null : null;

    return {
      ...order,
      part,
      partName: part?.partName || order.partName || null,
      mbomHeader,
      mbomHeaderNoReg: mbomHeader?.noReg || null,
    };
  });
}

function normalizePartCode(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveBufferPercent(part) {
  const bufferStock = Number(part?.bufferStock || 0);
  if (!Number.isFinite(bufferStock) || bufferStock <= 0) return 0;
  return bufferStock;
}

function applyBufferStockPercent(baseQty, part) {
  const demandQty = Number(baseQty || 0);
  const bufferPercent = resolveBufferPercent(part);
  const bufferQty = demandQty > 0 && bufferPercent > 0
    ? (demandQty * bufferPercent) / 100
    : 0;

  return {
    demandQty,
    bufferPercent,
    bufferQty,
    grossRequirement: demandQty + bufferQty,
  };
}

function buildStockPositionMaps(stockRows = []) {
  return stockRows.reduce(
    (acc, stock) => {
      const partCode = normalizePartCode(stock.partCode);
      if (!partCode) return acc;

      const qtyOnHand = Number(stock.qtyOnHand || 0);
      const qtyReserved = Number(stock.qtyReserved || 0);
      const qtyQC = Number(stock.qtyQC || 0);
      const qtyAvailable = stock.qtyAvailable == null
        ? Math.max(qtyOnHand - qtyReserved - qtyQC, 0)
        : Number(stock.qtyAvailable || 0);

      acc.onHand[partCode] = Number(acc.onHand[partCode] || 0) + qtyOnHand;
      acc.allocated[partCode] =
        Number(acc.allocated[partCode] || 0) + qtyReserved + qtyQC;
      acc.available[partCode] =
        Number(acc.available[partCode] || 0) + Math.max(qtyAvailable, 0);
      return acc;
    },
    { onHand: {}, allocated: {}, available: {} },
  );
}

function normalizeUomCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizePartBaseOn(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isKgUom(value) {
  const code = normalizeUomCode(value);
  return code === "kg";
}

function isPcsUom(value) {
  const code = normalizeUomCode(value);
  return code === "pcs";
}

function isRawMaterialPart(part) {
  return part?.itemType === "RAW" && part?.rawType === "MATERIAL";
}

function getPreferredPartBase(part) {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "QTN") ||
    bases[0] ||
    null
  );
}

function resolveKgPerPcs(part) {
  // Focus sementara: konversi planning ke kg hanya memakai gross weight part.
  // Packing ratio dinonaktifkan dulu sampai rule bisnisnya dikonfirmasi.
  // const pcsPerBox = Number(part?.pcsPerBox || 0);
  // const kgPerBox = Number(part?.kgPerBox || 0);
  // if (pcsPerBox > 0 && kgPerBox > 0) {
  //   return { factor: kgPerBox / pcsPerBox, source: "packing box" };
  // }

  // const pcsPerPlastic = Number(part?.pcsPerPlastic || 0);
  // const kgPerPlastic = Number(part?.kgPerPlastic || 0);
  // if (pcsPerPlastic > 0 && kgPerPlastic > 0) {
  //   return { factor: kgPerPlastic / pcsPerPlastic, source: "packing plastic" };
  // }

  const base = getPreferredPartBase(part);
  const grossWeight = Number(base?.grossWeight || 0);
  if (grossWeight > 0) {
    return { factor: grossWeight, source: `${base.baseOn || "part"} gross weight` };
  }

  // const netWeight = Number(base?.netWeight || 0);
  // if (netWeight > 0) {
  //   return { factor: netWeight, source: `${base.baseOn || "part"} net weight` };
  // }

  return { factor: null, source: null };
}

function normalizePurchasingSupplyQty(row, options = {}) {
  const qty = Number(row?.qty || 0);
  if (qty <= 0) return 0;
  const targetUomCode = normalizeUomCode(options.targetUomCode);
  const sourceUomCode = normalizeUomCode(row?.uomCode);
  const fallbackFactor = Number(options.kgPerQty || 0);
  const kgPerQty = fallbackFactor > 0 ? fallbackFactor : resolveKgPerPcs(row?.part).factor;

  if (targetUomCode === "kg") {
    if (sourceUomCode === "kg" || !sourceUomCode) return qty;
    return kgPerQty ? qty * kgPerQty : qty;
  }
  if (sourceUomCode === "kg") return kgPerQty ? qty / kgPerQty : qty;
  return qty;
}

function normalizePlanningStockRows(stockRows = [], options = {}) {
  const planningUomByPartCode = options.planningUomByPartCode || {};
  const kgPerQtyByPartCode = options.kgPerQtyByPartCode || {};
  return stockRows.map((row) => {
    const partCode = normalizePartCode(row.partCode);
    const targetUomCode = planningUomByPartCode[partCode];
    if (!targetUomCode) return row;
    const kgPerQty = Number(kgPerQtyByPartCode[partCode] || 0);
    const convert = (value) => normalizePurchasingSupplyQty(
      { qty: value, uomCode: row.uomCode },
      { targetUomCode, kgPerQty },
    );
    return {
      ...row,
      qtyOnHand: convert(row.qtyOnHand),
      qtyReserved: convert(row.qtyReserved),
      qtyQC: convert(row.qtyQC),
      qtyAvailable: convert(row.qtyAvailable),
    };
  });
}

const WIP_STOCK_TYPES = new Set(["WIP", "SEMI-FINISHED", "SEMI FINISHED", "SFG"]);
function isWipStockType(value) {
  return WIP_STOCK_TYPES.has(String(value || "").trim().toUpperCase());
}

async function enrichRequirementSupplyBreakdown(tx, requirements = []) {
  if (!Array.isArray(requirements) || requirements.length === 0) return requirements;

  const partCodes = [...new Set(requirements.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
  if (partCodes.length === 0) return requirements;

  const [parts, stockRows, purchaseOrderRows] = await Promise.all([
    tx.part.findMany({
      where: { partCode: { in: partCodes }, isDeleted: false },
      select: {
        partCode: true,
        itemType: true,
        rawType: true,
        partBases: { select: { baseOn: true, grossWeight: true } },
      },
    }),
    tx.stockBalance.findMany({
      where: {
        AND: [
          { partCode: { in: partCodes }, isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: {
        id: true,
        partCode: true,
        warehouseCode: true,
        rackCode: true,
        lotNumber: true,
        stockType: true,
        uomCode: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyQC: true,
        qtyAvailable: true,
        warehouse: { select: { warehouseCode: true, warehouseName: true } },
      },
      orderBy: [{ warehouseCode: "asc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
    }),
    tx.purchaseOrderDetail.findMany({
      where: {
        isDeleted: false,
        partCode: { in: partCodes },
        po: {
          isDeleted: false,
          status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt"] },
        },
      },
      select: {
        id: true,
        partCode: true,
        qty: true,
        qtyReceived: true,
        uomCode: true,
        po: {
          select: {
            poNumber: true,
            status: true,
            deliveryDate: true,
            supplierCode: true,
            supplierName: true,
            vendorCode: true,
            vendorName: true,
          },
        },
      },
      orderBy: [{ po: { deliveryDate: "asc" } }, { createdAt: "asc" }],
    }),
  ]);

  const partByCode = new Map(parts.map((part) => [normalizePartCode(part.partCode), part]));
  const planningUomByPartCode = {};
  const kgPerQtyByPartCode = {};
  for (const requirement of requirements) {
    const partCode = normalizePartCode(requirement.partCode);
    const part = requirement.part || partByCode.get(partCode);
    if (!partCode || !isRawMaterialPart(part)) continue;
    const targetUomCode = isKgUom(requirement.uomCode) || requirement.plannedOrderQtyKg != null ? "kg" : requirement.uomCode;
    if (!targetUomCode) continue;
    planningUomByPartCode[partCode] = targetUomCode;
    const factor = Number(requirement.mbomDetail?.grossWeight || 0) || Number(resolveKgPerPcs(partByCode.get(partCode)).factor || 0);
    if (factor > 0) kgPerQtyByPartCode[partCode] = factor;
  }

  const conversionRules = { planningUomByPartCode, kgPerQtyByPartCode };
  const normalizedStocks = normalizePlanningStockRows(stockRows, conversionRules);
  const stocksByPart = new Map();
  for (const stock of normalizedStocks) {
    const partCode = normalizePartCode(stock.partCode);
    if (!stocksByPart.has(partCode)) stocksByPart.set(partCode, []);
    stocksByPart.get(partCode).push(stock);
  }

  const supplierByPart = new Map();
  for (const row of purchaseOrderRows) {
    const partCode = normalizePartCode(row.partCode);
    const outstandingOriginalQty = Math.max(Number(row.qty || 0) - Number(row.qtyReceived || 0), 0);
    if (!partCode || outstandingOriginalQty <= 0) continue;
    const outstandingQty = normalizePurchasingSupplyQty(
      { ...row, qty: outstandingOriginalQty, part: partByCode.get(partCode) },
      { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
    );
    if (!supplierByPart.has(partCode)) supplierByPart.set(partCode, []);
    supplierByPart.get(partCode).push({
      poDetailId: row.id,
      poNumber: row.po.poNumber,
      poStatus: row.po.status,
      supplierCode: row.po.supplierCode || row.po.vendorCode || null,
      supplierName: row.po.supplierName || row.po.vendorName || null,
      deliveryDate: row.po.deliveryDate,
      orderedQty: normalizePurchasingSupplyQty(
        { ...row, qty: Number(row.qty || 0), part: partByCode.get(partCode) },
        { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
      ),
      receivedQty: normalizePurchasingSupplyQty(
        { ...row, qty: Number(row.qtyReceived || 0), part: partByCode.get(partCode) },
        { targetUomCode: planningUomByPartCode[partCode], kgPerQty: kgPerQtyByPartCode[partCode] },
      ),
      outstandingQty: roundPlanningQty(outstandingQty),
      uomCode: planningUomByPartCode[partCode] || row.uomCode || null,
    });
  }

  return requirements.map((requirement) => {
    const partCode = normalizePartCode(requirement.partCode);
    const stockLines = stocksByPart.get(partCode) || [];
    const warehouseLines = stockLines.filter((row) => !isWipStockType(row.stockType));
    const wipLines = stockLines.filter((row) => isWipStockType(row.stockType));
    const supplierLines = (supplierByPart.get(partCode) || []).map((row) => ({
      ...row,
      eligibleForRequirement: !row.deliveryDate || new Date(row.deliveryDate) <= new Date(requirement.requiredDate),
    }));
    const stockSummary = (lines) => ({
      qtyOnHand: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyOnHand || 0), 0)),
      qtyReserved: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyReserved || 0), 0)),
      qtyQC: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyQC || 0), 0)),
      qtyAvailable: roundPlanningQty(lines.reduce((sum, row) => sum + Number(row.qtyAvailable || 0), 0)),
      lines: lines.map((row) => ({
        stockBalanceId: row.id,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouse?.warehouseName || null,
        rackCode: row.rackCode,
        lotNumber: row.lotNumber,
        stockType: row.stockType,
        uomCode: planningUomByPartCode[partCode] || row.uomCode || null,
        qtyOnHand: roundPlanningQty(row.qtyOnHand),
        qtyReserved: roundPlanningQty(row.qtyReserved),
        qtyQC: roundPlanningQty(row.qtyQC),
        qtyAvailable: roundPlanningQty(row.qtyAvailable),
      })),
    });

    return {
      ...requirement,
      supplyBreakdown: {
        warehouseStock: stockSummary(warehouseLines),
        wipStock: stockSummary(wipLines),
        supplierOutstanding: {
          qtyOutstanding: roundPlanningQty(supplierLines.reduce((sum, row) => sum + Number(row.outstandingQty || 0), 0)),
          qtyEligible: roundPlanningQty(supplierLines.filter((row) => row.eligibleForRequirement).reduce((sum, row) => sum + Number(row.outstandingQty || 0), 0)),
          lines: supplierLines,
        },
      },
    };
  });
}

function buildMaterialPlanningRules(details = []) {
  const planningUomByPartCode = {};
  const kgPerQtyByPartCode = {};

  for (const detail of details) {
    if (!isRawMaterialPart(detail.part)) continue;
    const partCode = normalizePartCode(detail.part?.partCode);
    if (!partCode) continue;
    if (isKgUom(detail.uomCode)) {
      planningUomByPartCode[partCode] = "kg";
      kgPerQtyByPartCode[partCode] = 1;
      continue;
    }
    const detailFactor = Number(detail.grossWeight || 0);
    const partFactor = Number(resolveKgPerPcs(detail.part).factor || 0);
    const factor = detailFactor > 0 ? detailFactor : partFactor;
    if (factor > 0) {
      planningUomByPartCode[partCode] = "kg";
      kgPerQtyByPartCode[partCode] = factor;
    }
  }

  return { planningUomByPartCode, kgPerQtyByPartCode };
}

async function buildProductionMbomKgPerPcsMap(tx, requirements = [], partMap = new Map()) {
  const productionRows = requirements.filter(
    (row) => row.orderType === "Production" || row.levelMBOM === 0,
  );
  const result = new Map();

  for (const row of productionRows) {
    const part =
      partMap.get(row.partId) ||
      partMap.get(normalizePartCode(row.partCode)) ||
      null;
    const partId = row.partId || part?.id || null;
    if (!partId) continue;

    const mbom = await tx.mBOMHeader.findFirst({
      where: {
        partId,
        isDeleted: false,
        ...buildMbomValidityWhere(row.requiredDate),
      },
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      include: {
        details: {
          where: { isDeleted: false },
          include: {
            part: {
              select: {
                id: true,
                partCode: true,
                pcsPerBox: true,
                kgPerBox: true,
                pcsPerPlastic: true,
                kgPerPlastic: true,
                partBases: {
                  select: {
                    baseOn: true,
                    netWeight: true,
                    grossWeight: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!mbom?.details?.length) continue;

    let factor = 0;
    for (const detail of mbom.details) {
      const childFactor = resolveKgPerPcs(detail.part).factor;
      if (!childFactor) continue;
      factor += Number(detail.qty || 0) * childFactor;
    }

    if (factor > 0) {
      const roundedFactor = roundPlanningQty(factor);
      if (row.partId) result.set(row.partId, roundedFactor);
      if (row.partCode) result.set(normalizePartCode(row.partCode), roundedFactor);
    }
  }

  return result;
}

async function buildProductionRequirementKgMap(tx, requirements = [], partMap = new Map()) {
  if (!Array.isArray(requirements) || requirements.length === 0) return new Map();

  const result = new Map();
  const productionRows = requirements.filter(
    (row) => row.orderType === "Production" || row.levelMBOM === 0,
  );
  const dependentRows = requirements.filter((row) => Number(row.levelMBOM || 0) > 0);
  const missingPartIds = [
    ...new Set(dependentRows.map((row) => row.partId).filter((id) => id && !partMap.has(id))),
  ];
  const missingPartCodes = [
    ...new Set(
      dependentRows
        .map((row) => normalizePartCode(row.partCode))
        .filter((code) => code && !partMap.has(code)),
    ),
  ];

  if (missingPartIds.length > 0 || missingPartCodes.length > 0) {
    const parts = await tx.part.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(missingPartIds.length > 0 ? [{ id: { in: missingPartIds } }] : []),
          ...(missingPartCodes.length > 0 ? [{ partCode: { in: missingPartCodes } }] : []),
        ],
      },
      select: {
        id: true,
        partCode: true,
        pcsPerBox: true,
        kgPerBox: true,
        pcsPerPlastic: true,
        kgPerPlastic: true,
        partBases: {
          select: {
            baseOn: true,
            netWeight: true,
            grossWeight: true,
          },
        },
      },
    });

    for (const part of parts) {
      if (part.id) partMap.set(part.id, part);
      if (part.partCode) partMap.set(normalizePartCode(part.partCode), part);
    }
  }

  for (const row of productionRows) {
    const rowDate = row.requiredDate ? new Date(row.requiredDate).getTime() : null;
    if (!rowDate) continue;

    let totalKg = 0;
    for (const dependent of dependentRows) {
      const dependentDate = dependent.requiredDate ? new Date(dependent.requiredDate).getTime() : null;
      if (dependentDate !== rowDate) continue;

      const part =
        partMap.get(dependent.partId) ||
        partMap.get(normalizePartCode(dependent.partCode)) ||
        null;
      const factor = resolveKgPerPcs(part).factor;
      if (!factor) continue;

      totalKg += Number(dependent.plannedOrderQty || dependent.netRequirement || 0) * Number(factor || 0);
    }

    if (totalKg > 0) {
      const roundedKg = roundPlanningQty(totalKg);
      if (row.id) result.set(row.id, roundedKg);
      if (row.partId) result.set(row.partId, roundedKg);
      if (row.partCode) result.set(normalizePartCode(row.partCode), roundedKg);
    }
  }

  return result;
}

function roundPlanningQty(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return Number(qty.toFixed(6));
}

async function buildProductionConversionPartMap(tx, requirements = []) {
  const partIds = [...new Set(requirements.map((row) => row.partId).filter(Boolean))];
  const partCodes = [
    ...new Set(requirements.map((row) => normalizePartCode(row.partCode)).filter(Boolean)),
  ];

  if (partIds.length === 0 && partCodes.length === 0) return new Map();

  const parts = await tx.part.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(partIds.length > 0 ? [{ id: { in: partIds } }] : []),
        ...(partCodes.length > 0 ? [{ partCode: { in: partCodes } }] : []),
      ],
    },
    select: {
      id: true,
      partCode: true,
      itemType: true,
      rawType: true,
      pcsPerBox: true,
      kgPerBox: true,
      pcsPerPlastic: true,
      kgPerPlastic: true,
      partBases: {
        select: {
          baseOn: true,
          netWeight: true,
          grossWeight: true,
        },
      },
    },
  });

  const map = new Map();
  for (const part of parts) {
    if (part.id) map.set(part.id, part);
    if (part.partCode) map.set(normalizePartCode(part.partCode), part);
  }
  return map;
}

function resolveProductionPlannedOrderQuantity({ qty, sourceUomCode, part, fallbackKgPerPcs = null }) {
  const sourceCode = normalizeUomCode(sourceUomCode);
  const partConversion = resolveKgPerPcs(part);
  const fallbackFactor = Number(fallbackKgPerPcs || 0);
  const factor = partConversion.factor || (fallbackFactor > 0 ? fallbackFactor : null);
  const source = partConversion.source || (factor ? "active mbom component gross weight" : null);

  if (factor) {
    const convertedQty = roundPlanningQty(Number(qty || 0) * Number(factor || 0));
    return {
      qty: convertedQty,
      uomCode: "kg",
      note: `Auto converted production qty from ${roundPlanningQty(qty)} ${sourceUomCode || "original uom"} to ${convertedQty} kg using ${source}.`,
    };
  }

  if (isKgUom(sourceCode)) {
    return {
      qty: roundPlanningQty(qty),
      uomCode: "kg",
      note: null,
    };
  }

  if (!factor) {
    return {
      qty: roundPlanningQty(qty),
      uomCode: sourceUomCode || null,
      note: sourceCode && !isPcsUom(sourceCode)
        ? null
        : "Production qty belum dikonversi ke kg karena data berat/packing part belum lengkap.",
    };
  }
}

function buildPlannedOrderRequirementKey(row) {
  const requiredDate = row.requiredDate ? new Date(row.requiredDate).toISOString() : "";
  const orderDate = row.orderDate ? new Date(row.orderDate).toISOString() : "";
  return [
    row.runNumber || "",
    normalizePartCode(row.partCode),
    requiredDate,
    orderDate,
  ].join("|");
}

function parseSoSourceNumber(value) {
  const [soNumber, lineNumber] = String(value || "").split("#");
  const parsedLineNumber = Number(lineNumber);
  return {
    soNumber: soNumber || null,
    lineNumber: Number.isFinite(parsedLineNumber) ? parsedLineNumber : null,
  };
}

async function buildRequirementOriginalUomMap(tx, requirements = []) {
  const map = new Map();
  if (!Array.isArray(requirements) || requirements.length === 0) return map;

  const mpsDetailIds = [
    ...new Set(requirements.map((row) => row.mpsDetailId).filter(Boolean)),
  ];
  if (mpsDetailIds.length > 0) {
    const mpsDetails = await tx.mPSDetail.findMany({
      where: { id: { in: mpsDetailIds } },
      select: {
        id: true,
        mbom: { select: { uomCode: true } },
        forecastDetail: { select: { uomCode: true } },
      },
    });
    const uomByMpsDetailId = new Map(
      mpsDetails.map((detail) => [
        detail.id,
        detail.forecastDetail?.uomCode || detail.mbom?.uomCode || null,
      ]),
    );
    for (const requirement of requirements) {
      const uomCode = uomByMpsDetailId.get(requirement.mpsDetailId);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  const soRequirements = requirements.filter((row) => row.sourceType === "SO" && row.sourceNumber);
  if (soRequirements.length > 0) {
    const soFilters = soRequirements
      .map((row) => parseSoSourceNumber(row.sourceNumber))
      .filter((row) => row.soNumber && row.lineNumber != null);
    const soDetails = soFilters.length > 0
      ? await tx.salesOrderDetail.findMany({
          where: {
            OR: soFilters.map((row) => ({
              soNumber: row.soNumber,
              lineNumber: row.lineNumber,
            })),
          },
          select: {
            soNumber: true,
            lineNumber: true,
            uomCode: true,
          },
        })
      : [];
    const uomBySoLine = new Map(
      soDetails.map((detail) => [`${detail.soNumber}#${detail.lineNumber}`, detail.uomCode]),
    );
    for (const requirement of soRequirements) {
      const uomCode = uomBySoLine.get(requirement.sourceNumber);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  const mbomRequirements = requirements.filter(
    (row) => row.sourceType === "MBOM" && row.sourceNumber && row.partId,
  );
  if (mbomRequirements.length > 0) {
    const noRegs = [...new Set(mbomRequirements.map((row) => row.sourceNumber).filter(Boolean))];
    const partIds = [...new Set(mbomRequirements.map((row) => row.partId).filter(Boolean))];
    const details = await tx.mBOMDetail.findMany({
      where: {
        noReg: { in: noRegs },
        partId: { in: partIds },
        isDeleted: false,
      },
      select: {
        noReg: true,
        partId: true,
        uomCode: true,
      },
    });
    const uomByMbomPart = new Map(
      details.map((detail) => [`${detail.noReg}|${detail.partId}`, detail.uomCode]),
    );
    for (const requirement of mbomRequirements) {
      const uomCode = uomByMbomPart.get(`${requirement.sourceNumber}|${requirement.partId}`);
      if (uomCode) map.set(requirement.id, uomCode);
    }
  }

  return map;
}

async function enrichPlannedOrderQtyBreakdown(tx, orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const runNumbers = [...new Set(orders.map((order) => order.runNumber).filter(Boolean))];
  const partCodes = [
    ...new Set(orders.map((order) => normalizePartCode(order.partCode)).filter(Boolean)),
  ];

  if (runNumbers.length === 0 || partCodes.length === 0) {
    return orders.map((order) => ({
      ...order,
      qtyPcs: order.orderType === "Purchase" && isPcsUom(order.uomCode) ? Number(order.qty || 0) : null,
      qtyKg: isKgUom(order.uomCode) ? Number(order.qty || 0) : null,
    }));
  }

  const requirements = await tx.mRPRequirement.findMany({
    where: {
      runNumber: { in: runNumbers },
      plannedOrderQty: { gt: 0 },
      isDeleted: false,
    },
    select: {
      id: true,
      runNumber: true,
      parentRequirementId: true,
      rootRequirementId: true,
      treePath: true,
      partCode: true,
      requiredDate: true,
      orderDate: true,
      plannedOrderQty: true,
      levelMBOM: true,
      mbomLevelComponent: true,
      mbomDetailId: true,
      requirementType: true,
      partId: true,
      orderType: true,
      netRequirement: true,
      mpsDetailId: true,
      sourceType: true,
      sourceNumber: true,
    },
  });

  const requirementByKey = new Map(
    requirements.map((requirement) => [buildPlannedOrderRequirementKey(requirement), requirement]),
  );
  const productionConversionPartMap = await buildProductionConversionPartMap(tx, requirements);
  const productionRequirementKgMap = await buildProductionRequirementKgMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const originalUomMap = await buildRequirementOriginalUomMap(tx, requirements);

  return orders.map((order) => {
    const requirement = requirementByKey.get(buildPlannedOrderRequirementKey(order));
    const originalUomCode = requirement ? originalUomMap.get(requirement.id) || null : null;
    const qtyPcs = order.orderType === "Production"
      ? (requirement ? Number(requirement.plannedOrderQty || 0) : null)
      : (isPcsUom(order.uomCode) ? Number(order.qty || 0) : null);
    const originalQty = Number(qtyPcs ?? order.qty ?? 0);
    const ownPart =
      productionConversionPartMap.get(order.partId) ||
      productionConversionPartMap.get(normalizePartCode(order.partCode)) ||
      null;
    const ownKgPerQty = resolveKgPerPcs(ownPart).factor;
    const storedOrderQtyKg = isKgUom(order.uomCode)
      ? Number(order.qty || 0)
      : null;
    const qtyKg = storedOrderQtyKg != null
      ? storedOrderQtyKg
      : order.orderType === "Production" && isKgUom(originalUomCode)
        ? originalQty
        : ownKgPerQty
          ? roundPlanningQty(originalQty * Number(ownKgPerQty || 0))
      : order.orderType === "Production"
        ? productionRequirementKgMap.get(requirement?.id) ||
          productionRequirementKgMap.get(requirement?.partId) ||
          productionRequirementKgMap.get(normalizePartCode(requirement?.partCode || order.partCode)) ||
          null
        : null;
    const displayQty = order.orderType === "Production" && qtyPcs != null
      ? qtyPcs
      : Number(order.qty || 0);
    const displayUomCode = order.orderType === "Production" && qtyPcs != null
      ? originalUomCode || order.uomCode
      : order.uomCode;

    return {
      ...order,
      qty: displayQty,
      uomCode: displayUomCode,
      qtyPcs,
      qtyKg,
      mrpRequirementId: requirement?.id ?? null,
      mrpRequirementParentId: requirement?.parentRequirementId ?? null,
      mrpRequirementRootId: requirement?.rootRequirementId ?? null,
      mrpRequirementTreePath: requirement?.treePath ?? null,
      mrpRequirementLevelMBOM: requirement?.levelMBOM ?? null,
      mbomLevelComponent: requirement?.mbomLevelComponent ?? null,
      mbomDetailId: requirement?.mbomDetailId ?? null,
      mrpRequirementType: requirement?.requirementType ?? null,
      mrpRequirementSourceType: requirement?.sourceType ?? null,
    };
  });
}

async function enrichRequirementQtyBreakdown(tx, requirements = []) {
  if (!Array.isArray(requirements) || requirements.length === 0) return requirements;

  const runNumbers = [...new Set(requirements.map((row) => row.runNumber).filter(Boolean))];
  const plannedOrderKgByRequirementKey = new Map();
  if (runNumbers.length > 0) {
    const plannedOrders = await tx.plannedOrder.findMany({
      where: {
        runNumber: { in: runNumbers },
        isDeleted: false,
      },
      select: {
        runNumber: true,
        partCode: true,
        requiredDate: true,
        orderDate: true,
        qty: true,
        uomCode: true,
      },
    });

    for (const order of plannedOrders) {
      if (!isKgUom(order.uomCode)) continue;
      plannedOrderKgByRequirementKey.set(
        buildPlannedOrderRequirementKey(order),
        Number(order.qty || 0),
      );
    }
  }

  const productionConversionPartMap = await buildProductionConversionPartMap(tx, requirements);
  const productionMbomKgPerPcsMap = await buildProductionMbomKgPerPcsMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const productionRequirementKgMap = await buildProductionRequirementKgMap(
    tx,
    requirements,
    productionConversionPartMap,
  );
  const originalUomMap = await buildRequirementOriginalUomMap(tx, requirements);

  return requirements.map((requirement) => {
    const plannedOrderQty = Number(requirement.plannedOrderQty || 0);
    const grossRequirement = Number(requirement.grossRequirement || 0);
    const onHandQty = Number(requirement.onHandQty || 0);
    const netRequirement = Number(requirement.netRequirement || 0);
    const scheduledSupplyQty = Math.max(
      roundPlanningQty(grossRequirement - onHandQty - netRequirement),
      0,
    );
    const isProduction = requirement.orderType === "Production" || requirement.levelMBOM === 0;
    const part =
      productionConversionPartMap.get(requirement.partId) ||
      productionConversionPartMap.get(normalizePartCode(requirement.partCode)) ||
      null;
    const rawMaterial = isRawMaterialPart(requirement.part || part);
    const detailKgPerQty = Number(requirement.mbomDetail?.grossWeight || 0);
    const rawMaterialKgPerQty = rawMaterial
      ? (detailKgPerQty > 0 ? detailKgPerQty : resolveKgPerPcs(part).factor)
      : null;
    const originalUomCode = requirement.uomCode || originalUomMap.get(requirement.id) || null;
    const uomCode = rawMaterial && (rawMaterialKgPerQty || isKgUom(originalUomCode))
      ? "kg"
      : originalUomCode;
    let plannedOrderQtyKg = null;

    if (plannedOrderQty > 0) {
      if (isKgUom(originalUomCode)) {
        plannedOrderQtyKg = plannedOrderQty;
      }
      plannedOrderQtyKg =
        plannedOrderQtyKg ??
        plannedOrderKgByRequirementKey.get(buildPlannedOrderRequirementKey(requirement)) ??
        null;
      const ownKgPerQty = rawMaterial
        ? rawMaterialKgPerQty
        : isProduction
          ? resolveKgPerPcs(part).factor
          : null;
      if (plannedOrderQtyKg == null && ownKgPerQty) {
        plannedOrderQtyKg = roundPlanningQty(plannedOrderQty * Number(ownKgPerQty || 0));
      }
      if (plannedOrderQtyKg == null && isProduction && !isKgUom(uomCode)) {
        const conversion = resolveProductionPlannedOrderQuantity({
          qty: plannedOrderQty,
          sourceUomCode: uomCode,
          part,
          fallbackKgPerPcs:
            productionMbomKgPerPcsMap.get(requirement.partId) ||
            productionMbomKgPerPcsMap.get(normalizePartCode(requirement.partCode)),
        });
        plannedOrderQtyKg = isKgUom(conversion.uomCode)
          ? conversion.qty
          : productionRequirementKgMap.get(requirement.id) ||
            productionRequirementKgMap.get(requirement.partId) ||
            productionRequirementKgMap.get(normalizePartCode(requirement.partCode)) ||
            null;
      }
    }

    return {
      ...requirement,
      uomCode,
      scheduledSupplyQty,
      plannedOrderQtyKg,
    };
  });
}

function buildBufferStockNote(bufferPercent, bufferQty) {
  if (!bufferPercent || !bufferQty) return null;
  return `Buffer stock ${bufferPercent}% x forecast bulan berikutnya = ${bufferQty}`;
}

function planningMonthKey(value) {
  const parsed = parseDate(value);
  if (!parsed) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function nextPlanningMonthKey(value) {
  const parsed = parseDate(value);
  if (!parsed) return "";
  return planningMonthKey(new Date(parsed.getFullYear(), parsed.getMonth() + 1, 1));
}

function buildMpsDemandContextMap(mpsDetails = []) {
  return new Map(
    mpsDetails.map((row) => [
      row.id,
      {
        customerCode: normalizePartCode(row.customerCode) || "Tanpa Customer",
        planPartCode: normalizePartCode(row.partCode) || "Tanpa Part",
        requiredDate: row.endDate || row.startDate,
      },
    ]),
  );
}

function applyNextMonthPurchaseBuffer(requirements = [], options = {}) {
  const purchaseRequirements = requirements.filter((row) => row.orderType === "Purchase");
  const contextByMpsDetailId = buildMpsDemandContextMap(options.mpsDetails || []);
  const groups = new Map();

  for (const row of purchaseRequirements) {
    const context = contextByMpsDetailId.get(row.mpsDetailId) || {
      customerCode: row.sourceType === "SO" ? row.sourceNumber || "SO" : "Tanpa Customer",
      planPartCode: row.sourceType === "SO" ? row.partCode : "Tanpa Part",
      requiredDate: row.requiredDate,
    };
    const month = planningMonthKey(context.requiredDate || row.requiredDate);
    const baseKey = [
      normalizePartCode(row.partCode),
      context.customerCode,
      context.planPartCode,
    ].join("|");
    const key = `${baseKey}|${month}`;
    if (!groups.has(key)) {
      groups.set(key, { baseKey, month, requiredDate: context.requiredDate || row.requiredDate, rows: [], baseQty: 0 });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.baseQty += Number(row.effectiveDemandQty || 0);
  }

  for (const group of groups.values()) {
    const nextGroup = groups.get(`${group.baseKey}|${nextPlanningMonthKey(group.requiredDate)}`);
    const nextMonthDemandQty = Number(nextGroup?.baseQty || 0);
    const groupBaseQty = Number(group.baseQty || 0);
    for (const [index, row] of group.rows.entries()) {
      const rowBaseQty = Number(row.effectiveDemandQty || 0);
      const allocation = groupBaseQty > 0
        ? nextMonthDemandQty * (rowBaseQty / groupBaseQty)
        : index === 0
          ? nextMonthDemandQty
          : 0;
      const bufferBaseQty = roundPlanningQty(allocation);
      const bufferPercent = resolveBufferPercent({ bufferStock: row._partBufferPercent });
      const bufferQty = roundPlanningQty((bufferBaseQty * bufferPercent) / 100);
      row.bufferBaseQty = bufferBaseQty;
      row.bufferPercent = bufferPercent;
      row.bufferQty = bufferQty;
      row.bufferOverridden = false;
      row.grossRequirement = roundPlanningQty(rowBaseQty + bufferQty);
      row.notes = buildBufferStockNote(bufferPercent, bufferQty);
    }
  }

  const rowsByPart = new Map();
  for (const row of purchaseRequirements) {
    const partCode = normalizePartCode(row.partCode);
    if (!rowsByPart.has(partCode)) rowsByPart.set(partCode, []);
    rowsByPart.get(partCode).push(row);
  }

  for (const [partCode, rows] of rowsByPart.entries()) {
    let projectedAvailable = Number(options.initialAvailableMap?.[partCode] || 0);
    let projectedActual = Number(options.initialActualAvailableMap?.[partCode] || 0);
    const allocatedQty = Number(options.initialAllocatedMap?.[partCode] || 0);
    rows.sort((a, b) => new Date(a.requiredDate) - new Date(b.requiredDate) || String(a.treePath || "").localeCompare(String(b.treePath || "")));
    for (const row of rows) {
      row.onHandQty = projectedActual;
      row.allocatedQty = allocatedQty;
      row.netRequirement = roundPlanningQty(Math.max(Number(row.grossRequirement || 0) - projectedAvailable, 0));
      row.plannedOrderQty = row.netRequirement;
      row.orderPercent = Number(row.orderPercent ?? 100);
      row.adjustedOrderQty = row.netRequirement;
      projectedAvailable = Math.max(projectedAvailable - Number(row.grossRequirement || 0), 0);
      projectedActual = Math.max(projectedActual - Number(row.grossRequirement || 0), 0);
    }
  }

  return purchaseRequirements;
}

function stripRequirementInternals(requirements = []) {
  const persistedIds = new Set(requirements.map((row) => row.id));
  return requirements.map((row) => {
    const data = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));
    if (data.parentRequirementId && !persistedIds.has(data.parentRequirementId)) {
      data.parentRequirementId = null;
    }
    return data;
  });
}

async function syncProductionRequirementsToMps(tx, mps, requirements, mbomHeaderByPartCode, runNumber) {
  await tx.mPSDetail.updateMany({
    where: {
      mpsNumber: mps.mpsNumber,
      isDeleted: false,
      notes: { startsWith: GENERATED_MPS_CHILD_NOTE_PREFIX },
    },
    data: { isDeleted: true },
  });

  const sourceDetails = mps.details.filter(
    (row) => !String(row.notes || "").startsWith(GENERATED_MPS_CHILD_NOTE_PREFIX),
  );
  const sourceById = new Map(sourceDetails.map((row) => [row.id, row]));
  const groups = new Map();
  for (const row of requirements) {
    if (row.orderType !== "Production" || Number(row.levelMBOM || 0) <= 0) continue;
    // FG adalah output/receipt, bukan operation. Hanya WIP/SFG/child routable
    // yang boleh disinkronkan sebagai baris proses pada MPS.
    if (String(row._partItemType || "").trim().toUpperCase() === "FG") continue;
    const qtyPlanned = Number(row._productionScheduleQty || 0);
    if (qtyPlanned <= 0) continue;
    const source = sourceById.get(row.mpsDetailId);
    if (!source) continue;
    const key = [source.id, normalizePartCode(row.partCode), planningMonthKey(row.requiredDate)].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        source,
        partCode: row.partCode,
        partId: row.partId || null,
        qtyPlanned: 0,
        startDate: row.orderDate || source.startDate,
        endDate: row.requiredDate || source.endDate,
      });
    }
    const group = groups.get(key);
    group.qtyPlanned += qtyPlanned;
    if (new Date(row.orderDate) < new Date(group.startDate)) group.startDate = row.orderDate;
    if (new Date(row.requiredDate) > new Date(group.endDate)) group.endDate = row.requiredDate;
  }

  const generated = [...groups.values()];
  if (generated.length === 0) return 0;
  const firstGeneratedLine = sourceDetails.reduce((max, row) => Math.max(max, Number(row.lineNumber || 0)), 0) + 1;
  await tx.mPSDetail.createMany({
    data: generated.map((row, index) => ({
      mpsNumber: mps.mpsNumber,
      lineNumber: firstGeneratedLine + index,
      partCode: row.partCode,
      partId: row.partId,
      mbomHeaderId: mbomHeaderByPartCode[row.partCode] || null,
      // Child/SFG schedule inherits the planning context of its FG receipt.
      // This keeps buffer visible and traceable throughout the production tree.
      forecastQty: Number(row.source.forecastQty || 0),
      actualSalesOrderQty: Number(row.source.actualSalesOrderQty || 0),
      bufferBaseQty: Number(row.source.bufferBaseQty || 0),
      bufferPercent: Number(row.source.bufferPercent || 0),
      bufferQty: Number(row.source.bufferQty || 0),
      effectiveDemandQty: Number(row.source.effectiveDemandQty || 0),
      productionPercent: Number(row.source.productionPercent || 100),
      qtyPlanned: roundPlanningQty(row.qtyPlanned),
      startDate: row.startDate,
      endDate: row.endDate,
      priority: row.source.priority || 1,
      status: "Planned",
      customerCode: row.source.customerCode,
      forecastPeriodOffset: row.source.forecastPeriodOffset,
      notes: `${GENERATED_MPS_CHILD_NOTE_PREFIX} Generated from ${runNumber}; source ${row.source.partCode}; [MPS-SOURCE:${row.source.id}]`,
    })),
  });
  return generated.length;
}

function enrichRequirementPlanningGroups(requirements = []) {
  const byId = new Map(requirements.map((row) => [row.id, row]));
  return requirements.map((row) => {
    const root = Number(row.levelMBOM || 0) === 0
      ? row
      : byId.get(row.rootRequirementId) || byId.get(row.parentRequirementId) || row;
    const mpsDetail = row.mpsDetail || root.mpsDetail || null;
    return {
      ...row,
      planningCustomerCode: mpsDetail?.customerCode || "Tanpa Customer",
      planningMonth: mpsDetail?.startDate || mpsDetail?.endDate || row.requiredDate,
      planningPartCode: root.partCode || mpsDetail?.partCode || row.partCode,
      planningPartNumber: root.part?.partNumber || row.part?.partNumber || null,
      planningPartName: root.part?.partName || row.part?.partName || null,
      planningPartItemType: root.part?.itemType || row.part?.itemType || null,
    };
  });
}

function resolvePlanningPolicy(part) {
  return part?.planningPolicy === "MTS" ? "MTS" : "MTO";
}

function resolveIndependentDemandQty(forecastQty, soQty, part) {
  const normalizedForecastQty = Number(forecastQty || 0);
  const normalizedSoQty = Number(soQty || 0);
  // PPIC plan tetap berbasis Forecast (+ buffer). SO aktual adalah floor,
  // sehingga plan tidak boleh turun di bawah order customer yang sudah masuk.
  return Math.max(normalizedForecastQty, normalizedSoQty);
}

function upsertSupplyQty(map, partCode, qty) {
  const code = normalizePartCode(partCode);
  if (!code) return;
  const safeQty = Number(qty || 0);
  if (safeQty <= 0) return;
  map[code] = Number(map[code] || 0) + safeQty;
}

function mergeQtyMaps(...maps) {
  const merged = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [partCode, qty] of Object.entries(m)) {
      upsertSupplyQty(merged, partCode, qty);
    }
  }
  return merged;
}

function resolveOpenManufacturingSupplyQty(mo) {
  const plannedQty = Number(mo?.qtyPlanned || 0);
  if (plannedQty <= 0) return 0;

  // Fulfillment MO is based on the MO header. Historical rows may only
  // have qtyProduced populated, so keep it as a fallback signal.
  const fulfilledQty = Math.max(
    Number(mo?.qtyGood || 0),
    Number(mo?.qtyProduced || 0),
  );
  const rejectedQty = Number(mo?.qtyReject || 0);

  return Math.max(plannedQty - fulfilledQty - rejectedQty, 0);
}

function resolveFirmExecutionSupplyQty(row) {
  const plannedQty = Number(row?.plannedQty ?? row?.qtyPlanned ?? 0);
  if (plannedQty <= 0) return 0;

  // WO/VPO routing is already a firm execution plan for dependent inHouse/Vendor
  // MBOM rows. Count the planned quantity as coverage so rerunning MRP does not
  // create duplicate child PMO after the FG/root MO has been released.
  return plannedQty;
}

function isValidLinkedPrSupply(detail, plannedOrderByNumber = new Map()) {
  if (!detail?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(detail.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (detail.createdAt && plannedOrder.createdAt && new Date(detail.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function isValidLinkedMppSupply(detail, plannedOrderByNumber = new Map()) {
  if (!detail?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(detail.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Monthly Planned", "Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (detail.createdAt && plannedOrder.createdAt && new Date(detail.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function isValidLinkedMoSupply(mo, plannedOrderByNumber = new Map()) {
  if (!mo?.plannedOrderNumber) return true;
  const plannedOrder = plannedOrderByNumber.get(mo.plannedOrderNumber);
  if (!plannedOrder) return false;
  if (!["Partially Released", "Released"].includes(plannedOrder.status)) return false;
  if (mo.createdAt && plannedOrder.createdAt && new Date(mo.createdAt) < new Date(plannedOrder.createdAt)) {
    return false;
  }
  return true;
}

function buildNettingRunSummary(soDemandConsumptionSummary) {
  return {
    totalConsumedQty: Number(soDemandConsumptionSummary.totalConsumedQty || 0),
    impactedMpsLines: Number(soDemandConsumptionSummary.impactedMpsLines || 0),
    byPart: Object.entries(soDemandConsumptionSummary.byPart || {}).map(
      ([partCode, value]) => ({
        partCode,
        consumedQty: Number(value?.consumedQty || 0),
        sources: [...new Set(value?.sources || [])],
      }),
    ),
  };
}

function normalizeNettingSummary(summary) {
  const normalized = {
    totalConsumedQty: Number(summary?.totalConsumedQty || 0),
    impactedMpsLines: Number(summary?.impactedMpsLines || 0),
    byPart: {},
  };

  if (Array.isArray(summary?.byPart)) {
    for (const row of summary.byPart) {
      if (!row?.partCode) continue;
      normalized.byPart[row.partCode] = {
        consumedQty: Number(row.consumedQty || 0),
        sources: Array.isArray(row.sources) ? row.sources : [],
      };
    }
  } else if (summary?.byPart && typeof summary.byPart === "object") {
    for (const [partCode, value] of Object.entries(summary.byPart)) {
      normalized.byPart[partCode] = {
        consumedQty: Number(value?.consumedQty || 0),
        sources: Array.isArray(value?.sources) ? value.sources : [],
      };
    }
  }

  return normalized;
}

function parseLegacyNettingSummary(notes) {
  if (!notes || !notes.includes("NETTING_SUMMARY=")) return null;
  try {
    const jsonText = notes.slice(notes.indexOf("NETTING_SUMMARY=") + "NETTING_SUMMARY=".length);
    return JSON.parse(jsonText);
  } catch (parseErr) {
    console.warn(`[MRP Audit] Failed to parse legacy netting summary: ${parseErr.message}`);
    return null;
  }
}

function isWithinSoDemandTimeFence(targetDate, fenceConfig = {}) {
  const fenceDays = Math.max(Number(fenceConfig.days || 0), 0);
  const fenceHours = Math.max(Number(fenceConfig.hours || 0), 0);
  if (fenceDays <= 0 && fenceHours <= 0) return true;

  const dueDate = parseDate(targetDate);
  if (!dueDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fenceDate = new Date(today);
  fenceDate.setDate(fenceDate.getDate() + fenceDays);
  fenceDate.setHours(fenceDate.getHours() + fenceHours);
  return dueDate <= fenceDate;
}

async function buildPlannedOrderPartnerMap(tx, partCodes) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const parts = await tx.part.findMany({
    where: {
      partCode: { in: normalizedPartCodes },
      isDeleted: false,
    },
    select: {
      partCode: true,
      supplier: {
        select: {
          supplierCode: true,
        },
      },
      vendorPriceLists: {
        where: { isDeleted: false },
        orderBy: [{ pricingYear: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          vendor: {
            select: {
              vendorCode: true,
            },
          },
        },
      },
    },
  });

  return parts.reduce((acc, part) => {
    acc[part.partCode] = {
      supplierCode: part.supplier?.supplierCode || null,
      vendorCode: part.vendorPriceLists?.[0]?.vendor?.vendorCode || null,
    };
    return acc;
  }, {});
}

const OPEN_SO_HEADER_STATUSES = [
  "Confirmed",
  "In Progress",
  "In Production",
  "Ready to Deliver",
];

const OPEN_SO_DETAIL_STATUSES = [
  "Pending",
  "In Planning",
  "In Production",
];

async function buildOpenSoDemandByPart(tx, partCodes, cutoffDate) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];

  // Parse cutoff date - hanya fetch SO yang due date <= cutoff
  const whereDate = cutoffDate ? parseDate(cutoffDate) : null;
  if (cutoffDate && !whereDate) {
    // Invalid cutoff date
    console.warn(`[buildOpenSoDemandByPart] Invalid cutoffDate: ${cutoffDate}`);
    return {};
  }

  const soDetails = await tx.salesOrderDetail.findMany({
    where: {
      isDeleted: false,
      ...(normalizedPartCodes.length > 0 ? { partCode: { in: normalizedPartCodes } } : {}),
      status: { in: OPEN_SO_DETAIL_STATUSES },
      soHeader: {
        isDeleted: false,
        status: { in: OPEN_SO_HEADER_STATUSES },
      },
    },
    select: {
      soNumber: true,
      lineNumber: true,
      partCode: true,
      part: {
        select: { id: true },
      },
      uomCode: true,
      qty: true,
      qtyDelivered: true,
      deliveryDate: true,
      soHeader: {
        select: {
          soDate: true,
          deliveryDate: true,
        },
      },
    },
  });

  const demandByPart = {};

  for (const detail of soDetails) {
    const partCode = normalizePartCode(detail.partCode);
    if (!partCode) continue;

    const outstandingQty = Math.max(
      Number(detail.qty || 0) - Number(detail.qtyDelivered || 0),
      0,
    );
    if (outstandingQty <= 0) continue;

    const dueDate = parseDate(
      detail.deliveryDate || detail.soHeader?.deliveryDate || detail.soHeader?.soDate,
    );
    if (!dueDate) continue;
    if (whereDate && dueDate > whereDate) continue;

    if (!demandByPart[partCode]) {
      demandByPart[partCode] = [];
    }

    demandByPart[partCode].push({
      dueDate,
      remainingQty: outstandingQty,
      partId: detail.part?.id || null,
      uomCode: detail.uomCode || null,
      sourceNumber: `${detail.soNumber}#${detail.lineNumber}`,
    });
  }

  for (const bucket of Object.values(demandByPart)) {
    bucket.sort((a, b) => a.dueDate - b.dueDate);
  }

  return demandByPart;
}

function consumeSoDemandForPart(demandByPart, partCode, upToDate, targetQty, options = {}) {
  const code = normalizePartCode(partCode);
  const target = Number(targetQty || 0);
  if (!code || target <= 0) return { consumedQty: 0, sources: [] };

  const bucket = demandByPart[code] || [];
  if (bucket.length === 0) return { consumedQty: 0, sources: [] };

  const limitDate = upToDate ? parseDate(upToDate) : null;
  const canConsume = typeof options.canConsume === "function" ? options.canConsume : () => true;
  let remainingTarget = target;
  let consumedQty = 0;
  const sources = [];

  for (const row of bucket) {
    if (remainingTarget <= 0) break;
    if (row.remainingQty <= 0) continue;
    if (limitDate && row.dueDate > limitDate) continue;
    if (!canConsume(row)) continue;

    const used = Math.min(row.remainingQty, remainingTarget);
    if (used <= 0) continue;

    row.remainingQty -= used;
    remainingTarget -= used;
    consumedQty += used;
    sources.push(`${row.sourceNumber}:${used}`);
  }

  return { consumedQty, sources };
}

function parseSoConsumptionSource(source) {
  const match = String(source || "").match(/^(.*)#(\d+):([0-9.]+)$/);
  if (!match) return null;
  return {
    soNumber: match[1],
    lineNumber: Number(match[2]),
    qty: Number(match[3] || 0),
  };
}

async function resolveMbomLeadTimeDays(tx, mbomHeaderId) {
  if (!mbomHeaderId) return 0;

  const mbomHeader = await tx.mBOMHeader.findUnique({
    where: { id: mbomHeaderId },
    select: { noReg: true },
  });
  if (!mbomHeader?.noReg) return 0;

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
    },
    select: { leadTime: true, leadTimeUnit: true },
  });
  return details.reduce((maximum, detail) => Math.max(maximum, durationToWorkingDays(detail.leadTime, detail.leadTimeUnit)), 0);
}

function collectRemainingSoDemandRows(openSoDemandByPart) {
  const rows = [];
  for (const [partCode, bucket] of Object.entries(openSoDemandByPart || {})) {
    for (const demand of bucket || []) {
      const remainingQty = Number(demand.remainingQty || 0);
      if (remainingQty <= 0) continue;
      rows.push({
        ...demand,
        partCode,
        remainingQty,
      });
    }
  }
  rows.sort((a, b) => a.dueDate - b.dueDate);
  return rows;
}

function collectSoPlanNumbersFromDemand(openSoDemandByPart) {
  const planNumbers = [];
  for (const bucket of Object.values(openSoDemandByPart || {})) {
    for (const demand of bucket || []) {
      const soNumber = String(demand.sourceNumber || "").split("#")[0];
      const planNumber = buildSoPlanNumber(soNumber);
      if (planNumber) planNumbers.push(planNumber);
    }
  }
  return [...new Set(planNumbers)];
}

async function upsertMrpPegging(tx, data) {
  const toNullableInt = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const where = {
    demandType: data.demandType,
    demandNumber: data.demandNumber,
    demandLineNumber: toNullableInt(data.demandLineNumber),
    supplyType: data.supplyType,
    supplyNumber: data.supplyNumber,
    supplyLineNumber: toNullableInt(data.supplyLineNumber),
    itemId: data.itemId,
  };

  const updated = await tx.mRPPegging.updateMany({
    where,
    data: {
      qtyPegged: data.qtyPegged,
      status: "Active",
      notes: data.notes || null,
    },
  });

  if (updated.count === 0) {
    await tx.mRPPegging.create({
      data: {
        ...where,
        qtyPegged: data.qtyPegged,
        status: "Active",
        notes: data.notes || null,
      },
    });
  }
}

async function buildOpenSupplyMap(tx, partCodes, cutoffDate, options = {}) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? parseDate(cutoffDate) : null;
  const excludedRunNumbers = Array.isArray(options.excludeRunNumbers)
    ? options.excludeRunNumbers.filter(Boolean)
    : [];
  const excludedPlanNumbers = new Set(
    Array.isArray(options.excludePlanNumbers)
      ? options.excludePlanNumbers.filter(Boolean)
      : [],
  );
  const planningUomByPartCode = options.planningUomByPartCode || {};
  const kgPerQtyByPartCode = options.kgPerQtyByPartCode || {};

  const plannedOrderWhere = {
    partCode: { in: normalizedPartCodes },
    isDeleted: false,
    status: "Planned",
    NOT: { referenceType: "SO" },
  };
  if (whereDate) {
    plannedOrderWhere.requiredDate = { lte: whereDate };
  }
  if (excludedRunNumbers.length > 0) {
    plannedOrderWhere.AND = [{ NOT: { runNumber: { in: excludedRunNumbers } } }];
  }

  const plannedOrders = await tx.plannedOrder.findMany({
    where: plannedOrderWhere,
    select: {
      orderNumber: true,
      partCode: true,
      qty: true,
      uomCode: true,
      orderType: true,
      referenceNumber: true,
      mrpRun: {
        select: { planNumber: true },
      },
    },
  });

  // Hanya firm MO yang dihitung sebagai scheduled receipt untuk FG in-house.
  // Status Completed tidak otomatis berarti fulfilled; netting tetap pakai sisa qty header MO.
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      AND: [
        {
          OR: [
            { status: { in: ["Released", "In Progress", "Completed"] } },
            {
              status: "Draft",
              referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] },
            },
          ],
        },
        ...(whereDate
          ? [{ OR: [{ plannedEndDate: null }, { plannedEndDate: { lte: whereDate } }] }]
          : []),
      ],
      part: {
        partCode: { in: normalizedPartCodes },
      },
    },
    select: {
      moNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      part: {
        select: {
          partCode: true,
        },
      },
    },
  });

  const workOrders = await tx.workOrder.findMany({
    where: {
      isDeleted: false,
      isReworkOrder: false,
      status: { not: "Cancelled" },
      outputPartCode: { in: normalizedPartCodes },
      plannedQty: { gt: 0 },
      ...(whereDate ? { plannedDate: { lte: whereDate } } : {}),
    },
    select: {
      outputPartCode: true,
      plannedQty: true,
    },
  });

  const vendorProcessOrders = await tx.vendorProcessOrder.findMany({
    where: {
      isDeleted: false,
      isReworkOrder: false,
      status: { not: "Cancelled" },
      outputPartCode: { in: normalizedPartCodes },
      qtyPlanned: { gt: 0 },
      ...(whereDate
        ? {
            OR: [
              { dueDate: { lte: whereDate } },
              { dueDate: null, orderDate: { lte: whereDate } },
            ],
          }
        : {}),
    },
    select: {
      outputPartCode: true,
      qtyPlanned: true,
    },
  });
  // MPP hasil release planned order adalah firm production coverage sampai
  // qty-nya penuh dikonversi ke MO. Kalau tidak dihitung, MRP run ulang akan
  // membuat PMO baru untuk demand FG yang sama.
  const monthlyProductionPlanDetails = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      status: { in: ["Planned", "Partially Released"] },
      ...(whereDate
        ? {
            OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }],
          }
        : {}),
      plan: {
        isDeleted: false,
        status: { not: "Cancelled" },
      },
    },
    select: {
      partCode: true,
      qtyPlanned: true,
      qtyReleased: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  const purchaseRequisitionDetails = await tx.purchaseRequisitionDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      pr: {
        isDeleted: false,
        status: { not: "Rejected" },
        ...(whereDate ? { requiredDate: { lte: whereDate } } : {}),
      },
    },
    select: {
      partCode: true,
      qty: true,
      orderedQty: true,
      uomCode: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  // PO open qty dihitung dari qty order - qty received untuk dokumen yang sudah firm.
  const purchaseOrderDetails = await tx.purchaseOrderDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      po: {
        isDeleted: false,
        status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt"] },
        ...(whereDate ? { deliveryDate: { lte: whereDate } } : {}),
      },
    },
    select: {
      partCode: true,
      qty: true,
      qtyReceived: true,
      uomCode: true,
    },
  });

  const supplyPartCodes = [...new Set([
    ...purchaseRequisitionDetails.map((row) => normalizePartCode(row.partCode)),
    ...purchaseOrderDetails.map((row) => normalizePartCode(row.partCode)),
  ].filter(Boolean))];
  const supplyParts = supplyPartCodes.length > 0
    ? await tx.part.findMany({
      where: { partCode: { in: supplyPartCodes }, isDeleted: false },
      select: {
        partCode: true,
        partBases: {
          select: { baseOn: true, grossWeight: true },
        },
      },
    })
    : [];
  const supplyPartByCode = new Map(supplyParts.map((part) => [normalizePartCode(part.partCode), part]));

  const plannedOrderMap = {};
  for (const row of plannedOrders) {
    const planNumber = row.referenceNumber || row.mrpRun?.planNumber;
    if (planNumber && excludedPlanNumbers.has(planNumber)) continue;
    const partCode = normalizePartCode(row.partCode);
    upsertSupplyQty(plannedOrderMap, row.partCode, normalizePurchasingSupplyQty(row, {
      targetUomCode: planningUomByPartCode[partCode],
      kgPerQty: kgPerQtyByPartCode[partCode],
    }));
  }

  const moMap = {};
  for (const row of manufacturingOrders) {
    const remaining = resolveOpenManufacturingSupplyQty(row);
    upsertSupplyQty(moMap, row.part?.partCode, remaining);
  }

  const productionExecutionMap = {};
  for (const row of workOrders) {
    upsertSupplyQty(productionExecutionMap, row.outputPartCode, resolveFirmExecutionSupplyQty(row));
  }
  for (const row of vendorProcessOrders) {
    upsertSupplyQty(productionExecutionMap, row.outputPartCode, resolveFirmExecutionSupplyQty(row));
  }
  const mppMap = {};
  const mppPlannedOrderNumbers = [...new Set(monthlyProductionPlanDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const mppPlannedOrders = mppPlannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: mppPlannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const mppPlannedOrderByNumber = new Map(mppPlannedOrders.map((order) => [order.orderNumber, order]));

  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, mppPlannedOrderByNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertSupplyQty(mppMap, row.partCode, openQty);
  }

  const prMap = {};
  const prPlannedOrderNumbers = [...new Set(purchaseRequisitionDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const prPlannedOrders = prPlannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: prPlannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const prPlannedOrderByNumber = new Map(prPlannedOrders.map((order) => [order.orderNumber, order]));

  for (const row of purchaseRequisitionDetails) {
    if (!isValidLinkedPrSupply(row, prPlannedOrderByNumber)) continue;
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: Number(row.qty || 0) - Number(row.orderedQty || 0),
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }, {
        targetUomCode: planningUomByPartCode[normalizePartCode(row.partCode)],
        kgPerQty: kgPerQtyByPartCode[normalizePartCode(row.partCode)],
      }),
      0,
    );
    upsertSupplyQty(prMap, row.partCode, openQty);
  }

  const poMap = {};
  for (const row of purchaseOrderDetails) {
    const openQty = Math.max(
      normalizePurchasingSupplyQty({
        ...row,
        qty: Number(row.qty || 0) - Number(row.qtyReceived || 0),
        part: supplyPartByCode.get(normalizePartCode(row.partCode)),
      }, {
        targetUomCode: planningUomByPartCode[normalizePartCode(row.partCode)],
        kgPerQty: kgPerQtyByPartCode[normalizePartCode(row.partCode)],
      }),
      0,
    );
    upsertSupplyQty(poMap, row.partCode, openQty);
  }

  return mergeQtyMaps(plannedOrderMap, moMap, productionExecutionMap, mppMap, prMap, poMap);
}

async function buildOpenMppSupplyMap(tx, partCodes, cutoffDate) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const monthlyProductionPlanDetails = await tx.monthlyProductionPlanDetail.findMany({
    where: {
      isDeleted: false,
      partCode: { in: normalizedPartCodes },
      status: { in: ["Planned", "Partially Released"] },
      ...(whereDate
        ? {
            OR: [{ requiredDate: null }, { requiredDate: { lte: whereDate } }],
          }
        : {}),
      plan: {
        isDeleted: false,
        status: { not: "Cancelled" },
      },
    },
    select: {
      partCode: true,
      qtyPlanned: true,
      qtyReleased: true,
      plannedOrderNumber: true,
      createdAt: true,
    },
  });

  const plannedOrderNumbers = [...new Set(monthlyProductionPlanDetails
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const mppMap = {};
  for (const row of monthlyProductionPlanDetails) {
    if (!isValidLinkedMppSupply(row, plannedOrderByNumber)) continue;
    const openQty = Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReleased || 0), 0);
    upsertSupplyQty(mppMap, row.partCode, openQty);
  }
  return mppMap;
}

async function buildOpenMoSupplyMap(tx, partCodes, cutoffDate) {
  const normalizedPartCodes = [...new Set((partCodes || []).map(normalizePartCode).filter(Boolean))];
  if (normalizedPartCodes.length === 0) return {};

  const whereDate = cutoffDate ? new Date(cutoffDate) : null;
  const manufacturingOrders = await tx.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      AND: [
        {
          OR: [
            { status: { in: ["Released", "In Progress", "Completed"] } },
            {
              status: "Draft",
              referenceType: { in: ["MRPPlannedOrder", "MonthlyProductionPlan"] },
            },
          ],
        },
        ...(whereDate
          ? [{ OR: [{ plannedEndDate: null }, { plannedEndDate: { lte: whereDate } }] }]
          : []),
      ],
      part: {
        partCode: { in: normalizedPartCodes },
      },
    },
    select: {
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      qtyReject: true,
      plannedOrderNumber: true,
      createdAt: true,
      part: {
        select: {
          partCode: true,
        },
      },
    },
  });

  const plannedOrderNumbers = [...new Set(manufacturingOrders
    .map((row) => row.plannedOrderNumber)
    .filter(Boolean))];
  const plannedOrders = plannedOrderNumbers.length > 0
    ? await tx.plannedOrder.findMany({
      where: {
        orderNumber: { in: plannedOrderNumbers },
        isDeleted: false,
      },
      select: { orderNumber: true, status: true, createdAt: true },
    })
    : [];
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));

  const moMap = {};
  for (const row of manufacturingOrders) {
    if (!isValidLinkedMoSupply(row, plannedOrderByNumber)) continue;
    upsertSupplyQty(moMap, row.part?.partCode, resolveOpenManufacturingSupplyQty(row));
  }
  return moMap;
}

// ============================================
// GENERATE RUN NUMBER
// ============================================
exports.generateNumber = async (req, res, next) => {
  try {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

    const lastRun = await prisma.mRPRun.findFirst({
      where: {
        runNumber: { startsWith: `MRP-${dateStr}-` },
      },
      orderBy: { runNumber: "desc" },
      select: { runNumber: true },
    });

    let nextSeq = 1;
    if (lastRun) {
      const match = lastRun.runNumber.match(/-(\d+)$/);
      if (match) {
        nextSeq = parseInt(match[1]) + 1;
      }
    }

    const runNumber = `MRP-${dateStr}-${String(nextSeq).padStart(3, "0")}`;
    res.json({ runNumber });
  } catch (e) {
    next(e);
  }
};

// ============================================
// LIST MRP RUNS
// ============================================
exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      status,
      mpsNumber,
      includeRevisions,
      isCurrentPlan,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = req.query;
    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (isCurrentPlan !== undefined) {
      where.isCurrentPlan = isCurrentPlan === "true";
    } else if (includeRevisions !== "true") {
      where.isCurrentPlan = true;
    }

    if (mpsNumber) {
      where.mpsNumber = mpsNumber;
    }

    if (dateFrom || dateTo) {
      where.runDate = {};
      if (dateFrom) where.runDate.gte = parseDate(dateFrom);
      if (dateTo) where.runDate.lte = parseDate(dateTo);
    }

    if (q) {
      where.OR = [
        { runNumber: { contains: q, mode: "insensitive" } },
        { planNumber: { contains: q, mode: "insensitive" } },
        { mpsNumber: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query) || { runDate: "desc" };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mRPRun.findMany({
        where,
        include: {
          mps: {
            select: {
              mpsNumber: true,
              mpsName: true,
              periodStart: true,
              periodEnd: true,
            },
          },
          _count: {
            select: {
              requirements: true,
              plannedOrders: true,
            },
          },
        },
        orderBy,
        skip,
        take: Number(limit),
      }),
      prisma.mRPRun.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET MRP RUN BY NUMBER
// ============================================
exports.get = async (req, res, next) => {
  try {
    const { runNumber } = req.params;

    const mrpRun = await findRunByNumberOrCurrentPlan(runNumber, {
        mps: true,
        requirements: {
          where: { isDeleted: false, orderType: "Purchase" },
          orderBy: [{ levelMBOM: "asc" }, { requiredDate: "asc" }],
          include: {
            part: {
              select: {
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                rawType: true,
                material: { select: { materialCode: true, materialName: true } },
              },
            },
            mbomDetail: { select: { uomCode: true, grossWeight: true, category: true } },
            mpsDetail: { select: { partCode: true, customerCode: true, startDate: true, endDate: true } },
          },
        },
        plannedOrders: {
          where: { isDeleted: false, orderType: "Purchase" },
          orderBy: [{ orderDate: "asc" }],
        },
    });

    if (!mrpRun) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const requirementsWithQtyBreakdown = await enrichRequirementQtyBreakdown(
      prisma,
      mrpRun.requirements,
    );
    const requirementsWithSupplyBreakdown = await enrichRequirementSupplyBreakdown(
      prisma,
      requirementsWithQtyBreakdown,
    );
    const groupedRequirements = enrichRequirementPlanningGroups(requirementsWithSupplyBreakdown);
    const plannedOrdersWithQtyBreakdown = await enrichPlannedOrderQtyBreakdown(
      prisma,
      mrpRun.plannedOrders,
    );
    const enrichedPlannedOrders = await enrichPlannedOrderDisplay(
      prisma,
      plannedOrdersWithQtyBreakdown,
    );
    const releasedOrderNumbers = enrichedPlannedOrders.map((row) => row.orderNumber).filter(Boolean);
    const prLinks = releasedOrderNumbers.length ? await prisma.purchaseRequisitionDetail.findMany({
      where: { plannedOrderNumber: { in: releasedOrderNumbers }, isDeleted: false, pr: { isDeleted: false } },
      select: { plannedOrderNumber: true, prNumber: true, pr: { select: { status: true } } },
    }) : [];
    const prByPlannedOrder = new Map(prLinks.map((row) => [row.plannedOrderNumber, { prNumber: row.prNumber, status: row.pr.status }]));
    res.json(mapDoc({
      ...mrpRun,
      requirements: groupedRequirements,
      plannedOrders: enrichedPlannedOrders.map((row) => ({ ...row, purchaseRequest: prByPlannedOrder.get(row.orderNumber) || null })),
    }));
  } catch (e) {
    next(e);
  }
};

// ============================================
// GET MRP AUDIT - DEMAND NETTING DETAILS
// ============================================
exports.getAudit = async (req, res, next) => {
  try {
    const { runNumber } = req.params;

    // Fetch MRP run with all details. Identifier may be runNumber or stable planNumber.
    const mrpRun = await findRunByNumberOrCurrentPlan(runNumber, {
        mps: {
          include: {
            details: {
              where: { isDeleted: false, status: { not: "Cancelled" } },
              include: {
                part: {
                  select: { partCode: true, partNumber: true, partName: true, planningPolicy: true },
                },
              },
            },
          },
        },
        requirements: {
          where: { isDeleted: false, levelMBOM: 0 }, // Only independent requirements (FG)
          orderBy: [{ requiredDate: "asc" }],
        },
        plannedOrders: {
          where: { isDeleted: false },
          orderBy: [{ orderDate: "asc" }],
        },
    });

    if (!mrpRun) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const nettingSummary = normalizeNettingSummary(
      mrpRun.nettingSummary || parseLegacyNettingSummary(mrpRun.notes),
    );

    // Build detailed audit with MPS-level netting breakdown
    const mpsAudit = (mrpRun.mps?.details || []).map((mpsDetail) => {
      const requirement = mrpRun.requirements.find((r) => r.partCode === mpsDetail.partCode);
      const plannedOrder = mrpRun.plannedOrders.find((po) => po.partCode === mpsDetail.partCode);
      const nettingDetail = nettingSummary.byPart[mpsDetail.partCode] || { consumedQty: 0, sources: [] };

      return {
        mpsLineNumber: mpsDetail.lineNumber,
        partCode: mpsDetail.partCode,
        partNumber: mpsDetail.part?.partNumber || null,
        partName: mpsDetail.part?.partName || null,
        planningPolicy: resolvePlanningPolicy(mpsDetail.part),
        mpsQtyPlanned: Number(mpsDetail.qtyPlanned || 0),
        // Netting breakdown
        soConsumedQty: Number(requirement?.soConsumedQty ?? nettingDetail.consumedQty ?? 0),
        soSources: requirement?.consumptionSources || nettingDetail.sources || [],
        effectiveGrossQty: Number(
          requirement?.effectiveDemandQty ??
          resolveIndependentDemandQty(
            Number(mpsDetail.qtyPlanned || 0),
            Number(nettingDetail.consumedQty || 0),
            mpsDetail.part,
          ),
        ),
        // Resulting net requirement
        netRequirementQty: requirement
          ? Math.max(Number(requirement.grossRequirement || 0) - Number(requirement.onHandQty || 0), 0)
          : 0,
        // Planned order generated
        plannedOrderQty: plannedOrder ? Number(plannedOrder.qty || 0) : 0,
        plannedOrderNumber: plannedOrder?.orderNumber || null,
        // Audit check: verify netting math
        auditCheck: {
          expectedNetQty: requirement
            ? Math.max(
              Number(requirement.effectiveDemandQty || requirement.grossRequirement || 0) -
                Number(requirement.onHandQty || 0),
              0,
            )
            : resolveIndependentDemandQty(
              Number(mpsDetail.qtyPlanned || 0),
              Number(nettingDetail.consumedQty || 0),
              mpsDetail.part,
            ),
          actualPlannedQty: plannedOrder ? Number(plannedOrder.qty || 0) : 0,
          nettingApplied: Number(requirement?.soConsumedQty ?? nettingDetail.consumedQty ?? 0) > 0,
        },
      };
    });

    res.json({
      runNumber: mrpRun.runNumber,
      runDate: mrpRun.runDate,
      status: mrpRun.status,
      mpsNumber: mrpRun.mpsNumber,
      planHorizon: mrpRun.planHorizon,
      cutoffDate: mrpRun.cutoffDate,
      executionTime: mrpRun.executionTime,
      // Summary counts
      summaryMetrics: {
        totalMpsLines: mpsAudit.length,
        totalRequirements: mrpRun.totalRequirements || 0,
        totalPlannedOrders: mrpRun.totalPlannedOrders || 0,
        soDemandsConsumed: Number(mrpRun.soDemandConsumedQty ?? nettingSummary.totalConsumedQty ?? 0),
        impactedMpsLines: Number(mrpRun.soDemandImpactedLines ?? nettingSummary.impactedMpsLines ?? 0),
      },
      // Detailed MPS-level netting breakdown
      mpsLevelAudit: mpsAudit,
      // Overall netting summary
      nettingSummary,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// RUN MRP CALCULATION
// ============================================
exports.runMRP = async (req, res, next) => {
  try {
    const { runNumber, mpsNumber, planHorizon, cutoffDate, soDemandPartCodes } = req.body;
    const startTime = Date.now();

    const mpsPrecheck = await prisma.mPS.findUnique({
      where: { mpsNumber },
      select: {
        mpsNumber: true,
        status: true,
        isDeleted: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!mpsPrecheck || mpsPrecheck.isDeleted) {
      return res.status(404).json({ message: "MPS tidak ditemukan" });
    }

    if (!["Confirmed", "Released"].includes(mpsPrecheck.status)) {
      return res.status(409).json({
        message: `MPS harus berstatus Confirmed/Released sebelum run MRP (saat ini: ${mpsPrecheck.status})`,
      });
    }

    const existingRunning = await prisma.mRPRun.findFirst({
      where: {
        mpsNumber,
        isDeleted: false,
        status: "Running",
      },
      select: { runNumber: true },
    });

    if (existingRunning) {
      return res.status(409).json({
        message: `MRP untuk MPS ${mpsNumber} sedang berjalan di run ${existingRunning.runNumber}. Tunggu selesai lalu coba lagi.`,
      });
    }

    const resolvedPlanHorizon = resolvePlanHorizonDays(
      planHorizon,
      mpsPrecheck.periodStart,
      mpsPrecheck.periodEnd,
    );

    // Calculate cutoffDate: use provided date, or default to MPS periodEnd
    let resolvedCutoffDate = parseDate(cutoffDate);
    if (!resolvedCutoffDate) {
      // Default to MPS periodEnd or today + planHorizon days
      if (mpsPrecheck.periodEnd) {
        resolvedCutoffDate = new Date(mpsPrecheck.periodEnd);
      } else {
        resolvedCutoffDate = new Date();
        resolvedCutoffDate.setDate(resolvedCutoffDate.getDate() + resolvedPlanHorizon);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const planIdentity = await resolvePlanIdentity(tx, {
        mpsNumber,
        planScope: "MPS",
      });
      await retirePreviousPlanRevisions(tx, planIdentity.planNumber, runNumber);

      // Create MRP Run header
      const mrpRun = await tx.mRPRun.create({
        data: {
          runNumber,
          ...planIdentity,
          planHorizon: resolvedPlanHorizon,
          cutoffDate: resolvedCutoffDate,
          status: "Running",
          runBy: req.user?.username || "system",
          mps: {
            connect: {
              mpsNumber,
            },
          },
        },
      });
      emitPlanningMrpRunUpdate(mrpRun, "start", req.user?.username || "system");

      try {
        // Get MPS details (include part untuk bisa ambil partId)
        const mps = await tx.mPS.findUnique({
          where: { mpsNumber },
          include: {
            details: {
              where: { isDeleted: false, status: { not: "Cancelled" } },
              orderBy: { endDate: "asc" },
              include: {
                part: { select: { id: true, itemType: true, bufferStock: true, planningPolicy: true } },
                mbom: { select: { uomCode: true } },
                forecastDetail: { select: { uomCode: true } },
              },
            },
          },
        });

        if (!mps) {
          throw new Error("MPS tidak ditemukan");
        }

        // Child production rows hasil MRP ditampilkan di MPS, tetapi bukan demand
        // baru. Hanya row sumber forecast/SO yang boleh diexplode pada run berikutnya.
        const sourceMpsDetails = mps.details.filter(
          (row) => !String(row.notes || "").startsWith(GENERATED_MPS_CHILD_NOTE_PREFIX),
        );

        const runningRun = await tx.mRPRun.findFirst({
          where: {
            mpsNumber,
            isDeleted: false,
            status: "Running",
            runNumber: { not: runNumber },
          },
          select: { runNumber: true },
        });

        if (runningRun) {
          throw new Error(
            `MRP untuk MPS ${mpsNumber} sedang berjalan di run ${runningRun.runNumber}. Tunggu selesai lalu coba lagi.`,
          );
        }

        if (!["Confirmed", "Released"].includes(mps.status)) {
          throw new Error(
            `MPS harus berstatus Confirmed/Released sebelum run MRP (saat ini: ${mps.status})`,
          );
        }

        await supersedePreviousMrpArtifacts(
          tx,
          mpsNumber,
          runNumber,
          req.user?.username || "system",
        );

        const requirements = [];
        const plannedOrders = [];
        const dependentProjectedAvailableMap = {};
        const dependentProjectedActualAvailableMap = {};
        const dependentProjectedAllocatedMap = {};
        const dependentProjectedMoSupplyMap = {};
        const purchaseInitialAvailableMap = {};
        const purchaseInitialActualAvailableMap = {};
        const purchaseInitialAllocatedMap = {};
        const mbomHeaderByPartCode = {};
        const uomCodeByPartCode = {};
        const soSourcesByRequirement = new Map();
        const affectedSoNumbers = new Set();
        const soDemandConsumptionSummary = {
          totalConsumedQty: 0,
          impactedMpsLines: 0,
          byPart: {},
        };
        const soDemandTimeFence = await getSoDemandTimeFenceSetting(tx);

        const mpsPartCodes = [
          ...new Set(sourceMpsDetails.map((detail) => detail.partCode).map(normalizePartCode).filter(Boolean)),
        ];
        const requestedSoDemandPartCodes = Array.isArray(soDemandPartCodes)
          ? [...new Set(soDemandPartCodes.map(normalizePartCode).filter(Boolean))]
          : [];
        const scopedSoDemandPartCodes = requestedSoDemandPartCodes.length > 0
          ? requestedSoDemandPartCodes.filter((partCode) => mpsPartCodes.includes(partCode))
          : mpsPartCodes;

        // Best practice ERP: SO aktual juga menjadi demand MRP.
        // Scope SO demand dibatasi ke part MPS yang sedang dirun.
        // Jadi SO part berbeda tidak ikut "numpang" ke MRP run MPS lain.
        const openSoDemandByPart = await buildOpenSoDemandByPart(
          tx,
          scopedSoDemandPartCodes,
          resolvedCutoffDate || mps.periodEnd,
        );
        const openSoDemandPartCodes = Object.keys(openSoDemandByPart);
        const soOnlyPlanNumbersInScope = collectSoPlanNumbersFromDemand(openSoDemandByPart);

        // Batch fetch semua stock balance sekaligus untuk hindari N+1
        const allPartCodes = [
            ...new Set([
              ...sourceMpsDetails.map((d) => d.partCode),
              ...openSoDemandPartCodes,
            ].map(normalizePartCode).filter(Boolean)),
        ];
        const stockBalances = await tx.stockBalance.findMany({
          where: {
            AND: [
              { partCode: { in: allPartCodes }, isDeleted: false },
              buildExcludeSpecialRackCondition(),
            ],
          },
          select: {
            partCode: true,
            stockType: true,
            uomCode: true,
            qtyOnHand: true,
            qtyReserved: true,
            qtyQC: true,
            qtyAvailable: true,
          },
        });
        const normalizedStockBalances = normalizePlanningStockRows(stockBalances);
        const stockPositionMaps = buildStockPositionMaps(normalizedStockBalances);

        // Netting scheduled receipts untuk menghindari double planned order.
        const supplyMap = await buildOpenSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
          {
            excludeRunNumbers: [runNumber],
            excludePlanNumbers: soOnlyPlanNumbersInScope,
          },
        );
        const projectedMppSupplyMap = await buildOpenMppSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
        );
        const projectedMoSupplyMap = await buildOpenMoSupplyMap(
          tx,
          allPartCodes,
          resolvedCutoffDate || mps.periodEnd,
        );

        // Gunakan projected stock per part agar demand antar-periode tidak selalu pakai stock awal yang sama.
        // Ini mencegah false net=0 ketika part yang sama muncul di beberapa baris MPS.
        const projectedAvailableMap = mergeQtyMaps(stockPositionMaps.available, supplyMap);
        const stockAllocatedMap = stockPositionMaps.allocated;

        // Debug log untuk audit
        const debugSoPartCodes = Object.keys(openSoDemandByPart);
        if (debugSoPartCodes.length > 0) {
          console.log(`[MRP ${runNumber}] SO demand parts detected: ${debugSoPartCodes.join(", ")}`);
        }

        // Process each MPS item (Level 0 - Finished Goods)
        for (const mpsDetail of sourceMpsDetails) {
          const fgPartCode = normalizePartCode(mpsDetail.partCode);
            const fgUomCode = mpsDetail.forecastDetail?.uomCode || mpsDetail.mbom?.uomCode || null;
            if (fgPartCode && fgUomCode) {
              uomCodeByPartCode[fgPartCode] = fgUomCode;
            }

          // Time fence mengikuti due date SO, bukan due date bucket MPS.
          // SO yang masih dalam fence boleh consume forecast/MPS terdekat untuk part yang sama.
          const soConsumption = consumeSoDemandForPart(
            openSoDemandByPart,
            mpsDetail.partCode,
            mpsDetail.endDate,
            Number.MAX_SAFE_INTEGER,
            {
              canConsume: (row) => isWithinSoDemandTimeFence(row.dueDate, soDemandTimeFence),
            },
          );

          if (soConsumption.consumedQty > 0) {
            const partCode = normalizePartCode(mpsDetail.partCode);
            for (const source of soConsumption.sources) {
              const parsed = parseSoConsumptionSource(source);
              if (parsed?.soNumber) affectedSoNumbers.add(parsed.soNumber);
            }

            soDemandConsumptionSummary.totalConsumedQty += Number(
              soConsumption.consumedQty || 0,
            );
            soDemandConsumptionSummary.impactedMpsLines += 1;

            if (!soDemandConsumptionSummary.byPart[partCode]) {
              soDemandConsumptionSummary.byPart[partCode] = {
                consumedQty: 0,
                sources: [],
              };
            }

            soDemandConsumptionSummary.byPart[partCode].consumedQty += Number(
              soConsumption.consumedQty || 0,
            );
            soDemandConsumptionSummary.byPart[partCode].sources.push(
              ...soConsumption.sources,
            );
          }

          // MPS menyimpan Forecast dan Buffer terpisah. MRP memakai demand
          // forecast+buffer sebagai baseline, tetapi tidak boleh lebih kecil dari SO aktual.
          const forecastQty = Number(mpsDetail.forecastQty ?? mpsDetail.qtyPlanned ?? 0);
          const forecastDemandWithBuffer = Number(mpsDetail.qtyPlanned ?? mpsDetail.effectiveDemandQty ?? forecastQty);
          const soQtyInBucket = Number(soConsumption.consumedQty || 0);
          if (Number(mpsDetail.actualSalesOrderQty || 0) !== soQtyInBucket) {
            await tx.mPSDetail.update({ where: { id: mpsDetail.id }, data: { actualSalesOrderQty: soQtyInBucket } });
          }

          // Pola consumption bergantung policy part:
          // MTO memakai forecast sebagai rencana awal sampai SO masuk; setelah ada SO,
          // qty produksi mengikuti SO aktual agar tidak over forecast.
          // MTS tetap memakai max(forecast, SO).
          const grossRequirementAfterSo = resolveIndependentDemandQty(
            forecastDemandWithBuffer,
            soQtyInBucket,
            mpsDetail.part,
          );

          // Hitung leadTime dari selisih startDate - endDate MPSDetail (dalam hari)
          const startDate = new Date(mpsDetail.startDate);
          const endDate = new Date(mpsDetail.endDate);
          const leadTimeDays = Math.max(
            Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)),
            0
          );

          // orderDate = tanggal produksi harus mulai (startDate dari MPS)
          const orderDate = startDate;
          const requirementIdentity = createRequirementIdentity();
          const requirementTreePath = buildRequirementTreePath(
            null,
            0,
            mpsDetail.lineNumber || requirements.length + 1,
          );

          // Create independent requirement from MPS
          const requirement = {
            ...requirementIdentity,
            runNumber,
            treePath: requirementTreePath,
            levelMBOM: 0,
            mbomLevelComponent: 0,
            mbomDetailId: null,
            partCode: mpsDetail.partCode,
            partId: mpsDetail.partId || mpsDetail.part?.id || null,
            requirementType: "Independent",
            sourceType: "MPS",
            sourceNumber: mpsNumber,
            // Traceability: dari MPSDetail mana requirement ini dibuat
            mpsDetailId: mpsDetail.id,
            requiredDate: mpsDetail.endDate,
            grossRequirement: grossRequirementAfterSo,
            forecastQty,
            soConsumedQty: soQtyInBucket,
            effectiveDemandQty: forecastDemandWithBuffer,
            bufferBaseQty: Number(mpsDetail.bufferBaseQty || 0),
            bufferPercent: Number(mpsDetail.bufferPercent || 0),
            bufferQty: Number(mpsDetail.bufferQty || 0),
            consumptionSources: soConsumption.sources,
            onHandQty: 0,
            allocatedQty: 0,
            netRequirement: 0,
            plannedOrderQty: 0,
            orderType: "Production",
            leadTime: leadTimeDays,
            orderDate,
            notes: null,
            _partBufferPercent: Number(mpsDetail.part?.bufferStock || 0),
            _productionScheduleQty: grossRequirementAfterSo,
          };

          const availableBefore = projectedAvailableMap[fgPartCode] || 0;
          const actualOnHandBefore = stockPositionMaps.available[fgPartCode] || 0;
          const allocatedQty = stockAllocatedMap[fgPartCode] || 0;
          requirement.onHandQty = actualOnHandBefore;
          requirement.allocatedQty = allocatedQty;
          requirement.netRequirement = Math.max(
            requirement.grossRequirement - availableBefore,
            0
          );
          requirement.plannedOrderQty = requirement.netRequirement;
          if (requirement.orderType === "Purchase" && purchaseInitialAvailableMap[fgPartCode] === undefined) {
            purchaseInitialAvailableMap[fgPartCode] = availableBefore;
            purchaseInitialActualAvailableMap[fgPartCode] = actualOnHandBefore;
            purchaseInitialAllocatedMap[fgPartCode] = allocatedQty;
          }
          const mppAvailableBefore = Number(projectedMppSupplyMap[fgPartCode] || 0);
          const moAvailableBefore = Number(projectedMoSupplyMap[fgPartCode] || 0);
          const nonProductionDriverAvailableBefore = Math.max(
            availableBefore - mppAvailableBefore - moAvailableBefore,
            0,
          );
          const mppDrivenQty = Math.min(
            mppAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore, 0),
          );
          const moDrivenQty = Math.min(
            moAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
          );
          const productionExplosionQty = requirement.plannedOrderQty + mppDrivenQty + moDrivenQty;

          // Kurangi projected stock dengan gross requirement pada bucket ini.
          projectedAvailableMap[fgPartCode] = Math.max(
            availableBefore - requirement.grossRequirement,
            0
          );
          projectedMppSupplyMap[fgPartCode] = Math.max(
            mppAvailableBefore - mppDrivenQty,
            0,
          );
          projectedMoSupplyMap[fgPartCode] = Math.max(
            moAvailableBefore - moDrivenQty,
            0,
          );

          // Simpan requirement level MPS walaupun net=0 agar demand tetap terlihat di UI.
          requirements.push(requirement);
          if (soConsumption.consumedQty > 0) {
            soSourcesByRequirement.set(requirement, soConsumption.sources);
          }

          if (productionExplosionQty > 0) {
            // Resolve mbomHeaderId: pakai yang ada di MPSDetail,
            // jika null → cari MBOM dari partId secara otomatis
            let mbomHeaderId = mpsDetail.mbomHeaderId || null;
            let resolvedMbomUomCode = mpsDetail.mbom?.uomCode || null;
            if (!mbomHeaderId && requirement.partId) {
              const foundBom = await findActiveMbomHeader(
                tx,
                requirement.partId,
                requirement.requiredDate,
              );
              mbomHeaderId = foundBom?.id || null;
              resolvedMbomUomCode = foundBom?.uomCode || resolvedMbomUomCode;
            }

            if (mbomHeaderId) {
              mbomHeaderByPartCode[mpsDetail.partCode] = mbomHeaderId;
              if (fgPartCode && !uomCodeByPartCode[fgPartCode] && resolvedMbomUomCode) {
                uomCodeByPartCode[fgPartCode] = resolvedMbomUomCode;
              }
            }

            // Explode MBOM untuk level berikutnya
            if (mbomHeaderId) {
              const visitedMBomIds = new Set([mbomHeaderId]); // guard circular reference
              const mbomExploded = await explodeMBOM(
                tx,
                runNumber,
                mbomHeaderId,
                productionExplosionQty,
                mpsDetail.endDate,
                1, // Start from level 1
                visitedMBomIds,
                dependentProjectedAvailableMap,
                dependentProjectedActualAvailableMap,
                dependentProjectedAllocatedMap,
                mbomHeaderByPartCode,
                uomCodeByPartCode,
                {
                  excludePlanNumbers: soOnlyPlanNumbersInScope,
                  projectedMoSupplyMap: dependentProjectedMoSupplyMap,
                  initialAvailableMap: purchaseInitialAvailableMap,
                  initialActualAvailableMap: purchaseInitialActualAvailableMap,
                  initialAllocatedMap: purchaseInitialAllocatedMap,
                parentBufferPercent: Number(mpsDetail.bufferPercent ?? mpsDetail.part?.bufferStock ?? 0),
                  forecastDemandQty: forecastDemandWithBuffer,
                  actualSalesOrderQty: Math.min(
                    Number(soQtyInBucket || 0),
                    Number(productionExplosionQty || 0),
                  ),
                  consumptionSources: soConsumption.sources,
                  mpsDetailId: mpsDetail.id,
                  parentRequirementId: requirement.id,
                  rootRequirementId: requirement.rootRequirementId,
                  parentTreePath: requirement.treePath,
                },
              );

              requirements.push(...mbomExploded.requirements);
            }
          }
        }

        // Sisa SO demand yang tidak tercakup MPS tetap harus masuk MRP.
        // Ini menjaga flow SO -> MRP -> PlannedOrder untuk part make-to-order.
        const remainingSoDemandRows = collectRemainingSoDemandRows(openSoDemandByPart);
        for (const [soDemandIndex, soDemand] of remainingSoDemandRows.entries()) {
          const fgPartCode = normalizePartCode(soDemand.partCode);
          if (!fgPartCode) continue;
          if (soDemand.uomCode && !uomCodeByPartCode[fgPartCode]) {
            uomCodeByPartCode[fgPartCode] = soDemand.uomCode;
          }

          let partId = soDemand.partId || null;
          let partBufferStock = 0;
          if (!partId) {
            const part = await tx.part.findUnique({
              where: { partCode: fgPartCode },
              select: { id: true, bufferStock: true },
            });
            partId = part?.id || null;
            partBufferStock = Number(part?.bufferStock || 0);
          } else {
            const part = await tx.part.findUnique({
              where: { id: partId },
              select: { bufferStock: true },
            });
            partBufferStock = Number(part?.bufferStock || 0);
          }

          let mbomHeaderId = null;
          let leadTimeDays = 0;
          if (partId) {
            const activeMbom = await findActiveMbomHeader(tx, partId, soDemand.dueDate);
            mbomHeaderId = activeMbom?.id || null;
            if (activeMbom?.uomCode && !uomCodeByPartCode[fgPartCode]) {
              uomCodeByPartCode[fgPartCode] = activeMbom.uomCode;
            }
            leadTimeDays = await resolveMbomLeadTimeDays(tx, mbomHeaderId);
          }

          if (mbomHeaderId) {
            mbomHeaderByPartCode[fgPartCode] = mbomHeaderId;
          }

          const orderDate = new Date(soDemand.dueDate);
          orderDate.setDate(orderDate.getDate() - leadTimeDays);
          const requirement = {
            ...createRequirementIdentity(),
            runNumber,
            treePath: buildRequirementTreePath(null, 0, soDemandIndex + 1),
            levelMBOM: 0,
            mbomLevelComponent: 0,
            mbomDetailId: null,
            partCode: fgPartCode,
            partId,
            requirementType: "Independent",
            sourceType: "SO",
            sourceNumber: soDemand.sourceNumber,
            mpsDetailId: null,
            requiredDate: soDemand.dueDate,
            grossRequirement: soDemand.remainingQty,
            forecastQty: 0,
            soConsumedQty: soDemand.remainingQty,
            effectiveDemandQty: soDemand.remainingQty,
            consumptionSources: [`${soDemand.sourceNumber}:${Number(soDemand.remainingQty || 0)}`],
            onHandQty: 0,
            allocatedQty: 0,
            netRequirement: 0,
            plannedOrderQty: 0,
            orderType: mbomHeaderId ? "Production" : "Purchase",
            leadTime: leadTimeDays,
            orderDate,
            notes: null,
            _partBufferPercent: partBufferStock,
            _productionScheduleQty: soDemand.remainingQty,
          };

          const availableBefore = projectedAvailableMap[fgPartCode] || 0;
          const actualOnHandBefore = stockPositionMaps.available[fgPartCode] || 0;
          const allocatedQty = stockAllocatedMap[fgPartCode] || 0;
          requirement.onHandQty = actualOnHandBefore;
          requirement.allocatedQty = allocatedQty;
          requirement.netRequirement = Math.max(
            requirement.grossRequirement - availableBefore,
            0,
          );
          requirement.plannedOrderQty = requirement.netRequirement;
          if (requirement.orderType === "Purchase" && purchaseInitialAvailableMap[fgPartCode] === undefined) {
            purchaseInitialAvailableMap[fgPartCode] = availableBefore;
            purchaseInitialActualAvailableMap[fgPartCode] = actualOnHandBefore;
            purchaseInitialAllocatedMap[fgPartCode] = allocatedQty;
          }
          const mppAvailableBefore = Number(projectedMppSupplyMap[fgPartCode] || 0);
          const moAvailableBefore = Number(projectedMoSupplyMap[fgPartCode] || 0);
          const nonProductionDriverAvailableBefore = Math.max(
            availableBefore - mppAvailableBefore - moAvailableBefore,
            0,
          );
          const mppDrivenQty = Math.min(
            mppAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore, 0),
          );
          const moDrivenQty = Math.min(
            moAvailableBefore,
            Math.max(requirement.grossRequirement - nonProductionDriverAvailableBefore - mppDrivenQty, 0),
          );
          const productionExplosionQty = requirement.plannedOrderQty + mppDrivenQty + moDrivenQty;

          projectedAvailableMap[fgPartCode] = Math.max(
            availableBefore - requirement.grossRequirement,
            0,
          );
          projectedMppSupplyMap[fgPartCode] = Math.max(
            mppAvailableBefore - mppDrivenQty,
            0,
          );
          projectedMoSupplyMap[fgPartCode] = Math.max(
            moAvailableBefore - moDrivenQty,
            0,
          );

          requirements.push(requirement);
          if (requirement.plannedOrderQty > 0) {
            soSourcesByRequirement.set(requirement, [
              `${soDemand.sourceNumber}:${requirement.plannedOrderQty}`,
            ]);
          }

          if (productionExplosionQty > 0 && mbomHeaderId) {
            const mbomExploded = await explodeMBOM(
              tx,
              runNumber,
              mbomHeaderId,
              productionExplosionQty,
              soDemand.dueDate,
              1,
              new Set([mbomHeaderId]),
              dependentProjectedAvailableMap,
              dependentProjectedActualAvailableMap,
              dependentProjectedAllocatedMap,
              mbomHeaderByPartCode,
              uomCodeByPartCode,
              {
                excludePlanNumbers: soOnlyPlanNumbersInScope,
                projectedMoSupplyMap: dependentProjectedMoSupplyMap,
                initialAvailableMap: purchaseInitialAvailableMap,
                initialActualAvailableMap: purchaseInitialActualAvailableMap,
                initialAllocatedMap: purchaseInitialAllocatedMap,
                parentBufferPercent: partBufferStock,
                forecastDemandQty: 0,
                actualSalesOrderQty: Math.min(
                  Number(soDemand.remainingQty || 0),
                  Number(productionExplosionQty || 0),
                ),
                consumptionSources: requirement.consumptionSources,
                parentRequirementId: requirement.id,
                rootRequirementId: requirement.rootRequirementId,
                parentTreePath: requirement.treePath,
              },
            );
            requirements.push(...mbomExploded.requirements);
          }
        }

        // Satu explosion menghasilkan dua output yang tegas:
        // - Production (FG/child process) disinkronkan ke MPS.
        // - Purchase saja yang menjadi requirement dan planned order MRP.
        await syncProductionRequirementsToMps(
          tx,
          { ...mps, details: sourceMpsDetails },
          requirements,
          mbomHeaderByPartCode,
          runNumber,
        );
        const purchaseRequirements = applyNextMonthPurchaseBuffer(requirements, {
          mpsDetails: sourceMpsDetails,
          initialAvailableMap: purchaseInitialAvailableMap,
          initialActualAvailableMap: purchaseInitialActualAvailableMap,
          initialAllocatedMap: purchaseInitialAllocatedMap,
        });
        const persistedPurchaseRequirements = stripRequirementInternals(purchaseRequirements);

        // Create purchase-only requirements
        if (persistedPurchaseRequirements.length > 0) {
          await tx.mRPRequirement.createMany({
            data: persistedPurchaseRequirements,
          });
        }

        const partnerMap = await buildPlannedOrderPartnerMap(
          tx,
          purchaseRequirements.map((requirement) => requirement.partCode),
        );

        // Generate planned orders dari requirements (generate nomor secara berurutan)
        let poSeq = 0;
        let moSeq = 0;
        const today = new Date();
        const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

        // Cari sequence terakhir sekali di luar loop. Referensi di PR/MO/MPP ikut
        // dihitung supaya nomor planned order tidak dipakai ulang setelah PO lama dihapus.
        const [
          lastPlo,
          lastPloPrDetail,
          lastPmo,
          lastPmoMo,
          lastPmoMppDetail,
        ] = await Promise.all([
          tx.plannedOrder.findFirst({
            where: { orderNumber: { startsWith: `PLO-${dateStr}-` } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          }),
          tx.purchaseRequisitionDetail.findFirst({
            where: { plannedOrderNumber: { startsWith: `PLO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
          tx.plannedOrder.findFirst({
            where: { orderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          }),
          tx.manufacturingOrder.findFirst({
            where: { plannedOrderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
          tx.monthlyProductionPlanDetail.findFirst({
            where: { plannedOrderNumber: { startsWith: `PMO-${dateStr}-` } },
            orderBy: { plannedOrderNumber: "desc" },
            select: { plannedOrderNumber: true },
          }),
        ]);
        const extractSeq = (str) => parseInt(str?.match(/-(\d+)$/)?.[1] || "0", 10);
        poSeq = Math.max(
          extractSeq(lastPlo?.orderNumber),
          extractSeq(lastPloPrDetail?.plannedOrderNumber),
        );
        moSeq = Math.max(
          extractSeq(lastPmo?.orderNumber),
          extractSeq(lastPmoMo?.plannedOrderNumber),
          extractSeq(lastPmoMppDetail?.plannedOrderNumber),
        );
        const productionConversionPartMap = await buildProductionConversionPartMap(tx, purchaseRequirements);
        const productionMbomKgPerPcsMap = await buildProductionMbomKgPerPcsMap(
          tx,
          purchaseRequirements,
          productionConversionPartMap,
        );
        const requirementOriginalUomMap = await buildRequirementOriginalUomMap(tx, purchaseRequirements);

        for (const mrpReq of purchaseRequirements) {
          if (mrpReq.plannedOrderQty > 0) {
            // Calculate order date (required date - lead time)
            const orderDate = new Date(mrpReq.requiredDate);
            orderDate.setDate(orderDate.getDate() - mrpReq.leadTime);

            const orderType = "Purchase";
            const isProduction = orderType === "Production";

            const prefix = isProduction ? "PMO" : "PLO";
            if (isProduction) moSeq++; else poSeq++;
            const seq = isProduction ? moSeq : poSeq;
            const orderNumber = `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;
            const sourceUomCode =
              uomCodeByPartCode[mrpReq.partCode] ||
              requirementOriginalUomMap.get(mrpReq.id) ||
              null;
            let plannedOrderQty = mrpReq.plannedOrderQty;
            let plannedOrderUomCode = sourceUomCode;
            let plannedOrderNotes = null;
            const conversionPart =
              productionConversionPartMap.get(mrpReq.partId) ||
              productionConversionPartMap.get(normalizePartCode(mrpReq.partCode)) ||
              null;

            if (isProduction) {
              const conversion = resolveProductionPlannedOrderQuantity({
                qty: mrpReq.plannedOrderQty,
                sourceUomCode: sourceUomCode || null,
                part: conversionPart,
                fallbackKgPerPcs:
                  productionMbomKgPerPcsMap.get(mrpReq.partId) ||
                  productionMbomKgPerPcsMap.get(normalizePartCode(mrpReq.partCode)),
              });
              plannedOrderQty = mrpReq.plannedOrderQty;
              plannedOrderUomCode = sourceUomCode;
              plannedOrderNotes = conversion.note
                ? `${conversion.note} Planned order qty tetap memakai original pcs; gunakan Qty (kg) untuk konversi produksi.`
                : null;
            } else if (isRawMaterialPart(conversionPart) && !isKgUom(sourceUomCode)) {
              plannedOrderNotes = "Raw material belum dikonversi ke kg karena gross weight/pitch/cavity pada MBOM belum lengkap.";
            }

            const plannedOrder = {
              orderNumber,
              runNumber,
              orderType,
              partCode: mrpReq.partCode,
              partId: mrpReq.partId || null,
              uomCode: plannedOrderUomCode || (isProduction ? null : "pcs"),
              mbomHeaderId: isProduction
                ? mrpReq.mbomHeaderId || mbomHeaderByPartCode[mrpReq.partCode] || null
                : null,
              qty: plannedOrderQty,
              requiredDate: mrpReq.requiredDate,
              orderDate,
              supplierCode: isProduction ? null : partnerMap[mrpReq.partCode]?.supplierCode || null,
              vendorCode: isProduction ? null : partnerMap[mrpReq.partCode]?.vendorCode || null,
              referenceType: "MRP",
              referenceNumber: planIdentity.planNumber || runNumber,
              status: "Planned",
              notes: plannedOrderNotes,
            };

            plannedOrders.push(plannedOrder);

            const soSources = soSourcesByRequirement.get(mrpReq) || [];
            if (soSources.length > 0 && mrpReq.partId) {
              for (const source of soSources) {
                const parsed = parseSoConsumptionSource(source);
                if (!parsed || parsed.qty <= 0) continue;
                affectedSoNumbers.add(parsed.soNumber);
                plannedOrder.mrpPeggings = plannedOrder.mrpPeggings || [];
                plannedOrder.mrpPeggings.push({
                  demandType: "SO",
                  demandNumber: parsed.soNumber,
                  demandLineNumber: parsed.lineNumber,
                  supplyType: "PlannedOrder",
                  supplyNumber: orderNumber,
                  supplyLineNumber: null,
                  itemId: mrpReq.partId,
                  qtyPegged: parsed.qty,
                  notes: `MRP ${runNumber} pegging SO ${parsed.soNumber} line ${parsed.lineNumber}`,
                });
              }
            }
          }
        }

        // Create all planned orders
        let createdPlannedOrders = [];
        if (plannedOrders.length > 0) {
          await tx.plannedOrder.createMany({
            data: plannedOrders.map(({ mrpPeggings, ...plannedOrder }) => plannedOrder),
          });

          for (const plannedOrder of plannedOrders) {
            for (const pegging of plannedOrder.mrpPeggings || []) {
              await upsertMrpPegging(tx, pegging);
            }
          }

          // Normalisasi konsistensi referensi untuk run ini.
          // Jika ada row lama/null (mis. data historis), paksa ke pola MRP yang konsisten.
          await tx.plannedOrder.updateMany({
            where: {
              runNumber,
              isDeleted: false,
              OR: [
                { referenceType: null },
                { referenceNumber: null },
              ],
            },
            data: {
              referenceType: "MRP",
              referenceNumber: planIdentity.planNumber || runNumber,
            },
          });

          createdPlannedOrders = await tx.plannedOrder.findMany({
            where: {
              orderNumber: { in: plannedOrders.map((order) => order.orderNumber) },
            },
          });
        }

        await supersedeSoOnlyPlansCoveredByMps(
          tx,
          [...affectedSoNumbers],
          runNumber,
          planIdentity.planNumber,
          req.user?.username || "system",
        );

        // Update MRP Run status
        const executionTime = Math.round((Date.now() - startTime) / 1000);
        const nettingRunSummary = buildNettingRunSummary(soDemandConsumptionSummary);
        const completedRun = await tx.mRPRun.update({
          where: { runNumber },
          data: {
            status: "Completed",
            totalRequirements: purchaseRequirements.length,
            totalPlannedOrders: plannedOrders.length,
            soDemandConsumedQty: nettingRunSummary.totalConsumedQty,
            soDemandImpactedLines: nettingRunSummary.impactedMpsLines,
            nettingSummary: nettingRunSummary,
            executionTime,
            notes: null,
          },
        });

        emitPlanningPlannedOrderBulkUpdate(createdPlannedOrders, "create", req.user?.username || "system");
        emitPlanningMrpRunUpdate(completedRun, "complete", req.user?.username || "system");

        for (const soNumber of affectedSoNumbers) {
          await syncOperationalSalesOrderStatus(tx, soNumber);
        }

        return {
          ...completedRun,
          soDemandConsumption: {
            ...nettingRunSummary,
            byPart: Object.entries(soDemandConsumptionSummary.byPart).map(
              ([partCode, value]) => ({
                partCode,
                consumedQty: Number(value.consumedQty || 0),
                sources: value.sources,
              }),
            ),
          },
        };
      } catch (error) {
        // Update status to Failed on error
        const failedRun = await tx.mRPRun.update({
          where: { runNumber },
          data: {
            status: "Failed",
            errorMessage: error.message,
          },
        });
        emitPlanningMrpRunUpdate(failedRun, "fail", req.user?.username || "system");
        throw error;
      }
    }, {
      timeout: 120000, // 2 minutes timeout for MRP calculation
    });

    res.status(201).json(mapDoc(result));
  } catch (e) {
    next(e);
  }
};

// ============================================
// HELPER: EXPLODE MBOM
// ============================================
const MAX_MBOM_DEPTH = 10;

async function explodeMBOM(
  tx,
  runNumber,
  mbomHeaderId,
  quantity,
  requiredDate,
  level,
  visitedMBomIds = new Set(),
  projectedAvailableMap = {},
  projectedActualAvailableMap = {},
  projectedAllocatedMap = {},
  mbomHeaderByPartCode = {},
  uomCodeByPartCode = {},
  options = {},
) {
  const requirements = [];

  // Guard: max depth untuk hindari MBOM yang terlalu dalam / infinite loop
  if (level > MAX_MBOM_DEPTH) {
    console.warn(`[MRP] explodeMBOM: max depth ${MAX_MBOM_DEPTH} tercapai di mbomHeaderId=${mbomHeaderId}`);
    return { requirements };
  }

  // Get BOM details
  const mbomHeader = await tx.mBOMHeader.findFirst({
    where: {
      id: mbomHeaderId,
      isDeleted: false,
      ...buildMbomValidityWhere(requiredDate),
    },
    include: {
      details: {
        where: { isDeleted: false },
        include: {
          part: {
            include: {
              partBases: { select: { baseOn: true, grossWeight: true } },
              material: { select: { materialCode: true, materialName: true } },
            },
          },
        },
        orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!mbomHeader || !mbomHeader.details || mbomHeader.details.length === 0) {
    return { requirements };
  }

  // Skip BOMDetail yang tidak punya part (partId null)
  const validDetails = sortMbomDetailsParentFirst(
    mbomHeader.details.filter((d) => d.part != null),
  );
  if (validDetails.length === 0) return { requirements };
  const materialPlanningRules = buildMaterialPlanningRules(validDetails);
  const requirementIdByMbomDetailId = new Map();
  const childSequenceByParentId = new Map();
  const projectedMoSupplyMap = options.projectedMoSupplyMap || {};

  // Batch fetch stock balances untuk semua part sekaligus (hindari N+1 query)
  const allPartCodes = [...new Set(validDetails.map((d) => d.part.partCode))];
  const unresolvedPartCodes = allPartCodes.filter(
    (code) => projectedAvailableMap[code] === undefined,
  );
  if (unresolvedPartCodes.length > 0) {
    const stockBalances = await tx.stockBalance.findMany({
      where: {
        AND: [
          { partCode: { in: unresolvedPartCodes }, isDeleted: false },
          buildExcludeSpecialRackCondition(),
        ],
      },
      select: {
        partCode: true,
        stockType: true,
        uomCode: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyQC: true,
        qtyAvailable: true,
      },
    });
    const normalizedStockBalances = normalizePlanningStockRows(stockBalances, materialPlanningRules);
    const stockPositionMaps = buildStockPositionMaps(normalizedStockBalances);
    const supplyMap = await buildOpenSupplyMap(
      tx,
      unresolvedPartCodes,
      requiredDate,
      {
        excludeRunNumbers: [runNumber],
        excludePlanNumbers: options.excludePlanNumbers || [],
        ...materialPlanningRules,
      },
    );
    const moSupplyMap = await buildOpenMoSupplyMap(tx, unresolvedPartCodes, requiredDate);
    for (const partCode of unresolvedPartCodes) {
      projectedAvailableMap[partCode] =
        Number(stockPositionMaps.available[partCode] || 0) + Number(supplyMap[partCode] || 0);
      projectedActualAvailableMap[partCode] = Number(stockPositionMaps.available[partCode] || 0);
      projectedAllocatedMap[partCode] = Number(stockPositionMaps.allocated[partCode] || 0);
      projectedMoSupplyMap[partCode] = Number(moSupplyMap[partCode] || 0);
    }
  }

  for (const detail of validDetails) {
    const partCode = detail.part.partCode;
    const normalizedPartCode = normalizePartCode(partCode);
    const kgPerQty = Number(materialPlanningRules.kgPerQtyByPartCode[normalizedPartCode] || 0);
    const planRawMaterialInKg = materialPlanningRules.planningUomByPartCode[normalizedPartCode] === "kg";
    const effectiveDemandQty = Number(detail.qty || 0) * Number(quantity || 0) * (planRawMaterialInKg ? kgPerQty : 1);
    const forecastQty = Number(detail.qty || 0)
      * Number(options.forecastDemandQty ?? quantity ?? 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    const actualSalesOrderQty = Number(detail.qty || 0)
      * Number(options.actualSalesOrderQty || 0)
      * (planRawMaterialInKg ? kgPerQty : 1);
    // Buffer purchase dihitung setelah seluruh bulan selesai diexplode, karena
    // bucket bulan A membutuhkan forecast hasil explosion bulan A+1.
    const grossRequirement = effectiveDemandQty;
    const detailUomCode = planRawMaterialInKg ? "kg" : detail.uomCode || null;
    if (partCode && detailUomCode) {
      uomCodeByPartCode[partCode] = detailUomCode;
    }
    const availableBefore = projectedAvailableMap[partCode] || 0;
    const actualAvailableBefore = projectedActualAvailableMap[partCode] || 0;
    const onHandQty = actualAvailableBefore;
    const allocatedQty = projectedAllocatedMap[partCode] || 0;
    const netRequirement = Math.max(grossRequirement - availableBefore, 0);

    // Kurangi projected stock komponen agar demand berikutnya tidak pakai stok awal yang sama.
    projectedAvailableMap[partCode] = Math.max(
      availableBefore - grossRequirement,
      0,
    );
    projectedActualAvailableMap[partCode] = Math.max(
      actualAvailableBefore - grossRequirement,
      0,
    );

    const isSubAssembly = isSubAssemblyDetail(detail);
    // MBOM Vendor/inHouse is a production route; only SUB_ASSEMBLY creates separate planned supply.
    const orderType = ["inHouse", "Vendor"].includes(detail.category)
      ? "Production"
      : "Purchase";
    const plannedOrderQty = orderType === "Production" && !isSubAssembly
      ? 0
      : netRequirement;
    // Firm Subassembly MO menutup planned supply parent, tetapi tetap membutuhkan material MBOM.
    // Porsi MO harus menjadi driver explosion tanpa membuat PMO Subassembly baru.
    const moDrivenQty = isSubAssembly
      ? Math.min(Number(projectedMoSupplyMap[partCode] || 0), grossRequirement)
      : 0;
    const subAssemblyExplosionQty = plannedOrderQty + moDrivenQty;
    if (isSubAssembly) {
      projectedMoSupplyMap[partCode] = Math.max(
        Number(projectedMoSupplyMap[partCode] || 0) - moDrivenQty,
        0,
      );
    }

    // Calculate lead time and order date
    const leadTime = durationToWorkingDays(detail.leadTime, detail.leadTimeUnit);
    const orderDate = new Date(requiredDate);
    orderDate.setDate(orderDate.getDate() - leadTime);

    // levelMBOM = level rekursi saat ini (ditentukan oleh kedalaman BOM explosion)
    // level=1 → komponen langsung FG, level=2 → sub-komponen dari inHouse, dst
    const absoluteLevel = level;
    const parentRequirementId =
      (detail.parentDetailId && requirementIdByMbomDetailId.get(detail.parentDetailId)) ||
      options.parentRequirementId ||
      null;
    const parentTreePath =
      (detail.parentDetailId && requirements.find(
        (row) => row.id === requirementIdByMbomDetailId.get(detail.parentDetailId),
      )?.treePath) ||
      options.parentTreePath ||
      null;
    const parentSequenceKey = parentRequirementId || "__ROOT__";
    const siblingSequence = Number(childSequenceByParentId.get(parentSequenceKey) || 0) + 1;
    childSequenceByParentId.set(parentSequenceKey, siblingSequence);
    const requirementIdentity = createRequirementIdentity(
      parentRequirementId,
      options.rootRequirementId || parentRequirementId,
    );

    // levelComponent is relative to this MBOM header. The owning sub-assembly
    // supplies the offset for nested headers.
    const componentLevel =
      Number(options.parentComponentLevel || 0) +
      Math.max(Number(detail.levelComponent || 1), 1);

    const requirement = {
      ...requirementIdentity,
      runNumber,
      treePath: buildRequirementTreePath(
        parentTreePath,
        componentLevel,
        siblingSequence,
      ),
      levelMBOM: componentLevel,
      mbomLevelComponent: componentLevel,
      mbomDetailId: detail.id,
      partCode: detail.part.partCode,
      partId: detail.part.id,
      requirementType: "Dependent",
      sourceType: "MBOM",
      sourceNumber: mbomHeader.noReg,
      requiredDate,
      grossRequirement,
      bufferBaseQty: 0,
      bufferPercent: 0,
      bufferQty: 0,
      bufferOverridden: false,
      forecastQty,
      soConsumedQty: actualSalesOrderQty,
      effectiveDemandQty,
      consumptionSources: Array.isArray(options.consumptionSources)
        ? options.consumptionSources
        : [],
      onHandQty,
      allocatedQty,
      netRequirement,
      plannedOrderQty,
      orderType,
      mpsDetailId: options.mpsDetailId || null,
      leadTime,
      orderDate,
      notes: null,
      // Seluruh turunan BOM mewarisi buffer master parent/FG. Buffer child
      // tidak boleh mengganti policy demand dari parent plan.
      _partBufferPercent: Number(
        options.parentBufferPercent ?? detail.part?.bufferStock ?? 0,
      ),
      _partItemType: detail.part?.itemType || null,
      _productionScheduleQty: orderType === "Production"
        ? isSubAssembly
          ? plannedOrderQty
          : effectiveDemandQty
        : 0,
    };

    if (orderType === "Purchase" && options.initialAvailableMap?.[partCode] === undefined) {
      options.initialAvailableMap[partCode] = availableBefore;
      options.initialActualAvailableMap[partCode] = actualAvailableBefore;
      options.initialAllocatedMap[partCode] = allocatedQty;
    }

    requirements.push(requirement);
    requirementIdByMbomDetailId.set(detail.id, requirement.id);

    // Inline in-house/vendor tetap harus explode ke MBOM anak agar raw material
    // pada routing berikutnya tidak hilang. Sub-assembly memakai kebutuhan net,
    // sedangkan inline memakai gross demand karena tidak membuat planned supply terpisah.
    const childExplosionQty = isSubAssembly
      ? subAssemblyExplosionQty
      : orderType === "Production"
        ? grossRequirement
        : 0;
    if (childExplosionQty > 0) {
      const submBom = await findActiveMbomHeader(tx, detail.part.id, orderDate);
      if (submBom) {
        mbomHeaderByPartCode[detail.part.partCode] = submBom.id;
      }

      if (submBom && !visitedMBomIds.has(submBom.id)) {
        // Guard hanya berlaku pada jalur rekursi aktif. MBOM yang sama tetap boleh
        // dipakai pada sibling lain karena demand-nya memang harus diakumulasi.
        const branchVisitedMbomIds = new Set(visitedMBomIds);
        branchVisitedMbomIds.add(submBom.id);
        const subExploded = await explodeMBOM(
          tx,
          runNumber,
          submBom.id,
          childExplosionQty,
          orderDate,
          absoluteLevel + 1,
          branchVisitedMbomIds,
          projectedAvailableMap,
          projectedActualAvailableMap,
          projectedAllocatedMap,
          mbomHeaderByPartCode,
          uomCodeByPartCode,
          {
            ...options,
            actualSalesOrderQty: Math.min(
              Number(actualSalesOrderQty || 0),
              Number(childExplosionQty || 0),
            ),
            forecastDemandQty: forecastQty,
            parentRequirementId: requirement.id,
            rootRequirementId: requirement.rootRequirementId,
            parentTreePath: requirement.treePath,
            parentComponentLevel: requirement.mbomLevelComponent,
          },
        );
        requirements.push(...subExploded.requirements);
      } else if (submBom && visitedMBomIds.has(submBom.id)) {
        console.warn(`[MRP] Circular MBOM reference terdeteksi: mbomHeaderId=${submBom.id} sudah diproses, skip.`);
      }
    }
  }

  return { requirements };
}

// ============================================
// GET REQUIREMENTS
// ============================================
exports.getRequirements = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const { levelMBOM, partCode, orderType, page = 1, limit = 50 } = req.query;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);
    if (!runNumber) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const where = {
      runNumber,
      isDeleted: false,
      orderType: "Purchase",
    };

    if (levelMBOM !== undefined) {
      where.levelMBOM = Number(levelMBOM);
    }

    if (partCode) {
      where.partCode = partCode;
    }

    if (orderType && orderType !== "Purchase") {
      return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.mRPRequirement.findMany({
        where,
        include: {
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              itemType: true,
              rawType: true,
              material: { select: { materialCode: true, materialName: true } },
            },
          },
          mbomDetail: { select: { uomCode: true, grossWeight: true, category: true } },
          mpsDetail: { select: { partCode: true, customerCode: true, startDate: true, endDate: true } },
        },
        orderBy: [{ treePath: "asc" }, { createdAt: "asc" }],
        skip,
        take: Number(limit),
      }),
      prisma.mRPRequirement.count({ where }),
    ]);

    const itemsWithQtyBreakdown = await enrichRequirementQtyBreakdown(prisma, items);
    const itemsWithSupplyBreakdown = await enrichRequirementSupplyBreakdown(prisma, itemsWithQtyBreakdown);
    const groupedItems = enrichRequirementPlanningGroups(itemsWithSupplyBreakdown);

    res.json({
      items: groupedItems.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// Read model lintas header MRP.  Header detail tetap tersedia di /:runNumber;
// endpoint ini hanya mengagregasi kebutuhan aktif per bulan/customer/part.
exports.generalSummary = async (req, res, next) => {
  try {
    const rows = await prisma.mRPRequirement.findMany({
      where: { isDeleted: false, orderType: "Purchase", mrpRun: { isDeleted: false, isCurrentPlan: true } },
      select: {
        partCode: true, requiredDate: true, grossRequirement: true, forecastQty: true,
        soConsumedQty: true, bufferQty: true, netRequirement: true, adjustedOrderQty: true,
        part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, partType: true } },
        mrpRun: { select: { runNumber: true, mpsNumber: true, runDate: true } },
        mpsDetail: { select: { customerCode: true, startDate: true, endDate: true, mps: { select: { forecastNumber: true } } } },
      },
      orderBy: [{ requiredDate: "asc" }, { partCode: "asc" }],
      take: 20000,
    });
    const grouped = new Map();
    for (const row of rows) {
      const month = planningMonthKey(row.mpsDetail?.startDate || row.requiredDate) || "Tanpa Bulan";
      const forecastNumber = row.mpsDetail?.mps?.forecastNumber || "Tanpa Forecast";
      const customerCode = row.mpsDetail?.customerCode || "Tanpa Customer";
      const partCode = row.partCode || row.part?.partCode || "Tanpa Part";
      const key = [month, forecastNumber, customerCode, partCode].join("|");
      const current = grouped.get(key) || {
        month, forecastNumber, customerCode, partCode,
        partNumber: row.part?.partNumber || null, partName: row.part?.partName || null,
        itemType: row.part?.itemType || null, rawType: row.part?.rawType || null, partType: row.part?.partType || null,
        runNumbers: new Set(), mpsNumbers: new Set(), forecastQty: 0, actualSalesOrderQty: 0,
        bufferQty: 0, grossRequirement: 0, netRequirement: 0, adjustedOrderQty: 0,
      };
      if (row.mrpRun?.runNumber) current.runNumbers.add(row.mrpRun.runNumber);
      if (row.mrpRun?.mpsNumber) current.mpsNumbers.add(row.mrpRun.mpsNumber);
      current.forecastQty += Number(row.forecastQty || 0);
      current.actualSalesOrderQty += Number(row.soConsumedQty || 0);
      current.bufferQty += Number(row.bufferQty || 0);
      current.grossRequirement += Number(row.grossRequirement || 0);
      current.netRequirement += Number(row.netRequirement || 0);
      current.adjustedOrderQty += Number(row.adjustedOrderQty ?? row.netRequirement ?? 0);
      grouped.set(key, current);
    }
    res.json([...grouped.values()].map((row) => ({
      ...row,
      runNumbers: [...row.runNumbers],
      mpsNumbers: [...row.mpsNumbers],
    })));
  } catch (error) {
    next(error);
  }
};

exports.updateRequirementBuffer = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    if (!runNumber) return res.status(404).json({ message: "MRP Run tidak ditemukan" });

    const requirementIds = [...new Set(
      (Array.isArray(req.body.requirementIds) ? req.body.requirementIds : [req.body.requirementId])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    )];
    const isOrderPercentUpdate = req.body.orderPercent !== undefined && req.body.orderPercent !== null && req.body.orderPercent !== "";
    const bufferPercent = Number(req.body.bufferPercent);
    const orderPercent = Number(req.body.orderPercent);
    const bufferScope = req.body.scope === "parent" ? "PARENT_FG" : "LINE";
    if (requirementIds.length === 0) {
      return res.status(400).json({ message: "Requirement yang akan diedit wajib dipilih" });
    }
    if (!isOrderPercentUpdate && (!Number.isFinite(bufferPercent) || bufferPercent < 0 || bufferPercent > 100)) {
      return res.status(400).json({ message: "Buffer stock harus di antara 0 sampai 100 persen" });
    }
    if (isOrderPercentUpdate && (!Number.isFinite(orderPercent) || orderPercent < 0 || orderPercent > 100)) {
      return res.status(400).json({ message: "Order forecast harus di antara 0 sampai 100 persen" });
    }

    await prisma.$transaction(async (tx) => {
      const run = await tx.mRPRun.findFirst({
        where: { runNumber, isDeleted: false },
        select: { runNumber: true, planNumber: true, cutoffDate: true, status: true },
      });
      if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
      if (run.status !== "Completed") {
        throw Object.assign(new Error("Adjustment hanya dapat diedit pada MRP yang sudah Completed"), { status: 409 });
      }

      const selected = await tx.mRPRequirement.findMany({
        where: {
          id: { in: requirementIds },
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
        },
        select: { id: true, rootRequirementId: true, partCode: true, bufferBaseQty: true, effectiveDemandQty: true, forecastQty: true, soConsumedQty: true, bufferQty: true },
      });
      if (selected.length !== requirementIds.length) {
        throw Object.assign(new Error("Sebagian requirement purchase tidak ditemukan"), { status: 404 });
      }

      const rootRequirementIds = [...new Set(selected.map((row) => row.rootRequirementId).filter(Boolean))];
      const targets = !isOrderPercentUpdate && bufferScope === "PARENT_FG" && rootRequirementIds.length
        ? await tx.mRPRequirement.findMany({
          where: { runNumber, isDeleted: false, orderType: "Purchase", rootRequirementId: { in: rootRequirementIds } },
          select: { id: true, partCode: true, bufferBaseQty: true, effectiveDemandQty: true, forecastQty: true, soConsumedQty: true, bufferQty: true },
        })
        : selected;

      for (const row of targets) {
        const nextBufferQty = isOrderPercentUpdate
          ? Number(row.bufferQty || 0)
          : roundPlanningQty(Number(row.bufferBaseQty || 0) * bufferPercent / 100);
        const forecastBasis = Number(row.forecastQty || Math.max(Number(row.effectiveDemandQty || 0) - Number(row.bufferQty || 0), 0));
        // PPIC boleh mengurangi/menambah coverage forecast, tetapi SO aktual adalah floor.
        const demandAfterOrderPercent = isOrderPercentUpdate
          ? Math.max((forecastBasis * orderPercent) / 100, Number(row.soConsumedQty || 0))
          : Number(row.effectiveDemandQty || 0);
        await tx.mRPRequirement.update({
          where: { id: row.id },
          data: {
            ...(isOrderPercentUpdate ? {
              orderPercent,
              grossRequirement: roundPlanningQty(demandAfterOrderPercent + nextBufferQty),
              notes: `Order forecast ${orderPercent}% (minimum SO ${Number(row.soConsumedQty || 0)})`,
            } : {
              bufferPercent,
              bufferQty: nextBufferQty,
              bufferOverridden: true,
              bufferReferenceScope: bufferScope,
              grossRequirement: roundPlanningQty(Number(row.effectiveDemandQty || 0) + nextBufferQty),
              notes: buildBufferStockNote(bufferPercent, nextBufferQty),
            }),
          },
        });
      }

      const partCodes = [...new Set(targets.map((row) => normalizePartCode(row.partCode)).filter(Boolean))];
      const requirements = await tx.mRPRequirement.findMany({
        where: {
          runNumber,
          isDeleted: false,
          orderType: "Purchase",
          partCode: { in: partCodes },
        },
        include: {
          part: {
            include: { partBases: { select: { baseOn: true, grossWeight: true } } },
          },
          mbomDetail: { select: { uomCode: true, grossWeight: true, category: true } },
        },
        orderBy: [{ requiredDate: "asc" }, { treePath: "asc" }],
      });
      const materialRules = buildMaterialPlanningRules(
        requirements.map((row) => ({ ...(row.mbomDetail || {}), part: row.part })),
      );
      const stockRows = await tx.stockBalance.findMany({
        where: {
          AND: [
            { partCode: { in: partCodes }, isDeleted: false },
            buildExcludeSpecialRackCondition(),
          ],
        },
        select: {
          partCode: true,
          stockType: true,
          uomCode: true,
          qtyOnHand: true,
          qtyReserved: true,
          qtyQC: true,
          qtyAvailable: true,
        },
      });
      const normalizedStocks = normalizePlanningStockRows(stockRows, materialRules);
      const stockMaps = buildStockPositionMaps(normalizedStocks);
      const supplyMap = await buildOpenSupplyMap(tx, partCodes, run.cutoffDate, {
        excludeRunNumbers: [runNumber],
        ...materialRules,
      });

      for (const partCode of partCodes) {
        let projectedAvailable = Number(stockMaps.available[partCode] || 0) + Number(supplyMap[partCode] || 0);
        let projectedActual = Number(stockMaps.available[partCode] || 0);
        const allocatedQty = Number(stockMaps.allocated[partCode] || 0);
        for (const row of requirements.filter((item) => normalizePartCode(item.partCode) === partCode)) {
          const grossRequirement = Number(row.grossRequirement || 0);
          const netRequirement = roundPlanningQty(Math.max(grossRequirement - projectedAvailable, 0));
          await tx.mRPRequirement.update({
            where: { id: row.id },
            data: {
              onHandQty: projectedActual,
              allocatedQty,
              netRequirement,
              plannedOrderQty: netRequirement,
              adjustedOrderQty: netRequirement,
            },
          });
          projectedAvailable = Math.max(projectedAvailable - grossRequirement, 0);
          projectedActual = Math.max(projectedActual - grossRequirement, 0);
          row.netRequirement = netRequirement;
          row.plannedOrderQty = netRequirement;
        }
      }

      const openOrders = await tx.plannedOrder.findMany({
        where: { runNumber, isDeleted: false, orderType: "Purchase", partCode: { in: partCodes } },
        orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
      });
      const lockedOrder = openOrders.find((row) => row.status !== "Planned");
      if (lockedOrder) {
        throw Object.assign(
          new Error(`Buffer tidak dapat diubah karena ${lockedOrder.orderNumber} sudah berstatus ${lockedOrder.status}`),
          { status: 409 },
        );
      }

      const dateKey = (value) => new Date(value).toISOString().slice(0, 10);
      const orderGroups = new Map();
      for (const order of openOrders) {
        const key = `${normalizePartCode(order.partCode)}|${dateKey(order.requiredDate)}`;
        if (!orderGroups.has(key)) orderGroups.set(key, []);
        orderGroups.get(key).push(order);
      }
      const requirementGroups = new Map();
      for (const row of requirements) {
        const key = `${normalizePartCode(row.partCode)}|${dateKey(row.requiredDate)}`;
        if (!requirementGroups.has(key)) requirementGroups.set(key, { rows: [], qty: 0 });
        requirementGroups.get(key).rows.push(row);
        requirementGroups.get(key).qty += Number(row.plannedOrderQty || 0);
      }

      const partnerMap = await buildPlannedOrderPartnerMap(tx, partCodes);
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const lastPlo = await tx.plannedOrder.findFirst({
        where: { orderNumber: { startsWith: `PLO-${dateStr}-` } },
        orderBy: { orderNumber: "desc" },
        select: { orderNumber: true },
      });
      let sequence = parseInt(lastPlo?.orderNumber?.match(/-(\d+)$/)?.[1] || "0", 10);
      const allKeys = new Set([...orderGroups.keys(), ...requirementGroups.keys()]);
      for (const key of allKeys) {
        const existing = orderGroups.get(key) || [];
        const target = requirementGroups.get(key);
        const qty = roundPlanningQty(target?.qty || 0);
        if (qty <= 0) {
          if (existing.length > 0) {
            await tx.plannedOrder.updateMany({
              where: { orderNumber: { in: existing.map((row) => row.orderNumber) } },
              data: { isDeleted: true, notes: "Cancelled after MRP buffer override" },
            });
          }
          continue;
        }

        if (existing.length > 0) {
          await tx.plannedOrder.update({ where: { orderNumber: existing[0].orderNumber }, data: { qty } });
          if (existing.length > 1) {
            await tx.plannedOrder.updateMany({
              where: { orderNumber: { in: existing.slice(1).map((row) => row.orderNumber) } },
              data: { isDeleted: true, notes: "Consolidated after MRP buffer override" },
            });
          }
          continue;
        }

        const row = target.rows[0];
        const partCode = normalizePartCode(row.partCode);
        sequence += 1;
        await tx.plannedOrder.create({
          data: {
            orderNumber: `PLO-${dateStr}-${String(sequence).padStart(4, "0")}`,
            runNumber,
            orderType: "Purchase",
            partCode,
            partId: row.partId || null,
            uomCode: materialRules.planningUomByPartCode[partCode] || row.mbomDetail?.uomCode || "pcs",
            qty,
            requiredDate: row.requiredDate,
            orderDate: row.orderDate || row.requiredDate,
            supplierCode: partnerMap[partCode]?.supplierCode || null,
            vendorCode: partnerMap[partCode]?.vendorCode || null,
            referenceType: "MRP",
            referenceNumber: run.planNumber || runNumber,
            status: "Planned",
            notes: "Created after MRP buffer override",
          },
        });
      }

      const [totalRequirements, totalPlannedOrders] = await Promise.all([
        tx.mRPRequirement.count({ where: { runNumber, isDeleted: false, orderType: "Purchase" } }),
        tx.plannedOrder.count({ where: { runNumber, isDeleted: false, orderType: "Purchase" } }),
      ]);
      await tx.mRPRun.update({
        where: { runNumber },
        data: { totalRequirements, totalPlannedOrders },
      });
    }, { timeout: 120000 });

    res.json({
      message: isOrderPercentUpdate ? "Order percentage MRP berhasil diperbarui" : "Buffer stock MRP berhasil diperbarui",
      runNumber,
      ...(isOrderPercentUpdate ? { orderPercent } : { bufferPercent }),
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

async function nextMrpPurchaseRequestNumber(tx) {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `PR-MRP-${dateKey}-`;
  const latest = await tx.purchaseRequisition.findFirst({
    where: { prNumber: { startsWith: prefix } },
    orderBy: { prNumber: "desc" },
    select: { prNumber: true },
  });
  const sequence = Number(latest?.prNumber?.match(/(\d+)$/)?.[1] || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

// Output MRP purchase-only. Planned order yang sudah menjadi PR tidak dibuat ulang.
exports.createPurchaseRequestOutput = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    if (!runNumber) return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.mRPRun.findFirst({ where: { runNumber, isDeleted: false }, select: { runNumber: true, status: true, planNumber: true } });
      if (!run) throw Object.assign(new Error("MRP Run tidak ditemukan"), { status: 404 });
      if (run.status !== "Completed") throw Object.assign(new Error("MRP harus Completed sebelum membuat Purchase Request"), { status: 409 });
      const orders = await tx.plannedOrder.findMany({
        where: { runNumber, isDeleted: false, orderType: "Purchase", status: "Planned", qty: { gt: 0 } },
        orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
      });
      if (!orders.length) {
        const existing = await tx.purchaseRequisitionDetail.findMany({ where: { plannedOrderNumber: { not: null }, pr: { notes: { contains: runNumber }, isDeleted: false } }, select: { prNumber: true }, distinct: ["prNumber"] });
        return { created: false, prNumbers: existing.map((row) => row.prNumber), message: "Tidak ada planned purchase order baru untuk dikeluarkan." };
      }
      const partCodes = [...new Set(orders.map((row) => row.partCode))];
      const parts = await tx.part.findMany({ where: { partCode: { in: partCodes }, isDeleted: false }, select: { partCode: true, partName: true, partNumber: true, material: { select: { materialCode: true, materialName: true } } } });
      const partByCode = new Map(parts.map((part) => [part.partCode, part]));
      const prNumber = await nextMrpPurchaseRequestNumber(tx);
      const requiredDate = orders.reduce((earliest, order) => !earliest || new Date(order.requiredDate) < earliest ? new Date(order.requiredDate) : earliest, null) || new Date();
      const created = await tx.purchaseRequisition.create({
        data: {
          prNumber,
          requestedBy: req.user?.username || req.user?.email || "PPIC",
          requiredDate,
          poType: "Material",
          status: "Draft",
          notes: `Generated from MRP ${run.planNumber || runNumber}`,
          details: { create: orders.map((order, index) => {
            const part = partByCode.get(order.partCode);
            return {
              lineNumber: index + 1,
              partCode: order.partCode,
              partNumber: part?.partNumber || order.partCode,
              partName: part?.partName || null,
              description: part?.material?.materialName || null,
              qty: Number(order.qty || 0),
              uomCode: order.uomCode || null,
              preferredSupplier: order.supplierCode || null,
              preferredVendor: order.vendorCode || null,
              plannedOrderNumber: order.orderNumber,
              notes: `MRP ${runNumber}; Order % sudah diterapkan pada planned order`,
            };
          }) },
        },
        include: { details: true },
      });
      await tx.plannedOrder.updateMany({ where: { orderNumber: { in: orders.map((row) => row.orderNumber) } }, data: { status: "Released", notes: `Released to Purchase Request ${prNumber}` } });
      return { created: true, purchaseRequest: created, prNumbers: [prNumber] };
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

// Output produksi tetap dikelola Monthly Production Plan, dengan source MPS dari MRP run.
exports.createProductionPlanOutput = async (req, res, next) => {
  try {
    const runNumber = await resolveCurrentRunNumber(req.params.runNumber);
    const run = runNumber && await prisma.mRPRun.findFirst({ where: { runNumber, isDeleted: false }, select: { mpsNumber: true, status: true } });
    if (!run) return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    if (run.status !== "Completed") return res.status(409).json({ message: "MRP harus Completed sebelum membuat Production Planning" });
    if (!run.mpsNumber) return res.status(409).json({ message: "MRP ini tidak terhubung ke MPS sehingga Production Planning tidak dapat dibuat" });
    const monthlyPlan = require("./MonthlyProductionPlanController");
    const delegatedReq = Object.create(req);
    delegatedReq.body = { ...(req.body || {}), mpsNumber: run.mpsNumber };
    return monthlyPlan.createFromMps(delegatedReq, res, next);
  } catch (error) { next(error); }
};

// ============================================
// GET PLANNED ORDERS
// ============================================
exports.getPlannedOrders = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const { orderType, status, partCode, page = 1, limit = 50 } = req.query;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);
    if (!runNumber) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const where = {
      runNumber,
      isDeleted: false,
      orderType: "Purchase",
    };

    if (orderType && orderType !== "Purchase") {
      return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
    }

    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (partCode) {
      where.partCode = partCode;
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.plannedOrder.findMany({
        where,
        include: {
          mrpRun: {
            select: {
              runNumber: true,
              planNumber: true,
              planRevision: true,
              planScope: true,
              runDate: true,
            },
          },
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { orderDate: "asc" }],
        skip,
        take: Number(limit),
      }),
      prisma.plannedOrder.count({ where }),
    ]);
    const itemsWithQtyBreakdown = await enrichPlannedOrderQtyBreakdown(prisma, items);
    const enrichedItems = await enrichPlannedOrderDisplay(prisma, itemsWithQtyBreakdown);

    res.json({
      items: enrichedItems.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================
// DELETE MRP RUN
// ============================================
exports.remove = async (req, res, next) => {
  try {
    const { runNumber: runIdentifier } = req.params;
    const runNumber = await resolveCurrentRunNumber(runIdentifier);

    const existing = runNumber
      ? await prisma.mRPRun.findUnique({
          where: { runNumber },
          select: { id: true, runNumber: true, isDeleted: true },
        })
      : null;

    if (!existing || existing.isDeleted) {
      return res.status(404).json({ message: "MRP Run tidak ditemukan" });
    }

    const lockedPlannedOrderCount = await prisma.plannedOrder.count({
      where: {
        runNumber,
        isDeleted: false,
        status: { in: ["Partially Released", "Released", "Covered"] },
      },
    });

    if (lockedPlannedOrderCount > 0) {
      return res.status(409).json({
        message: "MRP Run tidak bisa dihapus karena sudah memiliki Planned Order yang sudah released/covered.",
      });
    }

    await prisma.$transaction(async (tx) => {
      // Cascade soft delete: requirement dari run ini
      await tx.mRPRequirement.updateMany({
        where: { runNumber, isDeleted: false },
        data: { isDeleted: true },
      });

      // Cascade soft delete: planned order dari run ini (aman karena released sudah di-guard)
      await tx.plannedOrder.updateMany({
        where: {
          runNumber,
          isDeleted: false,
          status: { notIn: ["Partially Released", "Released", "Covered"] },
        },
        data: { isDeleted: true },
      });

      await tx.mRPRun.update({
        where: { runNumber },
        data: { isDeleted: true },
      });
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

// ============================================
// BULK SOFT DELETE
// ============================================
exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: "ids array required",
        received: req.body,
      });
    }

    const runs = await prisma.mRPRun.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, runNumber: true },
    });

    const runNumbers = runs.map((r) => r.runNumber);
    const lockedRuns = await prisma.plannedOrder.findMany({
      where: {
        runNumber: { in: runNumbers },
        isDeleted: false,
        status: { in: ["Partially Released", "Released", "Covered"] },
      },
      select: { runNumber: true },
      distinct: ["runNumber"],
    });
    const lockedSet = new Set(lockedRuns.map((x) => x.runNumber));

    const deletable = [];
    const skipped = [];

    for (const r of runs) {
      if (lockedSet.has(r.runNumber)) {
        skipped.push({ id: r.id, runNumber: r.runNumber, reason: "punya planned order yang sudah released/covered" });
        continue;
      }
      deletable.push(r.id);
    }

    if (deletable.length === 0) {
      return res.status(409).json({
        message: "Tidak ada MRP Run yang bisa dihapus",
        deletedCount: 0,
        skipped,
      });
    }

    const deletableRuns = runs.filter((r) => deletable.includes(r.id));
    const deletableRunNumbers = deletableRuns.map((r) => r.runNumber);

    const result = await prisma.$transaction(async (tx) => {
      await tx.mRPRequirement.updateMany({
        where: { runNumber: { in: deletableRunNumbers }, isDeleted: false },
        data: { isDeleted: true },
      });

      await tx.plannedOrder.updateMany({
        where: {
          runNumber: { in: deletableRunNumbers },
          isDeleted: false,
          status: { notIn: ["Partially Released", "Released", "Covered"] },
        },
        data: { isDeleted: true },
      });

      return tx.mRPRun.updateMany({
        where: { id: { in: deletable } },
        data: { isDeleted: true },
      });
    });

    res.json({ deletedCount: result.count, skipped });
  } catch (e) {
    next(e);
  }
};

