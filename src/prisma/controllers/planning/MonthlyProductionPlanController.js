const { prisma } = require("../../index");
const { buildCapacitySnapshot } = require("../../services/planning/capacityPlanningService");
const { recommendMonthlyCapacity } = require("../../services/planning/capacityRecommendationService");
const { findPreset } = require("../../services/planning/capacitySimulationPresetService");
const dailyProductionScheduleController = require("../production/DailyProductionScheduleController");
const {
  buildMaterialReadinessSnapshot,
} = require("../../services/planning/materialReadinessService");
const {
  planningMonthKey: monthKey,
  utcMonthStart: monthStart,
  utcMonthEnd: monthEnd,
  utcMonthEndInstant,
} = require("../../utils/planningMonth");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const { isDiscreteUom, normalizeQuantity, splitQuantity } = require("../../utils/uomQuantity");
const include = { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } };

const text = (value) => String(value ?? "").trim() || null;
const dateOnly = (value) => {
  const input = String(value || "").slice(0, 10);
  const parsed = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const jakartaTodayDate = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateOnly(`${values.year}-${values.month}-${values.day}`);
};
function assertCapacityDateEditable(value) {
  const allocationDate = value instanceof Date ? dateOnly(value) : dateOnly(value);
  if (allocationDate && allocationDate < jakartaTodayDate()) {
    throw Object.assign(new Error(`Capacity ${allocationDate.toISOString().slice(0, 10)} sudah menjadi histori Production dan tidak dapat diubah.`), { statusCode: 409, code: "CAPACITY_HISTORY_LOCKED" });
  }
  return allocationDate;
}
const executionShift = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return ({ "1": "1A", "2": "2A", "3": "3A" })[normalized] || normalized;
};
const calendarDaysBetween = (start, end) => Math.max(Math.ceil((end - start) / 86400000), 0);
const freezeFenceDate = (days) => { const value = new Date(); value.setUTCHours(0, 0, 0, 0); value.setUTCDate(value.getUTCDate() + Math.max(Math.trunc(number(days)), 0)); return value; };
function requireFreezeOverride(plan, allocationDate, planningMode, body) {
  assertCapacityDateEditable(allocationDate);
  if (planningMode !== "PRODUCTION" || !allocationDate || allocationDate > freezeFenceDate(plan.freezeFenceDays)) return null;
  const reason = text(body?.freezeOverrideReason || body?.overrideReason);
  if (!reason || reason.length < 10) throw Object.assign(new Error(`Tanggal berada dalam freeze fence ${number(plan.freezeFenceDays)} hari. Isi alasan override minimal 10 karakter.`), { statusCode: 409, code: "CAPACITY_FREEZE_FENCE" });
  return reason;
}
const isGeneratedProcess = (row) => String(row?.notes || "").includes("[MRP-PRODUCTION]");
const isChildFgReceipt = (row) => isGeneratedProcess(row)
  && String(row?.part?.itemType || "").trim().toUpperCase() === "FG";

async function nextPlanNumber(tx, value) {
  const prefix = `MPP-${monthKey(value).replace("-", "")}-`;
  const last = await tx.monthlyProductionPlan.findFirst({ where: { planNumber: { startsWith: prefix } }, orderBy: { planNumber: "desc" }, select: { planNumber: true } });
  const sequence = Number(last?.planNumber?.split("-").pop() || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function nextDailyPlanNumber(tx, value) {
  const date = value instanceof Date ? value : new Date(value);
  const prefix = `DPS-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}-`;
  const last = await tx.dailyProductionSchedule.findFirst({
    where: { scheduleNumber: { startsWith: prefix } },
    orderBy: { scheduleNumber: "desc" },
    select: { scheduleNumber: true },
  });
  const sequence = number(last?.scheduleNumber?.split("-").pop()) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function nextWorkOrderNumber(tx, value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const prefix = `WO-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}-`;
  const last = await tx.workOrder.findFirst({
    where: { woNumber: { startsWith: prefix } },
    orderBy: { woNumber: "desc" },
    select: { woNumber: true },
  });
  return `${prefix}${String(number(last?.woNumber?.split("-").pop()) + 1).padStart(3, "0")}`;
}

function dailyPlanMarker(planNumber, allocation, moNumber) {
  return `[PPIC-DPP:${planNumber}:${allocation.lineNumber}:${allocation.mbomProcessId}:${allocation.scheduleDate}:${allocation.shift}:${moNumber}:${allocation.routingMode}]`;
}

function serialize(plan) {
  if (!plan) return plan;
  const receiptLines = plan.details.filter((row) => !isGeneratedProcess(row));
  const childReceiptLines = plan.details.filter(isChildFgReceipt);
  const processLines = plan.details.filter((row) => isGeneratedProcess(row) && !isChildFgReceipt(row));
  return {
    ...plan,
    targetQty: receiptLines.reduce((sum, row) => sum + number(row.qtyPlanned), 0),
    actualQty: receiptLines.reduce((sum, row) => sum + number(row.qtyReleased), 0),
    forecastQty: receiptLines.reduce((sum, row) => sum + number(row.forecastQty), 0),
    bufferQty: receiptLines.reduce((sum, row) => sum + number(row.bufferQty), 0),
    actualSalesOrderQty: receiptLines.reduce((sum, row) => sum + number(row.actualSalesOrderQty), 0),
    lineCount: plan.details.length,
    receiptLineCount: receiptLines.length,
    childReceiptLineCount: childReceiptLines.length,
    processLineCount: processLines.length,
    sourceMpsNumber: String(plan.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null,
  };
}

function detailFromMps(row, lineNumber) {
  const uomCode = row.part?.productionUomCode
    || row.part?.baseUomCode
    || row.part?.stockUomCode
    || row.mbom?.uomCode
    || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null);
  return {
    lineNumber,
    plannedOrderNumber: null,
    partCode: row.partCode,
    partId: row.partId || row.part?.id || null,
    mpsDetailId: row.id,
    forecastQty: number(row.forecastQty),
    actualSalesOrderQty: number(row.actualSalesOrderQty),
    bufferBaseQty: number(row.bufferBaseQty),
    bufferPercent: number(row.bufferPercent),
    bufferQty: number(row.bufferQty),
    productionPercent: number(row.productionPercent || 100),
    effectiveDemandQty: number(row.effectiveDemandQty),
    qtyPlanned: normalizeQuantity(row.qtyPlanned, uomCode),
    uomCode,
    requiredDate: row.endDate,
    priority: number(row.priority) || 1,
    status: "Planned",
    notes: `[MPS-LINE:${row.lineNumber}] ${row.notes || ""}`.trim(),
  };
}

function sourcePartCode(row) {
  return String(row?.notes || "").match(/;\s*source\s+(.+?)(?:;|$)/i)?.[1]?.trim() || null;
}

// Production Plan is an execution proposal: PPIC may reduce/increase the
// forecast portion here without changing the approved MPS.  Actual SO remains
// a hard floor, and child/SFG quantities follow their parent FG proportionally.
function derivePlanDetails(mpsDetails, productionPercent, netProductionByMpsDetail = new Map()) {
  const ratio = productionPercent / 100;
  const isProcess = (row) => isGeneratedProcess(row);
  const receipts = mpsDetails.filter((row) => !isProcess(row));
  const receiptById = new Map(receipts.map((row) => [row.id, row]));
  const receiptByLegacyKey = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${row.forecastPeriodOffset || ""}`, row]));
  const receiptByMonth = new Map(receipts.map((row) => [`${row.customerCode || ""}|${row.partCode}|${monthKey(row.startDate)}`, row]));
  const adjustedReceiptQty = new Map(receipts.map((row) => {
    const mrpNetQty = netProductionByMpsDetail.get(row.id);
    const baseQty = mrpNetQty == null
      ? Math.max(number(row.effectiveDemandQty), number(row.actualSalesOrderQty))
      : number(mrpNetQty);
    const uomCode = row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null);
    return [row.id, normalizeQuantity(baseQty * ratio, uomCode)];
  }));
  return mpsDetails.map((row) => {
    if (!isProcess(row)) {
      return {
        ...row,
        productionPercent,
        qtyPlanned: adjustedReceiptQty.get(row.id),
      };
    }
    const sourceId = String(row.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
    const source = receiptById.get(sourceId) || receiptByLegacyKey.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${row.forecastPeriodOffset || ""}`) || receiptByMonth.get(`${row.customerCode || ""}|${sourcePartCode(row) || ""}|${monthKey(row.startDate)}`);
    if (!source) {
      const rowUom = row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : row.uomCode);
      return { ...row, uomCode: row.uomCode || rowUom, qtyPlanned: normalizeQuantity(number(row.qtyPlanned) * ratio, rowUom) };
    }
    const sourceOriginalQty = Math.max(number(source.qtyPlanned), 0);
    const childFactor = sourceOriginalQty > 0 ? number(row.qtyPlanned) / sourceOriginalQty : 1;
    return {
      ...row,
      uomCode: row.uomCode || row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : null),
      forecastQty: number(row.forecastQty) || number(source.forecastQty), actualSalesOrderQty: number(row.actualSalesOrderQty) || number(source.actualSalesOrderQty), bufferBaseQty: number(row.bufferBaseQty) || number(source.bufferBaseQty), bufferPercent: number(row.bufferPercent) || number(source.bufferPercent), bufferQty: number(row.bufferQty) || number(source.bufferQty), effectiveDemandQty: number(row.effectiveDemandQty) || number(source.effectiveDemandQty), productionPercent,
      // Generated MPS process rows already contain the MRP-netted production
      // quantity. Only apply PPIC's explicit production percentage here.
      qtyPlanned: normalizeQuantity(netProductionByMpsDetail.has(source.id)
        ? number(row.qtyPlanned) * ratio
        : Math.max(adjustedReceiptQty.get(source.id) * childFactor, number(source.actualSalesOrderQty) * childFactor), row.part?.productionUomCode || row.part?.baseUomCode || row.part?.stockUomCode || (["FG", "WIP"].includes(String(row.part?.itemType || "").trim().toUpperCase()) ? "PCS" : row.uomCode)),
    };
  });
}

async function withMpsSnapshot(plan) {
  const mpsNumber = String(plan?.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;
  if (!mpsNumber) return plan;
  const mps = await prisma.mPS.findFirst({
    where: { mpsNumber, isDeleted: false },
    select: {
      details: {
        where: { isDeleted: false },
        select: {
          id: true,
          lineNumber: true,
          partCode: true,
          customerCode: true,
          startDate: true,
          notes: true,
          forecastQty: true,
          actualSalesOrderQty: true,
          bufferBaseQty: true,
          bufferPercent: true,
          bufferQty: true,
          productionPercent: true,
          effectiveDemandQty: true,
          qtyPlanned: true,
          part: { select: { partName: true, partNumber: true } },
        },
      },
    },
  });
  if (!mps) return plan;
  const byId = new Map(mps.details.map((row) => [row.id, row]));
  const byLineNumber = new Map(mps.details.map((row) => [String(row.lineNumber), row]));
  return {
    ...plan,
    details: plan.details.map((detail) => {
      const sourceLine = String(detail.notes || "").match(/\[MPS-LINE:(\d+)\]/)?.[1];
      const source = byId.get(detail.mpsDetailId) || byLineNumber.get(sourceLine);
      if (!source) return detail;
      const parentSourceId = String(source.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      const parentSource = byId.get(parentSourceId) || source;
      const synced = { ...detail, ...Object.fromEntries(["forecastQty", "actualSalesOrderQty", "bufferBaseQty", "bufferPercent", "bufferQty", "effectiveDemandQty"].map((field) => [field, source[field]])), mpsDetailId: source.id };
      synced.planningCustomerCode = parentSource.customerCode || null;
      synced.planningMonth = parentSource.startDate || plan.planMonth;
      synced.parentFgPartCode = parentSource.partCode || source.partCode || detail.partCode;
      synced.parentFgPartName = parentSource.part?.partName || parentSource.part?.partNumber || null;
      if (plan.status === "Draft" && !isGeneratedProcess(detail)) {
        synced.qtyPlanned = Math.max(
          number(source.effectiveDemandQty) * number(detail.productionPercent || 100) / 100,
          number(source.actualSalesOrderQty),
        );
      }
      return synced;
    }),
  };
}

async function withManufacturingOrderTrace(plan) {
  if (!plan?.planNumber) return plan;
  const manufacturingOrders = await prisma.manufacturingOrder.findMany({
    where: {
      monthlyProductionPlanNumber: plan.planNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      moNumber: true,
      monthlyProductionPlanLineNumber: true,
      qtyPlanned: true,
      qtyProduced: true,
      qtyGood: true,
      status: true,
      plannedStartDate: true,
      plannedEndDate: true,
      createdAt: true,
    },
    orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
  });
  const moIds = manufacturingOrders.map((mo) => mo.id).filter(Boolean);
  const moNumbers = manufacturingOrders.map((mo) => mo.moNumber).filter(Boolean);
  const dailyPlans = manufacturingOrders.length && (moIds.length || moNumbers.length) ? await prisma.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(moIds.length ? [{ moId: { in: moIds } }] : []),
        ...(moNumbers.length ? [{ moNumber: { in: moNumbers } }] : []),
      ],
    },
    select: { scheduleNumber: true, scheduleDate: true, shift: true, moId: true, moNumber: true, woId: true, woNumber: true, partCode: true, processId: true, machineId: true, plannedQty: true, actualQty: true, status: true },
    orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }],
  }) : [];
  const dailyByMo = new Map();
  for (const row of dailyPlans) {
    const key = row.moId || row.moNumber;
    if (!dailyByMo.has(key)) dailyByMo.set(key, []);
    dailyByMo.get(key).push(row);
  }
  const byLine = new Map();
  for (const mo of manufacturingOrders) {
    const key = Number(mo.monthlyProductionPlanLineNumber);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(mo);
  }
  return {
    ...plan,
    manufacturingOrders,
    dailyProductionPlans: dailyPlans,
    details: plan.details.map((detail) => ({
      ...detail,
      manufacturingOrders: (byLine.get(Number(detail.lineNumber)) || []).map((mo) => ({ ...mo, dailyProductionPlans: dailyByMo.get(mo.moNumber) || dailyByMo.get(mo.id) || [] })),
    })),
  };
}

function displayReference(type, value, href, label = null) {
  if (!value) return null;
  return {
    type,
    value,
    label: label || String(value),
    href,
  };
}

async function withPlanDisplayReferences(plan) {
  const details = Array.isArray(plan?.details) ? plan.details : [];
  const partIds = [...new Set(details.map((row) => row.partId).filter(Boolean))];
  const partCodes = [...new Set(details.map((row) => row.partCode).filter(Boolean))];
  const sourceMpsNumber = String(plan?.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const [parts, bomHeaders, processBoms, sourceMps, sourceMrp] = await Promise.all([
    partIds.length || partCodes.length
      ? prisma.part.findMany({
        where: {
          isDeleted: false,
          OR: [
            ...(partIds.length ? [{ id: { in: partIds } }] : []),
            ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
          ],
        },
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          partType: true,
        },
      })
      : [],
    partIds.length
      ? prisma.mBOMHeader.findMany({
        where: { partId: { in: partIds }, isDeleted: false },
        orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
        select: { noReg: true, partId: true, revision: true },
      })
      : [],
    partIds.length
      ? prisma.mBOMProcess.findMany({
        where: {
          isDeleted: false,
          mbomDetail: { partId: { in: partIds } },
        },
        orderBy: [{ noReg: "desc" }, { sequence: "asc" }],
        select: {
          noReg: true,
          mbomDetail: { select: { partId: true } },
        },
      })
      : [],
    sourceMpsNumber
      ? prisma.mPS.findFirst({
        where: { mpsNumber: sourceMpsNumber, isDeleted: false },
        select: { mpsNumber: true, mpsName: true, forecastNumber: true },
      })
      : null,
    sourceMpsNumber
      ? prisma.mRPRun.findFirst({
        where: {
          mpsNumber: sourceMpsNumber,
          isDeleted: false,
          isCurrentPlan: true,
          status: "Completed",
        },
        orderBy: { createdAt: "desc" },
        select: { runNumber: true, runDate: true, status: true },
      })
      : null,
  ]);
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const bomByPartId = new Map();
  for (const header of bomHeaders) {
    if (!bomByPartId.has(header.partId)) bomByPartId.set(header.partId, header);
  }
  for (const route of processBoms) {
    const partId = route.mbomDetail?.partId;
    if (partId && !bomByPartId.has(partId)) {
      bomByPartId.set(partId, { noReg: route.noReg, partId });
    }
  }
  const documentReferences = [
    displayReference(
      "FORECAST",
      sourceMps?.forecastNumber,
      sourceMps?.forecastNumber
        ? `/modules/sales/forecasts/${encodeURIComponent(sourceMps.forecastNumber)}`
        : null,
      sourceMps?.forecastNumber ? `Forecast ${sourceMps.forecastNumber}` : null,
    ),
    displayReference(
      "MPS",
      sourceMps?.mpsNumber || sourceMpsNumber,
      sourceMpsNumber
        ? `/modules/planning-ppic/mps/${encodeURIComponent(sourceMpsNumber)}`
        : null,
      sourceMpsNumber ? `Master Production Schedule ${sourceMpsNumber}` : null,
    ),
    displayReference(
      "MRP",
      sourceMrp?.runNumber,
      sourceMrp?.runNumber
        ? `/modules/planning-ppic/mrp/${encodeURIComponent(sourceMrp.runNumber)}`
        : null,
      sourceMrp?.runNumber ? `Material Requirements Plan ${sourceMrp.runNumber}` : null,
    ),
  ].filter(Boolean);
  return {
    ...plan,
    sourceMpsNumber,
    sourceMrpNumber: sourceMrp?.runNumber || null,
    sourceForecastNumber: sourceMps?.forecastNumber || null,
    documentReferences,
    details: details.map((detail) => {
      const part = partById.get(detail.partId) || partByCode.get(detail.partCode) || null;
      const bom = part?.id ? bomByPartId.get(part.id) : null;
      const lineType = !isGeneratedProcess(detail)
        ? "FG Receipt"
        : String(part?.itemType || "").toUpperCase() === "FG"
          ? "Child FG Receipt"
          : "Production Process";
      const referenceLinks = [
        displayReference(
          "PART",
          part?.partCode || detail.partCode,
          `/master-data/parts/${encodeURIComponent(part?.partCode || detail.partCode)}/edit?key=${encodeURIComponent(part?.partCode || detail.partCode)}`,
          [part?.partCode || detail.partCode, part?.partName].filter(Boolean).join(" · "),
        ),
        displayReference(
          "BOM",
          bom?.noReg,
          bom?.noReg
            ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(bom.noReg)}/edit`
            : null,
          bom?.noReg ? `Bill of Material ${bom.noReg}` : null,
        ),
        displayReference(
          "PLANNED_ORDER",
          detail.plannedOrderNumber,
          detail.plannedOrderNumber
            ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(detail.plannedOrderNumber)}`
            : null,
          detail.plannedOrderNumber ? `Planned Order ${detail.plannedOrderNumber}` : null,
        ),
        ...(detail.manufacturingOrders || []).map((mo) => displayReference(
          "MO",
          mo.moNumber,
          `/modules/production/manufacturing-orders/${encodeURIComponent(mo.moNumber)}`,
          `Manufacturing Order ${mo.moNumber}`,
        )),
      ].filter(Boolean);
      return {
        ...detail,
        part,
        bomNumber: bom?.noReg || null,
        lineType,
        displayName: part?.partName || part?.partNumber || detail.partCode,
        referenceLinks,
      };
    }),
  };
}

function planIssueReferences(issue, plan, sourceMrpNumber) {
  return [
    displayReference(
      "BOM",
      issue.bomNumber,
      issue.bomNumber
        ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(issue.bomNumber)}/edit`
        : null,
      issue.bomNumber ? `Perbaiki BOM ${issue.bomNumber}` : null,
    ),
    displayReference(
      "PART",
      issue.partCode,
      issue.partCode
        ? `/master-data/parts/${encodeURIComponent(issue.partCode)}/edit?key=${encodeURIComponent(issue.partCode)}`
        : null,
      issue.partCode
        ? [issue.partCode, issue.partName].filter(Boolean).join(" · ")
        : null,
    ),
    displayReference(
      "PLANNED_ORDER",
      issue.orderNumber,
      issue.orderNumber
        ? `/modules/planning-ppic/planned-orders/${encodeURIComponent(issue.orderNumber)}`
        : null,
      issue.orderNumber ? `Planned Order ${issue.orderNumber}` : null,
    ),
    displayReference(
      "MRP",
      sourceMrpNumber,
      sourceMrpNumber
        ? `/modules/planning-ppic/mrp/${encodeURIComponent(sourceMrpNumber)}`
        : null,
      sourceMrpNumber ? `MRP ${sourceMrpNumber}` : null,
    ),
    displayReference(
      "CAPACITY",
      issue.source === "CAPACITY" ? plan.planNumber : null,
      issue.source === "CAPACITY"
        ? `/modules/planning-ppic/capacity-planning?planNumber=${encodeURIComponent(plan.planNumber)}`
        : null,
      issue.source === "CAPACITY" ? "Buka Capacity Planning" : null,
    ),
  ].filter(Boolean);
}

function buildPlanReadiness(plan, capacity, materialReadiness) {
  const materialPartNames = new Map(
    (materialReadiness?.items || []).map((item) => [item.partCode, item.partName]),
  );
  const capacityIssues = (capacity?.readiness?.issues || [])
    .filter((issue) => ["blocking", "warning", "overridable"].includes(String(issue.severity || "").toLowerCase()))
    .filter((issue) => issue.planNumber === plan.planNumber || String(issue.code || "").startsWith("PLAN_"))
    .map((issue) => ({ ...issue, source: "CAPACITY" }));
  const materialIssues = (materialReadiness?.issues || []).map((issue) => ({
    ...issue,
    partName: issue.partName || materialPartNames.get(issue.partCode) || null,
    source: "MATERIAL",
  }));
  const issues = [...capacityIssues, ...materialIssues].map((issue) => {
    const severity = String(issue.severity || "WARNING").toUpperCase();
    return {
      ...issue,
      severity,
      title: [
        issue.partCode,
        issue.partName,
        issue.processName || issue.processCode,
        issue.machineName || issue.machineCode,
      ].filter(Boolean).join(" · ") || issue.code,
      references: planIssueReferences(issue, plan, materialReadiness?.mrpRunNumber),
    };
  });
  const blockingCount = issues.filter((issue) => issue.severity === "BLOCKING").length;
  const warningCount = issues.filter((issue) => issue.severity === "WARNING").length;
  const overridableCount = issues.filter((issue) => issue.severity === "OVERRIDABLE").length;
  const capacityOverrideRequired = overridableCount > 0 && plan.capacityOverrideApproved !== true;
  return {
    ready: blockingCount === 0 && !capacityOverrideRequired,
    releaseReady: blockingCount === 0 && !capacityOverrideRequired,
    capacityOverrideRequired,
    summary: {
      blocking: blockingCount,
      warning: warningCount,
      overridable: overridableCount,
      receiptOnlyFg: Number(capacity?.summary?.fgReceiptLineCount || 0),
      unscheduled: Number(capacity?.summary?.unscheduledCount || 0),
    },
    issues,
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(number(req.query.page) || 1, 1); const limit = Math.min(Math.max(number(req.query.limit) || 20, 1), 500); const q = String(req.query.q || req.query.search || "").trim();
    const where = { isDeleted: false, ...(q ? { OR: [{ planNumber: { contains: q, mode: "insensitive" } }, { status: { contains: q, mode: "insensitive" } }] } : {}) };
    const [items, total] = await Promise.all([prisma.monthlyProductionPlan.findMany({ where, include, orderBy: { planMonth: "desc" }, skip: (page - 1) * limit, take: limit }), prisma.monthlyProductionPlan.count({ where })]);
    res.json({ items: items.map(serialize), total, page, limit });
  } catch (error) { next(error); }
};

exports.listDailyPlans = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  return dailyProductionScheduleController.list(req, res, next);
};

exports.getDailyPlan = (req, res, next) => {
  req.query = { ...(req.query || {}), sourceModule: "PPIC" };
  req.params.scheduleNumber = req.params.scheduleNumber || req.params.planNumber;
  return dailyProductionScheduleController.get(req, res, next);
};

exports.get = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan" });
    const [snapshot, materialReadiness, capacity] = await Promise.all([
      withMpsSnapshot(plan),
      buildMaterialReadinessSnapshot(prisma, plan),
      buildCapacitySnapshot(prisma, {
        planNumber: plan.planNumber,
        startDate: plan.periodStart,
        endDate: plan.periodEnd,
      }),
    ]);
    const traced = await withManufacturingOrderTrace(snapshot);
    const displayPlan = await withPlanDisplayReferences(traced);
    res.json({
      ...serialize(displayPlan),
      materialReadiness,
      capacityReadiness: capacity.readiness,
      capacitySummary: capacity.summary,
      capacityUnscheduled: capacity.unscheduled,
      planReadiness: buildPlanReadiness(displayPlan, capacity, materialReadiness),
    });
  } catch (error) { next(error); }
};

exports.materialReadiness = async (req, res, next) => {
  try {
    res.json(await buildMaterialReadinessSnapshot(prisma, req.params.planNumber));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

exports.createFromMps = async (req, res, next) => {
  try {
    const mpsNumber = text(req.body?.mpsNumber);
    if (!mpsNumber) return res.status(400).json({ message: "MPS wajib dipilih." });
    const productionPercent = req.body?.productionPercent == null ? 100 : Number(req.body.productionPercent);
    if (!Number.isFinite(productionPercent) || productionPercent < 0 || productionPercent > 100) return res.status(400).json({ message: "Persentase Production Plan harus antara 0 sampai 100." });
    const mps = await prisma.mPS.findFirst({
      where: { mpsNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } }, include: { part: true }, orderBy: [{ startDate: "asc" }, { lineNumber: "asc" }] } },
    });
    if (!mps) return res.status(404).json({ message: "MPS tidak ditemukan." });
    if (mps.status !== "Confirmed") return res.status(409).json({ message: "MPS harus Confirmed sebelum dibuat menjadi Production Plan." });
    const completedMrp = await prisma.mRPRun.findFirst({ where: { mpsNumber, isDeleted: false, isCurrentPlan: true, status: "Completed" }, orderBy: { createdAt: "desc" }, select: { runNumber: true } });
    if (!completedMrp) return res.status(409).json({ message: "Jalankan MRP sampai Completed sebelum membuat Production Plan agar material sudah diperiksa." });
    const rootRequirements = await prisma.mRPRequirement.findMany({
      where: {
        runNumber: completedMrp.runNumber,
        isDeleted: false,
        orderType: "Production",
        requirementType: "Independent",
        levelMBOM: 0,
        mpsDetailId: { not: null },
      },
      select: { mpsDetailId: true, plannedOrderQty: true, adjustedOrderQty: true, netRequirement: true },
    });
    const netProductionByMpsDetail = new Map();
    for (const row of rootRequirements) {
      const qty = number(row.adjustedOrderQty || row.plannedOrderQty || row.netRequirement);
      netProductionByMpsDetail.set(row.mpsDetailId, number(netProductionByMpsDetail.get(row.mpsDetailId)) + qty);
    }
    const validDetails = derivePlanDetails(mps.details, productionPercent, netProductionByMpsDetail);
    if (!validDetails.length) return res.status(400).json({ message: "MPS belum mempunyai FG receipt atau child/SFG process." });

    const grouped = new Map();
    for (const row of validDetails) {
      const key = monthKey(row.startDate);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const sourceType = `MPS:${mps.mpsNumber}`;
    const result = await prisma.$transaction(async (tx) => {
      const plans = [];
      for (const [key, details] of grouped.entries()) {
        const planMonth = monthStart(key);
        const existing = await tx.monthlyProductionPlan.findFirst({ where: { sourceType, planMonth: { gte: monthStart(planMonth), lte: utcMonthEndInstant(planMonth) }, isDeleted: false }, include });
        if (existing) {
          if (existing.status === "Draft") {
            let nextLineNumber = Math.max(0, ...existing.details.map((row) => number(row.lineNumber))) + 1;
            const matchedIds = new Set();
            for (const row of details) {
              const sourceLineMarker = `[MPS-LINE:${row.lineNumber}]`;
              const matched = existing.details.find((detail) => detail.mpsDetailId === row.id || String(detail.notes || "").includes(sourceLineMarker));
              const data = detailFromMps(row, matched?.lineNumber || nextLineNumber++);
              if (matched) { matchedIds.add(matched.id); await tx.monthlyProductionPlanDetail.update({ where: { id: matched.id }, data }); }
              else await tx.monthlyProductionPlanDetail.create({ data: { ...data, planId: existing.id } });
            }
            const stale = existing.details.filter((detail) => !matchedIds.has(detail.id));
            if (stale.length) await tx.monthlyProductionPlanDetail.updateMany({ where: { id: { in: stale.map((detail) => detail.id) } }, data: { isDeleted: true, status: "Cancelled", notes: "Synchronized: MPS line no longer active" } });
            const positiveQtyCount = await tx.monthlyProductionPlanDetail.count({
              where: { planId: existing.id, isDeleted: false, qtyPlanned: { gt: 0.000001 } },
            });
            if (positiveQtyCount === 0) {
              await tx.monthlyProductionPlan.update({
                where: { id: existing.id },
                data: {
                  status: "Closed",
                  closedBy: req.user?.username || req.user?.email || "system",
                  closedAt: new Date(),
                  notes: `Production plan dari ${mps.mpsNumber}; kebutuhan produksi 0 karena demand sudah tercakup stock pada ${completedMrp.runNumber}.`,
                },
              });
            }
          }
          const synchronized = await tx.monthlyProductionPlan.findFirst({ where: { id: existing.id }, include });
          plans.push({ ...serialize(synchronized), existing: true, synchronized: existing.status === "Draft" });
          continue;
        }
        const planNumber = await nextPlanNumber(tx, planMonth);
        const noProductionRequired = details.every((row) => number(row.qtyPlanned) <= 0.000001);
        const created = await tx.monthlyProductionPlan.create({
          data: {
            planNumber,
            planMonth,
            periodStart: monthStart(planMonth),
            periodEnd: monthEnd(planMonth),
            status: noProductionRequired ? "Closed" : "Draft",
            sourceType,
            notes: noProductionRequired
              ? `Production plan dari ${mps.mpsNumber}; kebutuhan produksi 0 karena demand sudah tercakup stock pada ${completedMrp.runNumber}.`
              : `Production plan dari ${mps.mpsNumber}; material check ${completedMrp.runNumber}; adjustment ${productionPercent}% (minimum SO aktual)`,
            ...(noProductionRequired ? {
              closedBy: req.user?.username || req.user?.email || "system",
              closedAt: new Date(),
            } : {}),
            createdBy: req.user?.username || req.user?.email || null,
            details: {
              create: details.map((row, index) => detailFromMps(row, index + 1)),
            },
          },
          include,
        });
        plans.push({ ...serialize(created), existing: false });
      }
      return plans;
    });
    const actor = req.user?.username || req.user?.email || "system";
    const items = [];
    for (const item of result) {
      let capacityRecommendation = null;
      // First creation and Draft re-sync both receive a fresh recommendation.
      // The service only replaces its own AUTO_RECOMMENDATION rows; PPIC's
      // manual allocations remain authoritative.
      if ((!item.existing || item.synchronized) && item.status === "Draft") {
        try {
          capacityRecommendation = await recommendMonthlyCapacity(prisma, item.planNumber, { actor });
        } catch (recommendationError) {
          capacityRecommendation = { ready: false, error: recommendationError.message };
        }
      }
      items.push({ ...item, capacityRecommendation });
    }
    res.status(201).json({ items, total: items.length, sourceMpsNumber: mps.mpsNumber, mrpRunNumber: completedMrp.runNumber, productionPercent });
  } catch (error) { next(error); }
};

exports.recommendCapacity = async (req, res, next) => {
  try {
    const planningMode = String(req.body?.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
    const scenarioKey = planningMode === "SIMULATION" ? String(req.body?.scenarioKey || "").trim().toLowerCase() : null;
    const presetId = String(req.body?.presetId || scenarioKey || "").trim().toLowerCase() || null;
    if (planningMode === "SIMULATION" && !scenarioKey) return res.status(400).json({ message: "Pilih preset simulasi bulanan terlebih dahulu." });
    if (presetId && !(await findPreset(prisma, presetId))) return res.status(404).json({ message: "Preset capacity tidak ditemukan." });
    const planningGranularity = String(req.body?.planningGranularity || "DAY").toUpperCase() === "WEEK" ? "WEEK" : "DAY";
    const rollingLookbackWeeks = Math.min(Math.max(Math.trunc(number(req.body?.rollingLookbackWeeks)), 0), 12);
    const freezeFenceDays = Math.min(Math.max(Math.trunc(number(req.body?.freezeFenceDays)), 0), 31);
    await prisma.monthlyProductionPlan.update({ where: { planNumber: req.params.planNumber }, data: { planningGranularity, rollingLookbackWeeks, freezeFenceDays } });
    const recommendation = await recommendMonthlyCapacity(prisma, req.params.planNumber, {
      actor: req.user?.username || req.user?.email || "system",
      planningMode,
      scenarioKey,
      presetId,
    });
    if (planningMode === "PRODUCTION") {
      await prisma.monthlyProductionPlan.update({ where: { planNumber: req.params.planNumber }, data: { replanRequired: !recommendation.ready, replanReason: recommendation.ready ? null : "Capacity recommendation masih memiliki blocker.", ...(recommendation.ready ? { lastReplannedAt: new Date() } : {}) } });
      if (recommendation.ready) await prisma.planningChangeImpact.updateMany({ where: { status: "PENDING_REPLAN", affectedPlanNumbers: { array_contains: [req.params.planNumber] } }, data: { status: "RESOLVED", resolutionNotes: `Production Capacity dihitung ulang melalui ${req.params.planNumber}.`, resolvedBy: req.user?.username || req.user?.email || "system", resolvedAt: new Date() } });
    }
    res.json(recommendation);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.adoptCapacitySimulation = async (req, res, next) => {
  try {
    const scenarioKey = String(req.body?.scenarioKey || "").trim().toLowerCase();
    if (!/^preset-[a-z0-9-]{8,}$/i.test(scenarioKey)) return res.status(400).json({ message: "Pilih preset simulasi bulanan yang akan dijadikan Production Capacity." });
    const preset = await findPreset(prisma, scenarioKey);
    if (!preset) return res.status(404).json({ message: "Preset simulasi tidak ditemukan atau sudah tidak tersedia." });
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true, status: true, periodStart: true, periodEnd: true },
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({ message: `Production Capacity tidak dapat direvisi saat MPP berstatus ${plan.status}.` });
    }
    const today = jakartaTodayDate();
    const simulationRows = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, planningMode: "SIMULATION", scenarioKey, status: "Draft", isDeleted: false },
      orderBy: [{ scheduleDate: "asc" }, { plannedStartTime: "asc" }, { createdAt: "asc" }],
    });
    const simulation = simulationRows.filter((row) => dateOnly(row.scheduleDate) >= today);
    if (!simulation.length) return res.status(409).json({ message: "Preset tidak mempunyai allocation hari ini atau mendatang. Hari yang sudah lewat dikunci sebagai histori Production.", code: "CAPACITY_HISTORY_LOCKED" });
    const production = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, planningMode: "PRODUCTION", status: { in: ["Draft", "Published"] }, isDeleted: false },
      select: { id: true, lineNumber: true, mbomProcessId: true, scheduleDate: true, shift: true, plannedQty: true, deliveryPhaseId: true, transferBatchNumber: true },
    });
    const replaceableProduction = production.filter((row) => dateOnly(row.scheduleDate) >= today);
    const preservedProduction = production.filter((row) => dateOnly(row.scheduleDate) < today);
    const productionIds = replaceableProduction.map((row) => row.id);
    const linkedSchedules = await prisma.dailyProductionSchedule.findMany({
      where: { productionPlanId: plan.id, isDeleted: false, status: { not: "Cancelled" } },
      select: { id: true, scheduleNumber: true, scheduleDate: true, status: true },
    });
    const replaceableSchedules = linkedSchedules.filter((row) => dateOnly(row.scheduleDate) >= today);
    const lockedSchedules = replaceableSchedules.filter((row) => row.status !== "Draft");
    if (lockedSchedules.length) {
      return res.status(409).json({
        message: "Simulation tidak dapat mengganti Production Capacity karena DPP sudah dijalankan. Batalkan melalui workflow revisi DPP terlebih dahulu.",
        code: "DPP_REVISION_LOCKED",
        schedules: lockedSchedules,
      });
    }
    const actor = req.user?.username || req.user?.email || "system";
    const planningGranularity = String(req.body?.planningGranularity || "DAY").toUpperCase() === "WEEK" ? "WEEK" : "DAY";
    const rollingLookbackWeeks = Math.min(Math.max(Math.trunc(number(req.body?.rollingLookbackWeeks)), 0), 12);
    const freezeFenceDays = Math.min(Math.max(Math.trunc(number(req.body?.freezeFenceDays)), 0), 31);
    const result = await prisma.$transaction(async (tx) => {
      if (replaceableSchedules.length) await tx.dailyProductionSchedule.updateMany({ where: { id: { in: replaceableSchedules.map((row) => row.id) } }, data: { status: "Cancelled", isDeleted: true } });
      if (productionIds.length) await tx.productionPlanAllocation.updateMany({ where: { id: { in: productionIds } }, data: { status: "Cancelled", isDeleted: true } });
      const idMap = new Map();
      const simulationById = new Map(simulationRows.map((row) => [row.id, row]));
      const fingerprint = (row) => [row.lineNumber, row.mbomProcessId, dateOnly(row.scheduleDate)?.toISOString().slice(0, 10), row.shift, row.deliveryPhaseId || "", row.transferBatchNumber || "", number(row.plannedQty)].join("|");
      const preservedProductionByFingerprint = new Map(preservedProduction.map((row) => [fingerprint(row), row.id]));
      for (const source of simulation) {
        const created = await tx.productionPlanAllocation.create({
          data: {
            planId: source.planId, lineNumber: source.lineNumber, mbomProcessId: source.mbomProcessId,
            scheduleDate: source.scheduleDate, shift: source.shift, plannedStartTime: source.plannedStartTime,
            plannedEndTime: source.plannedEndTime, machineId: source.machineId, routingMode: source.routingMode,
            vendorId: source.vendorId, vendorSendDate: source.vendorSendDate, vendorReturnDate: source.vendorReturnDate,
            vendorLeadTimeDays: source.vendorLeadTimeDays, expectedReturnQty: source.expectedReturnQty,
            plannedQty: source.plannedQty, uomCode: source.uomCode, status: "Draft", notes: source.notes,
            allocationSource: source.allocationSource, planningMode: "PRODUCTION", scenarioKey: null,
            recommendationReason: source.recommendationReason, capacityMode: source.capacityMode,
            deliveryPhaseId: source.deliveryPhaseId, deliveryPhaseNumber: source.deliveryPhaseNumber,
            transferBatchNumber: source.transferBatchNumber, predecessorAllocationIds: null, createdBy: actor,
          },
        });
        idMap.set(source.id, created.id);
      }
      for (const source of simulation) {
        const mapped = Array.isArray(source.predecessorAllocationIds) ? source.predecessorAllocationIds.map((id) => {
          if (idMap.has(id)) return idMap.get(id);
          const historicalSource = simulationById.get(id);
          return historicalSource && dateOnly(historicalSource.scheduleDate) < today
            ? preservedProductionByFingerprint.get(fingerprint(historicalSource))
            : null;
        }).filter(Boolean) : [];
        if (mapped.length) await tx.productionPlanAllocation.update({ where: { id: idMap.get(source.id) }, data: { predecessorAllocationIds: mapped } });
      }
      const simulationMachineIds = [...new Set(simulation.filter((row) => row.routingMode === "INHOUSE" && row.machineId).map((row) => row.machineId))];
      const calendarStart = new Date(Math.max(plan.periodStart.getTime(), today.getTime()));
      for (let scheduleDate = calendarStart; scheduleDate <= plan.periodEnd; scheduleDate = new Date(scheduleDate.getTime() + 86400000)) {
        const date = scheduleDate.toISOString().slice(0, 10); const configured = preset.dailyOverrides?.[date] || null; const weekDay = scheduleDate.getUTCDay(); const weekendHoliday = !configured && ((weekDay === 6 && !preset.includeSaturday) || (weekDay === 0 && !preset.includeSunday));
        const dayStatus = configured?.dayStatus || (weekendHoliday ? "HOLIDAY" : "WORKING"); const shiftsPerDay = Math.max(1, Math.min(Number(configured?.shiftCount || preset.shiftCount || 1), 3)); const overtimeStart = configured?.overtimeStart || preset.overtimeStart || null; const overtimeEnd = configured?.overtimeEnd || preset.overtimeEnd || null;
        for (const machineId of simulationMachineIds) {
          await tx.capacityDayOverride.upsert({
            where: { planId_machineId_scheduleDate: { planId: plan.id, machineId, scheduleDate } },
            update: { dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason: `[SIMULATION-PRESET:${preset.id}] ${preset.name}`, changedBy: actor, changedAt: new Date(), isDeleted: false },
            create: { planId: plan.id, machineId, scheduleDate, dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason: `[SIMULATION-PRESET:${preset.id}] ${preset.name}`, changedBy: actor },
          });
        }
      }
      await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { planningGranularity, rollingLookbackWeeks, freezeFenceDays, replanRequired: false, replanReason: null, lastReplannedAt: new Date() } });
      await tx.planningChangeImpact.updateMany({ where: { status: "PENDING_REPLAN", affectedPlanNumbers: { array_contains: [plan.planNumber] } }, data: { status: "RESOLVED", resolutionNotes: `Simulation ${scenarioKey} diadopsi menjadi Production Capacity ${plan.planNumber}.`, resolvedBy: actor, resolvedAt: new Date() } });
      return { adoptedCount: idMap.size, appliedCalendarDays: plan.periodEnd < calendarStart ? 0 : Math.floor((plan.periodEnd - calendarStart) / 86400000) + 1, appliedMachineCount: simulationMachineIds.length, cancelledDppCount: replaceableSchedules.length, replacedProductionCount: productionIds.length, lockedPastAllocationCount: preservedProduction.length, lockedPastDppCount: linkedSchedules.length - replaceableSchedules.length };
    });
    res.json({ planNumber: plan.planNumber, scenarioKey, planningMode: "PRODUCTION", ...result, message: "Preset berhasil ditetapkan sebagai Production Capacity. Hari yang sudah lewat tetap dikunci sebagai histori." });
  } catch (error) { next(error); }
};

exports.confirm = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Draft") return res.status(409).json({ message: `Production Plan tidak dapat dikonfirmasi dari status ${plan.status}.` });
    if (!plan.details.length) return res.status(400).json({ message: "Production Plan tanpa detail tidak dapat dikonfirmasi." });
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Production Plan harus direplan setelah perubahan target delivery.", code: "DELIVERY_REPLAN_REQUIRED" });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Confirmed", confirmedBy: req.user?.username || req.user?.email || null, confirmedAt: new Date() }, include });
    res.json(serialize(updated));
  } catch (error) { next(error); }
};

exports.release = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (plan.status !== "Confirmed") return res.status(409).json({ message: `Production Plan harus Confirmed sebelum release, status saat ini ${plan.status}.` });
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Production Plan harus direplan setelah perubahan target delivery.", code: "DELIVERY_REPLAN_REQUIRED" });
    const capacity = await buildCapacitySnapshot(prisma, {
      ...(req.body || {}),
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      manualAllocation: true,
    });
    const materialReadiness = await buildMaterialReadinessSnapshot(prisma, plan);
    const hasOverridable = Number(capacity.readiness.overridableCount || 0) > 0 || Number(capacity.summary.overloadedCells || 0) > 0;
    const overrideApproved = plan.capacityOverrideApproved === true;
    if (!capacity.readiness.ok || (hasOverridable && !overrideApproved)) {
      return res.status(409).json({ message: "Production Plan belum dapat direlease. Lengkapi alokasi manual pada Capacity Check, pastikan tiap delivery phase tercukupi, lalu selesaikan blocker routing/overload.", code: "CAPACITY_NOT_READY", capacity: { summary: capacity.summary, readiness: capacity.readiness, deliveryCoverage: capacity.deliveryCoverage, unscheduled: capacity.unscheduled } });
    }
    if (!materialReadiness.ready) {
      return res.status(409).json({
        message: "Production Plan belum dapat direlease. Supplier/lead time atau jadwal kedatangan material dan purchase part belum siap.",
        code: "MATERIAL_NOT_READY",
        materialReadiness,
      });
    }
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { status: "Released", releasedBy: req.user?.username || req.user?.email || null, releasedAt: new Date() }, include });
    res.json({ ...serialize(updated), materialReadiness });
  } catch (error) { next(error); }
};

// PPIC owns the monthly-to-daily conversion. The capacity snapshot is the
// source of machine/date allocation; Production only consumes the resulting
// Daily Production Plan and follows its MO / Material Issue references.
exports.convertToDailyPlans = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({
        message: `Production Plan harus Released sebelum dikonversi ke Daily Production Plan. Status saat ini ${plan.status}.`,
        code: "MONTHLY_PLAN_NOT_RELEASED",
      });
    }
    if (plan.replanRequired) return res.status(409).json({ message: plan.replanReason || "Jalankan ulang Production Capacity sebelum revisi DPP.", code: "DELIVERY_REPLAN_REQUIRED" });

    // UOM is a foreign key in WO/DPP. Capacity allocations can originate from
    // legacy snapshots that use different letter casing (for example `PCS`
    // while the canonical master key is `pcs`). Publish the real master key.
    const masterUoms = await prisma.uom.findMany({
      where: { isDeleted: false },
      select: { uomCode: true },
    });
    const canonicalUomByLower = new Map(masterUoms.map((row) => [String(row.uomCode).trim().toLowerCase(), row.uomCode]));
    const canonicalUomCode = (...candidates) => {
      for (const candidate of candidates) {
        const value = String(candidate || "").trim();
        if (!value) continue;
        const canonical = canonicalUomByLower.get(value.toLowerCase());
        if (canonical) return canonical;
      }
      return null;
    };

    {
    const draftAllocations = await prisma.productionPlanAllocation.findMany({
      where: { planId: plan.id, isDeleted: false, status: "Draft", planningMode: "PRODUCTION" },
      include: {
        mbomProcess: {
          select: {
            id: true,
            noReg: true,
            mbomDetailId: true,
            processId: true,
            sequence: true,
            cycleTime: true,
            machineId: true,
            diesId: true,
            process: { select: { processCode: true, processName: true } },
            machine: { select: { costingRate: true, costingRateType: true, currencyCode: true } },
            mbomDetail: {
              select: {
                partId: true,
                part: { select: { partCode: true, partNumber: true, partName: true } },
              },
            },
          },
        },
      },
      orderBy: [{ scheduleDate: "asc" }, { lineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!draftAllocations.length) {
      return res.status(409).json({
        message: "Belum ada draft allocation MPP yang perlu dipublikasikan. Atur tanggal, mesin, shift, dan qty dari Capacity Check terlebih dahulu.",
        code: "MANUAL_MPP_ALLOCATION_REQUIRED",
      });
    }

    const manufacturingOrders = await prisma.manufacturingOrder.findMany({
      where: {
        monthlyProductionPlanNumber: plan.planNumber,
        isDeleted: false,
        status: { notIn: ["Cancelled", "Completed"] },
      },
      include: {
        part: { select: { partCode: true } },
        workOrders: {
          where: { isDeleted: false, status: { not: "Cancelled" } },
          orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
    });
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "MPP sudah dapat dialokasikan sebelum release, tetapi publish ke Daily Plan memerlukan MO/WO reference. Buat MO reference lalu ulangi publish.",
        code: "MO_REFERENCE_REQUIRED_FOR_PUBLISH",
      });
    }

    const allocationBomNumbers = [...new Set(
      draftAllocations.map((allocation) => allocation.mbomProcess?.noReg).filter(Boolean),
    )];
    const allocationBomHeaders = allocationBomNumbers.length
      ? await prisma.mBOMHeader.findMany({
        where: { noReg: { in: allocationBomNumbers }, isDeleted: false },
        select: { noReg: true, partId: true },
      })
      : [];
    const bomOwnerPartIdByNumber = new Map(
      allocationBomHeaders.map((header) => [header.noReg, header.partId]),
    );
    const sourceMpsNumber = String(plan.sourceType || "").startsWith("MPS:")
      ? String(plan.sourceType).slice(4)
      : null;
    const sourceMpsDetails = sourceMpsNumber ? await prisma.mPSDetail.findMany({
      where: { mpsNumber: sourceMpsNumber, isDeleted: false },
      select: { id: true, notes: true },
    }) : [];
    const sourceMpsById = new Map(sourceMpsDetails.map((row) => [row.id, row]));
    const planDetailByMpsId = new Map(plan.details.filter((row) => row.mpsDetailId).map((row) => [row.mpsDetailId, row]));
    const parentLineByLine = new Map();
    for (const detail of plan.details) {
      // MRP reruns can replace generated MPS detail ids. The MPP snapshot
      // keeps the immutable source marker, so prefer it over the current MPS row.
      const sourceId = String(detail.notes || sourceMpsById.get(detail.mpsDetailId)?.notes || "").match(/\[MPS-SOURCE:([^\]]+)\]/)?.[1];
      const parentDetail = sourceId ? planDetailByMpsId.get(sourceId) : null;
      if (parentDetail) parentLineByLine.set(number(detail.lineNumber), number(parentDetail.lineNumber));
    }
    const mosByPartId = new Map();
    for (const mo of manufacturingOrders) {
      if (!mo.partId) continue;
      if (!mosByPartId.has(mo.partId)) mosByPartId.set(mo.partId, []);
      mosByPartId.get(mo.partId).push(mo);
    }

    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const lineNumber = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(lineNumber)) mosByLine.set(lineNumber, []);
      mosByLine.get(lineNumber).push(mo);
    }
    const receiptLineNumbers = new Set(plan.details.filter((row) => !isGeneratedProcess(row)).map((row) => number(row.lineNumber)));
    const parentMOs = manufacturingOrders.filter((mo) => receiptLineNumbers.has(number(mo.monthlyProductionPlanLineNumber)));
    const mosForAllocation = (allocation) => {
      const ownerPartId = bomOwnerPartIdByNumber.get(allocation.mbomProcess?.noReg);
      const owned = ownerPartId ? (mosByPartId.get(ownerPartId) || []) : [];
      if (owned.length) return owned;
      const direct = mosByLine.get(number(allocation.lineNumber)) || [];
      if (direct.length) return direct;
      const parentLine = parentLineByLine.get(number(allocation.lineNumber));
      const parentOwned = parentLine ? (mosByLine.get(parentLine) || []) : [];
      if (parentOwned.length) return parentOwned;
      // A single-FG plan has an unambiguous fallback. Multi-FG plans must
      // never guess by processId because common processes (PRG/SPOT/WELD)
      // occur under several forecast parents.
      return parentMOs.length === 1 ? parentMOs : [];
    };

    const allocationById = new Map(draftAllocations.map((allocation) => [allocation.id, allocation]));
    const allocationDepthMemo = new Map();
    const allocationDepth = (allocation, visiting = new Set()) => {
      if (!allocation) return 0;
      if (allocationDepthMemo.has(allocation.id)) return allocationDepthMemo.get(allocation.id);
      if (visiting.has(allocation.id)) return 0;
      const nextVisiting = new Set(visiting).add(allocation.id);
      const predecessors = Array.isArray(allocation.predecessorAllocationIds)
        ? allocation.predecessorAllocationIds.map((id) => allocationById.get(id)).filter(Boolean)
        : [];
      const depth = predecessors.length
        ? Math.max(...predecessors.map((row) => allocationDepth(row, nextVisiting))) + 1
        : 0;
      allocationDepthMemo.set(allocation.id, depth);
      return depth;
    };
    const routeDepthById = new Map();
    const routePlannedQtyById = new Map();
    for (const allocation of draftAllocations) {
      const routeId = allocation.mbomProcess?.id;
      if (!routeId) continue;
      routeDepthById.set(routeId, Math.max(number(routeDepthById.get(routeId)), allocationDepth(allocation)));
      routePlannedQtyById.set(routeId, number(routePlannedQtyById.get(routeId)) + number(allocation.plannedQty));
    }

    // Create the exact child-routing WO needed by each capacity allocation.
    // The same process can occur more than once in a nested BOM, therefore
    // mbomProcessId (not processId) is the execution identity.
    const generatedWorkOrders = await prisma.$transaction(async (tx) => {
      const created = [];
      const generatedKeys = new Set();
      for (const allocation of draftAllocations) {
        if (String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR") continue;
        const route = allocation.mbomProcess;
        const mo = mosForAllocation(allocation)[0] || null;
        if (!route?.id || !route.processId || !mo) continue;
        const key = `${mo.id}|${route.id}`;
        if (generatedKeys.has(key) || (mo.workOrders || []).some((wo) => wo.mbomProcessId === route.id)) continue;
        generatedKeys.add(key);
        const workOrder = await tx.workOrder.create({
          data: {
            woNumber: await nextWorkOrderNumber(tx, allocation.scheduleDate),
            woDate: new Date(),
            moId: mo.id,
            mbomDetailId: route.mbomDetailId || null,
            mbomProcessId: route.id,
            outputPartId: route.mbomDetail?.partId || mo.partId || null,
            outputPartCode: route.mbomDetail?.part?.partCode || mo.part?.partCode || null,
            outputPartNumber: route.mbomDetail?.part?.partNumber || null,
            outputPartName: route.mbomDetail?.part?.partName || null,
            processId: route.processId,
            sequence: (number(routeDepthById.get(route.id)) + 1) * 10,
            cycleTime: number(route.cycleTime),
            diesId: route.diesId || null,
            machineId: allocation.machineId || route.machineId || null,
            machineCostingRate: route.machine?.costingRate ?? null,
            machineRateType: route.machine?.costingRateType || null,
            machineCurrency: route.machine?.currencyCode || null,
            plannedDate: allocation.scheduleDate,
            plannedQty: normalizeQuantity(routePlannedQtyById.get(route.id), canonicalUomCode(allocation.uomCode, mo.uomCode)),
            uomCode: canonicalUomCode(allocation.uomCode, mo.uomCode),
            status: "Planned",
            notes: `[MPP-CHILD-ROUTING:${plan.planNumber}:${allocation.lineNumber}:${route.id}] Generated from Capacity Planning`,
          },
        });
        mo.workOrders.push(workOrder);
        created.push(workOrder);
      }
      return created;
    });

    const moIds = manufacturingOrders.map((mo) => mo.id);
    const mbomProcessIds = [...new Set(draftAllocations.map((row) => row.mbomProcess?.id).filter(Boolean))];
    const committed = await prisma.dailyProductionSchedule.groupBy({
      by: ["moId", "mbomProcessId"],
      where: {
        moId: { in: moIds },
        mbomProcessId: { in: mbomProcessIds },
        isDeleted: false,
        status: { in: ["Draft", "Released", "In Progress", "Completed"] },
      },
      _sum: { plannedQty: true },
    });
    const committedByMoProcess = new Map(committed.map((row) => [
      `${row.moId}|${row.mbomProcessId}`,
      number(row._sum.plannedQty),
    ]));
    const remainingByMoProcess = new Map();
    const desired = [];
    const publishBlockers = [];

    for (const allocation of draftAllocations) {
      const processId = allocation.mbomProcess?.processId;
      const mbomProcessId = allocation.mbomProcess?.id;
      const candidateMos = mosForAllocation(allocation);
      if (!processId) {
        publishBlockers.push({ allocationId: allocation.id, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      if (!candidateMos.length) {
        publishBlockers.push({ allocationId: allocation.id, lineNumber: allocation.lineNumber, reason: "MO_REFERENCE_MISSING" });
        continue;
      }
      let qtyToAssign = number(allocation.plannedQty);
      for (const mo of candidateMos) {
        if (qtyToAssign <= 0.000001) break;
        const remainingKey = `${mo.id}|${mbomProcessId}`;
        const workOrder = (mo.workOrders || []).find((wo) => wo.mbomProcessId === mbomProcessId)
          || (mo.workOrders || []).find((wo) => !wo.mbomProcessId && wo.processId === processId) || null;
        if (!remainingByMoProcess.has(remainingKey)) {
          const executionTargetQty = workOrder ? number(workOrder.plannedQty) : number(mo.qtyPlanned);
          remainingByMoProcess.set(
            remainingKey,
            Math.max(executionTargetQty - number(committedByMoProcess.get(remainingKey)), 0),
          );
        }
        const available = number(remainingByMoProcess.get(remainingKey));
        if (available <= 0) continue;
        const assignedQty = normalizeQuantity(Math.min(qtyToAssign, available), canonicalUomCode(allocation.uomCode, mo.uomCode));
        if (!workOrder && String(allocation.routingMode || "INHOUSE").toUpperCase() !== "VENDOR") {
          publishBlockers.push({
            allocationId: allocation.id,
            moNumber: mo.moNumber,
            processCode: allocation.mbomProcess?.process?.processCode || null,
            reason: "WORK_ORDER_REFERENCE_MISSING",
          });
          qtyToAssign = 0;
          break;
        }
        desired.push({ allocation, mo, workOrder, processId, mbomProcessId, assignedQty });
        remainingByMoProcess.set(remainingKey, available - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) {
        publishBlockers.push({
          allocationId: allocation.id,
          lineNumber: allocation.lineNumber,
          remainingQty: qtyToAssign,
          reason: "MO_QTY_NOT_AVAILABLE",
        });
      }
    }
    if (publishBlockers.length) {
      return res.status(409).json({
        message: "Draft allocation belum dapat dipublikasikan karena MO/WO reference atau sisa qty belum mencukupi.",
        code: "ALLOCATION_PUBLISH_BLOCKED",
        blockers: publishBlockers,
      });
    }

    const published = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const item of desired) {
        const marker = `[PPIC-MPP-ALLOCATION:${item.allocation.id}:${item.mo.moNumber}]`;
        const scheduleDate = new Date(item.allocation.scheduleDate);
        rows.push(await tx.dailyProductionSchedule.create({
          data: {
            scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate),
            scheduleDate,
            shift: executionShift(item.allocation.shift),
            moId: item.mo.id,
            moNumber: item.mo.moNumber,
            woId: item.workOrder?.id || null,
            woNumber: item.workOrder?.woNumber || null,
            // A Daily Production Plan represents one routing operation, not
            // the parent MO receipt. Its item identity must therefore be the
            // operation output (WO for in-house, route detail for vendor).
            // Using the parent FG here creates empty Material Issues and leaves
            // every intermediate WIP lot unconsumed.
            partId: item.workOrder?.outputPartId
              || item.allocation.mbomProcess?.mbomDetail?.partId
              || item.mo.partId,
            partCode: item.workOrder?.outputPartCode
              || item.allocation.mbomProcess?.mbomDetail?.part?.partCode
              || item.mo.part?.partCode
              || null,
            processId: item.processId,
            productionPlanId: plan.id,
            productionPlanAllocationId: item.allocation.id,
            mbomProcessId: item.mbomProcessId,
            machineId: item.allocation.routingMode === "INHOUSE" ? item.allocation.machineId : null,
            vendorId: item.allocation.routingMode === "VENDOR" ? item.allocation.vendorId : null,
            plannedQty: item.assignedQty,
            uomCode: canonicalUomCode(item.allocation.uomCode, item.mo.uomCode),
            sequence: number(item.allocation.mbomProcess?.sequence),
            status: "Draft",
            notes: `${marker} mode ${item.allocation.routingMode}${item.allocation.vendorId ? `; vendor ${item.allocation.vendorId}` : ""}${item.allocation.vendorSendDate ? `; send ${String(item.allocation.vendorSendDate).slice(0, 10)}` : ""}${item.allocation.vendorReturnDate ? `; return ${String(item.allocation.vendorReturnDate).slice(0, 10)}` : ""}${item.allocation.expectedReturnQty != null ? `; expected return ${item.allocation.expectedReturnQty}` : ""}${item.allocation.notes ? `; ${item.allocation.notes}` : ""}`,
            createdBy: req.user?.username || req.user?.email || null,
          },
        }));
      }
      await tx.productionPlanAllocation.updateMany({
        where: { id: { in: draftAllocations.map((row) => row.id) }, status: "Draft", isDeleted: false },
        data: {
          status: "Published",
          publishedAt: new Date(),
          publishedBy: req.user?.username || req.user?.email || null,
        },
      });
      return rows;
    });
    return res.status(201).json({
      planNumber: plan.planNumber,
      items: published,
      total: published.length,
      summary: {
        createdCount: published.length,
        generatedWorkOrderCount: generatedWorkOrders.length,
        publishedAllocationCount: draftAllocations.length,
        updatedCount: 0,
      },
      ownership: {
        planner: "PPIC",
        source: "Manual MPP Allocation",
        executor: "Production",
      },
    });
    }

    const capacity = await buildCapacitySnapshot(prisma, {
      ...(req.body || {}),
      planNumber: plan.planNumber,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      ignoreDraftDailyPlans: true,
    });
    if (!capacity.readiness.ok) {
      return res.status(409).json({
        message: "Daily Production Plan belum dapat dibuat karena Capacity Check masih mempunyai blocker routing, mesin, atau cycle time.",
        code: "CAPACITY_BLOCKING",
        capacity: {
          summary: capacity.summary,
          readiness: capacity.readiness,
          unscheduled: capacity.unscheduled,
        },
      });
    }

    const unscheduled = (capacity.unscheduled || []).filter((row) => row.source === "PROPOSED" && row.reference === plan.planNumber);
    const allowPartial = Boolean(req.body?.allowPartial || plan.capacityOverrideApproved);
    if (unscheduled.length && !allowPartial) {
      return res.status(409).json({
        message: "Sebagian load belum memperoleh mesin/tanggal. Selesaikan Capacity Check atau gunakan override yang sudah di-approve.",
        code: "DAILY_PLAN_CAPACITY_INCOMPLETE",
        capacity: {
          summary: capacity.summary,
          readiness: capacity.readiness,
          unscheduled,
        },
      });
    }

    const rawAllocations = [];
    for (const machine of capacity.machines || []) {
      for (const [scheduleDate, cell] of Object.entries(machine.cells || {})) {
        for (const item of cell.items || []) {
          if (item.source !== "PROPOSED" || item.reference !== plan.planNumber || number(item.qty) <= 0 || !item.mbomProcessId) continue;
          const shiftCount = Math.min(Math.max(number(cell.capacityRule?.shiftsPerDay) || 1, 1), 3);
          const itemUom = item.uomCode || null;
          const shiftQuantities = splitQuantity(item.qty, shiftCount, itemUom);
          let remainingQty = normalizeQuantity(item.qty, itemUom);
          for (let shiftIndex = 1; shiftIndex <= shiftCount; shiftIndex += 1) {
            const shiftQty = shiftQuantities[shiftIndex - 1];
            remainingQty -= shiftQty;
            if (shiftQty <= 0) continue;
            rawAllocations.push({
              ...item,
              scheduleDate,
              shift: String(shiftIndex),
              qty: shiftQty,
              minutes: number(item.minutes) / shiftCount,
              machineId: machine.id,
              routingMode: "INHOUSE",
            });
          }
        }
      }
    }
    for (const item of capacity.vendorAssignments || []) {
      if (item.planNumber !== plan.planNumber || number(item.qty) <= 0 || !item.mbomProcessId) continue;
      rawAllocations.push({
        ...item,
        scheduleDate: String(item.scheduleDate).slice(0, 10),
        shift: "VENDOR",
        machineId: null,
        routingMode: "VENDOR",
      });
    }
    rawAllocations.sort((left, right) =>
      String(left.scheduleDate).localeCompare(String(right.scheduleDate))
      || number(left.sequence) - number(right.sequence)
      || String(left.shift).localeCompare(String(right.shift), undefined, { numeric: true }));

    if (!rawAllocations.length) {
      return res.status(409).json({
        message: "Capacity Check belum menghasilkan allocation harian untuk Production Plan ini.",
        code: "NO_DAILY_CAPACITY_ALLOCATION",
        capacity: { summary: capacity.summary, readiness: capacity.readiness, unscheduled },
      });
    }

    const lineNumbers = [...new Set(rawAllocations.map((row) => number(row.lineNumber)).filter(Boolean))];
    const routeIds = [...new Set(rawAllocations.map((row) => row.mbomProcessId).filter(Boolean))];
    const [manufacturingOrders, routes] = await Promise.all([
      prisma.manufacturingOrder.findMany({
        where: {
          monthlyProductionPlanNumber: plan.planNumber,
          isDeleted: false,
          status: { not: "Cancelled" },
        },
        include: {
          part: { select: { id: true, partCode: true } },
          workOrders: {
            where: { isDeleted: false, status: { not: "Cancelled" } },
            select: { id: true, woNumber: true, processId: true, sequence: true, machineId: true },
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          },
        },
        orderBy: [{ monthlyProductionPlanLineNumber: "asc" }, { createdAt: "asc" }],
      }),
      prisma.mBOMProcess.findMany({
        where: { id: { in: routeIds }, isDeleted: false },
        select: { id: true, processId: true, sequence: true },
      }),
    ]);
    if (!manufacturingOrders.length) {
      return res.status(409).json({
        message: "Belum ada MO reference dari Monthly Production Plan. Buat/release MO dari PPIC terlebih dahulu.",
        code: "MO_REFERENCE_REQUIRED",
      });
    }

    const routeById = new Map(routes.map((row) => [row.id, row]));
    const mosByLine = new Map();
    for (const mo of manufacturingOrders) {
      const key = number(mo.monthlyProductionPlanLineNumber);
      if (!mosByLine.has(key)) mosByLine.set(key, []);
      mosByLine.get(key).push(mo);
    }
    const parentMOs = mosByLine.get(1) || [];
    const mosForLine = (lineNumber) => {
      const direct = mosByLine.get(number(lineNumber)) || [];
      // A process/WIP MPP line is executed by the FG parent MO's routing.
      // Falling back to that MO prevents invalid child MOs without an MBOM
      // and keeps the daily plan linked to the actual production order.
      return direct.length ? direct : parentMOs;
    };
    const missingMoLines = [...new Set(rawAllocations
      .map((row) => number(row.lineNumber))
      .filter((lineNumber) => !mosForLine(lineNumber).length))];

    const markerPrefix = `[PPIC-DPP:${plan.planNumber}:`;
    const moIds = manufacturingOrders.map((row) => row.id);
    const existingSchedules = await prisma.dailyProductionSchedule.findMany({
      where: {
        isDeleted: false,
        moId: { in: moIds },
        OR: [
          { notes: { contains: markerPrefix } },
          { status: { notIn: ["Draft", "Cancelled"] } },
        ],
      },
      orderBy: [{ scheduleDate: "asc" }, { shift: "asc" }, { sequence: "asc" }],
    });
    const committedByMoProcess = new Map();
    for (const row of existingSchedules.filter((item) => item.status !== "Draft" && item.status !== "Cancelled" && item.processId)) {
      const key = `${row.moId}|${row.processId}`;
      committedByMoProcess.set(key, number(committedByMoProcess.get(key)) + number(row.plannedQty));
    }
    const remainingByMoProcess = new Map();
    const desired = [];
    const capacitySkipped = [];

    for (const allocation of rawAllocations) {
      const route = routeById.get(allocation.mbomProcessId);
      if (!route?.processId) {
        capacitySkipped.push({ ...allocation, reason: "ROUTING_PROCESS_REFERENCE_MISSING" });
        continue;
      }
      let qtyToAssign = number(allocation.qty);
      for (const mo of mosForLine(number(allocation.lineNumber))) {
        const remainingKey = `${mo.id}|${route.processId}`;
        if (!remainingByMoProcess.has(remainingKey)) {
          remainingByMoProcess.set(
            remainingKey,
            Math.max(number(mo.qtyPlanned) - number(committedByMoProcess.get(remainingKey)), 0),
          );
        }
        const availableForMo = number(remainingByMoProcess.get(remainingKey));
        if (availableForMo <= 0 || qtyToAssign <= 0) continue;
        const allocationUomCode = canonicalUomCode(allocation.uomCode, mo.uomCode);
        const assignedQty = isDiscreteUom(allocationUomCode)
          ? Math.min(Math.round(qtyToAssign), Math.round(availableForMo))
          : Math.min(qtyToAssign, availableForMo);
        const workOrder = (mo.workOrders || []).find((row) => row.processId === route.processId) || null;
        desired.push({
          ...allocation,
          processId: route.processId,
          sequence: number(allocation.sequence || route.sequence),
          qty: assignedQty,
          mo,
          workOrder,
        });
        remainingByMoProcess.set(remainingKey, availableForMo - assignedQty);
        qtyToAssign -= assignedQty;
      }
      if (qtyToAssign > 0.000001) capacitySkipped.push({ ...allocation, qty: qtyToAssign, reason: "MO_RELEASE_QTY_NOT_AVAILABLE" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const draftRows = existingSchedules.filter((row) => row.status === "Draft" && String(row.notes || "").includes(markerPrefix));
      const draftByMarker = new Map(draftRows.map((row) => [String(row.notes || "").match(/\[PPIC-DPP:[^\]]+\]/)?.[0], row]).filter(([marker]) => marker));
      const retainedDraftIds = new Set();
      const rows = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const allocation of desired) {
        const marker = dailyPlanMarker(plan.planNumber, allocation, allocation.mo.moNumber);
        const existing = draftByMarker.get(marker);
        const scheduleDate = new Date(`${allocation.scheduleDate}T00:00:00.000Z`);
        const data = {
          scheduleDate,
          shift: executionShift(allocation.shift),
          moId: allocation.mo.id,
          moNumber: allocation.mo.moNumber,
          woId: allocation.workOrder?.id || null,
          woNumber: allocation.workOrder?.woNumber || null,
          partId: allocation.mo.partId || null,
          partCode: allocation.partCode || allocation.mo.part?.partCode || null,
          processId: allocation.processId,
          machineId: allocation.routingMode === "INHOUSE" ? allocation.machineId : null,
          plannedQty: normalizeQuantity(allocation.qty, canonicalUomCode(allocation.uomCode, allocation.mo.uomCode)),
          uomCode: canonicalUomCode(allocation.uomCode, allocation.mo.uomCode),
          sequence: number(allocation.sequence),
          status: "Draft",
          notes: `${marker} Capacity ${number(allocation.minutes)} min; mode ${allocation.routingMode}${allocation.vendorId ? `; vendor ${allocation.vendorId}` : ""}${allocation.vendorSendDate ? `; send ${String(allocation.vendorSendDate).slice(0, 10)}` : ""}${allocation.vendorReturnDate ? `; return ${String(allocation.vendorReturnDate).slice(0, 10)}` : ""}${allocation.expectedReturnQty != null ? `; expected return ${allocation.expectedReturnQty}` : ""}${allocation.diesId ? `; dies ${allocation.diesId}` : ""}.`,
          createdBy: req.user?.username || req.user?.email || null,
        };
        if (existing) {
          retainedDraftIds.add(existing.id);
          rows.push(await tx.dailyProductionSchedule.update({ where: { id: existing.id }, data }));
          updatedCount += 1;
        } else {
          rows.push(await tx.dailyProductionSchedule.create({
            data: { scheduleNumber: await nextDailyPlanNumber(tx, scheduleDate), ...data },
          }));
          createdCount += 1;
        }
      }

      const staleIds = draftRows.filter((row) => !retainedDraftIds.has(row.id)).map((row) => row.id);
      if (staleIds.length) {
        await tx.dailyProductionSchedule.updateMany({
          where: { id: { in: staleIds } },
          data: { isDeleted: true, status: "Cancelled" },
        });
      }
      return { rows, createdCount, updatedCount, cancelledCount: staleIds.length };
    });

    res.status(result.createdCount ? 201 : 200).json({
      planNumber: plan.planNumber,
      ownership: {
        planner: "PPIC",
        source: "Monthly Production Plan + Capacity Check",
        executor: "Production",
      },
      items: result.rows,
      total: result.rows.length,
      summary: {
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        cancelledDraftCount: result.cancelledCount,
        unscheduledCount: unscheduled.length,
        skippedCapacityCount: capacitySkipped.length,
        missingMoLineCount: missingMoLines.length,
      },
      warnings: {
        unscheduled,
        missingMoLines,
        capacitySkipped,
      },
      capacity: {
        parameters: capacity.parameters,
        summary: capacity.summary,
        readiness: capacity.readiness,
      },
    });
  } catch (error) { next(error); }
};

// Persist PPIC's date/shift/qty decision before MPP release. This draft
// allocation deliberately has no MO/WO dependency; it is published to Daily
// Production Plan only after release has created the production references.
exports.createManualDailyPlan = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      include,
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed", "Released", "In Progress"].includes(plan.status)) {
      return res.status(409).json({ message: `MPP berstatus ${plan.status} tidak dapat menerima alokasi produksi baru.` });
    }
    const lineNumber = Number(req.body?.lineNumber);
    const planningMode = String(req.body?.planningMode || "PRODUCTION").toUpperCase() === "SIMULATION" ? "SIMULATION" : "PRODUCTION";
    const scenarioKey = planningMode === "SIMULATION" ? String(req.body?.scenarioKey || "").trim().toLowerCase() : null;
    const mbomProcessId = text(req.body?.mbomProcessId);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = dateOnly(routingMode === "VENDOR"
      ? (req.body?.vendorSendDate || req.body?.scheduleDate)
      : req.body?.scheduleDate);
    const shift = routingMode === "VENDOR" ? "VENDOR" : String(req.body?.shift || "1");
    const plannedQty = number(req.body?.plannedQty);
    const machineId = text(req.body?.machineId);
    const vendorId = text(req.body?.vendorId);
    const vendorReturnDate = routingMode === "VENDOR" ? dateOnly(req.body?.vendorReturnDate) : null;
    const expectedReturnQtyInput = req.body?.expectedReturnQty == null
      ? plannedQty
      : number(req.body.expectedReturnQty);
    const notes = text(req.body?.notes);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || !scheduleDate || plannedQty <= 0) {
      return res.status(400).json({ message: "Line, routing process, tanggal, dan qty alokasi wajib diisi." });
    }
    if (planningMode === "SIMULATION" && !/^preset-[a-z0-9-]{8,}$/i.test(scenarioKey || "")) return res.status(400).json({ message: "Simulation allocation harus memakai preset bulanan yang tersimpan." });
    if (planningMode === "SIMULATION" && !(await findPreset(prisma, scenarioKey))) return res.status(404).json({ message: "Preset simulasi tidak ditemukan." });
    if (scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) {
      return res.status(400).json({ message: "Tanggal alokasi harus berada dalam periode MPP." });
    }
    const freezeOverrideReason = requireFreezeOverride(plan, scheduleDate, planningMode, req.body);
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && (!machineId || !["1", "2", "3"].includes(shift))) || (routingMode === "VENDOR" && !vendorId)) {
      return res.status(400).json({ message: "Pilih shift dan mesin untuk in-house, atau vendor untuk proses vendor." });
    }
    if (routingMode === "VENDOR" && (!vendorReturnDate || vendorReturnDate < scheduleDate)) {
      return res.status(400).json({ message: "Tanggal kembali vendor wajib diisi dan tidak boleh sebelum tanggal kirim." });
    }
    if (routingMode === "VENDOR" && expectedReturnQtyInput <= 0) {
      return res.status(400).json({ message: "Qty ekspektasi kembali vendor harus lebih dari nol." });
    }
    const line = plan.details.find((row) => Number(row.lineNumber) === lineNumber && !row.isDeleted);
    if (!line) return res.status(404).json({ message: "Line Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({
      where: { id: mbomProcessId, isDeleted: false },
      include: {
        mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } },
        process: { select: { processCode: true, processName: true } },
      },
    });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) {
      return res.status(409).json({ message: "Routing process tidak sesuai dengan line Production Plan." });
    }
    if (!route.processId) return res.status(409).json({ message: "Routing belum mempunyai reference process." });
    let selectedVendor = null;
    if (routingMode === "INHOUSE") {
      const selectedMachine = await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: "Active" }, select: { id: true, machineSpecificationCode: true } });
      const requiredSpecification = route.machineSpecificationCode || (route.machineId ? (await prisma.machine.findUnique({ where: { id: route.machineId }, select: { machineSpecificationCode: true } }))?.machineSpecificationCode : null);
      if (!selectedMachine) {
        return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
      }
      if (!requiredSpecification || selectedMachine.machineSpecificationCode !== requiredSpecification) return res.status(409).json({ message: "Mesin tidak memenuhi Machine Specification routing BOM." });
    } else {
      selectedVendor = await prisma.vendor.findFirst({
        where: { id: vendorId, isDeleted: false, status: "Active" },
        select: { id: true, vendorCode: true, vendorName: true, leadTimeDays: true },
      });
      if (!selectedVendor) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    }

    const allocated = await prisma.productionPlanAllocation.aggregate({
      where: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        isDeleted: false,
        status: { in: ["Draft", "Published"] },
        planningMode,
        ...(planningMode === "SIMULATION" ? { scenarioKey } : {}),
      },
      _sum: { plannedQty: true },
    });
    const normalizedQty = normalizeQuantity(plannedQty, line.uomCode);
    const expectedReturnQty = routingMode === "VENDOR"
      ? normalizeQuantity(expectedReturnQtyInput, line.uomCode)
      : null;
    if (routingMode === "VENDOR" && expectedReturnQty > normalizedQty + 0.000001) {
      return res.status(409).json({ message: "Qty ekspektasi kembali tidak boleh melebihi qty yang dikirim ke vendor." });
    }
    const remainingQty = Math.max(number(line.qtyPlanned) - number(allocated._sum.plannedQty), 0);
    if (normalizedQty > remainingQty + 0.000001) {
      return res.status(409).json({ message: `Qty alokasi melebihi sisa MPP untuk proses ini. Sisa tersedia ${remainingQty} ${line.uomCode || ""}.` });
    }

    const allocation = await prisma.productionPlanAllocation.create({
      data: {
        planId: plan.id,
        lineNumber,
        mbomProcessId,
        scheduleDate,
        shift,
        machineId: routingMode === "INHOUSE" ? machineId : null,
        routingMode,
        vendorId: routingMode === "VENDOR" ? vendorId : null,
        vendorSendDate: routingMode === "VENDOR" ? scheduleDate : null,
        vendorReturnDate,
        vendorLeadTimeDays: routingMode === "VENDOR"
          ? Math.max(number(selectedVendor?.leadTimeDays), 0)
          : null,
        expectedReturnQty,
        plannedQty: normalizedQty,
        uomCode: line.uomCode || null,
        status: "Draft",
        planningMode,
        scenarioKey,
        notes: [notes, freezeOverrideReason ? `[FREEZE-OVERRIDE] ${freezeOverrideReason}` : null].filter(Boolean).join("; ") || null,
        createdBy: req.user?.username || req.user?.email || null,
      },
    });
    res.status(201).json({
      planNumber: plan.planNumber,
      planningMode,
      scenarioKey,
      allocation,
      summary: {
        createdCount: 1,
        plannedQty: normalizedQty,
        remainingQty: normalizeQuantity(remainingQty - normalizedQty, line.uomCode),
        ...(routingMode === "VENDOR" ? {
          vendorSchedule: {
            vendorCode: selectedVendor.vendorCode,
            sendDate: scheduleDate,
            returnDate: vendorReturnDate,
            plannedLeadTimeDays: calendarDaysBetween(scheduleDate, vendorReturnDate),
            masterLeadTimeDays: number(selectedVendor.leadTimeDays),
            expectedReturnQty,
          },
        } : {}),
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.updateManualAllocation = async (req, res, next) => {
  try {
    const allocation = await prisma.productionPlanAllocation.findFirst({
      where: { id: req.params.allocationId, isDeleted: false },
      include: {
        plan: { include: { details: { where: { isDeleted: false, status: { not: "Cancelled" } } } } },
        mbomProcess: { include: { machine: { select: { machineSpecificationCode: true } } } },
      },
    });
    if (!allocation || allocation.plan.planNumber !== req.params.planNumber) return res.status(404).json({ message: "Draft allocation tidak ditemukan." });
    if (allocation.status !== "Draft") return res.status(409).json({ message: "Hanya allocation Draft yang dapat diedit." });
    const routingMode = String(req.body?.routingMode || allocation.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = dateOnly(routingMode === "VENDOR" ? (req.body?.vendorSendDate || req.body?.scheduleDate) : req.body?.scheduleDate);
    const vendorReturnDate = routingMode === "VENDOR" ? dateOnly(req.body?.vendorReturnDate) : null;
    const plannedQty = normalizeQuantity(req.body?.plannedQty, allocation.uomCode);
    const expectedReturnQty = routingMode === "VENDOR" ? normalizeQuantity(req.body?.expectedReturnQty ?? plannedQty, allocation.uomCode) : null;
    const shift = routingMode === "VENDOR" ? "VENDOR" : String(req.body?.shift || allocation.shift || "1");
    const machineId = text(req.body?.machineId);
    const vendorId = text(req.body?.vendorId);
    if (!scheduleDate || plannedQty <= 0) return res.status(400).json({ message: "Tanggal dan qty allocation wajib diisi." });
    const freezeOverrideReason = requireFreezeOverride(allocation.plan, scheduleDate, allocation.planningMode, req.body);
    if (scheduleDate < allocation.plan.periodStart || scheduleDate > allocation.plan.periodEnd) return res.status(400).json({ message: "Tanggal allocation harus berada dalam periode MPP." });
    if (routingMode === "INHOUSE" && (!machineId || !["1", "2", "3"].includes(shift))) return res.status(400).json({ message: "Mesin dan shift wajib dipilih." });
    if (routingMode === "VENDOR" && (!vendorId || !vendorReturnDate || vendorReturnDate < scheduleDate)) return res.status(400).json({ message: "Vendor, tanggal kirim, dan tanggal kembali wajib valid." });
    if (routingMode === "VENDOR" && (expectedReturnQty <= 0 || expectedReturnQty > plannedQty + 0.000001)) return res.status(400).json({ message: "Qty kembali vendor harus lebih dari nol dan tidak melebihi qty kirim." });
    let selectedVendor = null;
    if (routingMode === "INHOUSE") {
      const machine = await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: "Active" }, select: { id: true, machineSpecificationCode: true } });
      const requiredSpecification = allocation.mbomProcess.machineSpecificationCode || allocation.mbomProcess.machine?.machineSpecificationCode;
      if (!machine || !requiredSpecification || machine.machineSpecificationCode !== requiredSpecification) return res.status(409).json({ message: "Mesin tidak aktif atau tidak memenuhi Machine Specification routing." });
    } else {
      selectedVendor = await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" }, select: { id: true, leadTimeDays: true } });
      if (!selectedVendor) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    }
    const line = allocation.plan.details.find((row) => Number(row.lineNumber) === Number(allocation.lineNumber));
    if (!line) return res.status(409).json({ message: "Line MPP allocation sudah tidak tersedia." });
    const other = await prisma.productionPlanAllocation.aggregate({
      where: {
        id: { not: allocation.id }, planId: allocation.planId, lineNumber: allocation.lineNumber,
        mbomProcessId: allocation.mbomProcessId, planningMode: allocation.planningMode,
        ...(allocation.planningMode === "SIMULATION" ? { scenarioKey: allocation.scenarioKey } : {}),
        isDeleted: false, status: { in: ["Draft", "Published"] },
      },
      _sum: { plannedQty: true },
    });
    const remainingQty = Math.max(number(line.qtyPlanned) - number(other._sum.plannedQty), 0);
    if (plannedQty > remainingQty + 0.000001) return res.status(409).json({ message: `Qty edit melebihi sisa MPP ${remainingQty} ${allocation.uomCode || ""}.` });
    const updated = await prisma.productionPlanAllocation.update({
      where: { id: allocation.id },
      data: {
        scheduleDate, shift, plannedQty, routingMode,
        machineId: routingMode === "INHOUSE" ? machineId : null,
        vendorId: routingMode === "VENDOR" ? vendorId : null,
        vendorSendDate: routingMode === "VENDOR" ? scheduleDate : null,
        vendorReturnDate, vendorLeadTimeDays: routingMode === "VENDOR" ? Math.max(number(selectedVendor?.leadTimeDays), 0) : null,
        expectedReturnQty, notes: [text(req.body?.notes), freezeOverrideReason ? `[FREEZE-OVERRIDE] ${freezeOverrideReason}` : null].filter(Boolean).join("; ") || null,
      },
    });
    res.json({ planNumber: allocation.plan.planNumber, allocation: updated, message: "Allocation berhasil diperbarui." });
  } catch (error) { next(error); }
};

exports.removeManualAllocation = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: req.params.planNumber, isDeleted: false },
      select: { id: true, planNumber: true, freezeFenceDays: true },
    });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    const allocation = await prisma.productionPlanAllocation.findFirst({
      where: { id: req.params.allocationId, planId: plan.id, isDeleted: false },
    });
    if (!allocation) return res.status(404).json({ message: "Draft allocation tidak ditemukan." });
    if (allocation.status !== "Draft") {
      return res.status(409).json({ message: "Allocation yang sudah dipublikasikan tidak dapat dihapus dari Capacity Check." });
    }
    requireFreezeOverride(plan, allocation.scheduleDate, allocation.planningMode, req.body);
    const updated = await prisma.productionPlanAllocation.update({
      where: { id: allocation.id },
      data: { status: "Cancelled", isDeleted: true },
    });
    res.json({ planNumber: plan.planNumber, allocation: updated });
  } catch (error) { next(error); }
};

exports.capacityOverride = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!["Draft", "Confirmed"].includes(plan.status)) return res.status(409).json({ message: "Capacity override hanya dapat dilakukan sebelum release." });
    const reason = String(req.body?.reason || req.body?.notes || "").trim();
    if (reason.length < 10) return res.status(400).json({ message: "Reason override minimal 10 karakter." });
    const updated = await prisma.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { capacityOverrideApproved: true, capacityOverrideReason: reason, capacityOverrideBy: req.user?.username || req.user?.email || "system", capacityOverrideAt: new Date() }, include });
    res.json({ ...serialize(updated), capacityOverride: { approved: true, reason } });
  } catch (error) { next(error); }
};

// PPIC may rebalance a plan to a machine alternative defined in the BOM routing.
// This deliberately writes a plan-level assignment, never mutating the MBOM
// default machine used by future plans.
exports.assignCapacityMachine = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, include });
    if (!plan) return res.status(404).json({ message: "Monthly Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Penggantian mesin hanya dapat dilakukan sebelum Production Plan release." });
    const lineNumber = Number(req.body?.lineNumber);
    const mbomProcessId = text(req.body?.mbomProcessId);
    const machineId = text(req.body?.machineId);
    const diesId = text(req.body?.diesId);
    const vendorId = text(req.body?.vendorId);
    const routingMode = String(req.body?.routingMode || "INHOUSE").toUpperCase();
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || !mbomProcessId || Number.isNaN(scheduleDate.getTime())) return res.status(400).json({ message: "Line, routing process, dan tanggal assignment wajib dipilih." });
    assertCapacityDateEditable(scheduleDate);
    if (!["INHOUSE", "VENDOR"].includes(routingMode) || (routingMode === "INHOUSE" && !machineId) || (routingMode === "VENDOR" && !vendorId)) return res.status(400).json({ message: "Pilih mesin untuk INHOUSE atau vendor untuk VENDOR." });
    if (reason.length < 10) return res.status(400).json({ message: "Alasan perpindahan mesin minimal 10 karakter." });
    const line = plan.details.find((item) => Number(item.lineNumber) === lineNumber && !item.isDeleted);
    if (!line) return res.status(404).json({ message: "Detail Production Plan tidak ditemukan." });
    const route = await prisma.mBOMProcess.findFirst({ where: { id: mbomProcessId, isDeleted: false }, include: { mbomDetail: { select: { partId: true, part: { select: { partCode: true } } } } } });
    if (!route || (line.partId && route.mbomDetail?.partId !== line.partId) || (!line.partId && route.mbomDetail?.part?.partCode !== line.partCode)) return res.status(409).json({ message: "Routing process tidak sesuai dengan part pada Production Plan." });
    const legacyMachine = route.machineId ? await prisma.machine.findUnique({ where: { id: route.machineId }, select: { machineSpecificationCode: true } }) : null;
    const requiredSpecification = route.machineSpecificationCode || legacyMachine?.machineSpecificationCode || null;
    const machine = machineId ? await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false, status: 'Active' }, select: { id: true, machineCode: true, machineName: true, machineSpecificationCode: true } }) : null;
    if (routingMode === "INHOUSE" && !machine) return res.status(409).json({ message: "Mesin tidak aktif atau tidak ditemukan." });
    if (routingMode === "INHOUSE" && (!requiredSpecification || machine.machineSpecificationCode !== requiredSpecification)) return res.status(409).json({ message: "Mesin tidak memenuhi Machine Specification routing BOM." });
    if (diesId && !await prisma.dies.findFirst({ where: { id: diesId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Dies/QD tidak aktif atau tidak ditemukan." });
    if (routingMode === "VENDOR" && !await prisma.vendor.findFirst({ where: { id: vendorId, isDeleted: false, status: "Active" } })) return res.status(409).json({ message: "Vendor tidak aktif atau tidak ditemukan." });
    const override = await prisma.capacityMachineOverride.upsert({
      where: { planId_lineNumber_mbomProcessId_scheduleDate: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate } },
      create: { planId: plan.id, lineNumber, mbomProcessId, scheduleDate, machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { machineId: routingMode === "INHOUSE" ? machineId : null, diesId, routingMode, vendorId: routingMode === "VENDOR" ? vendorId : null, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    res.json({ planNumber: plan.planNumber, lineNumber, mbomProcessId, override: { ...override, machine } });
  } catch (error) { next(error); }
};

exports.setCapacityDay = async (req, res, next) => {
  try {
    const plan = await prisma.monthlyProductionPlan.findFirst({ where: { planNumber: req.params.planNumber, isDeleted: false }, select: { id: true, planNumber: true, status: true, periodStart: true, periodEnd: true } });
    if (!plan) return res.status(404).json({ message: "Production Plan tidak ditemukan." });
    if (!['Draft', 'Confirmed'].includes(plan.status)) return res.status(409).json({ message: "Capacity harian hanya dapat diubah sebelum plan release." });
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || "").trim();
    if (Number.isNaN(scheduleDate.getTime()) || scheduleDate < plan.periodStart || scheduleDate > plan.periodEnd) return res.status(400).json({ message: "Tanggal harus berada dalam periode Production Plan." });
    assertCapacityDateEditable(scheduleDate);
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && (![1, 2, 3].includes(shiftsPerDay)))) return res.status(400).json({ message: "Status atau jumlah shift harian tidak valid." });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: "Jam mulai dan selesai lembur harus diisi berpasangan." });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: "Jam selesai lembur harus setelah jam mulai." });
    if (reason.length < 5) return res.status(400).json({ message: "Alasan perubahan capacity harian minimal 5 karakter." });
    if (!machineId || !await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false } })) return res.status(400).json({ message: "Mesin wajib dipilih." });
    const row = await prisma.capacityDayOverride.upsert({
      where: { planId_machineId_scheduleDate: { planId: plan.id, machineId, scheduleDate } },
      create: {
        planId: plan.id,
        machineId,
        scheduleDate,
        dayStatus,
        shiftsPerDay,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
      },
      update: {
        dayStatus,
        shiftsPerDay,
        overtimeStart,
        overtimeEnd,
        reason,
        changedBy: req.user?.username || req.user?.email || 'system',
        changedAt: new Date(),
        isDeleted: false,
      },
    });
    res.json(row);
  } catch (error) { next(error); }
};

// Global machine calendar: usable even when no MPP/Production Plan exists.
// It is intentionally separate from plan-scoped overrides so a global rule
// cannot accidentally mutate a specific plan.
exports.setGlobalCapacityDay = async (req, res, next) => {
  try {
    const scheduleDate = new Date(`${String(req.body?.scheduleDate || '').slice(0, 10)}T00:00:00.000Z`);
    const machineId = text(req.body?.machineId);
    const dayStatus = String(req.body?.dayStatus || 'WORKING').toUpperCase();
    const shiftsPerDay = req.body?.shiftsPerDay == null ? null : Number(req.body.shiftsPerDay);
    const reason = String(req.body?.reason || '').trim();
    if (Number.isNaN(scheduleDate.getTime()) || !machineId) return res.status(400).json({ message: 'Mesin dan tanggal wajib dipilih.' });
    assertCapacityDateEditable(scheduleDate);
    if (!['WORKING', 'HOLIDAY', 'OVERLOAD'].includes(dayStatus) || (shiftsPerDay != null && ![1, 2, 3].includes(shiftsPerDay))) return res.status(400).json({ message: 'Status atau jumlah shift harian tidak valid.' });
    const time = (value) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
    const overtimeStart = time(req.body?.overtimeStart);
    const overtimeEnd = time(req.body?.overtimeEnd);
    if (Boolean(overtimeStart) !== Boolean(overtimeEnd)) return res.status(400).json({ message: 'Jam mulai dan selesai lembur harus diisi berpasangan.' });
    if (overtimeStart && overtimeEnd && overtimeEnd <= overtimeStart) return res.status(400).json({ message: 'Jam selesai lembur harus setelah jam mulai.' });
    if (reason.length < 5) return res.status(400).json({ message: 'Alasan perubahan capacity harian minimal 5 karakter.' });
    if (!await prisma.machine.findFirst({ where: { id: machineId, isDeleted: false }, select: { id: true } })) return res.status(400).json({ message: 'Mesin tidak ditemukan.' });
    const row = await prisma.capacityCalendarOverride.upsert({
      where: { machineId_scheduleDate: { machineId, scheduleDate } },
      create: { machineId, scheduleDate, dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system' },
      update: { dayStatus, shiftsPerDay, overtimeStart, overtimeEnd, reason, changedBy: req.user?.username || req.user?.email || 'system', changedAt: new Date(), isDeleted: false },
    });
    res.json({ scope: 'GLOBAL', ...row });
  } catch (error) { next(error); }
};
