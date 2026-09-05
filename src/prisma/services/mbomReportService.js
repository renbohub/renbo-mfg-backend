const { calculateLiveMbomCosts } = require("./mbomLiveCostingService");
const { legacyPriceValue, resolveEffectiveRecord } = require("./pricing/effectivePriceService");
const { resolveVendorProcessPrice } = require("./pricing/vendorProcessPricingService");
const { resolveMbomRevision } = require("./planning/mbomRevisionService");
const { isCustomerSupplied } = require("../utils/materialSupply");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? "").trim();

function machineCost(process, rates, costingDate, currencyRates) {
  const machine = process.machine || {};
  const effective = resolveEffectiveRecord(rates.filter((row) => row.machineId === machine.id), costingDate);
  const originalRate = number(effective?.unitPrice ?? machine.costingRate);
  const currencyCode = effective?.currencyCode || machine.currencyCode || "IDR";
  const exchangeRate = currencyCode === "IDR" ? 1 : number(currencyRates.get(currencyCode)) || 1;
  const rate = originalRate * exchangeRate;
  const type = text(effective?.costingRateType || machine.costingRateType || "PER_HOUR").toUpperCase();
  const seconds = number(process.cycleTime);
  const unitCost = type === "PER_SECOND" ? rate * seconds
    : type === "PER_MINUTE" ? rate * seconds / 60
      : type === "PER_CYCLE" ? rate
        : rate * seconds / 3600;
  return { rate, originalRate, currencyCode, exchangeRate, rateType: type, unitCost, source: effective ? "Machine Cost Rate" : rate ? "Machine Master" : "Not Found", effectiveFrom: effective?.effectiveFrom || null };
}

async function buildMbomReport(prisma, noReg, options = {}) {
  const headers = await prisma.mBOMHeader.findMany({
    where: { isDeleted: false },
    include: {
      part: { include: { material: true } }, uom: true,
      details: {
        where: { isDeleted: false }, orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
        include: {
          parentDetail: { include: { part: true } }, uom: true, materialForm: true, alternateMaterialForm: true, supplier: true, supplyCustomer: true, vendor: true,
          part: { include: { material: true } },
          mbomProcesses: { where: { isDeleted: false }, orderBy: { sequence: "asc" }, include: { process: true, machine: true, vendor: true, dies: true } },
        },
      },
    },
  });
  const header = headers.find((row) => row.noReg === noReg || row.id === noReg);
  if (!header) throw Object.assign(new Error("BOM tidak ditemukan."), { statusCode: 404 });
  const costingDate = options.costingDate ? new Date(options.costingDate) : new Date(header.effectiveDate || new Date());
  const date = Number.isNaN(costingDate.getTime()) ? new Date() : costingDate;
  const [partPrices, materialPrices, vendorPrices, machineRates, currencies, liveCostMap] = await Promise.all([
    prisma.partPriceList.findMany({ where: { isDeleted: false }, include: { supplier: true } }),
    prisma.materialPriceList.findMany({ where: { isDeleted: false }, include: { supplier: true, material: true, materialSubstance: true, materialGrade: true } }),
    prisma.vendorPriceList.findMany({ where: { isDeleted: false }, include: { vendor: true, details: { where: { isDeleted: false }, include: { vendorProcess: true } } } }),
    prisma.machineCostRate.findMany({ where: { isDeleted: false } }),
    prisma.currency.findMany({ where: { isDeleted: false }, select: { currencyCode: true, exchangeRate: true } }),
    calculateLiveMbomCosts(prisma, { costingDate: date }),
  ]);
  const currencyRates = new Map(currencies.map((row) => [row.currencyCode, number(row.exchangeRate) || 1]));
  const headersByPart = new Map();
  headers.forEach((row) => {
    if (!row.partId) return;
    const revisions = headersByPart.get(row.partId) || [];
    revisions.push(row);
    headersByPart.set(row.partId, revisions);
  });

  const buildRow = (detail, context) => {
    const part = detail.part || {};
    const material = part.material || {};
    const customerSupplied = isCustomerSupplied(detail.materialSupplyType);
    const partPrice = resolveEffectiveRecord(partPrices.filter((row) => row.partId === part.id && (!detail.supplierId || row.supplierId === detail.supplierId)), date);
    const form = detail.materialScheme === "ALTERNATIVE" ? detail.alternateMaterialForm?.symbol : detail.materialForm?.symbol;
    const materialCandidates = materialPrices.filter((row) => (!detail.supplierId || row.supplierId === detail.supplierId) && (row.materialId ? row.materialId === part.materialId : (
      row.materialGradeId === material.materialGradeId && row.materialSubstanceId === material.materialSubstanceId
      && number(row.thickness) === number(material.thickness) && (!row.CSP || row.CSP === form)
    )));
    const materialPrice = resolveEffectiveRecord(materialCandidates, date);
    const selectedPrice = customerSupplied ? null : partPrice || materialPrice;
    const unitPriceOriginal = legacyPriceValue(selectedPrice, date);
    const priceCurrency = selectedPrice?.currencyCode || "IDR";
    const priceExchangeRate = priceCurrency === "IDR" ? 1 : number(currencyRates.get(priceCurrency)) || 1;
    const unitPrice = unitPriceOriginal * priceExchangeRate;
    const priceSource = customerSupplied ? "Customer Supplied (Zero Value)" : partPrice ? "Purchase Part Price List" : materialPrice ? "Material Price List" : "Not Found";
    const priceQty = materialPrice && number(detail.grossWeight) > 0 ? number(detail.qty) * number(detail.grossWeight) : number(detail.qty);
    const purchaseAmount = unitPrice * priceQty;
    const processes = (detail.mbomProcesses || []).map((process) => {
      if (String(process.routingMode || "INHOUSE").toUpperCase() === "VENDOR") {
        const resolved = resolveVendorProcessPrice({ vendorPrices, vendorId: process.vendorId, partId: part.id, process: process.process, costingDate: date, currencyRates });
        const originalRate = number(resolved?.originalUnitPrice); const currencyCode = resolved?.currencyCode || "IDR"; const exchangeRate = number(resolved?.exchangeRate) || 1;
        return {
          routingNumber: process.routingNumber || process.occurrenceCode || `OP-${String(process.sequence || 0).padStart(3, "0")}`,
          sequence: process.sequence, processCode: process.process?.processCode, processName: process.process?.processName,
          routingMode: "VENDOR", machineCode: null, machineName: null, machineSpecificationCode: null, diesCode: process.dies?.diesCode,
          vendorCode: process.vendor?.vendorCode, vendorName: process.vendor?.vendorName, cycleTimeSeconds: 0,
          rate: originalRate * exchangeRate, originalRate, rateCurrency: currencyCode, exchangeRate, rateType: "PER_PCS",
          processCostPerUnit: number(resolved?.unitPrice), priceSource: resolved?.priceList ? "Vendor Price List" : "Not Found", effectiveFrom: resolved?.priceList?.effectiveFrom || null,
        };
      }
      const costing = machineCost(process, machineRates, date, currencyRates);
      return {
        routingNumber: process.routingNumber || process.occurrenceCode || `OP-${String(process.sequence || 0).padStart(3, "0")}`,
        sequence: process.sequence, processCode: process.process?.processCode, processName: process.process?.processName,
        routingMode: process.routingMode, machineCode: process.machine?.machineCode, machineName: process.machine?.machineName,
        machineSpecificationCode: process.machineSpecificationCode, diesCode: process.dies?.diesCode,
        vendorCode: process.vendor?.vendorCode, vendorName: process.vendor?.vendorName,
        cycleTimeSeconds: number(process.cycleTime), rate: costing.rate, originalRate: costing.originalRate,
        rateCurrency: costing.currencyCode, exchangeRate: costing.exchangeRate, rateType: costing.rateType,
        processCostPerUnit: costing.unitCost, priceSource: costing.source, effectiveFrom: costing.effectiveFrom,
      };
    });
    const processCostPerUnit = processes.reduce((sum, process) => sum + number(process.processCostPerUnit), 0);
    const priceRequired = !customerSupplied && (Boolean(part.materialId) || detail.category === "Purchase");
    return {
      line: context.line, nodeKey: context.nodeKey, parentNodeKey: context.parentNodeKey,
      level: context.level, localLevel: detail.levelComponent, parentPartCode: context.parentPartCode, parentPartNumber: context.parentPartNumber,
      sourceBomNoReg: context.sourceHeader.noReg, sourceBomRevision: context.sourceHeader.revision,
      sourceBomPartCode: context.sourceHeader.part?.partCode, sourceBomPartNumber: context.sourceHeader.part?.partNumber,
      linkedBomNoReg: context.linkedHeader?.noReg || null, linkedBomRevision: context.linkedHeader?.revision || null,
      partCode: part.partCode, partNumber: part.partNumber, partName: part.partName, itemType: part.itemType,
      rawType: part.rawType, category: detail.category, qty: number(detail.qty), cumulativeQty: context.cumulativeQty, uomCode: detail.uomCode,
      materialSupplyType: detail.materialSupplyType || "SUPPLIER_PURCHASE", supplyCustomerCode: detail.supplyCustomer?.customerCode || null, supplyCustomerName: detail.supplyCustomer?.customerName || null,
      scrapPercent: number(detail.scrapFactor), grossWeightKg: number(detail.grossWeight),
      materialCode: material.materialCode, materialName: material.materialName, materialType: material.materialType,
      materialSpec: material.spec, thickness: material.thickness, width: material.width, materialForm: form,
      leadTime: number(detail.leadTime), leadTimeUnit: detail.leadTimeUnit,
      unitPrice, unitPriceOriginal, priceExchangeRate, priceUom: selectedPrice?.uomCode, priceCurrency,
      priceSource, supplierCode: selectedPrice?.supplier?.supplierCode, supplierName: selectedPrice?.supplier?.supplierName,
      priceEffectiveFrom: selectedPrice?.effectiveFrom, priceEffectiveUntil: selectedPrice?.effectiveUntil, priceRequired,
      purchaseAmount, processCostPerUnit, estimatedLineCost: purchaseAmount + processCostPerUnit * number(detail.qty),
      estimatedExtendedCost: unitPrice * (materialPrice && number(detail.grossWeight) > 0 ? context.cumulativeQty * number(detail.grossWeight) : context.cumulativeQty) + processCostPerUnit * context.cumulativeQty,
      processes,
    };
  };

  const rows = [];
  let nodeSequence = 0;
  const expandHeader = (sourceHeader, host = null, baseLevel = 0, quantityFactor = 1, ancestorHeaderIds = new Set()) => {
    if (!sourceHeader || ancestorHeaderIds.has(sourceHeader.id)) return;
    const nextAncestors = new Set(ancestorHeaderIds).add(sourceHeader.id);
    const details = sourceHeader.details || [];
    const nodeKeyByDetail = new Map(details.map((detail) => [detail.id, `BOM-N${String(++nodeSequence).padStart(5, "0")}`]));
    const rowByDetail = new Map();
    details.forEach((detail) => {
      const parentRow = detail.parentDetailId ? rowByDetail.get(detail.parentDetailId) : null;
      const parentNodeKey = parentRow?.nodeKey || host?.nodeKey || "BOM-ROOT";
      const parentPartCode = parentRow?.partCode || host?.partCode || sourceHeader.part?.partCode || null;
      const parentPartNumber = parentRow?.partNumber || host?.partNumber || sourceHeader.part?.partNumber || null;
      const localLevel = Math.max(1, number(detail.levelComponent) || 1);
      const level = parentRow ? parentRow.level + 1 : baseLevel + localLevel;
      const cumulativeQty = (parentRow?.cumulativeQty ?? quantityFactor) * number(detail.qty);
      const revisions = (headersByPart.get(detail.partId) || []).filter((candidate) => !nextAncestors.has(candidate.id));
      const linkedHeader = resolveMbomRevision({ revisions, selectionDate: date }).revision;
      const row = buildRow(detail, {
        line: rows.length + 1, nodeKey: nodeKeyByDetail.get(detail.id), parentNodeKey, level,
        parentPartCode, parentPartNumber, cumulativeQty, sourceHeader, linkedHeader,
      });
      rows.push(row);
      rowByDetail.set(detail.id, row);
      if (linkedHeader) expandHeader(linkedHeader, row, row.level, row.cumulativeQty, nextAncestors);
    });
  };
  expandHeader(header);
  rows.forEach((row, index) => { row.line = index + 1; });
  const liveCost = liveCostMap.get(header.id) || {};
  const priceApplicableLines = rows.filter((row) => row.priceRequired).length;
  const pricedLines = rows.filter((row) => row.priceRequired && row.unitPrice > 0).length;
  return {
    generatedAt: new Date(), costingDate: date,
    header: { noReg: header.noReg, revision: header.revision, effectiveDate: header.effectiveDate, expiryDate: header.expiryDate, uomCode: header.uomCode, notes: header.notes, partCode: header.part?.partCode, partNumber: header.part?.partNumber, partName: header.part?.partName, customerCode: header.part?.customerCode },
    summary: { componentCount: rows.length, directComponentCount: header.details.length, explodedComponentCount: Math.max(0, rows.length - header.details.length), sourceBomCount: new Set(rows.map((row) => row.sourceBomNoReg)).size, maxLevel: Math.max(0, ...rows.map((row) => row.level)), processCount: rows.reduce((sum, row) => sum + row.processes.length, 0), priceApplicableLines, pricedLines, unpricedLines: Math.max(0, priceApplicableLines - pricedLines), priceCoveragePercent: priceApplicableLines ? pricedLines / priceApplicableLines * 100 : 100, materialCost: number(liveCost.materialCost), processCost: number(liveCost.processCost), overheadCost: number(liveCost.overheadCost), totalCost: number(liveCost.totalCost), costPerUnit: number(liveCost.costPerUnit), costingStatus: liveCost.status || "NOT COSTED" },
    rows,
  };
}

module.exports = { buildMbomReport };
