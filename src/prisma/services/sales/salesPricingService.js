"use strict";

const { calculateLiveMbomCosts } = require("../mbomLiveCostingService");
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const asDate = (value) => { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
const costingCache = new WeakMap();

function liveCosts(prisma, costingDate) {
  const key = (asDate(costingDate) || new Date()).toISOString().slice(0, 10);
  const cached = costingCache.get(prisma);
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.promise;
  const promise = calculateLiveMbomCosts(prisma, { costingDate }).catch((error) => { costingCache.delete(prisma); throw error; });
  costingCache.set(prisma, { key, promise, expiresAt: Date.now() + 5000 });
  return promise;
}

function resolveActiveSalesPrice(input = {}) {
  const effectiveDate = asDate(input.effectiveDate || new Date());
  const matches = (input.prices || []).filter((row) => row.isActive !== false && row.customerCode === input.customerCode && row.partCode === input.partCode && String(row.currencyCode || "IDR") === String(input.currencyCode || "IDR") && (!row.effectiveFrom || asDate(row.effectiveFrom) <= effectiveDate) && (!row.effectiveUntil || asDate(row.effectiveUntil) >= effectiveDate)).sort((a, b) => asDate(b.effectiveFrom || 0) - asDate(a.effectiveFrom || 0));
  const master = matches[0] || null;
  const requested = input.requestedPrice == null ? null : number(input.requestedPrice);
  const isOverride = requested != null && ((master && Math.abs(requested - number(master.unitPrice)) > 0.000001) || (!master && requested > 0));
  if (isOverride) {
    if (!input.canOverride) throw Object.assign(new Error("PRICE_OVERRIDE_NOT_ALLOWED"), { statusCode: 403, code: "PRICE_OVERRIDE_NOT_ALLOWED" });
    if (!String(input.overrideReason || "").trim()) throw Object.assign(new Error("Alasan price override wajib diisi."), { statusCode: 400, code: "PRICE_OVERRIDE_REASON_REQUIRED" });
    return { code: "PRICE_OVERRIDE", unitPrice: requested, priceSourceId: master?.id || null, originalMasterPrice: master ? number(master.unitPrice) : null, overrideReason: String(input.overrideReason).trim() };
  }
  if (!master) return { code: "PRICE_NOT_FOUND", unitPrice: 0, priceSourceId: null, originalMasterPrice: null, warning: "Master price aktif tidak ditemukan." };
  return { code: "MASTER_PRICE", unitPrice: number(master.unitPrice), priceSourceId: master.id || null, originalMasterPrice: number(master.unitPrice), overrideReason: null };
}

function calculateMarginPreview(input = {}) {
  const qty = Math.max(number(input.qty), 0);
  const unitPrice = number(input.unitPrice);
  const materialCost = number(input.materialCost);
  const processCost = number(input.processCost);
  const overheadCost = number(input.overheadCost);
  const estimatedBomCostPerUnit = materialCost + processCost + overheadCost;
  const salesAmount = qty * unitPrice;
  const estimatedTotalCost = qty * estimatedBomCostPerUnit;
  const estimatedGrossContribution = salesAmount - estimatedTotalCost;
  return { salesAmount, estimatedBomMaterialCost: materialCost, estimatedProcessCost: processCost, estimatedOverheadCost: overheadCost, estimatedBomCostPerUnit, estimatedTotalCost, estimatedGrossContribution, estimatedMarginPercent: salesAmount > 0 ? (estimatedGrossContribution / salesAmount) * 100 : 0 };
}

async function resolveSalesLinePreview(prisma, input = {}) {
  const part = await prisma.part.findFirst({ where: { partCode: input.partCode, isDeleted: false }, select: { id: true, partCode: true, mbomHeaders: { where: { isDeleted: false }, orderBy: [{ revision: "desc" }, { updatedAt: "desc" }], take: 1, select: { id: true } } } });
  const prices = part ? await prisma.customerPartPrice.findMany({ where: { customerCode: input.customerCode, partId: part.id, currencyCode: input.currencyCode || "IDR", isActive: true, isDeleted: false } }) : [];
  const price = resolveActiveSalesPrice({ ...input, prices: prices.map((row) => ({ ...row, partCode: input.partCode })) });
  const costs = part ? await liveCosts(prisma, input.effectiveDate) : new Map();
  const cost = costs.get(part?.mbomHeaders?.[0]?.id) || { materialCost: 0, processCost: 0, overheadCost: 0, status: "NOT COSTED" };
  return { price, costStatus: cost.status || "NOT COSTED", margin: calculateMarginPreview({ qty: input.qty, unitPrice: price.unitPrice, ...cost }), mbomHeaderId: part?.mbomHeaders?.[0]?.id || null };
}

module.exports = { resolveActiveSalesPrice, calculateMarginPreview, resolveSalesLinePreview };
