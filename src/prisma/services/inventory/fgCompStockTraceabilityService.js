const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 3) => Number(number(value).toFixed(digits));
const normalizeUomCode = (value) => String(value || "unit").trim().toLowerCase();

function activeHeaderWhere(asOf) {
  return {
    isDeleted: false,
    partId: { not: null },
    AND: [
      { OR: [{ effectiveDate: null }, { effectiveDate: { lte: asOf } }] },
      { OR: [{ expiryDate: null }, { expiryDate: { gte: asOf } }] },
    ],
  };
}

function stockSummary(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const uomCode = normalizeUomCode(row.uomCode);
    const current = grouped.get(uomCode) || { uomCode, qtyOnHand: 0, qtyReserved: 0, qtyQC: 0, qtyAvailable: 0 };
    current.qtyOnHand += number(row.qtyOnHand);
    current.qtyReserved += number(row.qtyReserved);
    current.qtyQC += number(row.qtyQC);
    current.qtyAvailable += number(row.qtyAvailable);
    grouped.set(uomCode, current);
  }
  const byUom = [...grouped.values()]
    .map((row) => ({ ...row, qtyOnHand: round(row.qtyOnHand), qtyReserved: round(row.qtyReserved), qtyQC: round(row.qtyQC), qtyAvailable: round(row.qtyAvailable) }))
    .sort((left, right) => left.uomCode.localeCompare(right.uomCode));
  return {
    qtyOnHand: round(byUom.reduce((sum, row) => sum + row.qtyOnHand, 0)),
    qtyReserved: round(byUom.reduce((sum, row) => sum + row.qtyReserved, 0)),
    qtyQC: round(byUom.reduce((sum, row) => sum + row.qtyQC, 0)),
    qtyAvailable: round(byUom.reduce((sum, row) => sum + row.qtyAvailable, 0)),
    byUom,
  };
}

function mergeBreakdowns(rows, field) {
  const grouped = new Map();
  for (const row of rows) {
    for (const stock of row[field]?.byUom || []) {
      const uomCode = normalizeUomCode(stock.uomCode);
      const current = grouped.get(uomCode) || { uomCode, qtyOnHand: 0, qtyReserved: 0, qtyQC: 0, qtyAvailable: 0 };
      current.qtyOnHand += number(stock.qtyOnHand);
      current.qtyReserved += number(stock.qtyReserved);
      current.qtyQC += number(stock.qtyQC);
      current.qtyAvailable += number(stock.qtyAvailable);
      grouped.set(uomCode, current);
    }
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    qtyOnHand: round(row.qtyOnHand),
    qtyReserved: round(row.qtyReserved),
    qtyQC: round(row.qtyQC),
    qtyAvailable: round(row.qtyAvailable),
  })).sort((left, right) => left.uomCode.localeCompare(right.uomCode));
}

function lineCategory(part) {
  if (part?.itemType === "WIP") return "WIP";
  if (part?.itemType === "FG") return "COMPONENT_FG";
  if (part?.itemType === "RAW" && part?.rawType === "MATERIAL") return "MATERIAL";
  if (part?.itemType === "RAW") return "PURCHASE_PART";
  return "OTHER";
}

function requirementFactor(detail, detailById, memo = new Map()) {
  if (memo.has(detail.id)) return memo.get(detail.id);
  const parent = detail.parentDetailId ? detailById.get(detail.parentDetailId) : null;
  const factor = Math.max(number(detail.qty), 0) * (parent ? requirementFactor(parent, detailById, memo) : 1);
  memo.set(detail.id, factor);
  return factor;
}

function addTraceLine(lines, detail, header, multiplier, detailById, memo, depth) {
  const part = detail.part;
  if (!part?.id || !part.partCode) return null;
  const category = lineCategory(part);
  const materialIdentity = category === "MATERIAL" && part.materialId ? part.materialId : null;
  const key = materialIdentity ? `${category}:MATERIAL:${materialIdentity}` : `${category}:PART:${part.id}`;
  const parent = detail.parentDetailId ? detailById.get(detail.parentDetailId) : null;
  const parentFactor = parent ? requirementFactor(parent, detailById, memo) : 1;
  const detailFactor = requirementFactor(detail, detailById, memo);
  const usesGrossWeight = category === "MATERIAL" && number(detail.grossWeight) > 0;
  const requiredPerFg = multiplier * (usesGrossWeight ? parentFactor * number(detail.grossWeight) : detailFactor);
  const existing = lines.get(key) || {
    key,
    category,
    partId: part.id,
    partCode: part.partCode,
    partNumber: part.partNumber || null,
    partName: part.partName || null,
    materialId: part.materialId || null,
    materialCode: part.material?.materialCode || null,
    materialName: part.material?.materialName || null,
    requiredPerFg: 0,
    requirementUomCode: usesGrossWeight ? "kg" : detail.uomCode || part.stockUomCode || "unit",
    minimumLevel: number(detail.levelComponent),
    traceDepth: depth,
    sourceBoms: new Set(),
    sourcePartCodes: new Set(),
  };
  existing.requiredPerFg += requiredPerFg;
  existing.minimumLevel = Math.min(existing.minimumLevel, number(detail.levelComponent));
  existing.traceDepth = Math.min(existing.traceDepth, depth);
  existing.sourceBoms.add(header.noReg);
  existing.sourcePartCodes.add(part.partCode);
  lines.set(key, existing);
  return { part, factor: multiplier * detailFactor, category };
}

function collectTraceLines(root, headerByPartId) {
  const lines = new Map();
  const missingBomPartCodes = new Set();
  const walk = (partId, multiplier, path, depth) => {
    const header = headerByPartId.get(partId);
    if (!header) {
      missingBomPartCodes.add(path[path.length - 1]?.partCode || root.partCode);
      return;
    }
    const detailById = new Map(header.details.map((detail) => [detail.id, detail]));
    const memo = new Map();
    for (const detail of header.details) {
      const added = addTraceLine(lines, detail, header, multiplier, detailById, memo, depth);
      if (!added || added.category !== "COMPONENT_FG" || path.some((item) => item.id === added.part.id)) continue;
      walk(added.part.id, added.factor, [...path, { id: added.part.id, partCode: added.part.partCode }], depth + 1);
    }
  };
  walk(root.id, 1, [{ id: root.id, partCode: root.partCode }], 0);
  return { lines, missingBomPartCodes: [...missingBomPartCodes] };
}

function matchingStock(line, stockByPartCode, stockByMaterialId) {
  if (line.category === "MATERIAL" && line.materialId) {
    const materialRows = stockByMaterialId.get(line.materialId) || [];
    if (materialRows.length) return materialRows;
  }
  return stockByPartCode.get(line.partCode) || [];
}

function availableForRequirement(stock, uomCode) {
  const exact = stock.byUom.find((row) => normalizeUomCode(row.uomCode) === normalizeUomCode(uomCode));
  if (exact) return number(exact.qtyAvailable);
  return stock.byUom.length === 1 ? number(stock.byUom[0].qtyAvailable) : 0;
}

async function buildFgCompStockTraceability(prisma, options = {}) {
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const warehouseCode = String(options.warehouseCode || "").trim();
  const search = String(options.q || "").trim().toLowerCase();
  const [roots, headers] = await Promise.all([
    prisma.part.findMany({
      where: { itemType: "FG", partType: "COMP", isDeleted: false },
      select: { id: true, partCode: true, partNumber: true, partName: true, stockUomCode: true },
      orderBy: [{ partCode: "asc" }],
    }),
    prisma.mBOMHeader.findMany({
      where: activeHeaderWhere(asOf),
      orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        noReg: true,
        partId: true,
        revision: true,
        details: {
          where: { isDeleted: false },
          select: {
            id: true,
            parentDetailId: true,
            levelComponent: true,
            qty: true,
            uomCode: true,
            grossWeight: true,
            part: {
              select: {
                id: true,
                partCode: true,
                partNumber: true,
                partName: true,
                itemType: true,
                rawType: true,
                stockUomCode: true,
                materialId: true,
                material: { select: { materialCode: true, materialName: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const headerByPartId = new Map();
  for (const header of headers) if (header.partId && !headerByPartId.has(header.partId)) headerByPartId.set(header.partId, header);
  const traces = roots.map((root) => ({ root, rootHeader: headerByPartId.get(root.id) || null, ...collectTraceLines(root, headerByPartId) }));
  const partCodes = new Set(roots.map((root) => root.partCode));
  const materialIds = new Set();
  for (const trace of traces) {
    for (const line of trace.lines.values()) {
      partCodes.add(line.partCode);
      if (line.materialId) materialIds.add(line.materialId);
    }
  }
  const stockRows = await prisma.stockBalance.findMany({
    where: {
      isDeleted: false,
      ...(warehouseCode ? { warehouseCode } : {}),
      OR: [
        ...(partCodes.size ? [{ partCode: { in: [...partCodes] } }] : []),
        ...(materialIds.size ? [{ materialId: { in: [...materialIds] } }] : []),
      ],
    },
    select: {
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      partCode: true,
      materialId: true,
      materialCode: true,
      stockType: true,
      uomCode: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
    },
  });
  const stockByPartCode = new Map();
  const stockByMaterialId = new Map();
  for (const row of stockRows) {
    if (row.partCode) stockByPartCode.set(row.partCode, [...(stockByPartCode.get(row.partCode) || []), row]);
    if (row.materialId) stockByMaterialId.set(row.materialId, [...(stockByMaterialId.get(row.materialId) || []), row]);
  }

  const items = traces.map((trace) => {
    const traceLines = [...trace.lines.values()].map((line) => {
      const stock = stockSummary(matchingStock(line, stockByPartCode, stockByMaterialId));
      const requirementAvailable = availableForRequirement(stock, line.requirementUomCode);
      return {
        ...line,
        sourceBoms: [...line.sourceBoms].sort(),
        sourcePartCodes: [...line.sourcePartCodes].sort(),
        requiredPerFg: round(line.requiredPerFg, 6),
        stock,
        fgCoverageQty: line.requiredPerFg > 0 ? round(requirementAvailable / line.requiredPerFg) : 0,
      };
    }).sort((left, right) => left.category.localeCompare(right.category) || left.minimumLevel - right.minimumLevel || left.partCode.localeCompare(right.partCode));
    const fgStock = stockSummary(stockByPartCode.get(trace.root.partCode) || []);
    const componentFgStock = { byUom: mergeBreakdowns(traceLines.filter((line) => line.category === "COMPONENT_FG"), "stock") };
    const wipStock = { byUom: mergeBreakdowns(traceLines.filter((line) => line.category === "WIP"), "stock") };
    const materialStock = { byUom: mergeBreakdowns(traceLines.filter((line) => ["MATERIAL", "PURCHASE_PART"].includes(line.category)), "stock") };
    const hasAvailable = (stock) => stock.byUom.some((row) => number(row.qtyAvailable) > 0);
    const traceStatus = fgStock.qtyAvailable > 0
      ? "FG READY"
      : hasAvailable(componentFgStock) || hasAvailable(wipStock)
        ? "WIP AVAILABLE"
        : hasAvailable(materialStock)
          ? "MATERIAL AVAILABLE"
          : trace.rootHeader
            ? "NO AVAILABLE STOCK"
            : "MBOM MISSING";
    return {
      fgPartId: trace.root.id,
      fgPartCode: trace.root.partCode,
      fgPartNumber: trace.root.partNumber,
      fgPartName: trace.root.partName,
      fgUomCode: trace.root.stockUomCode || "pcs",
      mbomNoReg: trace.rootHeader?.noReg || null,
      mbomRevision: trace.rootHeader?.revision || null,
      fgStock,
      componentFgStock,
      wipStock,
      materialStock,
      traceStatus,
      traceLineCount: traceLines.length,
      missingBomPartCodes: trace.missingBomPartCodes,
      traceLines,
    };
  }).filter((row) => !search || [
    row.fgPartCode,
    row.fgPartNumber,
    row.fgPartName,
    row.mbomNoReg,
    ...row.traceLines.flatMap((line) => [line.partCode, line.partNumber, line.partName, line.materialCode, line.materialName]),
  ].some((value) => String(value || "").toLowerCase().includes(search)));

  return {
    items,
    total: items.length,
    summary: {
      fgCompTracked: items.length,
      fgCompWithMbom: items.filter((row) => row.mbomNoReg).length,
      fgCompWithReadyFg: items.filter((row) => row.fgStock.qtyAvailable > 0).length,
      fgCompWithWip: items.filter((row) => row.wipStock.byUom.some((stock) => stock.qtyAvailable > 0)).length,
      fgCompWithMaterial: items.filter((row) => row.materialStock.byUom.some((stock) => stock.qtyAvailable > 0)).length,
      readyFgByUom: mergeBreakdowns(items, "fgStock"),
      wipByUom: mergeBreakdowns(items, "wipStock"),
      materialByUom: mergeBreakdowns(items, "materialStock"),
    },
  };
}

module.exports = { buildFgCompStockTraceability, stockSummary };
