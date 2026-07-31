const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PO_STATUSES = new Set([
  "Approved",
  "Sent",
  "Confirmed",
  "Partial Receipt",
  "Completed",
]);

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 3) => Number(number(value).toFixed(digits));
const day = (value) => {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));
};
const addDays = (value, days) => new Date(day(value).getTime() + number(days) * DAY_MS);

function sourceNumbers(detail) {
  const values = [
    detail?.plannedOrderNumber,
    ...(Array.isArray(detail?.sourcePlannedOrderNumbers)
      ? detail.sourcePlannedOrderNumbers
      : []),
  ];
  return new Set(values.filter(Boolean).map(String));
}

function allocatedDetailQty(detail, orderNumber) {
  const allocations = Array.isArray(detail?.lotAllocations)
    ? detail.lotAllocations
    : [];
  const allocated = allocations
    .filter((item) => String(item?.plannedOrderNumber || "") === orderNumber)
    .reduce((sum, item) => sum + number(item?.qtyKg), 0);
  if (allocated > 0) return allocated;
  const sources = [...sourceNumbers(detail)];
  if (!sources.includes(orderNumber)) return 0;
  return number(detail.qty) / Math.max(sources.length, 1);
}

function supplierContext(order) {
  const supplierItems = order.part?.supplierItems || [];
  const selected = supplierItems.find(
    (item) => item.supplier?.supplierCode === order.supplierCode,
  ) || supplierItems.find((item) => item.isPreferred) || supplierItems[0] || null;
  const direct = order.part?.supplier || null;
  const supplier = order.supplierCode
    ? selected?.supplier || (direct?.supplierCode === order.supplierCode ? direct : null)
    : selected?.supplier || direct;
  return {
    supplierCode: order.supplierCode || supplier?.supplierCode || null,
    supplierName: supplier?.supplierName || null,
    leadTimeDays: number(selected?.leadTimeDays ?? supplier?.leadTimeDays),
    source: selected?.leadTimeDays != null
      ? "SUPPLIER_ITEM"
      : supplier?.leadTimeDays != null
        ? "SUPPLIER"
        : null,
  };
}

async function buildMaterialReadinessSnapshot(prisma, planOrNumber) {
  const plan = typeof planOrNumber === "string"
    ? await prisma.monthlyProductionPlan.findFirst({
      where: { planNumber: planOrNumber, isDeleted: false },
      select: {
        id: true,
        planNumber: true,
        sourceType: true,
        periodStart: true,
        periodEnd: true,
      },
    })
    : planOrNumber;
  if (!plan) throw Object.assign(new Error("Monthly Production Plan tidak ditemukan."), { status: 404 });

  const mpsNumber = String(plan.sourceType || "").startsWith("MPS:")
    ? String(plan.sourceType).slice(4)
    : null;
  const run = mpsNumber
    ? await prisma.mRPRun.findFirst({
      where: {
        mpsNumber,
        isDeleted: false,
        isCurrentPlan: true,
        status: "Completed",
      },
      orderBy: { createdAt: "desc" },
      select: { runNumber: true, runDate: true },
    })
    : null;
  if (!run) {
    return {
      planNumber: plan.planNumber,
      mpsNumber,
      mrpRunNumber: null,
      ready: false,
      summary: { total: 0, blocking: 1, warning: 0, ready: 0 },
      issues: [{
        severity: "BLOCKING",
        code: "MRP_NOT_COMPLETED",
        message: "MRP current dan Completed belum tersedia untuk Production Plan.",
      }],
      items: [],
    };
  }

  const orders = await prisma.plannedOrder.findMany({
    where: {
      runNumber: run.runNumber,
      orderType: "Purchase",
      isDeleted: false,
      status: { notIn: ["Cancelled"] },
      qty: { gt: 0 },
    },
    include: {
      part: {
        select: {
          id: true,
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
          supplier: {
            select: {
              supplierCode: true,
              supplierName: true,
              leadTimeDays: true,
            },
          },
          supplierItems: {
            where: { isActive: true },
            orderBy: [{ isPreferred: "desc" }, { priority: "asc" }],
            select: {
              leadTimeDays: true,
              isPreferred: true,
              priority: true,
              supplier: {
                select: {
                  supplierCode: true,
                  supplierName: true,
                  leadTimeDays: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: [{ requiredDate: "asc" }, { orderNumber: "asc" }],
  });

  const orderNumbers = orders.map((order) => order.orderNumber);
  const [prDetails, stockRows] = await Promise.all([
    orderNumbers.length
      ? prisma.purchaseRequisitionDetail.findMany({
        where: {
          isDeleted: false,
          OR: [
            { plannedOrderNumber: { in: orderNumbers } },
            { pr: { notes: { contains: run.runNumber }, isDeleted: false } },
          ],
        },
        include: {
          pr: {
            select: {
              prNumber: true,
              status: true,
              requiredDate: true,
              isDeleted: true,
            },
          },
          poDetails: {
            where: { isDeleted: false },
            include: {
              po: {
                select: {
                  poNumber: true,
                  status: true,
                  deliveryDate: true,
                  isDeleted: true,
                },
              },
            },
          },
        },
      })
      : [],
    orders.length
      ? prisma.stockBalance.groupBy({
        by: ["partCode"],
        where: {
          partCode: { in: [...new Set(orders.map((order) => order.partCode))] },
          isDeleted: false,
          warehouse: { availableForProduction: true, isDeleted: false },
        },
        _sum: { qtyAvailable: true },
      })
      : [],
  ]);

  const stockByPartCode = new Map(
    stockRows.map((row) => [row.partCode, number(row._sum?.qtyAvailable)]),
  );
  const today = day(new Date());
  const issues = [];
  const items = orders.map((order) => {
    const supplier = supplierContext(order);
    const requiredDate = day(order.requiredDate);
    const calculatedOrderDate = supplier.leadTimeDays > 0
      ? addDays(requiredDate, -supplier.leadTimeDays)
      : day(order.orderDate);
    const linkedDetails = prDetails.filter((detail) => sourceNumbers(detail).has(order.orderNumber));
    let prQty = 0;
    let poQty = 0;
    let receivedQty = 0;
    let latestDeliveryDate = null;
    const prNumbers = new Set();
    const poNumbers = new Set();

    for (const detail of linkedDetails) {
      const detailShare = allocatedDetailQty(detail, order.orderNumber);
      prQty += detailShare;
      prNumbers.add(detail.pr?.prNumber);
      const detailQty = Math.max(number(detail.qty), 0);
      for (const poDetail of detail.poDetails || []) {
        if (!poDetail.po || poDetail.po.isDeleted || !ACTIVE_PO_STATUSES.has(poDetail.po.status)) continue;
        const ratio = detailQty > 0 ? detailShare / detailQty : 0;
        poQty += number(poDetail.qty) * ratio;
        receivedQty += number(poDetail.qtyReceived) * ratio;
        poNumbers.add(poDetail.po.poNumber);
        const delivery = day(poDetail.deliveryDate || poDetail.po.deliveryDate);
        if (delivery && (!latestDeliveryDate || delivery > latestDeliveryDate)) latestDeliveryDate = delivery;
      }
    }

    const requiredQty = number(order.qty);
    const stockAvailable = stockByPartCode.get(order.partCode) || 0;
    const remainingToRelease = Math.max(requiredQty - number(order.qtyReleased), 0);
    const lineIssues = [];
    const push = (severity, code, message) => {
      const issue = {
        severity,
        code,
        orderNumber: order.orderNumber,
        partCode: order.partCode,
        message,
      };
      lineIssues.push(issue);
      issues.push(issue);
    };

    if (!supplier.supplierCode) {
      push("BLOCKING", "SUPPLIER_MISSING", `${order.partCode} belum mempunyai supplier pilihan/default.`);
    }
    if (supplier.leadTimeDays <= 0) {
      push("BLOCKING", "SUPPLIER_LEAD_TIME_MISSING", `${order.partCode} belum mempunyai lead time Supplier-Item/Supplier.`);
    }
    if (
      supplier.leadTimeDays > 0 &&
      calculatedOrderDate &&
      calculatedOrderDate < today &&
      poQty + 0.000001 < requiredQty
    ) {
      push("BLOCKING", "MATERIAL_ORDER_LATE", `${order.partCode} melewati tanggal order ${calculatedOrderDate.toISOString().slice(0, 10)} dan supply PO belum mencukupi.`);
    }
    if (latestDeliveryDate && latestDeliveryDate > requiredDate) {
      push("BLOCKING", "PO_DELIVERY_LATE", `${order.partCode} dijadwalkan datang ${latestDeliveryDate.toISOString().slice(0, 10)}, setelah required date ${requiredDate.toISOString().slice(0, 10)}.`);
    }
    if (prQty + 0.000001 < requiredQty) {
      push("WARNING", "PR_RELEASE_PENDING", `${order.partCode} masih memiliki ${round(requiredQty - prQty)} yang belum direlease ke PR.`);
    } else if (poQty + 0.000001 < prQty) {
      push("WARNING", "PO_CONVERSION_PENDING", `${order.partCode} masih memiliki ${round(prQty - poQty)} PR yang belum menjadi PO aktif.`);
    }

    return {
      orderNumber: order.orderNumber,
      partCode: order.partCode,
      partNumber: order.part?.partNumber || null,
      partName: order.part?.partName || null,
      itemType: order.part?.itemType || null,
      rawType: order.part?.rawType || null,
      requiredQty: round(requiredQty),
      releasedToPrQty: round(number(order.qtyReleased)),
      remainingToReleaseQty: round(remainingToRelease),
      prQty: round(prQty),
      poQty: round(poQty),
      receivedQty: round(receivedQty),
      stockAvailableQty: round(stockAvailable),
      stockCoveredQty: round(Math.min(requiredQty, stockAvailable)),
      stockShortageQty: round(Math.max(requiredQty - stockAvailable, 0)),
      stockCheck: stockAvailable + 0.000001 >= requiredQty ? "COVERED" : "PURCHASE_REQUIRED",
      uomCode: order.uomCode || null,
      supplierCode: supplier.supplierCode,
      supplierName: supplier.supplierName,
      leadTimeDays: supplier.leadTimeDays,
      leadTimeSource: supplier.source,
      orderDate: calculatedOrderDate,
      requiredDate,
      latestDeliveryDate,
      prNumbers: [...prNumbers].filter(Boolean),
      poNumbers: [...poNumbers].filter(Boolean),
      ready: !lineIssues.some((issue) => issue.severity === "BLOCKING"),
      issues: lineIssues,
    };
  });

  const blocking = issues.filter((issue) => issue.severity === "BLOCKING").length;
  const warning = issues.filter((issue) => issue.severity === "WARNING").length;
  return {
    planNumber: plan.planNumber,
    mpsNumber,
    mrpRunNumber: run.runNumber,
    generatedAt: new Date(),
    ready: blocking === 0,
    summary: {
      total: items.length,
      blocking,
      warning,
      ready: items.filter((item) => item.ready).length,
      stockCoveredQty: round(items.reduce((sum, item) => sum + number(item.stockCoveredQty), 0)),
      stockShortageQty: round(items.reduce((sum, item) => sum + number(item.stockShortageQty), 0)),
    },
    issues,
    items,
  };
}

module.exports = { buildMaterialReadinessSnapshot };
