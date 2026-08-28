const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { convertNumericFields } = require("../../utils/numericConverter");
const { deletePartPhoto, deletePartAttachment } = require("../../middleware/uploads");
const { normalizeAssemblyPolicy } = require("../../utils/assemblyPolicy");
const { generateConfiguredNumber, getRule, formatNumber } = require("../../services/numberingService");
const { resolveItemCompatibility } = require("../../services/itemCompatibilityService");

// ─── Constants ────────────────────────────────────────────────────────────────

const PART_BASE_FIELDS = ["thickness", "width", "length", "cavity", "netWeight", "scrapWeight", "grossWeight", "cycleTime"];
const PART_NUMERIC_FIELDS = [
  "bufferStock",
  "componentLevel",
  "processSequence",
  "bomLevel",
  "pcsPerBox",
  "kgPerBox",
  "pcsPerPlastic",
  "kgPerPlastic",
  "qtyPlasticPerBox",
];
const PLANNING_POLICIES = new Set(["MTS", "MTO"]);
const ITEM_TYPES = new Set(["FG", "WIP", "RAW"]);
const ITEM_TYPE_VALUES = Array.from(ITEM_TYPES);
const RAW_TYPES = new Set(["MATERIAL", "PURCHASE_PART"]);
const PART_TYPES = new Set(["STANDARD", "COMP"]);
const OPTIONAL_SELECT_FIELDS = ["category", "statusPhp", "status", "statusService", "planningPolicy"];
// Multipart forms send checkbox values as strings; normalize them before Prisma writes.
const PART_PERMISSION_FIELDS = [
  "canPurchase", "canManufacture", "canSell", "canStore",
  "canUseInBom", "canSubcontract", "canTrackLot", "canTrackSerial",
  "hasDrawing",
];
const PROCESS_PART_SEQUENCE_STEP = 10;
const RAW_PART_SEQUENCE_WIDTH = 3;
const RAW_PART_DEFAULT_REVISION = "00";

const ATTACHMENT_PART_SELECT = {
  part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
};

const PART_CODE_REFERENCE_COLUMNS = [
  ["tbl_quotationdetail", "part_code"],
  ["tbl_salesorderdetail", "part_code"],
  ["tbl_lot_master", "part_code"],
  ["tbl_stock_balance", "part_code"],
  ["tbl_stock_movement", "part_code"],
  ["tbl_stock_reservation", "part_code"],
  ["tbl_sto_details", "part_code"],
  ["tbl_forecast_detail", "part_code"],
  ["tbl_mps_detail", "part_code"],
  ["tbl_mrp_requirement", "part_code"],
  ["tbl_planned_order", "part_code"],
  ["tbl_monthly_production_plan_detail", "part_code"],
  ["tbl_purchase_requisition_detail", "part_code"],
  ["tbl_purchase_order_detail", "part_code"],
  ["tbl_purchase_invoice_detail", "part_code"],
  ["tbl_vendor_process_order", "input_part_code"],
  ["tbl_vendor_process_order", "output_part_code"],
  ["tbl_daily_production_schedule", "part_code"],
  ["tbl_material_issue_detail", "part_code"],
];

// Gunakan fungsi agar attachment orderBy bisa dikustomisasi (list pakai desc, lainnya asc)
const partInclude = (attachOrder = 'asc', includeBomProcesses = true) => ({
  material: true,
  supplier: { select: { id: true, supplierCode: true, supplierName: true } },
  process: { select: { id: true, processCode: true, processName: true } },
  ...(includeBomProcesses ? {
    mbomDetails: {
      where: { isDeleted: false, mbomHeader: { isDeleted: false } },
      select: {
        noReg: true,
        mbomHeader: { select: { revision: true, effectiveDate: true } },
        mbomProcesses: {
          where: { isDeleted: false },
          orderBy: { sequence: "asc" },
          select: { sequence: true, occurrenceCode: true, process: { select: { processCode: true, processName: true } } },
        },
      },
    },
  } : {}),
  partBases: true,
  attachments: { where: { isDeleted: false }, orderBy: { createdAt: attachOrder } },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse JSON string ke value; return fallback jika bukan string atau gagal parse
const parseJsonField = (value, fallback = null) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

const normalizePlanningPolicy = (data) => {
  if (!data || data.planningPolicy === undefined || data.planningPolicy === null || data.planningPolicy === '') {
    if (data) data.planningPolicy = "MTO";
    return data;
  }

  const value = String(data.planningPolicy).trim().toUpperCase();
  data.planningPolicy = PLANNING_POLICIES.has(value) ? value : "MTO";
  return data;
};

const normalizeOptionalSelects = (data) => {
  if (!data) return data;
  OPTIONAL_SELECT_FIELDS.forEach((field) => {
    if (data[field] === '') data[field] = null;
  });
  if (data.status === undefined || data.status === null || data.status === '') {
    data.status = "Active";
  }
  return data;
};

const normalizePartPermissions = (data) => {
  if (!data) return data;
  PART_PERMISSION_FIELDS.forEach((field) => {
    if (data[field] === undefined) return;
    if (typeof data[field] === "string") {
      data[field] = ["true", "1", "yes", "ya", "on"].includes(data[field].trim().toLowerCase());
    } else {
      data[field] = Boolean(data[field]);
    }
  });
  return data;
};

const normalizeItemType = (data) => {
  if (!data) return data;
  const raw = data.itemType ?? data.item_type;
  if (raw === undefined) {
    delete data.item_type;
    return data;
  }

  const value = String(raw || "").trim().toUpperCase();
  data.itemType = ITEM_TYPES.has(value) ? value : null;
  delete data.item_type;
  return data;
};

const normalizeRawType = (data, defaultRawType = "PURCHASE_PART") => {
  if (!data) return data;
  if (data.itemType !== "RAW") {
    data.rawType = null;
    return data;
  }
  const value = String(data.rawType || defaultRawType).trim().toUpperCase();
  data.rawType = RAW_TYPES.has(value) ? value : defaultRawType;
  return data;
};

const normalizePartType = (data, applyDefault = true) => {
  if (!data) return data;
  const raw = data.partType ?? data.part_type;
  if (raw === undefined && !applyDefault) {
    delete data.part_type;
    return data;
  }
  const value = String(raw ?? "STANDARD").trim().toUpperCase();
  data.partType = PART_TYPES.has(value) ? value : "STANDARD";
  delete data.part_type;
  return data;
};

const normalizePartAssemblyPolicy = (data) => {
  if (!data) return data;
  data.assemblyPolicy = normalizeAssemblyPolicy(data.assemblyPolicy, "INLINE");
  return data;
};
const normalizePartCode = (value) => String(value || "").trim().toUpperCase();

// A part cannot safely enter BOM, planning, or inventory with only a
// transaction-level UOM. On create, use the first supplied operational UOM as
// the base and fill the role-specific UOMs that apply to the item type.
function normalizeCreatePartUoms(data) {
  const itemType = String(data.itemType || "").trim().toUpperCase();
  const selectedUom = [
    data.baseUomCode,
    data.productionUomCode,
    data.purchaseUomCode,
    data.stockUomCode,
    data.salesUomCode,
    data.uomCode,
  ].map((value) => String(value || "").trim().toUpperCase()).find(Boolean) || null;
  delete data.uomCode;
  if (!selectedUom) return data;
  data.baseUomCode ||= selectedUom;
  data.stockUomCode ||= selectedUom;
  if (["FG", "WIP"].includes(itemType)) data.productionUomCode ||= selectedUom;
  if (itemType === "FG") data.salesUomCode ||= selectedUom;
  if (itemType === "RAW" || data.canPurchase) data.purchaseUomCode ||= selectedUom;
  return data;
}
const CUSTOMER_FAMILY_PATTERN = "(?:\\d{3,4}|C\\d{3})";
const CUSTOMER_FAMILY_BRANCH_PATTERN = `${CUSTOMER_FAMILY_PATTERN}(?:[A-Z]+|-[A-Z]+)?`;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getPrimaryCustomerCode = (data = {}) => {
  if (Array.isArray(data.customerCodes) && data.customerCodes.length > 0) {
    return normalizePartCode(data.customerCodes[0]);
  }
  return normalizePartCode(data.customerCode);
};

const getCustomerCodeFromPartCode = (partCode) => {
  const match = normalizePartCode(partCode).match(new RegExp(`^([^-]+)-${CUSTOMER_FAMILY_BRANCH_PATTERN}-\\d{2,3}$`));
  return match ? match[1] : "";
};

const getPartCustomerCode = (data = {}) => getPrimaryCustomerCode(data) || getCustomerCodeFromPartCode(data.partCode);

const getCustomerPartBase = (partCode) => {
  const code = normalizePartCode(partCode);
  const match = code.match(new RegExp(`^(.*-${CUSTOMER_FAMILY_BRANCH_PATTERN})-\\d{2,3}$`));
  return match ? match[1] : code;
};

const formatPartProcessSequence = (sequence) => String(sequence).padStart(3, "0");

const normalizeRawPartRevision = (value) => {
  const revision = String(value || RAW_PART_DEFAULT_REVISION).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!revision) return RAW_PART_DEFAULT_REVISION;
  return /^\d+$/.test(revision) ? revision.padStart(2, "0") : revision;
};

const getRawPartRevision = (data = {}) => data.noRevisi ?? data.noRevision ?? data.revision ?? data.rev;

const stripPartCodeTransientFields = (data = {}) => {
  const {
    noRevisi, noRevision, revision, rev, processOrder, isInsertion,
    parentBranchCode, siblingBranchCodes, siblingPartIds, usedProcessSequences, reserveBranchAlpha,
    sequenceSourcePartCode, fixedProcessSequence,
    branchReconcile,
    ...rest
  } = data;
  return rest;
};

const normalizeLinkedCustomers = async (data = {}, fallbackPrimary = "") => {
  const hasPrimaryInput = data.customerCode !== undefined;
  const hasListInput = data.customerCodes !== undefined;
  if (!hasPrimaryInput && !hasListInput) return data;
  const primary = normalizePartCode(hasPrimaryInput ? data.customerCode : fallbackPrimary);
  const incoming = Array.isArray(data.customerCodes) ? data.customerCodes : [];
  const codes = [...new Set([primary, ...incoming.map(normalizePartCode)].filter(Boolean))];
  if (codes.length) {
    const customers = await prisma.customer.findMany({ where: { customerCode: { in: codes }, isDeleted: false }, select: { customerCode: true } });
    const found = new Set(customers.map((item) => normalizePartCode(item.customerCode)));
    const missing = codes.filter((code) => !found.has(code));
    if (missing.length) throw Object.assign(new Error(`Kode pelanggan tidak ditemukan di Master Pelanggan: ${missing.join(", ")}.`), { statusCode: 400 });
  }
  if (hasPrimaryInput) data.customerCode = primary || null;
  data.customerCodes = codes;
  return data;
};

const buildProcessPartCode = (basePartCode, sequence) =>
  `${getCustomerPartBase(basePartCode)}-${formatPartProcessSequence(sequence)}`;

const isDetailProcessSequence = sequence => Number.isInteger(sequence) && sequence > 0 && sequence % PROCESS_PART_SEQUENCE_STEP === 0;

const findFirstAvailableSequence = (usedSequences, start = 1, step = 1) => {
  let sequence = start;
  while (usedSequences.has(sequence)) sequence += step;
  return sequence;
};

const findNextDetailProcessSequence = (usedSequences) => {
  let sequence = PROCESS_PART_SEQUENCE_STEP;
  while (usedSequences.has(sequence)) sequence += PROCESS_PART_SEQUENCE_STEP;
  return sequence;
};

const formatCustomerFamilySequence = (sequence, partType = "STANDARD") =>
  partType === "COMP" ? `C${String(sequence).padStart(3, "0")}` : String(sequence).padStart(4, "0");

const getCustomerFamilySequence = (partCode) => {
  const match = normalizePartCode(partCode).match(/^[^-]+-(?:C)?(\d{3,4})(?:-|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
};

const normalizeBranchCode = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");

const alphaSequence = (index) => {
  let value = Math.max(0, Number(index) || 0); let result = "";
  do { result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26) - 1; } while (value >= 0);
  return result;
};

const replaceBranchToken = (partCode, pattern, oldBranch, newBranch, processSequence) => {
  const source = String(pattern || ""); let cursor = 0; let expression = "^"; let hasBranch = false;
  if (!oldBranch && source.includes("-{BRANCH}-{PROCESS}")) {
    const processSuffix = `-${formatPartProcessSequence(processSequence)}`;
    if (normalizePartCode(partCode).endsWith(processSuffix)) return `${partCode.slice(0, -processSuffix.length)}-${newBranch}${processSuffix}`;
  }
  for (const match of source.matchAll(/\{([A-Z_]+)\}/g)) {
    expression += escapeRegExp(source.slice(cursor, match.index));
    if (match[1] === "BRANCH" && !hasBranch) {
      expression += `(?<branch>${escapeRegExp(oldBranch)})`; hasBranch = true;
    } else expression += ".*?";
    cursor = match.index + match[0].length;
  }
  expression += `${escapeRegExp(source.slice(cursor))}$`;
  if (!hasBranch) return null;
  const matched = normalizePartCode(partCode).match(new RegExp(expression, "d"));
  const indices = matched?.indices?.groups?.branch;
  if (!indices) return null;
  return `${partCode.slice(0, indices[0])}${newBranch}${partCode.slice(indices[1])}`;
};

const resolveChildCodeContext = async (data, ruleKey) => {
  const rule = await getRule(ruleKey);
  const processStep = Math.max(1, Number(rule?.processStep || PROCESS_PART_SEQUENCE_STEP));
  const processOrder = Math.max(1, Number.parseInt(data.processOrder ?? data.componentLevel, 10) || 1);
  const baseSequence = processOrder * processStep;
  const configuredInsertionStart = Math.max(processStep + 1, Number(rule?.insertionStart || processStep + 1));
  const insertionOffset = Math.max(1, configuredInsertionStart - processStep);
  const usedSequences = new Set((Array.isArray(data.usedProcessSequences) ? data.usedProcessSequences : []).map(Number).filter(Number.isFinite));
  let processSequence = Number.parseInt(data.processSequence, 10);
  if (!(processSequence > 0)) processSequence = data.isInsertion === true || data.isInsertion === "true" ? baseSequence + insertionOffset : baseSequence;
  if (data.isInsertion === true || data.isInsertion === "true") {
    while (usedSequences.has(processSequence) && processSequence < baseSequence + processStep) processSequence += 1;
    if (processSequence >= baseSequence + processStep) throw Object.assign(new Error(`Slot sisipan proses ${baseSequence}-${baseSequence + processStep - 1} sudah penuh.`), { statusCode: 409 });
  }

  const inheritedBranch = rule?.inheritBranchAlpha === false ? "" : normalizeBranchCode(data.parentBranchCode);
  let branchCode = inheritedBranch; let branchReconcile = null;
  if ((rule?.siblingAlphaMode || "SAME_PROCESS") !== "NONE" && data.reserveBranchAlpha !== false) {
    const siblingBranches = (Array.isArray(data.siblingBranchCodes) ? data.siblingBranchCodes : []).map(normalizeBranchCode);
    if (siblingBranches.length === 0) {
      branchCode = inheritedBranch;
    } else {
      const localUsed = new Set(siblingBranches
        .filter((value) => value.startsWith(inheritedBranch))
        .map((value) => value.slice(inheritedBranch.length))
        .filter(Boolean));
      if (siblingBranches.includes(inheritedBranch)) {
        localUsed.add("A");
        branchReconcile = { oldBranch: inheritedBranch, newBranch: `${inheritedBranch}A`, pattern: rule?.pattern || "" };
      }
      let index = 0; while (localUsed.has(alphaSequence(index))) index += 1;
      branchCode = `${inheritedBranch}${alphaSequence(index)}`;
    }
  }
  return { processSequence, branchCode, branchReconcile, formattedProcess: formatPartProcessSequence(processSequence) };
};

const findNextCustomerPartSequence = async (customerCode, partType = "STANDARD") => {
  const customer = normalizePartCode(customerCode);
  if (!customer) return 1;

  const existing = await prisma.part.findMany({
    where: { partCode: { startsWith: `${customer}-` }, isDeleted: false },
    select: { partCode: true },
  });

  const normalizedPartType = PART_TYPES.has(partType) ? partType : "STANDARD";
  const pattern = new RegExp(`^${escapeRegExp(customer)}-(C\\d{3}|\\d{3,4})(?:[A-Z]+|-[A-Z]+)?-\\d{2,3}$`);
  const used = new Set(existing
    .map((part) => {
      const match = normalizePartCode(part.partCode).match(pattern);
      if (!match) return null;
      const isCompCode = match[1].startsWith("C");
      if ((normalizedPartType === "COMP") !== isCompCode) return null;
      return Number(match[1].replace(/^C/, ""));
    })
    .filter((value) => Number.isInteger(value)));

  return findFirstAvailableSequence(used);
};

const buildCustomerPartCode = async (data) => {
  const customerCode = getPartCustomerCode(data);
  const partType = normalizePartCode(data.partType) === "COMP" ? "COMP" : "STANDARD";
  const legacy = async () => {
    const sequence = await findNextCustomerPartSequence(customerCode, partType);
    return `${customerCode ? `${customerCode}-` : ""}${formatCustomerFamilySequence(sequence, partType)}-000`;
  };
  const ruleKey = partType === "COMP" ? "PART_FG_COMPONENT" : "PART_FG_NON_COMPONENT";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = await generateConfiguredNumber(ruleKey, { context: { customer: customerCode }, fallback: legacy });
    const existing = await prisma.part.findUnique({ where: { partCode: code } });
    if (!existing || existing.isDeleted) return code;
  }
  throw Object.assign(new Error("Tidak dapat membuat Part Code unik dari aturan penomoran."), { statusCode: 409 });
};

const buildChildPartCode = async (data = {}) => {
  const customerCode = getPartCustomerCode(data);
  const partType = normalizePartCode(data.partType) === "COMP" ? "COMP" : "STANDARD";
  const ruleKey = partType === "COMP" ? "PART_CHILD_COMPONENT" : "PART_CHILD_NON_COMPONENT";
  const inheritedFamilySequence = getCustomerFamilySequence(data.sequenceSourcePartCode);
  const rule = inheritedFamilySequence ? await getRule(ruleKey) : null;
  const codeContext = await resolveChildCodeContext(data, ruleKey);
  data.processSequence = codeContext.processSequence;
  data.componentLevel = Math.max(1, Number.parseInt(data.processOrder ?? data.componentLevel, 10) || 1);
  data.branchCode = codeContext.branchCode || null;
  data.branchReconcile = codeContext.branchReconcile;
  const legacy = async () => {
    const sequence = inheritedFamilySequence || await findNextCustomerPartSequence(customerCode, partType);
    return `${customerCode ? `${customerCode}-` : ""}${formatCustomerFamilySequence(sequence, partType)}${codeContext.branchCode}-${codeContext.formattedProcess}`;
  };
  if (inheritedFamilySequence && rule?.isActive) {
    const code = formatNumber(rule, inheritedFamilySequence, { customer: customerCode, level: codeContext.formattedProcess, process: codeContext.formattedProcess, branch: codeContext.branchCode });
    const existing = await prisma.part.findUnique({ where: { partCode: code } });
    if (!existing || existing.isDeleted) return code;
    throw Object.assign(new Error(`Part Code ${code} sudah digunakan dalam family Produk Utama/FG non-component yang sama.`), { statusCode: 409 });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = await generateConfiguredNumber(ruleKey, {
      context: { customer: customerCode, level: codeContext.formattedProcess, process: codeContext.formattedProcess, branch: codeContext.branchCode },
      fallback: legacy,
    });
    const existing = await prisma.part.findUnique({ where: { partCode: code } });
    if (!existing || existing.isDeleted) return code;
  }
  throw Object.assign(new Error("Tidak dapat membuat Child Part Code unik dari aturan penomoran."), { statusCode: 409 });
};

const findNextRawPartSequence = async () => {
  const existing = await prisma.part.findMany({
    where: { itemType: "RAW", isDeleted: false },
    select: { partCode: true },
  });

  const pattern = new RegExp(`^(\\d{${RAW_PART_SEQUENCE_WIDTH}})-?[A-Z0-9]+$`);
  const used = new Set(existing
    .map((part) => {
      const match = normalizePartCode(part.partCode).match(pattern);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isInteger(value)));

  return findFirstAvailableSequence(used);
};

const buildRawPartCode = async (data = {}) => {
  const noRevisi = normalizeRawPartRevision(getRawPartRevision(data));
  const legacy = async () => {
    const sequence = await findNextRawPartSequence();
    return `${String(sequence).padStart(RAW_PART_SEQUENCE_WIDTH, "0")}-${noRevisi}`;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = await generateConfiguredNumber("PART_RAW", { context: { rev: noRevisi }, fallback: legacy });
    const existing = await prisma.part.findUnique({ where: { partCode: code } });
    if (!existing || existing.isDeleted) return code;
  }
  throw Object.assign(new Error("Tidak dapat membuat Raw Material Code unik dari aturan penomoran."), { statusCode: 409 });
};

const buildPartCode = async (data = {}) => {
  if (data.itemType === "FG") return buildCustomerPartCode(data);
  if (data.itemType === "WIP") return buildChildPartCode(data);
  if (data.itemType === "RAW" && data.rawType === "PURCHASE_PART") {
    return data.hasDrawing ? buildCustomerPartCode({ ...data, partType: "STANDARD" }) : buildRawPartCode(data);
  }
  if (data.itemType === "RAW" && data.rawType === "MATERIAL") {
    data.reserveBranchAlpha = false;
    data.parentBranchCode = "";
    data.siblingBranchCodes = [];
    data.siblingPartIds = [];
    return buildChildPartCode(data);
  }
  return buildCustomerPartCode(data);
};

const isCustomerPartCode = (partCode, customerCode) => {
  const code = normalizePartCode(partCode);
  const customer = normalizePartCode(customerCode);
  if (!code || !customer) return false;
  return new RegExp(`^${escapeRegExp(customer)}-${CUSTOMER_FAMILY_BRANCH_PATTERN}-\\d{2,3}$`).test(code);
};

const buildPrimaryCustomerCodeMappings = (parts) => {
  const usedByCustomer = new Map();
  const mappings = [];
  const skipped = [];

  const getUsedSet = (customerCode, partType = "STANDARD") => {
    const customer = normalizePartCode(customerCode);
    const key = `${customer}:${normalizePartCode(partType) === "COMP" ? "COMP" : "STANDARD"}`;
    if (!usedByCustomer.has(key)) usedByCustomer.set(key, new Set());
    return usedByCustomer.get(key);
  };

  parts.forEach((part) => {
    const primaryCustomer = getPrimaryCustomerCode(part);
    if (!primaryCustomer) {
      skipped.push({
        id: part.id,
        partCode: part.partCode,
        reason: "No primary customer code",
      });
      return;
    }

    const used = getUsedSet(primaryCustomer, part.partType);
    const existingMatch = getCustomerPartMatch(part.partCode, primaryCustomer);
    const expectedPartType = normalizePartCode(part.partType) === "COMP" ? "COMP" : "STANDARD";
    if (existingMatch?.partType === expectedPartType) used.add(existingMatch.familySequence);
  });

  parts.forEach((part) => {
    const primaryCustomer = getPrimaryCustomerCode(part);
    if (!primaryCustomer) return;

    if (isCustomerPartCode(part.partCode, primaryCustomer))
      return;

    const partType = normalizePartCode(part.partType) === "COMP" ? "COMP" : "STANDARD";
    const used = getUsedSet(primaryCustomer, partType);
    let sequence = 1;
    while (used.has(sequence)) sequence += 1;
    used.add(sequence);

    mappings.push({
      id: part.id,
      oldPartCode: part.partCode,
      normalizedOldPartCode: normalizePartCode(part.partCode),
      newPartCode: `${primaryCustomer}-${formatCustomerFamilySequence(sequence, partType)}-000`,
      primaryCustomer,
    });
  });

  return { mappings, skipped };
};

const getCustomerPartMatch = (partCode, customerCode) => {
  const code = normalizePartCode(partCode);
  const customer = normalizePartCode(customerCode);
  if (!code || !customer) return null;
  const match = code.match(new RegExp(`^${escapeRegExp(customer)}-(C\\d{3}|\\d{3,4})(?:-([A-Z]+))?-(\\d{2,3})$`));
  return match
    ? {
        base: `${customer}-${match[1]}`,
        familySequence: Number(match[1].replace(/^C/, "")),
        branchCode: match[2] || "",
        processSequence: Number(match[3]),
        partType: match[1].startsWith("C") ? "COMP" : "STANDARD",
      }
    : null;
};

const findNextFamilySequenceFromParts = (parts, customerCode, partType = "STANDARD") => {
  const customer = normalizePartCode(customerCode);
  const used = parts
    .map((part) => getCustomerPartMatch(part.partCode, customer))
    .filter((match) => match?.partType === partType)
    .map((match) => match.familySequence)
    .filter((value) => Number.isInteger(value));

  return used.length > 0 ? Math.max(...used) + 1 : 1;
};

const buildSelectedPartCodeMappings = (allParts, selectedParts, fgPartId, detailPartIds = []) => {
  const detailIdSet = new Set(detailPartIds);
  const selectedIdSet = new Set([fgPartId, ...detailPartIds]);
  const fgPart = selectedParts.find((part) => part.id === fgPartId);
  const skipped = [];

  if (!fgPart) {
    return {
      mappings: [],
      skipped: [{ id: fgPartId, reason: "FG part not found" }],
      preview: null,
    };
  }

  const primaryCustomer = getPrimaryCustomerCode(fgPart);
  if (!primaryCustomer) {
    return {
      mappings: [],
      skipped: [{ id: fgPart.id, partCode: fgPart.partCode, reason: "FG has no primary customer code" }],
      preview: null,
    };
  }

  const fgExistingMatch = getCustomerPartMatch(fgPart.partCode, primaryCustomer);
  const partType = normalizePartCode(fgPart.partType) === "COMP" ? "COMP" : "STANDARD";
  const familySequence = fgExistingMatch?.processSequence === 0 && fgExistingMatch.partType === partType
    ? fgExistingMatch.familySequence
    : findNextFamilySequenceFromParts(allParts, primaryCustomer, partType);
  const baseCode = `${primaryCustomer}-${formatCustomerFamilySequence(familySequence, partType)}`;
  const fgTargetCode = `${baseCode}-000`;

  const usedProcessSequences = new Set([0]);
  allParts.forEach((part) => {
    if (detailIdSet.has(part.id)) return;
    const match = normalizePartCode(part.partCode).match(new RegExp(`^${escapeRegExp(baseCode)}-(\\d{2,3})$`));
    if (match) usedProcessSequences.add(Number(match[1]));
  });

  const mappings = [];
  const addMapping = (part, newPartCode) => {
    if (normalizePartCode(part.partCode) === newPartCode) return;
    mappings.push({
      id: part.id,
      itemType: part.itemType,
      oldPartCode: part.partCode,
      normalizedOldPartCode: normalizePartCode(part.partCode),
      newPartCode,
      primaryCustomer,
    });
  };

  addMapping(fgPart, fgTargetCode);

  const detailParts = detailPartIds
    .map((id) => selectedParts.find((part) => part.id === id))
    .filter(Boolean);

  detailParts.forEach((part) => {
    const existingMatch = normalizePartCode(part.partCode).match(new RegExp(`^${escapeRegExp(baseCode)}-(\\d{2,3})$`));
    if (existingMatch) {
      const sequence = Number(existingMatch[1]);
      if (isDetailProcessSequence(sequence) && !usedProcessSequences.has(sequence)) {
        usedProcessSequences.add(sequence);
        return;
      }
    }

    const processSequence = findNextDetailProcessSequence(usedProcessSequences);
    usedProcessSequences.add(processSequence);
    addMapping(part, `${baseCode}-${formatPartProcessSequence(processSequence)}`);
  });

  selectedParts.forEach((part) => {
    if (!selectedIdSet.has(part.id)) {
      skipped.push({ id: part.id, partCode: part.partCode, reason: "Not selected for this migration batch" });
    }
  });

  return {
    mappings,
    skipped,
    preview: {
      primaryCustomer,
      baseCode,
      fgPartId,
      detailPartIds,
      targetCodes: [
        { id: fgPart.id, oldPartCode: fgPart.partCode, newPartCode: fgTargetCode, itemType: fgPart.itemType },
        ...detailParts.map((part) => ({
          id: part.id,
          oldPartCode: part.partCode,
          newPartCode: mappings.find((mapping) => mapping.id === part.id)?.newPartCode || normalizePartCode(part.partCode),
          itemType: part.itemType,
        })),
      ],
    },
  };
};

const updatePartCodeReferences = async (tx, mapping) => {
  await tx.part.update({
    where: { id: mapping.id },
    data: { partCode: mapping.newPartCode },
  });

  for (const [table, column] of PART_CODE_REFERENCE_COLUMNS) {
    await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2 OR UPPER("${column}") = $3`,
      mapping.newPartCode,
      mapping.oldPartCode,
      mapping.normalizedOldPartCode,
    );
  }
};

const getMbomSequenceUsage = async (mbom, db = prisma) => {
  const [salesOrders, forecasts, mps] = await Promise.all([
    db.salesOrderDetail.count({
      where: { mbomHeaderId: mbom.id, isDeleted: false, status: { not: "Cancelled" } },
    }),
    mbom.partId
      ? db.forecastDetail.count({
        where: {
          partId: mbom.partId,
          isDeleted: false,
          forecast: { is: { isDeleted: false, status: { not: "Obsolete" } } },
          OR: [{ M1Qty: { gt: 0 } }, { M2Qty: { gt: 0 } }, { M3Qty: { gt: 0 } }],
        },
      })
      : 0,
    db.mPSDetail.count({
      where: { mbomHeaderId: mbom.id, isDeleted: false, status: { not: "Cancelled" } },
    }),
  ]);
  return { salesOrders, forecasts, mps, locked: salesOrders > 0 || forecasts > 0 || mps > 0 };
};

const reconcileConditionalSiblingBranches = async ({ siblingPartIds, bomLevel, branchReconcile }) => {
  if (!branchReconcile || !Array.isArray(siblingPartIds) || siblingPartIds.length === 0) return [];
  const branchWhere = branchReconcile.oldBranch ? { branchCode: branchReconcile.oldBranch } : { OR: [{ branchCode: null }, { branchCode: "" }] };
  const siblings = await prisma.part.findMany({
    where: { id: { in: siblingPartIds }, bomLevel, itemType: "WIP", isDeleted: false, ...branchWhere },
    select: { id: true, partCode: true, branchCode: true },
  });
  const mappings = siblings.map((part) => ({
    id: part.id,
    oldPartCode: part.partCode,
    normalizedOldPartCode: normalizePartCode(part.partCode),
    newPartCode: replaceBranchToken(part.partCode, branchReconcile.pattern, branchReconcile.oldBranch, branchReconcile.newBranch, processSequence),
    newBranchCode: branchReconcile.newBranch,
  })).filter((item) => item.newPartCode && item.newPartCode !== item.oldPartCode);
  if (!mappings.length) return [];
  const conflicts = await prisma.part.findMany({ where: { partCode: { in: mappings.map((item) => item.newPartCode) }, id: { notIn: mappings.map((item) => item.id) } }, select: { partCode: true } });
  if (conflicts.length) throw Object.assign(new Error(`Kode hasil percabangan sudah digunakan: ${conflicts.map((item) => item.partCode).join(", ")}.`), { statusCode: 409 });
  await prisma.$transaction(async (tx) => {
    for (const mapping of mappings) {
      await updatePartCodeReferences(tx, mapping);
      await tx.part.update({ where: { id: mapping.id }, data: { branchCode: mapping.newBranchCode } });
    }
  }, { timeout: 60000 });
  return mappings.map(({ id, oldPartCode, newPartCode, newBranchCode }) => ({ id, oldPartCode, partCode: newPartCode, branchCode: newBranchCode }));
};

const findNextProcessSequence = async (basePartCode) => {
  const base = getCustomerPartBase(basePartCode);
  if (!base) return 1;

  const existing = await prisma.part.findMany({
    where: { partCode: { startsWith: `${base}-` } },
    select: { partCode: true, isDeleted: true },
  });

  const processParts = existing
    .map((part) => {
      const match = normalizePartCode(part.partCode).match(new RegExp(`^${escapeRegExp(base)}-(\\d{2,3})$`));
      return match ? { sequence: Number(match[1]), isDeleted: part.isDeleted } : null;
    })
    .filter((part) => part && isDetailProcessSequence(part.sequence));

  const used = new Set(
    processParts.filter((part) => !part.isDeleted).map((part) => part.sequence),
  );

  const deletedSequence = processParts
    .filter((part) => part.isDeleted && !used.has(part.sequence))
    .map((part) => part.sequence)
    .sort((a, b) => a - b)[0];

  if (deletedSequence !== undefined) return deletedSequence;

  return findNextDetailProcessSequence(used);
};

// Map file upload ke photo record
const toPhotoRecord = (f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/parts/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

// Map file upload ke attachment file record
const toAttachmentFileRecord = (f) => ({
  fileName: f.originalname,
  fileUrl: `/uploads/parts/attachments/${f.filename}`,
  fileType: f.mimetype,
  fileSize: f.size,
});

// Fetch part dengan semua relasi standar
const fetchPartWithIncludes = (id) =>
  prisma.part.findUnique({ where: { id }, include: partInclude() });

const replaceDeletedPart = async (existing, data) => {
  deletePartPhotos(existing.photos);
  await prisma.partBase.deleteMany({ where: { partId: existing.id } });
  await prisma.partAttachment.updateMany({
    where: { partId: existing.id },
    data: { isDeleted: true },
  });

  return prisma.part.update({
    where: { id: existing.id },
    data: { ...data, photos: data.photos || [], isDeleted: false },
  });
};

// Attach customers data ke doc berdasarkan customerCodes
const attachCustomersToPartDoc = async (doc) => {
  const linkedCodes = [...new Set([doc.customerCode, ...(doc.customerCodes || [])].map(normalizePartCode).filter(Boolean))];
  if (!linkedCodes.length) { doc.customers = []; return doc; }
  try {
    const customers = await prisma.customer.findMany({
      where: { customerCode: { in: linkedCodes }, isDeleted: false },
      select: { customerCode: true, customerName: true },
      orderBy: { customerCode: 'asc' },
    });
    doc.customers = customers.map(mapDoc);
  } catch {
    doc.customers = [];
  }
  return doc;
};

// Hapus semua file foto dari array photos
const deletePartPhotos = (photos) => {
  if (!Array.isArray(photos)) return;
  photos.forEach((p) => { if (p?.fileUrl) deletePartPhoto(p.fileUrl); });
};

// Buat PartBase records baru dari array partBases (untuk create / bulkCreate)
const savePartBases = async (partId, partBases) => {
  if (!Array.isArray(partBases) || partBases.length === 0) return;
  const ops = partBases
    .filter((pb) => pb?.baseOn && Object.keys(pb).length > 1)
    .map(({ baseOn, ...fields }) =>
      prisma.partBase.create({
        data: { partId, baseOn, ...convertNumericFields(fields, PART_BASE_FIELDS) },
      })
    );
  if (ops.length > 0) await Promise.all(ops);
};

// Upsert / delete satu PartBase record (untuk update)
const upsertOrDeletePartBase = (existing, partId, baseOn, data) => {
  if (Object.keys(data || {}).length > 0) {
    const converted = convertNumericFields(data, PART_BASE_FIELDS);
    return existing
      ? prisma.partBase.update({ where: { id: existing.id }, data: converted })
      : prisma.partBase.create({ data: { partId, baseOn, ...converted } });
  }
  if (existing) return prisma.partBase.delete({ where: { id: existing.id } });
  return null;
};

// Simpan attachment records dari file uploads yang dikelompokkan per fileCount.
// Mengembalikan jumlah file yang dikonsumsi (untuk dilanjutkan ke proses berikutnya).
const saveAttachmentFiles = async (partId, attachmentFiles, attachmentsRaw, uploadedBy) => {
  if (!attachmentFiles.length) return 0;
  let attachmentsData = parseJsonField(attachmentsRaw, []);
  if ((!Array.isArray(attachmentsData) || !attachmentsData.length) && attachmentFiles.length) {
    attachmentsData = [{ title: "Drawing / Dokumen Teknik", description: "Attachment dari Master Part", fileCount: attachmentFiles.length }];
  }
  if (!Array.isArray(attachmentsData) || !attachmentsData.length) return 0;
  let fileOffset = 0;
  // Pre-compute slices secara sinkron sebelum async ops
  const ops = attachmentsData.map((info) => {
    const count = Number(info.fileCount) || 1;
    const groupFiles = attachmentFiles.slice(fileOffset, fileOffset + count);
    fileOffset += count;
    return prisma.partAttachment.create({
      data: {
        partId,
        title: info.title || groupFiles[0]?.originalname || 'Attachment',
        files: groupFiles.map(toAttachmentFileRecord),
        description: info.description || null,
        uploadedBy,
      },
    });
  });
  await Promise.all(ops);
  return fileOffset;
};

// ─── Part CRUD ────────────────────────────────────────────────────────────────

const normalizeItemTypeFilter = (value) => {
  const raw = Array.isArray(value)
    ? value.flatMap((item) => String(item || "").split(","))
    : String(value || "").split(",");
  return raw
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
};

const parseBoolean = (value) => value === true || String(value).toLowerCase() === "true";

const addWhereCondition = (where, condition) => {
  if (!condition) return;

  if (where.OR) {
    where.AND = [...(where.AND || []), { OR: where.OR }, condition];
    delete where.OR;
    return;
  }

  where.AND = [...(where.AND || []), condition];
};

exports.getAllCodes = async (req, res, next) => {
  try {
    const parts = await prisma.part.findMany({
      where: { isDeleted: false },
      select: { partCode: true },
      orderBy: { partCode: "asc" },
    });
    res.json(parts.map((p) => p.partCode));
  } catch (e) { next(e); }
};

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      customerCode,
      itemType,
      rawType,
      includeEmptyItemType,
      category,
      status,
      supplierId,
      page = 1,
      limit = 20,
      includeBomProcess,
    } = req.query;
    const where = { isDeleted: isDeleted !== undefined ? isDeleted === "true" : false };

    if (customerCode) {
      where.OR = [{ customerCode }, { customerCodes: { has: customerCode } }];
    }
    if (category) where.category = category;
    if (rawType) where.rawType = String(rawType).trim().toUpperCase();
    const itemTypes = normalizeItemTypeFilter(itemType);
    const shouldIncludeEmptyItemType = parseBoolean(includeEmptyItemType);
    if (itemTypes.length > 0 || shouldIncludeEmptyItemType) {
      const itemTypeConditions = [];
      if (itemTypes.length === 1) itemTypeConditions.push({ itemType: itemTypes[0] });
      else if (itemTypes.length > 1) itemTypeConditions.push({ itemType: { in: itemTypes } });
      if (shouldIncludeEmptyItemType) {
        itemTypeConditions.push(
          { itemType: null },
          { itemType: "" },
          { itemType: { notIn: ITEM_TYPE_VALUES } },
        );
      }
      addWhereCondition(where, { OR: itemTypeConditions });
    }
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;

    if (q) {
      const searchOR = [
        { partCode: { contains: q, mode: "insensitive" } },
        { partNumber: { contains: q, mode: "insensitive" } },
        { partName: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
        { variant: { contains: q, mode: "insensitive" } },
        { itemType: { contains: q, mode: "insensitive" } },
        { customerCode: { contains: q, mode: "insensitive" } },
        { noPhp: { contains: q, mode: "insensitive" } },
      ];
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchOR }];
        delete where.OR;
      } else {
        where.OR = searchOR;
      }
    }

    const orderBy = buildSort(req.query);
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.part.findMany({ where, orderBy, skip, take: Number(limit), include: partInclude('desc', true) }),
      prisma.part.count({ where }),
    ]);

    const itemsWithCustomers = await Promise.all(
      items.map(async (item) => {
        const mapped = await attachCustomersToPartDoc(mapDoc(item));
        if (includeBomProcess === "true" || item.mbomDetails) {
          const bomProcesses = (item.mbomDetails || []).flatMap((detail) => (detail.mbomProcesses || []).map((process) => ({ ...process, revision: detail.mbomHeader?.revision || 0 })))
            .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0) || Number(left.sequence || 0) - Number(right.sequence || 0));
          mapped.bomProcessNames = [...new Set(bomProcesses.map((process) => process.occurrenceCode || process.process?.processName).filter(Boolean))];
        }
        return mapped;
      })
    );
    res.json({ items: itemsWithCustomers, total, page: Number(page), limit: Number(limit) });
  } catch (e) { next(e); }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.part.findFirst({
      where: { partCode: req.params.partCode, isDeleted: false },
      include: partInclude(),
    });
    if (!doc) return res.status(404).json({ message: "Part not found" });

    const transformed = mapDoc(doc);
    await attachCustomersToPartDoc(transformed);
    res.json(transformed);
  } catch (e) { next(e); }
};

exports.getCompatibilityProfile = async (req, res, next) => {
  try {
    const doc = await prisma.part.findFirst({
      where: { partCode: req.params.partCode, isDeleted: false },
    });
    if (!doc) return res.status(404).json({ message: "Part not found" });
    res.json(resolveItemCompatibility(doc));
  } catch (e) { next(e); }
};

exports.shiftProcessSequences = async (req, res, next) => {
  try {
    const mbomHeaderId = String(req.body?.mbomHeaderId || "").trim();
    const partIds = [...new Set((Array.isArray(req.body?.partIds) ? req.body.partIds : []).map(String).filter(Boolean))];
    const fromSequence = Number(req.body?.fromSequence);
    const shiftBy = Number(req.body?.shiftBy);
    if (!mbomHeaderId || !partIds.length || !Number.isInteger(fromSequence) || fromSequence < 1 || !Number.isInteger(shiftBy) || shiftBy === 0) {
      return res.status(400).json({ message: "MBOM, part yang digeser, sequence awal, dan nilai pergeseran wajib valid." });
    }

    const mbom = await prisma.mBOMHeader.findFirst({
      where: { id: mbomHeaderId, isDeleted: false },
      select: {
        id: true,
        partId: true,
        details: { where: { isDeleted: false }, select: { partId: true } },
      },
    });
    if (!mbom) return res.status(404).json({ message: "MBOM tidak ditemukan." });

    const detailPartIds = new Set(mbom.details.map((detail) => detail.partId).filter(Boolean));
    const outsideBom = partIds.filter((id) => !detailPartIds.has(id));
    if (outsideBom.length) return res.status(400).json({ message: "Ada part yang bukan detail dari MBOM ini." });

    const usage = await getMbomSequenceUsage(mbom);
    if (usage.locked) {
      return res.status(409).json({
        message: "Sequence utama tidak dapat digeser karena BOM sudah dipakai Forecast, Sales Order, atau MPS. Gunakan slot sisipan.",
        usage,
      });
    }

    const parts = await prisma.part.findMany({
      where: {
        id: { in: partIds },
        isDeleted: false,
        processSequence: shiftBy > 0 ? { gte: fromSequence } : { gte: fromSequence },
        OR: [{ itemType: "WIP" }, { itemType: "RAW", rawType: "MATERIAL" }],
      },
      select: { id: true, partCode: true, processSequence: true, componentLevel: true },
    });
    if (!parts.length) return res.status(400).json({ message: "Tidak ada part process yang memenuhi sequence pergeseran." });

    const mappings = parts.map((part) => {
      const processSequence = Number(part.processSequence) + shiftBy;
      if (processSequence < 1) throw Object.assign(new Error("Hasil sequence tidak boleh kurang dari 001."), { statusCode: 400 });
      return {
        id: part.id,
        oldPartCode: part.partCode,
        normalizedOldPartCode: normalizePartCode(part.partCode),
        newPartCode: buildProcessPartCode(part.partCode, processSequence),
        oldProcessSequence: Number(part.processSequence),
        processSequence,
        componentLevel: Math.max(1, Math.floor(processSequence / PROCESS_PART_SEQUENCE_STEP)),
      };
    }).sort((a, b) => shiftBy > 0 ? b.oldProcessSequence - a.oldProcessSequence : a.oldProcessSequence - b.oldProcessSequence);

    const conflicts = await prisma.part.findMany({
      where: {
        partCode: { in: mappings.map((mapping) => mapping.newPartCode) },
        id: { notIn: mappings.map((mapping) => mapping.id) },
        isDeleted: false,
      },
      select: { partCode: true },
    });
    if (conflicts.length) {
      return res.status(409).json({ message: `Kode tujuan sudah digunakan: ${conflicts.map((item) => item.partCode).join(", ")}.` });
    }

    await prisma.$transaction(async (tx) => {
      for (const mapping of mappings) {
        await updatePartCodeReferences(tx, mapping);
        await tx.part.update({
          where: { id: mapping.id },
          data: { processSequence: mapping.processSequence, componentLevel: mapping.componentLevel },
        });
      }
    }, { timeout: 60000 });

    res.json({
      message: "Sequence part berhasil digeser.",
      items: mappings.map((mapping) => ({
        id: mapping.id,
        oldPartCode: mapping.oldPartCode,
        partCode: mapping.newPartCode,
        oldProcessSequence: mapping.oldProcessSequence,
        processSequence: mapping.processSequence,
        componentLevel: mapping.componentLevel,
      })),
    });
  } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try {
    let { partBases, attachments, ...partData } = req.body;
    partBases = parseJsonField(partBases, []);
    if (!Array.isArray(partBases)) partBases = [];

    const data = normalizeCreatePartUoms(normalizePartPermissions(normalizeOptionalSelects(normalizePartType(
      normalizePartAssemblyPolicy(normalizeRawType(normalizeItemType(normalizePlanningPolicy(convertNumericFields(partData, PART_NUMERIC_FIELDS)))))
    ))));
    if (typeof data.customerCodes === 'string') {
      data.customerCodes = parseJsonField(data.customerCodes, data.customerCodes);
    }
    await normalizeLinkedCustomers(data);
    if (req.files?.photos?.length > 0) data.photos = req.files.photos.map(toPhotoRecord);

    if (!data.partCode) data.partCode = await buildPartCode(data);
    else data.partCode = normalizePartCode(data.partCode);

    const siblingPartIds = Array.isArray(data.siblingPartIds) ? data.siblingPartIds : [];
    const branchReconcile = data.branchReconcile;

    const cleanedData = stripPartCodeTransientFields(data);

    // Handle relation ids
    const {
      materialId: materialIdCreate,
      supplierId: supplierIdCreate,
      processId: processIdCreate,
      ...createData
    } = cleanedData;
    if (materialIdCreate) createData.material = { connect: { id: materialIdCreate } };
    if (supplierIdCreate) createData.supplier = { connect: { id: supplierIdCreate } };
    if (processIdCreate) createData.process = { connect: { id: processIdCreate } };

    const existing = await prisma.part.findUnique({ where: { partCode: createData.partCode } });
    let doc;
    if (existing?.isDeleted) {
      doc = await replaceDeletedPart(existing, createData);
    } else {
      doc = await prisma.part.create({ data: createData });
    }

    const renamedSiblings = await reconcileConditionalSiblingBranches({ siblingPartIds, bomLevel: Number(data.bomLevel || 0), branchReconcile });

    await savePartBases(doc.id, partBases);
    await saveAttachmentFiles(doc.id, req.files?.files ?? [], attachments, req.user?.username);

    const transformed = mapDoc(await fetchPartWithIncludes(doc.id));
    transformed.renamedSiblings = renamedSiblings;
    await attachCustomersToPartDoc(transformed);
    res.status(201).json(transformed);
  } catch (e) { next(e); }
};

exports.clone = async (req, res, next) => {
  try {
    const source = await prisma.part.findUnique({
      where: { id: req.params.id },
      include: { partBases: true },
    });

    if (!source || source.isDeleted) {
      return res.status(404).json({ message: "Part not found" });
    }

    const cloneOptions = normalizeRawType(normalizeItemType({
      itemType: req.body?.itemType ?? source.itemType ?? null,
      rawType: req.body?.rawType ?? source.rawType ?? null,
    }));
    const clonePartType = normalizePartType({ partType: req.body?.partType ?? source.partType });
    const sourceAssemblyPolicy = normalizeAssemblyPolicy(source.assemblyPolicy, "INLINE");
    const cloneAssemblyPolicy = cloneOptions.itemType === "FG" ? sourceAssemblyPolicy : "INLINE";
    const clonedPartCode = await buildPartCode({
      ...source,
      ...cloneOptions,
      partType: clonePartType.partType,
      hasDrawing: req.body?.hasDrawing ?? source.hasDrawing,
      componentLevel: req.body?.componentLevel ?? source.componentLevel,
      processSequence: req.body?.processSequence ?? source.processSequence,
      branchCode: req.body?.branchCode ?? source.branchCode,
    });

    const createData = {
      partCode: clonedPartCode,
      partNumber: source.partNumber,
      partName: source.partName,
      model: source.model,
      variant: source.variant,
      customerCode: source.customerCode,
      customerCodes: source.customerCodes,
      itemType: cloneOptions.itemType,
      rawType: cloneOptions.rawType,
      partType: clonePartType.partType,
      hasDrawing: req.body?.hasDrawing ?? source.hasDrawing,
      componentLevel: req.body?.componentLevel ?? source.componentLevel,
      processSequence: req.body?.processSequence ?? source.processSequence,
      branchCode: req.body?.branchCode ?? source.branchCode,
      category: source.category,
      status: source.status,
      statusService: source.statusService,
      planningPolicy: source.planningPolicy,
      assemblyPolicy: cloneAssemblyPolicy,
      bufferStock: source.bufferStock,
      noPhp: source.noPhp,
      statusPhp: source.statusPhp,
      pcsPerBox: source.pcsPerBox,
      kgPerBox: source.kgPerBox,
      packingPlastic: source.packingPlastic,
      pcsPerPlastic: source.pcsPerPlastic,
      kgPerPlastic: source.kgPerPlastic,
      qtyPlasticPerBox: source.qtyPlasticPerBox,
      notes: source.notes,
    };

    if (source.materialId) createData.material = { connect: { id: source.materialId } };
    if (source.supplierId) createData.supplier = { connect: { id: source.supplierId } };
    if (source.processId) createData.process = { connect: { id: source.processId } };

    const existingCloneTarget = await prisma.part.findUnique({ where: { partCode: createData.partCode } });
    const doc = existingCloneTarget?.isDeleted
      ? await replaceDeletedPart(existingCloneTarget, createData)
      : await prisma.part.create({ data: createData });

    await savePartBases(
      doc.id,
      source.partBases.map((base) => ({
        baseOn: base.baseOn,
        CSP: base.CSP,
        thickness: base.thickness,
        width: base.width,
        length: base.length,
        cavity: base.cavity,
        netWeight: base.netWeight,
        scrapWeight: base.scrapWeight,
        grossWeight: base.grossWeight,
        cycleTime: base.cycleTime,
      }))
    );

    const transformed = mapDoc(await fetchPartWithIncludes(doc.id));
    await attachCustomersToPartDoc(transformed);
    res.status(201).json(transformed);
  } catch (e) { next(e); }
};

exports.partCodeMigrationCandidates = async (req, res, next) => {
  try {
    const parts = await prisma.part.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        partCode: true,
        partNumber: true,
        partName: true,
        itemType: true,
        partType: true,
        customerCode: true,
        customerCodes: true,
        createdAt: true,
      },
      orderBy: [{ itemType: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });

    const items = parts.map((part) => ({
      ...mapDoc(part),
      primaryCustomer: getPrimaryCustomerCode(part),
      isPrimaryCustomerCode: isCustomerPartCode(part.partCode, getPrimaryCustomerCode(part)),
    }));

    res.json({
      items,
      total: items.length,
      fgItems: items.filter((part) => part.itemType === "FG"),
      detailItems: items.filter((part) => !part.itemType || part.itemType === "WIP" || part.itemType === "RAW"),
    });
  } catch (e) { next(e); }
};

exports.migratePartCodesToPrimaryCustomer = async (req, res, next) => {
  try {
    const fgPartId = req.body?.fgPartId;
    const detailPartIds = Array.isArray(req.body?.detailPartIds) ? req.body.detailPartIds : [];

    const parts = await prisma.part.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        partCode: true,
        partNumber: true,
        partName: true,
        itemType: true,
        partType: true,
        customerCode: true,
        customerCodes: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    let migration;
    if (fgPartId) {
      const selectedIds = [fgPartId, ...detailPartIds];
      const selectedParts = parts.filter((part) => selectedIds.includes(part.id));
      migration = buildSelectedPartCodeMappings(parts, selectedParts, fgPartId, detailPartIds);
      if (!migration.preview) {
        return res.status(400).json({
          message: migration.skipped?.[0]?.reason || "Invalid migration selection",
          skipped: migration.skipped || [],
        });
      }
    }
    else {
      migration = buildPrimaryCustomerCodeMappings(parts);
    }

    const { mappings, skipped } = migration;
    const duplicateTargets = mappings
      .map((item) => item.newPartCode)
      .filter((code, index, all) => all.indexOf(code) !== index);

    if (duplicateTargets.length > 0) {
      return res.status(409).json({
        message: "Duplicate target part codes generated",
        duplicates: [...new Set(duplicateTargets)],
      });
    }

    if (mappings.length === 0) {
      return res.json({
        message: "No part codes need migration",
        updatedCount: 0,
        skippedCount: skipped.length,
        skipped,
        mappings: [],
        preview: migration.preview || null,
      });
    }

    const targetCodes = mappings.map(item => item.newPartCode);
    const conflicts = await prisma.part.findMany({
      where: {
        partCode: { in: targetCodes },
        id: { notIn: mappings.map(item => item.id) },
      },
      select: { id: true, partCode: true },
    });

    if (conflicts.length > 0) {
      return res.status(409).json({
        message: "Target part codes already exist",
        conflicts: conflicts.map(mapDoc),
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const mapping of mappings) {
        await updatePartCodeReferences(tx, mapping);
      }
    }, { timeout: 60000 });

    res.json({
      message: "Part codes migrated to primary customer format",
      updatedCount: mappings.length,
      skippedCount: skipped.length,
      skipped,
      mappings,
      preview: migration.preview || null,
    });
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    let {
      partBases,
      attachments: attachmentsPayload,
      deletedAttachmentIds,
      replacedAttachments,
      existingPhotos,
      ...partData
    } = req.body;

    if (partBases !== undefined) {
      partBases = parseJsonField(partBases, []);
      if (!Array.isArray(partBases)) partBases = [];
    }
    replacedAttachments = parseJsonField(replacedAttachments, []);
    if (!Array.isArray(replacedAttachments)) replacedAttachments = [];

    const data = normalizePartPermissions(normalizeOptionalSelects(normalizePartType(
      normalizePartAssemblyPolicy(normalizeRawType(normalizeItemType(normalizePlanningPolicy(convertNumericFields(partData, PART_NUMERIC_FIELDS)))))
    , false)));
    if (typeof data.customerCodes === 'string') {
      data.customerCodes = parseJsonField(data.customerCodes, data.customerCodes);
    }

    const currentPart = await prisma.part.findUnique({
      where: { id: req.params.id },
      include: { material: true, partBases: true, attachments: true },
    });
    if (!currentPart) return res.status(404).json({ message: "Part not found" });
    await normalizeLinkedCustomers(data, currentPart.customerCode);

    // Hitung foto akhir: pertahankan URL yang ada di existingPhotos, hapus sisanya dari disk
    const dbPhotos = Array.isArray(currentPart.photos) ? currentPart.photos : [];
    const keptUrls = (() => {
      const parsed = parseJsonField(existingPhotos, null);
      return Array.isArray(parsed) ? parsed : dbPhotos.map((p) => p.fileUrl);
    })();
    dbPhotos.filter((p) => !keptUrls.includes(p.fileUrl)).forEach((p) => deletePartPhoto(p.fileUrl));
    const remaining = dbPhotos.filter((p) => keptUrls.includes(p.fileUrl));
    const newPhotos = req.files?.photos?.length > 0 ? req.files.photos.map(toPhotoRecord) : [];
    data.photos = [...remaining, ...newPhotos];

    // Hapus soft-deleted partCode yang bentrok
    if (data.partCode && data.partCode !== currentPart.partCode) {
      const stale = await prisma.part.findFirst({ where: { partCode: data.partCode, isDeleted: true } });
      if (stale) await prisma.part.delete({ where: { id: stale.id } });
    }

    // Soft-delete attachments yang dihapus user
    if (deletedAttachmentIds) {
      const ids = Array.isArray(deletedAttachmentIds)
        ? deletedAttachmentIds
        : parseJsonField(deletedAttachmentIds, []);
      if (ids.length > 0) {
        await prisma.partAttachment.updateMany({
          where: { id: { in: ids }, partId: req.params.id },
          data: { isDeleted: true },
        });
      }
    }

    const cleanedData = stripPartCodeTransientFields(data);

    // Buang field yang tidak bisa di-update langsung
    const {
      id, createdAt, updatedAt,
      material, supplier, process, partBases: _partBases, attachments,
      materialId, supplierId, processId,
      ...updateData
    } = cleanedData;

    if (materialId) updateData.material = { connect: { id: materialId } };
    else if (materialId === null) updateData.material = { disconnect: true };

    if (supplierId) updateData.supplier = { connect: { id: supplierId } };
    else if (supplierId === null) updateData.supplier = { disconnect: true };

    if (processId) updateData.process = { connect: { id: processId } };
    else if (processId === null) updateData.process = { disconnect: true };

    const doc = await prisma.part.update({ where: { id: req.params.id }, data: updateData });

    // Upsert / delete PartBases jika partBases dikirim di payload
    if (partBases !== undefined) {
      const partBaseOps = ['QTN', 'Actual'].map((baseOn) => {
        const existing = currentPart.partBases.find(pb => pb.baseOn === baseOn);
        const incoming = partBases.find(pb => pb.baseOn === baseOn);
        const { baseOn: _bo, ...fields } = incoming || {};
        return upsertOrDeletePartBase(existing, doc.id, baseOn, incoming ? fields : null);
      }).filter(Boolean);
      if (partBaseOps.length > 0) await Promise.all(partBaseOps);
    }

    // Simpan attachment baru dari field 'files'
    await saveAttachmentFiles(doc.id, req.files?.files ?? [], attachmentsPayload, req.user?.username);

    // Update files pada attachment existing dari field 'replacedFiles'
    if (replacedAttachments.length > 0) {
      const replacedFiles = req.files?.replacedFiles ?? [];
      // Pre-compute file slices secara sinkron berdasarkan fileCount
      let replaceOffset = 0;
      const replaceOps = replacedAttachments.map((item) => {
        const count = Number(item.fileCount) || 0;
        const newFiles = replacedFiles.slice(replaceOffset, replaceOffset + count).map(toAttachmentFileRecord);
        replaceOffset += count;
        return { item, newFiles };
      });

      await Promise.all(replaceOps.map(async ({ item, newFiles }) => {
        const current = await prisma.partAttachment.findUnique({ where: { id: item.id } });
        if (!current) return;
        const dbFiles = Array.isArray(current.files) ? current.files : [];
        const keptUrls = Array.isArray(item.existingFiles) ? item.existingFiles : dbFiles.map((f) => f.fileUrl);
        dbFiles.filter((f) => !keptUrls.includes(f.fileUrl)).forEach((f) => deletePartAttachment(f.fileUrl));
        const kept = dbFiles.filter((f) => keptUrls.includes(f.fileUrl));
        return prisma.partAttachment.update({
          where: { id: item.id },
          data: { files: [...kept, ...newFiles] },
        });
      }));
    }

    const transformed = mapDoc(await fetchPartWithIncludes(doc.id));
    await attachCustomersToPartDoc(transformed);
    res.json(transformed);
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    const part = await prisma.part.findUnique({ where: { id: req.params.id }, select: { photos: true } });
    await prisma.part.update({ where: { id: req.params.id }, data: { isDeleted: true } });
    if (part) deletePartPhotos(part.photos);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }
    const parts = await prisma.part.findMany({ where: { id: { in: ids } }, select: { id: true, photos: true } });
    const result = await prisma.part.updateMany({ where: { id: { in: ids } }, data: { isDeleted: true } });
    parts.forEach((p) => deletePartPhotos(p.photos));
    res.json({ deletedCount: result.count });
  } catch (e) { next(e); }
};

exports.bulkCreate = async (req, res, next) => {
  try {
    const { parts } = req.body;
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ message: "parts array required" });
    }

    const success = [], failed = [], duplicates = [];

    for (const partData of parts) {
      try {
        const { partBases, ...partDataOnly } = partData;
        if (partDataOnly.partCode) partDataOnly.partCode = normalizePartCode(partDataOnly.partCode);

        // Resolve materialCode → materialId
        if (!partDataOnly.materialId && partDataOnly.materialCode) {
          const mat = await prisma.material.findUnique({ where: { materialCode: partDataOnly.materialCode } });
          if (mat) partDataOnly.materialId = mat.id;
        }

        // Resolve supplierCode → supplierId
        if (!partDataOnly.supplierId && partDataOnly.supplierCode) {
          const sup = await prisma.supplier.findUnique({ where: { supplierCode: partDataOnly.supplierCode } });
          if (sup) partDataOnly.supplierId = sup.id;
        }

        // Resolve processCode → processId
        if (!partDataOnly.processId && partDataOnly.processCode) {
          const processCode = String(partDataOnly.processCode).trim().toUpperCase();
          const process = await prisma.process.findUnique({ where: { processCode } });
          if (process) partDataOnly.processId = process.id;
        }

        const converted = normalizePartPermissions(normalizeOptionalSelects(normalizePartType(
          normalizePartAssemblyPolicy(normalizeRawType(normalizeItemType(
            normalizePlanningPolicy(convertNumericFields(partDataOnly, PART_NUMERIC_FIELDS)),
          )))
        )));
        if (!converted.partCode) converted.partCode = await buildPartCode(converted);
        const cleanedConverted = stripPartCodeTransientFields(converted);
        const { materialId, supplierId, processId, materialCode, supplierCode, processCode, ...fields } = cleanedConverted;
        const payload = { ...fields };
        if (materialId) payload.material = { connect: { id: materialId } };
        if (supplierId) payload.supplier = { connect: { id: supplierId } };
        if (processId) payload.process = { connect: { id: processId } };

        const existing = await prisma.part.findUnique({ where: { partCode: converted.partCode } });
        let doc;
        if (existing) {
          if (existing.isDeleted) {
            doc = await replaceDeletedPart(existing, payload);
          } else {
            duplicates.push({ partCode: converted.partCode, reason: "Part already exists" });
            continue;
          }
        } else {
          doc = await prisma.part.create({ data: payload });
        }

        await savePartBases(doc.id, Array.isArray(partBases) ? partBases : []);
        success.push(mapDoc(doc));
      } catch (err) {
        failed.push({ partCode: partData.partCode, error: err.message });
      }
    }

    res.json({ success, failed, duplicates });
  } catch (e) { next(e); }
};

// ─── Part Attachment CRUD ─────────────────────────────────────────────────────

exports.listAttachments = async (req, res, next) => {
  try {
    const { q, isDeleted, partId, page = 1, limit = 20 } = req.query;
    const where = { isDeleted: isDeleted !== undefined ? isDeleted === "true" : false };
    if (partId) where.partId = partId;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query);
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.partAttachment.findMany({ where, include: ATTACHMENT_PART_SELECT, orderBy, skip, take: Number(limit) }),
      prisma.partAttachment.count({ where }),
    ]);
    res.json({ items: items.map(mapDoc), total, page: Number(page), limit: Number(limit) });
  } catch (e) { next(e); }
};

exports.getAttachment = async (req, res, next) => {
  try {
    const doc = await prisma.partAttachment.findFirst({
      where: { id: req.params.id, isDeleted: false },
      include: ATTACHMENT_PART_SELECT,
    });
    if (!doc) return res.status(404).json({ message: "Part attachment not found" });
    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};

exports.createAttachment = async (req, res, next) => {
  try {
    const uploadedFiles = req.files || (req.file ? [req.file] : []);
    const { partId, title, description, uploadedBy } = req.body;
    const doc = await prisma.partAttachment.create({
      data: { partId, title, description, uploadedBy, files: uploadedFiles.map(toAttachmentFileRecord) },
      include: ATTACHMENT_PART_SELECT,
    });
    res.status(201).json(mapDoc(doc));
  } catch (e) { next(e); }
};

exports.updateAttachment = async (req, res, next) => {
  try {
    const { existingFiles, title, description, uploadedBy } = req.body;

    const current = await prisma.partAttachment.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: "Part attachment not found" });

    // Hitung files akhir: pertahankan yang ada di existingFiles, hapus sisanya dari disk
    const dbFiles = Array.isArray(current.files) ? current.files : [];
    const keptFiles = (() => {
      const parsed = parseJsonField(existingFiles, null);
      return Array.isArray(parsed) ? parsed : dbFiles;
    })();
    const keptUrls = keptFiles.map((f) => f.fileUrl);
    dbFiles.filter((f) => !keptUrls.includes(f.fileUrl)).forEach((f) => deletePartAttachment(f.fileUrl));

    const newFiles = (req.files ?? []).map(toAttachmentFileRecord);
    const finalFiles = [...keptFiles, ...newFiles];

    const updateData = { files: finalFiles };
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (uploadedBy !== undefined) updateData.uploadedBy = uploadedBy;

    const doc = await prisma.partAttachment.update({
      where: { id: req.params.id },
      data: updateData,
      include: ATTACHMENT_PART_SELECT,
    });
    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};

exports.removeAttachment = async (req, res, next) => {
  try {
    const doc = await prisma.partAttachment.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ message: "Part attachment not found" });
    await prisma.partAttachment.update({ where: { id: req.params.id }, data: { isDeleted: true } });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

exports.bulkRemoveAttachments = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }
    const result = await prisma.partAttachment.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });
    res.json({ deletedCount: result.count });
  } catch (e) { next(e); }
};

exports.getAttachmentsByPartId = async (req, res, next) => {
  try {
    const { partId } = req.params;
    const { isDeleted } = req.query;
    const items = await prisma.partAttachment.findMany({
      where: { partId, isDeleted: isDeleted === "true" },
      orderBy: { createdAt: "desc" },
    });
    res.json(items.map(mapDoc));
  } catch (e) { next(e); }
};
