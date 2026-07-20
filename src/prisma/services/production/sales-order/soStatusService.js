const {
  buildSalesOrderProducedQtyMap,
} = require("./soProductionTraceService");
const {
  syncReservationsForConfirmedSO,
} = require("./soReservationService");

const ACTIVE_OPERATIONAL_STATUSES = new Set([
  "Confirmed",
  "In Progress",
  "Ready to Deliver",
  // Legacy header values kept here so old rows can be re-synced into In Progress.
  "In Planning",
  "In Production",
  "Delivered",
]);

const RESERVATION_SYNC_STATUSES = new Set([
  "Confirmed",
  "In Progress",
  "Ready to Deliver",
  "In Planning",
  "In Production",
]);

const buildSoLineReferenceNumber = (soNumber, lineNumber) =>
  `${soNumber}#${String(lineNumber)}`;

const toNumber = (value) => Number(value || 0);

const parseSoLineReference = (reference) => {
  const match = String(reference || "").match(/^(.*)#(\d+)$/);
  if (!match) return null;
  return {
    soNumber: match[1],
    lineNumber: Number(match[2]),
  };
};

const normalizeMrpPlanRef = (plannedOrder) => {
  if (!plannedOrder) return null;
  const planNumber =
    plannedOrder.mrpRun?.planNumber ||
    (plannedOrder.referenceType === "MRP" ? plannedOrder.referenceNumber : null) ||
    plannedOrder.runNumber;

  if (!planNumber) return null;

  return {
    planNumber,
    runNumber: plannedOrder.mrpRun?.runNumber || plannedOrder.runNumber || null,
    planRevision: plannedOrder.mrpRun?.planRevision || null,
    planScope: plannedOrder.mrpRun?.planScope || null,
  };
};

const emitSalesOrderStatusUpdate = (so, action = "sync", actionBy = "system") => {
  try {
    const io = global.io;
    if (!io || !so?.soNumber) return;

    const payload = {
      soNumber: so.soNumber,
      status: so.status,
      action,
      actionBy,
      updatedAt: so.updatedAt,
    };

    if (Array.isArray(so.details)) {
      payload.details = so.details;
    }

    io.emit("sales-order:status", payload);
  } catch (err) {
    console.error("Failed to emit SO status update:", err);
  }
};

const buildOperationalContext = async (tx, soHeader, details) => {
  const lineRefs = details.map((detail, idx) =>
    buildSoLineReferenceNumber(soHeader.soNumber, detail.lineNumber || idx + 1)
  );
  const lineNumbers = details.map((detail, idx) => detail.lineNumber || idx + 1);

  const reservations = await tx.stockReservation.findMany({
    where: {
      referenceType: "SO",
      referenceNumber: { in: lineRefs },
      status: "Active",
      isDeleted: false,
    },
    select: {
      referenceNumber: true,
      qtyReserved: true,
      qtyReleased: true,
    },
  });

  const reservedOpenByRef = new Map();
  for (const reservation of reservations) {
    const openQty = Math.max(
      0,
      toNumber(reservation.qtyReserved) - toNumber(reservation.qtyReleased)
    );
    const current = reservedOpenByRef.get(reservation.referenceNumber) || 0;
    reservedOpenByRef.set(reservation.referenceNumber, current + openQty);
  }

  const producedByRef = await buildSalesOrderProducedQtyMap(tx, lineRefs);

  const peggings = await tx.mRPPegging.findMany({
    where: {
      demandType: "SO",
      demandNumber: soHeader.soNumber,
      demandLineNumber: { in: lineNumbers },
      status: "Active",
    },
    select: {
      demandLineNumber: true,
      supplyType: true,
      supplyNumber: true,
      qtyPegged: true,
    },
  });

  const plannedOrderNumbers = [
    ...new Set(
      peggings
        .filter((item) => item.supplyType === "PlannedOrder")
        .map((item) => item.supplyNumber)
        .filter(Boolean)
    ),
  ];
  const moNumbersFromPegging = [
    ...new Set(
      peggings
        .filter((item) => item.supplyType === "MO")
        .map((item) => item.supplyNumber)
        .filter(Boolean)
    ),
  ];

  const plannedOrderFilters = [];
  if (plannedOrderNumbers.length > 0) {
    plannedOrderFilters.push({ orderNumber: { in: plannedOrderNumbers } });
  }
  if (lineRefs.length > 0) {
    plannedOrderFilters.push({
      referenceType: "SO",
      referenceNumber: { in: lineRefs },
    });
  }

  const plannedOrders = plannedOrderFilters.length
    ? await tx.plannedOrder.findMany({
        where: {
          isDeleted: false,
          status: { in: ["Planned", "Partially Released", "Released"] },
          OR: plannedOrderFilters,
        },
        select: {
          orderNumber: true,
          runNumber: true,
          status: true,
          referenceType: true,
          referenceNumber: true,
          mrpRun: {
            select: {
              runNumber: true,
              planNumber: true,
              planRevision: true,
              planScope: true,
            },
          },
        },
      })
    : [];

  const directMoPlannedOrderNumbers = plannedOrders
    .filter((order) => ["Partially Released", "Released"].includes(order.status))
    .map((order) => order.orderNumber);
  const directMos = directMoPlannedOrderNumbers.length
    ? await tx.manufacturingOrder.findMany({
        where: {
          plannedOrderNumber: { in: directMoPlannedOrderNumbers },
          referenceType: "MRPPlannedOrder",
          isDeleted: false,
          status: { in: ["Draft", "Released", "In Progress"] },
        },
        select: {
          moNumber: true,
          plannedOrderNumber: true,
          status: true,
        },
      })
    : [];
  const activeMoNumbers = [...new Set([...moNumbersFromPegging, ...directMos.map((mo) => mo.moNumber)])];
  const manufacturingOrders = activeMoNumbers.length
    ? await tx.manufacturingOrder.findMany({
        where: {
          moNumber: { in: activeMoNumbers },
          isDeleted: false,
          status: { in: ["Draft", "Released", "In Progress"] },
        },
        select: {
          moNumber: true,
          status: true,
        },
      })
    : [];

  const activePlannedOrderNumbers = new Set(
    plannedOrders
      .filter((order) => order.status === "Planned")
      .map((order) => order.orderNumber)
  );
  const plannedOrderByNumber = new Map(plannedOrders.map((order) => [order.orderNumber, order]));
  const activeMoNumberSet = new Set(manufacturingOrders.map((order) => order.moNumber));
  const activeDirectMoByPlannedOrder = new Map(
    directMos
      .filter((mo) => activeMoNumberSet.has(mo.moNumber))
      .map((mo) => [mo.plannedOrderNumber, mo.moNumber]),
  );
  const plannedOrderRefs = new Set();
  const inProductionRefs = new Set();
  const traceByRef = new Map();

  for (const lineRef of lineRefs) {
    traceByRef.set(lineRef, {
      plannedOrders: [],
      mrpPlans: [],
      manufacturingOrders: [],
      peggedQty: 0,
    });
  }

  for (const pegging of peggings) {
    const lineNumber = pegging.demandLineNumber;
    if (!lineNumber) continue;
    const lineRef = buildSoLineReferenceNumber(soHeader.soNumber, lineNumber);
    const trace = traceByRef.get(lineRef);
    if (!trace) continue;

    trace.peggedQty += toNumber(pegging.qtyPegged);

    if (pegging.supplyType === "PlannedOrder" && activePlannedOrderNumbers.has(pegging.supplyNumber)) {
      plannedOrderRefs.add(lineRef);
      trace.plannedOrders.push(pegging.supplyNumber);
      const mrpPlan = normalizeMrpPlanRef(plannedOrderByNumber.get(pegging.supplyNumber));
      if (mrpPlan) trace.mrpPlans.push(mrpPlan);
    }

    if (pegging.supplyType === "MO" && activeMoNumberSet.has(pegging.supplyNumber)) {
      inProductionRefs.add(lineRef);
      trace.manufacturingOrders.push(pegging.supplyNumber);
    }
  }

  for (const plannedOrder of plannedOrders) {
    if (plannedOrder.referenceType !== "SO" || !lineRefs.includes(plannedOrder.referenceNumber)) {
      continue;
    }

    const trace = traceByRef.get(plannedOrder.referenceNumber);
    if (!trace) continue;

    if (plannedOrder.status === "Planned") {
      plannedOrderRefs.add(plannedOrder.referenceNumber);
      trace.plannedOrders.push(plannedOrder.orderNumber);
      const mrpPlan = normalizeMrpPlanRef(plannedOrder);
      if (mrpPlan) trace.mrpPlans.push(mrpPlan);
    } else if (activeDirectMoByPlannedOrder.has(plannedOrder.orderNumber)) {
      inProductionRefs.add(plannedOrder.referenceNumber);
      trace.manufacturingOrders.push(activeDirectMoByPlannedOrder.get(plannedOrder.orderNumber));
    }
  }

  for (const plannedOrder of plannedOrders) {
    const directMoNumber = activeDirectMoByPlannedOrder.get(plannedOrder.orderNumber);
    if (!directMoNumber) {
      continue;
    }

    for (const pegging of peggings) {
      if (pegging.supplyType !== "PlannedOrder" || pegging.supplyNumber !== plannedOrder.orderNumber) {
        continue;
      }
      const lineRef = buildSoLineReferenceNumber(soHeader.soNumber, pegging.demandLineNumber);
      const trace = traceByRef.get(lineRef);
      if (!trace) continue;

      inProductionRefs.add(lineRef);
      trace.manufacturingOrders.push(directMoNumber);
      const mrpPlan = normalizeMrpPlanRef(plannedOrder);
      if (mrpPlan) trace.mrpPlans.push(mrpPlan);
    }
  }

  for (const trace of traceByRef.values()) {
    trace.plannedOrders = [...new Set(trace.plannedOrders)];
    const seenPlans = new Set();
    trace.mrpPlans = trace.mrpPlans.filter((plan) => {
      if (!plan?.planNumber || seenPlans.has(plan.planNumber)) return false;
      seenPlans.add(plan.planNumber);
      return true;
    });
    trace.manufacturingOrders = [...new Set(trace.manufacturingOrders)];
  }

  return {
    lineRefs,
    reservedOpenByRef,
    producedByRef,
    plannedOrderRefs,
    inProductionRefs,
    traceByRef,
  };
};

const deriveDetailStatus = ({
  soHeaderStatus,
  qty,
  qtyDelivered,
  isOutstandingReserved,
  hasActivePlannedOrder,
  hasActiveManufacturingOrder,
  hasProducedQty,
}) => {
  const outstanding = Math.max(0, toNumber(qty) - toNumber(qtyDelivered));

  if (soHeaderStatus === "Cancelled") {
    return outstanding <= 0 ? "Completed" : "Cancelled";
  }
  if (outstanding <= 0) {
    return "Completed";
  }
  if (soHeaderStatus === "Draft") {
    return "Pending";
  }
  if (isOutstandingReserved) {
    return "Completed";
  }
  if (hasActiveManufacturingOrder || hasProducedQty) {
    return "In Production";
  }
  if (hasActivePlannedOrder) {
    return "In Planning";
  }
  return "In Planning";
};

const isFullyDelivered = (details) => {
  if (!details.length) return false;
  return details.every((detail) => toNumber(detail.qtyDelivered) >= toNumber(detail.qty));
};

const deriveOperationalStatus = async (tx, soHeader) => {
  if (!soHeader?.soNumber) return soHeader?.status || "Draft";

  if (soHeader.status === "Cancelled") {
    return "Cancelled";
  }

  const details = await tx.salesOrderDetail.findMany({
    where: {
      soNumber: soHeader.soNumber,
      isDeleted: false,
    },
    select: {
      lineNumber: true,
      qty: true,
      qtyDelivered: true,
    },
    orderBy: { lineNumber: "asc" },
  });

  if (!details.length) {
    return soHeader.status || "Draft";
  }

  if (isFullyDelivered(details)) {
    return "Delivered";
  }

  if (!ACTIVE_OPERATIONAL_STATUSES.has(soHeader.status)) {
    return soHeader.status;
  }

  const { lineRefs, reservedOpenByRef, plannedOrderRefs, inProductionRefs, producedByRef } = await buildOperationalContext(
    tx,
    soHeader,
    details
  );

  const allOutstandingCovered = details.every((detail, idx) => {
    const lineRef = lineRefs[idx];
    const outstandingQty = Math.max(
      0,
      toNumber(detail.qty) - toNumber(detail.qtyDelivered)
    );
    const reservedOpen = reservedOpenByRef.get(lineRef) || 0;
    return reservedOpen >= outstandingQty;
  });

  if (allOutstandingCovered) {
    return "Ready to Deliver";
  }

  if (inProductionRefs.size > 0) {
    return "In Progress";
  }

  if (plannedOrderRefs.size > 0) {
    return "In Progress";
  }

  const hasProducedQty = details.some((detail, idx) => {
    const lineRef = lineRefs[idx];
    return toNumber(producedByRef.get(lineRef)) > toNumber(detail.qtyDelivered);
  });

  if (hasProducedQty) {
    return "In Progress";
  }

  if (["In Planning", "In Production"].includes(soHeader.status)) {
    return "In Progress";
  }

  if (["Confirmed", "Ready to Deliver"].includes(soHeader.status)) {
    return "In Progress";
  }

  return soHeader.status;
};

const syncOperationalSalesOrderStatus = async (tx, soNumber) => {
  const soHeader = await tx.salesOrderHeader.findFirst({
    where: {
      soNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      soNumber: true,
      soDate: true,
      deliveryDate: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!soHeader) return null;

  const details = await tx.salesOrderDetail.findMany({
    where: {
      soNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      lineNumber: true,
      partCode: true,
      uomCode: true,
      qty: true,
      qtyProduced: true,
      qtyDelivered: true,
      status: true,
      isDeleted: true,
    },
    orderBy: { lineNumber: "asc" },
  });

  let detailsChanged = false;

  if (details.length > 0 && RESERVATION_SYNC_STATUSES.has(soHeader.status)) {
    await syncReservationsForConfirmedSO(tx, soHeader, details);
  }

  if (details.length > 0) {
    const { lineRefs, reservedOpenByRef, plannedOrderRefs, inProductionRefs, producedByRef } = await buildOperationalContext(
      tx,
      soHeader,
      details
    );

    for (const [idx, detail] of details.entries()) {
      const lineRef = lineRefs[idx];
      const nextQtyProduced = toNumber(producedByRef.get(lineRef));
      const nextDetailStatus = deriveDetailStatus({
        soHeaderStatus: soHeader.status,
        qty: detail.qty,
        qtyDelivered: detail.qtyDelivered,
        isOutstandingReserved:
          (reservedOpenByRef.get(lineRef) || 0) >=
          Math.max(0, toNumber(detail.qty) - toNumber(detail.qtyDelivered)),
        hasActivePlannedOrder: plannedOrderRefs.has(lineRef),
        hasActiveManufacturingOrder: inProductionRefs.has(lineRef),
        hasProducedQty: nextQtyProduced > toNumber(detail.qtyDelivered),
      });

      const detailUpdate = {};
      if (nextDetailStatus !== detail.status) {
        detailUpdate.status = nextDetailStatus;
      }
      if (nextQtyProduced !== toNumber(detail.qtyProduced)) {
        detailUpdate.qtyProduced = nextQtyProduced;
      }

      if (Object.keys(detailUpdate).length > 0) {
        await tx.salesOrderDetail.update({
          where: { id: detail.id },
          data: detailUpdate,
        });
        detailsChanged = true;
      }
    }
  }

  const nextStatus = await deriveOperationalStatus(tx, soHeader);
  if (!nextStatus || nextStatus === soHeader.status) {
    if (detailsChanged) {
      const updatedDetails = await tx.salesOrderDetail.findMany({
        where: {
          soNumber,
          isDeleted: false,
        },
        select: {
          id: true,
          lineNumber: true,
          status: true,
          qtyProduced: true,
          qtyDelivered: true,
          updatedAt: true,
        },
        orderBy: { lineNumber: "asc" },
      });

      emitSalesOrderStatusUpdate({
        ...soHeader,
        details: updatedDetails,
      });
    }
    return soHeader;
  }

  const updated = await tx.salesOrderHeader.update({
    where: { id: soHeader.id },
    data: { status: nextStatus },
    select: {
      id: true,
      soNumber: true,
      status: true,
      updatedAt: true,
      details: {
        where: { isDeleted: false },
        select: {
          id: true,
          lineNumber: true,
          status: true,
          qtyProduced: true,
          qtyDelivered: true,
          updatedAt: true,
        },
        orderBy: { lineNumber: "asc" },
      },
    },
  });

  emitSalesOrderStatusUpdate(updated);
  return updated;
};

const explainOperationalSalesOrderStatus = async (tx, soNumber) => {
  const soHeader = await tx.salesOrderHeader.findFirst({
    where: {
      soNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      soNumber: true,
      status: true,
    },
  });

  if (!soHeader) return null;

  const details = await tx.salesOrderDetail.findMany({
    where: {
      soNumber,
      isDeleted: false,
    },
    select: {
      id: true,
      lineNumber: true,
      partCode: true,
      qty: true,
      qtyDelivered: true,
      status: true,
    },
    orderBy: { lineNumber: "asc" },
  });

  const context = details.length
    ? await buildOperationalContext(tx, soHeader, details)
    : {
        lineRefs: [],
        reservedOpenByRef: new Map(),
        plannedOrderRefs: new Set(),
        inProductionRefs: new Set(),
        producedByRef: new Map(),
        traceByRef: new Map(),
      };

  const lines = details.map((detail, idx) => {
    const lineRef = context.lineRefs[idx];
    const outstandingQty = Math.max(
      0,
      toNumber(detail.qty) - toNumber(detail.qtyDelivered)
    );
    const reservedOpenQty = context.reservedOpenByRef.get(lineRef) || 0;
    const qtyProduced = context.producedByRef.get(lineRef) ?? detail.qtyProduced;
    const hasActivePlannedOrder = context.plannedOrderRefs.has(lineRef);
    const hasActiveManufacturingOrder = context.inProductionRefs.has(lineRef);
    const expectedStatus = deriveDetailStatus({
      soHeaderStatus: soHeader.status,
      qty: detail.qty,
      qtyDelivered: detail.qtyDelivered,
      isOutstandingReserved: reservedOpenQty >= outstandingQty,
      hasActivePlannedOrder,
      hasActiveManufacturingOrder,
      hasProducedQty: toNumber(qtyProduced) > toNumber(detail.qtyDelivered),
    });
    const trace = context.traceByRef.get(lineRef) || {
      plannedOrders: [],
      mrpPlans: [],
      manufacturingOrders: [],
      peggedQty: 0,
    };

    return {
      detailId: detail.id,
      lineNumber: detail.lineNumber,
      partCode: detail.partCode,
      qty: toNumber(detail.qty),
      qtyDelivered: toNumber(detail.qtyDelivered),
      qtyProduced: toNumber(qtyProduced),
      outstandingQty,
      reservedOpenQty,
      peggedQty: trace.peggedQty,
      plannedOrders: trace.plannedOrders,
      mrpPlans: trace.mrpPlans,
      manufacturingOrders: trace.manufacturingOrders,
      hasActivePlannedOrder,
      hasActiveManufacturingOrder,
      currentStatus: detail.status,
      expectedStatus,
      reason:
        expectedStatus === "Completed"
          ? outstandingQty <= 0
            ? "Qty delivered sudah memenuhi qty line"
            : "Line sudah ter-cover untuk delivery"
          : expectedStatus === "Cancelled"
          ? "SO dibatalkan dan line belum selesai dikirim"
          : expectedStatus === "In Production"
          ? "Line sudah punya Manufacturing Order aktif dari pegging MRP"
          : expectedStatus === "In Planning"
          ? "Line sudah punya Planned Order aktif dari pegging MRP"
          : expectedStatus === "Pending"
          ? "SO masih Draft"
          : expectedStatus === "In Planning"
          ? "SO sudah aktif dan line belum punya Manufacturing Order aktif"
          : "Status operasional dihitung otomatis dari traceability planning/production",
    };
  });

  const expectedHeaderStatus = await deriveOperationalStatus(tx, soHeader);

  return {
    soNumber: soHeader.soNumber,
    headerStatusCurrent: soHeader.status,
    headerStatusExpected: expectedHeaderStatus,
    lines,
  };
};

module.exports = {
  ACTIVE_OPERATIONAL_STATUSES,
  buildSoLineReferenceNumber,
  parseSoLineReference,
  syncOperationalSalesOrderStatus,
  explainOperationalSalesOrderStatus,
};
