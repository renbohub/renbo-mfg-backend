const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { parseFilter } = require("../../utils/parseFilter");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { generateConfiguredNumber } = require("../../services/numberingService");
const { assertStockBalanceNotFrozen, assertStockIdentityNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const {
  buildExcludeSpecialRackCondition,
} = require("../inventory/utils/stockReservationHelpers");
const {
  getRoutingOperations,
} = require("./services/productionWorkflowService");

const FINAL_STOCK_TYPE = "Finished Goods";
const WIP_STOCK_TYPE = "WIP";
const VENDOR_WIP_STOCK_TYPE = "Vendor WIP";
const QUANTITY_TOLERANCE = 0.005;
const SOURCE_STOCK_BALANCE = "STOCK_BALANCE";
const SOURCE_WORK_ORDER_OUTPUT = "WORK_ORDER_OUTPUT";
const SOURCE_PREVIOUS_WIP = "PREVIOUS_WIP";
const PRICE_MONTH_FIELDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeRateType(value) {
  return String(value || "PER_HOUR").trim().toUpperCase();
}

function toMachineRatePerSecond(rate, rateType) {
  const numericRate = toNumber(rate);
  switch (normalizeRateType(rateType)) {
    case "PER_SECOND":
      return numericRate;
    case "PER_MINUTE":
      return numericRate / 60;
    case "PER_CYCLE":
      return numericRate;
    case "PER_HOUR":
    default:
      return numericRate / 3600;
  }
}

function getPlannedProcessCost(cycleTime, machine) {
  if (!machine) return 0;
  return toNumber(cycleTime) * toMachineRatePerSecond(machine.costingRate, machine.costingRateType);
}

function getMonthlyVendorRate(priceList, date = new Date()) {
  if (!priceList) return 0;
  const monthIndex = Number.isFinite(date?.getMonth?.()) ? date.getMonth() : new Date().getMonth();
  const currentMonthRate = toNumber(priceList[PRICE_MONTH_FIELDS[monthIndex]], NaN);
  if (Number.isFinite(currentMonthRate) && currentMonthRate > 0) return currentMonthRate;

  for (const field of PRICE_MONTH_FIELDS) {
    const rate = toNumber(priceList[field], NaN);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return 0;
}

function vendorProcessMatchesOrder(vendorProcess = {}, order = {}) {
  const processCode = String(order.processCode || "").trim().toLowerCase();
  const processName = String(order.processName || "").trim().toLowerCase();
  const vendorProcessCode = String(vendorProcess.vendorProcessCode || "").trim().toLowerCase();
  const vendorProcessName = String(vendorProcess.vendorProcessName || "").trim().toLowerCase();

  return Boolean(
    (processCode && vendorProcessCode && processCode === vendorProcessCode)
    || (processName && vendorProcessName && processName === vendorProcessName)
    || (processName && vendorProcessCode && processName === vendorProcessCode)
    || (processCode && vendorProcessName && processCode === vendorProcessName),
  );
}

function buildVendorCostSnapshot(priceList, qty, date = new Date()) {
  const rate = getMonthlyVendorRate(priceList, date);
  return {
    vendorPriceListId: priceList?.id || null,
    vendorRate: rate,
    vendorCurrency: priceList?.currencyCode || null,
    plannedVendorCost: roundQuantity(toNumber(qty) * rate),
  };
}

async function resolveVendorPriceSnapshot(tx, orderLike = {}, date = new Date()) {
  const vendorCode = normalizeText(orderLike.vendorCode);
  if (!vendorCode) {
    return {
      vendorPriceListId: null,
      vendorRate: 0,
      vendorCurrency: null,
      plannedVendorCost: 0,
    };
  }

  const partIds = [orderLike.inputPartId, orderLike.outputPartId].filter(Boolean);
  const partCodes = [orderLike.inputPartCode, orderLike.outputPartCode].filter(Boolean);
  const pricingYear = date.getFullYear();
  const baseWhere = {
    vendor: { is: { vendorCode, isDeleted: false } },
    isDeleted: false,
    OR: [
      ...(partIds.length ? [{ partId: { in: partIds } }] : []),
      ...(partCodes.length ? [{ part: { is: { partCode: { in: partCodes } } } }] : []),
    ],
  };
  if (baseWhere.OR.length === 0) delete baseWhere.OR;

  const priceLists = await tx.vendorPriceList.findMany({
    where: {
      ...baseWhere,
      pricingYear,
    },
    include: {
      entityProcesses: {
        where: { entityType: "vendorPriceList" },
        include: {
          vendorProcess: {
            select: { vendorProcessCode: true, vendorProcessName: true },
          },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 20,
  });

  const fallbackPriceLists = priceLists.length > 0
    ? priceLists
    : await tx.vendorPriceList.findMany({
        where: baseWhere,
        include: {
          entityProcesses: {
            where: { entityType: "vendorPriceList" },
            include: {
              vendorProcess: {
                select: { vendorProcessCode: true, vendorProcessName: true },
              },
            },
          },
        },
        orderBy: [{ pricingYear: "desc" }, { updatedAt: "desc" }],
        take: 20,
      });

  const matchedByProcess = fallbackPriceLists.find((priceList) =>
    priceList.entityProcesses?.some((row) =>
      vendorProcessMatchesOrder(row.vendorProcess, orderLike),
    ),
  );
  const matched = matchedByProcess || fallbackPriceLists[0] || null;
  return buildVendorCostSnapshot(matched, orderLike.qtyPlanned, date);
}

function roundQuantity(value) {
  return Math.round(toNumber(value) * 1000000) / 1000000;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  return text !== "" && text !== "-";
}

function coalesceValue(...values) {
  return values.find((value) => hasMeaningfulValue(value)) ?? null;
}

function inferStartSequenceFromSourcePartCode(operations = [], sourcePartCode) {
  if (!sourcePartCode) return 0;
  const normalizedPartCode = String(sourcePartCode).trim().toLowerCase();
  if (!normalizedPartCode) return 0;

  const matchedOperation = operations.find((operation) =>
    String(operation?.outputPart?.partCode || operation?.inputPart?.partCode || "").trim().toLowerCase() === normalizedPartCode,
  );
  return toNumber(matchedOperation?.sequence, 0);
}

async function findReservedMoSourceWipForVendorSend(tx, order, sourceBalance) {
  if (!order?.moId || !sourceBalance?.id) return null;

  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: order.moId },
    select: {
      moNumber: true,
      inputSourceType: true,
      sourceStockBalanceId: true,
    },
  });
  if (!mo || mo.inputSourceType !== "WIP_STOCK" || mo.sourceStockBalanceId !== sourceBalance.id) {
    return null;
  }

  const reservation = await tx.stockReservation.findFirst({
    where: {
      referenceType: "MANUFACTURING_ORDER",
      referenceNumber: mo.moNumber,
      stockBalanceId: sourceBalance.id,
      isDeleted: false,
      status: { in: ["Active", "Released"] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!reservation) return null;

  const qtyReservedRemaining = Math.max(
    0,
    roundQuantity(toNumber(reservation.qtyReserved) - toNumber(reservation.qtyReleased)),
  );
  if (qtyReservedRemaining <= QUANTITY_TOLERANCE) return null;

  return { mo, reservation, qtyReservedRemaining };
}

async function consumeReservedMoSourceWipForVendorSend(
  tx,
  order,
  sourceBalance,
  reservedContext,
  qty,
  now,
  performedBy,
) {
  const qtyOut = roundQuantity(qty);
  if (qtyOut <= 0) return [];
  if (reservedContext.qtyReservedRemaining + QUANTITY_TOLERANCE < qtyOut) {
    throw Object.assign(new Error("Qty reserved source stock untuk MO tidak cukup untuk dikirim ke vendor."), {
      statusCode: 400,
    });
  }

  await assertStockBalanceNotFrozen(tx, sourceBalance.id);

  const qtyBefore = toNumber(sourceBalance.qtyOnHand);
  const qtyReservedBefore = toNumber(sourceBalance.qtyReserved);
  const qtyQC = toNumber(sourceBalance.qtyQC);
  const qtyAfter = roundQuantity(Math.max(0, qtyBefore - qtyOut));
  const qtyReservedAfter = Math.max(0, roundQuantity(qtyReservedBefore - reservedContext.qtyReservedRemaining));
  await tx.stockBalance.update({
    where: { id: sourceBalance.id },
    data: {
      qtyOnHand: qtyAfter,
      qtyReserved: qtyReservedAfter,
      qtyAvailable: Math.max(0, qtyAfter - qtyReservedAfter - qtyQC),
      lastMovement: now,
    },
  });

  const consumedQty = roundQuantity(toNumber(reservedContext.reservation.qtyReleased) + qtyOut);
  await tx.stockReservation.update({
    where: { id: reservedContext.reservation.id },
    data: {
      qtyReserved: consumedQty,
      qtyReleased: consumedQty,
      status: "Released",
      notes: `[VENDOR SEND] ${order.orderNumber} consume ${qtyOut} from source WIP MO ${reservedContext.mo.moNumber}; remainder released to available`,
    },
  });

  return [{
    warehouseCode: sourceBalance.warehouseCode,
    rackCode: sourceBalance.rackCode || null,
    lotNumber: sourceBalance.lotNumber || null,
    partCode: sourceBalance.partCode || order.inputPartCode || order.outputPartCode || null,
    partNumber: sourceBalance.partNumber || order.inputPartNumber || order.outputPartNumber || null,
    partName: sourceBalance.partName || order.inputPartName || order.outputPartName || null,
    productId: sourceBalance.productId || null,
    description: sourceBalance.description || null,
    spec: sourceBalance.spec || order.spec || null,
    thickness: sourceBalance.thickness ?? order.thickness ?? null,
    width: sourceBalance.width ?? order.width ?? null,
    CSP: sourceBalance.CSP || order.CSP || null,
    stockType: sourceBalance.stockType || WIP_STOCK_TYPE,
    qty: qtyOut,
    qtyBefore,
    qtyAfter,
    referenceType: "MANUFACTURING_ORDER",
    referenceNumber: reservedContext.mo.moNumber,
    notes: `Send reserved source WIP ${reservedContext.mo.moNumber} to vendor ${order.orderNumber}`,
    performedBy,
  }];
}

function buildOrderPrefix(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `VPO-${y}${m}${d}`;
}

async function generateVendorProcessOrderNumber(tx) {
  const prefix = buildOrderPrefix();
  const last = await tx.vendorProcessOrder.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });

  let seq = 1;
  if (last?.orderNumber) {
    const parts = last.orderNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function resolvePartIdentity(part = {}) {
  const partBase = getPreferredPartBase(part);
  return {
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    spec: part.material?.spec || null,
    thickness: partBase.thickness ?? null,
    width: partBase.width ?? null,
    CSP: partBase.CSP || null,
  };
}

function normalizePartBaseOn(value) {
  return String(value || "").trim().toUpperCase();
}

function getPreferredPartBase(part = {}) {
  const bases = Array.isArray(part.partBases) ? part.partBases : [];
  return (
    bases.find((base) => normalizePartBaseOn(base.baseOn) === "ACTUAL") ||
    bases.find((base) => ["QTN", "QUOTATION"].includes(normalizePartBaseOn(base.baseOn))) ||
    bases[0] ||
    {}
  );
}

function stockIdentityFromOrder(order) {
  return {
    partNumber: order.outputPartNumber || null,
    partName: order.outputPartName || null,
    spec: order.spec || null,
    thickness: order.thickness ?? null,
    width: order.width ?? null,
    CSP: order.CSP || null,
  };
}

const MBOM_DETAIL_SELECT = {
  id: true,
  noReg: true,
  levelComponent: true,
  part: {
    select: {
      id: true,
      partCode: true,
      partNumber: true,
      partName: true,
      material: { select: { spec: true } },
      partBases: {
        select: { baseOn: true, thickness: true, width: true, CSP: true },
        orderBy: { createdAt: "asc" },
      },
    },
  },
  parentDetail: {
    select: {
      id: true,
      levelComponent: true,
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
        },
      },
    },
  },
};

const PART_IDENTITY_SELECT = {
  id: true,
  partCode: true,
  partNumber: true,
  partName: true,
  material: { select: { spec: true } },
  partBases: {
    select: { baseOn: true, thickness: true, width: true, CSP: true },
    orderBy: { createdAt: "asc" },
  },
};

const MBOM_PROCESS_SELECT = {
  id: true,
  sequence: true,
  cycleTime: true,
  machineId: true,
  machine: {
    select: {
      id: true,
      machineCode: true,
      machineName: true,
      costingRate: true,
      costingRateType: true,
      currencyCode: true,
    },
  },
  process: {
    select: {
      id: true,
      processCode: true,
      processName: true,
    },
  },
};

async function loadMbomDetailMap(tx, mbomDetailIds = []) {
  const ids = [...new Set(mbomDetailIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const details = await tx.mBOMDetail.findMany({
    where: { id: { in: ids } },
    select: MBOM_DETAIL_SELECT,
  });

  return new Map(details.map((detail) => [detail.id, detail]));
}

function buildMbomDetailKey(noReg, partCode) {
  if (!hasMeaningfulValue(noReg) || !hasMeaningfulValue(partCode)) return null;
  return `${String(noReg).trim()}::${String(partCode).trim()}`;
}

async function loadMbomDetailMapsForOrders(tx, orders = []) {
  const ids = [...new Set(orders.map((order) => order.mbomDetailId).filter(Boolean))];
  const noRegs = [...new Set(orders.map((order) => order.mbomNoReg).filter((noReg) => hasMeaningfulValue(noReg)))];
  const partCodes = [
    ...new Set(
      orders
        .flatMap((order) => [order.inputPartCode, order.outputPartCode])
        .filter((partCode) => hasMeaningfulValue(partCode)),
    ),
  ];

  if (ids.length === 0 && (noRegs.length === 0 || partCodes.length === 0)) {
    return { byId: new Map(), byKey: new Map() };
  }

  const details = await tx.mBOMDetail.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(noRegs.length && partCodes.length
          ? [{ noReg: { in: noRegs }, part: { partCode: { in: partCodes } } }]
          : []),
      ],
    },
    select: MBOM_DETAIL_SELECT,
  });

  return {
    byId: new Map(details.map((detail) => [detail.id, detail])),
    byKey: new Map(
      details
        .map((detail) => [buildMbomDetailKey(detail.noReg, detail.part?.partCode), detail])
        .filter(([key]) => key),
    ),
  };
}

async function loadMbomProcessMap(tx, mbomProcessIds = []) {
  const ids = [...new Set(mbomProcessIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const processes = await tx.mBOMProcess.findMany({
    where: { id: { in: ids } },
    select: MBOM_PROCESS_SELECT,
  });

  return new Map(processes.map((process) => [process.id, process]));
}

async function loadPartIdentityMaps(tx, orders = []) {
  const ids = [...new Set(orders.map((order) => order.outputPartId).filter(Boolean))];
  const codes = [...new Set(orders.map((order) => order.outputPartCode).filter((code) => hasMeaningfulValue(code)))];
  if (ids.length === 0 && codes.length === 0) {
    return { byId: new Map(), byCode: new Map() };
  }

  const parts = await tx.part.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(codes.length ? [{ partCode: { in: codes } }] : []),
      ],
    },
    select: PART_IDENTITY_SELECT,
  });

  return {
    byId: new Map(parts.map((part) => [part.id, part])),
    byCode: new Map(parts.map((part) => [part.partCode, part])),
  };
}

function enrichVendorProcessOrder(
  order,
  mbomDetailMaps = { byId: new Map(), byKey: new Map() },
  mbomProcessesById = new Map(),
  partIdentityMaps = { byId: new Map(), byCode: new Map() },
) {
  const mbomDetail = order.mbomDetail
    || mbomDetailMaps.byId.get(order.mbomDetailId)
    || mbomDetailMaps.byKey.get(buildMbomDetailKey(order.mbomNoReg, order.inputPartCode))
    || mbomDetailMaps.byKey.get(buildMbomDetailKey(order.mbomNoReg, order.outputPartCode))
    || null;
  const mbomProcess = order.mbomProcess || mbomProcessesById.get(order.mbomProcessId) || null;
  const outputPartFromOrder = partIdentityMaps.byId.get(order.outputPartId)
    || partIdentityMaps.byCode.get(order.outputPartCode)
    || {};
  const outputPart = hasMeaningfulValue(mbomDetail?.part?.partCode)
    ? mbomDetail.part
    : outputPartFromOrder;
  const outputBase = getPreferredPartBase(outputPart);
  const machine = mbomProcess?.machine || null;
  const cycleTime = order.cycleTime ?? mbomProcess?.cycleTime ?? null;

  return {
    ...order,
    mbomDetail,
    mbomProcess,
    operationLevelComponent: mbomDetail?.levelComponent ?? null,
    outputPartCode: coalesceValue(order.outputPartCode, outputPart.partCode),
    outputPartNumber: coalesceValue(order.outputPartNumber, outputPart.partNumber),
    outputPartName: coalesceValue(order.outputPartName, outputPart.partName),
    spec: coalesceValue(order.spec, outputPart.material?.spec),
    thickness: coalesceValue(order.thickness, outputBase.thickness),
    width: coalesceValue(order.width, outputBase.width),
    CSP: coalesceValue(order.CSP, outputBase.CSP),
    cycleTime,
    machineId: coalesceValue(order.machineId, mbomProcess?.machineId),
    machine,
    machineCode: coalesceValue(order.machineCode, machine?.machineCode),
    machineCostingRate: order.machineCostingRate ?? machine?.costingRate ?? null,
    machineRateType: coalesceValue(order.machineRateType, machine?.costingRateType),
    machineCurrency: coalesceValue(order.machineCurrency, machine?.currencyCode),
    plannedProcessCost: order.plannedVendorCost ?? order.plannedProcessCost ?? getPlannedProcessCost(cycleTime, machine),
    actualProcessCost: order.actualVendorCost ?? order.actualProcessCost ?? 0,
  };
}

async function getActiveMbomHeader(tx, partId) {
  if (!partId) return null;

  const now = new Date();
  return tx.mBOMHeader.findFirst({
    where: {
      partId,
      isDeleted: false,
      OR: [{ effectiveDate: null }, { effectiveDate: { lte: now } }],
      AND: [{ OR: [{ expiryDate: null }, { expiryDate: { gte: now } }] }],
    },
    include: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          material: { select: { spec: true } },
          partBases: {
            select: { baseOn: true, thickness: true, width: true, CSP: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
    orderBy: [{ effectiveDate: "desc" }, { revision: "desc" }],
  });
}

async function resolveDefaultVendorForPart(tx, partId) {
  if (!partId) return null;

  const priceLists = await tx.vendorPriceList.findMany({
    where: {
      partId,
      vendorId: { not: null },
      isDeleted: false,
      vendor: { is: { isDeleted: false } },
    },
    include: {
      vendor: {
        select: {
          vendorCode: true,
          vendorName: true,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 5,
  });

  const vendors = new Map();
  for (const row of priceLists) {
    if (row.vendor?.vendorCode) vendors.set(row.vendor.vendorCode, row.vendor);
  }

  return vendors.size === 1 ? [...vendors.values()][0] : null;
}

async function getVendorRoutingOperations(tx, mo) {
  const mbomHeader = await getActiveMbomHeader(tx, mo.partId);
  if (!mbomHeader) return { mbomHeader: null, operations: [] };

  const details = await tx.mBOMDetail.findMany({
    where: {
      noReg: mbomHeader.noReg,
      isDeleted: false,
      category: { in: ["inHouse", "Vendor"] },
    },
    include: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          material: { select: { spec: true } },
          partBases: {
            select: { baseOn: true, thickness: true, width: true, CSP: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
      uom: { select: { uomCode: true } },
      mbomProcesses: {
        where: { isDeleted: false },
        include: {
          process: {
            select: {
              id: true,
              processCode: true,
              processName: true,
            },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
    orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
  });

  const allProcesses = details.flatMap((detail) =>
    detail.mbomProcesses.map((process) => ({
      detail,
      process,
      sequence: process.sequence || 0,
    })),
  );
  const maxSequence = allProcesses.reduce((max, row) => Math.max(max, row.sequence), 0);
  const operations = [];

  for (const { detail, process, sequence } of allProcesses) {
    if (detail.category !== "Vendor") continue;

    const isFinalOperation = sequence === maxSequence;
    const outputPart = isFinalOperation ? mbomHeader.part : detail.part;
    const outputIdentity = resolvePartIdentity(outputPart);
    const inputIdentity = resolvePartIdentity(detail.part);
    const vendor = await resolveDefaultVendorForPart(tx, detail.partId);
    const qtyPlanned = roundQuantity(toNumber(detail.qty, 1) * toNumber(mo.qtyPlanned, 1));

    operations.push({
      mbomHeader,
      detail,
      process,
      sequence,
      isFinalOperation,
      vendor,
      qtyPlanned,
      inputPart: detail.part,
      inputIdentity,
      outputPart,
      outputIdentity,
      stockType: isFinalOperation ? FINAL_STOCK_TYPE : WIP_STOCK_TYPE,
    });
  }

  operations.sort((a, b) => a.sequence - b.sequence);
  return { mbomHeader, operations };
}

async function findStockBalance(tx, order, body = {}) {
  if (body.sourceStockBalanceId) {
    return tx.stockBalance.findFirst({
      where: { id: body.sourceStockBalanceId, uomCode: order.uomCode || null, isDeleted: false },
    });
  }

  const warehouseCode = normalizeText(body.sourceWarehouseCode || body.warehouseCode);
  if (!warehouseCode) return null;

  const partCode = normalizeText(body.partCode)
    || normalizeText(body.sourcePartCode)
    || order.inputPartCode
    || order.outputPartCode
    || null;
  const exactRackCode = normalizeText(body.sourceRackCode || body.rackCode);
  const exactLotNumber = normalizeText(body.sourceLotNumber || body.lotNumber);

  const exactMatch = await tx.stockBalance.findFirst({
    where: {
      warehouseCode,
      rackCode: exactRackCode,
      lotNumber: exactLotNumber,
      partCode,
      uomCode: order.uomCode || null,
      isDeleted: false,
    },
    orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
  });
  if (exactMatch) return exactMatch;

  return tx.stockBalance.findFirst({
    where: {
      warehouseCode,
      partCode,
      uomCode: order.uomCode || null,
      stockType: WIP_STOCK_TYPE,
      isDeleted: false,
      qtyAvailable: { gt: 0 },
      AND: [buildExcludeSpecialRackCondition()],
    },
    orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
  });
}

async function findPreviousWipBalances(tx, order, body = {}) {
  const sourcePartCode = normalizeText(body.sourcePartCode)
    || normalizeText(body.partCode)
    || order.inputPartCode
    || order.outputPartCode
    || null;
  if (!sourcePartCode) {
    throw Object.assign(new Error("Part WIP sumber untuk kirim vendor tidak ditemukan."), {
      statusCode: 400,
    });
  }

  const sourceWarehouseCode = normalizeText(body.sourceWarehouseCode || body.warehouseCode);
  const sourceRackCode = normalizeText(body.sourceRackCode || body.rackCode);
  const selectedBalanceIds = Array.isArray(body.sourceStockBalanceIds)
    ? [...new Set(body.sourceStockBalanceIds.map(normalizeText).filter(Boolean))]
    : [];

  return tx.stockBalance.findMany({
    where: {
      AND: [
        {
          ...(selectedBalanceIds.length ? { id: { in: selectedBalanceIds } } : {}),
          partCode: sourcePartCode,
          ...(sourceWarehouseCode ? { warehouseCode: sourceWarehouseCode } : {}),
          ...(sourceRackCode ? { rackCode: sourceRackCode } : {}),
          uomCode: order.uomCode || null,
          stockType: WIP_STOCK_TYPE,
          isDeleted: false,
          qtyAvailable: { gt: 0 },
        },
        buildExcludeSpecialRackCondition(),
      ],
    },
    orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
  });
}

function parseVendorSchedulePhase(notes) {
  const text = String(notes || "");
  const markerIndex = text.indexOf("phase ");
  if (markerIndex < 0) return {};
  const jsonStart = text.indexOf("{", markerIndex);
  if (jsonStart < 0) return {};

  try {
    return JSON.parse(text.slice(jsonStart));
  } catch (_error) {
    return {};
  }
}

function vendorScheduleDate(order) {
  const phase = parseVendorSchedulePhase(order?.notes);
  return phase.sendDate || order?.orderDate || order?.dueDate || null;
}

async function consumeSourceBalancesForVendorSend(tx, order, balances, qty, now, performedBy, sourceContext = {}) {
  const requiredQty = roundQuantity(qty);
  const availableQty = balances.reduce((sum, balance) => sum + toNumber(balance.qtyAvailable), 0);
  if (availableQty + QUANTITY_TOLERANCE < requiredQty) {
    const sourcePartCode = sourceContext.partCode || order.inputPartCode || order.outputPartCode || "-";
    throw Object.assign(
      new Error(`Stock WIP ${sourcePartCode} untuk kirim vendor tidak cukup. Tersedia ${availableQty}, dibutuhkan ${requiredQty}.`),
      { statusCode: 400 },
    );
  }

  const movements = [];
  let remaining = requiredQty;
  for (const balance of balances) {
    if (remaining <= QUANTITY_TOLERANCE) break;

    const qtyOut = roundQuantity(Math.min(toNumber(balance.qtyAvailable), remaining));
    if (qtyOut <= 0) continue;

    await assertStockBalanceNotFrozen(tx, balance.id);

    const qtyBefore = toNumber(balance.qtyOnHand);
    const qtyReserved = toNumber(balance.qtyReserved);
    const qtyQC = toNumber(balance.qtyQC);
    const qtyAfter = roundQuantity(Math.max(0, qtyBefore - qtyOut));
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyAvailable: Math.max(0, qtyAfter - qtyReserved - qtyQC),
        lastMovement: now,
      },
    });

    movements.push({
      warehouseCode: balance.warehouseCode,
      rackCode: balance.rackCode || null,
      lotNumber: balance.lotNumber || null,
      partCode: balance.partCode || sourceContext.partCode || order.inputPartCode || order.outputPartCode || null,
      partNumber: balance.partNumber || sourceContext.partNumber || order.inputPartNumber || order.outputPartNumber || null,
      partName: balance.partName || sourceContext.partName || order.inputPartName || order.outputPartName || null,
      productId: balance.productId || null,
      description: balance.description || null,
      spec: balance.spec || sourceContext.spec || order.spec || null,
      thickness: balance.thickness ?? sourceContext.thickness ?? order.thickness ?? null,
      width: balance.width ?? sourceContext.width ?? order.width ?? null,
      CSP: balance.CSP || sourceContext.CSP || order.CSP || null,
      stockType: balance.stockType || WIP_STOCK_TYPE,
      qty: qtyOut,
      qtyBefore,
      qtyAfter,
      referenceType: "VENDOR_PROCESS_ORDER",
      referenceNumber: order.orderNumber,
      notes: `Consume WIP ${balance.partCode || sourceContext.partCode || order.inputPartCode || ""} untuk kirim vendor ${order.vendorCode || ""} (${order.orderNumber})`.trim(),
      performedBy,
    });

    remaining = roundQuantity(remaining - qtyOut);
  }

  return movements;
}

async function restoreStockBalanceFromMovement(tx, movement, now = new Date()) {
  if (!movement?.warehouseCode || !movement?.partCode) return null;

  const existingBalance = await tx.stockBalance.findFirst({
    where: {
      warehouseCode: movement.warehouseCode,
      rackCode: movement.rackCode || null,
      lotNumber: movement.lotNumber || null,
      partCode: movement.partCode,
      productId: movement.productId || null,
      description: movement.description || null,
      spec: movement.spec || null,
      thickness: movement.thickness ?? null,
      width: movement.width ?? null,
      CSP: movement.CSP || null,
      partNumber: movement.partNumber || null,
      uomCode: movement.uomCode || null,
      isDeleted: false,
    },
    select: {
      id: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
    },
  });

  const qty = roundQuantity(toNumber(movement.qty));
  if (existingBalance) {
    await assertStockBalanceNotFrozen(tx, existingBalance.id);
    const qtyOnHand = roundQuantity(toNumber(existingBalance.qtyOnHand) + qty);
    const qtyReserved = toNumber(existingBalance.qtyReserved);
    const qtyQC = toNumber(existingBalance.qtyQC);
    return tx.stockBalance.update({
      where: { id: existingBalance.id },
      data: {
        qtyOnHand,
        qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
        lastMovement: now,
      },
    });
  }

  await assertStockIdentityNotFrozen(tx, {
    warehouseCode: movement.warehouseCode,
    rackCode: movement.rackCode || null,
    lotNumber: movement.lotNumber || null,
    stockType: movement.stockType || WIP_STOCK_TYPE,
  });
  return tx.stockBalance.create({
    data: {
      warehouseCode: movement.warehouseCode,
      rackCode: movement.rackCode || null,
      lotNumber: movement.lotNumber || null,
      partCode: movement.partCode,
      partNumber: movement.partNumber || null,
      partName: movement.partName || null,
      productId: movement.productId || null,
      description: movement.description || null,
      spec: movement.spec || null,
      thickness: movement.thickness ?? null,
      width: movement.width ?? null,
      CSP: movement.CSP || null,
      uomCode: movement.uomCode || null,
      stockType: movement.stockType || WIP_STOCK_TYPE,
      qtyOnHand: qty,
      qtyReserved: 0,
      qtyQC: 0,
      qtyAvailable: qty,
      lastMovement: now,
    },
  });
}

async function findWorkOrderOutputSource(tx, order, body = {}) {
  const woNumber = normalizeText(body.sourceWoNumber || body.woNumber);
  const woId = normalizeText(body.sourceWoId || body.woId);
  if (!woNumber && !woId) return null;
  const previousSequence = await tx.workOrder.findFirst({
    where: {
      moId: order.moId,
      isDeleted: false,
      status: "Completed",
      sequence: { lt: order.sequence || 0 },
    },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  if (!previousSequence) return null;

  const source = await tx.workOrder.findFirst({
    where: {
      ...(woId ? { id: woId } : { woNumber }),
      moId: order.moId,
      isDeleted: false,
      status: "Completed",
      sequence: previousSequence.sequence,
    },
    include: {
      process: { select: { processCode: true, processName: true } },
      mbomDetail: {
        select: {
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              material: { select: { spec: true } },
              partBases: {
                select: { baseOn: true, thickness: true, width: true, CSP: true },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
      },
      manufacturingOrder: {
        select: {
          moNumber: true,
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              material: { select: { spec: true } },
              partBases: {
                select: { baseOn: true, thickness: true, width: true, CSP: true },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
      },
    },
  });
  if (!source) return null;

  const alreadySent = await tx.stockMovement.aggregate({
    where: {
      transactionType: "VENDOR_SEND",
      referenceType: "WORK_ORDER",
      referenceNumber: source.woNumber,
      isDeleted: false,
    },
    _sum: { qty: true },
  });
  const qtyAvailable = Math.max(0, roundQuantity(toNumber(source.qtyGood) - toNumber(alreadySent._sum.qty)));
  const sourcePart = source.mbomDetail?.part || source.manufacturingOrder?.part || null;
  const sourcePartBase = sourcePart?.partBases?.find((base) => String(base.baseOn || "").toUpperCase() === "PART")
    || sourcePart?.partBases?.[0]
    || null;

  return {
    ...source,
    qtyAvailable,
    sourcePartCode: sourcePart?.partCode || null,
    sourcePartNumber: sourcePart?.partNumber || null,
    sourcePartName: sourcePart?.partName || null,
    sourceSpec: sourcePart?.material?.spec || null,
    sourceThickness: sourcePartBase?.thickness ?? null,
    sourceWidth: sourcePartBase?.width ?? null,
    sourceCSP: sourcePartBase?.CSP || null,
  };
}

function getRollbackableVendorSendStatus(order = {}) {
  const qtySent = roundQuantity(toNumber(order.qtySent));
  if (qtySent <= QUANTITY_TOLERANCE) {
    return order.vendorCode ? "Waiting Material" : "Planned";
  }
  return "Sent";
}

async function reduceReceivedQcHoldStock(tx, movement, now = new Date()) {
  if (!movement?.warehouseCode || !movement?.partCode) return null;

  const existingBalance = await tx.stockBalance.findFirst({
    where: {
      warehouseCode: movement.warehouseCode,
      rackCode: movement.rackCode || null,
      lotNumber: movement.lotNumber || null,
      partCode: movement.partCode,
      productId: movement.productId || null,
      description: movement.description || null,
      spec: movement.spec || null,
      thickness: movement.thickness ?? null,
      width: movement.width ?? null,
      CSP: movement.CSP || null,
      partNumber: movement.partNumber || null,
      uomCode: movement.uomCode || null,
      stockType: movement.stockType || WIP_STOCK_TYPE,
      isDeleted: false,
    },
    select: {
      id: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
    },
  });

  if (!existingBalance) return null;

  await assertStockBalanceNotFrozen(tx, existingBalance.id);
  const qty = roundQuantity(toNumber(movement.qty));
  const qtyOnHand = Math.max(0, roundQuantity(toNumber(existingBalance.qtyOnHand) - qty));
  const qtyQC = Math.max(0, roundQuantity(toNumber(existingBalance.qtyQC) - qty));
  const qtyReserved = toNumber(existingBalance.qtyReserved);

  return tx.stockBalance.update({
    where: { id: existingBalance.id },
    data: {
      qtyOnHand,
      qtyQC,
      qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - qtyQC),
      lastMovement: now,
    },
  });
}

async function assertVendorProcessSequenceReady(tx, order) {
  const capacityAllocationId = String(order?.notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
  if (capacityAllocationId) {
    const allocation = await tx.productionPlanAllocation.findFirst({
      where: { id: capacityAllocationId, isDeleted: false },
      select: { predecessorAllocationIds: true },
    });
    const predecessorIds = Array.isArray(allocation?.predecessorAllocationIds)
      ? allocation.predecessorAllocationIds.filter(Boolean)
      : [];
    if (!predecessorIds.length) return;
    const completedPredecessors = await tx.dailyProductionSchedule.findMany({
      where: {
        moId: order.moId,
        productionPlanAllocationId: { in: predecessorIds },
        isDeleted: false,
        status: "Completed",
      },
      select: { productionPlanAllocationId: true },
    });
    const completedIds = new Set(completedPredecessors.map((row) => row.productionPlanAllocationId));
    const missingIds = predecessorIds.filter((id) => !completedIds.has(id));
    if (!missingIds.length) return;
    const blockers = await tx.dailyProductionSchedule.findMany({
      where: { moId: order.moId, productionPlanAllocationId: { in: missingIds }, isDeleted: false },
      select: { scheduleNumber: true, status: true },
      orderBy: [{ scheduleDate: "asc" }, { scheduleNumber: "asc" }],
    });
    const label = blockers.length
      ? blockers.map((row) => `${row.scheduleNumber} (${row.status})`).join(", ")
      : `${missingIds.length} predecessor DPP belum terbit`;
    throw Object.assign(new Error(`Vendor Process belum bisa dikirim. Predecessor DPP belum selesai: ${label}.`), { statusCode: 409 });
  }

  if (!order?.moId || order.sequence === null || order.sequence === undefined) {
    return;
  }

  const [previousWorkOrder, previousVendorOrder] = await Promise.all([
    tx.workOrder.findFirst({
      where: {
        moId: order.moId,
        isDeleted: false,
        sequence: { lt: order.sequence },
        status: { notIn: ["Completed", "Cancelled"] },
      },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      select: { woNumber: true, sequence: true, status: true },
    }),
    tx.vendorProcessOrder.findFirst({
      where: {
        moId: order.moId,
        isDeleted: false,
        id: { not: order.id },
        sequence: { lt: order.sequence },
        status: { notIn: ["Completed", "Closed", "Cancelled"] },
      },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      select: { orderNumber: true, sequence: true, status: true },
    }),
  ]);

  const blockers = [previousWorkOrder, previousVendorOrder]
    .filter(Boolean)
    .sort((a, b) => toNumber(a.sequence) - toNumber(b.sequence));
  const blocker = blockers[0];
  if (!blocker) return;

  const referenceNumber = blocker.woNumber || blocker.orderNumber || "-";
  throw Object.assign(
    new Error(
      `Vendor Process belum bisa dikirim. Proses sebelumnya belum selesai: ${referenceNumber} (seq ${blocker.sequence}, ${blocker.status}).`,
    ),
    { statusCode: 409 },
  );
}

async function resolveInternalRackCode(tx, rackCode) {
  const normalizedRackCode = normalizeText(rackCode);
  if (!normalizedRackCode) return null;

  const rack = await tx.rack.findFirst({
    where: {
      rackCode: normalizedRackCode,
      isDeleted: false,
    },
    select: { rackCode: true },
  });

  return rack?.rackCode || null;
}

async function receiveVendorOutputToQc(tx, order, body, performedBy) {
  const qty = roundQuantity(toNumber(body.qtyReceived || body.qty));
  const warehouseCode = normalizeText(body.warehouseCode || body.receiveWarehouseCode);
  const rackCode = normalizeText(body.rackCode || body.receiveRackCode);
  const lotNumber = normalizeText(body.lotNumber || body.receiveLotNumber);

  if (qty <= 0) {
    throw Object.assign(new Error("Qty received harus lebih dari 0."), { statusCode: 400 });
  }
  if (!warehouseCode) {
    throw Object.assign(new Error("Warehouse penerimaan wajib diisi."), { statusCode: 400 });
  }
  if (!order.outputPartCode) {
    throw Object.assign(new Error("Output part vendor process belum tersedia."), { statusCode: 400 });
  }

  const remainingSent = roundQuantity(toNumber(order.qtySent) - toNumber(order.qtyReceived));
  if (remainingSent + QUANTITY_TOLERANCE < qty && body.allowOverReceive !== true) {
    throw Object.assign(new Error("Qty received melebihi qty yang sudah dikirim ke vendor."), {
      statusCode: 400,
    });
  }

  if (order.vendorWarehouseCode) {
    const vendorBalance = await tx.stockBalance.findFirst({
      where: {
        warehouseCode: order.vendorWarehouseCode,
        rackCode: order.vendorRackCode || null,
        lotNumber: order.vendorLotNumber || null,
        partCode: order.inputPartCode || order.outputPartCode,
        uomCode: order.uomCode || null,
        stockType: VENDOR_WIP_STOCK_TYPE,
        isDeleted: false,
      },
      select: {
        id: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyQC: true,
      },
    });

    if (vendorBalance) {
      await assertStockBalanceNotFrozen(tx, vendorBalance.id);
      const qtyOut = Math.min(qty, toNumber(vendorBalance.qtyOnHand));
      const qtyOnHand = roundQuantity(toNumber(vendorBalance.qtyOnHand) - qtyOut);
      const qtyReserved = Math.max(0, roundQuantity(toNumber(vendorBalance.qtyReserved) - qtyOut));
      if (qtyOut > 0) {
        const vendorOutMovementNumber = await generateMovementNumber("OUT", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber: vendorOutMovementNumber,
            movementDate: new Date(),
            movementType: "OUT",
            direction: "OUT",
            transactionType: "VENDOR_RECEIVE",
            warehouseCode: order.vendorWarehouseCode,
            rackCode: order.vendorRackCode || null,
            lotNumber: order.vendorLotNumber || null,
            partCode: order.inputPartCode || order.outputPartCode || null,
            partNumber: order.inputPartNumber || order.outputPartNumber || null,
            partName: order.inputPartName || order.outputPartName || null,
            spec: order.spec || null,
            thickness: order.thickness ?? null,
            width: order.width ?? null,
            CSP: order.CSP || null,
            stockType: VENDOR_WIP_STOCK_TYPE,
            qty: qtyOut,
            deltaQty: -qtyOut,
            qtyBefore: toNumber(vendorBalance.qtyOnHand),
            qtyAfter: qtyOnHand,
            uomCode: order.uomCode || null,
            referenceType: "VENDOR_PROCESS_ORDER",
            referenceNumber: order.orderNumber,
            notes: `Vendor WIP consumed on receipt ${order.orderNumber}`,
            performedBy,
          },
        });
      }
      await tx.stockBalance.update({
        where: { id: vendorBalance.id },
        data: {
          qtyOnHand,
          qtyReserved,
          qtyAvailable: Math.max(0, qtyOnHand - qtyReserved - toNumber(vendorBalance.qtyQC)),
          lastMovement: new Date(),
        },
      });
    }
  }

  const stockIdentity = stockIdentityFromOrder(order);
  const existingBalance = await tx.stockBalance.findFirst({
    where: {
      warehouseCode,
      rackCode,
      lotNumber,
      partCode: order.outputPartCode,
      ...stockIdentity,
      uomCode: order.uomCode || null,
      stockType: order.stockType || WIP_STOCK_TYPE,
      isDeleted: false,
    },
    select: {
      id: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
    },
  });

  const now = body.receivedAt ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw Object.assign(new Error("Tanggal penerimaan tidak valid."), { statusCode: 400 });
  }
  const qtyBefore = toNumber(existingBalance?.qtyOnHand);
  const qtyAfter = roundQuantity(qtyBefore + qty);
  const qtyQC = roundQuantity(toNumber(existingBalance?.qtyQC) + qty);
  const movementNumber = await generateMovementNumber("IN", tx);

  await tx.stockMovement.create({
    data: {
      movementNumber,
      movementDate: now,
      movementType: "IN",
      direction: "IN",
      transactionType: "QC_HOLD",
      warehouseCode,
      rackCode,
      lotNumber,
      partCode: order.outputPartCode,
      partNumber: order.outputPartNumber || null,
      partName: order.outputPartName || null,
      ...stockIdentity,
      stockType: order.stockType || WIP_STOCK_TYPE,
      qty,
      deltaQty: qty,
      qtyBefore,
      qtyAfter,
      qualityBucket: "GOOD",
      uomCode: order.uomCode || null,
      referenceType: "VENDOR_PROCESS_ORDER",
      referenceNumber: order.orderNumber,
      notes: [
        `${order.stockType === FINAL_STOCK_TYPE ? "FG" : "WIP"} vendor output ${order.orderNumber} masuk QC Hold`,
        normalizeText(body.deliveryNoteNumber) ? `Surat jalan vendor: ${normalizeText(body.deliveryNoteNumber)}` : null,
        normalizeText(body.notes),
      ].filter(Boolean).join(" · "),
      performedBy,
    },
  });

  if (existingBalance) {
    await assertStockBalanceNotFrozen(tx, existingBalance.id);
    await tx.stockBalance.update({
      where: { id: existingBalance.id },
      data: {
        qtyOnHand: qtyAfter,
        qtyQC,
        qtyAvailable: Math.max(0, qtyAfter - toNumber(existingBalance.qtyReserved) - qtyQC),
        lastMovement: now,
      },
    });
  } else {
    await assertStockIdentityNotFrozen(tx, {
      warehouseCode,
      rackCode,
      lotNumber,
      stockType: order.stockType || WIP_STOCK_TYPE,
    });
    await tx.stockBalance.create({
      data: {
        warehouseCode,
        rackCode,
        lotNumber,
        partCode: order.outputPartCode,
        partNumber: order.outputPartNumber || null,
        partName: order.outputPartName || null,
        ...stockIdentity,
        uomCode: order.uomCode || null,
        stockType: order.stockType || WIP_STOCK_TYPE,
        qtyOnHand: qty,
        qtyReserved: 0,
        qtyQC: qty,
        qtyAvailable: 0,
        lastMovement: now,
      },
    });
  }

  return { movementNumber, qty, receivedAt: now };
}

async function createVendorReceiptQualityInspection(tx, order, receipt, body, performedBy) {
  if (!order.moId) {
    throw Object.assign(new Error("MO sumber Vendor Process belum tersedia; QC Inspection tidak dapat dibuat."), {
      statusCode: 409,
    });
  }

  const inspectionNumber = await generateConfiguredNumber("QUALITY_INSPECTION", {
    db: tx,
    context: { prefix: "QC" },
  });
  const receiptMarker = `[VPO-RECEIPT:${receipt.movementNumber}]`;
  const notes = [
    receiptMarker,
    `Penerimaan vendor ${order.orderNumber}; stock ditahan di QC Hold sampai inspeksi selesai. Dibuat oleh ${performedBy}.`,
    normalizeText(body.deliveryNoteNumber) ? `Surat jalan vendor: ${normalizeText(body.deliveryNoteNumber)}` : null,
    normalizeText(body.notes),
  ].filter(Boolean).join(" ");

  return tx.qualityInspection.create({
    data: {
      inspectionNumber,
      inspectionDate: receipt.receivedAt,
      moId: order.moId,
      vendorProcessOrderId: order.id,
      partId: order.outputPartId || null,
      batchNumber: normalizeText(body.lotNumber || body.receiveLotNumber) || null,
      sampleSize: 1,
      qtyInspected: receipt.qty,
      qtyPassed: 0,
      qtyFailed: 0,
      qtyRework: 0,
      decision: "Pending",
      inspectedBy: "Unassigned",
      status: "Draft",
      notes,
    },
    select: {
      id: true,
      inspectionNumber: true,
      inspectionDate: true,
      qtyInspected: true,
      status: true,
      decision: true,
    },
  });
}

async function generateVendorProcessOrdersFromRouting(tx, mo, options = {}) {
  const { requireVendorOperations = false, createdBy = null } = options;
  const capacityAllocationIds = Array.isArray(options.capacityAllocationIds)
    ? options.capacityAllocationIds.filter(Boolean)
    : [];
  const { mbomHeader, operations } = await getVendorRoutingOperations(tx, mo);
  if (!mbomHeader) {
    throw Object.assign(new Error(`MBOM aktif tidak ditemukan untuk MO ${mo.moNumber}.`), {
      statusCode: 400,
    });
  }
  const capacityVendorAllocations = mo.monthlyProductionPlanNumber && mo.monthlyProductionPlanLineNumber != null
    ? await tx.productionPlanAllocation.findMany({
      where: {
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        routingMode: "VENDOR",
        plan: { planNumber: mo.monthlyProductionPlanNumber, isDeleted: false },
        ...(capacityAllocationIds.length
          ? { id: { in: capacityAllocationIds } }
          : {
              OR: [
                { lineNumber: mo.monthlyProductionPlanLineNumber },
                {
                  dailyProductionSchedules: {
                    some: { moId: mo.id, shift: "VENDOR", isDeleted: false },
                  },
                },
              ],
            }),
      },
      include: {
        vendor: { select: { id: true, vendorCode: true, vendorName: true } },
        mbomProcess: {
          include: {
            process: { select: { id: true, processCode: true, processName: true } },
          },
        },
      },
      orderBy: [{ vendorSendDate: "asc" }, { scheduleDate: "asc" }, { createdAt: "asc" }],
    })
    : [];
  const capacityVendorProcessIds = new Set(capacityVendorAllocations.map((row) => row.mbomProcessId));
  const requestedStartSequence = toNumber(
    options.startSequence ?? mo?.sourceStartSequence,
    0,
  ) || inferStartSequenceFromSourcePartCode(operations, mo?.sourcePartCode);
  const bomVendorOperations = operations.filter((operation) => !capacityVendorProcessIds.has(operation.process.id));
  const scopedOperations = requestedStartSequence > 0
    ? bomVendorOperations.filter(operation => toNumber(operation.sequence) >= requestedStartSequence)
    : bomVendorOperations;
  if (scopedOperations.length === 0 && capacityVendorAllocations.length === 0) {
    if (requireVendorOperations) {
      throw Object.assign(new Error("Tidak ada MBOM Detail category Vendor untuk MO ini."), {
        statusCode: 400,
      });
    }
    return { created: [], existing: [], mbomNoReg: mbomHeader.noReg };
  }

  const created = [];
  const existing = [];
  for (const operation of scopedOperations) {
    const duplicate = await tx.vendorProcessOrder.findFirst({
      where: {
        moId: mo.id,
        mbomProcessId: operation.process.id,
        isDeleted: false,
      },
    });
    if (duplicate) {
      existing.push(duplicate);
      continue;
    }

    const orderNumber = await generateVendorProcessOrderNumber(tx);
    const costSnapshot = await resolveVendorPriceSnapshot(tx, {
      vendorCode: operation.vendor?.vendorCode || null,
      inputPartId: operation.inputPart?.id || null,
      inputPartCode: operation.inputPart?.partCode || null,
      outputPartId: operation.outputPart?.id || null,
      outputPartCode: operation.outputPart?.partCode || null,
      processCode: operation.process.process?.processCode || null,
      processName: operation.process.process?.processName || null,
      qtyPlanned: operation.qtyPlanned,
    });
    const order = await tx.vendorProcessOrder.create({
      data: {
        orderNumber,
        orderDate: new Date(),
        moId: mo.id,
        moNumber: mo.moNumber,
        mbomHeaderId: mbomHeader.id,
        mbomNoReg: mbomHeader.noReg,
        mbomDetailId: operation.detail.id,
        mbomProcessId: operation.process.id,
        processId: operation.process.processId,
        processCode: operation.process.process?.processCode || null,
        processName: operation.process.process?.processName || null,
        sequence: operation.sequence,
        vendorCode: operation.vendor?.vendorCode || null,
        vendorName: operation.vendor?.vendorName || null,
        inputPartId: operation.inputPart?.id || null,
        inputPartCode: operation.inputPart?.partCode || null,
        inputPartNumber: operation.inputPart?.partNumber || null,
        inputPartName: operation.inputPart?.partName || null,
        outputPartId: operation.outputPart?.id || null,
        outputPartCode: operation.outputPart?.partCode || null,
        outputPartNumber: operation.outputIdentity.partNumber || operation.outputPart?.partNumber || null,
        outputPartName: operation.outputIdentity.partName || operation.outputPart?.partName || null,
        spec: operation.outputIdentity.spec || null,
        thickness: operation.outputIdentity.thickness ?? null,
        width: operation.outputIdentity.width ?? null,
        CSP: operation.outputIdentity.CSP || null,
        stockType: operation.stockType,
        qtyPlanned: operation.qtyPlanned,
        uomCode: operation.detail.uomCode || mo.uomCode || null,
        ...costSnapshot,
        dueDate: mo.plannedEndDate || null,
        status: operation.vendor?.vendorCode ? "Waiting Material" : "Planned",
        createdBy,
        notes: `Generated from MBOM ${mbomHeader.noReg} vendor routing for ${operation.outputPart?.partCode || "output"}`,
      },
    });
    created.push(order);
  }

  if (capacityVendorAllocations.length > 0) {
    const { operations: inHouseOperations } = await getRoutingOperations(tx, mo);
    const capacityOperationByProcessId = new Map(inHouseOperations.map((operation) => [operation.process?.id, operation]));
    // A capacity recommendation may keep an existing Vendor-category routing
    // as vendor work, not only redirect an in-house route. Adapt those vendor
    // operations to the same component identity used by capacity VPOs.
    for (const vendorOperation of operations) {
      capacityOperationByProcessId.set(vendorOperation.process?.id, {
        mbomDetailId: vendorOperation.detail?.id || null,
        componentPartId: vendorOperation.inputPart?.id || null,
        componentPartCode: vendorOperation.inputPart?.partCode || null,
        componentPartNumber: vendorOperation.inputPart?.partNumber || null,
        componentPartName: vendorOperation.inputPart?.partName || null,
        uomCode: vendorOperation.detail?.uomCode || mo.uomCode || null,
        sequence: vendorOperation.sequence || 0,
      });
    }
    for (const allocation of capacityVendorAllocations) {
      const operation = capacityOperationByProcessId.get(allocation.mbomProcessId);
      if (!operation) continue;
      const marker = `[CAPACITY-VENDOR:${allocation.id}]`;
      const duplicate = await tx.vendorProcessOrder.findFirst({
        where: { moId: mo.id, isDeleted: false, notes: { contains: marker } },
      });
      if (duplicate) {
        existing.push(duplicate);
        continue;
      }
      const qtyPlanned = roundQuantity(toNumber(allocation.plannedQty));
      const dueDate = allocation.vendorReturnDate || allocation.scheduleDate || mo.plannedEndDate || null;
      const orderNumber = await generateVendorProcessOrderNumber(tx);
      const predecessorAllocationIds = Array.isArray(allocation.predecessorAllocationIds)
        ? allocation.predecessorAllocationIds.filter(Boolean)
        : [];
      const predecessorDailyPlan = predecessorAllocationIds.length
        ? await tx.dailyProductionSchedule.findFirst({
            where: {
              moId: mo.id,
              productionPlanAllocationId: { in: predecessorAllocationIds },
              isDeleted: false,
              woId: { not: null },
            },
            select: { woId: true },
            orderBy: [{ scheduleDate: "desc" }, { createdAt: "desc" }],
          })
        : null;
      const predecessorWorkOrder = predecessorDailyPlan?.woId
        ? await tx.workOrder.findFirst({
            where: { id: predecessorDailyPlan.woId, isDeleted: false },
            select: {
              outputPartId: true,
              outputPartCode: true,
              outputPartNumber: true,
              outputPartName: true,
            },
          })
        : null;
      const inputPart = {
        id: predecessorWorkOrder?.outputPartId || operation.componentPartId || null,
        code: predecessorWorkOrder?.outputPartCode || operation.componentPartCode || null,
        number: predecessorWorkOrder?.outputPartNumber || operation.componentPartNumber || null,
        name: predecessorWorkOrder?.outputPartName || operation.componentPartName || null,
      };
      const costSnapshot = await resolveVendorPriceSnapshot(tx, {
        vendorCode: allocation.vendor?.vendorCode || null,
        inputPartId: inputPart.id,
        inputPartCode: inputPart.code,
        outputPartId: operation.componentPartId || null,
        outputPartCode: operation.componentPartCode || null,
        processCode: allocation.mbomProcess?.process?.processCode || null,
        processName: allocation.mbomProcess?.process?.processName || null,
        qtyPlanned,
      });
      const phase = {
        allocationId: allocation.id,
        sendDate: allocation.vendorSendDate || allocation.scheduleDate,
        returnDate: allocation.vendorReturnDate || allocation.scheduleDate,
        qtySend: allocation.plannedQty,
        expectedReturnQty: allocation.expectedReturnQty ?? allocation.plannedQty,
      };
      created.push(await tx.vendorProcessOrder.create({
        data: {
          orderNumber,
          orderDate: new Date(),
          moId: mo.id,
          moNumber: mo.moNumber,
          mbomHeaderId: mbomHeader.id,
          mbomNoReg: mbomHeader.noReg,
          mbomDetailId: operation.mbomDetailId || null,
          mbomProcessId: allocation.mbomProcessId,
          processId: allocation.mbomProcess?.processId || operation.processId || null,
          processCode: allocation.mbomProcess?.process?.processCode || null,
          processName: allocation.mbomProcess?.process?.processName || null,
          sequence: operation.sequence || 0,
          vendorCode: allocation.vendor?.vendorCode || null,
          vendorName: allocation.vendor?.vendorName || null,
          inputPartId: inputPart.id,
          inputPartCode: inputPart.code,
          inputPartNumber: inputPart.number,
          inputPartName: inputPart.name,
          outputPartId: operation.componentPartId || null,
          outputPartCode: operation.componentPartCode || null,
          outputPartNumber: operation.componentPartNumber || null,
          outputPartName: operation.componentPartName || null,
          stockType: WIP_STOCK_TYPE,
          qtyPlanned,
          uomCode: operation.uomCode || mo.uomCode || null,
          ...costSnapshot,
          dueDate,
          status: allocation.vendor?.vendorCode ? "Waiting Material" : "Planned",
          createdBy,
          notes: `${marker} Internal BOM process dialihkan ke vendor dari Capacity Planning; phase ${JSON.stringify(phase)}`,
        },
      }));
    }
  }

  return { created, existing, mbomNoReg: mbomHeader.noReg };
}

async function resolveVendorSendReadiness(tx, order) {
  const terminalStatuses = new Set(["Sent", "Partial Received", "QC Hold", "Completed", "Closed", "Cancelled"]);
  const storedStatus = order?.status || null;
  const materialRequiredQty = roundQuantity(Math.max(0, toNumber(order?.qtyPlanned) - toNumber(order?.qtySent)));
  const base = {
    materialRequiredQty,
    materialAvailableQty: 0,
    materialShortageQty: materialRequiredQty,
    materialReady: false,
    materialReadinessCode: "WAITING_MATERIAL",
    materialReadinessMessage: `Menunggu WIP ${order?.inputPartCode || "input vendor"} tersedia ${materialRequiredQty} ${order?.uomCode || ""}.`.trim(),
  };

  if (terminalStatuses.has(storedStatus) || materialRequiredQty <= QUANTITY_TOLERANCE) {
    return {
      ...base,
      status: storedStatus,
      materialAvailableQty: materialRequiredQty,
      materialShortageQty: 0,
      materialReady: materialRequiredQty <= QUANTITY_TOLERANCE,
      materialReadinessCode: "NOT_APPLICABLE",
      materialReadinessMessage: "Pengiriman vendor sudah diproses atau tidak memiliki sisa qty.",
    };
  }

  if (!order?.vendorCode) {
    return {
      ...base,
      status: "Planned",
      materialReadinessCode: "VENDOR_NOT_SELECTED",
      materialReadinessMessage: "Vendor belum dipilih.",
    };
  }

  try {
    await assertVendorProcessSequenceReady(tx, order);
  } catch (error) {
    return {
      ...base,
      status: "Waiting Material",
      materialReadinessCode: "PREDECESSOR_NOT_READY",
      materialReadinessMessage: error.message,
    };
  }

  const balances = await findPreviousWipBalances(tx, order);
  const materialAvailableQty = roundQuantity(
    balances.reduce((sum, balance) => sum + toNumber(balance.qtyAvailable), 0),
  );
  const materialShortageQty = roundQuantity(Math.max(0, materialRequiredQty - materialAvailableQty));
  const materialReady = materialShortageQty <= QUANTITY_TOLERANCE;
  return {
    ...base,
    status: materialReady
      ? (toNumber(order.qtySent) > QUANTITY_TOLERANCE ? "Partial Sent" : "Ready to Send")
      : "Waiting Material",
    materialAvailableQty,
    materialShortageQty,
    materialReady,
    materialReadinessCode: materialReady ? "READY" : "WAITING_MATERIAL",
    materialReadinessMessage: materialReady
      ? `WIP ${order.inputPartCode || "input vendor"} cukup: ${materialAvailableQty} ${order.uomCode || ""} tersedia untuk ${materialRequiredQty} ${order.uomCode || ""}.`.trim()
      : `WIP ${order.inputPartCode || "input vendor"} belum cukup: tersedia ${materialAvailableQty}, dibutuhkan ${materialRequiredQty}, kurang ${materialShortageQty} ${order.uomCode || ""}.`.trim(),
  };
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      moNumber,
      vendorCode,
      status,
      stockType,
    } = req.query;

    const where = {};
    where.isDeleted = isDeleted !== undefined ? isDeleted === "true" : false;
    if (moId) where.moId = moId;
    if (moNumber) where.moNumber = moNumber;
    if (vendorCode) where.vendorCode = vendorCode;
    if (stockType) where.stockType = stockType;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;
    if (q) {
      where.OR = [
        { orderNumber: { contains: q, mode: "insensitive" } },
        { moNumber: { contains: q, mode: "insensitive" } },
        { vendorCode: { contains: q, mode: "insensitive" } },
        { vendorName: { contains: q, mode: "insensitive" } },
        { processCode: { contains: q, mode: "insensitive" } },
        { processName: { contains: q, mode: "insensitive" } },
        { outputPartCode: { contains: q, mode: "insensitive" } },
        { outputPartName: { contains: q, mode: "insensitive" } },
      ];
    }

    const take = Number(limit);
    const skip = (Number(page) - 1) * take;
    const orderBy = buildSort(req.query, { defaultSort: { orderDate: "desc" } });
    const [items, total] = await Promise.all([
      prisma.vendorProcessOrder.findMany({ where, orderBy, skip, take }),
      prisma.vendorProcessOrder.count({ where }),
    ]);
    const [mbomDetailMaps, mbomProcessesById, partIdentityMaps] = await Promise.all([
      loadMbomDetailMapsForOrders(prisma, items),
      loadMbomProcessMap(prisma, items.map((item) => item.mbomProcessId)),
      loadPartIdentityMaps(prisma, items),
    ]);
    const inspectedGroups = items.length > 0
      ? await prisma.qualityInspection.groupBy({
          by: ["vendorProcessOrderId"],
          where: {
            vendorProcessOrderId: { in: items.map((item) => item.id) },
            isDeleted: false,
          },
          _sum: { qtyInspected: true },
        })
      : [];
    const inspectedByOrderId = new Map(
      inspectedGroups.map((row) => [row.vendorProcessOrderId, Number(row._sum.qtyInspected || 0)]),
    );

    const readinessByOrderId = new Map(await Promise.all(items.map(async (item) => [
      item.id,
      await resolveVendorSendReadiness(prisma, item),
    ])));

    res.json({
      items: items.map((item) => {
        const enrichedItem = enrichVendorProcessOrder(item, mbomDetailMaps, mbomProcessesById, partIdentityMaps);
        return {
          ...mapDoc(enrichedItem),
          ...readinessByOrderId.get(item.id),
          qcInspectedQty: inspectedByOrderId.get(item.id) || 0,
          qcRemainingQty: Math.max(0, Number(item.qtyReceived || 0) - (inspectedByOrderId.get(item.id) || 0)),
        };
      }),
      total,
      page: Number(page),
      limit: take,
    });
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.vendorProcessOrder.findFirst({
      where: {
        orderNumber: req.params.orderNumber,
        isDeleted: false,
      },
    });
    if (!item) return res.status(404).json({ message: "Vendor Process Order tidak ditemukan." });
    const [mbomDetailMaps, mbomProcessesById, partIdentityMaps] = await Promise.all([
      loadMbomDetailMapsForOrders(prisma, [item]),
      loadMbomProcessMap(prisma, [item.mbomProcessId]),
      loadPartIdentityMaps(prisma, [item]),
    ]);
    const [readiness, receiptMovements, qualityInspections] = await Promise.all([
      resolveVendorSendReadiness(prisma, item),
      prisma.stockMovement.findMany({
        where: {
          referenceType: "VENDOR_PROCESS_ORDER",
          referenceNumber: item.orderNumber,
          transactionType: "QC_HOLD",
          movementType: "IN",
          isDeleted: false,
        },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
        select: {
          movementNumber: true,
          movementDate: true,
          qty: true,
          uomCode: true,
          warehouseCode: true,
          rackCode: true,
          lotNumber: true,
          notes: true,
          performedBy: true,
        },
      }),
      prisma.qualityInspection.findMany({
        where: { vendorProcessOrderId: item.id, isDeleted: false },
        orderBy: [{ inspectionDate: "desc" }, { createdAt: "desc" }],
        select: {
          inspectionNumber: true,
          inspectionDate: true,
          qtyInspected: true,
          qtyPassed: true,
          qtyFailed: true,
          decision: true,
          status: true,
          notes: true,
        },
      }),
    ]);
    const inspectionsByMovement = new Map();
    qualityInspections.forEach((inspection) => {
      const marker = String(inspection.notes || "").match(/\[VPO-RECEIPT:([^\]]+)\]/)?.[1];
      if (marker) inspectionsByMovement.set(marker, inspection);
    });
    const receiptHistory = receiptMovements.map((movement) => ({
      ...movement,
      qualityInspection: inspectionsByMovement.get(movement.movementNumber) || null,
    }));
    const qcInspectedQty = qualityInspections.reduce(
      (sum, inspection) => sum + toNumber(inspection.qtyInspected),
      0,
    );
    res.json({
      ...mapDoc(enrichVendorProcessOrder(item, mbomDetailMaps, mbomProcessesById, partIdentityMaps)),
      ...readiness,
      qcInspectedQty,
      qcRemainingQty: Math.max(0, toNumber(item.qtyReceived) - qcInspectedQty),
      receiptHistory: mapDoc(receiptHistory),
      qualityInspections: mapDoc(qualityInspections),
    });
  } catch (err) {
    next(err);
  }
};

exports.getSendOptions = async (req, res, next) => {
  try {
    const order = await prisma.vendorProcessOrder.findFirst({
      where: { orderNumber: req.params.orderNumber, isDeleted: false },
    });
    if (!order) return res.status(404).json({ message: "Vendor Process Order tidak ditemukan." });

    const currentReadiness = await resolveVendorSendReadiness(prisma, order);
    const balances = await findPreviousWipBalances(prisma, order);
    const warehouseCodes = [...new Set(balances.map((row) => row.warehouseCode).filter(Boolean))];
    const rackCodes = [...new Set(balances.map((row) => row.rackCode).filter(Boolean))];
    const [warehouses, racks] = await Promise.all([
      warehouseCodes.length
        ? prisma.warehouse.findMany({
          where: { warehouseCode: { in: warehouseCodes }, isDeleted: false, isActive: true },
          select: { warehouseCode: true, warehouseName: true },
        })
        : [],
      rackCodes.length
        ? prisma.rack.findMany({
          where: { rackCode: { in: rackCodes }, isDeleted: false, isActive: true },
          select: { rackCode: true, rackName: true, warehouseCode: true },
        })
        : [],
    ]);
    const warehouseNames = new Map(warehouses.map((row) => [row.warehouseCode, row.warehouseName]));
    const rackNames = new Map(racks.map((row) => [row.rackCode, row.rackName]));

    const sameProcess = order.processId
      ? { processId: order.processId }
      : { processCode: order.processCode || null };
    const candidateOrders = await prisma.vendorProcessOrder.findMany({
      where: {
        id: { not: order.id },
        isDeleted: false,
        vendorCode: order.vendorCode || null,
        inputPartCode: order.inputPartCode || null,
        uomCode: order.uomCode || null,
        ...sameProcess,
        status: { notIn: ["Sent", "Partial Received", "QC Hold", "Completed", "Closed", "Cancelled"] },
      },
      orderBy: [{ dueDate: "asc" }, { orderDate: "asc" }, { orderNumber: "asc" }],
    });
    const currentScheduleTime = new Date(vendorScheduleDate(order) || 0).getTime();
    const candidateReadiness = await Promise.all(candidateOrders.map(async (candidate) => ({
      candidate,
      readiness: await resolveVendorSendReadiness(prisma, candidate),
    })));

    const scheduleRow = (item, readiness, locked = false) => {
      const phase = parseVendorSchedulePhase(item.notes);
      return {
        orderNumber: item.orderNumber,
        moNumber: item.moNumber,
        processCode: item.processCode,
        processName: item.processName,
        vendorCode: item.vendorCode,
        vendorName: item.vendorName,
        inputPartCode: item.inputPartCode,
        inputPartNumber: item.inputPartNumber,
        inputPartName: item.inputPartName,
        uomCode: item.uomCode,
        qtyPlanned: roundQuantity(toNumber(item.qtyPlanned)),
        qtySent: roundQuantity(toNumber(item.qtySent)),
        qtyToSend: roundQuantity(Math.max(0, toNumber(item.qtyPlanned) - toNumber(item.qtySent))),
        sendDate: phase.sendDate || item.orderDate,
        dueDate: phase.returnDate || item.dueDate,
        status: readiness.status,
        materialReady: readiness.materialReady,
        locked,
      };
    };

    res.json({
      item: {
        order: scheduleRow(order, currentReadiness, true),
        stockOptions: balances.map((balance) => ({
          stockBalanceId: balance.id,
          warehouseCode: balance.warehouseCode,
          warehouseName: warehouseNames.get(balance.warehouseCode) || balance.warehouseCode,
          rackCode: balance.rackCode || null,
          rackName: balance.rackCode ? (rackNames.get(balance.rackCode) || balance.rackCode) : "Tanpa rack",
          lotNumber: balance.lotNumber || null,
          partCode: balance.partCode,
          partNumber: balance.partNumber,
          partName: balance.partName,
          uomCode: balance.uomCode,
          qtyAvailable: roundQuantity(toNumber(balance.qtyAvailable)),
        })),
        nextSchedules: candidateReadiness
          .filter(({ candidate, readiness }) => {
            const candidateTime = new Date(vendorScheduleDate(candidate) || 0).getTime();
            return readiness.materialReady
              && (!Number.isFinite(currentScheduleTime) || !Number.isFinite(candidateTime) || candidateTime >= currentScheduleTime);
          })
          .map(({ candidate, readiness }) => scheduleRow(candidate, readiness)),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.generateFromMo = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const mo = await tx.manufacturingOrder.findFirst({
        where: {
          moNumber: req.params.moNumber,
          isDeleted: false,
        },
        include: {
          part: {
            select: {
              id: true,
              partCode: true,
              partNumber: true,
              partName: true,
              material: { select: { spec: true } },
              partBases: {
                select: { baseOn: true, thickness: true, width: true, CSP: true },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
      });
      if (!mo) {
        throw Object.assign(new Error("Manufacturing Order tidak ditemukan."), { statusCode: 404 });
      }

      return generateVendorProcessOrdersFromRouting(tx, mo, {
        requireVendorOperations: true,
        createdBy: req.user?.username || req.user?.email || null,
      });
    });

    res.status(201).json({
      message: "Vendor Process Order generated.",
      mbomNoReg: result.mbomNoReg,
      created: result.created.map(mapDoc),
      existing: result.existing.map(mapDoc),
      createdCount: result.created.length,
      existingCount: result.existing.length,
    });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      vendorCode,
      vendorName,
      dueDate,
      notes,
      status,
    } = req.body || {};

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.vendorProcessOrder.findFirst({
        where: { orderNumber: req.params.orderNumber, isDeleted: false },
      });
      if (!current) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }

      const data = {};
      if (vendorCode !== undefined) data.vendorCode = normalizeText(vendorCode);
      if (vendorName !== undefined) data.vendorName = normalizeText(vendorName);
      if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
      if (notes !== undefined) data.notes = normalizeText(notes);
      if (status !== undefined) data.status = normalizeText(status) || "Planned";

      const nextOrder = { ...current, ...data };
      if (vendorCode !== undefined || current.vendorPriceListId === null || toNumber(current.vendorRate) <= 0) {
        Object.assign(
          data,
          await resolveVendorPriceSnapshot(tx, nextOrder, data.dueDate || current.dueDate || current.orderDate || new Date()),
        );
      }

      return tx.vendorProcessOrder.update({
        where: { orderNumber: req.params.orderNumber },
        data,
      });
    });
    res.json(mapDoc(updated));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    next(err);
  }
};

function sameVendorSendGroup(order, primary) {
  const sameProcess = primary.processId
    ? order.processId === primary.processId
    : normalizeText(order.processCode) === normalizeText(primary.processCode);
  return sameProcess
    && normalizeText(order.vendorCode) === normalizeText(primary.vendorCode)
    && normalizeText(order.inputPartCode) === normalizeText(primary.inputPartCode)
    && normalizeText(order.uomCode) === normalizeText(primary.uomCode);
}

async function sendScheduledPreviousWip(tx, order, body, actor) {
  if (["Closed", "Cancelled"].includes(order.status)) {
    throw Object.assign(new Error(`${order.orderNumber} sudah closed/cancelled.`), { statusCode: 400 });
  }

  const readiness = await resolveVendorSendReadiness(tx, order);
  if (!readiness.materialReady) {
    throw Object.assign(new Error(`${order.orderNumber}: ${readiness.materialReadinessMessage}`), { statusCode: 409 });
  }

  const remaining = roundQuantity(toNumber(order.qtyPlanned) - toNumber(order.qtySent));
  const requestedQty = roundQuantity(toNumber(body.qtySent || body.qty));
  if (requestedQty <= 0 || Math.abs(requestedQty - remaining) > QUANTITY_TOLERANCE) {
    throw Object.assign(
      new Error(`${order.orderNumber}: qty kirim harus sama dengan sisa qty jadwal (${remaining} ${order.uomCode || ""}).`.trim()),
      { statusCode: 400 },
    );
  }

  const now = new Date();
  const balances = await findPreviousWipBalances(tx, order, body);
  const sourceMovements = await consumeSourceBalancesForVendorSend(
    tx,
    order,
    balances,
    requestedQty,
    now,
    actor,
  );
  if (!sourceMovements.length) {
    throw Object.assign(new Error(`${order.orderNumber}: source WIP untuk kirim vendor tidak ditemukan.`), {
      statusCode: 400,
    });
  }

  const vendorTarget = {
    warehouseCode: normalizeText(body.vendorWarehouseCode),
    rackCode: normalizeText(body.vendorRackCode),
    lotNumber: normalizeText(body.vendorLotNumber || body.lotNumber),
  };
  const destinationRackCode = await resolveInternalRackCode(tx, vendorTarget.rackCode);
  const movementNumbers = [];
  for (const sourceMovementData of sourceMovements) {
    const movementNumber = await generateMovementNumber("OUT", tx);
    await tx.stockMovement.create({
      data: {
        movementNumber,
        movementDate: now,
        movementType: "OUT",
        direction: "OUT",
        transactionType: "VENDOR_SEND",
        warehouseCode: sourceMovementData.warehouseCode,
        rackCode: sourceMovementData.rackCode || null,
        destinationWarehouseCode: vendorTarget.warehouseCode || null,
        destinationRackCode,
        lotNumber: sourceMovementData.lotNumber || null,
        partCode: sourceMovementData.partCode,
        partNumber: sourceMovementData.partNumber,
        partName: sourceMovementData.partName,
        productId: sourceMovementData.productId,
        description: sourceMovementData.description,
        spec: sourceMovementData.spec,
        thickness: sourceMovementData.thickness,
        width: sourceMovementData.width,
        CSP: sourceMovementData.CSP,
        stockType: sourceMovementData.stockType,
        qty: sourceMovementData.qty || requestedQty,
        deltaQty: -(sourceMovementData.qty || requestedQty),
        qtyBefore: sourceMovementData.qtyBefore,
        qtyAfter: sourceMovementData.qtyAfter,
        uomCode: order.uomCode || null,
        referenceType: "VENDOR_PROCESS_ORDER",
        referenceNumber: order.orderNumber,
        notes: sourceMovementData.notes,
        performedBy: sourceMovementData.performedBy || actor,
      },
    });
    movementNumbers.push(movementNumber);
  }

  const primarySource = sourceMovements[0];
  const updated = await tx.vendorProcessOrder.update({
    where: { id: order.id },
    data: {
      qtySent: roundQuantity(toNumber(order.qtySent) + requestedQty),
      sourceWarehouseCode: primarySource.warehouseCode,
      sourceRackCode: primarySource.rackCode || null,
      sourceLotNumber: primarySource.lotNumber || null,
      vendorWarehouseCode: vendorTarget.warehouseCode || order.vendorWarehouseCode,
      vendorRackCode: vendorTarget.rackCode || order.vendorRackCode,
      vendorLotNumber: vendorTarget.lotNumber || order.vendorLotNumber,
      sentAt: order.sentAt || now,
      status: "Sent",
    },
  });

  const capacityAllocationId = String(order.notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
  if (capacityAllocationId) {
    await tx.dailyProductionSchedule.updateMany({
      where: {
        moId: order.moId,
        productionPlanAllocationId: capacityAllocationId,
        isDeleted: false,
        status: { in: ["Draft", "Released", "In Progress"] },
      },
      data: { status: "In Progress" },
    });
  }

  return { updated, movementNumber: movementNumbers[0], movementNumbers };
}

exports.send = async (req, res, next) => {
  try {
    if (Array.isArray(req.body?.shipments)) {
      const shipments = req.body.shipments.map((row) => ({
        orderNumber: normalizeText(row?.orderNumber),
        qtySent: roundQuantity(toNumber(row?.qtySent || row?.qty)),
      }));
      const uniqueOrderNumbers = new Set(shipments.map((row) => row.orderNumber).filter(Boolean));
      if (!shipments.length || shipments.length > 20 || uniqueOrderNumbers.size !== shipments.length) {
        throw Object.assign(new Error("Daftar jadwal kirim kosong, duplikat, atau melebihi 20 jadwal."), { statusCode: 400 });
      }
      if (!uniqueOrderNumbers.has(req.params.orderNumber)) {
        throw Object.assign(new Error("Jadwal utama wajib ikut dalam pengiriman."), { statusCode: 400 });
      }
      const selectedBalanceIds = Array.isArray(req.body.sourceStockBalanceIds)
        ? [...new Set(req.body.sourceStockBalanceIds.map(normalizeText).filter(Boolean))]
        : [];
      if (!normalizeText(req.body.sourceWarehouseCode) || !selectedBalanceIds.length || selectedBalanceIds.length > 100) {
        throw Object.assign(new Error("Pilih warehouse dan minimal satu stock WIP sumber."), { statusCode: 400 });
      }

      const result = await prisma.$transaction(async (tx) => {
        const orders = await tx.vendorProcessOrder.findMany({
          where: { orderNumber: { in: [...uniqueOrderNumbers] }, isDeleted: false },
        });
        if (orders.length !== shipments.length) {
          throw Object.assign(new Error("Satu atau lebih jadwal vendor tidak ditemukan."), { statusCode: 404 });
        }
        const orderByNumber = new Map(orders.map((order) => [order.orderNumber, order]));
        const primary = orderByNumber.get(req.params.orderNumber);
        if (orders.some((order) => !sameVendorSendGroup(order, primary))) {
          throw Object.assign(
            new Error("Jadwal gabungan harus menggunakan vendor, proses, part input, dan UOM yang sama."),
            { statusCode: 400 },
          );
        }

        const actor = req.user?.username || req.user?.email || "system";
        const orderedShipments = [
          shipments.find((row) => row.orderNumber === req.params.orderNumber),
          ...shipments.filter((row) => row.orderNumber !== req.params.orderNumber),
        ];
        const sent = [];
        for (const shipment of orderedShipments) {
          sent.push(await sendScheduledPreviousWip(tx, orderByNumber.get(shipment.orderNumber), {
            ...req.body,
            sourceType: SOURCE_PREVIOUS_WIP,
            qtySent: shipment.qtySent,
            sourceStockBalanceIds: selectedBalanceIds,
          }, actor));
        }
        return sent;
      });

      const movementNumbers = result.flatMap((row) => row.movementNumbers);
      return res.json({
        message: `${result.length} jadwal berhasil dikirim ke vendor dalam satu transaksi.`,
        movementNumber: movementNumbers[0] || null,
        movementNumbers,
        items: result.map((row) => mapDoc(row.updated)),
        item: mapDoc(result[0].updated),
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.vendorProcessOrder.findFirst({
        where: {
          orderNumber: req.params.orderNumber,
          isDeleted: false,
        },
      });
      if (!order) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }
      if (["Closed", "Cancelled"].includes(order.status)) {
        throw Object.assign(new Error("Vendor Process Order sudah closed/cancelled."), {
          statusCode: 400,
        });
      }
      const readiness = await resolveVendorSendReadiness(tx, order);
      if (!readiness.materialReady) {
        throw Object.assign(new Error(readiness.materialReadinessMessage), { statusCode: 409 });
      }

      const qty = roundQuantity(toNumber(req.body?.qtySent || req.body?.qty));
      if (qty <= 0) {
        throw Object.assign(new Error("Qty sent harus lebih dari 0."), { statusCode: 400 });
      }

      const remaining = roundQuantity(toNumber(order.qtyPlanned) - toNumber(order.qtySent));
      if (remaining + QUANTITY_TOLERANCE < qty && req.body?.allowOverSend !== true) {
        throw Object.assign(new Error("Qty sent melebihi qty planned vendor process."), {
          statusCode: 400,
        });
      }

      const sourceType = normalizeText(req.body?.sourceType) || SOURCE_PREVIOUS_WIP;
      const now = new Date();
      let sourceBalance = null;
      let sourceWorkOrder = null;
      let sourceMovements = [];

      if (sourceType === SOURCE_WORK_ORDER_OUTPUT) {
        sourceWorkOrder = await findWorkOrderOutputSource(tx, order, req.body || {});
        if (!sourceWorkOrder) {
          throw Object.assign(new Error("Source Work Order completed untuk kirim vendor tidak ditemukan."), {
            statusCode: 400,
          });
        }
        if (toNumber(sourceWorkOrder.qtyAvailable) + QUANTITY_TOLERANCE < qty) {
          throw Object.assign(new Error("Qty good Work Order tidak cukup untuk dikirim ke vendor."), {
            statusCode: 400,
          });
        }

        const sourceWarehouseCode = normalizeText(req.body?.sourceWarehouseCode || req.body?.warehouseCode);
        if (!sourceWarehouseCode) {
          throw Object.assign(new Error("Source warehouse wajib diisi untuk kirim dari output WO."), {
            statusCode: 400,
          });
        }

        const sourcePartContext = {
          sourcePartCode: sourceWorkOrder.sourcePartCode,
          partCode: sourceWorkOrder.sourcePartCode,
          partNumber: sourceWorkOrder.sourcePartNumber,
          partName: sourceWorkOrder.sourcePartName,
          spec: sourceWorkOrder.sourceSpec,
          thickness: sourceWorkOrder.sourceThickness,
          width: sourceWorkOrder.sourceWidth,
          CSP: sourceWorkOrder.sourceCSP,
        };

        sourceBalance = await findStockBalance(tx, order, {
          ...req.body,
          ...sourcePartContext,
          sourceWarehouseCode,
          sourceRackCode: normalizeText(req.body?.sourceRackCode || req.body?.rackCode),
          sourceLotNumber: normalizeText(req.body?.sourceLotNumber || req.body?.lotNumber),
        });
        const fallbackBalances = sourceBalance
          ? [sourceBalance]
          : await findPreviousWipBalances(tx, order, {
            ...req.body,
            ...sourcePartContext,
            sourceWarehouseCode,
          });
        sourceMovements = await consumeSourceBalancesForVendorSend(
          tx,
          order,
          fallbackBalances,
          qty,
          now,
          req.user?.username || req.user?.email || "system",
          sourcePartContext,
        );
        sourceMovements = sourceMovements.map((movement) => ({
          ...movement,
          referenceType: "WORK_ORDER",
          referenceNumber: sourceWorkOrder.woNumber,
          notes: `Send WO output ${sourceWorkOrder.woNumber} to vendor ${order.vendorCode || ""} for ${order.orderNumber}`.trim(),
        }));
      } else if (sourceType === SOURCE_PREVIOUS_WIP) {
        const balances = await findPreviousWipBalances(tx, order, req.body || {});
        sourceMovements = await consumeSourceBalancesForVendorSend(
          tx,
          order,
          balances,
          qty,
          now,
          req.user?.username || req.user?.email || "system",
        );
      } else {
        sourceBalance = await findStockBalance(tx, order, req.body || {});
        if (!sourceBalance) {
          throw Object.assign(new Error("Source stock balance untuk kirim vendor tidak ditemukan."), {
            statusCode: 400,
          });
        }
        const reservedMoSource = await findReservedMoSourceWipForVendorSend(tx, order, sourceBalance);
        if (toNumber(sourceBalance.qtyAvailable) + QUANTITY_TOLERANCE < qty) {
          if (reservedMoSource) {
            sourceMovements = await consumeReservedMoSourceWipForVendorSend(
              tx,
              order,
              sourceBalance,
              reservedMoSource,
              qty,
              now,
              req.user?.username || req.user?.email || "system",
            );
          } else {
            throw Object.assign(new Error("Qty available source stock tidak cukup untuk dikirim ke vendor."), {
              statusCode: 400,
            });
          }
        } else {
          sourceMovements = await consumeSourceBalancesForVendorSend(
            tx,
            order,
            [sourceBalance],
            qty,
            now,
            req.user?.username || req.user?.email || "system",
          );
        }
      }

      if (sourceMovements.length === 0) {
        throw Object.assign(new Error("Source WIP untuk kirim vendor tidak ditemukan."), {
          statusCode: 400,
        });
      }

      const vendorTarget = {
        warehouseCode: normalizeText(req.body?.vendorWarehouseCode),
        rackCode: normalizeText(req.body?.vendorRackCode),
        lotNumber: normalizeText(req.body?.vendorLotNumber || req.body?.lotNumber),
      };
      const destinationRackCode = await resolveInternalRackCode(tx, vendorTarget.rackCode);

      const movementNumbers = [];
      for (const sourceMovementData of sourceMovements) {
        const movementNumber = await generateMovementNumber("OUT", tx);
        await tx.stockMovement.create({
          data: {
          movementNumber,
          movementDate: now,
          movementType: "OUT",
          direction: "OUT",
          transactionType: "VENDOR_SEND",
          warehouseCode: sourceMovementData.warehouseCode,
          rackCode: sourceMovementData.rackCode || null,
          destinationWarehouseCode: vendorTarget.warehouseCode || null,
          destinationRackCode,
          lotNumber: sourceMovementData.lotNumber || null,
          partCode: sourceMovementData.partCode,
          partNumber: sourceMovementData.partNumber,
          partName: sourceMovementData.partName,
          productId: sourceMovementData.productId,
          description: sourceMovementData.description,
          spec: sourceMovementData.spec,
          thickness: sourceMovementData.thickness,
          width: sourceMovementData.width,
          CSP: sourceMovementData.CSP,
          stockType: sourceMovementData.stockType,
          qty: sourceMovementData.qty || qty,
          deltaQty: -(sourceMovementData.qty || qty),
          qtyBefore: sourceMovementData.qtyBefore,
          qtyAfter: sourceMovementData.qtyAfter,
          uomCode: order.uomCode || null,
          referenceType: "VENDOR_PROCESS_ORDER",
          referenceNumber: order.orderNumber,
          notes: sourceMovementData.notes,
          performedBy: sourceMovementData.performedBy || req.user?.username || req.user?.email || "system",
          },
        });
        movementNumbers.push(movementNumber);
      }

      const primarySource = sourceMovements[0];
      const movementNumber = movementNumbers[0];

      const qtySent = roundQuantity(toNumber(order.qtySent) + qty);
      const status = qtySent + QUANTITY_TOLERANCE >= toNumber(order.qtyPlanned)
        ? "Sent"
        : "Partial Sent";
      const updated = await tx.vendorProcessOrder.update({
        where: { id: order.id },
        data: {
          qtySent,
          sourceWarehouseCode: primarySource.warehouseCode,
          sourceRackCode: primarySource.rackCode || null,
          sourceLotNumber: primarySource.lotNumber || null,
          vendorWarehouseCode: vendorTarget.warehouseCode || order.vendorWarehouseCode,
          vendorRackCode: vendorTarget.rackCode || order.vendorRackCode,
          vendorLotNumber: vendorTarget.lotNumber || order.vendorLotNumber,
          sentAt: order.sentAt || now,
          status,
        },
      });

      const capacityAllocationId = String(order.notes || "").match(/\[CAPACITY-VENDOR:([^\]]+)\]/)?.[1] || null;
      if (capacityAllocationId) {
        await tx.dailyProductionSchedule.updateMany({
          where: {
            moId: order.moId,
            productionPlanAllocationId: capacityAllocationId,
            isDeleted: false,
            status: { in: ["Draft", "Released", "In Progress"] },
          },
          data: { status: "In Progress" },
        });
      }

      return { updated, movementNumber, movementNumbers };
    });

    res.json({
      message: "Vendor Process Order sent.",
      movementNumber: result.movementNumber,
      movementNumbers: result.movementNumbers,
      item: mapDoc(result.updated),
    });
  } catch (err) {
    next(err);
  }
};

exports.rollbackSend = async (req, res, next) => {
  try {
    if (req.user?.isSuperAdmin !== true) {
      throw Object.assign(new Error("Rollback send hanya diizinkan untuk Super Admin."), {
        statusCode: 403,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.vendorProcessOrder.findFirst({
        where: {
          orderNumber: req.params.orderNumber,
          isDeleted: false,
        },
      });
      if (!order) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }
      if (["Closed", "Cancelled", "Completed"].includes(order.status)) {
        throw Object.assign(
          new Error("Vendor Process Order tidak bisa rollback karena statusnya sudah final."),
          { statusCode: 400 },
        );
      }
      if (toNumber(order.qtySent) <= QUANTITY_TOLERANCE) {
        throw Object.assign(new Error("Vendor Process Order belum memiliki qty sent untuk di-rollback."), {
          statusCode: 400,
        });
      }

      const existingInspection = await tx.qualityInspection.findFirst({
        where: {
          vendorProcessOrderId: order.id,
          isDeleted: false,
        },
        select: {
          inspectionNumber: true,
          status: true,
        },
      });
      if (existingInspection) {
        throw Object.assign(
          new Error(`Rollback tidak bisa dilakukan karena sudah ada QC Inspection ${existingInspection.inspectionNumber}.`),
          { statusCode: 409 },
        );
      }

      const sendMovements = await tx.stockMovement.findMany({
        where: {
          transactionType: "VENDOR_SEND",
          referenceType: "VENDOR_PROCESS_ORDER",
          referenceNumber: order.orderNumber,
          isDeleted: false,
        },
        orderBy: [{ createdAt: "desc" }, { movementDate: "desc" }],
      });

      if (sendMovements.length === 0) {
        throw Object.assign(new Error("Movement VENDOR_SEND untuk order ini tidak ditemukan."), {
          statusCode: 404,
        });
      }

      const receiveMovements = await tx.stockMovement.findMany({
        where: {
          transactionType: { in: ["VENDOR_RECEIVE", "QC_HOLD"] },
          referenceType: "VENDOR_PROCESS_ORDER",
          referenceNumber: order.orderNumber,
          isDeleted: false,
        },
        orderBy: [{ createdAt: "desc" }, { movementDate: "desc" }],
      });

      const rollbackNow = new Date();
      for (const movement of receiveMovements.filter(movement => movement.transactionType === "QC_HOLD")) {
        await reduceReceivedQcHoldStock(tx, movement, rollbackNow);
      }
      for (const movement of sendMovements) {
        await restoreStockBalanceFromMovement(tx, movement, rollbackNow);
      }

      await tx.stockMovement.updateMany({
        where: { id: { in: sendMovements.map(movement => movement.id) } },
        data: {
          isDeleted: true,
          notes: `[ROLLED BACK ${order.orderNumber}]`,
        },
      });
      if (receiveMovements.length > 0) {
        await tx.stockMovement.updateMany({
          where: { id: { in: receiveMovements.map(movement => movement.id) } },
          data: {
            isDeleted: true,
            notes: `[ROLLED BACK ${order.orderNumber}]`,
          },
        });
      }

      const updated = await tx.vendorProcessOrder.update({
        where: { id: order.id },
        data: {
          qtySent: 0,
          qtyReceived: 0,
          qtyAccepted: 0,
          qtyReject: 0,
          qtyRework: 0,
          sourceWarehouseCode: null,
          sourceRackCode: null,
          sourceLotNumber: null,
          receiveWarehouseCode: null,
          receiveRackCode: null,
          receiveLotNumber: null,
          vendorLotNumber: null,
          sentAt: null,
          receivedAt: null,
          status: getRollbackableVendorSendStatus({ ...order, qtySent: 0 }),
        },
      });

      return { updated, movementCount: sendMovements.length + receiveMovements.length };
    });

    res.json({
      message: "Vendor send rolled back.",
      movementCount: result.movementCount,
      item: mapDoc(result.updated),
    });
  } catch (err) {
    next(err);
  }
};

exports.receive = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.vendorProcessOrder.findFirst({
        where: {
          orderNumber: req.params.orderNumber,
          isDeleted: false,
        },
      });
      if (!order) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }
      if (["Closed", "Cancelled"].includes(order.status)) {
        throw Object.assign(new Error("Vendor Process Order sudah closed/cancelled."), {
          statusCode: 400,
        });
      }

      const receipt = await receiveVendorOutputToQc(
        tx,
        order,
        req.body || {},
        req.user?.username || req.user?.email || "system",
      );
      const qualityInspection = await createVendorReceiptQualityInspection(
        tx,
        order,
        receipt,
        req.body || {},
        req.user?.username || req.user?.email || "system",
      );
      const vendorRate = toNumber(order.vendorRate);
      const qtyReceived = roundQuantity(toNumber(order.qtyReceived) + receipt.qty);
      const effectiveSentQty = Math.max(toNumber(order.qtySent || 0), qtyReceived);
      const status = qtyReceived + QUANTITY_TOLERANCE >= effectiveSentQty
        ? "QC Hold"
        : "Partial Received";
      const updated = await tx.vendorProcessOrder.update({
        where: { id: order.id },
        data: {
          qtyReceived,
          actualVendorCost: roundQuantity(qtyReceived * vendorRate),
          receiveWarehouseCode: normalizeText(req.body?.warehouseCode || req.body?.receiveWarehouseCode),
          receiveRackCode: normalizeText(req.body?.rackCode || req.body?.receiveRackCode),
          receiveLotNumber: normalizeText(req.body?.lotNumber || req.body?.receiveLotNumber),
          receivedAt: order.receivedAt || receipt.receivedAt,
          status,
        },
      });

      return { updated, movementNumber: receipt.movementNumber, qualityInspection };
    });

    res.json({
      message: "Vendor output received to QC Hold.",
      movementNumber: result.movementNumber,
      qualityInspection: mapDoc(result.qualityInspection),
      item: mapDoc(result.updated),
    });
  } catch (err) {
    next(err);
  }
};

exports.reprice = async (req, res, next) => {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.vendorProcessOrder.findFirst({
        where: {
          orderNumber: req.params.orderNumber,
          isDeleted: false,
        },
      });
      if (!order) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }
      if (!order.vendorCode) {
        throw Object.assign(new Error("Vendor belum diassign, price vendor belum bisa dihitung ulang."), {
          statusCode: 400,
        });
      }

      const manualRateInput = req.body?.vendorRate ?? req.body?.rate;
      const hasManualRate =
        manualRateInput !== undefined &&
        manualRateInput !== null &&
        String(manualRateInput).trim() !== "";

      let costSnapshot;
      if (hasManualRate) {
        const vendorRate = toNumber(manualRateInput);
        if (vendorRate <= 0) {
          throw Object.assign(new Error("Vendor rate harus lebih dari 0."), {
            statusCode: 400,
          });
        }

        costSnapshot = {
          vendorPriceListId: req.body?.vendorPriceListId || null,
          vendorRate,
          vendorCurrency:
            normalizeText(req.body?.vendorCurrency || req.body?.currency || order.vendorCurrency) || "IDR",
          plannedVendorCost: roundQuantity(toNumber(order.qtyPlanned) * vendorRate),
        };
      } else if (req.body?.vendorPriceListId) {
        const priceList = await tx.vendorPriceList.findFirst({
          where: {
            id: req.body.vendorPriceListId,
            isDeleted: false,
          },
        });
        if (!priceList) {
          throw Object.assign(new Error("Vendor Price List tidak ditemukan."), {
            statusCode: 404,
          });
        }

        costSnapshot = buildVendorCostSnapshot(
          priceList,
          order.qtyPlanned,
          order.dueDate || order.receivedAt || order.orderDate || new Date(),
        );
        if (toNumber(costSnapshot.vendorRate) <= 0) {
          throw Object.assign(new Error("Vendor Price List belum punya rate aktif untuk periode ini."), {
            statusCode: 400,
          });
        }
      } else {
        costSnapshot = await resolveVendorPriceSnapshot(
          tx,
          order,
          order.dueDate || order.receivedAt || order.orderDate || new Date(),
        );
        if (!costSnapshot.vendorPriceListId || toNumber(costSnapshot.vendorRate) <= 0) {
          throw Object.assign(new Error("Vendor Price List yang sesuai tidak ditemukan."), {
            statusCode: 404,
          });
        }
      }

      const vendorRate = toNumber(costSnapshot.vendorRate);
      const actualQty = toNumber(order.qtyAccepted) > 0
        ? toNumber(order.qtyAccepted)
        : toNumber(order.qtyReceived);

      return tx.vendorProcessOrder.update({
        where: { id: order.id },
        data: {
          ...costSnapshot,
          actualVendorCost: roundQuantity(actualQty * vendorRate),
        },
      });
    });

    res.json(mapDoc(updated));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.vendorProcessOrder.findFirst({
        where: {
          orderNumber: req.params.orderNumber,
          isDeleted: false,
        },
      });
      if (!existing) {
        throw Object.assign(new Error("Vendor Process Order tidak ditemukan."), { statusCode: 404 });
      }
      const qcCount = await tx.qualityInspection.count({
        where: {
          vendorProcessOrderId: existing.id,
          isDeleted: false,
        },
      });
      if (qcCount > 0) {
        throw Object.assign(new Error("Vendor Process Order yang sudah punya QC Inspection tidak bisa dihapus."), {
          statusCode: 400,
        });
      }
      const sentMovementCount = await tx.stockMovement.count({
        where: {
          referenceNumber: existing.orderNumber,
          transactionType: "VENDOR_SEND",
          isDeleted: false,
        },
      });
      const hasSentHistory =
        toNumber(existing.qtySent) > QUANTITY_TOLERANCE ||
        sentMovementCount > 0 ||
        !!existing.sentAt;
      if (hasSentHistory) {
        throw Object.assign(
          new Error("Vendor Process Order tidak bisa dihapus karena sudah pernah dikirim. Rollback send dulu."),
          {
            statusCode: 400,
          },
        );
      }

      return tx.vendorProcessOrder.update({
        where: { id: existing.id },
        data: {
          isDeleted: true,
          status: "Cancelled",
          closedAt: new Date(),
        },
      });
    });
    res.json(mapDoc(updated));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    next(err);
  }
};

exports.generateVendorProcessOrdersFromRouting = generateVendorProcessOrdersFromRouting;
exports.getVendorRoutingOperations = getVendorRoutingOperations;
