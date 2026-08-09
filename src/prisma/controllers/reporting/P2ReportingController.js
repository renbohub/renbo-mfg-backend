const { prisma } = require("../../index");
const {
  calculateLiveMbomCosts,
} = require("../../services/mbomLiveCostingService");
const { buildFgCompStockTraceability } = require("../../services/inventory/fgCompStockTraceabilityService");

const MONTH_FIELDS = [
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

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const safePage = (value) => Math.max(1, Number(value) || 1);
const safeLimit = (value) => Math.min(500, Math.max(1, Number(value) || 20));
const daysOld = (value) =>
  value
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(value).getTime()) / 86400000),
      )
    : 0;
const agingBucket = (days) => {
  if (days <= 30) return "0-30 days";
  if (days <= 60) return "31-60 days";
  if (days <= 90) return "61-90 days";
  return ">90 days";
};
const latestCost = (header) => header?.mbomcostHeaders?.[0] || null;

const mbomInclude = {
  part: {
    select: {
      partCode: true,
      partNumber: true,
      partName: true,
      itemType: true,
    },
  },
  details: {
    where: { isDeleted: false },
    select: {
      id: true,
      levelComponent: true,
      category: true,
      qty: true,
      grossWeight: true,
      uomCode: true,
      part: {
        select: {
          partCode: true,
          partNumber: true,
          partName: true,
          itemType: true,
          rawType: true,
        },
      },
      mbomProcesses: {
        where: { isDeleted: false },
        select: {
          id: true,
          cycleTime: true,
          routingMode: true,
          machineId: true,
          vendorId: true,
        },
      },
    },
  },
  mbomcostHeaders: {
    where: { isDeleted: false },
    orderBy: [
      { isStandard: "desc" },
      { costVersion: "desc" },
      { updatedAt: "desc" },
    ],
    take: 1,
    select: {
      id: true,
      qtyBase: true,
      costVersion: true,
      currencyCode: true,
      costModel: true,
      materialCost: true,
      processCost: true,
      overheadCost: true,
      totalCost: true,
      costPerUnit: true,
      status: true,
      isStandard: true,
      validFrom: true,
      validTo: true,
    },
  },
};

const mapMbom = (header, liveCosts = new Map()) => {
  const savedCost = latestCost(header);
  const liveCost = liveCosts.get(header.id) || null;
  const cost = savedCost || liveCost;
  const processes = header.details.flatMap((detail) => detail.mbomProcesses || []);
  const routingMissing = processes.filter(
    (process) =>
      number(process.cycleTime) <= 0 ||
      (process.routingMode === "VENDOR"
        ? !process.vendorId
        : !process.machineId),
  ).length;
  const componentCount = header.details.length;
  const rawMaterialCount = header.details.filter(
    (detail) =>
      detail.part?.itemType === "RAW" &&
      detail.part?.rawType === "MATERIAL",
  ).length;
  const purchasePartCount = header.details.filter(
    (detail) => detail.part?.rawType === "PURCHASE_PART",
  ).length;
  const maximumLevel = header.details.reduce(
    (maximum, detail) => Math.max(maximum, number(detail.levelComponent)),
    0,
  );

  return {
    id: header.id,
    noReg: header.noReg,
    revision: header.revision,
    effectiveDate: header.effectiveDate,
    expiryDate: header.expiryDate,
    uomCode: header.uomCode,
    partCode: header.part?.partCode || null,
    partNumber: header.part?.partNumber || null,
    partName: header.part?.partName || null,
    itemType: header.part?.itemType || null,
    componentCount,
    processCount: processes.length,
    rawMaterialCount,
    purchasePartCount,
    maximumLevel,
    routingMissing,
    readinessStatus:
      componentCount > 0 && processes.length > 0 && routingMissing === 0
        ? "READY"
        : "ACTION REQUIRED",
    costVersion: savedCost?.costVersion || (liveCost ? "LIVE" : null),
    costModel: savedCost?.costModel || (liveCost ? "CURRENT" : null),
    currencyCode: cost?.currencyCode || "IDR",
    materialCost: round(cost?.materialCost),
    processCost: round(cost?.processCost),
    overheadCost: round(cost?.overheadCost),
    totalCost: round(cost?.totalCost),
    costPerUnit: round(
      cost?.costPerUnit ??
        (number(cost?.totalCost) / Math.max(number(cost?.qtyBase), 1)),
    ),
    costingStatus: savedCost?.status || liveCost?.status || "NOT COSTED",
    isStandardCost: Boolean(savedCost?.isStandard),
  };
};

const mbomWhere = (query) => {
  const q = String(query.q || query.search || "").trim();
  return {
    isDeleted: false,
    ...(q
      ? {
          OR: [
            { noReg: { contains: q, mode: "insensitive" } },
            {
              part: {
                is: {
                  OR: [
                    { partCode: { contains: q, mode: "insensitive" } },
                    { partNumber: { contains: q, mode: "insensitive" } },
                    { partName: { contains: q, mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };
};

async function readMbomReport(req) {
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit);
  const where = mbomWhere(req.query);
  const costingDate = req.query.startDate || undefined;
  const [headers, allHeaders, total, liveCosts] = await Promise.all([
    prisma.mBOMHeader.findMany({
      where,
      include: mbomInclude,
      orderBy: [{ updatedAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.mBOMHeader.findMany({
      where,
      include: mbomInclude,
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.mBOMHeader.count({ where }),
    calculateLiveMbomCosts(prisma, { costingDate }),
  ]);
  const allItems = allHeaders.map((header) => mapMbom(header, liveCosts));
  const totalCost = allItems.reduce(
    (totalValue, item) => totalValue + number(item.totalCost),
    0,
  );
  const costed = allItems.filter((item) => item.costVersion != null).length;
  const ready = allItems.filter((item) => item.readinessStatus === "READY").length;

  return {
    items: headers.map((header) => mapMbom(header, liveCosts)),
    total,
    page,
    limit,
    summary: {
      totalBom: total,
      costedBom: costed,
      missingCost: Math.max(total - costed, 0),
      routingReady: ready,
      routingActionRequired: Math.max(total - ready, 0),
      totalStandardCost: round(totalCost),
      costingCoveragePercent: total > 0 ? round((costed / total) * 100, 1) : 0,
    },
    chart: {
      labels: ["Costed", "Not Costed", "Routing Ready", "Routing Action"],
      series: [costed, Math.max(total - costed, 0), ready, Math.max(total - ready, 0)],
    },
  };
}

exports.mbomCosting = async (req, res, next) => {
  try {
    res.json(await readMbomReport(req));
  } catch (error) {
    next(error);
  }
};

exports.mbomStructure = async (req, res, next) => {
  try {
    res.json(await readMbomReport(req));
  } catch (error) {
    next(error);
  }
};

exports.inventory = async (req, res, next) => {
  try {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const q = String(req.query.q || req.query.search || "").trim();
    const where = {
      isDeleted: false,
      ...(req.query.warehouseCode
        ? { warehouseCode: String(req.query.warehouseCode) }
        : {}),
      ...(req.query.stockType
        ? { stockType: String(req.query.stockType) }
        : {}),
      ...(q
        ? {
            OR: [
              { partCode: { contains: q, mode: "insensitive" } },
              { partNumber: { contains: q, mode: "insensitive" } },
              { partName: { contains: q, mode: "insensitive" } },
              { warehouseCode: { contains: q, mode: "insensitive" } },
              { rackCode: { contains: q, mode: "insensitive" } },
              { lotNumber: { contains: q, mode: "insensitive" } },
              { stockType: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const select = {
      id: true,
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      partCode: true,
      partNumber: true,
      partName: true,
      stockType: true,
      uomCode: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
      minStock: true,
      lastMovement: true,
    };
    const [rows, allRows, total, traceability] = await Promise.all([
      prisma.stockBalance.findMany({
        where,
        select,
        orderBy: [{ lastMovement: "asc" }, { partCode: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.stockBalance.findMany({ where, select }),
      prisma.stockBalance.count({ where }),
      buildFgCompStockTraceability(prisma, { q, warehouseCode: req.query.warehouseCode }),
    ]);
    const mapRow = (row) => {
      const agingDays = daysOld(row.lastMovement);
      const belowMinimum =
        number(row.minStock) > 0 &&
        number(row.qtyAvailable) < number(row.minStock);
      return {
        ...row,
        agingDays,
        agingBucket: agingBucket(agingDays),
        stockStatus: belowMinimum
          ? "BELOW MINIMUM"
          : number(row.qtyAvailable) <= 0
            ? "NO AVAILABLE STOCK"
            : "AVAILABLE",
      };
    };
    const mappedAll = allRows.map(mapRow);
    const agingCounts = mappedAll.reduce((result, row) => {
      result[row.agingBucket] = (result[row.agingBucket] || 0) + 1;
      return result;
    }, {});
    res.json({
      items: rows.map(mapRow),
      total,
      page,
      limit,
      summary: {
        totalStockLines: total,
        qtyOnHand: round(sumBy(mappedAll, "qtyOnHand")),
        qtyReserved: round(sumBy(mappedAll, "qtyReserved")),
        qtyQC: round(sumBy(mappedAll, "qtyQC")),
        qtyAvailable: round(sumBy(mappedAll, "qtyAvailable")),
        belowMinimumLines: mappedAll.filter(
          (row) => row.stockStatus === "BELOW MINIMUM",
        ).length,
        agedOver90Lines: agingCounts[">90 days"] || 0,
        fgCompTracked: traceability.summary.fgCompTracked,
        fgCompWithReadyFg: traceability.summary.fgCompWithReadyFg,
        fgCompWithWip: traceability.summary.fgCompWithWip,
        fgCompWithMaterial: traceability.summary.fgCompWithMaterial,
      },
      chart: {
        labels: ["0-30 days", "31-60 days", "61-90 days", ">90 days"],
        series: [
          agingCounts["0-30 days"] || 0,
          agingCounts["31-60 days"] || 0,
          agingCounts["61-90 days"] || 0,
          agingCounts[">90 days"] || 0,
        ],
      },
      traceability,
    });
  } catch (error) {
    next(error);
  }
};

function sumBy(rows, key) {
  return rows.reduce((total, row) => total + number(row[key]), 0);
}

exports.salesMargin = async (req, res, next) => {
  try {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const q = String(req.query.q || req.query.search || "").trim();
    const where = {
      isDeleted: false,
      soHeader: { isDeleted: false },
      ...(q
        ? {
            OR: [
              { soNumber: { contains: q, mode: "insensitive" } },
              { partCode: { contains: q, mode: "insensitive" } },
              { partNumber: { contains: q, mode: "insensitive" } },
              { partName: { contains: q, mode: "insensitive" } },
              {
                soHeader: {
                  customerName: { contains: q, mode: "insensitive" },
                },
              },
            ],
          }
        : {}),
    };
    const include = {
      soHeader: {
        select: {
          soNumber: true,
          soDate: true,
          customerCode: true,
          customerName: true,
          currencyCode: true,
          status: true,
        },
      },
      mbom: {
        select: {
          noReg: true,
          mbomcostHeaders: {
            where: { isDeleted: false },
            orderBy: [
              { isStandard: "desc" },
              { costVersion: "desc" },
              { updatedAt: "desc" },
            ],
            take: 1,
            select: {
              costVersion: true,
              currencyCode: true,
              costPerUnit: true,
              totalCost: true,
              qtyBase: true,
              isStandard: true,
            },
          },
        },
      },
    };
    const [rows, allRows, total, purchaseSpend] = await Promise.all([
      prisma.salesOrderDetail.findMany({
        where,
        include,
        orderBy: [{ soHeader: { soDate: "desc" } }, { lineNumber: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.salesOrderDetail.findMany({ where, include }),
      prisma.salesOrderDetail.count({ where }),
      prisma.purchaseOrderDetail.aggregate({
        where: { isDeleted: false, po: { isDeleted: false } },
        _sum: { totalAmount: true },
      }),
    ]);
    const mapRow = (row) => {
      const cost = row.mbom?.mbomcostHeaders?.[0] || null;
      const costPerUnit = number(
        cost?.costPerUnit ??
          number(cost?.totalCost) / Math.max(number(cost?.qtyBase), 1),
      );
      const revenue =
        number(row.totalAmount) ||
        number(row.qty) * number(row.unitPrice);
      const cogs = number(row.qty) * costPerUnit;
      const margin = revenue - cogs;
      return {
        id: row.id,
        soNumber: row.soNumber,
        soDate: row.soHeader.soDate,
        customerCode: row.soHeader.customerCode,
        customerName: row.soHeader.customerName,
        soStatus: row.soHeader.status,
        lineNumber: row.lineNumber,
        partCode: row.partCode,
        partNumber: row.partNumber,
        partName: row.partName,
        qty: round(row.qty),
        uomCode: row.uomCode,
        unitPrice: round(row.unitPrice),
        revenue: round(revenue),
        mbomNoReg: row.mbom?.noReg || null,
        costVersion: cost?.costVersion || null,
        costPerUnit: round(costPerUnit),
        cogs: round(cogs),
        margin: round(margin),
        marginPercent: revenue > 0 ? round((margin / revenue) * 100, 1) : 0,
        currencyCode: row.soHeader.currencyCode || "IDR",
        costingStatus: cost ? "COSTED" : "COST MISSING",
      };
    };
    const mappedAll = allRows.map(mapRow);
    const revenue = sumBy(mappedAll, "revenue");
    const cogs = sumBy(mappedAll, "cogs");
    const margin = revenue - cogs;
    const costed = mappedAll.filter(
      (row) => row.costingStatus === "COSTED",
    ).length;
    res.json({
      items: rows.map(mapRow),
      total,
      page,
      limit,
      summary: {
        totalSalesLines: total,
        revenue: round(revenue),
        cogs: round(cogs),
        grossMargin: round(margin),
        grossMarginPercent:
          revenue > 0 ? round((margin / revenue) * 100, 1) : 0,
        costedLines: costed,
        missingCostLines: Math.max(total - costed, 0),
        purchaseSpend: round(purchaseSpend._sum.totalAmount),
      },
      chart: {
        labels: ["Revenue", "COGS", "Gross Margin", "Purchase Spend"],
        series: [
          round(revenue),
          round(cogs),
          round(margin),
          round(purchaseSpend._sum.totalAmount),
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.costTrend = async (req, res, next) => {
  try {
    const year = Math.max(2000, Number(req.query.year) || new Date().getFullYear());
    const [partPrices, materialPrices] = await Promise.all([
      prisma.partPriceList.findMany({
        where: { isDeleted: false, pricingYear: year },
        select: Object.fromEntries([
          ["currencyCode", true],
          ...MONTH_FIELDS.map((field) => [field, true]),
        ]),
      }),
      prisma.materialPriceList.findMany({
        where: { isDeleted: false, pricingYear: year },
        select: Object.fromEntries([
          ["currencyCode", true],
          ...MONTH_FIELDS.map((field) => [field, true]),
        ]),
      }),
    ]);
    const averages = (rows) =>
      MONTH_FIELDS.map((field) => {
        const values = rows.map((row) => number(row[field])).filter((value) => value > 0);
        return values.length
          ? round(values.reduce((total, value) => total + value, 0) / values.length)
          : 0;
      });
    res.json({
      items: MONTH_FIELDS.map((field, index) => ({
        month: field,
        partAverage: averages(partPrices)[index],
        materialAverage: averages(materialPrices)[index],
      })),
      total: 12,
      page: 1,
      limit: 12,
      summary: {
        year,
        partPriceLists: partPrices.length,
        materialPriceLists: materialPrices.length,
      },
      chart: {
        labels: MONTH_FIELDS.map(
          (field) => field.charAt(0).toUpperCase() + field.slice(1, 3),
        ),
        series: [
          { name: "Part", data: averages(partPrices) },
          { name: "Material", data: averages(materialPrices) },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.purchasing = async (req, res, next) => {
  try {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const view = String(req.query.view || "resume").trim().toLowerCase();
    const q = String(req.query.q || req.query.search || "").trim();
    const where = {
      isDeleted: false,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(q
        ? {
            OR: [
              { poNumber: { contains: q, mode: "insensitive" } },
              { supplierCode: { contains: q, mode: "insensitive" } },
              { supplierName: { contains: q, mode: "insensitive" } },
              { vendorCode: { contains: q, mode: "insensitive" } },
              { vendorName: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where,
      include: {
        supplier: { select: { supplierCode: true, supplierName: true } },
        vendor: { select: { vendorCode: true, vendorName: true } },
        details: {
          where: { isDeleted: false },
          select: { qty: true, qtyReceived: true, totalAmount: true },
        },
        goodsReceipts: {
          where: { isDeleted: false },
          select: { grNumber: true, grDate: true, status: true },
          orderBy: { grDate: "asc" },
        },
      },
      orderBy: { poDate: "desc" },
    });
    const mapped = purchaseOrders.map((po) => {
      const lineCount = po.details.length;
      const receivedLineCount = po.details.filter(
        (detail) => number(detail.qtyReceived) + 1e-9 >= number(detail.qty),
      ).length;
      const receiptCoveragePercent = lineCount > 0
        ? round((receivedLineCount / lineCount) * 100, 1)
        : 0;
      const actualReceiptDate = po.goodsReceipts.at(-1)?.grDate || null;
      const leadTimeDays = po.poDate && po.deliveryDate
        ? Math.max(0, Math.ceil((new Date(po.deliveryDate) - new Date(po.poDate)) / 86400000))
        : 0;
      const onTime = actualReceiptDate && po.deliveryDate
        ? new Date(actualReceiptDate) <= new Date(po.deliveryDate)
        : null;
      return {
        poNumber: po.poNumber,
        poDate: po.poDate,
        partnerCode: po.supplierCode || po.vendorCode,
        partnerName: po.supplier?.supplierName || po.supplierName || po.vendor?.vendorName || po.vendorName || "-",
        partnerType: po.supplierCode ? "SUPPLIER" : "VENDOR",
        deliveryDate: po.deliveryDate,
        actualReceiptDate,
        poType: po.poType,
        currencyCode: po.currencyCode,
        totalAmount: round(po.totalAmount),
        lineCount,
        receivedLineCount,
        receiptCoveragePercent,
        leadTimeDays,
        onTimeStatus: onTime == null ? "OPEN" : onTime ? "ON TIME" : "LATE",
        grCount: po.goodsReceipts.length,
        status: po.status,
      };
    });

    let items = mapped;
    if (view === "supplier" || view === "performance") {
      const groups = new Map();
      for (const row of mapped) {
        const key = `${row.partnerType}:${row.partnerCode || row.partnerName}`;
        const current = groups.get(key) || {
          partnerCode: row.partnerCode,
          partnerName: row.partnerName,
          partnerType: row.partnerType,
          poCount: 0,
          totalSpend: 0,
          completedPoCount: 0,
          latePoCount: 0,
          receiptCoverageTotal: 0,
          leadTimeTotal: 0,
        };
        current.poCount += 1;
        current.totalSpend += number(row.totalAmount);
        current.completedPoCount += row.status === "Completed" ? 1 : 0;
        current.latePoCount += row.onTimeStatus === "LATE" ? 1 : 0;
        current.receiptCoverageTotal += number(row.receiptCoveragePercent);
        current.leadTimeTotal += number(row.leadTimeDays);
        groups.set(key, current);
      }
      items = [...groups.values()].map((row) => ({
        partnerCode: row.partnerCode,
        partnerName: row.partnerName,
        partnerType: row.partnerType,
        poCount: row.poCount,
        totalSpend: round(row.totalSpend),
        completedPoCount: row.completedPoCount,
        openPoCount: row.poCount - row.completedPoCount,
        latePoCount: row.latePoCount,
        receiptCoveragePercent: row.poCount ? round(row.receiptCoverageTotal / row.poCount, 1) : 0,
        averageLeadTimeDays: row.poCount ? round(row.leadTimeTotal / row.poCount, 1) : 0,
        performanceStatus: row.latePoCount > 0 ? "ATTENTION" : row.completedPoCount === row.poCount ? "COMPLETE" : "OPEN",
      }));
    }

    const total = items.length;
    const paged = items.slice((page - 1) * limit, page * limit);
    const totalSpend = mapped.reduce((sum, row) => sum + number(row.totalAmount), 0);
    const completed = mapped.filter((row) => row.status === "Completed").length;
    const late = mapped.filter((row) => row.onTimeStatus === "LATE").length;
    const averageCoverage = mapped.length
      ? mapped.reduce((sum, row) => sum + number(row.receiptCoveragePercent), 0) / mapped.length
      : 0;
    res.json({
      items: paged,
      total,
      page,
      limit,
      view,
      summary: {
        totalPurchaseOrders: mapped.length,
        totalSpend: round(totalSpend),
        completedPurchaseOrders: completed,
        openPurchaseOrders: mapped.length - completed,
        latePurchaseOrders: late,
        receiptCoveragePercent: round(averageCoverage, 1),
      },
      chart: view === "supplier" || view === "performance"
        ? {
            labels: items.slice(0, 10).map((row) => row.partnerName),
            series: items.slice(0, 10).map((row) => row.totalSpend),
          }
        : {
            labels: ["Completed", "Open", "Late"],
            series: [completed, Math.max(mapped.length - completed, 0), late],
          },
    });
  } catch (error) {
    next(error);
  }
};
