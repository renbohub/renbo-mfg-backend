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

function scaleStockSummary(stock, share) {
  const safeShare = Math.max(0, Math.min(1, number(share)));
  const byUom = (stock?.byUom || []).map((row) => ({
    ...row,
    qtyOnHand: round(number(row.qtyOnHand) * safeShare, 6),
    qtyReserved: round(number(row.qtyReserved) * safeShare, 6),
    qtyQC: round(number(row.qtyQC) * safeShare, 6),
    qtyAvailable: round(number(row.qtyAvailable) * safeShare, 6),
  }));
  return {
    qtyOnHand: round(byUom.reduce((sum, row) => sum + row.qtyOnHand, 0), 6),
    qtyReserved: round(byUom.reduce((sum, row) => sum + row.qtyReserved, 0), 6),
    qtyQC: round(byUom.reduce((sum, row) => sum + row.qtyQC, 0), 6),
    qtyAvailable: round(byUom.reduce((sum, row) => sum + row.qtyAvailable, 0), 6),
    byUom,
  };
}

function materialPieceSourcePartCode(notes) {
  return String(notes || "").match(/\[PCS_TO_KG\]\s*([^|\r\n]+)/i)?.[1]?.trim() || null;
}

function buildMaterialPieceAttribution(movements = []) {
  const byMaterial = new Map();
  for (const movement of movements) {
    const materialId = movement.materialId;
    const sourcePartCode = materialPieceSourcePartCode(movement.notes);
    if (!materialId || !sourcePartCode) continue;
    const deltaQty = Number.isFinite(Number(movement.deltaQty))
      ? Number(movement.deltaQty)
      : (String(movement.direction || "IN").toUpperCase() === "OUT" ? -1 : 1) * number(movement.qty);
    const current = byMaterial.get(materialId) || { totalKg: 0, byPartCode: new Map() };
    current.totalKg += deltaQty;
    current.byPartCode.set(sourcePartCode, number(current.byPartCode.get(sourcePartCode)) + deltaQty);
    byMaterial.set(materialId, current);
  }
  return byMaterial;
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
  // Keep one row per BOM part even when several parts consume the same material.
  // Their gross weight can differ, so merging only by material would produce an
  // incorrect KG-to-PCS conversion and hide the actual BOM part code.
  const key = materialIdentity ? `${category}:MATERIAL:${materialIdentity}:PART:${part.id}` : `${category}:PART:${part.id}`;
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
    materialType: part.material?.materialType || null,
    materialSpec: [
      part.material?.materialGrade || part.material?.materialName || String(part.material?.materialCode || "").split("-PO")[0] || null,
      part.material?.thickness != null ? `${part.material.thickness} mm` : null,
      part.material?.width != null ? `${part.material.width} mm` : null,
      part.material?.materialForm,
    ].filter(Boolean).join(" x ") || part.material?.spec || null,
    grossWeightPerPieceKg: usesGrossWeight ? number(detail.grossWeight) : 0,
    requiredPerFg: 0,
    requirementUomCode: usesGrossWeight ? "kg" : detail.uomCode || part.stockUomCode || "unit",
    minimumLevel: number(detail.levelComponent),
    traceDepth: depth,
    sourceBoms: new Set(),
    sourcePartCodes: new Set(),
    processes: new Map(),
  };
  existing.requiredPerFg += requiredPerFg;
  existing.minimumLevel = Math.min(existing.minimumLevel, number(detail.levelComponent));
  existing.traceDepth = Math.min(existing.traceDepth, depth);
  existing.sourceBoms.add(header.noReg);
  existing.sourcePartCodes.add(part.partCode);
  for (const route of detail.mbomProcesses || []) {
    const process = route.process;
    const processCode = process?.processCode || null;
    const processName = process?.processName || null;
    const processKey = `${number(route.sequence)}:${processCode || route.id}`;
    existing.processes.set(processKey, {
      processCode,
      processName,
      sequence: number(route.sequence),
      routingMode: route.routingMode || "INHOUSE",
    });
  }
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
      // Inventory matrix must be usable for every finished good. Child FG
      // components are still exploded recursively, while ordinary/non-COMP FG
      // can now be selected as the report root as well.
      where: { itemType: "FG", isDeleted: false },
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
                material: {
                  select: {
                    materialCode: true,
                    materialName: true,
                    materialType: true,
                    materialGrade: true,
                    materialForm: true,
                    spec: true,
                    thickness: true,
                    width: true,
                  },
                },
              },
            },
            mbomProcesses: {
              where: { isDeleted: false },
              orderBy: [{ sequence: "asc" }],
              select: {
                id: true,
                sequence: true,
                routingMode: true,
                process: { select: { processCode: true, processName: true } },
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
  const [stockRows, materialPieceMovements, receiptAllocations, purchaseSuggestionAllocations] = await Promise.all([
    prisma.stockBalance.findMany({
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
    }),
    materialIds.size ? prisma.stockMovement.findMany({
      where: {
        isDeleted: false,
        materialId: { in: [...materialIds] },
        ...(warehouseCode ? { warehouseCode } : {}),
        OR: [
          { referenceType: "MATERIAL_PCS_CONVERSION" },
          { transactionType: "MANUAL_MATERIAL_CONVERSION" },
          { notes: { startsWith: "[PCS_TO_KG]" } },
        ],
      },
      select: { materialId: true, direction: true, qty: true, deltaQty: true, notes: true },
    }) : [],
    prisma.goodsReceiptAllocation?.findMany ? prisma.goodsReceiptAllocation.findMany({
      where: {
        isDeleted: false,
        grDetail: {
          isDeleted: false,
          gr: { isDeleted: false, status: { not: "Cancelled" } },
          poDetail: {
            isDeleted: false,
            OR: [
              ...(partCodes.size ? [{ partCode: { in: [...partCodes] } }] : []),
              ...(materialIds.size ? [{ materialId: { in: [...materialIds] } }] : []),
            ],
          },
        },
      },
      select: {
        allocationType: true,
        partCode: true,
        fgPartCode: true,
        allocatedQty: true,
        uomCode: true,
        plannedOrderNumber: true,
        grDetail: { select: { poDetail: { select: { partCode: true, materialId: true, uomCode: true } } } },
      },
    }) : [],
    prisma.purchaseSuggestionItem?.findMany ? prisma.purchaseSuggestionItem.findMany({
      where: {
        isDeleted: false,
        status: { not: "Cancelled" },
        suggestion: { isDeleted: false, status: { not: "Cancelled" } },
        OR: [
          ...(partCodes.size ? [{ partCode: { in: [...partCodes] } }] : []),
          ...(materialIds.size ? [{ materialId: { in: [...materialIds] } }] : []),
        ],
      },
      select: { partCode: true, materialId: true, uomCode: true, sourceRequirements: true },
    }) : [],
  ]);
  const stockByPartCode = new Map();
  const stockByMaterialId = new Map();
  for (const row of stockRows) {
    if (row.partCode) stockByPartCode.set(row.partCode, [...(stockByPartCode.get(row.partCode) || []), row]);
    if (row.materialId) stockByMaterialId.set(row.materialId, [...(stockByMaterialId.get(row.materialId) || []), row]);
  }
  const materialPieceAttribution = buildMaterialPieceAttribution(materialPieceMovements);
  const allocationSummaryForLine = (line, rootPartCode, attributionShare) => {
    const basePartCode = String(line.partCode || "").replace(/-\d{3}$/, "-000");
    const matching = receiptAllocations.filter((allocation) => {
      const poDetail = allocation.grDetail?.poDetail;
      const sameSupply = line.materialId
        ? String(poDetail?.materialId || "") === String(line.materialId)
        : [line.partCode, basePartCode].includes(poDetail?.partCode);
      if (!sameSupply) return false;
      const target = String(allocation.fgPartCode || allocation.partCode || "");
      return !target || target === rootPartCode || target === line.partCode || target === basePartCode;
    });
    const byUom = new Map();
    for (const allocation of matching) {
      const uomCode = String(allocation.uomCode || allocation.grDetail?.poDetail?.uomCode || line.requirementUomCode || "unit").toLowerCase();
      const share = line.materialId && String(allocation.fgPartCode || allocation.partCode || "") === rootPartCode
        ? (attributionShare ?? 1)
        : 1;
      byUom.set(uomCode, round(number(byUom.get(uomCode)) + number(allocation.allocatedQty) * share, 6));
    }
    return {
      basis: "GOODS_RECEIPT_DEMAND_ALLOCATION",
      byUom: [...byUom.entries()].map(([uomCode, qty]) => ({ uomCode, qty })),
      totalAllocations: matching.length,
    };
  };
  const plannedAllocationSummaryForLine = (line, rootPartCode, attributionShare) => {
    const basePartCode = String(line.partCode || "").replace(/-\d{3}$/, "-000");
    const byUom = new Map();
    let totalAllocations = 0;
    for (const item of purchaseSuggestionAllocations) {
      const sameSupply = line.materialId
        ? String(item.materialId || "") === String(line.materialId)
        : [line.partCode, basePartCode].includes(item.partCode);
      if (!sameSupply) continue;
      for (const source of Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []) {
        const target = String(source.fgPartCode || source.partCode || "");
        if (target && ![rootPartCode, line.partCode, basePartCode].includes(target)) continue;
        const reservedAllocationQty = Math.max(number(source.reservedAllocationQty), 0);
        if (!reservedAllocationQty) continue;
        const share = line.materialId && target === rootPartCode ? (attributionShare ?? 1) : 1;
        const uomCode = String(item.uomCode || line.requirementUomCode || "unit").toLowerCase();
        byUom.set(uomCode, round(number(byUom.get(uomCode)) + reservedAllocationQty * share, 6));
        totalAllocations += 1;
      }
    }
    return {
      basis: "PURCHASE_SUGGESTION_RESERVED_ALLOCATION",
      byUom: [...byUom.entries()].map(([uomCode, qty]) => ({ uomCode, qty })),
      totalAllocations,
    };
  };

  const items = traces.map((trace) => {
    const traceLines = [...trace.lines.values()].map((line) => {
      const physicalStock = stockSummary(matchingStock(line, stockByPartCode, stockByMaterialId));
      const attribution = line.category === "MATERIAL" && line.materialId
        ? materialPieceAttribution.get(line.materialId)
        : null;
      const attributedKg = Math.max(0, number(attribution?.byPartCode.get(line.partCode)));
      const attributionShare = attribution && attribution.totalKg > 0
        ? attributedKg / attribution.totalKg
        : null;
      const stock = attributionShare == null ? physicalStock : scaleStockSummary(physicalStock, attributionShare);
      const demandAllocation = allocationSummaryForLine(line, trace.root.partCode, attributionShare);
      const plannedPurchaseAllocation = plannedAllocationSummaryForLine(line, trace.root.partCode, attributionShare);
      const requirementAvailable = availableForRequirement(stock, line.requirementUomCode);
      return {
        ...line,
        sourceBoms: [...line.sourceBoms].sort(),
        sourcePartCodes: [...line.sourcePartCodes].sort(),
        processes: [...line.processes.values()].sort((left, right) => left.sequence - right.sequence || String(left.processCode || "").localeCompare(String(right.processCode || ""))),
        grossWeightPerPieceKg: round(line.grossWeightPerPieceKg, 6),
        requiredPerFg: round(line.requiredPerFg, 6),
        stock,
        demandAllocation,
        plannedPurchaseAllocation,
        stockAttribution: attributionShare == null ? null : {
          method: "MATERIAL_PIECE_CONVERSION_HISTORY",
          sourcePartCode: line.partCode,
          attributedKg: round(attributedKg, 6),
          sharePercent: round(attributionShare * 100, 4),
        },
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

module.exports = {
  buildFgCompStockTraceability,
  stockSummary,
  scaleStockSummary,
  buildMaterialPieceAttribution,
};
