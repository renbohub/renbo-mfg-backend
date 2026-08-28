const LAYERS = Object.freeze({
  PRODUCTION_PLAN: "PRODUCTION_PLAN",
  MRP: "MRP",
  MPS: "MPS",
});

const SOURCE_TYPES = new Set(["FORECAST", "SALES_ORDER"]);

const unique = (values) => [...new Set((values || []).filter(Boolean).map(String))];
const stripWorkflowNotes = (value) => String(value || "")
  .split(";")
  .map((entry) => entry.trim())
  .filter((entry) => entry && !/^(Submitted for approval by|Approved by|Closed by)\b/i.test(entry))
  .join("; ") || null;

function normalizeRequest(input = {}) {
  const sourceType = String(input.sourceType || "").trim().toUpperCase();
  if (!SOURCE_TYPES.has(sourceType)) {
    const error = new Error("Pilih sumber Forecast atau Sales Order.");
    error.code = "INVALID_SOURCE_TYPE";
    throw error;
  }
  const sourceNumbers = unique(input.sourceNumbers).slice(0, 100);
  if (!sourceNumbers.length) {
    const error = new Error("Pilih minimal satu Forecast atau Sales Order.");
    error.code = "SOURCE_REQUIRED";
    throw error;
  }

  const requested = new Set((input.layers || []).map((value) => String(value).toUpperCase()));
  const layers = new Set();
  if (requested.has(LAYERS.MPS)) {
    layers.add(LAYERS.MPS);
    layers.add(LAYERS.MRP);
    layers.add(LAYERS.PRODUCTION_PLAN);
  } else if (requested.has(LAYERS.MRP)) {
    layers.add(LAYERS.MRP);
    layers.add(LAYERS.PRODUCTION_PLAN);
  } else if (requested.has(LAYERS.PRODUCTION_PLAN)) {
    layers.add(LAYERS.PRODUCTION_PLAN);
  }
  if (!layers.size) {
    const error = new Error("Checklist minimal satu lapisan data planning yang akan dihapus.");
    error.code = "RESET_LAYER_REQUIRED";
    throw error;
  }
  return { sourceType, sourceNumbers, layers: [...layers] };
}

async function listResetSources(db, { sourceType, query = "", limit = 50 } = {}) {
  const type = String(sourceType || "FORECAST").toUpperCase();
  if (!SOURCE_TYPES.has(type)) return [];
  const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const q = String(query || "").trim();
  if (type === "FORECAST") {
    const rows = await db.forecast.findMany({
      where: {
        isDeleted: false,
        ...(q ? { OR: [
          { forecastNumber: { contains: q, mode: "insensitive" } },
          { forecastName: { contains: q, mode: "insensitive" } },
          { customerCode: { contains: q, mode: "insensitive" } },
        ] } : {}),
      },
      orderBy: [{ periodStart: "desc" }, { forecastNumber: "desc" }],
      take,
      select: { forecastNumber: true, forecastName: true, customerCode: true, periodStart: true, periodEnd: true, status: true },
    });
    return rows.map((row) => ({
      sourceType: type,
      sourceNumber: row.forecastNumber,
      label: row.forecastName || row.forecastNumber,
      customerCode: row.customerCode,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status: row.status,
    }));
  }

  const rows = await db.salesOrderHeader.findMany({
    where: {
      isDeleted: false,
      ...(q ? { OR: [
        { soNumber: { contains: q, mode: "insensitive" } },
        { customerCode: { contains: q, mode: "insensitive" } },
        { customerName: { contains: q, mode: "insensitive" } },
      ] } : {}),
    },
    orderBy: [{ soDate: "desc" }, { soNumber: "desc" }],
    take,
    select: { soNumber: true, customerCode: true, customerName: true, soDate: true, deliveryDate: true, status: true },
  });
  return rows.map((row) => ({
    sourceType: type,
    sourceNumber: row.soNumber,
    label: row.customerName || row.soNumber,
    customerCode: row.customerCode,
    periodStart: row.soDate,
    periodEnd: row.deliveryDate,
    status: row.status,
  }));
}

async function protectedSnapshot(db) {
  const [balances, movements, receipts, logs] = await Promise.all([
    db.stockBalance.aggregate({ _count: { _all: true }, _sum: { qtyOnHand: true, qtyReserved: true, qtyAvailable: true } }),
    db.stockMovement.aggregate({ _count: { _all: true }, _sum: { qty: true, deltaQty: true } }),
    db.goodsReceipt.count(),
    db.productionLog.count(),
  ]);
  return {
    stockBalances: { count: balances._count._all, ...balances._sum },
    stockMovements: { count: movements._count._all, ...movements._sum },
    goodsReceipts: receipts,
    productionLogs: logs,
  };
}

async function resolveGraph(db, normalized) {
  const { sourceType, sourceNumbers } = normalized;
  const sourceWhere = { sourceType, sourceNumber: { in: sourceNumbers } };
  const existingSourceCount = sourceType === "FORECAST"
    ? await db.forecast.count({ where: { forecastNumber: { in: sourceNumbers }, isDeleted: false } })
    : await db.salesOrderHeader.count({ where: { soNumber: { in: sourceNumbers }, isDeleted: false } });
  if (existingSourceCount !== sourceNumbers.length) {
    const error = new Error("Sebagian Forecast/Sales Order sudah berubah atau tidak ditemukan. Muat ulang daftar sumber.");
    error.code = "RESET_SOURCE_STALE";
    throw error;
  }

  const demandRows = await db.mPSDemandSource.findMany({
    where: sourceWhere,
    select: { mpsDetailId: true, mpsDetail: { select: { mpsNumber: true } } },
  });
  const directMps = sourceType === "FORECAST"
    ? await db.mPS.findMany({ where: { forecastNumber: { in: sourceNumbers } }, select: { id: true, mpsNumber: true } })
    : await db.mPSDetail.findMany({ where: { soNumber: { in: sourceNumbers } }, select: { mpsNumber: true } });
  const mpsNumbers = unique([
    ...demandRows.map((row) => row.mpsDetail?.mpsNumber),
    ...directMps.map((row) => row.mpsNumber),
  ]);
  const mpsRows = mpsNumbers.length
    ? await db.mPS.findMany({ where: { mpsNumber: { in: mpsNumbers } }, select: { id: true, mpsNumber: true } })
    : [];
  const mpsIds = mpsRows.map((row) => row.id);
  const mpsDetailRows = mpsNumbers.length
    ? await db.mPSDetail.findMany({ where: { mpsNumber: { in: mpsNumbers } }, select: { id: true } })
    : [];
  const mpsDetailIds = mpsDetailRows.map((row) => row.id);

  const mrpOr = [];
  if (mpsNumbers.length) mrpOr.push({ mpsNumber: { in: mpsNumbers } });
  mrpOr.push({ requirements: { some: { rootDemandSourceType: sourceType, rootDemandSourceNumber: { in: sourceNumbers } } } });
  mrpOr.push({ requirements: { some: { sourceType, sourceNumber: { in: sourceNumbers } } } });
  const mrpRows = await db.mRPRun.findMany({ where: { OR: mrpOr }, select: { id: true, runNumber: true } });
  const runNumbers = unique(mrpRows.map((row) => row.runNumber));
  const requirementRows = runNumbers.length
    ? await db.mRPRequirement.findMany({ where: { runNumber: { in: runNumbers } }, select: { id: true } })
    : [];
  const requirementIds = requirementRows.map((row) => row.id);
  const plannedOrderRows = runNumbers.length
    ? await db.plannedOrder.findMany({ where: { runNumber: { in: runNumbers } }, select: { orderNumber: true } })
    : [];
  const plannedOrderNumbers = plannedOrderRows.map((row) => row.orderNumber);

  const planDetailOr = [];
  if (requirementIds.length) planDetailOr.push({ mrpRequirementId: { in: requirementIds } });
  if (plannedOrderNumbers.length) planDetailOr.push({ plannedOrderNumber: { in: plannedOrderNumbers } });
  if (mpsDetailIds.length) planDetailOr.push({ mpsDetailId: { in: mpsDetailIds } });
  const planDetailRows = planDetailOr.length
    ? await db.monthlyProductionPlanDetail.findMany({ where: { OR: planDetailOr }, select: { planId: true } })
    : [];
  const planIds = unique(planDetailRows.map((row) => row.planId));
  const planRows = planIds.length
    ? await db.monthlyProductionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, planNumber: true } })
    : [];
  const planNumbers = planRows.map((row) => row.planNumber);
  const allocationRows = planIds.length
    ? await db.productionPlanAllocation.findMany({ where: { planId: { in: planIds } }, select: { id: true } })
    : [];
  const allocationIds = allocationRows.map((row) => row.id);
  const scheduleRows = planIds.length
    ? await db.dailyProductionSchedule.findMany({ where: { productionPlanId: { in: planIds } }, select: { id: true, dailyPlanRevisionId: true } })
    : [];
  const scheduleIds = scheduleRows.map((row) => row.id);
  const revisionIds = unique(scheduleRows.map((row) => row.dailyPlanRevisionId));
  const directRevisionRows = planIds.length
    ? await db.dailyPlanRevision.findMany({ where: { sourceProductionPlanId: { in: planIds } }, select: { id: true } })
    : [];
  revisionIds.push(...directRevisionRows.map((row) => row.id));

  const purchaseSuggestionRows = runNumbers.length
    ? await db.purchaseSuggestion.findMany({ where: { runNumber: { in: runNumbers } }, select: { id: true, suggestionNumber: true } })
    : [];
  const rccpRows = mpsIds.length
    ? await db.rccpRun.findMany({ where: { mpsId: { in: mpsIds } }, select: { id: true } })
    : [];
  const mixedSources = mpsNumbers.length
    ? await db.mPSDemandSource.findMany({
      where: {
        mpsDetail: { mpsNumber: { in: mpsNumbers } },
        NOT: sourceWhere,
      },
      distinct: ["sourceType", "sourceNumber"],
      select: { sourceType: true, sourceNumber: true },
    })
    : [];
  const deliveryPlanSources = mpsNumbers.length
    ? await db.mPSDeliveryPlan.findMany({
      where: { mpsNumber: { in: mpsNumbers }, sourceNumber: { not: null } },
      distinct: ["sourceType", "sourceNumber"],
      select: { sourceType: true, sourceNumber: true },
    })
    : [];
  const gateSourceKeys = new Map();
  [{ sourceType, sourceNumber: null }, ...mixedSources, ...deliveryPlanSources]
    .forEach((row) => {
      const type = String(row.sourceType || "").trim().toUpperCase();
      const numbers = row.sourceNumber ? [row.sourceNumber] : sourceNumbers;
      numbers.forEach((number) => {
        if (type && number) gateSourceKeys.set(`${type}|${number}`, { sourceType: type, sourceNumber: number });
      });
    });
  const gateSources = [...gateSourceKeys.values()];
  const planningDecisionRows = gateSources.length
    ? await db.demandPlanningDecision.findMany({
      where: { OR: gateSources, isDeleted: false },
      select: { id: true, deliveryTargetId: true },
    })
    : [];
  const deliveryTargetIds = unique(planningDecisionRows.map((row) => row.deliveryTargetId));

  return {
    sourceType,
    sourceNumbers,
    mpsIds,
    mpsNumbers,
    mpsDetailIds,
    rccpRunIds: rccpRows.map((row) => row.id),
    mrpRunIds: mrpRows.map((row) => row.id),
    runNumbers,
    requirementIds,
    plannedOrderNumbers,
    purchaseSuggestionIds: purchaseSuggestionRows.map((row) => row.id),
    purchaseSuggestionNumbers: purchaseSuggestionRows.map((row) => row.suggestionNumber),
    planIds,
    planNumbers,
    allocationIds,
    scheduleIds,
    revisionIds: unique(revisionIds),
    demandPlanningDecisionIds: planningDecisionRows.map((row) => row.id),
    deliveryTargetIds,
    mixedSources,
  };
}

function impactCounts(graph, layers) {
  const selected = new Set(layers);
  return {
    sourceToDraft: graph.sourceNumbers.length,
    mps: selected.has(LAYERS.MPS) ? graph.mpsNumbers.length : 0,
    rccp: selected.has(LAYERS.MPS) ? graph.rccpRunIds.length : 0,
    mrp: selected.has(LAYERS.MRP) ? graph.runNumbers.length : 0,
    plannedOrders: selected.has(LAYERS.MRP) ? graph.plannedOrderNumbers.length : 0,
    purchaseSuggestions: selected.has(LAYERS.MRP) ? graph.purchaseSuggestionIds.length : 0,
    monthlyPlans: selected.has(LAYERS.PRODUCTION_PLAN) ? graph.planIds.length : 0,
    dailyPlans: selected.has(LAYERS.PRODUCTION_PLAN) ? graph.scheduleIds.length : 0,
  };
}

async function previewSourcePlanningReset(db, input) {
  const normalized = normalizeRequest(input);
  const graph = await resolveGraph(db, normalized);
  const protectedData = await protectedSnapshot(db);
  const warnings = [];
  if (normalized.layers.includes(LAYERS.MPS) && graph.mixedSources.length) {
    warnings.push(`${graph.mixedSources.length} sumber demand lain ikut terdampak karena berada pada dokumen MPS gabungan yang sama.`);
  }
  if (!graph.mpsNumbers.length && !graph.runNumbers.length && !graph.planIds.length) {
    warnings.push("Tidak ada dokumen planning turunan yang terhubung dengan sumber terpilih.");
  }
  return {
    mode: "PREVIEW",
    selection: normalized,
    impact: impactCounts(graph, normalized.layers),
    documents: {
      mpsNumbers: graph.mpsNumbers,
      mrpRunNumbers: graph.runNumbers,
      purchaseSuggestionNumbers: graph.purchaseSuggestionNumbers,
      monthlyPlanNumbers: graph.planNumbers,
    },
    mixedSources: graph.mixedSources,
    protected: protectedData,
    warnings,
  };
}

async function deleteProductionPlanning(tx, graph, removed) {
  if (!graph.planIds.length) return;
  const exceptionSourceIds = [...graph.scheduleIds, ...graph.allocationIds];
  removed.dailyPlanningException = exceptionSourceIds.length
    ? (await tx.dailyPlanningException.deleteMany({ where: { sourceId: { in: exceptionSourceIds } } })).count : 0;
  removed.dailyProductionSchedule = (await tx.dailyProductionSchedule.deleteMany({ where: { productionPlanId: { in: graph.planIds } } })).count;
  removed.dailyPlanRevision = graph.revisionIds.length
    ? (await tx.dailyPlanRevision.deleteMany({ where: { id: { in: graph.revisionIds } } })).count : 0;
  removed.monthlyProductionPlan = (await tx.monthlyProductionPlan.deleteMany({ where: { id: { in: graph.planIds } } })).count;
}

async function deleteMrp(tx, graph, removed) {
  if (!graph.runNumbers.length) return;
  removed.purchaseSuggestion = (await tx.purchaseSuggestion.deleteMany({ where: { runNumber: { in: graph.runNumbers } } })).count;
  const peggingOr = [
    { demandNumber: { in: [...graph.runNumbers, ...graph.mpsNumbers, ...graph.sourceNumbers] } },
  ];
  if (graph.plannedOrderNumbers.length) peggingOr.push({ supplyNumber: { in: graph.plannedOrderNumbers } });
  removed.mRPPegging = (await tx.mRPPegging.deleteMany({ where: { OR: peggingOr } })).count;
  removed.mRPRun = (await tx.mRPRun.deleteMany({ where: { runNumber: { in: graph.runNumbers } } })).count;
}

async function deleteMps(tx, graph, removed) {
  if (!graph.mpsIds.length) return;
  removed.dppDisplacementProposal = graph.deliveryTargetIds.length
    ? (await tx.dPPDisplacementProposal.deleteMany({ where: { deliveryTargetId: { in: graph.deliveryTargetIds } } })).count
    : 0;
  removed.dueDateRecoveryPlan = graph.deliveryTargetIds.length
    ? (await tx.dueDateRecoveryPlan.deleteMany({ where: { deliveryTargetId: { in: graph.deliveryTargetIds } } })).count
    : 0;
  removed.demandPlanningDecision = graph.demandPlanningDecisionIds.length
    ? (await tx.demandPlanningDecision.deleteMany({ where: { id: { in: graph.demandPlanningDecisionIds } } })).count
    : 0;
  const baselineLocks = await tx.planningBaselineLock.findMany({
    where: {
      OR: [
        { baselineMpsNumber: { in: graph.mpsNumbers } },
        ...(graph.runNumbers.length ? [{ baselineMrpNumber: { in: graph.runNumbers } }] : []),
      ],
    },
    select: { id: true },
  });
  const baselineLockIds = baselineLocks.map((row) => row.id);
  removed.planningAdjustment = baselineLockIds.length
    ? (await tx.planningAdjustment.deleteMany({ where: { baselineLockId: { in: baselineLockIds } } })).count
    : 0;
  removed.planningBaselineLock = baselineLockIds.length
    ? (await tx.planningBaselineLock.deleteMany({ where: { id: { in: baselineLockIds } } })).count
    : 0;
  removed.rccpRun = (await tx.rccpRun.deleteMany({ where: { mpsId: { in: graph.mpsIds } } })).count;
  removed.mPS = (await tx.mPS.deleteMany({ where: { id: { in: graph.mpsIds } } })).count;
}

async function resetSourcePlanning(prisma, input, actor = null) {
  const normalized = normalizeRequest(input);
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    const error = new Error("Alasan reset wajib diisi minimal 5 karakter.");
    error.code = "RESET_REASON_REQUIRED";
    throw error;
  }
  if (String(input.confirmation || "").trim() !== "RESET_SELECTED_PLANNING") {
    const error = new Error("Ketik RESET_SELECTED_PLANNING untuk menjalankan reset.");
    error.code = "RESET_CONFIRMATION_REQUIRED";
    throw error;
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026082502)`;
    const protectedBefore = await protectedSnapshot(tx);
    const graph = await resolveGraph(tx, normalized);
    const removed = {};
    const selected = new Set(normalized.layers);
    if (selected.has(LAYERS.PRODUCTION_PLAN)) await deleteProductionPlanning(tx, graph, removed);
    if (selected.has(LAYERS.MRP)) await deleteMrp(tx, graph, removed);
    if (selected.has(LAYERS.MPS)) await deleteMps(tx, graph, removed);

    if (normalized.sourceType === "FORECAST") {
      const forecasts = await tx.forecast.findMany({
        where: { forecastNumber: { in: normalized.sourceNumbers }, isDeleted: false },
        select: { forecastNumber: true, notes: true },
      });
      for (const forecast of forecasts) {
        await tx.forecast.update({
          where: { forecastNumber: forecast.forecastNumber },
          data: {
            status: "Draft",
            approvedBy: null,
            approvedDate: null,
            notes: stripWorkflowNotes(forecast.notes),
          },
        });
      }
      removed.sourcesReopened = forecasts.length;
    } else {
      removed.sourcesReopened = (await tx.salesOrderHeader.updateMany({
        where: { soNumber: { in: normalized.sourceNumbers }, isDeleted: false },
        data: { status: "Draft", approvedBy: null, approvedDate: null },
      })).count;
      await tx.salesOrderDetail.updateMany({
        where: { soNumber: { in: normalized.sourceNumbers }, isDeleted: false },
        data: { status: "Pending" },
      });
    }

    await tx.planningChangeImpact.create({
      data: {
        changeType: "SOURCE_PLANNING_RESET",
        sourceType: normalized.sourceType,
        sourceNumber: normalized.sourceNumbers.join(", "),
        oldValue: { layers: normalized.layers, documents: impactCounts(graph, normalized.layers) },
        newValue: { status: "Draft", stockPreserved: true },
        affectedMpsNumbers: graph.mpsNumbers,
        affectedPlanNumbers: graph.planNumbers,
        status: "RESOLVED",
        resolutionNotes: reason,
        changedBy: actor,
        resolvedBy: actor,
        resolvedAt: new Date(),
      },
    });
    const protectedAfter = await protectedSnapshot(tx);
    if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) {
      const error = new Error("Verifikasi inventory gagal: data stock/receipt berubah saat reset.");
      error.code = "PROTECTED_STOCK_CHANGED";
      throw error;
    }
    return { graph, removed, protected: protectedAfter };
  }, { maxWait: 30000, timeout: 120000 });

  return {
    status: "COMPLETED",
    selection: normalized,
    impact: impactCounts(result.graph, normalized.layers),
    removed: result.removed,
    protected: result.protected,
  };
}

module.exports = {
  LAYERS,
  normalizeRequest,
  listResetSources,
  previewSourcePlanningReset,
  resetSourcePlanning,
};
