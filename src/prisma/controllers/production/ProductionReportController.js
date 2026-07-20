const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

const num = value => Number(value || 0);

function processFromWorkOrder(workOrder) {
  const processCode = workOrder?.process?.processCode || "-";
  const processName = workOrder?.process?.processName || "-";
  return { processCode, processName };
}

function processLabel(processCode, processName) {
  if (processCode === "-" && processName === "-") return "-";
  if (processName === "-" || !processName) return processCode;
  return `${processCode} - ${processName}`;
}

function addQty(target, log) {
  target.produced += num(log.qtyProduced);
  target.good += num(log.qtyGood);
  target.reject += num(log.qtyReject);
  target.rework += num(log.qtyRework);
  return target;
}

function rate(part, total) {
  return total > 0 ? parseFloat(((part / total) * 100).toFixed(2)) : 0;
}
// ============================================================
// PRODUCTION REPORT - DASHBOARD (KPI Utama Produksi)
// ============================================================
exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const activeMoStatuses = ["Released", "Material Issued", "In Progress", "In Production", "Rework"];
    const activeWoStatuses = ["Released", "Material Issued", "In Production", "In Progress", "QC Pending", "Rework"];
    const runnableWoStatuses = ["Released", "Material Issued", "Rework"];
    const openMaterialIssueStatuses = ["Draft", "Issued", "Partially Returned"];
    const readyMaterialIssueStatuses = ["Issued", "Partially Returned", "Closed"];
    const openVendorStatuses = ["Planned", "Ready to Send", "Sent", "Partial Received", "QC Hold"];

    const [
      activeMoCount,
      releasedMoCount,
      childMoCount,
      reworkMoCount,
      completedMoCount,
      woToday,
      woStatusGroups,
      vendorStatusGroups,
      needSetupCount,
      materialRequiredWoCount,
      logsToday,
      weekLogs,
      openProductionLogs,
      pendingQc,
      completedQcToday,
      rejectedQc,
      openMaterialIssues,
      draftMaterialIssues,
      issuedMaterialIssues,
      wipInAgg,
      wipOutAgg,
      wipOpenMoCount,
      fgReceiptTodayAgg,
      topOpenMos,
    ] = await Promise.all([
      prisma.manufacturingOrder.count({
        where: { status: { in: activeMoStatuses }, isDeleted: false },
      }),
      prisma.manufacturingOrder.count({
        where: { status: "Released", isDeleted: false },
      }),
      prisma.manufacturingOrder.count({
        where: { isDeleted: false, parentMoNumber: { not: null }, status: { notIn: ["Completed", "Cancelled"] } },
      }),
      prisma.manufacturingOrder.count({
        where: { isDeleted: false, isReworkChild: true, status: { notIn: ["Completed", "Cancelled"] } },
      }),
      prisma.manufacturingOrder.count({
        where: {
          status: "Completed",
          isDeleted: false,
          actualEndDate: { gte: startOfToday, lt: startOfTomorrow },
        },
      }),
      prisma.workOrder.count({
        where: { isDeleted: false, plannedDate: { gte: startOfToday, lt: startOfTomorrow } },
      }),
      prisma.workOrder.groupBy({
        by: ["status"],
        where: { isDeleted: false, status: { not: "Cancelled" } },
        _count: { id: true },
      }),
      prisma.vendorProcessOrder.groupBy({
        by: ["status"],
        where: { isDeleted: false, status: { not: "Cancelled" } },
        _count: { id: true },
      }),
      prisma.workOrder.count({
        where: {
          isDeleted: false,
          status: { notIn: ["Cancelled", "Completed", "Closed"] },
          OR: [
            { diesId: null },
            { diesId: "" },
            { machineId: null },
            { machineId: "" },
            { shift: null },
            { shift: "" },
            { operatorName: null },
            { operatorName: "" },
          ],
        },
      }),
      prisma.workOrder.count({
        where: {
          isDeleted: false,
          status: "Released",
          materialIssues: {
            none: { isDeleted: false, status: { in: readyMaterialIssueStatuses } },
          },
        },
      }),
      prisma.productionLog.findMany({
        where: { isDeleted: false, logDate: { gte: startOfToday, lt: startOfTomorrow } },
        select: { qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true, status: true },
      }),
      prisma.productionLog.findMany({
        where: { isDeleted: false, logDate: { gte: startOfWeek } },
        select: { qtyProduced: true, qtyGood: true, qtyReject: true, qtyRework: true },
      }),
      prisma.productionLog.count({
        where: { isDeleted: false, status: { in: ["Open", "Submitted"] } },
      }),
      prisma.qualityInspection.count({
        where: { isDeleted: false, OR: [{ decision: "Pending" }, { status: "Draft" }] },
      }),
      prisma.qualityInspection.count({
        where: { isDeleted: false, status: "Completed", inspectionDate: { gte: startOfToday, lt: startOfTomorrow } },
      }),
      prisma.qualityInspection.count({
        where: { decision: "Rejected", isDeleted: false, inspectionDate: { gte: startOfWeek } },
      }),
      prisma.materialIssue.count({
        where: { isDeleted: false, status: { in: openMaterialIssueStatuses } },
      }),
      prisma.materialIssue.count({
        where: { isDeleted: false, status: "Draft" },
      }),
      prisma.materialIssue.count({
        where: { isDeleted: false, status: { in: ["Issued", "Partially Returned"] } },
      }),
      prisma.wIPEntry.aggregate({
        where: { isDeleted: false, direction: "IN" },
        _sum: { qty: true, amount: true },
      }),
      prisma.wIPEntry.aggregate({
        where: { isDeleted: false, direction: "OUT" },
        _sum: { qty: true, amount: true },
      }),
      prisma.wIPEntry.groupBy({
        by: ["moId"],
        where: { isDeleted: false },
        _sum: { qty: true },
      }),
      prisma.stockMovement.aggregate({
        where: {
          isDeleted: false,
          movementDate: { gte: startOfToday, lt: startOfTomorrow },
          movementType: "IN",
          transactionType: "PRODUCTION",
          referenceType: "QUALITY_INSPECTION",
          stockType: { in: ["Finished Goods", "FG"] },
        },
        _sum: { qty: true },
      }),
      prisma.manufacturingOrder.findMany({
        where: { isDeleted: false, status: { in: activeMoStatuses } },
        select: {
          moNumber: true,
          status: true,
          qtyPlanned: true,
          qtyGood: true,
          qtyReject: true,
          isReworkChild: true,
          parentMoNumber: true,
          part: { select: { partCode: true, partName: true } },
          workOrders: {
            where: { isDeleted: false, status: { not: "Cancelled" } },
            select: { status: true },
          },
        },
        orderBy: [{ updatedAt: "desc" }],
        take: 5,
      }),
    ]);

    const sumLogs = (logs, includeRework = true) => logs.reduce(
      (acc, l) => ({
        produced: acc.produced + Number(l.qtyProduced || 0),
        good: acc.good + Number(l.qtyGood || 0),
        reject: acc.reject + Number(l.qtyReject || 0),
        rework: includeRework ? acc.rework + Number(l.qtyRework || 0) : acc.rework,
      }),
      { produced: 0, good: 0, reject: 0, rework: 0 },
    );

    const countByStatus = (groups) => groups.reduce((acc, row) => {
      acc[row.status || "Unknown"] = row._count.id;
      return acc;
    }, {});

    const woByStatus = countByStatus(woStatusGroups);
    const vendorByStatus = countByStatus(vendorStatusGroups);
    const outputToday = sumLogs(logsToday);
    const outputWeek = sumLogs(weekLogs);
    const yieldRateToday = outputToday.produced > 0
      ? parseFloat(((outputToday.good / outputToday.produced) * 100).toFixed(2))
      : 0;
    const rejectRateWeek = outputWeek.produced > 0
      ? parseFloat(((outputWeek.reject / outputWeek.produced) * 100).toFixed(2))
      : 0;
    const wipQtyIn = Number(wipInAgg._sum.qty || 0);
    const wipQtyOut = Number(wipOutAgg._sum.qty || 0);
    const wipValueIn = Number(wipInAgg._sum.amount || 0);
    const wipValueOut = Number(wipOutAgg._sum.amount || 0);
    const wipOpenQty = Math.max(0, wipQtyIn - wipQtyOut);
    const wipOpenValue = Math.max(0, wipValueIn - wipValueOut);
    const activeWoCount = activeWoStatuses.reduce((total, status) => total + Number(woByStatus[status] || 0), 0);
    const inProductionWoCount = Number(woByStatus["In Production"] || 0) + Number(woByStatus["In Progress"] || 0);
    const qcPendingWoCount = Number(woByStatus["QC Pending"] || 0);
    const completedWoCount = Number(woByStatus.Completed || 0);
    const openVendorCount = openVendorStatuses.reduce((total, status) => total + Number(vendorByStatus[status] || 0), 0);

    const alerts = [
      {
        key: "needSetup",
        label: "Setup belum lengkap",
        count: needSetupCount,
        tone: needSetupCount > 0 ? "warning" : "ok",
      },
      {
        key: "needMaterialIssue",
        label: "WO menunggu Material Issue",
        count: materialRequiredWoCount,
        tone: materialRequiredWoCount > 0 ? "danger" : "ok",
      },
      {
        key: "pendingQc",
        label: "QC pending",
        count: pendingQc,
        tone: pendingQc > 0 ? "warning" : "ok",
      },
      {
        key: "vendorOpen",
        label: "Vendor process terbuka",
        count: openVendorCount,
        tone: openVendorCount > 0 ? "info" : "ok",
      },
    ];

    res.json({
      generatedAt: new Date().toISOString(),
      period: {
        today: startOfToday.toISOString(),
        weekStart: startOfWeek.toISOString(),
      },
      production: {
        activeMoCount,
        releasedMoCount,
        completedMoToday: completedMoCount,
        childMoCount,
        reworkMoCount,
        woToday,
      },
      execution: {
        activeWoCount,
        inProductionWoCount,
        qcPendingWoCount,
        completedWoCount,
        openProductionLogs,
        needSetupCount,
        woByStatus,
      },
      vendor: {
        openVendorCount,
        byStatus: vendorByStatus,
      },
      output: {
        today: outputToday,
        week: outputWeek,
        yieldRateToday,
        rejectRateWeek,
        fgReceiptToday: Number(fgReceiptTodayAgg._sum.qty || 0),
      },
      quality: {
        pendingInspections: pendingQc,
        completedToday: completedQcToday,
        rejectedThisWeek: rejectedQc,
      },
      materials: {
        openIssues: openMaterialIssues,
        draftIssues: draftMaterialIssues,
        issuedIssues: issuedMaterialIssues,
        woWaitingIssue: materialRequiredWoCount,
      },
      wip: {
        openQty: wipOpenQty,
        openValue: wipOpenValue,
        qtyIn: wipQtyIn,
        qtyOut: wipQtyOut,
        openMoCount: wipOpenMoCount.filter(row => Number(row._sum.qty || 0) > 0).length,
      },
      flow: {
        rootMoActive: Math.max(0, activeMoCount - childMoCount),
        childMoActive: childMoCount,
        reworkMoActive: reworkMoCount,
      },
      alerts,
      bottlenecks: topOpenMos.map((mo) => ({
        moNumber: mo.moNumber,
        status: mo.status,
        partCode: mo.part?.partCode || "-",
        partName: mo.part?.partName || "-",
        qtyPlanned: Number(mo.qtyPlanned || 0),
        qtyGood: Number(mo.qtyGood || 0),
        qtyReject: Number(mo.qtyReject || 0),
        isChild: Boolean(mo.parentMoNumber),
        isRework: Boolean(mo.isReworkChild),
        openWo: (mo.workOrders || []).filter(wo => wo.status !== "Completed").length,
      })),
    });
  } catch (e) {
    next(e);
  }
};
// ============================================================
// PRODUCTION REPORT - OEE (Overall Equipment Effectiveness)
// Rumus OEE = Availability × Performance × Quality
// ============================================================
exports.oeeReport = async (req, res, next) => {
  try {
    const { startDate, endDate, machineCode } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate dan endDate wajib diisi." });
    }

    const where = {
      isDeleted: false,
      logDate: { gte: new Date(startDate), lte: new Date(endDate) },
    };
    if (machineCode) where.machineCode = { contains: machineCode, mode: "insensitive" };

    const logs = await prisma.productionLog.findMany({
      where,
      select: {
        machineCode: true,
        shift: true,
        qtyPlanned: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        downtime: true,
        workOrder: {
          select: {
            woNumber: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
    });

    const machineProcessMap = {};
    for (const log of logs) {
      const { processCode, processName } = processFromWorkOrder(log.workOrder);
      const machineCodeKey = log.machineCode || "UNKNOWN";
      const key = `${machineCodeKey}||${processCode}`;
      if (!machineProcessMap[key]) {
        machineProcessMap[key] = {
          machineCode: machineCodeKey,
          processCode,
          processName,
          processLabel: processLabel(processCode, processName),
          woNumbers: new Set(),
          totalShifts: 0,
          totalPlannedTime: 0,
          totalDowntime: 0,
          totalQtyPlanned: 0,
          totalQtyProduced: 0,
          totalQtyGood: 0,
          totalQtyReject: 0,
        };
      }

      const entry = machineProcessMap[key];
      entry.totalShifts += 1;
      entry.totalPlannedTime += 480;
      entry.totalDowntime += num(log.downtime);
      entry.totalQtyPlanned += num(log.qtyPlanned);
      entry.totalQtyProduced += num(log.qtyProduced);
      entry.totalQtyGood += num(log.qtyGood);
      entry.totalQtyReject += num(log.qtyReject);
      if (log.workOrder?.woNumber) entry.woNumbers.add(log.workOrder.woNumber);
    }

    const data = Object.values(machineProcessMap).map((m) => {
      const availableTime = m.totalPlannedTime - m.totalDowntime;
      const availability = m.totalPlannedTime > 0 ? availableTime / m.totalPlannedTime : 0;
      const performance = m.totalQtyPlanned > 0 ? m.totalQtyProduced / m.totalQtyPlanned : 0;
      const quality = m.totalQtyProduced > 0 ? m.totalQtyGood / m.totalQtyProduced : 0;

      return {
        machineCode: m.machineCode,
        processCode: m.processCode,
        processName: m.processName,
        processLabel: m.processLabel,
        woCount: m.woNumbers.size,
        totalShifts: m.totalShifts,
        totalPlannedTime: m.totalPlannedTime,
        totalDowntime: m.totalDowntime,
        availability: parseFloat((availability * 100).toFixed(2)),
        performance: parseFloat((performance * 100).toFixed(2)),
        quality: parseFloat((quality * 100).toFixed(2)),
        oee: parseFloat((availability * performance * quality * 100).toFixed(2)),
        totalQtyPlanned: m.totalQtyPlanned,
        totalQtyProduced: m.totalQtyProduced,
        totalQtyGood: m.totalQtyGood,
        totalQtyReject: m.totalQtyReject,
      };
    });

    res.json({ period: { startDate, endDate }, machineCode: machineCode || null, data });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// PRODUCTION REPORT - YIELD REPORT (Efisiensi Produksi per MO/WO/Process)
// ============================================================
exports.yieldReport = async (req, res, next) => {
  try {
    const { startDate, endDate, moId, machineCode, partId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate dan endDate wajib diisi." });
    }

    const where = {
      isDeleted: false,
      logDate: { gte: new Date(startDate), lte: new Date(endDate) },
    };
    if (moId) where.moId = moId;
    if (machineCode) where.machineCode = { contains: machineCode, mode: "insensitive" };

    const logs = await prisma.productionLog.findMany({
      where,
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            partId: true,
            part: { select: { partCode: true, partName: true } },
          },
        },
        workOrder: {
          select: {
            woNumber: true,
            sequence: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
    });

    const filtered = partId
      ? logs.filter((l) => l.manufacturingOrder?.partId === partId)
      : logs;

    const rows = {};
    for (const log of filtered) {
      const { processCode, processName } = processFromWorkOrder(log.workOrder);
      const key = `${log.moId}||${log.woId || "-"}||${processCode}`;
      if (!rows[key]) {
        rows[key] = {
          moId: log.moId,
          moNumber: log.manufacturingOrder?.moNumber ?? "-",
          woNumber: log.workOrder?.woNumber ?? "-",
          sequence: log.workOrder?.sequence ?? null,
          processCode,
          processName,
          processLabel: processLabel(processCode, processName),
          partCode: log.manufacturingOrder?.part?.partCode ?? "-",
          partName: log.manufacturingOrder?.part?.partName ?? "-",
          totalProduced: 0,
          totalGood: 0,
          totalReject: 0,
          totalRework: 0,
          shiftCount: 0,
        };
      }

      rows[key].totalProduced += num(log.qtyProduced);
      rows[key].totalGood += num(log.qtyGood);
      rows[key].totalReject += num(log.qtyReject);
      rows[key].totalRework += num(log.qtyRework);
      rows[key].shiftCount += 1;
    }

    const data = Object.values(rows).map((row) => ({
      ...row,
      yieldRate: rate(row.totalGood, row.totalProduced),
      rejectRate: rate(row.totalReject, row.totalProduced),
    }));

    res.json({ period: { startDate, endDate }, data });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// PRODUCTION REPORT - SCRAP/REJECT REPORT
// ============================================================
exports.scrapReport = async (req, res, next) => {
  try {
    const { startDate, endDate, moId, machineCode, shift } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate dan endDate wajib diisi." });
    }

    const where = {
      isDeleted: false,
      logDate: { gte: new Date(startDate), lte: new Date(endDate) },
    };
    if (moId) where.moId = moId;
    if (machineCode) where.machineCode = { contains: machineCode, mode: "insensitive" };
    if (shift) where.shift = shift;

    const logs = await prisma.productionLog.findMany({
      where,
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            part: { select: { partCode: true, partName: true } },
          },
        },
        workOrder: {
          select: {
            woNumber: true,
            sequence: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
      orderBy: { logDate: "asc" },
    });

    const shiftSummary = {};
    const machineSummary = {};
    const processSummary = {};
    const grandTotal = { produced: 0, good: 0, reject: 0, rework: 0 };

    for (const log of logs) {
      addQty(grandTotal, log);

      const shiftKey = log.shift || "UNKNOWN";
      if (!shiftSummary[shiftKey]) shiftSummary[shiftKey] = { shift: shiftKey, produced: 0, reject: 0, rework: 0 };
      shiftSummary[shiftKey].produced += num(log.qtyProduced);
      shiftSummary[shiftKey].reject += num(log.qtyReject);
      shiftSummary[shiftKey].rework += num(log.qtyRework);

      const machineKey = log.machineCode || "UNKNOWN";
      if (!machineSummary[machineKey]) machineSummary[machineKey] = { machineCode: machineKey, produced: 0, reject: 0, rework: 0 };
      machineSummary[machineKey].produced += num(log.qtyProduced);
      machineSummary[machineKey].reject += num(log.qtyReject);
      machineSummary[machineKey].rework += num(log.qtyRework);

      const { processCode, processName } = processFromWorkOrder(log.workOrder);
      if (!processSummary[processCode]) {
        processSummary[processCode] = {
          processCode,
          processName,
          processLabel: processLabel(processCode, processName),
          produced: 0,
          reject: 0,
          rework: 0,
          woNumbers: new Set(),
        };
      }
      processSummary[processCode].produced += num(log.qtyProduced);
      processSummary[processCode].reject += num(log.qtyReject);
      processSummary[processCode].rework += num(log.qtyRework);
      if (log.workOrder?.woNumber) processSummary[processCode].woNumbers.add(log.workOrder.woNumber);
    }

    const withRejectRate = row => ({ ...row, rejectRate: rate(row.reject, row.produced) });
    const byProcess = Object.values(processSummary).map((row) => ({
      ...withRejectRate(row),
      woCount: row.woNumbers.size,
      woNumbers: Array.from(row.woNumbers),
    }));

    res.json({
      period: { startDate, endDate },
      grandTotal: { ...grandTotal, rejectRate: rate(grandTotal.reject, grandTotal.produced) },
      byShift: Object.values(shiftSummary).map(withRejectRate),
      byMachine: Object.values(machineSummary).map(withRejectRate),
      byProcess,
      detail: logs.map((log) => {
        const { processCode, processName } = processFromWorkOrder(log.workOrder);
        return {
          ...mapDoc(log),
          moNumber: log.manufacturingOrder?.moNumber ?? "-",
          woNumber: log.workOrder?.woNumber ?? "-",
          processCode,
          processName,
          processLabel: processLabel(processCode, processName),
        };
      }),
    });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// PRODUCTION REPORT - OUTPUT TREND (Tren Produksi per Hari/Minggu/Bulan)
// ============================================================
exports.outputTrend = async (req, res, next) => {
  try {
    const { startDate, endDate, groupBy = "day", moId, machineCode } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate dan endDate wajib diisi." });
    }

    const where = {
      isDeleted: false,
      logDate: { gte: new Date(startDate), lte: new Date(endDate) },
    };
    if (moId) where.moId = moId;
    if (machineCode) where.machineCode = { contains: machineCode, mode: "insensitive" };

    const logs = await prisma.productionLog.findMany({
      where,
      select: {
        logDate: true,
        qtyProduced: true,
        qtyGood: true,
        qtyReject: true,
        qtyRework: true,
        workOrder: {
          select: {
            woNumber: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
      },
      orderBy: { logDate: "asc" },
    });

    const trendMap = {};
    const processSummary = {};
    for (const log of logs) {
      let key;
      const d = new Date(log.logDate);
      if (groupBy === "month") {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      } else if (groupBy === "week") {
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
        key = `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
      } else {
        key = d.toISOString().slice(0, 10);
      }

      if (!trendMap[key]) trendMap[key] = { period: key, produced: 0, good: 0, reject: 0, rework: 0 };
      addQty(trendMap[key], log);

      const { processCode, processName } = processFromWorkOrder(log.workOrder);
      if (!processSummary[processCode]) {
        processSummary[processCode] = {
          processCode,
          processName,
          processLabel: processLabel(processCode, processName),
          produced: 0,
          good: 0,
          reject: 0,
          rework: 0,
        };
      }
      addQty(processSummary[processCode], log);
    }

    const data = Object.values(trendMap).map((row) => ({
      ...row,
      yieldRate: rate(row.good, row.produced),
      rejectRate: rate(row.reject, row.produced),
    }));
    const byProcess = Object.values(processSummary).map((row) => ({
      ...row,
      yieldRate: rate(row.good, row.produced),
      rejectRate: rate(row.reject, row.produced),
    }));

    res.json({ period: { startDate, endDate }, groupBy, data, byProcess });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// PRODUCTION REPORT - QC SUMMARY (Ringkasan Inspeksi QC)
// ============================================================
exports.qcSummary = async (req, res, next) => {
  try {
    const { startDate, endDate, moId, partId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate dan endDate wajib diisi." });
    }

    const where = {
      isDeleted: false,
      inspectionDate: { gte: new Date(startDate), lte: new Date(endDate) },
    };
    if (moId) where.moId = moId;
    if (partId) where.partId = partId;

    const [inspections, decisionCounts] = await Promise.all([
      prisma.qualityInspection.findMany({
        where,
        select: {
          decision: true,
          qtyInspected: true,
          qtyPassed: true,
          qtyFailed: true,
          qtyRework: true,
          workOrder: {
            select: {
              woNumber: true,
              process: { select: { processCode: true, processName: true } },
            },
          },
          vendorProcessOrder: {
            select: {
              orderNumber: true,
              processCode: true,
              processName: true,
              vendorName: true,
            },
          },
        },
      }),
      prisma.qualityInspection.groupBy({
        by: ["decision"],
        where,
        _count: { id: true },
      }),
    ]);

    const totals = inspections.reduce(
      (acc, i) => ({
        inspected: acc.inspected + num(i.qtyInspected),
        passed: acc.passed + num(i.qtyPassed),
        failed: acc.failed + num(i.qtyFailed),
        rework: acc.rework + num(i.qtyRework),
      }),
      { inspected: 0, passed: 0, failed: 0, rework: 0 }
    );

    const byDecision = decisionCounts.map((d) => ({
      decision: d.decision,
      count: d._count.id,
    }));

    const bySourceMap = {};
    const byProcessMap = {};
    for (const inspection of inspections) {
      const sourceType = inspection.vendorProcessOrder ? "VPO" : "WO";
      if (!bySourceMap[sourceType]) bySourceMap[sourceType] = { sourceType, count: 0, inspected: 0, passed: 0, failed: 0, rework: 0 };
      bySourceMap[sourceType].count += 1;
      bySourceMap[sourceType].inspected += num(inspection.qtyInspected);
      bySourceMap[sourceType].passed += num(inspection.qtyPassed);
      bySourceMap[sourceType].failed += num(inspection.qtyFailed);
      bySourceMap[sourceType].rework += num(inspection.qtyRework);

      const processCode = inspection.workOrder?.process?.processCode || inspection.vendorProcessOrder?.processCode || "-";
      const processName = inspection.workOrder?.process?.processName || inspection.vendorProcessOrder?.processName || "-";
      if (!byProcessMap[processCode]) {
        byProcessMap[processCode] = { processCode, processName, processLabel: processLabel(processCode, processName), count: 0, inspected: 0, passed: 0, failed: 0, rework: 0 };
      }
      byProcessMap[processCode].count += 1;
      byProcessMap[processCode].inspected += num(inspection.qtyInspected);
      byProcessMap[processCode].passed += num(inspection.qtyPassed);
      byProcessMap[processCode].failed += num(inspection.qtyFailed);
      byProcessMap[processCode].rework += num(inspection.qtyRework);
    }

    const withPassRate = row => ({ ...row, passRate: rate(row.passed, row.inspected) });

    res.json({
      period: { startDate, endDate },
      totals: { ...totals, passRate: rate(totals.passed, totals.inspected) },
      byDecision,
      bySource: Object.values(bySourceMap).map(withPassRate),
      byProcess: Object.values(byProcessMap).map(withPassRate),
    });
  } catch (e) {
    next(e);
  }
};

