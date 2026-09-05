"use strict";

const {
  legacyPriceValue,
  resolveEffectiveRecord,
} = require("./effectivePriceService");

const text = (value) => String(value ?? "").trim().toLowerCase();
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function vendorProcessMatches(detail, process) {
  const detailCode = text(detail?.vendorProcess?.vendorProcessCode);
  const processCode = text(process?.processCode);
  if (detailCode && processCode) return detailCode === processCode;

  const detailName = text(detail?.vendorProcess?.vendorProcessName);
  const processName = text(process?.processName);
  return Boolean(detailName && processName && detailName === processName);
}

function resolveVendorProcessPrice(options = {}) {
  const {
    vendorPrices = [],
    vendorId,
    partId,
    process,
    costingDate = new Date(),
    currencyRates = new Map(),
  } = options;

  if (!vendorId || !process) return null;

  const candidates = vendorPrices.filter((priceList) => (
    priceList.vendorId === vendorId
    && (!priceList.partId || !partId || priceList.partId === partId)
    && (priceList.details || []).some((detail) => vendorProcessMatches(detail, process))
  ));
  const exactPart = partId
    ? resolveEffectiveRecord(candidates.filter((priceList) => priceList.partId === partId), costingDate)
    : null;
  const priceList = exactPart
    || resolveEffectiveRecord(candidates.filter((priceList) => !priceList.partId), costingDate)
    || resolveEffectiveRecord(candidates, costingDate);
  if (!priceList) return null;

  const detail = (priceList.details || []).find((item) => vendorProcessMatches(item, process)) || null;
  if (!detail) return null;

  const originalUnitPrice = legacyPriceValue(detail, costingDate);
  const currencyCode = priceList.currencyCode || "IDR";
  const exchangeRate = currencyCode === "IDR" ? 1 : number(currencyRates.get(currencyCode)) || 1;
  return {
    priceList,
    detail,
    originalUnitPrice,
    unitPrice: originalUnitPrice * exchangeRate,
    currencyCode,
    exchangeRate,
    uomCode: detail.uomCode || priceList.uomCode || "PCS",
    found: originalUnitPrice > 0,
  };
}

module.exports = {
  resolveVendorProcessPrice,
  vendorProcessMatches,
};
