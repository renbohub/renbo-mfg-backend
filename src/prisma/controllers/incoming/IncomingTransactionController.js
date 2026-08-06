const crypto = require("crypto");
const { prisma } = require("../../index");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertQuantity } = require("../../utils/uomQuantity");
const {
  assertStockBalanceNotFrozen,
  assertWarehouseNotFrozen,
} = require("../inventory/utils/stockOpnameFreezeGuard");
const { lockStockBalanceIdentity } = require("../../services/inventory/stockBalanceLockService");

const number = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const REJECT_DISPOSITIONS = new Set(["HOLD", "RETURN_TO_SUPPLIER", "SCRAP"]);
const FINAL_REJECT_DISPOSITIONS = new Set(["RETURN_TO_SUPPLIER", "SCRAP"]);
const normalizeDisposition = (value) => String(value || "").trim().toUpperCase().replace(/[ -]+/g, "_");

exports.receivePurchaseOrder = async (req, res, next) => {
  try {
    const { poNumber, warehouseCode, details = [], deliveryNoteNumber, notes } = req.body;
    if (!poNumber || !warehouseCode || !details.length) return res.status(400).json({ message: "poNumber, warehouseCode, and details are required" });
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_purchase_order" WHERE "po_number" = ${poNumber} FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { poNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
      if (!po) throw Object.assign(new Error("Purchase Order not found"), { statusCode: 404 });
      if (!["Sent", "Confirmed", "Partial Receipt"].includes(po.status)) {
        throw Object.assign(new Error("Purchase Order harus berstatus Sent, Confirmed, atau Partial Receipt sebelum dibuatkan Goods Receipt"), { statusCode: 409 });
      }
      const warehouse = await tx.warehouse.findFirst({ where: { warehouseCode, isDeleted: false, isActive: true }, select: { warehouseCode: true } });
      if (!warehouse) throw Object.assign(new Error("Warehouse penerimaan tidak aktif atau tidak ditemukan"), { statusCode: 400 });
      const requestedRackCodes = [...new Set(details.map((line) => String(line.rackCode || "").trim()).filter(Boolean))];
      const requestedRacks = requestedRackCodes.length
        ? await tx.rack.findMany({
            where: { rackCode: { in: requestedRackCodes }, isDeleted: false, isActive: true },
            select: { rackCode: true, warehouseCode: true },
          })
        : [];
      for (const rackCode of requestedRackCodes) {
        const rack = requestedRacks.find((item) => item.rackCode === rackCode);
        if (!rack) throw Object.assign(new Error(`Rack ${rackCode} tidak aktif atau tidak ditemukan`), { statusCode: 400 });
        if (rack.warehouseCode && rack.warehouseCode !== warehouseCode) {
          throw Object.assign(new Error(`Rack ${rackCode} bukan milik warehouse ${warehouseCode}`), { statusCode: 409 });
        }
      }
      const grNumber = number("GR");
      const receiptDetails = details.map((line, index) => {
        const poDetail = po.details.find((item) => item.id === line.poDetailId);
        if (!poDetail || Number(line.qtyReceived) <= 0) throw Object.assign(new Error(`Invalid receipt detail at line ${index + 1}`), { statusCode: 400 });
        assertQuantity(line.qtyReceived, poDetail.uomCode, `Qty receipt line ${index + 1}`);
        if (Number(poDetail.qtyReceived || 0) + Number(line.qtyReceived) > Number(poDetail.qty || 0)) throw Object.assign(new Error(`Receipt quantity exceeds the outstanding PO on line ${index + 1}`), { statusCode: 409 });
        return { lineNumber: index + 1, poDetailId: poDetail.id, qtyOrdered: poDetail.qty, qtyReceived: Number(line.qtyReceived), deliveryNoteNumber: line.deliveryNoteNumber || deliveryNoteNumber || null, lotNumber: line.lotNumber || null, supplierLotNumber: line.supplierLotNumber || null, rackCode: String(line.rackCode || "").trim() || null, uomCode: poDetail.uomCode, unitPrice: poDetail.unitPrice, totalPrice: Number(line.qtyReceived) * Number(poDetail.unitPrice || 0), notes: line.notes || null };
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
    const inspection = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_goods_receipt" WHERE "gr_number" = ${req.body.grNumber} FOR UPDATE`;
      const gr = await tx.goodsReceipt.findFirst({ where: { grNumber: req.body.grNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } }, incomingInspections: { where: { isDeleted: false, status: { in: ["Open", "In Progress"] } }, select: { inspectionNumber: true } } } });
      if (!gr) throw Object.assign(new Error("Goods Receipt not found"), { statusCode: 404 });
      if (gr.incomingInspections.length) throw Object.assign(new Error(`Goods Receipt masih memiliki inspection aktif ${gr.incomingInspections[0].inspectionNumber}`), { statusCode: 409 });
      if (gr.status !== "Received Pending Inspection") throw Object.assign(new Error("Goods Receipt is not available for a new inspection"), { statusCode: 409 });
      return tx.incomingInspection.create({ data: { inspectionNumber: number("IQC"), grNumber: gr.grNumber, inspectedBy: req.user?.username || req.user?.email || null, status: "Open", details: { create: gr.details.map((item, index) => ({ grDetailId: item.id, lineNumber: index + 1, qtyInspected: 0, qtyAccepted: 0, qtyRejected: 0 })) } }, include: { details: true } });
    });
    res.status(201).json(inspection);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.completeInspection = async (req, res, next) => {
  try {
    const { decisions = [] } = req.body;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_incoming_inspection" WHERE "inspection_number" = ${req.params.inspectionNumber} FOR UPDATE`;
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
        const rejectedDisposition = normalizeDisposition(decision.rejectedDisposition || decision.disposition);
        assertQuantity(accepted || rejected || 1, grDetail.uomCode, `Qty inspection line ${line.lineNumber}`);
        if (accepted < 0 || rejected < 0 || Math.abs(accepted + rejected - Number(grDetail.qtyReceived)) > 0.000001) throw Object.assign(new Error("Qty accepted + rejected wajib sama dengan qty received pada setiap baris"), { statusCode: 400 });
        if (rejected > 0 && !REJECT_DISPOSITIONS.has(rejectedDisposition)) throw Object.assign(new Error(`Disposition reject line ${line.lineNumber} wajib HOLD, RETURN_TO_SUPPLIER, atau SCRAP.`), { statusCode: 400 });
        if (rejected <= 0 && rejectedDisposition) throw Object.assign(new Error(`Line ${line.lineNumber} tidak memiliki qty reject tetapi disposition reject diisi.`), { statusCode: 400 });
        if (rejectedDisposition === "RETURN_TO_SUPPLIER" && !String(decision.dispositionReference || "").trim()) throw Object.assign(new Error(`Referensi retur supplier wajib diisi pada line ${line.lineNumber}.`), { statusCode: 400 });
        acceptedTotal += accepted; rejectedTotal += rejected;
        const immediatelyDisposed = rejected > 0 && FINAL_REJECT_DISPOSITIONS.has(rejectedDisposition);
        await tx.incomingInspectionDetail.update({ where: { id: line.id }, data: {
          qtyInspected: accepted + rejected, qtyAccepted: accepted, qtyRejected: rejected,
          disposition: rejected > 0 ? (accepted > 0 ? "PARTIAL_ACCEPT" : "REJECT") : "ACCEPT",
          rejectedDisposition: rejected > 0 ? rejectedDisposition : null,
          dispositionReference: rejected > 0 ? String(decision.dispositionReference || "").trim() || null : null,
          qtyRejectedDisposed: immediatelyDisposed ? rejected : 0,
          disposedBy: immediatelyDisposed ? req.user?.username || req.user?.email || "system" : null,
          disposedAt: immediatelyDisposed ? new Date() : null,
          defectCode: decision.defectCode || null,
          defectCategory: decision.defectCategory || null,
          notes: decision.notes || null,
        } });
        await tx.goodsReceiptDetail.update({ where: { id: grDetail.id }, data: { qtyInspected: accepted + rejected } });
      }
      const decision = rejectedTotal === 0 ? "Accepted" : acceptedTotal === 0 ? "Rejected" : "Partially Accepted";
      const rejectedDispositionPending = decisions.some((row) => Number(row.qtyRejected || 0) > 0 && normalizeDisposition(row.rejectedDisposition || row.disposition) === "HOLD");
      await tx.incomingInspection.update({ where: { id: inspection.id }, data: { status: "Completed", decision, approvedBy: req.user?.username || req.user?.email || null, approvedAt: new Date() } });
      await tx.goodsReceipt.update({ where: { grNumber: inspection.grNumber }, data: { status: acceptedTotal > 0 ? "Partially Inspected" : (rejectedDispositionPending ? "Rejection Hold" : "Completed") } });
      return { inspectionNumber: inspection.inspectionNumber, decision, acceptedTotal, rejectedTotal, rejectedDispositionPending };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.putawayAccepted = async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT gr.id FROM "tbl_goods_receipt" gr JOIN "tbl_incoming_inspection" iqc ON iqc."gr_number" = gr."gr_number" WHERE iqc."inspection_number" = ${req.params.inspectionNumber} FOR UPDATE OF gr`;
      const inspection = await tx.incomingInspection.findFirst({ where: { inspectionNumber: req.params.inspectionNumber, status: "Completed", isDeleted: false }, include: { details: true, gr: { include: { details: { include: { poDetail: true, incomingInspectionDetails: true } } } } } });
      if (!inspection) throw Object.assign(new Error("Completed Incoming Inspection not found"), { statusCode: 404 });
      // A completed GR is terminal for quality release.  Keeping this guard at
      // the transaction boundary prevents a retried client request from posting
      // the same accepted quantity into available inventory twice.
      if (inspection.gr.status === "Completed") throw Object.assign(new Error("Accepted quantity has already been put away and all rejection dispositions are complete"), { statusCode: 409 });
      const movements = [];
      for (const detail of inspection.gr.details) {
        const inspectionDetail = detail.incomingInspectionDetails.find((item) => item.inspectionId === inspection.id);
        const accepted = Math.max(Number(inspectionDetail?.qtyAccepted || 0) - Number(inspectionDetail?.qtyAcceptedPutaway || 0), 0);
        if (accepted > 0) assertQuantity(accepted, detail.uomCode, `Qty putaway line ${detail.lineNumber}`);
        if (accepted <= 0 || !(detail.poDetail.materialCode || detail.poDetail.partCode || detail.poDetail.productId || detail.poDetail.description)) continue;
        const usesMaterialMaster = Boolean(detail.poDetail.materialId || detail.poDetail.materialCode);
        const conversionFactor = Number(detail.poDetail.conversionFactor || 0);
        const usesPurchaseConversion = usesMaterialMaster
          && conversionFactor > 0
          && Boolean(detail.poDetail.conversionUomCode);
        // GR/IQC remain expressed in the commercial package UOM (COIL/SHEET),
        // while available inventory must be posted in the material/base UOM
        // consumed by MRP and DPP (normally KG).
        const stockQty = usesPurchaseConversion ? accepted * conversionFactor : accepted;
        const stockUomCode = usesPurchaseConversion ? detail.poDetail.conversionUomCode : detail.uomCode;
        assertQuantity(stockQty, stockUomCode, `Qty stock putaway line ${detail.lineNumber}`);
        const materialMaster = usesMaterialMaster
          ? await tx.material.findFirst({
              where: {
                isDeleted: false,
                ...(detail.poDetail.materialId ? { id: detail.poDetail.materialId } : { materialCode: detail.poDetail.materialCode }),
              },
              select: { id: true, materialCode: true, materialName: true, materialType: true },
            })
          : null;
        const materialId = materialMaster?.id || detail.poDetail.materialId || null;
        const materialCode = materialMaster?.materialCode || detail.poDetail.materialCode || null;
        const materialName = materialMaster?.materialName || detail.poDetail.materialName || null;
        const materialType = materialMaster?.materialType || detail.poDetail.materialType || null;
        const identity = {
          warehouseCode: inspection.gr.warehouseCode,
          rackCode: detail.rackCode || null,
          lotNumber: detail.lotNumber || null,
          materialId,
          materialCode,
          partCode: usesMaterialMaster ? null : detail.poDetail.partCode,
          productId: detail.poDetail.productId || null,
          description: usesMaterialMaster ? null : detail.poDetail.description || null,
          spec: detail.poDetail.spec || null,
          thickness: detail.poDetail.thickness || null,
          width: detail.poDetail.width || null,
          CSP: detail.poDetail.CSP || null,
          partNumber: usesMaterialMaster ? null : detail.poDetail.partNumber || null,
          uomCode: stockUomCode || null,
          stockType: usesMaterialMaster ? "Material" : inspection.gr.stockType,
          isDeleted: false,
        };
        await lockStockBalanceIdentity(tx, identity);
        if (detail.lotNumber) {
          await tx.lotMaster.upsert({
            where: { lotNumber: detail.lotNumber },
            create: {
              lotNumber: detail.lotNumber,
              materialId,
              materialCode,
              materialName,
              partCode: usesMaterialMaster ? null : detail.poDetail.partCode,
              productId: detail.poDetail.productId || null,
              description: usesMaterialMaster ? null : detail.poDetail.description || null,
              supplierBatch: detail.supplierLotNumber || null,
            },
            update: {
              materialId: materialId || undefined,
              materialCode: materialCode || undefined,
              materialName: materialName || undefined,
              partCode: usesMaterialMaster ? undefined : detail.poDetail.partCode || undefined,
              supplierBatch: detail.supplierLotNumber || undefined,
            },
          });
        }
        const balance = await tx.stockBalance.findFirst({ where: identity }); const before = Number(balance?.qtyOnHand || 0); const after = before + stockQty;
        const movementNumber = await generateMovementNumber("IN", tx);
        await tx.stockMovement.create({ data: { movementNumber, movementType: "IN", direction: "IN", transactionType: "QUALITY_RELEASE", warehouseCode: identity.warehouseCode, rackCode: identity.rackCode, lotNumber: identity.lotNumber, materialId: identity.materialId, materialCode: identity.materialCode, materialName, materialType, partCode: identity.partCode, partNumber: identity.partNumber, partName: usesMaterialMaster ? null : detail.poDetail.partName || null, productId: identity.productId, description: identity.description, spec: identity.spec, thickness: identity.thickness, width: identity.width, CSP: identity.CSP, stockType: usesMaterialMaster ? "Material" : inspection.gr.stockType, qty: stockQty, deltaQty: stockQty, qtyBefore: before, qtyAfter: after, uomCode: identity.uomCode, qualityBucket: "AVAILABLE", referenceType: "INCOMING_INSPECTION", referenceNumber: inspection.inspectionNumber, notes: usesPurchaseConversion ? `Putaway ${accepted} ${detail.uomCode} x ${conversionFactor} ${stockUomCode}/${detail.uomCode}` : null, performedBy: req.user?.username || req.user?.email || null } });
        if (balance) {
          await assertStockBalanceNotFrozen(tx, balance.id);
          await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: after, qtyAvailable: after - Number(balance.qtyReserved || 0) - Number(balance.qtyQC || 0), lastMovement: new Date() } });
        } else {
          await assertWarehouseNotFrozen(tx, identity.warehouseCode);
          await tx.stockBalance.create({ data: { ...identity, isDeleted: false, materialName, materialType, partName: usesMaterialMaster ? null : detail.poDetail.partName || null, stockType: usesMaterialMaster ? "Material" : inspection.gr.stockType, qtyOnHand: stockQty, qtyAvailable: stockQty, qtyQC: 0, lastMovement: new Date() } });
        }
        movements.push(movementNumber);
        await tx.incomingInspectionDetail.update({ where: { id: inspectionDetail.id }, data: { qtyAcceptedPutaway: { increment: accepted } } });
      }
      const hasPendingRejectedDisposition = inspection.details.some((row) => Number(row.qtyRejectedDisposed || 0) + 0.000001 < Number(row.qtyRejected || 0));
      await tx.goodsReceipt.update({ where: { grNumber: inspection.grNumber }, data: { status: hasPendingRejectedDisposition ? "Rejection Hold" : "Completed" } });
      if (!hasPendingRejectedDisposition) {
        const poDetails = await tx.purchaseOrderDetail.findMany({
          where: { poNumber: inspection.gr.poNumber, isDeleted: false },
          select: { qty: true, qtyReceived: true },
        });
        if (poDetails.length && poDetails.every((row) => Number(row.qtyReceived || 0) + 0.000001 >= Number(row.qty || 0))) {
          await tx.purchaseOrder.update({ where: { poNumber: inspection.gr.poNumber }, data: { status: "Completed" } });
        }
      }
      return { inspectionNumber: inspection.inspectionNumber, movements };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

exports.disposeRejected = async (req, res, next) => {
  try {
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_incoming_inspection" WHERE "inspection_number" = ${req.params.inspectionNumber} FOR UPDATE`;
      const inspection = await tx.incomingInspection.findFirst({
        where: { inspectionNumber: req.params.inspectionNumber, status: "Completed", isDeleted: false },
        include: { details: true, gr: true },
      });
      if (!inspection) throw Object.assign(new Error("Completed Incoming Inspection not found"), { statusCode: 404 });
      const pending = inspection.details.filter((row) => Number(row.qtyRejectedDisposed || 0) + 0.000001 < Number(row.qtyRejected || 0));
      if (!pending.length) throw Object.assign(new Error("Seluruh qty reject sudah memiliki disposition final"), { statusCode: 409 });
      const byId = new Map(decisions.map((row) => [String(row.inspectionDetailId || row.id || ""), row]));
      for (const line of pending) {
        const decision = byId.get(line.id);
        if (!decision) throw Object.assign(new Error(`Disposition final wajib diisi untuk reject line ${line.lineNumber}`), { statusCode: 400 });
        const disposition = normalizeDisposition(decision.rejectedDisposition || decision.disposition);
        if (!FINAL_REJECT_DISPOSITIONS.has(disposition)) throw Object.assign(new Error(`Disposition final line ${line.lineNumber} wajib RETURN_TO_SUPPLIER atau SCRAP.`), { statusCode: 400 });
        const reference = String(decision.dispositionReference || "").trim() || null;
        if (disposition === "RETURN_TO_SUPPLIER" && !reference) throw Object.assign(new Error(`Referensi retur supplier wajib diisi pada line ${line.lineNumber}.`), { statusCode: 400 });
        const outstanding = Number(line.qtyRejected || 0) - Number(line.qtyRejectedDisposed || 0);
        const qty = decision.qty == null ? outstanding : Number(decision.qty);
        if (!Number.isFinite(qty) || Math.abs(qty - outstanding) > 0.000001) throw Object.assign(new Error(`Qty disposition line ${line.lineNumber} wajib sama dengan outstanding reject ${outstanding}.`), { statusCode: 400 });
        await tx.incomingInspectionDetail.update({ where: { id: line.id }, data: {
          rejectedDisposition: disposition,
          dispositionReference: reference,
          qtyRejectedDisposed: { increment: qty },
          disposedBy: req.user?.username || req.user?.email || "system",
          disposedAt: new Date(),
          notes: decision.notes ? [line.notes, decision.notes].filter(Boolean).join(" | ") : line.notes,
        } });
      }
      const remaining = await tx.incomingInspectionDetail.count({
        where: { inspectionId: inspection.id, qtyRejected: { gt: 0 }, OR: [{ rejectedDisposition: "HOLD" }, { disposedAt: null }] },
      });
      const acceptedPending = await tx.incomingInspectionDetail.findMany({ where: { inspectionId: inspection.id }, select: { qtyAccepted: true, qtyAcceptedPutaway: true } });
      const hasAcceptedPending = acceptedPending.some((row) => Number(row.qtyAcceptedPutaway || 0) + 0.000001 < Number(row.qtyAccepted || 0));
      await tx.goodsReceipt.update({ where: { grNumber: inspection.grNumber }, data: { status: remaining || hasAcceptedPending ? "Rejection Hold" : "Completed" } });
      return { inspectionNumber: inspection.inspectionNumber, disposedLines: pending.length, status: remaining || hasAcceptedPending ? "Rejection Hold" : "Completed" };
    });
    res.json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
