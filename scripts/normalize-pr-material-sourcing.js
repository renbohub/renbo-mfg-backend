const { prisma } = require("../src/prisma");

const text = (value) => String(value || "").trim();
const upper = (value) => text(value).toUpperCase();
const number = (value) => Number(value || 0);

async function resolveNormalization(prNumber, materialCode) {
  const requisition = await prisma.purchaseRequisition.findFirst({
    where: { prNumber, isDeleted: false },
    include: {
      purchaseOrders: { select: { poNumber: true } },
      details: {
        where: { materialCode, isDeleted: false },
        include: {
          sources: { where: { isDeleted: false } },
          sourcingAllocations: { where: { isDeleted: false } },
        },
      },
    },
  });
  if (!requisition) throw new Error(`PR ${prNumber} tidak ditemukan.`);
  if (requisition.details.length !== 1) throw new Error(`Material ${materialCode} harus ditemukan tepat satu baris pada ${prNumber}.`);
  if (requisition.purchaseOrders.length || number(requisition.details[0].orderedQty) > 0) {
    throw new Error(`${prNumber} sudah terhubung ke PO dan tidak aman dinormalisasi.`);
  }

  const detail = requisition.details[0];
  const sourceMetadata = detail.sources.map((row) => row.metadata || {}).find((row) => row.purchaseSuggestionItemId);
  const suggestionItem = sourceMetadata?.purchaseSuggestionItemId
    ? await prisma.purchaseSuggestionItem.findUnique({
        where: { id: sourceMetadata.purchaseSuggestionItemId },
        include: { supplierAllocations: { where: { isDeleted: false } } },
      })
    : null;
  const requirementId = suggestionItem?.mrpRequirementId;
  const requirement = requirementId
    ? await prisma.mRPRequirement.findUnique({
        where: { id: requirementId },
        include: { mbomDetail: { include: { materialForm: true } } },
      })
    : null;
  const material = await prisma.material.findFirst({ where: { id: detail.materialId, isDeleted: false } });
  const form = upper(suggestionItem?.purchasePackageUomCode || requirement?.mbomDetail?.materialForm?.formCode || material?.defaultPurchaseUomCode || material?.materialForm);
  const width = number(suggestionItem?.confirmedMaterialWidth || detail.width || requirement?.mbomDetail?.materialWidth || material?.width);
  const length = form === "SHEET" ? number(suggestionItem?.confirmedMaterialLength || detail.materialLength) : null;
  if (!["COIL", "SHEET", "PCS"].includes(form)) throw new Error(`Bentuk material ${materialCode} tidak dapat ditentukan dari Purchase Suggestion/MBOM/Master Material.`);
  if (width <= 0) throw new Error(`Lebar material ${materialCode} tidak dapat ditentukan.`);
  if (form === "SHEET" && !length) throw new Error(`Panjang SHEET ${materialCode} belum tersedia dan tidak boleh ditebak.`);

  const supplierCode = detail.confirmedSupplierCode || detail.proposedSupplierCode || suggestionItem?.alternativeSupplierCode || suggestionItem?.suggestedSupplierCode;
  if (!supplierCode) throw new Error(`Supplier ${materialCode} belum tersedia.`);
  const qty = number(detail.qty);
  return {
    requisition,
    detail,
    suggestionItem,
    requirement,
    material,
    normalized: {
      form,
      width,
      length,
      supplierCode,
      supplierName: suggestionItem?.suggestedSupplierName || null,
      qty,
      uomCode: detail.uomCode || suggestionItem?.uomCode || "KG",
      deliveryDate: suggestionItem?.confirmedDeliveryDate || requisition.requiredDate,
      currencyCode: suggestionItem?.currencyCode || "IDR",
      unitPrice: number(suggestionItem?.estimatedUnitPrice || detail.estimatedPrice),
      symbol: ({ COIL: "C", SHEET: "S", PCS: "P" })[form],
    },
  };
}

async function applyNormalization(result) {
  const { detail, suggestionItem, requirement, material, normalized } = result;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    if (suggestionItem) {
      await tx.purchaseSuggestionItem.update({
        where: { id: suggestionItem.id },
        data: {
          purchasePackageUomCode: normalized.form,
          confirmedMaterialWidth: normalized.width,
          confirmedMaterialLength: normalized.length,
        },
      });
      if (!suggestionItem.supplierAllocations.length) {
        await tx.purchaseSuggestionSupplierAllocation.create({
          data: {
            suggestionItemId: suggestionItem.id,
            supplierCode: normalized.supplierCode,
            supplierName: normalized.supplierName,
            confirmationStatus: suggestionItem.confirmationStatus || "Available",
            offeredQty: normalized.qty,
            confirmedQty: normalized.qty,
            deliveryDate: normalized.deliveryDate,
            moq: suggestionItem.confirmedMoq ?? suggestionItem.moq,
            orderMultiple: suggestionItem.orderMultiple,
            leadTimeDays: suggestionItem.confirmedLeadTimeDays ?? suggestionItem.purchasingLeadTimeDays,
            unitPrice: normalized.unitPrice,
            currencyCode: normalized.currencyCode,
            materialWidth: normalized.width,
            materialLength: normalized.length,
            purchasePackageUomCode: normalized.form,
            confirmedBy: suggestionItem.supplierConfirmedBy || "data-normalization",
            confirmedAt: now,
            status: "Confirmed",
          },
        });
      }
    }

    await tx.purchaseRequisitionDetail.update({
      where: { id: detail.id },
      data: {
        materialType: detail.materialType || material?.materialType || null,
        spec: detail.spec || material?.spec || null,
        thickness: detail.thickness || requirement?.mbomDetail?.materialThickness || material?.thickness || null,
        width: normalized.width,
        materialLength: normalized.length,
        CSP: normalized.symbol,
        purchasePackageUomCode: normalized.form,
        purchaseQtyKg: upper(normalized.uomCode) === "KG" ? normalized.qty : detail.purchaseQtyKg,
        recommendedPurchaseForms: [{
          formCode: normalized.form,
          formName: requirement?.mbomDetail?.materialForm?.formName || normalized.form,
          symbol: normalized.symbol,
        }],
        notes: [detail.notes, `Normalized sourcing: ${normalized.form}, width ${normalized.width} mm`].filter(Boolean).join(" | "),
      },
    });

    if (!detail.sourcingAllocations.length) {
      await tx.purchaseRequisitionSourcingAllocation.create({
        data: {
          prDetailId: detail.id,
          supplierCode: normalized.supplierCode,
          demandCoveredQty: normalized.qty,
          demandUomCode: normalized.uomCode,
          purchasePackageUomCode: normalized.form,
          materialWidth: normalized.width,
          materialLength: normalized.length,
          deliveryDate: normalized.deliveryDate,
          currencyCode: normalized.currencyCode,
          unitPrice: normalized.unitPrice,
          totalAmount: normalized.qty * normalized.unitPrice,
          status: "Confirmed",
          confirmedBy: "data-normalization",
          confirmedAt: now,
          notes: "Normalized from Purchase Suggestion and MBOM material form.",
        },
      });
    }

    return tx.purchaseRequisition.findUnique({
      where: { prNumber: result.requisition.prNumber },
      include: { details: { include: { sourcingAllocations: { where: { isDeleted: false } } } } },
    });
  });
}

async function main() {
  const prNumber = text(process.argv[2]);
  const materialCode = text(process.argv[3]);
  const apply = process.argv.includes("--apply");
  if (!prNumber || !materialCode) throw new Error("Usage: node scripts/normalize-pr-material-sourcing.js <PR_NUMBER> <MATERIAL_CODE> [--apply]");
  const result = await resolveNormalization(prNumber, materialCode);
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    prNumber,
    materialCode,
    detailId: result.detail.id,
    existingAllocationCount: result.detail.sourcingAllocations.length,
    sourceSuggestion: result.suggestionItem?.suggestionNumber || null,
    sourceRequirement: result.requirement?.id || null,
    normalized: result.normalized,
  }, null, 2));
  if (apply) {
    const updated = await applyNormalization(result);
    const row = updated.details.find((item) => item.id === result.detail.id);
    console.log(JSON.stringify({
      updated: true,
      purchasePackageUomCode: row.purchasePackageUomCode,
      width: row.width,
      length: row.materialLength,
      qty: row.qty,
      uomCode: row.uomCode,
      sourcingAllocations: row.sourcingAllocations,
    }, null, 2));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
