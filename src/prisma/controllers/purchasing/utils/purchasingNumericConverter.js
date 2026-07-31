const { convertNumericFields } = require("../../../utils/numericConverter");

/**
 * Convert numeric fields untuk PR Detail
 * Fields: lineNumber, qty, estimatedPrice, totalAmount
 */
const convertPRDetailNumericFields = (detail) => {
  return convertNumericFields(detail, [
    "lineNumber",
    "qty",
    "estimatedPrice",
    "totalAmount",
  ]);
};

/**
 * Convert numeric fields untuk PO Detail
 * Fields: lineNumber, qty, unitPrice, discount, tax, totalAmount
 */
const convertPODetailNumericFields = (detail) => {
  return convertNumericFields(detail, [
    "lineNumber",
    "qty",
    "purchasePackageQty",
    "conversionFactor",
    "convertedPurchaseQty",
    "unitPrice",
    "discount",
    "tax",
    "totalAmount",
  ]);
};

/**
 * Convert numeric fields untuk GR Detail
 * Fields: lineNumber, qtyReceived, qtyInspected, unitPrice, totalPrice
 */
const convertGRDetailNumericFields = (detail) => {
  return convertNumericFields(detail, [
    "lineNumber",
    "qtyReceived",
    "qtyInspected",
    "unitPrice",
    "totalPrice",
  ]);
};

/**
 * Convert numeric fields untuk Purchase Invoice Detail
 * Fields: lineNumber, qtyInvoiced, unitPrice, discount, tax, totalAmount, varianceAmount
 */
const convertPurchaseInvoiceDetailNumericFields = (detail) => {
  return convertNumericFields(detail, [
    "lineNumber",
    "qtyInvoiced",
    "unitPrice",
    "discount",
    "tax",
    "totalAmount",
    "varianceAmount",
  ]);
};

/**
 * Convert numeric fields untuk Header (PR/PO)
 * Fields: totalAmount
 */
const convertHeaderNumericFields = (header) => {
  return convertNumericFields(header, [
    "subtotalAmount",
    "discountAmount",
    "taxAmount",
    "totalAmount",
  ]);
};

module.exports = {
  convertPRDetailNumericFields,
  convertPODetailNumericFields,
  convertGRDetailNumericFields,
  convertPurchaseInvoiceDetailNumericFields,
  convertHeaderNumericFields,
};
