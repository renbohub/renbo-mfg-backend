"use strict";
const { userHasPermission } = require("../ai/permissionEvaluator");
const resources = { mps: "mps", suggestions: "purchaseOrder", orders: "purchaseOrder", "vendor-plans": "monthlyProductionPlan", "vendor-orders": "vendorProcessOrders", customer: "purchaseRequisition" };
const confirmationResource = (source) => ["suggestions", "orders"].includes(source) ? "purchaseOrder" : "purchaseRequisition";
const readContext = (source) => ({ moduleCode: ["mps", "vendor-plans"].includes(source) ? "planning-ppic" : source === "vendor-orders" ? "production" : "purchasing", pageCode: ({mps:"mps","vendor-plans":"monthly-production-plans","vendor-orders":"vendor-process-orders",suggestions:"purchase-suggestions",orders:"purchase-order",customer:"customer-supplies"})[source] });
function canConfirm(user, source) {
  return Boolean(resources[source]) && userHasPermission(user, { resourceCode: confirmationResource(source), action: "update" }, { moduleCode: "purchasing", pageCode: "eta-monitor" });
}
function canRead(user, source) {
  return Boolean(resources[source]) && (userHasPermission(user, { resourceCode: resources[source], action: "read" }, readContext(source))
    || userHasPermission(user, { resourceCode: confirmationResource(source), action: "read" }, { moduleCode: "purchasing", pageCode: "eta-monitor" }));
}
function authorize(source, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "No user context" });
    if (action === "read" ? canRead(req.user, source) : canConfirm(req.user, source)) return next();
    return res.status(403).json({ message: action === "read" ? "Akun tidak memiliki akses baca ETA." : "Konfirmasi ETA memerlukan akses update Purchasing." });
  };
}
module.exports = { resources, confirmationResource, canConfirm, canRead, authorize };
