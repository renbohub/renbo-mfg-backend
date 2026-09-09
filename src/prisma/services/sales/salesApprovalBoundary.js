"use strict";
function isSalesOrderApproval(value) {
  return /^(SalesOrderHeader|SalesOrder)$/i.test(String(value?.documentType || "")) ||
    (String(value?.moduleCode || "").toLowerCase() === "sales" && String(value?.pageCode || "").toLowerCase() === "sales-orders");
}
function assertGenericApprovalAllowed(value) {
  if (isSalesOrderApproval(value)) throw Object.assign(new Error("Gunakan workflow pada detail Sales Order agar persetujuan dan konfirmasi stok diproses bersama."), { statusCode: 409 });
}
module.exports = { isSalesOrderApproval, assertGenericApprovalAllowed };
