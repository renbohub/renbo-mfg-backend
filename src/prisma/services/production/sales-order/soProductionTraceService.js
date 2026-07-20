const buildSoLineReferenceNumber = (soNumber, lineNumber) =>
  `${soNumber}#${String(lineNumber)}`;

const toNumber = (value) => Number(value || 0);

function getManufacturingOrderTrace(row = {}) {
  return {
    parentMoNumber: row?.parentMoNumber || null,
    rootMoNumber: row?.rootMoNumber || row?.parentMoNumber || row?.moNumber || null,
  };
}

async function buildSalesOrderProducedQtyMap(db, lineRefs = []) {
  const normalizedLineRefs = [...new Set((lineRefs || []).filter(Boolean))];
  if (normalizedLineRefs.length === 0) return new Map();

  const parsedLineRefs = normalizedLineRefs
    .map((lineRef) => {
      const match = String(lineRef).match(/^(.*)#(\d+)$/);
      if (!match) return null;
      return {
        lineRef,
        soNumber: match[1],
        lineNumber: Number(match[2]),
      };
    })
    .filter(Boolean);

  const soNumbers = [...new Set(parsedLineRefs.map((item) => item.soNumber).filter(Boolean))];
  const lineNumbers = [...new Set(parsedLineRefs.map((item) => item.lineNumber).filter(Number.isFinite))];
  if (soNumbers.length === 0 || lineNumbers.length === 0) return new Map();

  const peggings = await db.mRPPegging.findMany({
    where: {
      demandType: "SO",
      demandNumber: { in: soNumbers },
      demandLineNumber: { in: lineNumbers },
      status: { not: "Closed" },
    },
    select: {
      demandNumber: true,
      demandLineNumber: true,
      supplyType: true,
      supplyNumber: true,
    },
  });

  const peggedPlannedOrderNumbers = [
    ...new Set(
      peggings
        .filter((item) => item.supplyType === "PlannedOrder")
        .map((item) => item.supplyNumber)
        .filter(Boolean),
    ),
  ];
  const peggedMoNumbers = [
    ...new Set(
      peggings
        .filter((item) => item.supplyType === "MO")
        .map((item) => item.supplyNumber)
        .filter(Boolean),
    ),
  ];

  const plannedOrders = await db.plannedOrder.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(peggedPlannedOrderNumbers.length > 0
          ? [{ orderNumber: { in: peggedPlannedOrderNumbers } }]
          : []),
        { referenceType: "SO", referenceNumber: { in: normalizedLineRefs } },
      ],
    },
    select: {
      orderNumber: true,
      referenceType: true,
      referenceNumber: true,
    },
  });

  const plannedOrderNumbers = [...new Set(plannedOrders.map((item) => item.orderNumber).filter(Boolean))];
  if (plannedOrderNumbers.length === 0 && peggedMoNumbers.length === 0) {
    return new Map(normalizedLineRefs.map((lineRef) => [lineRef, 0]));
  }

  const linkedMos = await db.manufacturingOrder.findMany({
    where: {
      isDeleted: false,
      OR: [
        ...(plannedOrderNumbers.length > 0
          ? [{ plannedOrderNumber: { in: plannedOrderNumbers } }]
          : []),
        ...(peggedMoNumbers.length > 0 ? [{ moNumber: { in: peggedMoNumbers } }] : []),
      ],
    },
    select: {
      moNumber: true,
      plannedOrderNumber: true,
      qtyGood: true,
      parentMoNumber: true,
      rootMoNumber: true,
    },
  });

  const rootTokens = [...new Set(
    linkedMos
      .map((row) => getManufacturingOrderTrace(row).rootMoNumber)
      .filter(Boolean),
  )];

  const relatedMos = rootTokens.length > 0
    ? await db.manufacturingOrder.findMany({
        where: {
          isDeleted: false,
          OR: rootTokens.flatMap((rootMoNumber) => ([
            { moNumber: rootMoNumber },
            { rootMoNumber },
            { parentMoNumber: rootMoNumber },
          ])),
        },
        select: {
          moNumber: true,
          plannedOrderNumber: true,
          qtyGood: true,
          parentMoNumber: true,
          rootMoNumber: true,
        },
      })
    : [];

  const allMosByNumber = new Map();
  for (const row of [...linkedMos, ...relatedMos]) {
    if (!row?.moNumber) continue;
    allMosByNumber.set(row.moNumber, row);
  }

  const childMap = new Map();
  for (const row of allMosByNumber.values()) {
    const { parentMoNumber } = getManufacturingOrderTrace(row);
    if (!parentMoNumber) continue;
    const children = childMap.get(parentMoNumber) || [];
    children.push(row);
    childMap.set(parentMoNumber, children);
  }

  const fulfillmentMap = new Map();
  function visit(moNumber, visited = new Set()) {
    if (!moNumber) return { ownGood: 0, childGood: 0, totalGood: 0 };
    if (fulfillmentMap.has(moNumber)) return fulfillmentMap.get(moNumber);
    if (visited.has(moNumber)) return { ownGood: 0, childGood: 0, totalGood: 0 };

    const row = allMosByNumber.get(moNumber);
    const nextVisited = new Set(visited);
    nextVisited.add(moNumber);

    const ownGood = toNumber(row?.qtyGood);
    const childGood = (childMap.get(moNumber) || []).reduce((sum, child) => {
      const childAggregate = visit(child.moNumber, nextVisited);
      return sum + toNumber(childAggregate.totalGood);
    }, 0);

    const aggregate = {
      ownGood,
      childGood,
      totalGood: ownGood + childGood,
    };
    fulfillmentMap.set(moNumber, aggregate);
    return aggregate;
  }

  for (const moNumber of allMosByNumber.keys()) {
    visit(moNumber);
  }

  const plannedOrderToRootMos = new Map();
  for (const row of allMosByNumber.values()) {
    if (!row?.plannedOrderNumber) continue;
    const rootMoNumber = getManufacturingOrderTrace(row).rootMoNumber;
    if (!rootMoNumber) continue;
    const current = plannedOrderToRootMos.get(row.plannedOrderNumber) || new Set();
    current.add(rootMoNumber);
    plannedOrderToRootMos.set(row.plannedOrderNumber, current);
  }

  const lineRefToRootMos = new Map();
  const pushRootMo = (lineRef, rootMoNumber) => {
    if (!lineRef || !rootMoNumber) return;
    const current = lineRefToRootMos.get(lineRef) || new Set();
    current.add(rootMoNumber);
    lineRefToRootMos.set(lineRef, current);
  };

  for (const pegging of peggings) {
    const lineRef = buildSoLineReferenceNumber(pegging.demandNumber, pegging.demandLineNumber);
    if (pegging.supplyType === "MO") {
      const rootMoNumber = getManufacturingOrderTrace(allMosByNumber.get(pegging.supplyNumber)).rootMoNumber;
      pushRootMo(lineRef, rootMoNumber);
      continue;
    }

    if (pegging.supplyType === "PlannedOrder") {
      for (const rootMoNumber of plannedOrderToRootMos.get(pegging.supplyNumber) || []) {
        pushRootMo(lineRef, rootMoNumber);
      }
    }
  }

  for (const plannedOrder of plannedOrders) {
    if (plannedOrder.referenceType !== "SO" || !plannedOrder.referenceNumber) continue;
    for (const rootMoNumber of plannedOrderToRootMos.get(plannedOrder.orderNumber) || []) {
      pushRootMo(plannedOrder.referenceNumber, rootMoNumber);
    }
  }

  const producedQtyMap = new Map();
  for (const lineRef of normalizedLineRefs) {
    const roots = [...(lineRefToRootMos.get(lineRef) || new Set())];
    const qtyProduced = roots.reduce((sum, rootMoNumber) => {
      return sum + toNumber(fulfillmentMap.get(rootMoNumber)?.totalGood);
    }, 0);
    producedQtyMap.set(lineRef, Math.max(0, qtyProduced));
  }

  return producedQtyMap;
}

async function enrichSalesOrderHeadersWithProducedQty(db, headers = []) {
  if (!Array.isArray(headers) || headers.length === 0) return [];

  const lineRefs = [];
  for (const header of headers) {
    for (const detail of Array.isArray(header?.details) ? header.details : []) {
      const lineNumber = Number(detail?.lineNumber);
      if (!header?.soNumber || !Number.isFinite(lineNumber)) continue;
      lineRefs.push(buildSoLineReferenceNumber(header.soNumber, lineNumber));
    }
  }

  const producedQtyMap = await buildSalesOrderProducedQtyMap(db, lineRefs);

  return headers.map((header) => ({
    ...header,
    details: (Array.isArray(header?.details) ? header.details : []).map((detail, index) => {
      const lineNumber = Number(detail?.lineNumber || index + 1);
      const lineRef = buildSoLineReferenceNumber(header.soNumber, lineNumber);
      return {
        ...detail,
        qtyProduced: producedQtyMap.has(lineRef)
          ? producedQtyMap.get(lineRef)
          : toNumber(detail?.qtyProduced),
      };
    }),
  }));
}

async function enrichSalesOrderDetailsWithProducedQty(db, details = []) {
  if (!Array.isArray(details) || details.length === 0) return [];

  const lineRefs = details
    .map((detail) => {
      const soNumber = detail?.soNumber || detail?.soHeader?.soNumber || null;
      const lineNumber = Number(detail?.lineNumber);
      if (!soNumber || !Number.isFinite(lineNumber)) return null;
      return buildSoLineReferenceNumber(soNumber, lineNumber);
    })
    .filter(Boolean);

  const producedQtyMap = await buildSalesOrderProducedQtyMap(db, lineRefs);

  return details.map((detail) => {
    const soNumber = detail?.soNumber || detail?.soHeader?.soNumber || null;
    const lineNumber = Number(detail?.lineNumber);
    const lineRef = soNumber && Number.isFinite(lineNumber)
      ? buildSoLineReferenceNumber(soNumber, lineNumber)
      : null;

    return {
      ...detail,
      qtyProduced: lineRef && producedQtyMap.has(lineRef)
        ? producedQtyMap.get(lineRef)
        : toNumber(detail?.qtyProduced),
    };
  });
}

module.exports = {
  buildSalesOrderProducedQtyMap,
  enrichSalesOrderHeadersWithProducedQty,
  enrichSalesOrderDetailsWithProducedQty,
};
