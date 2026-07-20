const { prisma } = require("../../../index");
const { generateConfiguredNumber } = require("../../../services/numberingService");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePONumberPrefix(poNumberPrefix) {
  const normalized = String(poNumberPrefix || "Production").trim().toLowerCase();

  if (normalized === "engineering" || normalized === "e-po") {
    return "E-PO";
  }

  return "P-PO";
}

// ============================================
// GENERATE NOMOR DOKUMEN SEQUENTIAL
// Contoh: PR-20260309-0001, PO-20260309-0001
// ============================================
async function generateDocNumber(model, prefix, field, tx = null) {
  const client = tx || prisma;
  const ruleKey = prefix === "LOT" ? "LOT" : prefix.includes("PO") ? "PURCHASE_ORDER" : "GENERIC_DOCUMENT";
  return generateConfiguredNumber(ruleKey, { db: client, context: { prefix }, fallback: async () => {
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");
  const last = await client[model].findFirst({
    where: { [field]: { startsWith: `${prefix}-${dateStr}-` } },
    orderBy: { [field]: "desc" },
    select: { [field]: true },
  });
  let seq = 1;
  if (last) {
    const match = last[field].match(/-(\d+)$/);
    if (match) seq = parseInt(match[1]) + 1;
  }
  return `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;
  } });
}

// ============================================
// GENERATE NOMOR PO FORMAT KHUSUS
// Contoh: P-PO/S001/01/2026/01, E-PO/S001/01/2026/01
// ============================================
async function generatePONumber(poType = "Other", tx = null, poNumberPrefix = null, partnerCode = null) {
  const client = tx || prisma;
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const normalizedPartnerCode = String(partnerCode || "").trim();
  const documentPrefix = resolvePONumberPrefix(poNumberPrefix);

  if (!normalizedPartnerCode) {
    throw new Error("supplierCode atau vendorCode wajib diisi untuk generate nomor PO");
  }

  const configured = await generateConfiguredNumber("PURCHASE_ORDER", { db: client, context: { prefix: documentPrefix, code: normalizedPartnerCode } });
  if (configured) return configured;
  const prefix = `${documentPrefix}/${normalizedPartnerCode}/${month}/${year}/`;

  const existingNumbers = await client.purchaseOrder.findMany({
    where: {
      poNumber: {
        startsWith: prefix,
      },
    },
    select: { poNumber: true },
  });

  let seq = 1;
  const seqRegex = new RegExp(
    `^${escapeRegExp(documentPrefix)}/${escapeRegExp(normalizedPartnerCode)}/${month}/${year}/(\\d+)$`,
  );
  for (const row of existingNumbers) {
    const match = row.poNumber?.match(seqRegex);
    if (!match) continue;
    const currentSeq = Number(match[1]);
    if (Number.isFinite(currentSeq) && currentSeq >= seq) {
      seq = currentSeq + 1;
    }
  }

  return `${documentPrefix}/${normalizedPartnerCode}/${month}/${year}/${String(seq).padStart(2, "0")}`;
}

// ============================================
// HITUNG TOTAL AMOUNT DARI ARRAY DETAILS
// ============================================
const calcTotal = (details) =>
  Array.isArray(details) ? details.reduce((sum, d) => sum + (d.totalAmount || 0), 0) : 0;

module.exports = { generateDocNumber, generatePONumber, calcTotal };
