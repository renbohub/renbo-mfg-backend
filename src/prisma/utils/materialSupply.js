"use strict";

const SUPPLIER_PURCHASE = "SUPPLIER_PURCHASE";
const CUSTOMER_SUPPLIED = "CUSTOMER_SUPPLIED";

function normalizeMaterialSupplyType(value) {
  return String(value || "").trim().toUpperCase() === CUSTOMER_SUPPLIED
    ? CUSTOMER_SUPPLIED
    : SUPPLIER_PURCHASE;
}

function isCustomerSupplied(value) {
  return normalizeMaterialSupplyType(value) === CUSTOMER_SUPPLIED;
}

module.exports = {
  SUPPLIER_PURCHASE,
  CUSTOMER_SUPPLIED,
  normalizeMaterialSupplyType,
  isCustomerSupplied,
};
