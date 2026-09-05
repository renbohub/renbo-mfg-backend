const {
  legacyPriceValue,
  resolveEffectiveRecord,
} = require("./pricing/effectivePriceService");
const { resolveVendorProcessPrice } = require("./pricing/vendorProcessPricingService");
const { isCustomerSupplied } = require("../utils/materialSupply");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const priceValue = (record, costingDate) => legacyPriceValue(record, costingDate);

const emptyEstimate = () => ({
  total: 0,
  material: 0,
  rawMaterial: 0,
  purchase: 0,
  process: 0,
  vendor: 0,
  lines: 0,
  covered: 0,
});

const addScaled = (target, source, factor) => {
  target.total += source.total * factor;
  target.material += source.material * factor;
  target.rawMaterial += source.rawMaterial * factor;
  target.purchase += source.purchase * factor;
  target.process += source.process * factor;
  target.vendor += source.vendor * factor;
  target.lines += source.lines;
  target.covered += source.covered;
};

const COSTING_HEADER_SELECT = {
  id: true,
  noReg: true,
  partId: true,
  revision: true,
  updatedAt: true,
  details: {
    where: { isDeleted: false },
    select: {
      id: true,
      parentDetailId: true,
      partId: true,
      supplierId: true,
      materialSupplyType: true,
      vendorId: true,
      category: true,
      qty: true,
      grossWeight: true,
      uomCode: true,
      materialFormId: true,
      materialScheme: true,
      alternateMaterialFormId: true,
      part: {
        select: {
          id: true,
          itemType: true,
          rawType: true,
          materialId: true,
          material: {
            select: {
              materialGradeId: true,
              materialSubstanceId: true,
              thickness: true,
            },
          },
        },
      },
      materialForm: { select: { symbol: true } },
      alternateMaterialForm: { select: { symbol: true } },
      mbomProcesses: {
        where: { isDeleted: false },
        select: {
          id: true,
          routingMode: true,
          vendorId: true,
          cycleTime: true,
          process: { select: { processCode: true, processName: true } },
          machine: {
            select: {
              id: true,
              costingRate: true,
              costingRateType: true,
              currencyCode: true,
            },
          },
        },
      },
    },
  },
};

async function calculateLiveMbomCosts(prisma, options = {}) {
  const requestedDate = options.costingDate
    ? new Date(options.costingDate)
    : new Date();
  const costingDate = Number.isNaN(requestedDate.getTime())
    ? new Date()
    : requestedDate;

  const [headers, partPrices, materialPrices, vendorPrices, machineCostRates, currencies] =
    await Promise.all([
      prisma.mBOMHeader.findMany({
        where: { isDeleted: false },
        select: COSTING_HEADER_SELECT,
        orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
      }),
      prisma.partPriceList.findMany({ where: { isDeleted: false } }),
      prisma.materialPriceList.findMany({ where: { isDeleted: false } }),
      prisma.vendorPriceList.findMany({
        where: { isDeleted: false },
        include: { details: { where: { isDeleted: false }, include: { vendorProcess: true } } },
      }),
      prisma.machineCostRate.findMany({ where: { isDeleted: false } }),
      prisma.currency.findMany({
        where: { isDeleted: false },
        select: { currencyCode: true, exchangeRate: true },
      }),
    ]);

  const currencyRates = new Map(
    currencies.map((currency) => [
      currency.currencyCode,
      number(currency.exchangeRate) || 1,
    ]),
  );
  const toIdr = (value, currencyCode) =>
    number(value) *
    (!currencyCode || currencyCode === "IDR"
      ? 1
      : currencyRates.get(currencyCode) || 1);

  const headersByPart = new Map();
  headers.forEach((header) => {
    if (!header.partId) return;
    const records = headersByPart.get(header.partId) || [];
    records.push(header);
    headersByPart.set(header.partId, records);
  });

  const linkedBom = (row, currentHeader) =>
    (headersByPart.get(row.partId) || []).find(
      (candidate) => candidate.id !== currentHeader.id,
    ) || null;

  const selectedMaterialSymbol = (row) =>
    row.materialScheme === "ALTERNATIVE"
      ? row.alternateMaterialForm?.symbol
      : row.materialForm?.symbol;

  const directPrice = (row) => {
    if (isCustomerSupplied(row.materialSupplyType)) {
      return { value: 0, found: true, kind: "material", customerSupplied: true };
    }
    const partPrice = resolveEffectiveRecord(
      partPrices.filter((item) => item.partId === row.partId && (!row.supplierId || item.supplierId === row.supplierId)),
      costingDate,
    );
    const partValue = priceValue(partPrice, costingDate);
    if (partValue > 0) {
      return {
        value: toIdr(partValue, partPrice.currencyCode),
        found: true,
        kind: "purchase",
      };
    }

    const material = row.part?.material || {};
    const formSymbol = selectedMaterialSymbol(row);
    const candidates = materialPrices.filter((item) => {
      if (row.supplierId && item.supplierId !== row.supplierId) return false;
      if (item.materialId) return item.materialId === row.part?.materialId;
      return (
        item.materialGradeId === material.materialGradeId &&
        item.materialSubstanceId === material.materialSubstanceId &&
        number(item.thickness) === number(material.thickness) &&
        (!item.CSP || item.CSP === formSymbol)
      );
    });
    const materialPrice = resolveEffectiveRecord(candidates, costingDate);
    const materialValue = priceValue(materialPrice, costingDate);
    if (materialValue > 0) {
      return {
        value: toIdr(materialValue, materialPrice.currencyCode),
        found: true,
        kind: "material",
      };
    }

    return { value: 0, found: false, kind: "purchase" };
  };

  const processEstimate = (row) =>
    (row.mbomProcesses || []).reduce(
      (result, process) => {
        if (String(process.routingMode || "INHOUSE").toUpperCase() === "VENDOR") {
          const resolved = resolveVendorProcessPrice({
            vendorPrices,
            vendorId: process.vendorId,
            partId: row.partId,
            process: process.process,
            costingDate,
            currencyRates,
          });
          const value = number(resolved?.unitPrice);
          result.value += value;
          result.vendor += value;
          result.lines += 1;
          if (resolved?.found) result.covered += 1;
          return result;
        }
        const seconds = number(process.cycleTime);
        const machine = process.machine || {};
        const effectiveRate = resolveEffectiveRecord(
          machineCostRates.filter((item) => item.machineId === machine.id),
          costingDate,
        );
        const rate = toIdr(effectiveRate?.unitPrice ?? machine.costingRate, effectiveRate?.currencyCode || machine.currencyCode);
        const rateType = String(
          effectiveRate?.costingRateType || machine.costingRateType || "PER_HOUR",
        ).toUpperCase();
        let costPerSecond = 0;
        if (rate > 0) {
          if (rateType === "PER_SECOND") costPerSecond = rate;
          else if (rateType === "PER_MINUTE") costPerSecond = rate / 60;
          else if (rateType === "PER_CYCLE") {
            costPerSecond = seconds > 0 ? rate / seconds : 0;
          } else costPerSecond = rate / 3600;
        }
        const found = seconds > 0 && costPerSecond > 0;
        result.value += found ? costPerSecond * seconds : 0;
        result.lines += 1;
        if (found) result.covered += 1;
        return result;
      },
      { value: 0, vendor: 0, lines: 0, covered: 0 },
    );

  const memo = new Map();
  const estimateHeader = (header, stack = new Set()) => {
    if (!header || stack.has(header.id)) return emptyEstimate();
    if (memo.has(header.id)) return memo.get(header.id);

    const nextStack = new Set(stack).add(header.id);
    const rowsByParent = new Map();
    const rowIds = new Set(header.details.map((row) => row.id));
    header.details.forEach((row) => {
      const parentId =
        row.parentDetailId && rowIds.has(row.parentDetailId)
          ? row.parentDetailId
          : null;
      const rows = rowsByParent.get(parentId) || [];
      rows.push(row);
      rowsByParent.set(parentId, rows);
    });

    const estimateNode = (row) => {
      const result = emptyEstimate();
      const qty = Math.max(0, number(row.qty));
      const routing = processEstimate(row);
      result.process += routing.value * qty;
      result.vendor += routing.vendor * qty;
      result.total += routing.value * qty;
      result.lines += routing.lines;
      result.covered += routing.covered;

      const childHeader = linkedBom(row, header);
      if (childHeader) {
        addScaled(result, estimateHeader(childHeader, nextStack), qty);
      } else if (
        row.category === "Purchase" ||
        row.part?.itemType === "RAW"
      ) {
        const price = directPrice(row);
        const pricedQty =
          price.kind === "material" && number(row.grossWeight) > 0
            ? qty * number(row.grossWeight)
            : qty;
        const amount = price.value * pricedQty;
        result.total += amount;
        result.material += amount;
        if (price.kind === "material") result.rawMaterial += amount;
        else result.purchase += amount;
        result.lines += 1;
        if (price.found) result.covered += 1;
      }

      (rowsByParent.get(row.id) || []).forEach((childRow) => {
        addScaled(result, estimateNode(childRow), qty);
      });
      return result;
    };

    const estimate = emptyEstimate();
    (rowsByParent.get(null) || []).forEach((root) => {
      addScaled(estimate, estimateNode(root), 1);
    });
    memo.set(header.id, estimate);
    return estimate;
  };

  return new Map(
    headers.map((header) => {
      const estimate = estimateHeader(header);
      return [
        header.id,
        {
          currencyCode: "IDR",
          materialCost: estimate.material,
          rawMaterialCost: estimate.rawMaterial,
          purchasePartCost: estimate.purchase,
          vendorCost: estimate.vendor,
          processCost: estimate.process,
          overheadCost: 0,
          totalCost: estimate.total,
          costPerUnit: estimate.total,
          lines: estimate.lines,
          covered: estimate.covered,
          status:
            estimate.lines === 0
              ? "NOT COSTED"
              : estimate.covered === estimate.lines
                ? "LIVE ESTIMATE"
                : "PARTIAL ESTIMATE",
        },
      ];
    }),
  );
}

module.exports = { calculateLiveMbomCosts };
