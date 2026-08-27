const crypto = require("crypto");
const { prisma } = require("../../index");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { assertQuantity } = require("../../utils/uomQuantity");
const {
  assertStockBalanceNotFrozen,
  assertStockIdentityNotFrozen,
} = require("../inventory/utils/stockOpnameFreezeGuard");
const { lockStockBalanceIdentity } = require("../../services/inventory/stockBalanceLockService");
const { autoAllocateMaterialReceipt } = require("../inventory/utils/autoPartAllocation");
const {
  ensureDefaultNumberingRule,
  generateConfiguredNumber,
} = require("../../services/numberingService");

const number = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const REJECT_DISPOSITIONS = new Set(["HOLD", "RETURN_TO_SUPPLIER", "SCRAP"]);
const FINAL_REJECT_DISPOSITIONS = new Set(["RETURN_TO_SUPPLIER", "SCRAP"]);
const RECEIPT_SHORTAGE_ACTIONS = new Set(["AUTO", "KEEP_OPEN", "CLOSE_PO"]);
const AUTO_CLOSE_SHORTAGE_PERCENT = 5;
const normalizeDisposition = (value) => String(value || "").trim().toUpperCase().replace(/[ -]+/g, "_");
const round = (value, digits = 6) => Number(Number(value || 0).toFixed(digits));
const ACTIVE_PO_RECEIPT_STATUSES = ["Sent", "Confirmed", "Partial Receipt", "Completed"];
const allocationType = (value) => String(value || "DEMAND").trim().toUpperCase() === "BUFFER" ? "BUFFER" : "DEMAND";
const dayKey = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

const normalizeInventoryStockType = (value) => {
  const normalized = String(value || "").trim().toUpperCase().replace(/[ _-]+/g, "_");
  if (["PART", "PURCHASE_PART", "PURCHASEPART"].includes(normalized)) return "Purchase Part";
  if (["MATERIAL", "RAW_MATERIAL", "RAWMATERIAL"].includes(normalized)) return "Material";
  return String(value || "").trim() || null;
};

exports.receivePurchaseOrder = async (req, res, next) => {
  try {
    const { poNumber, warehouseCode, details = [], deliveryNoteNumber, notes, closeReason } = req.body;
    const shortageAction = String(req.body.shortageAction || "AUTO").trim().toUpperCase();
    if (!poNumber || !warehouseCode || !details.length) return res.status(400).json({ message: "poNumber, warehouseCode, and details are required" });
    if (!RECEIPT_SHORTAGE_ACTIONS.has(shortageAction)) return res.status(400).json({ message: "shortageAction harus AUTO, KEEP_OPEN, atau CLOSE_PO" });
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "tbl_purchase_order" WHERE "po_number" = ${poNumber} FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({
        where: { poNumber, isDeleted: false },
        include: {
          details: {
            where: { isDeleted: false },
            include: {
              prDetail: { include: { sources: { where: { isDeleted: false }, orderBy: [{ requiredDate: "asc" }, { createdAt: "asc" }] } } },
              goodsReceiptDetails: {
                where: { isDeleted: false },
                include: { allocations: { where: { isDeleted: false, allocationType: "DEMAND" } } },
              },
            },
          },
        },
      });
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
      await ensureDefaultNumberingRule("LOT_INCOMING", tx);
      const demandSourceIds = [...new Set(po.details.flatMap((detail) => (detail.prDetail?.sources || []).map((source) => source.id)))];
      for (const sourceId of demandSourceIds) {
        await tx.$queryRaw`SELECT id FROM "tbl_purchase_requisition_source" WHERE id = ${sourceId} FOR UPDATE`;
      }
      const pastAllocationRows = demandSourceIds.length
        ? await tx.goodsReceiptAllocation.groupBy({
            by: ["prSourceId"],
            where: { prSourceId: { in: demandSourceIds }, allocationType: "DEMAND", isDeleted: false },
            _sum: { allocatedQty: true },
          })
        : [];
      const previouslyAllocatedBySource = new Map(pastAllocationRows.map((row) => [row.prSourceId, Number(row._sum.allocatedQty || 0)]));
      const receiptDetails = [];
      const receivedInRequest = new Map();
      const allocatedInRequest = new Map();
      for (const [index, line] of details.entries()) {
        const poDetail = po.details.find((item) => item.id === line.poDetailId);
        if (!poDetail || Number(line.qtyReceived) <= 0) throw Object.assign(new Error(`Invalid receipt detail at line ${index + 1}`), { statusCode: 400 });
        assertQuantity(line.qtyReceived, poDetail.uomCode, `Qty receipt line ${index + 1}`);
        const previouslyReceivedInRequest = Number(receivedInRequest.get(poDetail.id) || 0);
        const cumulativeReceived = Number(poDetail.qtyReceived || 0) + previouslyReceivedInRequest + Number(line.qtyReceived);
        const varianceQty = cumulativeReceived - Number(poDetail.qty || 0);
        const usesPurchaseConversion = Number(poDetail.conversionFactor || 0) > 0 && Boolean(poDetail.conversionUomCode);
        const allocatableQty = round(Number(line.qtyReceived) * (usesPurchaseConversion ? Number(poDetail.conversionFactor) : 1));
        const allocationUomCode = usesPurchaseConversion ? poDetail.conversionUomCode : poDetail.uomCode;
        const sources = poDetail.prDetail?.sources || [];
        const sourceById = new Map(sources.map((source) => [source.id, source]));
        const requestedAllocations = Array.isArray(line.allocations) && line.allocations.length
          ? line.allocations
          : sources.length
            ? []
            : [{ allocationType: "BUFFER", allocatedQty: allocatableQty, notes: "Legacy/manual PO tanpa structured demand source" }];
        if (sources.length && !requestedAllocations.length) {
          throw Object.assign(new Error(`Alokasi kebutuhan part wajib diisi untuk receipt line ${index + 1}`), { statusCode: 400 });
        }
        const allocationCreates = [];
        const seenDemandSources = new Set();
        let allocatedTotal = 0;
        for (const [allocationIndex, input] of requestedAllocations.entries()) {
          const type = allocationType(input.allocationType);
          const allocatedQty = Number(input.allocatedQty || 0);
          if (!Number.isFinite(allocatedQty) || allocatedQty <= 0) {
            throw Object.assign(new Error(`Qty alokasi line ${index + 1}.${allocationIndex + 1} harus lebih dari 0`), { statusCode: 400 });
          }
          assertQuantity(allocatedQty, allocationUomCode, `Qty alokasi line ${index + 1}.${allocationIndex + 1}`);
          const source = type === "DEMAND" ? sourceById.get(String(input.prSourceId || "")) : null;
          if (type === "DEMAND" && !source) {
            throw Object.assign(new Error(`Sumber kebutuhan part tidak valid pada receipt line ${index + 1}.${allocationIndex + 1}`), { statusCode: 400 });
          }
          if (source && seenDemandSources.has(source.id)) {
            throw Object.assign(new Error(`Sumber kebutuhan ${source.partCode || source.fgPartCode || source.plannedOrderNumber} duplikat pada receipt line ${index + 1}`), { statusCode: 400 });
          }
          if (source) {
            seenDemandSources.add(source.id);
            const previouslyAllocated = Number(previouslyAllocatedBySource.get(source.id) || 0);
            const inRequest = Number(allocatedInRequest.get(source.id) || 0);
            const remainingDemand = Math.max(Number(source.qty || 0) - previouslyAllocated - inRequest, 0);
            if (allocatedQty > remainingDemand + 0.000001) {
              throw Object.assign(new Error(`Alokasi ${source.partCode || source.fgPartCode || source.plannedOrderNumber} melebihi sisa kebutuhan ${round(remainingDemand)} ${allocationUomCode || ""}`.trim()), { statusCode: 409 });
            }
            allocatedInRequest.set(source.id, inRequest + allocatedQty);
          }
          allocatedTotal += allocatedQty;
          allocationCreates.push({
            prSourceId: source?.id || null,
            allocationType: type,
            plannedOrderNumber: source?.plannedOrderNumber || input.plannedOrderNumber || null,
            partCode: source?.partCode || input.partCode || null,
            fgPartCode: source?.fgPartCode || input.fgPartCode || null,
            requiredDate: source?.requiredDate || (input.requiredDate ? new Date(input.requiredDate) : null),
            requiredQty: source ? Number(source.qty || 0) : 0,
            allocatedQty,
            uomCode: allocationUomCode || source?.uomCode || null,
            notes: String(input.notes || "").trim() || (type === "BUFFER" ? "MOQ / order multiple excess buffer" : null),
            createdBy: req.user?.username || req.user?.email || null,
          });
        }
        if (Math.abs(allocatedTotal - allocatableQty) > 0.000001) {
          throw Object.assign(new Error(`Total alokasi receipt line ${index + 1} harus ${allocatableQty} ${allocationUomCode || ""}; saat ini ${round(allocatedTotal)}`.trim()), { statusCode: 400 });
        }
        const lotNumber = await generateConfiguredNumber("LOT_INCOMING", {
          db: tx,
          context: { code: poDetail.materialCode || poDetail.partCode || "" },
          fallback: () => number("INLOT"),
        });
        receiptDetails.push({ lineNumber: index + 1, poDetailId: poDetail.id, qtyOrdered: poDetail.qty, qtyReceived: Number(line.qtyReceived), deliveryNoteNumber: line.deliveryNoteNumber || deliveryNoteNumber || null, lotNumber, supplierLotNumber: String(line.supplierLotNumber || "").trim() || null, rackCode: String(line.rackCode || "").trim() || null, uomCode: poDetail.uomCode, unitPrice: poDetail.unitPrice, totalPrice: Number(line.qtyReceived) * Number(poDetail.unitPrice || 0), notes: [line.notes, varianceQty > 0 ? `Over receipt ${varianceQty} ${poDetail.uomCode || ""}`.trim() : null].filter(Boolean).join(" | ") || null, allocations: { create: allocationCreates } });
        receivedInRequest.set(poDetail.id, previouslyReceivedInRequest + Number(line.qtyReceived));
      }
      const gr = await tx.goodsReceipt.create({ data: { grNumber, poNumber, poType: po.poType, stockType: normalizeInventoryStockType(po.poType), warehouseCode, deliveryNoteNumber: deliveryNoteNumber || null, receivedBy: req.user?.username || req.user?.email || null, receivedDate: new Date(), status: "Received Pending Inspection", notes: notes || null, details: { create: receiptDetails } }, include: { details: { include: { allocations: true } } } });
      await Promise.all(receiptDetails.map((detail) => tx.purchaseOrderDetail.update({ where: { id: detail.poDetailId }, data: { qtyReceived: { increment: detail.qtyReceived } } })));
      const updatedPoDetails = await tx.purchaseOrderDetail.findMany({
        where: { poNumber, isDeleted: false },
        select: { qty: true, qtyReceived: true, uomCode: true },
      });
      const totalOrdered = updatedPoDetails.reduce((sum, line) => sum + Number(line.qty || 0), 0);
      const remainingQty = updatedPoDetails.reduce((sum, line) => sum + Math.max(Number(line.qty || 0) - Number(line.qtyReceived || 0), 0), 0);
      const overReceivedQty = updatedPoDetails.reduce((sum, line) => sum + Math.max(Number(line.qtyReceived || 0) - Number(line.qty || 0), 0), 0);
      const shortagePercent = totalOrdered > 0 ? remainingQty / totalOrdered * 100 : 0;
      const explicitlyClosed = shortageAction === "CLOSE_PO";
      const automaticallyClosed = shortageAction === "AUTO" && remainingQty > 0.000001 && shortagePercent <= AUTO_CLOSE_SHORTAGE_PERCENT;
      if (explicitlyClosed && remainingQty > 0.000001 && !String(closeReason || "").trim()) {
        throw Object.assign(new Error("Alasan close PO wajib diisi jika masih ada qty kurang"), { statusCode: 400 });
      }
      const poCompleted = remainingQty <= 0.000001 || explicitlyClosed || automaticallyClosed;
      const poStatus = poCompleted ? "Completed" : "Partial Receipt";
      const varianceNote = remainingQty > 0.000001
        ? poCompleted
          ? `PO closed with shortage ${remainingQty} (${shortagePercent.toFixed(3)}%). ${String(closeReason || (automaticallyClosed ? `Auto close <= ${AUTO_CLOSE_SHORTAGE_PERCENT}%` : "")).trim()}`.trim()
          : `PO remains partial; outstanding ${remainingQty} (${shortagePercent.toFixed(3)}%).`
        : overReceivedQty > 0.000001 ? `PO completed with over receipt ${overReceivedQty}.` : "PO fully received.";
      await tx.purchaseOrder.update({ where: { poNumber }, data: { status: poStatus } });
      await tx.goodsReceipt.update({ where: { grNumber }, data: { notes: [notes, varianceNote].filter(Boolean).join(" | ") || null } });
      return {
        ...gr,
        notes: [notes, varianceNote].filter(Boolean).join(" | ") || null,
        poStatus,
        receiptVariance: {
          totalOrdered,
          remainingQty,
          overReceivedQty,
          shortagePercent: Number(shortagePercent.toFixed(6)),
          shortageAction,
          automaticallyClosed,
          autoCloseThresholdPercent: AUTO_CLOSE_SHORTAGE_PERCENT,
        },
      };
    });
    res.status(201).json(result);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};

const allocationPlanInclude = {
  details: {
    where: { isDeleted: false },
    orderBy: { lineNumber: "asc" },
    include: {
      prDetail: {
        include: {
          sources: { where: { isDeleted: false }, orderBy: [{ requiredDate: "asc" }, { createdAt: "asc" }] },
        },
      },
      goodsReceiptDetails: {
        where: { isDeleted: false },
        include: { allocations: { where: { isDeleted: false } } },
      },
    },
  },
};

function mapAllocationPlan(po, globalAllocatedBySource = null) {
  return {
    poNumber: po.poNumber,
    deliveryDate: po.deliveryDate,
    supplierName: po.supplierName || po.vendorName || null,
    details: po.details.map((detail) => {
      const conversionFactor = Number(detail.conversionFactor || 0) > 0 && detail.conversionUomCode
        ? Number(detail.conversionFactor)
        : 1;
      const allocationUomCode = conversionFactor !== 1 ? detail.conversionUomCode : detail.uomCode;
      const previouslyAllocatedBySource = new Map();
      let bufferAllocatedQty = 0;
      for (const receipt of detail.goodsReceiptDetails || []) {
        for (const allocation of receipt.allocations || []) {
          if (allocation.allocationType === "BUFFER") bufferAllocatedQty += Number(allocation.allocatedQty || 0);
          else if (allocation.prSourceId) previouslyAllocatedBySource.set(allocation.prSourceId, Number(previouslyAllocatedBySource.get(allocation.prSourceId) || 0) + Number(allocation.allocatedQty || 0));
        }
      }
      const sources = (detail.prDetail?.sources || []).map((source) => {
        const previouslyAllocatedQty = Number((globalAllocatedBySource || previouslyAllocatedBySource).get(source.id) || 0);
        return {
          id: source.id,
          plannedOrderNumber: source.plannedOrderNumber,
          partCode: source.partCode,
          fgPartCode: source.fgPartCode,
          sourceType: source.sourceType,
          sourceNumber: source.sourceNumber,
          dueDate: source.requiredDate,
          requiredQty: round(source.qty),
          previouslyAllocatedQty: round(previouslyAllocatedQty),
          remainingQty: round(Math.max(Number(source.qty || 0) - previouslyAllocatedQty, 0)),
          uomCode: source.uomCode || allocationUomCode,
        };
      });
      const outstandingReceiptQty = Math.max(Number(detail.qty || 0) - Number(detail.qtyReceived || 0), 0);
      return {
        poDetailId: detail.id,
        materialCode: detail.materialCode,
        materialName: detail.materialName,
        partCode: detail.partCode,
        partName: detail.partName,
        description: detail.description,
        spec: detail.spec,
        orderedQty: round(detail.qty),
        receivedQty: round(detail.qtyReceived),
        outstandingReceiptQty: round(outstandingReceiptQty),
        receiptUomCode: detail.uomCode,
        allocationQty: round(outstandingReceiptQty * conversionFactor),
        allocationUomCode,
        conversionFactor,
        dueDate: detail.deliveryDate || po.deliveryDate,
        sources,
        bufferAllocatedQty: round(bufferAllocatedQty),
      };
    }),
  };
}

exports.getAllocationPlan = async (req, res, next) => {
  try {
    const po = await prisma.purchaseOrder.findFirst({
      where: { poNumber: req.params.poNumber, isDeleted: false },
      include: allocationPlanInclude,
    });
    if (!po) return res.status(404).json({ message: "Purchase Order not found" });
    const sourceIds = [...new Set(po.details.flatMap((detail) => (detail.prDetail?.sources || []).map((source) => source.id)))];
    const allocatedRows = sourceIds.length ? await prisma.goodsReceiptAllocation.groupBy({
      by: ["prSourceId"], where: { prSourceId: { in: sourceIds }, allocationType: "DEMAND", isDeleted: false }, _sum: { allocatedQty: true },
    }) : [];
    res.json(mapAllocationPlan(po, new Map(allocatedRows.map((row) => [row.prSourceId, Number(row._sum.allocatedQty || 0)]))));
  } catch (error) { next(error); }
};

exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : defaultFrom;
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : defaultTo;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: "Periode dashboard tidak valid" });

    const [purchaseOrders, actualReceipts, vendorProcessOrders] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where: {
          isDeleted: false,
          status: { in: ACTIVE_PO_RECEIPT_STATUSES },
          deliveryDate: { lte: to },
        },
        include: allocationPlanInclude,
        orderBy: [{ deliveryDate: "asc" }, { poNumber: "asc" }],
        take: 1000,
      }),
      prisma.goodsReceipt.findMany({
        where: { isDeleted: false, receivedDate: { gte: from, lte: to } },
        include: {
          po: { select: { supplierName: true, vendorName: true, deliveryDate: true } },
          details: {
            where: { isDeleted: false },
            include: {
              poDetail: true,
              allocations: { where: { isDeleted: false }, orderBy: [{ requiredDate: "asc" }, { createdAt: "asc" }] },
            },
          },
        },
        orderBy: { receivedDate: "desc" },
        take: 1000,
      }),
      prisma.vendorProcessOrder.findMany({
        where: {
          isDeleted: false,
          status: { notIn: ["Cancelled", "Closed"] },
          OR: [
            { dueDate: { gte: from, lte: to } },
            { receivedAt: { gte: from, lte: to } },
          ],
        },
        orderBy: [{ dueDate: "asc" }, { orderNumber: "asc" }],
        take: 1000,
      }),
    ]);

    const currentDay = dayKey(today);
    const dashboardSourceIds = [...new Set(purchaseOrders.flatMap((po) => po.details.flatMap((detail) => (detail.prDetail?.sources || []).map((source) => source.id))))];
    const dashboardAllocatedRows = dashboardSourceIds.length ? await prisma.goodsReceiptAllocation.groupBy({
      by: ["prSourceId"], where: { prSourceId: { in: dashboardSourceIds }, allocationType: "DEMAND", isDeleted: false }, _sum: { allocatedQty: true },
    }) : [];
    const dashboardAllocatedBySource = new Map(dashboardAllocatedRows.map((row) => [row.prSourceId, Number(row._sum.allocatedQty || 0)]));
    const planRows = purchaseOrders.flatMap((po) => mapAllocationPlan(po, dashboardAllocatedBySource).details.map((detail) => {
      const itemType = detail.materialCode ? "MATERIAL" : detail.partCode ? "PURCHASE_PART" : null;
      if (!itemType) return null;
      const dueDate = dayKey(detail.dueDate);
      const outstandingQty = detail.allocationQty;
      const daysToDue = dueDate ? Math.ceil((new Date(`${dueDate}T00:00:00.000Z`) - new Date(`${currentDay}T00:00:00.000Z`)) / 86400000) : null;
      const status = outstandingQty <= 0.000001 ? "RECEIVED" : daysToDue < 0 ? "OVERDUE" : daysToDue === 0 ? "DUE_TODAY" : daysToDue <= 7 ? "DUE_SOON" : "PLANNED";
      return {
        poNumber: po.poNumber,
        supplierName: po.supplierName || po.vendorName || null,
        poStatus: po.status,
        poDetailId: detail.poDetailId,
        itemType,
        materialCode: detail.materialCode || detail.partCode || "-",
        materialName: detail.materialName || detail.partName || detail.description || "-",
        spec: detail.spec,
        dueDate,
        plannedAt: detail.dueDate,
        orderedQty: round(detail.orderedQty * detail.conversionFactor),
        receivedQty: round(detail.receivedQty * detail.conversionFactor),
        outstandingQty,
        uomCode: detail.allocationUomCode,
        status,
        daysToDue,
        requirements: detail.sources,
        bufferAllocatedQty: detail.bufferAllocatedQty,
      };
    })).filter((row) => row && (row.dueDate >= dayKey(from) || row.outstandingQty > 0.000001));

    const actualRows = actualReceipts.flatMap((gr) => gr.details.map((detail) => {
      const poDetail = detail.poDetail;
      const factor = Number(poDetail.conversionFactor || 0) > 0 && poDetail.conversionUomCode ? Number(poDetail.conversionFactor) : 1;
      const dueDate = dayKey(poDetail.deliveryDate || gr.po.deliveryDate);
      const receivedDate = dayKey(gr.receivedDate || gr.grDate);
      return {
        grNumber: gr.grNumber,
        receivedDate,
        poNumber: gr.poNumber,
        supplierName: gr.po.supplierName || gr.po.vendorName || null,
        materialCode: poDetail.materialCode || poDetail.partCode || "-",
        materialName: poDetail.materialName || poDetail.partName || poDetail.description || "-",
        qtyReceived: round(Number(detail.qtyReceived || 0) * factor),
        uomCode: factor !== 1 ? poDetail.conversionUomCode : detail.uomCode,
        dueDate,
        onTimeStatus: dueDate && receivedDate > dueDate ? "LATE" : "ON_TIME",
        status: gr.status,
        lotNumber: detail.lotNumber,
        supplierLotNumber: detail.supplierLotNumber,
        allocations: (detail.allocations || []).map((allocation) => ({
          allocationType: allocation.allocationType,
          partCode: allocation.partCode,
          fgPartCode: allocation.fgPartCode,
          plannedOrderNumber: allocation.plannedOrderNumber,
          dueDate: dayKey(allocation.requiredDate),
          allocatedQty: round(allocation.allocatedQty),
          uomCode: allocation.uomCode,
        })),
      };
    }));

    const vendorRows = vendorProcessOrders.map((row) => ({
      itemType: "VENDOR_PROCESS",
      orderNumber: row.orderNumber,
      moNumber: row.moNumber,
      vendorCode: row.vendorCode,
      vendorName: row.vendorName || row.vendorCode || "Vendor belum ditentukan",
      partCode: row.outputPartCode || row.inputPartCode || "-",
      partNumber: row.outputPartNumber || row.inputPartNumber || null,
      partName: row.outputPartName || row.inputPartName || null,
      processCode: row.processCode,
      processName: row.processName,
      plannedAt: row.dueDate,
      actualAt: row.receivedAt,
      plannedQty: round(row.qtyPlanned),
      receivedQty: round(row.qtyReceived),
      outstandingQty: round(Math.max(Number(row.qtyPlanned || 0) - Number(row.qtyReceived || 0), 0)),
      uomCode: row.uomCode,
      status: row.status,
    }));

    const uomCodes = [...new Set([...planRows, ...actualRows, ...vendorRows].map((row) => row.uomCode).filter(Boolean))].sort();
    res.json({
      period: { from: dayKey(from), to: dayKey(to) },
      generatedAt: new Date(),
      uomCodes,
      summary: {
        plannedLines: planRows.filter((row) => row.dueDate >= dayKey(from) && row.dueDate <= dayKey(to)).length,
        arrivedLines: actualRows.length,
        overdueLines: planRows.filter((row) => row.status === "OVERDUE").length,
        dueSoonLines: planRows.filter((row) => ["DUE_TODAY", "DUE_SOON"].includes(row.status)).length,
        allocationPendingLines: planRows.filter((row) => row.outstandingQty > 0 && row.requirements.length > 0).length,
      },
      planRows,
      actualRows,
      vendorRows,
    });
  } catch (error) { next(error); }
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
        const partMaster = !usesMaterialMaster && detail.poDetail.partCode
          ? await tx.part.findFirst({
              where: { partCode: detail.poDetail.partCode, isDeleted: false },
              select: { rawType: true },
            })
          : null;
        const inventoryStockType = usesMaterialMaster
          ? "Material"
          : String(partMaster?.rawType || "").toUpperCase() === "PURCHASE_PART"
            ? "Purchase Part"
            : normalizeInventoryStockType(inspection.gr.stockType || inspection.gr.poType);
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
          stockType: inventoryStockType,
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
        await tx.stockMovement.create({ data: { movementNumber, movementType: "IN", direction: "IN", transactionType: "QUALITY_RELEASE", warehouseCode: identity.warehouseCode, rackCode: identity.rackCode, lotNumber: identity.lotNumber, materialId: identity.materialId, materialCode: identity.materialCode, materialName, materialType, partCode: identity.partCode, partNumber: identity.partNumber, partName: usesMaterialMaster ? null : detail.poDetail.partName || null, productId: identity.productId, description: identity.description, spec: identity.spec, thickness: identity.thickness, width: identity.width, CSP: identity.CSP, stockType: inventoryStockType, qty: stockQty, deltaQty: stockQty, qtyBefore: before, qtyAfter: after, uomCode: identity.uomCode, qualityBucket: "AVAILABLE", referenceType: "INCOMING_INSPECTION", referenceNumber: inspection.inspectionNumber, notes: usesPurchaseConversion ? `Putaway ${accepted} ${detail.uomCode} x ${conversionFactor} ${stockUomCode}/${detail.uomCode}` : null, performedBy: req.user?.username || req.user?.email || null } });
        let postedBalance;
        if (balance) {
          await assertStockBalanceNotFrozen(tx, balance.id);
          postedBalance = await tx.stockBalance.update({ where: { id: balance.id }, data: { qtyOnHand: after, qtyAvailable: after - Number(balance.qtyReserved || 0) - Number(balance.qtyQC || 0), lastMovement: new Date() } });
        } else {
          await assertStockIdentityNotFrozen(tx, { ...identity, stockType: inventoryStockType });
          postedBalance = await tx.stockBalance.create({ data: { ...identity, isDeleted: false, materialName, materialType, partName: usesMaterialMaster ? null : detail.poDetail.partName || null, stockType: inventoryStockType, qtyOnHand: stockQty, qtyAvailable: stockQty, qtyQC: 0, lastMovement: new Date() } });
        }
        await autoAllocateMaterialReceipt(tx, {
          stockBalanceId: postedBalance.id,
          receivedQty: stockQty,
          reservationDate: new Date(),
          sourceType: "INCOMING_INSPECTION",
          sourceNumber: inspection.inspectionNumber,
        });
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
