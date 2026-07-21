const crypto = require("crypto");
const { prisma } = require("../../index");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");

const number = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

exports.receivePurchaseOrder = async (req, res, next) => {
  try {
    const { poNumber, warehouseCode, details = [], deliveryNoteNumber, notes } = req.body;
    if (!poNumber || !warehouseCode || !details.length) return res.status(400).json({ message: "poNumber, warehouseCode, and details are required" });
    const result = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({ where: { poNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
      if (!po) throw Object.assign(new Error("Purchase Order not found"), { statusCode: 404 });
      const grNumber = number("GR");
      const receiptDetails = details.map((line, index) => {
        const poDetail = po.details.find((item) => item.id === line.poDetailId);
        if (!poDetail || Number(line.qtyReceived) <= 0) throw Object.assign(new Error(`Invalid receipt detail at line ${index + 1}`), { statusCode: 400 });
        if (Number(poDetail.qtyReceived || 0) + Number(line.qtyReceived) > Number(poDetail.qty || 0)) throw Object.assign(new Error(`Receipt quantity exceeds the outstanding PO on line ${index + 1}`), { statusCode: 409 });
        return { lineNumber: index + 1, poDetailId: poDetail.id, qtyOrdered: poDetail.qty, qtyReceived: Number(line.qtyReceived), deliveryNoteNumber: line.deliveryNoteNumber || deliveryNoteNumber || null, lotNumber: line.lotNumber || null, supplierLotNumber: line.supplierLotNumber || null, rackCode: line.rackCode || null, uomCode: poDetail.uomCode, unitPrice: poDetail.unitPrice, totalPrice: Number(line.qtyReceived) * Number(poDetail.unitPrice || 0), notes: line.notes || null };
      });
      const gr = await tx.goodsReceipt.create({ data: { grNumber, poNumber, poType: po.poType, stockType: po.poType, warehouseCode, deliveryNoteNumber: deliveryNoteNumber || null, receivedBy: req.user?.username || req.user?.email || null, receivedDate: new Date(), status: "Received Pending Inspection", notes: notes || null, details: { create: receiptDetails } }, include: { details: true } });
      await Promise.all(receiptDetails.map((detail) => tx.purchaseOrderDetail.update({ where: { id: detail.poDetailId }, data: { qtyReceived: { increment: detail.qtyReceived } } })));
      await tx.purchaseOrder.update({ where: { poNumber }, data: { status: "Partial Receipt" } });
      return gr;
    });
    res.status(201).json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.createInspection = async (req, res, next) => {
  try {
    const gr = await prisma.goodsReceipt.findFirst({ where: { grNumber: req.body.grNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
    if (!gr) return res.status(404).json({ message: "Goods Receipt not found" });
    if (gr.status !== "Received Pending Inspection") return res.status(409).json({ message: "Goods Receipt is not available for a new inspection" });
    const inspection = await prisma.incomingInspection.create({ data: { inspectionNumber: number("IQC"), grNumber: gr.grNumber, inspectedBy: req.user?.username || req.user?.email || null, status: "Open", details: { create: gr.details.map((item, index) => ({ grDetailId: item.id, lineNumber: index + 1, qtyInspected: 0, qtyAccepted: 0, qtyRejected: 0 })) } }, include: { details: true } });
    res.status(201).json(inspection);
  } catch (error) { next(error); }
};

exports.completeInspection = async (req, res, next) => {
  try {
    const { decisions = [] } = req.body;
    const result = await prisma.$transaction(async (tx) => {
      const inspection = await tx.incomingInspection.findFirst({ where: { inspectionNumber: req.params.inspectionNumber, isDeleted: false }, include: { gr: { include: { details: { include: { poDetail: true } } } }, details: true } });
      if (!inspection) throw Object.assign(new Error("Incoming Inspection not found"), { statusCode: 404 });
      if (inspection.status !== "Open") throw Object.assign(new Error("Incoming Inspection has already been completed"), { statusCode: 409 });
      if (decisions.length !== inspection.details.length || new Set(decisions.map((item) => item.grDetailId)).size !== inspection.details.length) throw Object.assign(new Error("A decision is required for every receipt detail"), { statusCode: 400 });
      let acceptedTotal = 0; let rejectedTotal = 0;
      for (const decision of decisions) {
        const line = inspection.details.find((item) => item.grDetailId === decision.grDetailId);
        const grDetail = inspection.gr.details.find((item) => item.id === decision.grDetailId);
        if (!line || !grDetail) throw Object.assign(new Error("Invalid inspection detail"), { statusCode: 400 });
        const accepted = Number(decision.qtyAccepted || 0); const rejected = Number(decision.qtyRejected || 0);
        if (accepted < 0 || rejected < 0 || accepted + rejected > Number(grDetail.qtyReceived)) throw Object.assign(new Error("Inspection quantity is invalid"), { statusCode: 400 });
        acceptedTotal += accepted; rejectedTotal += rejected;
        await tx.incomingInspectionDetail.update({ where: { id: line.id }, data: { qtyInspected: accepted + rejected, qtyAccepted: accepted, qtyRejected: rejected, disposition: rejected > 0 ? (accepted > 0 ? "PARTIAL_ACCEPT" : "REJECT") : "ACCEPT" } });
      }
      const decision = rejectedTotal === 0 ? "Accepted" : acceptedTotal === 0 ? "Rejected" : "Partially Accepted";
      await tx.incomingInspection.update({ where: { id: inspection.id }, data: { status: "Completed", decision, approvedBy: req.user?.username || req.user?.email || null, approvedAt: new Date() } });
      await tx.goodsReceipt.update({ where: { grNumber: inspection.grNumber }, data: { status: acceptedTotal > 0 ? "Partially Inspected" : "Completed" } });
      return { inspectionNumber: inspection.inspectionNumber, decision, acceptedTotal, rejectedTotal };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.putawayAccepted = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const inspection = await tx.incomingInspection.findFirst({ where: { inspectionNumber: req.params.inspectionNumber, status: "Completed", isDeleted: false }, include: { gr: { include: { details: { include: { poDetail: true, incomingInspectionDetails: true } } } } } });
      if (!inspection) throw Object.assign(new Error("Completed Incoming Inspection not found"), { statusCode: 404 });
      // A completed GR is terminal for quality release.  Keeping this guard at
      // the transaction boundary prevents a retried client request from posting
      // the same accepted quantity into available inventory twice.
      if (inspection.gr.status === "Completed") throw Object.assign(new Error("Accepted quantity has already been put away"), { statusCode: 409 });
      const movements = [];
      for (const detail of inspection.gr.details) {
        const accepted = detail.incomingInspectionDetails.reduce((sum, item) => sum + Number(item.qtyAccepted || 0), 0);
        if (accepted <= 0 || !detail.poDetail.partCode) continue;
        const identity = { warehouseCode: inspection.gr.warehouseCode, rackCode: detail.rackCode || null, lotNumber: detail.lotNumber || null, partCode: detail.poDetail.partCode, productId: null, description: null, spec: detail.poDetail.spec || null, thickness: detail.poDetail.thickness || null, width: detail.poDetail.width || null, CSP: detail.poDetail.CSP || null, partNumber: detail.poDetail.partNumber || null, uomCode: detail.uomCode || null, isDeleted: false };
        const balance = await tx.stockBalance.findFirst({ where: identity }); const before = Number(balance?.qtyOnHand || 0); const after = before + accepted;
        const movementNumber = await generateMovementNumber("IN", tx);
        await tx.stockMovement.create({ data: { movementNumber, movementType: "IN", direction: "IN", transactionType: "QUALITY_RELEASE", warehouseCode: identity.warehouseCode, rackCode: identity.rackCode, lotNumber: identity.lotNumber, partCode: identity.partCode, partNumber: detail.poDetail.partNumber || null, partName: detail.poDetail.partName || null, spec: identity.spec, thickness: identity.thickness, width: identity.width, CSP: identity.CSP, stockType: inspection.gr.stockType, qty: accepted, deltaQty: accepted, qtyBefore: before, qtyAfter: after, uomCode: identity.uomCode, qualityBucket: "AVAILABLE", referenceType: "INCOMING_INSPECTION", referenceNumber: inspection.inspectionNumber, performedBy: req.user?.username || req.user?.email || null } });
        if (balance) await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: after, qtyAvailable: after - Number(balance.qtyReserved || 0) - Number(balance.qtyQC || 0), lastMovement: new Date() } });
        else await tx.stockBalance.create({ data: { ...identity, isDeleted: false, partName: detail.poDetail.partName || null, stockType: inspection.gr.stockType, qtyOnHand: accepted, qtyAvailable: accepted, qtyQC: 0, lastMovement: new Date() } });
        movements.push(movementNumber);
      }
      await tx.goodsReceipt.update({ where: { grNumber: inspection.grNumber }, data: { status: "Completed" } });
      return { inspectionNumber: inspection.inspectionNumber, movements };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
