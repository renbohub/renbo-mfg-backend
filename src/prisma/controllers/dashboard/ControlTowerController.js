const { prisma } = require("../../index");

const total = (rows, field) =>
  rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
const allocationStatus = (required, allocated) => {
  const variance = Number(allocated || 0) - Number(required || 0);
  return Math.abs(variance) <= 0.000001
    ? "EXACT"
    : variance < 0
      ? "UNDER"
      : "OVER";
};
const calendarDayStamp = (value) => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

async function purchaseControlBySo(soNumbers = []) {
  if (!soNumbers.length) return new Map();
  const sources = await prisma.purchaseRequisitionSource.findMany({
    where: {
      soNumber: { in: soNumbers },
      isDeleted: false,
      prDetail: { isDeleted: false, pr: { isDeleted: false } },
    },
    select: {
      id: true,
      soNumber: true,
      qty: true,
      uomCode: true,
      mrpRunNumber: true,
      prDetail: {
        select: {
          id: true,
          prNumber: true,
          qty: true,
          orderedQty: true,
          sources: { where: { isDeleted: false }, select: { qty: true } },
          sourcingAllocations: {
            where: { isDeleted: false, status: { not: "Cancelled" } },
            select: { supplierCode: true, demandCoveredQty: true },
          },
        },
      },
    },
  });
  const map = new Map(
    soNumbers.map((soNumber) => [
      soNumber,
      {
        demandQty: 0,
        supplierAllocatedQty: 0,
        orderedQty: 0,
        prNumbers: new Set(),
        mrpNumbers: new Set(),
        suppliers: new Set(),
      },
    ]),
  );
  sources.forEach((row) => {
    const control = map.get(row.soNumber);
    if (!control) return;
    const sourceQty = Number(row.qty || 0);
    const detailSourceQty =
      total(row.prDetail?.sources || [], "qty") ||
      Number(row.prDetail?.qty || 0) ||
      sourceQty;
    const share = detailSourceQty > 0 ? sourceQty / detailSourceQty : 0;
    const detailSupplierQty = total(
      row.prDetail?.sourcingAllocations || [],
      "demandCoveredQty",
    );
    control.demandQty += sourceQty;
    control.supplierAllocatedQty += detailSupplierQty * share;
    control.orderedQty += Number(row.prDetail?.orderedQty || 0) * share;
    if (row.prDetail?.prNumber) control.prNumbers.add(row.prDetail.prNumber);
    if (row.mrpRunNumber) control.mrpNumbers.add(row.mrpRunNumber);
    (row.prDetail?.sourcingAllocations || []).forEach((allocation) => {
      if (allocation.supplierCode)
        control.suppliers.add(allocation.supplierCode);
    });
  });
  return new Map(
    [...map].map(([soNumber, control]) => [
      soNumber,
      {
        demandQty: control.demandQty,
        supplierAllocatedQty: control.supplierAllocatedQty,
        supplierAllocationVariance:
          control.supplierAllocatedQty - control.demandQty,
        supplierAllocationStatus:
          control.demandQty > 0
            ? allocationStatus(control.demandQty, control.supplierAllocatedQty)
            : "UNDER",
        orderedQty: control.orderedQty,
        orderVariance: control.orderedQty - control.demandQty,
        orderControlStatus:
          control.demandQty > 0
            ? allocationStatus(control.demandQty, control.orderedQty)
            : "UNDER",
        prNumbers: [...control.prNumbers],
        mrpNumbers: [...control.mrpNumbers],
        suppliers: [...control.suppliers],
      },
    ]),
  );
}

function summarizeSalesOrder(so, now = new Date()) {
  const orderedQty = total(so.details, "qty");
  const deliveredQty = total(so.details, "qtyDelivered");
  const outstandingQty = Math.max(orderedQty - deliveredQty, 0);
  const overdue =
    so.deliveryDate && new Date(so.deliveryDate) < now && outstandingQty > 0;
  const scheduleRisk = so.deliverySchedules.some((item) =>
    ["Cancelled", "Failed"].includes(item.status),
  );
  const lateSchedules = so.deliverySchedules.filter((item) => {
    const actualDate = item.actualDate || item.deliveredAt;
    return (
      item.status === "Delivered" &&
      item.plannedDate &&
      actualDate &&
      new Date(actualDate) > new Date(item.plannedDate)
    );
  });
  const maxLateDays = lateSchedules.reduce((max, item) => {
    const actualDate = item.actualDate || item.deliveredAt;
    return Math.max(
      max,
      Math.round(
        (calendarDayStamp(actualDate) - calendarDayStamp(item.plannedDate)) /
          86400000,
      ),
    );
  }, 0);
  const risk = overdue
    ? "CRITICAL"
    : scheduleRisk || lateSchedules.length
      ? "RISK"
      : outstandingQty > 0
        ? "WARNING"
        : "HEALTHY";
  return {
    soNumber: so.soNumber,
    customer: so.customer,
    customerCode: so.customerCode,
    customerName: so.customerName || so.customer?.customerName || null,
    soDate: so.soDate,
    deliveryDate: so.deliveryDate,
    status: so.status,
    orderedQty,
    deliveredQty,
    outstandingQty,
    parts: [
      ...new Set(so.details.map((detail) => detail.partCode).filter(Boolean)),
    ],
    deliverySchedules: so.deliverySchedules,
    demandStatus: "CONFIRMED",
    deliveryStatus:
      outstandingQty === 0
        ? lateSchedules.length
          ? "COMPLETED_LATE"
          : "COMPLETED"
        : "OPEN",
    lateDeliveryCount: lateSchedules.length,
    maxLateDays,
    risk,
  };
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const q = String(req.query.q || req.query.search || "").trim();
    const activeOnly = [true, "true", "1"].includes(req.query.activeOnly);
    const where = {
      isDeleted: false,
      status: {
        notIn: activeOnly ? ["Cancelled", "Completed"] : ["Cancelled"],
      },
      ...(q
        ? {
            OR: [
              { soNumber: { contains: q, mode: "insensitive" } },
              { customerCode: { contains: q, mode: "insensitive" } },
              { customerName: { contains: q, mode: "insensitive" } },
              {
                details: {
                  some: {
                    isDeleted: false,
                    OR: [
                      { partCode: { contains: q, mode: "insensitive" } },
                      { partName: { contains: q, mode: "insensitive" } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [rows, count] = await Promise.all([
      prisma.salesOrderHeader.findMany({
        where,
        include: {
          customer: { select: { customerCode: true, customerName: true } },
          details: {
            where: { isDeleted: false },
            select: { partCode: true, qty: true, qtyDelivered: true },
          },
          deliverySchedules: {
            where: { isDeleted: false },
            select: {
              scheduleNumber: true,
              status: true,
              plannedDate: true,
              actualDate: true,
            },
          },
        },
        orderBy: { deliveryDate: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesOrderHeader.count({ where }),
    ]);
    const now = new Date();
    const purchaseControl = await purchaseControlBySo(
      rows.map((row) => row.soNumber),
    );
    const items = rows.map((so) => {
      const purchase = purchaseControl.get(so.soNumber);
      return {
        ...summarizeSalesOrder(so, now),
        purchaseDemandQty: purchase?.demandQty || 0,
        supplierAllocatedQty: purchase?.supplierAllocatedQty || 0,
        supplierAllocationVariance: purchase?.supplierAllocationVariance || 0,
        supplierAllocationStatus: purchase?.supplierAllocationStatus || "UNDER",
        purchaseOrderedQty: purchase?.orderedQty || 0,
        purchaseOrderVariance: purchase?.orderVariance || 0,
        purchaseOrderControlStatus: purchase?.orderControlStatus || "UNDER",
        purchasePrNumbers: purchase?.prNumbers || [],
        purchaseSuppliers: purchase?.suppliers || [],
      };
    });
    res.json({
      items,
      total: count,
      page,
      limit,
      summary: {
        total: count,
        critical: items.filter((item) => item.risk === "CRITICAL").length,
        risk: items.filter((item) => item.risk === "RISK").length,
        warning: items.filter((item) => item.risk === "WARNING").length,
        completedLate: items.filter(
          (item) => item.deliveryStatus === "COMPLETED_LATE",
        ).length,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const so = await prisma.salesOrderHeader.findFirst({
      where: { soNumber: req.params.soNumber, isDeleted: false },
      include: {
        customer: { select: { customerCode: true, customerName: true } },
        details: {
          where: { isDeleted: false },
          include: {
            part: {
              select: {
                id: true,
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                partType: true,
              },
            },
          },
          orderBy: { lineNumber: "asc" },
        },
        deliverySchedules: {
          where: { isDeleted: false },
          include: { details: { where: { isDeleted: false } } },
          orderBy: { plannedDate: "asc" },
        },
      },
    });
    if (!so)
      return res.status(404).json({ message: "Sales Order tidak ditemukan." });

    const partCodes = [
      ...new Set(so.details.map((row) => row.partCode).filter(Boolean)),
    ];
    const mpsDetails = partCodes.length
      ? await prisma.mPSDetail.findMany({
          where: {
            isDeleted: false,
            partCode: { in: partCodes },
            OR: [{ customerCode: so.customerCode }, { customerCode: null }],
            mps: { isDeleted: false },
          },
          select: {
            id: true,
            mpsNumber: true,
            partCode: true,
            startDate: true,
            endDate: true,
            forecastQty: true,
            actualSalesOrderQty: true,
            bufferQty: true,
            effectiveDemandQty: true,
            qtyPlanned: true,
            status: true,
            mps: { select: { forecastNumber: true, status: true } },
          },
          orderBy: { startDate: "asc" },
          take: 500,
        })
      : [];
    const mpsNumbers = [...new Set(mpsDetails.map((row) => row.mpsNumber))];
    const mpsDetailIds = mpsDetails.map((row) => row.id);
    const mrpRequirements = mpsDetailIds.length
      ? await prisma.mRPRequirement.findMany({
          where: {
            isDeleted: false,
            mpsDetailId: { in: mpsDetailIds },
            mrpRun: { isDeleted: false },
          },
          select: {
            runNumber: true,
            partCode: true,
            requirementType: true,
            orderType: true,
            grossRequirement: true,
            netRequirement: true,
            adjustedOrderQty: true,
            requiredDate: true,
            mrpRun: { select: { status: true, mpsNumber: true } },
          },
          orderBy: { requiredDate: "asc" },
          take: 1000,
        })
      : [];
    const planSources = mpsNumbers.map((number) => `MPS:${number}`);
    const productionPlans = planSources.length
      ? await prisma.monthlyProductionPlan.findMany({
          where: { isDeleted: false, sourceType: { in: planSources } },
          include: {
            details: {
              where: { isDeleted: false },
              orderBy: { lineNumber: "asc" },
            },
          },
          orderBy: { planMonth: "asc" },
          take: 100,
        })
      : [];
    const planNumbers = productionPlans.map((row) => row.planNumber);
    const manufacturingOrders = planNumbers.length
      ? await prisma.manufacturingOrder.findMany({
          where: {
            isDeleted: false,
            monthlyProductionPlanNumber: { in: planNumbers },
          },
          include: {
            part: {
              select: { partCode: true, partNumber: true, partName: true },
            },
          },
          orderBy: { plannedStartDate: "asc" },
          take: 500,
        })
      : [];

    const summary = summarizeSalesOrder(so);
    const purchaseControl =
      (await purchaseControlBySo([so.soNumber])).get(so.soNumber) || null;
    res.json({
      ...summary,
      notes: so.notes,
      details: so.details,
      deliverySchedules: so.deliverySchedules,
      mps: mpsDetails,
      mrp: mrpRequirements,
      productionPlans,
      manufacturingOrders,
      purchaseDemandControl: purchaseControl,
      traceSummary: {
        mpsDocuments: mpsNumbers.length,
        mrpRuns: new Set(mrpRequirements.map((row) => row.runNumber)).size,
        productionPlans: productionPlans.length,
        manufacturingOrders: manufacturingOrders.length,
        deliverySchedules: so.deliverySchedules.length,
      },
    });
  } catch (error) {
    next(error);
  }
};
