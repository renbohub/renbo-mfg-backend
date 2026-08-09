const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { parseFilter } = require("../../utils/parseFilter");
const { createWIPEntry } = require("./WIPController");
const {
  IDENTITY_REQUIRED_MESSAGE,
  resolveItemIdentityInput,
  hasItemIdentity,
  buildIdentityWhere,
} = require("../inventory/utils/itemIdentity");
const {
  buildExcludeSpecialRackCondition,
  isSpecialRackCode,
} = require("../inventory/utils/stockReservationHelpers");
const { assertStockBalanceNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");
const { assertQuantity } = require("../../utils/uomQuantity");

// Generate nomor Material Issue otomatis: MI-YYYYMMDD-001
async function generateIssueNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `MI-${y}${m}${d}`;

  const last = await prisma.materialIssue.findFirst({
    where: { issueNumber: { startsWith: datePrefix } },
    orderBy: { issueNumber: "desc" },
    select: { issueNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.issueNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

function getAuthenticatedIssuer(user) {
  return user?.username || user?.email || user?.employeeId || user?.fullName || "system";
}

const getDetailItemLabel = (detail = {}) =>
  detail.partCode ||
  detail.partNumber ||
  detail.partName ||
  detail.productCode ||
  detail.product?.productCode ||
  detail.description ||
  detail.spec ||
  `Line ${detail.lineNumber || "?"}`;

const sameText = (left, right) => String(left || "").trim().toUpperCase() === String(right || "").trim().toUpperCase();
const sameNumber = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) <= 0.000001;
const materialIssueQty = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
const hasEnoughMaterialIssueQty = (available, required) => materialIssueQty(available) >= materialIssueQty(required);
const formatMaterialIssueQty = (value) => materialIssueQty(value).toFixed(3);

function stockMatchesMaterialIssueDetail(balance, detail) {
  if (detail.stockBalanceId && balance.id === detail.stockBalanceId) return true;
  const identityMatch = (detail.partCode && (sameText(balance.partCode, detail.partCode) || sameText(balance.materialCode, detail.partCode)))
    || (detail.partNumber && sameText(balance.partNumber, detail.partNumber))
    || (detail.productId && balance.productId === detail.productId);
  if (!identityMatch) return false;
  if (detail.uomCode && balance.uomCode && !sameText(balance.uomCode, detail.uomCode)) return false;
  if (detail.spec && balance.spec && !sameText(balance.spec, detail.spec)) return false;
  if (detail.thickness != null && balance.thickness != null && !sameNumber(balance.thickness, detail.thickness)) return false;
  if (detail.width != null && balance.width != null && !sameNumber(balance.width, detail.width)) return false;
  if (detail.CSP && balance.CSP && !sameText(balance.CSP, detail.CSP)) return false;
  return true;
}

async function attachMaterialIssueStock(doc) {
  const details = doc?.details || [];
  if (!details.length) return { ...doc, stockSummary: { lineCount: 0, materialLineCount: 0, readyLineCount: 0, shortageLineCount: 0, uomTotals: [] } };
  const directIds = details.map((row) => row.stockBalanceId).filter(Boolean);
  const partCodes = details.map((row) => row.partCode).filter(Boolean);
  const partNumbers = details.map((row) => row.partNumber).filter(Boolean);
  const productIds = details.map((row) => row.productId).filter(Boolean);
  const identityFilters = [
    directIds.length ? { id: { in: directIds } } : null,
    partCodes.length ? { partCode: { in: partCodes, mode: "insensitive" } } : null,
    partCodes.length ? { materialCode: { in: partCodes, mode: "insensitive" } } : null,
    partNumbers.length ? { partNumber: { in: partNumbers, mode: "insensitive" } } : null,
    productIds.length ? { productId: { in: productIds } } : null,
  ].filter(Boolean);
  const balances = identityFilters.length ? await prisma.stockBalance.findMany({
    where: {
      warehouseCode: doc.warehouseCode,
      isDeleted: false,
      AND: [buildExcludeSpecialRackCondition(), { OR: identityFilters }],
    },
    select: {
      id: true, warehouseCode: true, rackCode: true, lotNumber: true, partCode: true, partNumber: true, partName: true,
      materialId: true, materialCode: true, materialName: true, materialType: true, productId: true, description: true,
      spec: true, thickness: true, width: true, CSP: true, uomCode: true, stockType: true,
      qtyOnHand: true, qtyReserved: true, qtyQC: true, qtyAvailable: true,
    },
    orderBy: [{ qtyAvailable: "desc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
  }) : [];
  let enrichedDetails = details.map((detail) => {
    const matched = balances.filter((balance) => stockMatchesMaterialIssueDetail(balance, detail));
    const sum = (key) => matched.reduce((total, balance) => total + Number(balance[key] || 0), 0);
    const requestedQty = Number(detail.qtyRequired || 0);
    const availableQty = sum("qtyAvailable");
    const stockType = matched.find((row) => row.stockType)?.stockType || null;
    const isMaterial = Boolean(matched.some((row) => row.materialId || row.materialCode || /MATERIAL/i.test(row.stockType || "")) || /MATERIAL/i.test(detail.requirementSource || ""));
    return {
      ...detail,
      requestedQty,
      itemCategory: isMaterial ? "MATERIAL" : detail.isSubAssembly ? "SUB_ASSEMBLY" : stockType || "PART",
      stockAvailability: {
        qtyOnHand: sum("qtyOnHand"), qtyReserved: sum("qtyReserved"), qtyQC: sum("qtyQC"), qtyAvailable: availableQty,
        shortageQty: Math.max(materialIssueQty(requestedQty) - materialIssueQty(availableQty), 0), coveragePercent: requestedQty > 0 ? Math.min(availableQty / requestedQty * 100, 999.99) : 100,
        status: hasEnoughMaterialIssueQty(availableQty, requestedQty) ? "READY" : availableQty > 0 ? "PARTIAL" : "OUT_OF_STOCK",
        balanceCount: matched.length,
        locations: matched.slice(0, 12).map((balance) => ({
          stockBalanceId: balance.id, warehouseCode: balance.warehouseCode, rackCode: balance.rackCode, lotNumber: balance.lotNumber,
          qtyOnHand: Number(balance.qtyOnHand || 0), qtyReserved: Number(balance.qtyReserved || 0), qtyQC: Number(balance.qtyQC || 0), qtyAvailable: Number(balance.qtyAvailable || 0), uomCode: balance.uomCode,
        })),
      },
    };
  });
  const requirementGroups = new Map();
  for (const row of enrichedDetails) {
    const key = materialIssueRequirementKey(row);
    const group = requirementGroups.get(key) || {
      requestedQty: 0,
      uomCode: String(row.uomCode || "UNIT").toUpperCase(),
      balances: new Map(),
    };
    group.requestedQty += Number(row.requestedQty || 0);
    for (const location of row.stockAvailability.locations || []) {
      if (!group.balances.has(location.stockBalanceId)) group.balances.set(location.stockBalanceId, location);
    }
    requirementGroups.set(key, group);
  }
  for (const group of requirementGroups.values()) {
    group.qtyOnHand = [...group.balances.values()].reduce((sum, row) => sum + Number(row.qtyOnHand || 0), 0);
    group.qtyReserved = [...group.balances.values()].reduce((sum, row) => sum + Number(row.qtyReserved || 0), 0);
    group.qtyQC = [...group.balances.values()].reduce((sum, row) => sum + Number(row.qtyQC || 0), 0);
    group.qtyAvailable = [...group.balances.values()].reduce((sum, row) => sum + Number(row.qtyAvailable || 0), 0);
    group.shortageQty = Math.max(materialIssueQty(group.requestedQty) - materialIssueQty(group.qtyAvailable), 0);
    group.coveragePercent = group.requestedQty > 0 ? Math.min(group.qtyAvailable / group.requestedQty * 100, 999.99) : 100;
    group.status = hasEnoughMaterialIssueQty(group.qtyAvailable, group.requestedQty) ? "READY" : group.qtyAvailable > 0 ? "PARTIAL" : "OUT_OF_STOCK";
    group.balanceCount = group.balances.size;
  }
  enrichedDetails = enrichedDetails.map((row) => {
    const group = requirementGroups.get(materialIssueRequirementKey(row));
    return {
      ...row,
      requirementAvailability: group ? {
        requestedQty: group.requestedQty,
        qtyOnHand: group.qtyOnHand,
        qtyReserved: group.qtyReserved,
        qtyQC: group.qtyQC,
        qtyAvailable: group.qtyAvailable,
        shortageQty: group.shortageQty,
        coveragePercent: group.coveragePercent,
        status: group.status,
        balanceCount: group.balanceCount,
      } : row.stockAvailability,
    };
  });
  const totals = new Map();
  for (const group of requirementGroups.values()) {
    const uom = group.uomCode;
    const current = totals.get(uom) || { uomCode: uom, requestedQty: 0, availableQty: 0, shortageQty: 0 };
    current.requestedQty += Number(group.requestedQty || 0);
    current.availableQty += Number(group.qtyAvailable || 0);
    current.shortageQty += Number(group.shortageQty || 0);
    totals.set(uom, current);
  }
  return {
    ...doc,
    details: enrichedDetails,
    stockSummary: {
      lineCount: enrichedDetails.length,
      sourceLineCount: enrichedDetails.length,
      requirementCount: new Set(enrichedDetails.map((row) => materialIssueRequirementKey(row))).size,
      materialLineCount: enrichedDetails.filter((row) => row.itemCategory === "MATERIAL").length,
      materialRequirementCount: new Set(enrichedDetails.filter((row) => row.itemCategory === "MATERIAL").map((row) => materialIssueRequirementKey(row))).size,
      readyLineCount: enrichedDetails.filter((row) => row.stockAvailability.status === "READY").length,
      shortageLineCount: enrichedDetails.filter((row) => row.stockAvailability.status !== "READY").length,
      readyRequirementCount: [...requirementGroups.values()].filter((group) => group.status === "READY").length,
      shortageRequirementCount: [...requirementGroups.values()].filter((group) => group.status !== "READY").length,
      uomTotals: [...totals.values()],
    },
  };
}

function materialIssueNoteTokens(notes) {
  return String(notes || "").split(";").reduce((tokens, entry) => {
    const [rawKey, ...rawValue] = entry.trim().split("=");
    if (rawValue.length) tokens[String(rawKey || "").trim()] = rawValue.join("=").trim();
    return tokens;
  }, {});
}

function materialIssueRequirementKey(detail = {}) {
  return [
    detail.partCode || detail.partNumber || detail.productId || detail.description || "ITEM",
    detail.spec || "",
    detail.thickness ?? "",
    detail.width ?? "",
    detail.CSP || "",
    String(detail.uomCode || "UNIT").toUpperCase(),
    detail.requirementSource || "MBOM",
  ].join("|").toUpperCase();
}

async function attachMaterialIssueCalculationTrace(doc) {
  const details = doc?.details || [];
  if (!details.length) return doc;

  const scheduleNumber = String(doc.notes || "").match(/\[DPS-CONSUME:([^\]]+)\]/i)?.[1] || null;
  const schedule = scheduleNumber ? await prisma.dailyProductionSchedule.findFirst({
    where: { scheduleNumber, isDeleted: false },
    select: {
      scheduleNumber: true,
      plannedQty: true,
      uomCode: true,
      partCode: true,
      moNumber: true,
      woNumber: true,
      productionPlanId: true,
      productionPlanAllocationId: true,
      mbomProcess: {
        select: {
          id: true,
          mbomDetail: {
            select: {
              id: true,
              noReg: true,
              part: { select: { partCode: true, partName: true } },
            },
          },
        },
      },
    },
  }) : null;

  const noReg = schedule?.mbomProcess?.mbomDetail?.noReg || null;
  const partCodes = [...new Set(details.map((detail) => detail.partCode).filter(Boolean))];
  const mbomDetails = noReg && partCodes.length ? await prisma.mBOMDetail.findMany({
    where: {
      noReg,
      isDeleted: false,
      part: { partCode: { in: partCodes } },
    },
    select: {
      id: true,
      parentDetailId: true,
      qty: true,
      uomCode: true,
      scrapFactor: true,
      grossWeight: true,
      defaultGrossWeight: true,
      materialThickness: true,
      materialWidth: true,
      materialPitch: true,
      materialCavity: true,
      materialDensity: true,
      part: { select: { partCode: true, partNumber: true, partName: true, rawType: true } },
      parentDetail: { select: { part: { select: { partCode: true, partName: true } } } },
    },
  }) : [];

  const groups = new Map();
  for (const detail of details) {
    const key = materialIssueRequirementKey(detail);
    const group = groups.get(key) || [];
    group.push(detail);
    groups.set(key, group);
  }

  const enrichedDetails = details.map((detail) => {
    const tokens = materialIssueNoteTokens(detail.notes);
    const siblings = groups.get(materialIssueRequirementKey(detail)) || [detail];
    const parentPartCode = tokens.parent || schedule?.partCode || schedule?.mbomProcess?.mbomDetail?.part?.partCode || null;
    const mbomDetail = mbomDetails.find((row) =>
      sameText(row.part?.partCode, detail.partCode)
      && (!parentPartCode || sameText(row.parentDetail?.part?.partCode, parentPartCode)))
      || mbomDetails.find((row) => sameText(row.part?.partCode, detail.partCode));
    const plannedQty = Number(schedule?.plannedQty || 0);
    const qtyPer = Number(mbomDetail?.qty || 0);
    const scrapPercent = Number(mbomDetail?.scrapFactor || 0);
    const grossWeight = Number(mbomDetail?.grossWeight || mbomDetail?.defaultGrossWeight || 0);
    const rawRequirementQty = plannedQty * qtyPer * (1 + scrapPercent / 100);
    const calculatedQty = grossWeight > 0 && sameText(detail.uomCode, "KG")
      ? rawRequirementQty * grossWeight
      : rawRequirementQty;
    const totalRequestedQty = siblings.reduce((sum, row) => sum + Number(row.qtyRequired || 0), 0);
    const splitIndex = siblings.findIndex((row) => row.id === detail.id) + 1;
    const formulaParts = grossWeight > 0 && sameText(detail.uomCode, "KG")
      ? [
          `${materialIssueQty(plannedQty)} ${schedule?.uomCode || "PCS"} DPP`,
          `${materialIssueQty(qtyPer)} ${mbomDetail?.uomCode || "PCS"}/output`,
          `${materialIssueQty(grossWeight)} KG/${mbomDetail?.uomCode || "PCS"}`,
          `scrap ${materialIssueQty(scrapPercent)}%`,
        ]
      : [
          `${materialIssueQty(plannedQty)} ${schedule?.uomCode || "PCS"} DPP`,
          `${materialIssueQty(qtyPer)} ${mbomDetail?.uomCode || detail.uomCode || "UNIT"}/output`,
          `scrap ${materialIssueQty(scrapPercent)}%`,
        ];

    return {
      ...detail,
      calculationTrace: {
        requirementKey: materialIssueRequirementKey(detail),
        sourceType: detail.requirementSource || tokens.source || "MBOM",
        scheduleNumber,
        moNumber: schedule?.moNumber || doc.manufacturingOrder?.moNumber || null,
        woNumber: schedule?.woNumber || doc.workOrder?.woNumber || null,
        mbomNumber: noReg,
        mbomDetailId: mbomDetail?.id || null,
        parentPartCode,
        parentPartName: mbomDetail?.parentDetail?.part?.partName || schedule?.mbomProcess?.mbomDetail?.part?.partName || null,
        materialCode: tokens.material || null,
        plannedQty,
        plannedUomCode: schedule?.uomCode || null,
        qtyPer,
        qtyPerUomCode: mbomDetail?.uomCode || null,
        scrapPercent,
        grossWeightKg: grossWeight || null,
        rawRequirementQty,
        calculatedQty,
        totalRequestedQty,
        requestedUomCode: detail.uomCode || null,
        splitLineCount: siblings.length,
        splitLineNumber: splitIndex,
        splitQty: Number(detail.qtyRequired || 0),
        stockBalanceId: detail.stockBalanceId || null,
        rackCode: detail.rackCode || null,
        lotNumber: detail.lotNumber || null,
        formulaParts,
        splitReason: siblings.length > 1
          ? `Satu kebutuhan material ${materialIssueQty(totalRequestedQty)} ${detail.uomCode || "UNIT"} dibagi ke ${siblings.length} stock balance/lot.`
          : "Satu kebutuhan material dipenuhi oleh satu stock balance/lot.",
      },
    };
  });

  return {
    ...doc,
    sourceTrace: schedule ? {
      scheduleNumber: schedule.scheduleNumber,
      plannedQty: Number(schedule.plannedQty || 0),
      uomCode: schedule.uomCode,
      partCode: schedule.partCode,
      moNumber: schedule.moNumber,
      woNumber: schedule.woNumber,
      mbomNumber: noReg,
    } : null,
    details: enrichedDetails,
  };
}

const resolveMaterialIssueIdentity = async (tx, detail = {}) => {
  const identity = await resolveItemIdentityInput(tx, detail || {});

  if (!hasItemIdentity(identity)) {
    throw Object.assign(
      new Error(
        `Identitas stock kosong pada item ${getDetailItemLabel(detail)}. ${IDENTITY_REQUIRED_MESSAGE}`,
      ),
      { statusCode: 400 },
    );
  }

  return identity;
};

const mapMaterialIssueDetailInput = async (tx, detail = {}, index = 0, issueId) => {
  const identity = await resolveMaterialIssueIdentity(tx, detail);

  return {
    issueId,
    lineNumber: detail.lineNumber ?? index + 1,
    partCode: identity.partCode ?? null,
    partNumber: identity.partNumber ?? null,
    partName: detail.partName ?? identity.partName ?? null,
    spec: identity.spec ?? null,
    thickness: identity.thickness ?? null,
    width: identity.width ?? null,
    CSP: identity.CSP ?? null,
    productId: identity.productId ?? null,
    description: identity.description ?? null,
    stockBalanceId: detail.stockBalanceId ?? null,
    requirementSource: detail.requirementSource ?? null,
    isSubAssembly: Boolean(detail.isSubAssembly) || detail.requirementSource === "SubAssembly",
    rackCode: detail.rackCode ?? null,
    qtyRequired: detail.qtyRequired,
    qtyIssued: detail.qtyIssued ?? 0,
    qtyReturned: detail.qtyReturned ?? 0,
    uomCode: detail.uomCode ?? null,
    lotNumber: detail.lotNumber ?? null,
    notes: detail.notes ?? null,
  };
};

async function prepareDppMaterialIssueSources(tx, issue) {
  if (!String(issue.notes || "").includes("[DPS-CONSUME:")) return issue.details || [];

  const allocatedByBalance = new Map();
  let nextLineNumber = Math.max(0, ...(issue.details || []).map((detail) => Number(detail.lineNumber || 0))) + 1;

  for (const detail of issue.details || []) {
    const qtyToIssue = Number(detail.qtyIssued || 0);
    if (qtyToIssue <= 0) continue;
    const identity = await resolveMaterialIssueIdentity(tx, detail);
    const balances = await tx.stockBalance.findMany({
      where: {
        warehouseCode: issue.warehouseCode,
        ...buildIdentityWhere(identity),
        ...(detail.uomCode ? { uomCode: { equals: detail.uomCode, mode: "insensitive" } } : {}),
        isDeleted: false,
        AND: [buildExcludeSpecialRackCondition()],
      },
      orderBy: [{ qtyAvailable: "desc" }, { lastMovement: "asc" }],
      select: {
        id: true,
        rackCode: true,
        lotNumber: true,
        uomCode: true,
        qtyAvailable: true,
      },
    });
    const reservations = issue.manufacturingOrder?.moNumber && balances.length
      ? await tx.stockReservation.findMany({
          where: {
            stockBalanceId: { in: balances.map((balance) => balance.id) },
            referenceType: "MANUFACTURING_ORDER",
            OR: [
              { referenceNumber: issue.manufacturingOrder.moNumber },
              { referenceNumber: { startsWith: `${issue.manufacturingOrder.moNumber}#` } },
            ],
            status: "Active",
            isDeleted: false,
          },
          select: { stockBalanceId: true, qtyReserved: true, qtyReleased: true },
        })
      : [];
    const reservedByBalance = reservations.reduce((totals, reservation) => {
      const openQty = Math.max(0, Number(reservation.qtyReserved || 0) - Number(reservation.qtyReleased || 0));
      totals.set(reservation.stockBalanceId, Number(totals.get(reservation.stockBalanceId) || 0) + openQty);
      return totals;
    }, new Map());
    const orderedBalances = [...balances].sort((left, right) => {
      const leftPinned = left.id === detail.stockBalanceId ? 1 : 0;
      const rightPinned = right.id === detail.stockBalanceId ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      const leftLocation = sameText(left.rackCode, detail.rackCode) && sameText(left.lotNumber, detail.lotNumber) ? 1 : 0;
      const rightLocation = sameText(right.rackCode, detail.rackCode) && sameText(right.lotNumber, detail.lotNumber) ? 1 : 0;
      if (leftLocation !== rightLocation) return rightLocation - leftLocation;
      return Number(right.qtyAvailable || 0) - Number(left.qtyAvailable || 0);
    });

    let remaining = qtyToIssue;
    const allocations = [];
    for (const balance of orderedBalances) {
      if (!hasEnoughMaterialIssueQty(remaining, 0.001)) break;
      const alreadyAllocated = Number(allocatedByBalance.get(balance.id) || 0);
      const issuableQty = Math.max(
        0,
        Number(balance.qtyAvailable || 0) + Number(reservedByBalance.get(balance.id) || 0) - alreadyAllocated,
      );
      const allocatedQty = Math.min(issuableQty, remaining);
      if (!hasEnoughMaterialIssueQty(allocatedQty, 0.001)) continue;
      allocations.push({ balance, qty: materialIssueQty(allocatedQty) });
      allocatedByBalance.set(balance.id, alreadyAllocated + allocatedQty);
      remaining = materialIssueQty(remaining - allocatedQty);
    }

    if (hasEnoughMaterialIssueQty(remaining, 0.001)) {
      const availableQty = materialIssueQty(qtyToIssue - remaining);
      throw new Error(
        `Stok tidak mencukupi untuk ${detail.partCode || detail.description || "item"} ` +
        `(bisa issue: ${formatMaterialIssueQty(availableQty)}, dibutuhkan: ${formatMaterialIssueQty(qtyToIssue)})`,
      );
    }

    const [primary, ...additional] = allocations;
    await tx.materialIssueDetail.update({
      where: { id: detail.id },
      data: {
        stockBalanceId: primary.balance.id,
        rackCode: primary.balance.rackCode || null,
        lotNumber: primary.balance.lotNumber || null,
        uomCode: primary.balance.uomCode || detail.uomCode,
        qtyRequired: Number(detail.qtyRequired || 0),
        qtyIssued: primary.qty,
      },
    });
    for (const allocation of additional) {
      await tx.materialIssueDetail.create({
        data: {
          issueId: issue.id,
          lineNumber: nextLineNumber++,
          partCode: detail.partCode,
          partNumber: detail.partNumber,
          partName: detail.partName,
          spec: detail.spec,
          thickness: detail.thickness,
          width: detail.width,
          CSP: detail.CSP,
          productId: detail.productId,
          description: detail.description,
          stockBalanceId: allocation.balance.id,
          requirementSource: detail.requirementSource,
          isSubAssembly: detail.isSubAssembly,
          rackCode: allocation.balance.rackCode || null,
          qtyRequired: 0,
          qtyIssued: allocation.qty,
          qtyReturned: 0,
          uomCode: allocation.balance.uomCode || detail.uomCode,
          lotNumber: allocation.balance.lotNumber || null,
          notes: `${detail.notes || ""}; stock source split automatically`.replace(/^;\s*/, ""),
        },
      });
    }
  }

  return tx.materialIssueDetail.findMany({
    where: { issueId: issue.id, isDeleted: false },
    orderBy: { lineNumber: "asc" },
  });
}

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
}

function assertWorkOrderReleasedForMaterialIssue(workOrder) {
  if (!workOrder) {
    throw Object.assign(new Error("Work Order tidak ditemukan."), { statusCode: 404 });
  }
  // A single WO can have multiple Material Issue documents (one per DPP
  // schedule/material bucket). After the first issue is published the WO is
  // moved to `Material Issued`, but remaining draft issues still need to be
  // edited/issued. Keep both states writable until production starts.
  if (!["Released", "Material Issued"].includes(workOrder.status)) {
    throw Object.assign(
      new Error(
        `Material Issue hanya bisa dibuat untuk WO Released. Status WO ${workOrder.woNumber || ""} sekarang "${workOrder.status}".`,
      ),
      { statusCode: 409 },
    );
  }
}

async function getMaterialIssueDeleteBlockers(tx, issue) {
  const [stockMovementCount, wipEntryCount] = await Promise.all([
    tx.stockMovement.count({
      where: {
        referenceNumber: issue.issueNumber,
        isDeleted: false,
      },
    }),
    tx.wIPEntry.count({
      where: {
        sourceType: "MaterialIssue",
        sourceId: issue.id,
      },
    }),
  ]);

  return [
    !["Draft", "Cancelled"].includes(issue.status) && `status ${issue.status}`,
    stockMovementCount > 0 && `${stockMovementCount} Stock Movement`,
    wipEntryCount > 0 && `${wipEntryCount} WIP Entry`,
  ].filter(Boolean);
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      woId,
      warehouseCode,
      status,
      startDate,
      endDate,
    } = req.query;

    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (moId) where.moId = moId;
    if (woId) where.woId = woId;
    if (warehouseCode) where.warehouseCode = warehouseCode;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.issueDate = {};
      if (startDate) where.issueDate.gte = new Date(startDate);
      if (endDate) where.issueDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { issueNumber: { contains: q, mode: "insensitive" } },
        { issuedBy: { contains: q, mode: "insensitive" } },
        { receivedBy: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { issueDate: "desc" } });
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.materialIssue.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          manufacturingOrder: {
            select: {
              moNumber: true,
              status: true,
              part: { select: { partCode: true, partName: true } },
            },
          },
          workOrder: {
            select: {
              woNumber: true,
              status: true,
              plannedQty: true,
              process: { select: { processCode: true, processName: true } },
            },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          _count: { select: { details: true } },
        },
      }),
      prisma.materialIssue.count({ where }),
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

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.materialIssue.findFirst({
      where: { issueNumber: req.params.issueNumber, isDeleted: false },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            part: { select: { partCode: true, partNumber: true, partName: true } },
          },
        },
        workOrder: {
          select: {
            id: true,
            woNumber: true,
            status: true,
            plannedQty: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
        warehouse: { select: { warehouseCode: true, warehouseName: true, location: true } },
        details: {
          where: { isDeleted: false },
          orderBy: { lineNumber: "asc" },
          include: {
            product: { select: { productCode: true, productName: true, uomCode: true } },
          },
        },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    const tracedDoc = await attachMaterialIssueCalculationTrace(doc);
    res.json(mapDoc(await attachMaterialIssueStock(tracedDoc)));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const {
      details = [],
      issueNumber: _issueNumber,
      issueDate: _issueDate,
      issuedBy: _issuedBy,
      status: _status,
      ...data
    } = req.body;

    const issueNumber = await generateIssueNumber();

    const doc = await prisma.$transaction(async (tx) => {
      if (!data.woId) {
        throw Object.assign(new Error("WO Number wajib diisi untuk Material Issue."), {
          statusCode: 400,
        });
      }
      const workOrder = await tx.workOrder.findFirst({
        where: { id: data.woId, isDeleted: false },
        select: { id: true, moId: true, woNumber: true, status: true },
      });
      assertWorkOrderReleasedForMaterialIssue(workOrder);
      data.moId = workOrder.moId;

      const created = await tx.materialIssue.create({
        data: {
          ...data,
          issueNumber,
          issueDate: new Date(),
        },
      });

      if (details.length > 0) {
        const detailRows = await Promise.all(
          details.map((detail, index) => mapMaterialIssueDetailInput(tx, detail, index, created.id)),
        );
        await tx.materialIssueDetail.createMany({
          data: detailRows,
        });
      }

      return tx.materialIssue.findUnique({
        where: { id: created.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: {
            select: { woNumber: true, process: { select: { processCode: true, processName: true } } },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: {
            where: { isDeleted: false },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: "Nomor Material Issue sudah digunakan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      details,
      issueNumber: _issueNumber,
      issueDate: _issueDate,
      issuedBy: _issuedBy,
      status: _status,
      ...data
    } = req.body;

    const updateData = { ...data };

    const existing = await prisma.materialIssue.findFirst({
      where: { issueNumber: req.params.issueNumber, isDeleted: false },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.status === "Closed") {
      return res.status(409).json({ message: "Material Issue yang sudah ditutup tidak dapat diubah." });
    }
    if (Array.isArray(details) && existing.status !== "Draft") {
      return res.status(409).json({ message: "Alokasi lot dan qty hanya dapat diubah saat Material Issue masih Draft." });
    }

    const doc = await prisma.$transaction(async (tx) => {
      if (!updateData.woId) {
        throw Object.assign(new Error("WO Number wajib diisi untuk Material Issue."), {
          statusCode: 400,
        });
      }
      const workOrder = await tx.workOrder.findFirst({
        where: { id: updateData.woId, isDeleted: false },
        select: { id: true, moId: true, woNumber: true, status: true },
      });
      assertWorkOrderReleasedForMaterialIssue(workOrder);
      updateData.moId = workOrder.moId;

      const updated = await tx.materialIssue.update({
        where: { id: existing.id },
        data: updateData,
      });

      // Jika details dikirim, hapus yang lama dan buat ulang
      if (Array.isArray(details)) {
        await tx.materialIssueDetail.deleteMany({ where: { issueId: existing.id } });
        if (details.length > 0) {
          const detailRows = await Promise.all(
            details.map((detail, index) => mapMaterialIssueDetailInput(tx, detail, index, existing.id)),
          );
          await tx.materialIssueDetail.createMany({
            data: detailRows,
          });
        }
      }

      return tx.materialIssue.findUnique({
        where: { id: updated.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: {
            select: { woNumber: true, process: { select: { processCode: true, processName: true } } },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: {
            where: { isDeleted: false },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      select: { id: true, issueNumber: true, isDeleted: true, status: true },
    });

    if (!existing) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.isDeleted) return res.status(409).json({ message: "Data Material Issue sudah dihapus." });

    const blockers = await getMaterialIssueDeleteBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `Material Issue tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}.`,
      });
    }

    await prisma.materialIssue.updateMany({
      where: { id: existing.id, isDeleted: false },
      data: { isDeleted: true },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }

    const records = await prisma.materialIssue.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, issueNumber: true, status: true },
    });

    const deletable = [];
    const skipped = [];
    for (const issue of records) {
      const blockers = await getMaterialIssueDeleteBlockers(prisma, issue);
      if (blockers.length > 0) {
        skipped.push({ issueNumber: issue.issueNumber, reason: formatRelationList(blockers) });
      } else {
        deletable.push(issue);
      }
    }

    if (deletable.length === 0) {
      return res.status(409).json({
        message: "Tidak ada Material Issue yang bisa dihapus. Material Issue hanya bisa dihapus jika Draft/Cancelled dan belum punya transaksi.",
        skipped,
      });
    }

    const result = await prisma.materialIssue.updateMany({
      where: { id: { in: deletable.map((issue) => issue.id) }, isDeleted: false },
      data: { isDeleted: true },
    });

    res.json({ deletedCount: result.count, skipped });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER ROUTES & STATUS TRANSITIONS
// ============================================================

exports.generateNumber = async (req, res, next) => {
  try {
    const issueNumber = await generateIssueNumber();
    res.json({ issueNumber });
  } catch (e) { next(e); }
};

// Draft → Issued (penerbitan material ke lantai produksi + auto stock deduction)
exports.issue = async (req, res, next) => {
  try {
    const issuedBy = getAuthenticatedIssuer(req.user);
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      include: {
        details: { where: { isDeleted: false } },
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { id: true, woNumber: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.status !== "Draft") {
      return res.status(409).json({ message: `Material Issue tidak bisa diterbitkan dari status "${existing.status}".` });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const movementDate = new Date();
      const detailsToIssue = await prepareDppMaterialIssueSources(tx, existing);

      // Kurangi stok per detail line
      for (const detail of detailsToIssue) {
        const qtyToIssue = Number(detail.qtyIssued || 0);
        if (qtyToIssue <= 0) continue;
        assertQuantity(qtyToIssue, detail.uomCode, "Qty Issue");

        const identity = await resolveMaterialIssueIdentity(tx, detail);

        // Cari stock balance berdasarkan sumber yang dipilih dari FE. Jika belum ada,
        // fallback ke warehouse + lot + identitas item yang sama dengan purchasing.
        const balanceWhere = detail.stockBalanceId
          ? {
              id: detail.stockBalanceId,
              warehouseCode: existing.warehouseCode,
              uomCode: detail.uomCode || null,
              isDeleted: false,
            }
          : {
              warehouseCode: existing.warehouseCode,
              ...buildIdentityWhere(identity),
              uomCode: detail.uomCode || null,
              isDeleted: false,
            };
        if (!detail.stockBalanceId && detail.rackCode) balanceWhere.rackCode = detail.rackCode;
        if (detail.lotNumber) balanceWhere.lotNumber = detail.lotNumber;
        if (!detail.stockBalanceId) {
          balanceWhere.AND = [
            ...(balanceWhere.AND || []),
            buildExcludeSpecialRackCondition(),
          ];
        }

        let stockBalance = await tx.stockBalance.findFirst({
          where: balanceWhere,
          orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
          select: { id: true, warehouseCode: true, stockType: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true,
                    partCode: true, partNumber: true, partName: true, materialId: true, materialCode: true, materialName: true,
                    spec: true, thickness: true, width: true, CSP: true,
                    productId: true, description: true, rackCode: true, lotNumber: true, uomCode: true },
        });

        const moNumber = existing.manufacturingOrder?.moNumber || null;
        let activeReservation = null;

        if (moNumber && stockBalance) {
          activeReservation = await tx.stockReservation.findFirst({
            where: {
              stockBalanceId: stockBalance.id,
              referenceType: "MANUFACTURING_ORDER",
              OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
              status: "Active",
              isDeleted: false,
            },
            orderBy: { createdAt: "asc" },
            select: { id: true, qtyReserved: true, qtyReleased: true },
          });
        }

        if (!stockBalance && moNumber) {
          const reservationWhere = {
            referenceType: "MANUFACTURING_ORDER",
            OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
            warehouseCode: existing.warehouseCode,
            status: "Active",
            isDeleted: false,
          };
          const reservationPartCode = identity.partCode || detail.partCode;
          if (reservationPartCode) reservationWhere.partCode = reservationPartCode;
          if (identity.productId) reservationWhere.productId = identity.productId;
          if (identity.description) reservationWhere.description = identity.description;
          if (identity.spec) reservationWhere.spec = identity.spec;
          if (identity.thickness != null) reservationWhere.thickness = identity.thickness;
          if (identity.width != null) reservationWhere.width = identity.width;
          if (identity.CSP) reservationWhere.CSP = identity.CSP;
          if (detail.rackCode) reservationWhere.rackCode = detail.rackCode;
          if (detail.lotNumber) reservationWhere.lotNumber = detail.lotNumber;
          if (detail.uomCode) reservationWhere.stockBalance = { uomCode: detail.uomCode };

          let reservation = await tx.stockReservation.findFirst({
            where: reservationWhere,
            orderBy: { createdAt: "asc" },
            include: {
              stockBalance: {
                select: {
                  id: true,
                  warehouseCode: true,
                  stockType: true,
                  qtyOnHand: true,
                  qtyReserved: true,
                  qtyAvailable: true,
                  partCode: true,
                  partNumber: true,
                  partName: true,
                  materialId: true,
                  materialCode: true,
                  materialName: true,
                  spec: true,
                  thickness: true,
                  width: true,
                  CSP: true,
                  productId: true,
                  description: true,
                  rackCode: true,
                  lotNumber: true,
                  isDeleted: true,
                  uomCode: true,
                },
              },
            },
          });

          if (!reservation) {
            const broadReservationWhere = {
              referenceType: "MANUFACTURING_ORDER",
              OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
              warehouseCode: existing.warehouseCode,
              status: "Active",
              isDeleted: false,
            };
            if (detail.stockBalanceId) broadReservationWhere.stockBalanceId = detail.stockBalanceId;
            else if (reservationPartCode) broadReservationWhere.partCode = reservationPartCode;
            if (detail.uomCode) broadReservationWhere.stockBalance = { uomCode: detail.uomCode };

            reservation = await tx.stockReservation.findFirst({
              where: broadReservationWhere,
              orderBy: { createdAt: "asc" },
              include: {
                stockBalance: {
                  select: {
                    id: true,
                    warehouseCode: true,
                    stockType: true,
                    qtyOnHand: true,
                    qtyReserved: true,
                    qtyAvailable: true,
                    partCode: true,
                    partNumber: true,
                    partName: true,
                    materialId: true,
                    materialCode: true,
                    materialName: true,
                    spec: true,
                    thickness: true,
                    width: true,
                    CSP: true,
                    productId: true,
                    description: true,
                    rackCode: true,
                    lotNumber: true,
                    isDeleted: true,
                    uomCode: true,
                  },
                },
              },
            });
          }

          if (reservation?.stockBalance && !reservation.stockBalance.isDeleted) {
            const { isDeleted: _isDeleted, ...reservationStockBalance } = reservation.stockBalance;
            stockBalance = reservationStockBalance;
            activeReservation = {
              id: reservation.id,
              qtyReserved: reservation.qtyReserved,
              qtyReleased: reservation.qtyReleased,
            };
          }
        }

        if (!stockBalance) {
          throw new Error(
            `Stok tidak mencukupi untuk ${detail.partCode || detail.description || "item"} ` +
            `(tersedia: 0.000, dibutuhkan: ${formatMaterialIssueQty(qtyToIssue)})`
          );
        }

        if (isSpecialRackCode(stockBalance.rackCode)) {
          throw new Error(
            `Stok ${detail.partCode || detail.description || "item"} berada di special rack ${stockBalance.rackCode} dan tidak boleh dipakai untuk Material Issue produksi`
          );
        }
        let qtyStillReserved = Math.max(
          0,
          Number(activeReservation?.qtyReserved || 0) - Number(activeReservation?.qtyReleased || 0)
        );
        let reservationReleaseQty = Math.min(qtyToIssue, qtyStillReserved);
        let nextReservedQty = Math.max(0, Number(stockBalance.qtyReserved) - reservationReleaseQty);
        let issuableQty = Number(stockBalance.qtyAvailable || 0) + qtyStillReserved;

        // Draft MI dapat menunjuk saldo/lot yang sudah habis karena stock bergerak
        // setelah dokumen disiapkan. Jika material yang sama masih cukup pada
        // balance lain, alihkan sumber secara otomatis sebelum posting.
        if (!hasEnoughMaterialIssueQty(issuableQty, qtyToIssue)) {
          const noteTokens = materialIssueNoteTokens(detail.notes);
          const sourceMaterialCode = stockBalance.materialCode || noteTokens.material || null;
          const alternateIdentity = [
            sourceMaterialCode ? { materialCode: { equals: sourceMaterialCode, mode: "insensitive" } } : null,
            identity.partCode ? { partCode: { equals: identity.partCode, mode: "insensitive" } } : null,
            identity.partNumber ? { partNumber: { equals: identity.partNumber, mode: "insensitive" } } : null,
            identity.productId ? { productId: identity.productId } : null,
          ].filter(Boolean);
          const alternateBalances = alternateIdentity.length ? await tx.stockBalance.findMany({
            where: {
              id: { not: stockBalance.id },
              warehouseCode: existing.warehouseCode,
              uomCode: detail.uomCode ? { equals: detail.uomCode, mode: "insensitive" } : undefined,
              isDeleted: false,
              AND: [buildExcludeSpecialRackCondition(), { OR: alternateIdentity }],
            },
            orderBy: [{ qtyAvailable: "desc" }, { lastMovement: "asc" }],
            take: 20,
            select: {
              id: true, warehouseCode: true, stockType: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true,
              partCode: true, partNumber: true, partName: true, materialId: true, materialCode: true, materialName: true,
              spec: true, thickness: true, width: true, CSP: true, productId: true, description: true,
              rackCode: true, lotNumber: true, uomCode: true,
            },
          }) : [];

          for (const candidate of alternateBalances) {
            const candidateReservation = moNumber ? await tx.stockReservation.findFirst({
              where: {
                stockBalanceId: candidate.id,
                referenceType: "MANUFACTURING_ORDER",
                OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
                status: "Active",
                isDeleted: false,
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, qtyReserved: true, qtyReleased: true },
            }) : null;
            const candidateReserved = Math.max(0, Number(candidateReservation?.qtyReserved || 0) - Number(candidateReservation?.qtyReleased || 0));
            const candidateIssuable = Number(candidate.qtyAvailable || 0) + candidateReserved;
            if (!hasEnoughMaterialIssueQty(candidateIssuable, qtyToIssue)) continue;

            stockBalance = candidate;
            activeReservation = candidateReservation;
            qtyStillReserved = candidateReserved;
            reservationReleaseQty = Math.min(qtyToIssue, qtyStillReserved);
            nextReservedQty = Math.max(0, Number(stockBalance.qtyReserved) - reservationReleaseQty);
            issuableQty = candidateIssuable;
            await tx.materialIssueDetail.update({
              where: { id: detail.id },
              data: {
                stockBalanceId: candidate.id,
                rackCode: candidate.rackCode || null,
                lotNumber: candidate.lotNumber || null,
                uomCode: candidate.uomCode || detail.uomCode,
                notes: `${detail.notes || ""}; source reallocated automatically from depleted stock balance`.replace(/^;\s*/, ""),
              },
            });
            break;
          }
        }

        if (!hasEnoughMaterialIssueQty(issuableQty, qtyToIssue)) {
          throw new Error(
            `Stok tidak mencukupi untuk ${detail.partCode || detail.description || "item"} ` +
            `(bisa issue: ${formatMaterialIssueQty(issuableQty)}, dibutuhkan: ${formatMaterialIssueQty(qtyToIssue)})`
          );
        }

        const qtyBefore = Number(stockBalance.qtyOnHand);
        // Selisih pecahan di bawah presisi operasional (3 desimal) tidak boleh
        // memblokir issue atau meninggalkan saldo negatif yang sangat kecil.
        const qtyAfter = Math.max(0, qtyBefore - qtyToIssue);

        // Buat stock movement OUT
        const movementNumber = await generateMovementNumber("OUT", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate,
            movementType: "OUT",
            direction: "OUT",
            transactionType: "PRODUCTION",
            warehouseCode: existing.warehouseCode,
            rackCode: stockBalance.rackCode || detail.rackCode || null,
            lotNumber: stockBalance.lotNumber || null,
            partCode: stockBalance.partCode || null,
            partNumber: identity.partNumber || stockBalance.partNumber || null,
            partName: detail.partName || identity.partName || stockBalance.partName || null,
            spec: identity.spec || stockBalance.spec || null,
            thickness: identity.thickness ?? stockBalance.thickness ?? null,
            width: identity.width ?? stockBalance.width ?? null,
            CSP: identity.CSP || stockBalance.CSP || null,
            productId: stockBalance.productId || null,
            description: stockBalance.description || identity.description || null,
            qty: qtyToIssue,
            deltaQty: -qtyToIssue,
            qtyBefore,
            qtyAfter,
            uomCode: detail.uomCode || null,
            referenceType: "WORK_ORDER",
            referenceNumber: existing.workOrder?.woNumber || existing.issueNumber,
            notes: `Material Issue untuk WO ${existing.workOrder?.woNumber || ""}`,
            performedBy: issuedBy || "system",
          },
        });

        if (activeReservation && reservationReleaseQty > 0) {
          const nextReleasedQty = Number(activeReservation.qtyReleased || 0) + reservationReleaseQty;
          await tx.stockReservation.update({
            where: { id: activeReservation.id },
            data: {
              qtyReleased: nextReleasedQty,
              status: nextReleasedQty >= Number(activeReservation.qtyReserved || 0) ? "Released" : "Active",
            },
          });
        }

        // Update stock balance. Reservation ikut dilepas karena barang sudah keluar dari gudang.
        await assertStockBalanceNotFrozen(tx, stockBalance.id);
        await tx.stockBalance.update({
          where: { id: stockBalance.id },
          data: {
            qtyOnHand: qtyAfter,
            qtyReserved: nextReservedQty,
            qtyAvailable: Math.max(0, qtyAfter - nextReservedQty),
            lastMovement: movementDate,
          },
        });

        // Catat WIP Entry — material cost masuk WIP
        await createWIPEntry(tx, {
          entryDate: movementDate,
          moId: existing.moId,
          woId: existing.woId || null,
          costType: "Material",
          sourceType: "MaterialIssue",
          sourceId: existing.id,
          sourceRef: existing.issueNumber,
          partCode: identity.partCode || null,
          partNumber: identity.partNumber || null,
          partName: identity.partName || identity.description || null,
          uomCode: detail.uomCode || null,
          warehouseCode: stockBalance.warehouseCode || null,
          rackCode: stockBalance.rackCode || null,
          lotNumber: stockBalance.lotNumber || null,
          stockType: stockBalance.stockType || null,
          qty: qtyToIssue,
          rate: 0, // Bisa diisi dari price list nanti
          amount: 0, // Bisa diisi dari price list nanti
          direction: "IN",
          notes: `Material ${identity.partCode || identity.partNumber || identity.description || ""} issued`,
          createdBy: issuedBy || "system",
        });
      }

      // Update status MI
      const updatedIssue = await tx.materialIssue.update({
        where: { id: existing.id },
        data: {
          status: "Issued",
          issueDate: movementDate,
          issuedBy: issuedBy || undefined,
        },
        include: {
          manufacturingOrder: { select: { moNumber: true } },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } },
        },
      });

      if (existing.woId) {
        await tx.workOrder.updateMany({
          where: {
            id: existing.woId,
            isDeleted: false,
            status: "Released",
          },
          data: { status: "Material Issued" },
        });
      }

      return updatedIssue;
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e.message?.startsWith("Stok tidak mencukupi")) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// Issued / Partially Returned → Closed (+ proses pengembalian stok jika ada qtyReturned)
exports.close = async (req, res, next) => {
  try {
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      include: {
        details: { where: { isDeleted: false } },
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { woNumber: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (![ "Issued", "Partially Returned" ].includes(existing.status)) {
      return res.status(409).json({ message: `Material Issue tidak bisa ditutup dari status "${existing.status}".` });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const movementDate = new Date();

      // Proses pengembalian stok untuk setiap detail yang punya qtyReturned > 0
      for (const detail of existing.details) {
        const qtyToReturn = Number(detail.qtyReturned || 0);
        if (qtyToReturn <= 0) continue;

        const identity = await resolveMaterialIssueIdentity(tx, detail);

        // Cari stock balance berdasarkan sumber yang dipilih dari FE. Jika belum ada,
        // fallback ke warehouse + lot + identitas item yang sama dengan purchasing.
        const balanceWhere = detail.stockBalanceId
          ? {
              id: detail.stockBalanceId,
              warehouseCode: existing.warehouseCode,
              uomCode: detail.uomCode || null,
              isDeleted: false,
            }
          : {
              warehouseCode: existing.warehouseCode,
              ...buildIdentityWhere(identity),
              uomCode: detail.uomCode || null,
              isDeleted: false,
            };
        if (!detail.stockBalanceId && detail.rackCode) balanceWhere.rackCode = detail.rackCode;
        if (detail.lotNumber) balanceWhere.lotNumber = detail.lotNumber;

        let stockBalance = await tx.stockBalance.findFirst({
          where: balanceWhere,
          select: { id: true, qtyOnHand: true, qtyReserved: true, partCode: true, partNumber: true, partName: true,
                    spec: true, thickness: true, width: true, CSP: true,
                    productId: true, description: true, rackCode: true, lotNumber: true, uomCode: true },
        });

        const qtyBefore = Number(stockBalance?.qtyOnHand || 0);
        const qtyAfter  = qtyBefore + qtyToReturn;

        // Buat stock movement IN (return material ke gudang)
        const movementNumber = await generateMovementNumber("IN", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate,
            movementType: "IN",
            direction: "IN",
            transactionType: "RETURN",
            warehouseCode: existing.warehouseCode,
            rackCode: stockBalance?.rackCode || detail.rackCode || null,
            lotNumber: stockBalance?.lotNumber || detail.lotNumber || null,
            partCode: identity.partCode || stockBalance?.partCode || null,
            partNumber: identity.partNumber || stockBalance?.partNumber || null,
            partName: detail.partName || identity.partName || stockBalance?.partName || null,
            spec: identity.spec || stockBalance?.spec || null,
            thickness: identity.thickness ?? stockBalance?.thickness ?? null,
            width: identity.width ?? stockBalance?.width ?? null,
            CSP: identity.CSP || stockBalance?.CSP || null,
            productId: identity.productId || stockBalance?.productId || null,
            description: stockBalance?.description || identity.description || null,
            qty: qtyToReturn,
            deltaQty: qtyToReturn,
            qtyBefore,
            qtyAfter,
            uomCode: detail.uomCode || null,
            referenceType: existing.workOrder?.woNumber ? "WORK_ORDER" : "MANUFACTURING_ORDER",
            referenceNumber: existing.workOrder?.woNumber || existing.manufacturingOrder?.moNumber || existing.issueNumber,
            notes: `Return material MI ${existing.issueNumber} ke gudang`,
            performedBy: req.user?.username || "system",
          },
        });

        // Update atau buat stock balance
        if (stockBalance) {
          await assertStockBalanceNotFrozen(tx, stockBalance.id);
          await tx.stockBalance.update({
            where: { id: stockBalance.id },
            data: {
              qtyOnHand: qtyAfter,
              qtyAvailable: qtyAfter - Number(stockBalance.qtyReserved || 0),
              lastMovement: movementDate,
            },
          });
        } else {
          // Balance tidak ada → buat baru
          await tx.stockBalance.create({
            data: {
              warehouseCode: existing.warehouseCode,
              rackCode: detail.rackCode || null,
              partCode: identity.partCode || null,
              partNumber: identity.partNumber || null,
              partName: detail.partName || identity.partName || null,
              spec: identity.spec || null,
              thickness: identity.thickness ?? null,
              width: identity.width ?? null,
              CSP: identity.CSP || null,
              productId: identity.productId || null,
              description: identity.description || null,
              lotNumber: detail.lotNumber || null,
              uomCode: detail.uomCode || null,
              qtyOnHand: qtyToReturn,
              qtyReserved: 0,
              qtyAvailable: qtyToReturn,
              lastMovement: movementDate,
            },
          });
        }
      }

      return tx.materialIssue.update({
        where: { id: existing.id },
        data: { status: "Closed" },
      });
    });

    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};
