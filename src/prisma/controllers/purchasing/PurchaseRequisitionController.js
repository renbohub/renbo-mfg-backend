const { prisma } = require("../../index");
const { generateDocNumber, generatePONumber } = require("./utils/purchasingHelpers");
const { resolveApprovalRule, createApprovalRequest } = require("../../services/approvalRuleService");

const include = {
  department: true,
  details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" }, include: { product: true } },
  purchaseOrders: { include: { po: { select: { poNumber: true, status: true, supplierName: true, vendorName: true } } } },
};
const date = (v) => v ? new Date(v) : undefined;
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const bodyObject = (v) => typeof v === "string" ? JSON.parse(v) : (v || {});
const normalize = (v) => String(v || "").trim().toUpperCase();
const clean = (v) => {
  const value = String(v ?? "").trim();
  return value || null;
};
const actor = (req) => req.user?.username || req.user?.email || req.user?.id || "system";
const dayKey = (value) => {
  const parsed = date(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};
const isKg = (v) => ["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(normalize(v));
const classifyPart = (part) => {
  if (normalize(part?.rawType) === "PURCHASE_PART") return "PURCHASE_PART";
  if (normalize(part?.rawType) === "MATERIAL") return "RAW_MATERIAL";
  return "OTHER";
};
const normalizeCategory = (value) => {
  const category = normalize(value).replace(/[\s-]+/g, "_");
  if (["RAW", "MATERIAL", "RAW_MATERIAL"].includes(category)) return "RAW_MATERIAL";
  if (["PURCHASE", "PURCHASED", "PURCHASE_PART"].includes(category)) return "PURCHASE_PART";
  return category || null;
};
const normalizeSourceType = (value) => {
  const sourceType = normalize(value || "MANUAL").replace(/[\s-]+/g, "_");
  if (!["MANUAL", "MRP", "SYSTEM"].includes(sourceType)) {
    throw Object.assign(new Error("sourceType PR harus MANUAL, MRP, atau SYSTEM."), { statusCode: 400 });
  }
  return sourceType;
};
const preferredPartBase = (part) => {
  const bases = Array.isArray(part?.partBases) ? part.partBases : [];
  return bases.find((row) => normalize(row.baseOn) === "ACTUAL")
    || bases.find((row) => normalize(row.baseOn) === "QTN")
    || bases[0]
    || null;
};
const classifyRequisition = (details = []) => {
  const categories = [...new Set(details.map((detail) => detail.procurementCategory).filter(Boolean))];
  return categories.length === 1 ? categories[0] : categories.length > 1 ? "MIXED" : "OTHER";
};
async function attachProcurementClassification(rows, client = prisma) {
  const list = Array.isArray(rows) ? rows : [rows];
  const partCodes = [...new Set(list.flatMap((row) => row?.details || []).map((detail) => detail.partCode).filter(Boolean))];
  const parts = partCodes.length ? await client.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: { partCode: true, itemType: true, rawType: true, procurementType: true, baseUomCode: true, purchaseUomCode: true },
  }) : [];
  const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
  const classified = list.map((row) => {
    const details = (row?.details || []).map((detail) => {
      const part = partByCode.get(normalize(detail.partCode));
      const procurementCategory = detail.materialCode ? "RAW_MATERIAL" : classifyPart(part);
      return { ...detail, procurementCategory, partClassification: part || null };
    });
    const procurementCategory = classifyRequisition(details);
    return {
      ...row,
      details,
      procurementCategory,
      prCategory: procurementCategory,
      materialCategory: procurementCategory,
    };
  });
  return Array.isArray(rows) ? classified : classified[0];
}

/**
 * Normalize user-entered PR lines against master data. Identity values are
 * always snapshotted from the master, not trusted from the request payload.
 * Legacy/free-form lines remain supported when no procurement category is
 * supplied, while explicit Material/Purchase Part lines are strictly checked.
 */
async function normalizeRequisitionDetails(details, client) {
  if (!Array.isArray(details) || !details.length) {
    throw Object.assign(new Error("Minimal satu detail PR wajib diisi."), { statusCode: 400 });
  }

  const partIds = [...new Set(details.map((row) => clean(row.partId)).filter(Boolean))];
  const partCodes = [...new Set(details.map((row) => clean(row.partCode)).filter(Boolean))];
  const partNumbers = [...new Set(details.map((row) => clean(row.partNumber)).filter(Boolean))];
  const materialIds = [...new Set(details.map((row) => clean(row.materialId)).filter(Boolean))];
  const materialCodes = [...new Set(details.map((row) => clean(row.materialCode)).filter(Boolean))];

  const [parts, explicitMaterials] = await Promise.all([
    (partIds.length || partCodes.length || partNumbers.length) ? client.part.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(partIds.length ? [{ id: { in: partIds } }] : []),
          ...(partCodes.length ? [{ partCode: { in: partCodes } }] : []),
          ...(partNumbers.length ? [{ partNumber: { in: partNumbers } }] : []),
        ],
      },
      select: {
        id: true, partCode: true, partNumber: true, partName: true, itemType: true,
        rawType: true, materialId: true, baseUomCode: true, purchaseUomCode: true,
      },
    }) : [],
    (materialIds.length || materialCodes.length) ? client.material.findMany({
      where: {
        isDeleted: false,
        OR: [
          ...(materialIds.length ? [{ id: { in: materialIds } }] : []),
          ...(materialCodes.length ? [{ materialCode: { in: materialCodes } }] : []),
        ],
      },
      select: { id: true, materialCode: true, materialName: true, materialType: true, spec: true, thickness: true, width: true, CSP: true },
    }) : [],
  ]);

  const linkedMaterialIds = [...new Set(parts.map((part) => part.materialId).filter(Boolean))];
  const linkedMaterials = linkedMaterialIds.length ? await client.material.findMany({
    where: { id: { in: linkedMaterialIds }, isDeleted: false },
    select: { id: true, materialCode: true, materialName: true, materialType: true, spec: true, thickness: true, width: true, CSP: true },
  }) : [];
  const materials = [...explicitMaterials, ...linkedMaterials.filter((material) => !explicitMaterials.some((row) => row.id === material.id))];
  const partById = new Map(parts.map((part) => [part.id, part]));
  const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
  const partsByNumber = new Map();
  for (const part of parts) {
    const key = normalize(part.partNumber);
    if (!key) continue;
    if (!partsByNumber.has(key)) partsByNumber.set(key, []);
    partsByNumber.get(key).push(part);
  }
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const materialByCode = new Map(materials.map((material) => [normalize(material.materialCode), material]));

  const rows = details.map((detail, index) => {
    const line = index + 1;
    const numberMatches = partsByNumber.get(normalize(detail.partNumber)) || [];
    if (!detail.partId && !detail.partCode && clean(detail.partNumber) && numberMatches.length > 1) {
      throw Object.assign(new Error(`Part Number baris ${line} ambigu. Pilih Part Code dari Part Master.`), { statusCode: 400 });
    }
    const part = partById.get(clean(detail.partId))
      || partByCode.get(normalize(detail.partCode))
      || numberMatches[0]
      || null;
    const material = materialById.get(clean(detail.materialId))
      || materialByCode.get(normalize(detail.materialCode))
      || (part?.materialId ? materialById.get(part.materialId) : null)
      || null;
    const categoryHint = normalizeCategory(detail.procurementCategory || detail.prCategory || detail.itemCategory || detail.rawType);
    const category = categoryHint || (material ? "RAW_MATERIAL" : classifyPart(part));
    if (categoryHint === "RAW_MATERIAL" && part && classifyPart(part) === "PURCHASE_PART") {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part tidak dapat dicatat sebagai Raw Material.`), { statusCode: 400 });
    }
    if (categoryHint === "PURCHASE_PART" && part && classifyPart(part) === "RAW_MATERIAL") {
      throw Object.assign(new Error(`Baris ${line}: Part Material tidak dapat dicatat sebagai Purchase Part.`), { statusCode: 400 });
    }

    if (category === "RAW_MATERIAL" && !material) {
      throw Object.assign(new Error(`Baris ${line}: Raw Material wajib dipilih dari Material Master (contoh SPHC), atau Part Material harus memiliki relasi Material Master.`), { statusCode: 400 });
    }
    if (category === "PURCHASE_PART" && !part) {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part wajib dipilih dari Part Master.`), { statusCode: 400 });
    }
    if (category === "PURCHASE_PART" && !clean(part.partNumber)) {
      throw Object.assign(new Error(`Baris ${line}: Purchase Part ${part.partCode} belum memiliki Part Number/drawing code di Part Master.`), { statusCode: 409 });
    }

    const requestedQty = num(detail.qty, Number.NaN);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
      throw Object.assign(new Error(`Qty baris ${line} harus lebih dari 0.`), { statusCode: 400 });
    }
    const lotCount = detail.lotCount == null ? null : num(detail.lotCount, Number.NaN);
    const kgPerLot = detail.kgPerLot == null ? null : num(detail.kgPerLot, Number.NaN);
    if ((lotCount != null || kgPerLot != null) && category !== "RAW_MATERIAL") {
      throw Object.assign(new Error(`Baris ${line}: pengaturan lot hanya berlaku untuk Raw Material.`), { statusCode: 400 });
    }
    if ((lotCount != null || kgPerLot != null) && (!(lotCount > 0) || !(kgPerLot > 0))) {
      throw Object.assign(new Error(`Baris ${line}: jumlah lot dan KG per lot harus diisi bersama dan lebih dari 0.`), { statusCode: 400 });
    }
    const calculatedLotKg = lotCount && kgPerLot ? lotCount * kgPerLot : null;
    const requestedPurchaseQtyKg = detail.purchaseQtyKg == null ? null : num(detail.purchaseQtyKg, Number.NaN);
    if (requestedPurchaseQtyKg != null && (!Number.isFinite(requestedPurchaseQtyKg) || requestedPurchaseQtyKg <= 0)) {
      throw Object.assign(new Error(`Baris ${line}: purchaseQtyKg harus lebih dari 0.`), { statusCode: 400 });
    }
    if (calculatedLotKg != null && requestedPurchaseQtyKg != null && Math.abs(calculatedLotKg - requestedPurchaseQtyKg) > 1e-6) {
      throw Object.assign(new Error(`Baris ${line}: purchaseQtyKg harus sama dengan lotCount × kgPerLot (${calculatedLotKg} KG).`), { statusCode: 400 });
    }
    const purchaseQtyKg = calculatedLotKg ?? requestedPurchaseQtyKg;
    // UI manual raw-material may express qty as number of lots. PR demand is
    // normalized to KG; lotCount/kgPerLot remain as the commercial PO basis.
    const qty = category === "RAW_MATERIAL" && purchaseQtyKg != null ? purchaseQtyKg : requestedQty;
    const estimatedPrice = num(detail.estimatedPrice ?? detail.unitPrice);
    return {
      lineNumber: line,
      // For direct Material selection, do not misuse materialCode as partCode.
      // partCode remains an optional, validated trace back to the consuming part.
      partCode: category === "RAW_MATERIAL" ? (part?.partCode || null) : (part?.partCode || clean(detail.partCode)),
      partNumber: category === "RAW_MATERIAL" ? (part?.partNumber || null) : (part?.partNumber || clean(detail.partNumber)),
      partName: category === "RAW_MATERIAL" ? (part?.partName || null) : (part?.partName || clean(detail.partName)),
      materialId: material?.id || null,
      materialCode: material?.materialCode || null,
      materialName: material?.materialName || null,
      materialType: material?.materialType || null,
      // Product and Part use different tables/IDs. Never write Part.id into
      // productId for Material/Purchase Part lines (it would violate the FK).
      productId: ["RAW_MATERIAL", "PURCHASE_PART"].includes(category) ? null : clean(detail.productId),
      description: clean(detail.description),
      spec: category === "RAW_MATERIAL" ? (material?.spec || clean(detail.spec)) : clean(detail.spec),
      thickness: category === "RAW_MATERIAL" && material?.thickness != null ? num(material.thickness) : (detail.thickness == null ? null : num(detail.thickness)),
      width: category === "RAW_MATERIAL" && material?.width != null ? num(material.width) : (detail.width == null ? null : num(detail.width)),
      CSP: category === "RAW_MATERIAL" ? (material?.CSP || clean(detail.CSP)) : clean(detail.CSP),
      qty,
      uomCode: category === "RAW_MATERIAL" ? "KG" : (clean(detail.uomCode) || part?.purchaseUomCode || part?.baseUomCode || null),
      estimatedPrice,
      totalAmount: num(detail.totalAmount, qty * estimatedPrice),
      preferredSupplier: clean(detail.preferredSupplier),
      proposedSupplierCode: clean(detail.proposedSupplierCode || detail.supplierCode),
      supplierProposalSource: clean(detail.supplierProposalSource) || (detail.proposedSupplierCode || detail.supplierCode ? "PURCHASING" : null),
      lotCount,
      kgPerLot,
      purchaseQtyKg,
      lotAllocations: detail.lotAllocations || null,
      preferredVendor: clean(detail.preferredVendor),
      plannedOrderNumber: clean(detail.plannedOrderNumber),
      sourcePlannedOrderNumbers: detail.sourcePlannedOrderNumbers || null,
      notes: clean(detail.notes),
    };
  });

  const supplierCodes = [...new Set(rows.map((row) => row.proposedSupplierCode).filter(Boolean))];
  if (supplierCodes.length) {
    const suppliers = await client.supplier.findMany({
      where: { supplierCode: { in: supplierCodes }, isDeleted: false },
      select: { supplierCode: true },
    });
    const found = new Set(suppliers.map((supplier) => supplier.supplierCode));
    const missing = supplierCodes.filter((code) => !found.has(code));
    if (missing.length) throw Object.assign(new Error(`Supplier tidak ditemukan: ${missing.join(", ")}`), { statusCode: 400 });
  }
  return rows;
}

async function rawMaterialConversion(part, sourceUomCode, client) {
  if (isKg(sourceUomCode)) return { factor: 1, uomCode: "KG", source: "already kg" };
  const kgUom = await client.uom.findFirst({ where: { uomCode: { in: ["KG", "kg", "Kg", "KGS", "kgs"] }, isDeleted: false }, select: { uomCode: true } });
  const targetUomCode = kgUom?.uomCode || "KG";
  if (sourceUomCode) {
    const direct = await client.uomConversion.findFirst({
      where: { fromUomCode: sourceUomCode, toUomCode: targetUomCode, isActive: true },
      select: { factor: true },
    });
    if (num(direct?.factor) > 0) return { factor: num(direct.factor), uomCode: targetUomCode, source: "UOM Conversion Master" };
    const inverse = await client.uomConversion.findFirst({
      where: { fromUomCode: targetUomCode, toUomCode: sourceUomCode, isActive: true },
      select: { factor: true },
    });
    if (num(inverse?.factor) > 0) return { factor: 1 / num(inverse.factor), uomCode: targetUomCode, source: "UOM Conversion Master (inverse)" };
  }
  const grossWeight = num(preferredPartBase(part)?.grossWeight);
  if (grossWeight > 0) return { factor: grossWeight, uomCode: targetUomCode, source: "Part Base gross weight" };
  throw Object.assign(new Error(`Konversi ${part?.partCode || "raw material"} dari ${sourceUomCode || "UOM kosong"} ke KG belum tersedia. Isi UOM Conversion Master atau gross weight Part Base.`), { statusCode: 409 });
}
const withSummary = (row) => ({
  ...row,
  requestedQty: (row.details || []).reduce((sum, detail) => sum + num(detail.qty), 0),
  orderedQty: (row.details || []).reduce((sum, detail) => sum + num(detail.orderedQty), 0),
  lineCount: (row.details || []).length,
});

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1), limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 500);
    const q = String(req.query.q || req.query.search || "").trim();
    const where = {
      isDeleted: false,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.sourceType || req.query.source ? { sourceType: normalizeSourceType(req.query.sourceType || req.query.source) } : {}),
    };
    const category = normalize(req.query.category || req.query.procurementCategory || req.query.prType).replace(/[\s-]+/g, "_");
    if (["PURCHASE_PART", "RAW_MATERIAL"].includes(category)) {
      const rawType = category === "PURCHASE_PART" ? "PURCHASE_PART" : "MATERIAL";
      const matchingParts = await prisma.part.findMany({ where: { rawType, isDeleted: false }, select: { partCode: true } });
      where.details = category === "RAW_MATERIAL"
        ? { some: { isDeleted: false, OR: [{ materialCode: { not: null } }, { partCode: { in: matchingParts.map((part) => part.partCode) } }] } }
        : { some: { isDeleted: false, partCode: { in: matchingParts.map((part) => part.partCode) } } };
    } else if (category === "OTHER") {
      const purchaseParts = await prisma.part.findMany({ where: { rawType: "PURCHASE_PART", isDeleted: false }, select: { partCode: true } });
      where.details = {
        some: {
          isDeleted: false,
          OR: [
            { partCode: null },
            { partCode: { notIn: purchaseParts.map((part) => part.partCode) } },
          ],
        },
      };
    }
    if (q) where.OR = [
      ...["prNumber", "requestedBy", "priority", "poType", "sourceType", "notes"].map((k) => ({ [k]: { contains: q, mode: "insensitive" } })),
      { details: { some: { isDeleted: false, OR: ["partCode", "partNumber", "partName", "materialCode", "materialName", "materialType", "description"].map((k) => ({ [k]: { contains: q, mode: "insensitive" } })) } } },
    ];
    const [items, total] = await Promise.all([
      prisma.purchaseRequisition.findMany({ where, include, orderBy: { prDate: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.purchaseRequisition.count({ where }),
    ]);
    const classified = await attachProcurementClassification(items);
    res.json({ items: classified.map(withSummary), total, page, limit, category: category || "ALL" });
  } catch (e) { next(e); }
};
exports.get = async (req, res, next) => {
  try { const row = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false }, include }); if (!row) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); res.json(await attachProcurementClassification(row)); } catch (e) { next(e); }
};
exports.create = async (req, res, next) => {
  try {
    const input = bodyObject(req.body), header = bodyObject(input.header || input), details = Array.isArray(input.details) ? input.details : [];
    const requiredDate = date(header.requiredDate);
    if (header.requiredDate && (!requiredDate || Number.isNaN(requiredDate.getTime()))) return res.status(400).json({ message: "requiredDate tidak valid." });
    const prDate = date(header.prDate);
    if (header.prDate && (!prDate || Number.isNaN(prDate.getTime()))) return res.status(400).json({ message: "prDate tidak valid." });
    const result = await prisma.$transaction(async (tx) => {
      if (header.departmentId) {
        const department = await tx.department.findFirst({ where: { id: header.departmentId, isDeleted: false }, select: { id: true } });
        if (!department) throw Object.assign(new Error("Department tidak ditemukan atau sudah nonaktif."), { statusCode: 400 });
      }
      const prNumber = await generateDocNumber("purchaseRequisition", "PR", "prNumber", tx);
      const rows = await normalizeRequisitionDetails(details, tx);
      const totalAmount = rows.reduce((s, d) => s + d.totalAmount, 0);
      return tx.purchaseRequisition.create({ data: { prNumber, prDate: prDate || new Date(), requestedBy: header.requestedBy || req.user?.username || req.user?.email || null, departmentId: header.departmentId || null, requiredDate: requiredDate || new Date(), priority: header.priority || "Normal", poType: header.poType || "Other", sourceType: normalizeSourceType(header.sourceType || input.sourceType || "MANUAL"), totalAmount, notes: header.notes || null, details: { create: rows } }, include });
    });
    res.status(201).json(await attachProcurementClassification(result));
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
exports.update = async (req, res, next) => {
  try {
    const current = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } });
    if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revision Required", "Rejected"].includes(current.status)) return res.status(409).json({ message: "PR hanya dapat diedit saat Draft/Revision Required." });
    const input = bodyObject(req.body), header = bodyObject(input.header || input);
    const data = {}; ["requestedBy", "departmentId", "priority", "poType", "notes"].forEach((k) => { if (header[k] !== undefined) data[k] = header[k]; });
    if (header.departmentId !== undefined) data.departmentId = clean(header.departmentId);
    if (header.sourceType !== undefined && normalizeSourceType(header.sourceType) !== current.sourceType) return res.status(409).json({ message: "sourceType PR tidak dapat diubah setelah dokumen dibuat." });
    if (header.prDate !== undefined) {
      data.prDate = date(header.prDate);
      if (!data.prDate || Number.isNaN(data.prDate.getTime())) return res.status(400).json({ message: "prDate tidak valid." });
    }
    if (header.requiredDate !== undefined) {
      data.requiredDate = date(header.requiredDate);
      if (!data.requiredDate || Number.isNaN(data.requiredDate.getTime())) return res.status(400).json({ message: "requiredDate tidak valid." });
    }
    const details = Array.isArray(input.details) ? input.details : null;
    const result = await prisma.$transaction(async (tx) => {
      if (data.departmentId) {
        const department = await tx.department.findFirst({ where: { id: data.departmentId, isDeleted: false }, select: { id: true } });
        if (!department) throw Object.assign(new Error("Department tidak ditemukan atau sudah nonaktif."), { statusCode: 400 });
      }
      if (details) {
        const rows = (await normalizeRequisitionDetails(details, tx)).map((row) => ({ ...row, prNumber: current.prNumber }));
        await tx.purchaseRequisitionDetail.updateMany({ where: { prNumber: current.prNumber }, data: { isDeleted: true } });
        data.totalAmount = rows.reduce((s, r) => s + r.totalAmount, 0);
        await tx.purchaseRequisitionDetail.createMany({ data: rows });
      }
      return tx.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data, include });
    });
    res.json(await attachProcurementClassification(result));
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
exports.submit = async (req, res, next) => {
  try {
    const pr = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Draft", "Revision Required", "Rejected"].includes(pr.status)) return res.status(409).json({ message: `PR berstatus ${pr.status} tidak dapat disubmit.` });
    const rule = await resolveApprovalRule({ moduleCode: "purchasing", pageCode: "purchase-requisitions", actionCode: "approve", documentType: "PurchaseRequisition", amount: pr.totalAmount, context: pr });
    let request = null;
    if (rule) request = await createApprovalRequest({ rule, moduleCode: "purchasing", pageCode: "purchase-requisitions", actionCode: "approve", documentType: "PurchaseRequisition", documentId: pr.id, documentNumber: pr.prNumber, amount: pr.totalAmount, requestedByUserId: req.user?.id, requestedBy: req.user?.username || req.user?.email });
    const updated = await prisma.purchaseRequisition.update({ where: { prNumber: pr.prNumber }, data: { status: "Submitted" }, include });
    res.json({ ...updated, approvalRequest: request });
  } catch (e) { next(e); }
};
exports.approve = async (req, res, next) => { try { const current = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } }); if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); if (current.status !== "Submitted") return res.status(409).json({ message: `PR berstatus ${current.status} tidak dapat di-approve.` }); const pr = await prisma.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data: { status: "Approved", approvedBy: req.user?.username || req.user?.email || "system", approvedDate: new Date(), rejectedBy: null, rejectedDate: null, rejectionReason: null }, include }); res.json(pr); } catch (e) { next(e); } };
exports.reject = async (req, res, next) => { try { const reason = String(req.body?.reason || req.body?.rejectionReason || req.body?.notes || "").trim(); if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi." }); const current = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false } }); if (!current) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." }); if (current.status !== "Submitted") return res.status(409).json({ message: `PR berstatus ${current.status} tidak dapat ditolak.` }); const pr = await prisma.purchaseRequisition.update({ where: { prNumber: current.prNumber }, data: { status: "Rejected", rejectedBy: req.user?.username || req.user?.email || "system", rejectedDate: new Date(), rejectionReason: reason }, include }); res.json(pr); } catch (e) { next(e); } };
exports.remove = async (req, res, next) => { try { await prisma.purchaseRequisition.update({ where: { prNumber: req.params.prNumber }, data: { isDeleted: true } }); res.json({ ok: true }); } catch (e) { next(e); } };

/**
 * Purchasing supplier confirmation is deliberately separate from the supplier
 * proposal made by PPIC/MRP. Only outstanding lines are mutable so an existing
 * PO always keeps the supplier decision that was used when it was created.
 */
exports.confirmSuppliers = async (req, res, next) => {
  try {
    const input = bodyObject(req.body);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!lines.length) return res.status(400).json({ message: "Minimal satu detail supplier harus dikonfirmasi." });
    const pr = await prisma.purchaseRequisition.findFirst({
      where: { prNumber: req.params.prNumber, isDeleted: false },
      include: { details: { where: { isDeleted: false } } },
    });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Approved", "Partially Ordered"].includes(pr.status)) {
      return res.status(409).json({ message: "Supplier Purchasing hanya dapat dikonfirmasi setelah PR Approved." });
    }

    const byId = new Map(pr.details.map((row) => [row.id, row]));
    const normalizedLines = lines.map((line) => {
      const detail = byId.get(String(line?.prDetailId || line?.id || ""));
      if (!detail) throw Object.assign(new Error("Detail PR yang akan dikonfirmasi tidak ditemukan."), { statusCode: 400 });
      if (num(detail.orderedQty) >= num(detail.qty)) throw Object.assign(new Error(`Baris ${detail.lineNumber} sudah seluruhnya masuk PO.`), { statusCode: 409 });
      const supplierCode = String(line?.supplierCode || line?.confirmedSupplierCode || "").trim();
      if (!supplierCode) throw Object.assign(new Error(`Supplier baris ${detail.lineNumber} wajib diisi.`), { statusCode: 400 });
      return { detail, supplierCode };
    });
    const supplierCodes = [...new Set(normalizedLines.map((row) => row.supplierCode))];
    const suppliers = await prisma.supplier.findMany({
      where: { supplierCode: { in: supplierCodes }, isDeleted: false },
      select: { supplierCode: true, supplierName: true },
    });
    const supplierByCode = new Map(suppliers.map((row) => [row.supplierCode, row]));
    const missing = supplierCodes.filter((code) => !supplierByCode.has(code));
    if (missing.length) return res.status(400).json({ message: `Supplier tidak ditemukan: ${missing.join(", ")}` });

    const confirmedAt = new Date();
    const confirmedBy = actor(req);
    const result = await prisma.$transaction(async (tx) => {
      for (const row of normalizedLines) {
        await tx.purchaseRequisitionDetail.update({
          where: { id: row.detail.id },
          data: {
            confirmedSupplierCode: row.supplierCode,
            supplierConfirmedBy: confirmedBy,
            supplierConfirmedAt: confirmedAt,
          },
        });
      }
      return tx.purchaseRequisition.findUnique({ where: { prNumber: pr.prNumber }, include });
    });
    res.json({
      ...(await attachProcurementClassification(result)),
      supplierConfirmation: { confirmedBy, confirmedAt, lineCount: normalizedLines.length },
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

/**
 * Consolidate outstanding lines from multiple approved PRs. Grouping is based
 * on the commercial PO header (supplier/vendor, currency and delivery date),
 * never on MRP run, planned order, customer, or parent FG.
 */
exports.consolidateToPO = async (req, res, next) => {
  try {
    const input = bodyObject(req.body);
    const requestedLines = Array.isArray(input.lines) ? input.lines : [];
    if (!requestedLines.length) return res.status(400).json({ message: "Minimal satu detail PR harus dipilih." });
    const ids = [...new Set(requestedLines.map((line) => String(line?.prDetailId || line?.id || "")).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ message: "prDetailId wajib diisi pada setiap baris." });

    const detailRows = await prisma.purchaseRequisitionDetail.findMany({
      where: { id: { in: ids }, isDeleted: false },
      include: { pr: true },
    });
    const detailById = new Map(detailRows.map((row) => [row.id, row]));
    if (detailRows.length !== ids.length) return res.status(400).json({ message: "Sebagian detail PR tidak ditemukan." });
    const invalidPr = detailRows.find((row) => !["Approved", "Partially Ordered"].includes(row.pr.status));
    if (invalidPr) return res.status(409).json({ message: `${invalidPr.prNumber} belum Approved atau sudah selesai.` });

    const normalizedLines = requestedLines.map((requestLine) => {
      const detail = detailById.get(String(requestLine?.prDetailId || requestLine?.id || ""));
      const outstanding = num(detail.qty) - num(detail.orderedQty);
      const sourceQty = requestLine.sourceQty == null && requestLine.qty == null
        ? outstanding
        : num(requestLine.sourceQty ?? requestLine.qty);
      if (sourceQty <= 0 || sourceQty > outstanding + 1e-9) {
        throw Object.assign(new Error(`Qty baris ${detail.prNumber}/${detail.lineNumber} melebihi outstanding ${outstanding}.`), { statusCode: 409 });
      }
      const supplierCode = String(requestLine.supplierCode || detail.confirmedSupplierCode || "").trim();
      const vendorCode = String(requestLine.vendorCode || detail.preferredVendor || "").trim();
      if (!supplierCode && !vendorCode) {
        throw Object.assign(new Error(`Supplier Purchasing baris ${detail.prNumber}/${detail.lineNumber} belum dikonfirmasi.`), { statusCode: 409 });
      }
      if (supplierCode && vendorCode) {
        throw Object.assign(new Error(`Baris ${detail.prNumber}/${detail.lineNumber} tidak boleh memiliki supplier dan vendor sekaligus.`), { statusCode: 400 });
      }
      const currencyCode = String(requestLine.currencyCode || input.currencyCode || "IDR").trim().toUpperCase();
      const deliveryDate = dayKey(requestLine.deliveryDate || input.deliveryDate || detail.pr.requiredDate);
      const targetPoNumber = String(requestLine.targetPoNumber || input.targetPoNumber || "").trim() || null;
      return { requestLine, detail, sourceQty, supplierCode: supplierCode || null, vendorCode: vendorCode || null, currencyCode, deliveryDate, targetPoNumber };
    });

    const supplierCodes = [...new Set(normalizedLines.map((row) => row.supplierCode).filter(Boolean))];
    const vendorCodes = [...new Set(normalizedLines.map((row) => row.vendorCode).filter(Boolean))];
    const [suppliers, vendors] = await Promise.all([
      supplierCodes.length ? prisma.supplier.findMany({ where: { supplierCode: { in: supplierCodes }, isDeleted: false }, select: { supplierCode: true, supplierName: true } }) : [],
      vendorCodes.length ? prisma.vendor.findMany({ where: { vendorCode: { in: vendorCodes }, isDeleted: false }, select: { vendorCode: true, vendorName: true } }) : [],
    ]);
    const supplierByCode = new Map(suppliers.map((row) => [row.supplierCode, row]));
    const vendorByCode = new Map(vendors.map((row) => [row.vendorCode, row]));
    const unknownPartner = normalizedLines.find((row) => (row.supplierCode && !supplierByCode.has(row.supplierCode)) || (row.vendorCode && !vendorByCode.has(row.vendorCode)));
    if (unknownPartner) return res.status(400).json({ message: `Supplier/vendor tidak ditemukan: ${unknownPartner.supplierCode || unknownPartner.vendorCode}` });

    const result = await prisma.$transaction(async (tx) => {
      const groups = new Map();
      for (const row of normalizedLines) {
        // Explicit PO targets form their own group; otherwise use compatible
        // commercial header values. MRP/FG references are intentionally absent.
        const key = row.targetPoNumber
          ? `PO:${row.targetPoNumber}`
          : [row.supplierCode || "", row.vendorCode || "", row.currencyCode, row.deliveryDate].join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const purchaseOrders = [];
      for (const groupRows of groups.values()) {
        const first = groupRows[0];
        const target = first.targetPoNumber
          ? await tx.purchaseOrder.findFirst({ where: { poNumber: first.targetPoNumber, isDeleted: false } })
          : null;
        if (first.targetPoNumber && !target) throw Object.assign(new Error(`PO tujuan ${first.targetPoNumber} tidak ditemukan.`), { statusCode: 404 });
        if (target && target.status !== "Draft") throw Object.assign(new Error(`PO tujuan ${target.poNumber} harus berstatus Draft.`), { statusCode: 409 });
        if (target && ((target.supplierCode || null) !== first.supplierCode || (target.vendorCode || null) !== first.vendorCode)) {
          throw Object.assign(new Error(`Supplier/vendor tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (target && normalize(target.currencyCode) !== normalize(first.currencyCode)) {
          throw Object.assign(new Error(`Currency tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (target && dayKey(target.deliveryDate) !== first.deliveryDate) {
          throw Object.assign(new Error(`Delivery date tidak cocok dengan PO tujuan ${target.poNumber}.`), { statusCode: 409 });
        }
        if (groupRows.some((row) => row.supplierCode !== first.supplierCode || row.vendorCode !== first.vendorCode || row.currencyCode !== first.currencyCode || row.deliveryDate !== first.deliveryDate)) {
          throw Object.assign(new Error(`Baris untuk PO ${target?.poNumber || "baru"} memiliki header komersial yang tidak kompatibel.`), { statusCode: 409 });
        }

        const prepared = [];
        for (const row of groupRows) {
          const detail = row.detail;
          const explicitOrderUom = row.requestLine.orderUomCode || row.requestLine.poUomCode;
          const explicitOrderQty = num(row.requestLine.orderQty ?? row.requestLine.poQty, 0);
          let poQty = row.sourceQty;
          let poUom = detail.uomCode;
          let conversionSource = null;
          if (explicitOrderUom && explicitOrderQty > 0) {
            poQty = explicitOrderQty;
            poUom = explicitOrderUom;
            conversionSource = "Purchasing confirmation";
          } else if (num(detail.lotCount) > 0 && num(detail.kgPerLot) > 0) {
            // PR outstanding is tracked in KG. Derive PO lots from the actual
            // selected KG so partial consolidation cannot duplicate all lots.
            poQty = row.sourceQty / num(detail.kgPerLot);
            poUom = "LOT";
            conversionSource = `${num(detail.kgPerLot)} KG/LOT`;
          }
          const totalAmount = row.sourceQty >= num(detail.qty) - num(detail.orderedQty) - 1e-9
            ? num(detail.estimatedPrice) * row.sourceQty
            : num(detail.estimatedPrice) * row.sourceQty;
          const unitPrice = poQty > 0 ? totalAmount / poQty : 0;
          prepared.push({
            sourceQty: row.sourceQty,
            detail,
            data: {
              prDetailId: detail.id,
              productId: detail.productId,
              partCode: detail.partCode,
              partNumber: detail.partNumber,
              partName: detail.partName,
              materialId: detail.materialId,
              materialCode: detail.materialCode,
              materialName: detail.materialName,
              materialType: detail.materialType,
              description: detail.description,
              spec: detail.spec,
              thickness: detail.thickness,
              width: detail.width,
              CSP: detail.CSP,
              qty: poQty,
              uomCode: poUom,
              unitPrice,
              totalAmount,
              deliveryDate: date(row.deliveryDate),
              notes: conversionSource
                ? `${detail.notes || ""}${detail.notes ? "; " : ""}${conversionSource}; source demand ${row.sourceQty} ${detail.uomCode || "unit"}`
                : detail.notes,
            },
          });
        }
        const amount = prepared.reduce((sum, row) => sum + row.data.totalAmount, 0);
        const prNumbers = [...new Set(prepared.map((row) => row.detail.prNumber))];
        const poTypes = [...new Set(prepared.map((row) => row.detail.pr.poType).filter(Boolean))];
        let po;
        if (target) {
          const lastLine = await tx.purchaseOrderDetail.findFirst({ where: { poNumber: target.poNumber }, orderBy: { lineNumber: "desc" }, select: { lineNumber: true } });
          await tx.purchaseOrderDetail.createMany({ data: prepared.map((row, index) => ({ ...row.data, poNumber: target.poNumber, lineNumber: num(lastLine?.lineNumber) + index + 1 })) });
          for (const prNumber of prNumbers) await tx.purchaseOrderPR.upsert({ where: { poNumber_prNumber: { poNumber: target.poNumber, prNumber } }, create: { poNumber: target.poNumber, prNumber }, update: {} });
          await tx.purchaseOrderComment.create({ data: { poNumber: target.poNumber, type: "pr-consolidation", message: `Added ${prepared.length} line(s) from ${prNumbers.join(", ")}; grouped by supplier/currency/delivery`, createdBy: actor(req), userId: req.user?.id || null } });
          po = await tx.purchaseOrder.update({ where: { poNumber: target.poNumber }, data: { totalAmount: { increment: amount } }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true } });
        } else {
          const poNumber = await generatePONumber(poTypes.length === 1 ? poTypes[0] : "Mixed", tx, input.poNumberPrefix, first.supplierCode || first.vendorCode);
          po = await tx.purchaseOrder.create({
            data: {
              poNumber,
              poDate: new Date(),
              supplierCode: first.supplierCode,
              supplierName: supplierByCode.get(first.supplierCode)?.supplierName || null,
              vendorCode: first.vendorCode,
              vendorName: vendorByCode.get(first.vendorCode)?.vendorName || null,
              deliveryDate: date(first.deliveryDate),
              poType: poTypes.length === 1 ? poTypes[0] : "Mixed",
              currencyCode: first.currencyCode,
              status: "Draft",
              totalAmount: amount,
              notes: input.notes || `Consolidated from ${prNumbers.join(", ")}`,
              createdBy: actor(req),
              purchaseRequisitions: { create: prNumbers.map((prNumber) => ({ prNumber })) },
              comments: { create: { type: "pr-consolidation", message: `Created from ${prNumbers.join(", ")}; grouping independent of MRP/FG`, createdBy: actor(req), userId: req.user?.id || null } },
              details: { create: prepared.map((row, index) => ({ ...row.data, lineNumber: index + 1 })) },
            },
            include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
          });
        }

        for (const row of prepared) {
          await tx.purchaseRequisitionDetail.update({
            where: { id: row.detail.id },
            data: {
              orderedQty: { increment: row.sourceQty },
              confirmedSupplierCode: first.supplierCode,
              supplierConfirmedBy: actor(req),
              supplierConfirmedAt: new Date(),
            },
          });
        }
        purchaseOrders.push(po);
      }

      const affectedPrNumbers = [...new Set(normalizedLines.map((row) => row.detail.prNumber))];
      const prStatuses = [];
      for (const prNumber of affectedPrNumbers) {
        const details = await tx.purchaseRequisitionDetail.findMany({ where: { prNumber, isDeleted: false }, select: { qty: true, orderedQty: true } });
        const hasOutstanding = details.some((row) => num(row.qty) > num(row.orderedQty) + 1e-9);
        const relatedPOs = purchaseOrders.filter((po) => po.purchaseRequisitions?.some((link) => link.prNumber === prNumber));
        await tx.purchaseRequisition.update({ where: { prNumber }, data: { status: hasOutstanding ? "Partially Ordered" : "Completed", convertedToPO: relatedPOs.at(-1)?.poNumber || undefined } });
        prStatuses.push({ prNumber, status: hasOutstanding ? "Partially Ordered" : "Completed" });
      }
      return { purchaseOrders, prStatuses };
    });
    res.status(201).json({
      ...result,
      poCount: result.purchaseOrders.length,
      grouping: "SUPPLIER_CURRENCY_DELIVERY",
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.convertToPO = async (req, res, next) => {
  try {
    const input = bodyObject(req.body), pr = await prisma.purchaseRequisition.findFirst({ where: { prNumber: req.params.prNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
    if (!pr) return res.status(404).json({ message: "Purchase Requisition tidak ditemukan." });
    if (!["Approved", "Partially Ordered"].includes(pr.status)) return res.status(409).json({ message: "PR harus Approved sebelum dipindahkan ke PO." });
    const requestedTargetPo = input.targetPoNumber || input.existingPoNumber || input.poNumber || null;
    const result = await prisma.$transaction(async (tx) => {
      const requestedDetailIds = Array.isArray(input.detailIds)
        ? input.detailIds.map(String)
        : Array.isArray(input.prDetailIds)
          ? input.prDetailIds.map(String)
          : Array.isArray(input.lines)
            ? input.lines.map((line) => String(line?.prDetailId || line?.id || "")).filter(Boolean)
            : [];
      const outstanding = pr.details.filter((detail) => num(detail.qty) > num(detail.orderedQty)
        && (!requestedDetailIds.length || requestedDetailIds.includes(detail.id)));
      if (!outstanding.length) throw Object.assign(new Error(requestedDetailIds.length ? "Detail PR terpilih tidak ditemukan atau sudah dipesan." : "Seluruh detail PR sudah dipesan."), { statusCode: requestedDetailIds.length ? 400 : 409 });
      const confirmedSuppliers = [...new Set(outstanding.map((detail) => detail.confirmedSupplierCode).filter(Boolean))];
      if (!input.supplierCode && confirmedSuppliers.length > 1) {
        throw Object.assign(new Error("Detail terpilih memiliki supplier Purchasing berbeda. Gunakan konsolidasi lintas PR agar PO otomatis dipisah per supplier."), { statusCode: 409 });
      }

      const partCodes = [...new Set(outstanding.map((detail) => detail.partCode).filter(Boolean))];
      const parts = partCodes.length ? await tx.part.findMany({
        where: { partCode: { in: partCodes }, isDeleted: false },
        select: { id: true, partCode: true, rawType: true, itemType: true, partBases: true },
      }) : [];
      const partByCode = new Map(parts.map((part) => [normalize(part.partCode), part]));
      const preparedRows = [];
      for (const detail of outstanding) {
        const sourceQty = num(detail.qty) - num(detail.orderedQty);
        const part = partByCode.get(normalize(detail.partCode));
        const category = detail.materialCode ? "RAW_MATERIAL" : classifyPart(part);
        const hasLotPlan = category === "RAW_MATERIAL" && num(detail.kgPerLot) > 0;
        const conversion = hasLotPlan
          ? { factor: 1 / num(detail.kgPerLot), uomCode: "LOT", source: `${num(detail.kgPerLot)} KG/LOT` }
          : category === "RAW_MATERIAL"
            ? await rawMaterialConversion(part, detail.uomCode, tx)
            : { factor: 1, uomCode: detail.uomCode, source: null };
        const poQty = sourceQty * conversion.factor;
        const sourceAmount = num(detail.estimatedPrice) * sourceQty;
        const unitPrice = poQty > 0 ? sourceAmount / poQty : 0;
        preparedRows.push({
          sourceQty,
          conversionSource: conversion.source,
          data: {
            prDetailId: detail.id,
            productId: detail.productId,
            partCode: detail.partCode,
            partNumber: detail.partNumber,
            partName: detail.partName,
            materialId: detail.materialId,
            materialCode: detail.materialCode,
            materialName: detail.materialName,
            materialType: detail.materialType,
            description: detail.description,
            spec: detail.spec,
            thickness: detail.thickness,
            width: detail.width,
            CSP: detail.CSP,
            qty: poQty,
            uomCode: conversion.uomCode,
            unitPrice,
            totalAmount: sourceAmount,
            deliveryDate: date(input.deliveryDate) || pr.requiredDate,
            notes: conversion.source ? `${detail.notes || ""}${detail.notes ? "; " : ""}${hasLotPlan ? "Purchased by lot" : "Converted to KG"} via ${conversion.source}; source ${sourceQty} ${detail.uomCode || "unit"}` : detail.notes,
          },
        });
      }

      let po;
      if (requestedTargetPo) {
        const target = await tx.purchaseOrder.findFirst({ where: { poNumber: requestedTargetPo, isDeleted: false } });
        if (!target) throw Object.assign(new Error(`PO tujuan ${requestedTargetPo} tidak ditemukan.`), { statusCode: 404 });
        if (target.status !== "Draft") throw Object.assign(new Error("Konsolidasi PR hanya dapat dilakukan ke PO berstatus Draft."), { statusCode: 409 });
        const requestedSupplier = input.supplierCode
          || outstanding.find((detail) => detail.confirmedSupplierCode)?.confirmedSupplierCode
          || outstanding.find((detail) => detail.proposedSupplierCode)?.proposedSupplierCode
          || outstanding.find((detail) => detail.preferredSupplier)?.preferredSupplier
          || null;
        const requestedVendor = input.vendorCode || pr.details.find((detail) => detail.preferredVendor)?.preferredVendor || null;
        if (requestedSupplier && target.supplierCode && requestedSupplier !== target.supplierCode) throw Object.assign(new Error("Supplier PR berbeda dengan supplier PO tujuan."), { statusCode: 409 });
        if (requestedVendor && target.vendorCode && requestedVendor !== target.vendorCode) throw Object.assign(new Error("Vendor PR berbeda dengan vendor PO tujuan."), { statusCode: 409 });
        if (input.currencyCode && target.currencyCode !== input.currencyCode) throw Object.assign(new Error("Currency PR berbeda dengan currency PO tujuan."), { statusCode: 409 });
        const lastLine = await tx.purchaseOrderDetail.findFirst({ where: { poNumber: target.poNumber }, orderBy: { lineNumber: "desc" }, select: { lineNumber: true } });
        await tx.purchaseOrderDetail.createMany({ data: preparedRows.map((row, index) => ({ ...row.data, poNumber: target.poNumber, lineNumber: num(lastLine?.lineNumber) + index + 1 })) });
        await tx.purchaseOrderPR.upsert({
          where: { poNumber_prNumber: { poNumber: target.poNumber, prNumber: pr.prNumber } },
          create: { poNumber: target.poNumber, prNumber: pr.prNumber },
          update: {},
        });
        po = await tx.purchaseOrder.update({
          where: { poNumber: target.poNumber },
          data: {
            totalAmount: { increment: preparedRows.reduce((sum, row) => sum + row.data.totalAmount, 0) },
            ...(!target.supplierCode && requestedSupplier ? { supplierCode: requestedSupplier, supplierName: input.supplierName || target.supplierName } : {}),
            ...(!target.vendorCode && requestedVendor ? { vendorCode: requestedVendor, vendorName: input.vendorName || target.vendorName } : {}),
          },
          include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
        });
      } else {
        const supplierCode = input.supplierCode
          || outstanding.find((detail) => detail.confirmedSupplierCode)?.confirmedSupplierCode
          || outstanding.find((detail) => detail.proposedSupplierCode)?.proposedSupplierCode
          || outstanding.find((detail) => detail.preferredSupplier)?.preferredSupplier;
        if (!supplierCode && !input.vendorCode) throw Object.assign(new Error("supplierCode atau vendorCode wajib diisi."), { statusCode: 400 });
        const poNumber = await generatePONumber(pr.poType, tx, input.poNumberPrefix, supplierCode || input.vendorCode);
        po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            poDate: new Date(),
            supplierCode: supplierCode || null,
            supplierName: input.supplierName || null,
            vendorCode: input.vendorCode || null,
            vendorName: input.vendorName || null,
            deliveryDate: date(input.deliveryDate) || pr.requiredDate,
            poType: pr.poType,
            currencyCode: input.currencyCode || "IDR",
            status: "Draft",
            totalAmount: preparedRows.reduce((sum, row) => sum + row.data.totalAmount, 0),
            notes: input.notes || `Converted from ${pr.prNumber}`,
            createdBy: req.user?.username || req.user?.email || null,
            purchaseRequisitions: { create: { prNumber: pr.prNumber } },
            details: { create: preparedRows.map((row, index) => ({ ...row.data, lineNumber: index + 1 })) },
          },
          include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, purchaseRequisitions: true },
        });
      }
      for (const row of preparedRows) await tx.purchaseRequisitionDetail.update({ where: { id: row.data.prDetailId }, data: { orderedQty: { increment: row.sourceQty } } });
      const refreshedDetails = await tx.purchaseRequisitionDetail.findMany({ where: { prNumber: pr.prNumber, isDeleted: false }, select: { qty: true, orderedQty: true } });
      const hasOutstanding = refreshedDetails.some((detail) => num(detail.qty) > num(detail.orderedQty));
      await tx.purchaseRequisition.update({ where: { prNumber: pr.prNumber }, data: { status: hasOutstanding ? "Partially Ordered" : "Completed", convertedToPO: po.poNumber } });
      return {
        ...po,
        consolidated: Boolean(requestedTargetPo),
        prStatus: hasOutstanding ? "Partially Ordered" : "Completed",
        processedDetailIds: preparedRows.map((row) => row.data.prDetailId),
        conversionSummary: preparedRows.filter((row) => row.conversionSource).map((row) => ({ prDetailId: row.data.prDetailId, qty: row.data.qty, uomCode: row.data.uomCode, source: row.conversionSource })),
      };
    });
    res.status(requestedTargetPo ? 200 : 201).json(result);
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ message: e.message }); next(e); }
};
