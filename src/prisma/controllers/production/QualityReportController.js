const { prisma } = require("../../index");
const { calculateLiveMbomCosts } = require("../../services/mbomLiveCostingService");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const text = (value) => String(value || "").trim();

function dateRange(query) {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = query.startDate ? new Date(`${query.startDate}T00:00:00+07:00`) : defaultStart;
  const endBase = query.endDate ? new Date(`${query.endDate}T00:00:00+07:00`) : now;
  const endExclusive = new Date(endBase);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return {
    start: Number.isNaN(start.getTime()) ? defaultStart : start,
    endExclusive: Number.isNaN(endExclusive.getTime()) ? new Date(now.getTime() + 86400000) : endExclusive,
  };
}

function activeOn(row, at) {
  const time = at.getTime();
  const effectiveUntilInclusive = row.effectiveUntil
    ? new Date(row.effectiveUntil).getTime() + 86400000 - 1
    : null;
  return row.isActive && !row.isDeleted
    && new Date(row.effectiveFrom).getTime() <= time
    && (effectiveUntilInclusive == null || effectiveUntilInclusive >= time);
}

function resolveScrapPrice(prices, partCode, materialType, at) {
  const applicable = prices.filter((row) => activeOn(row, at));
  const ranked = applicable.map((row) => {
    let score = 0;
    if (row.partCode && text(row.partCode).toUpperCase() === text(partCode).toUpperCase()) score = 300;
    else if (row.partCode) return null;
    else if (row.materialType && text(row.materialType).toUpperCase() === text(materialType).toUpperCase()) score = 200;
    else if (row.materialType) return null;
    else score = 100;
    return { row, score };
  }).filter(Boolean).sort((left, right) => right.score - left.score || new Date(right.row.effectiveFrom) - new Date(left.row.effectiveFrom));
  return ranked[0]?.row || null;
}

function partWeight(part) {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  const preferred = [...bases].sort((left, right) => {
    const actual = (value) => text(value.baseOn).toUpperCase() === "ACTUAL" ? 1 : 0;
    return actual(right) - actual(left) || new Date(right.updatedAt) - new Date(left.updatedAt);
  })[0];
  if (number(preferred?.netWeight) > 0) return { kg: number(preferred.netWeight), source: "Net Weight Part (Actual)" };
  if (number(preferred?.grossWeight) > 0) return { kg: number(preferred.grossWeight), source: "Gross Weight Part (fallback)" };
  return { kg: 0, source: "Berat part belum diisi" };
}

exports.valueReport = async (req, res, next) => {
  try {
    const { start, endExclusive } = dateRange(req.query);
    const reasons = await prisma.productionLogNgReason.findMany({
      where: {
        isDeleted: false,
        status: { in: ["REWORK", "REJECT", "MIXED"] },
        judgedAt: { gte: start, lt: endExclusive },
        productionLog: { is: { isDeleted: false } },
      },
      include: {
        productionLog: {
          include: {
            manufacturingOrder: {
              select: {
                moNumber: true,
                part: {
                  select: {
                    id: true,
                    partCode: true,
                    partNumber: true,
                    partName: true,
                    material: { select: { materialType: true, materialName: true } },
                    partBases: { select: { baseOn: true, netWeight: true, grossWeight: true, updatedAt: true } },
                  },
                },
              },
            },
            workOrder: { select: { woNumber: true, process: { select: { processCode: true, processName: true } } } },
          },
        },
      },
      orderBy: [{ judgedAt: "asc" }, { createdAt: "asc" }],
    });

    const byLog = new Map();
    for (const reason of reasons) {
      const log = reason.productionLog;
      if (!byLog.has(log.id)) byLog.set(log.id, {
        log,
        judgedAt: reason.judgedAt,
        qtyNg: 0,
        qtyRework: 0,
        qtyScrap: 0,
        reasonLabels: new Set(),
      });
      const group = byLog.get(log.id);
      group.qtyNg += number(reason.qtyNg);
      group.qtyRework += number(reason.qtyRework);
      group.qtyScrap += number(reason.qtyReject);
      group.reasonLabels.add([reason.reason, reason.subReason].filter(Boolean).join(" — "));
      if (reason.judgedAt && (!group.judgedAt || reason.judgedAt > group.judgedAt)) group.judgedAt = reason.judgedAt;
    }

    const logNumbers = [...byLog.values()].map((group) => group.log.logNumber);
    const partIds = [...new Set([...byLog.values()].map((group) => group.log.manufacturingOrder?.part?.id).filter(Boolean))];
    const [reworkOrders, scrapPrices, bomHeaders, liveCosts] = await Promise.all([
      logNumbers.length ? prisma.workOrder.findMany({
        where: { isDeleted: false, isReworkOrder: true, reworkReferenceNumber: { in: logNumbers }, status: { not: "Cancelled" } },
        select: { woNumber: true, reworkReferenceNumber: true, plannedQty: true, qtyGood: true, qtyReject: true, status: true, endTime: true },
      }) : [],
      prisma.scrapPriceMaster.findMany({ where: { isDeleted: false, isActive: true }, orderBy: { effectiveFrom: "desc" } }),
      partIds.length ? prisma.mBOMHeader.findMany({ where: { isDeleted: false, partId: { in: partIds } }, select: { id: true, partId: true, revision: true, updatedAt: true }, orderBy: [{ revision: "desc" }, { updatedAt: "desc" }] }) : [],
      partIds.length ? calculateLiveMbomCosts(prisma, { costingDate: endExclusive }).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);

    const reworkByLog = new Map();
    for (const order of reworkOrders) {
      const current = reworkByLog.get(order.reworkReferenceNumber) || { plannedQty: 0, qtyGood: 0, qtyReject: 0, woNumbers: [], statuses: [], completedAt: null };
      current.plannedQty += number(order.plannedQty);
      current.qtyGood += number(order.qtyGood);
      current.qtyReject += number(order.qtyReject);
      current.woNumbers.push(order.woNumber);
      current.statuses.push(order.status);
      if (order.endTime && (!current.completedAt || order.endTime > current.completedAt)) current.completedAt = order.endTime;
      reworkByLog.set(order.reworkReferenceNumber, current);
    }
    const latestBomByPart = new Map();
    for (const header of bomHeaders) if (!latestBomByPart.has(header.partId)) latestBomByPart.set(header.partId, header);

    let rows = [...byLog.values()].map((group) => {
      const log = group.log;
      const part = log.manufacturingOrder?.part || {};
      const rework = reworkByLog.get(log.logNumber) || { plannedQty: group.qtyRework, qtyGood: 0, qtyReject: 0, woNumbers: [], statuses: [] };
      const weight = partWeight(part);
      const materialType = part.material?.materialType || "";
      const scrapPrice = resolveScrapPrice(scrapPrices, part.partCode, materialType, group.judgedAt || log.logDate);
      const unitCost = number(liveCosts.get(latestBomByPart.get(part.id)?.id)?.costPerUnit);
      const successfulQty = Math.min(number(rework.qtyGood), group.qtyRework || number(rework.qtyGood));
      const scrapKg = group.qtyScrap * weight.kg;
      return {
        qcDate: group.judgedAt,
        logNumber: log.logNumber,
        moNumber: log.manufacturingOrder?.moNumber || "-",
        woNumber: log.workOrder?.woNumber || "-",
        reworkWoNumbers: rework.woNumbers.join(", ") || "Belum dibuat",
        partCode: part.partCode || "-",
        partNumber: part.partNumber || "-",
        partName: part.partName || "-",
        processCode: log.workOrder?.process?.processCode || log.processCode || "-",
        processName: log.workOrder?.process?.processName || "-",
        ngReason: [...group.reasonLabels].join("; ") || "-",
        qtyNg: round(group.qtyNg),
        qtyReworkDecision: round(group.qtyRework),
        reworkSuccessfulQty: round(successfulQty),
        reworkRecoveryPercent: group.qtyRework > 0 ? round(successfulQty / group.qtyRework * 100) : 0,
        reworkStatus: rework.statuses.length ? [...new Set(rework.statuses)].join(", ") : "Belum dijadwalkan",
        unitCost: round(unitCost),
        reworkRecoveredValue: round(successfulQty * unitCost),
        scrapQty: round(group.qtyScrap),
        unitWeightKg: round(weight.kg, 6),
        weightSource: weight.source,
        scrapKg: round(scrapKg, 3),
        scrapCode: scrapPrice?.scrapCode || "Belum ada harga",
        scrapPricePerKg: round(scrapPrice?.pricePerKg),
        scrapValue: round(scrapKg * number(scrapPrice?.pricePerKg)),
        valueStatus: [successfulQty > 0 && unitCost <= 0 ? "Biaya part belum ada" : "", group.qtyScrap > 0 && weight.kg <= 0 ? "Berat part belum ada" : "", group.qtyScrap > 0 && !scrapPrice ? "Harga scrap/kg belum ada" : ""].filter(Boolean).join("; ") || "Lengkap",
      };
    });

    const query = text(req.query.q || req.query.search).toLowerCase();
    if (query) rows = rows.filter((row) => [row.logNumber, row.moNumber, row.woNumber, row.reworkWoNumbers, row.partCode, row.partNumber, row.partName, row.processCode, row.processName, row.ngReason].some((value) => text(value).toLowerCase().includes(query)));

    const summary = rows.reduce((result, row) => {
      result.reworkSuccessfulQty += number(row.reworkSuccessfulQty);
      result.reworkRecoveredValue += number(row.reworkRecoveredValue);
      result.scrapQty += number(row.scrapQty);
      result.scrapValue += number(row.scrapValue);
      result.scrapKg += number(row.scrapKg);
      if (row.reworkSuccessfulQty > 0 && row.unitCost <= 0) result.missingUnitCostRows += 1;
      if (row.scrapQty > 0 && row.unitWeightKg <= 0) result.missingWeightRows += 1;
      if (row.scrapQty > 0 && row.scrapPricePerKg <= 0) result.missingScrapPriceRows += 1;
      return result;
    }, { reworkSuccessfulQty: 0, reworkRecoveredValue: 0, scrapQty: 0, scrapValue: 0, scrapKg: 0, missingUnitCostRows: 0, missingWeightRows: 0, missingScrapPriceRows: 0 });
    Object.keys(summary).forEach((key) => { summary[key] = round(summary[key], key === "scrapKg" ? 3 : 2); });

    const byPart = new Map();
    rows.forEach((row) => {
      const current = byPart.get(row.partCode) || { rework: 0, scrap: 0 };
      current.rework += number(row.reworkSuccessfulQty);
      current.scrap += number(row.scrapQty);
      byPart.set(row.partCode, current);
    });
    res.json({
      data: rows,
      total: rows.length,
      period: { startDate: start, endDate: new Date(endExclusive.getTime() - 1) },
      summary,
      chart: {
        labels: [...byPart.keys()],
        series: [
          { name: "Rework Berhasil", data: [...byPart.values()].map((item) => round(item.rework)) },
          { name: "Scrap", data: [...byPart.values()].map((item) => round(item.scrap)) },
        ],
      },
      formula: {
        rework: "Qty Good dari Work Order Rework × biaya per unit part (Live mBOM Costing)",
        scrap: "Qty Scrap final QC × berat part per unit × harga scrap per KG",
      },
    });
  } catch (error) { next(error); }
};
