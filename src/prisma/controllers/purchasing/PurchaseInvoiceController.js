const { prisma } = require("../../index");
const readController = require("../supply-chain/SupplyChainReadController");
const { generateDocNumber } = require("./utils/purchasingHelpers");
const { convertPurchaseInvoiceDetailNumericFields } = require("./utils/purchasingNumericConverter");
const { resolveApprovalRule, createApprovalRequest } = require("../../services/approvalRuleService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value) => String(value || "").trim();
const parsedDate = (value) => {
  if (!value) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
};
const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";
const DETAIL_INCLUDE = {
  supplier: true,
  vendor: true,
  currency: true,
  purchaseOrders: { include: { po: true } },
  details: { orderBy: { lineNumber: "asc" }, include: { poDetail: true, grDetail: true, product: true } },
  payments: { orderBy: { lineNumber: "asc" } },
};

exports.list = readController.listPurchaseInvoices;
exports.get = readController.getPurchaseInvoice;

async function prepareInvoiceLines(tx, po, invoiceNumber, detailsInput) {
  const source = Array.isArray(detailsInput) && detailsInput.length
    ? detailsInput
    : po.details.map((detail) => ({
        poDetailId: detail.id,
        qtyInvoiced: number(detail.qtyReceived) || number(detail.qty),
        unitPrice: detail.unitPrice,
        discount: detail.discount,
        discountType: detail.discountType,
        tax: detail.tax,
      }));
  const poDetailById = new Map(po.details.map((detail) => [detail.id, detail]));
  const existing = await tx.purchaseInvoiceDetail.groupBy({
    by: ["poDetailId"],
    where: {
      poDetailId: { in: [...poDetailById.keys()] },
      invoice: {
        isDeleted: false,
        status: { notIn: ["Cancelled"] },
        ...(invoiceNumber ? { invoiceNumber: { not: invoiceNumber } } : {}),
      },
    },
    _sum: { qtyInvoiced: true },
  });
  const invoicedByPoDetail = new Map(existing.map((row) => [row.poDetailId, number(row._sum.qtyInvoiced)]));
  return source.map((raw, index) => {
    const line = convertPurchaseInvoiceDetailNumericFields(raw);
    const poDetail = poDetailById.get(String(line.poDetailId || ""));
    if (!poDetail) {
      throw Object.assign(new Error(`PO detail baris ${index + 1} tidak ditemukan pada ${po.poNumber}.`), { statusCode: 400 });
    }
    const qtyInvoiced = number(line.qtyInvoiced);
    const alreadyInvoiced = invoicedByPoDetail.get(poDetail.id) || 0;
    const outstanding = Math.max(number(poDetail.qty) - alreadyInvoiced, 0);
    if (qtyInvoiced <= 0 || qtyInvoiced > outstanding + 1e-9) {
      throw Object.assign(new Error(`Qty invoice baris ${index + 1} melebihi outstanding PO ${outstanding}.`), { statusCode: 409 });
    }
    const unitPrice = number(line.unitPrice ?? poDetail.unitPrice);
    const discount = number(line.discount ?? poDetail.discount);
    const tax = number(line.tax ?? poDetail.tax);
    const gross = qtyInvoiced * unitPrice;
    const discountAmount = String(line.discountType || "percent").toLowerCase() === "nominal"
      ? discount
      : gross * discount / 100;
    const taxable = Math.max(gross - discountAmount, 0);
    const totalAmount = taxable + taxable * tax / 100;
    const expectedGross = qtyInvoiced * number(poDetail.unitPrice);
    const expectedDiscount = String(poDetail.discountType || "percent").toLowerCase() === "nominal"
      ? number(poDetail.discount)
      : expectedGross * number(poDetail.discount) / 100;
    const expectedTaxable = Math.max(expectedGross - expectedDiscount, 0);
    const expectedAmount = expectedTaxable + expectedTaxable * number(poDetail.tax) / 100;
    const varianceAmount = totalAmount - expectedAmount;
    const receivedQty = number(poDetail.qtyReceived);
    const qtyMatched = receivedQty + 1e-9 >= qtyInvoiced;
    const priceMatched = Math.abs(varianceAmount) <= 0.01;
    return {
      lineNumber: number(line.lineNumber) || index + 1,
      poDetailId: poDetail.id,
      grDetailId: line.grDetailId || null,
      productId: poDetail.productId || null,
      description: line.description || poDetail.description,
      partCode: poDetail.partCode,
      partNumber: poDetail.partNumber,
      partName: poDetail.partName,
      spec: poDetail.spec,
      thickness: poDetail.thickness,
      width: poDetail.width,
      CSP: poDetail.CSP,
      qtyInvoiced,
      uomCode: line.uomCode || poDetail.uomCode,
      unitPrice,
      discount,
      discountType: line.discountType || "percent",
      tax,
      totalAmount,
      varianceAmount,
      notes: line.notes || null,
      qtyMatched,
      priceMatched,
      _discountAmount: discountAmount,
      _taxAmount: taxable * tax / 100,
    };
  });
}

function totals(lines) {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.qtyInvoiced * line.unitPrice, 0);
  const totalAmount = lines.reduce((sum, line) => sum + line.totalAmount, 0);
  return {
    subtotalAmount,
    discountAmount: lines.reduce((sum, line) => sum + number(line._discountAmount), 0),
    taxAmount: lines.reduce((sum, line) => sum + number(line._taxAmount), 0),
    totalAmount,
  };
}

exports.create = async (req, res, next) => {
  try {
    const input = req.body || {};
    const header = input.header || input;
    const poNumber = text(header.poNumber);
    const supplierInvoiceNumber = text(header.supplierInvoiceNumber);
    if (!poNumber || !supplierInvoiceNumber) {
      return res.status(400).json({ message: "poNumber dan supplierInvoiceNumber wajib diisi." });
    }
    const result = await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({
        where: { poNumber, isDeleted: false, status: { in: ["Approved", "Sent", "Confirmed", "Partial Receipt", "Completed"] } },
        include: { details: { where: { isDeleted: false } } },
      });
      if (!po) throw Object.assign(new Error("PO tidak ditemukan atau belum Approved."), { statusCode: 409 });
      const duplicate = await tx.purchaseInvoice.findFirst({
        where: {
          supplierInvoiceNumber,
          isDeleted: false,
          ...(po.supplierCode ? { supplierCode: po.supplierCode } : { vendorCode: po.vendorCode }),
        },
        select: { invoiceNumber: true },
      });
      if (duplicate) throw Object.assign(new Error(`Invoice supplier sudah digunakan pada ${duplicate.invoiceNumber}.`), { statusCode: 409 });
      const invoiceNumber = await generateDocNumber("purchaseInvoice", "PINV", "invoiceNumber", tx);
      const prepared = await prepareInvoiceLines(tx, po, null, input.details);
      const amount = totals(prepared);
      const matched = prepared.every((line) => line.qtyMatched && line.priceMatched);
      return tx.purchaseInvoice.create({
        data: {
          invoiceNumber,
          supplierInvoiceNumber,
          invoiceDate: parsedDate(header.invoiceDate) || new Date(),
          dueDate: parsedDate(header.dueDate),
          poNumber: po.poNumber,
          supplierCode: po.supplierCode,
          supplierName: po.supplierName,
          vendorCode: po.vendorCode,
          vendorName: po.vendorName,
          currencyCode: po.currencyCode,
          ...amount,
          status: "Draft",
          matchStatus: matched ? "Matched" : "Variance",
          invoiceFiles: Array.isArray(header.invoiceFiles) ? header.invoiceFiles : [],
          notes: header.notes || null,
          createdBy: actor(req),
          purchaseOrders: { create: { poNumber: po.poNumber } },
          details: {
            create: prepared.map(({ qtyMatched, priceMatched, _discountAmount, _taxAmount, ...line }) => line),
          },
        },
        include: DETAIL_INCLUDE,
      });
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const input = req.body || {};
    const header = input.header || input;
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseInvoice.findFirst({
        where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
      });
      if (!current) throw Object.assign(new Error("Purchase Invoice tidak ditemukan."), { statusCode: 404 });
      if (!["Draft", "Need Review"].includes(current.status)) {
        throw Object.assign(new Error(`Invoice berstatus ${current.status} tidak dapat diedit.`), { statusCode: 409 });
      }
      const poNumber = text(header.poNumber || current.poNumber);
      const po = await tx.purchaseOrder.findFirst({
        where: { poNumber, isDeleted: false },
        include: { details: { where: { isDeleted: false } } },
      });
      if (!po) throw Object.assign(new Error("Purchase Order tidak ditemukan."), { statusCode: 404 });
      const prepared = await prepareInvoiceLines(tx, po, current.invoiceNumber, input.details);
      const amount = totals(prepared);
      const matched = prepared.every((line) => line.qtyMatched && line.priceMatched);
      await tx.purchaseInvoiceDetail.deleteMany({ where: { invoiceNumber: current.invoiceNumber } });
      return tx.purchaseInvoice.update({
        where: { invoiceNumber: current.invoiceNumber },
        data: {
          supplierInvoiceNumber: text(header.supplierInvoiceNumber || current.supplierInvoiceNumber),
          invoiceDate: parsedDate(header.invoiceDate) || current.invoiceDate,
          dueDate: header.dueDate === undefined ? current.dueDate : parsedDate(header.dueDate),
          ...amount,
          matchStatus: matched ? "Matched" : "Variance",
          notes: header.notes === undefined ? current.notes : header.notes,
          details: { create: prepared.map(({ qtyMatched, priceMatched, _discountAmount, _taxAmount, ...line }) => line) },
        },
        include: DETAIL_INCLUDE,
      });
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    next(error);
  }
};

exports.submit = async (req, res, next) => {
  try {
    const invoice = await prisma.purchaseInvoice.findFirst({
      where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
      include: { details: true },
    });
    if (!invoice) return res.status(404).json({ message: "Purchase Invoice tidak ditemukan." });
    if (!["Draft", "Need Review"].includes(invoice.status)) {
      return res.status(409).json({ message: `Invoice berstatus ${invoice.status} tidak dapat disubmit.` });
    }
    const rule = await resolveApprovalRule({
      moduleCode: "purchasing",
      pageCode: "purchase-invoices",
      actionCode: "approve",
      documentType: "PurchaseInvoice",
      amount: invoice.totalAmount,
      currencyCode: invoice.currencyCode,
      context: invoice,
    });
    const approvalRequest = rule
      ? await createApprovalRequest({
          rule,
          moduleCode: "purchasing",
          pageCode: "purchase-invoices",
          actionCode: "approve",
          documentType: "PurchaseInvoice",
          documentId: invoice.id,
          documentNumber: invoice.invoiceNumber,
          amount: invoice.totalAmount,
          currencyCode: invoice.currencyCode,
          context: invoice,
          requestedByUserId: req.user?.id,
          requestedBy: actor(req),
        })
      : null;
    const updated = await prisma.purchaseInvoice.update({
      where: { invoiceNumber: invoice.invoiceNumber },
      data: { status: "Submitted", submittedBy: actor(req), submittedDate: new Date() },
      include: DETAIL_INCLUDE,
    });
    res.json({ ...updated, approvalRequest });
  } catch (error) {
    next(error);
  }
};

exports.approve = async (req, res, next) => {
  try {
    const current = await prisma.purchaseInvoice.findFirst({
      where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
    });
    if (!current) return res.status(404).json({ message: "Purchase Invoice tidak ditemukan." });
    if (current.status !== "Submitted") {
      return res.status(409).json({ message: `Invoice berstatus ${current.status} tidak dapat diapprove.` });
    }
    const invoice = await prisma.purchaseInvoice.update({
      where: { invoiceNumber: current.invoiceNumber },
      data: { status: "Approved", approvedBy: actor(req), approvedDate: new Date() },
      include: DETAIL_INCLUDE,
    });
    res.json(invoice);
  } catch (error) {
    next(error);
  }
};

exports.post = async (req, res, next) => {
  try {
    const current = await prisma.purchaseInvoice.findFirst({
      where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
    });
    if (!current) return res.status(404).json({ message: "Purchase Invoice tidak ditemukan." });
    if (current.status !== "Approved") return res.status(409).json({ message: "Invoice harus Approved sebelum diposting." });
    res.json(await prisma.purchaseInvoice.update({
      where: { invoiceNumber: current.invoiceNumber },
      data: { status: "Posted" },
      include: DETAIL_INCLUDE,
    }));
  } catch (error) {
    next(error);
  }
};

exports.pay = async (req, res, next) => {
  try {
    const amount = number(req.body?.amount);
    const current = await prisma.purchaseInvoice.findFirst({
      where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
      include: { payments: true },
    });
    if (!current) return res.status(404).json({ message: "Purchase Invoice tidak ditemukan." });
    if (!["Approved", "Posted"].includes(current.status)) return res.status(409).json({ message: "Invoice belum dapat dibayar." });
    const paid = current.payments.reduce((sum, row) => sum + number(row.amountPayment), 0);
    const outstanding = Math.max(number(current.totalAmount) - paid, 0);
    if (amount <= 0 || amount > outstanding + 0.01) return res.status(400).json({ message: `Amount payment harus 0-${outstanding}.` });
    const result = await prisma.$transaction(async (tx) => {
      await tx.purchaseInvoicePayment.create({
        data: {
          invoiceNumber: current.invoiceNumber,
          lineNumber: current.payments.length + 1,
          actualPaymentDate: parsedDate(req.body?.paymentDate) || new Date(),
          amountPayment: amount,
          outstandingPayment: Math.max(outstanding - amount, 0),
          notes: req.body?.notes || null,
          createdBy: actor(req),
        },
      });
      const fullyPaid = amount + 0.01 >= outstanding;
      return tx.purchaseInvoice.update({
        where: { invoiceNumber: current.invoiceNumber },
        data: fullyPaid ? { status: "Paid", paidBy: actor(req), paidDate: new Date() } : {},
        include: DETAIL_INCLUDE,
      });
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const current = await prisma.purchaseInvoice.findFirst({
      where: { invoiceNumber: req.params.invoiceNumber, isDeleted: false },
      include: { payments: true },
    });
    if (!current) return res.status(404).json({ message: "Purchase Invoice tidak ditemukan." });
    if (!["Draft", "Cancelled"].includes(current.status) || current.payments.length) {
      return res.status(409).json({ message: "Hanya invoice Draft/Cancelled tanpa payment yang dapat dihapus." });
    }
    await prisma.purchaseInvoice.update({
      where: { invoiceNumber: current.invoiceNumber },
      data: { isDeleted: true },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
