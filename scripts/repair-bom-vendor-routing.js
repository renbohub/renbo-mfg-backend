"use strict";

const { prisma, disconnectDatabase } = require("../src/prisma");
const { queueDirtyPartCodes } = require("../src/prisma/utils/mrpDirtyQueue");

const execute = process.argv.includes("--execute");
const ROOT_PART_CODE = "C003-0010-000";
const EFFECTIVE_DATE = new Date("2026-08-31T17:00:00.000Z"); // 2026-09-01 Asia/Jakarta
const REVISION_NOTE = "Normalisasi vendor code dan harga per routing process";

const detailFields = [
  "levelComponent", "partId", "supplierId", "qty", "uomCode", "category",
  "assemblyPolicyOverride", "scrapFactor", "materialThickness", "materialWidth",
  "materialPitch", "materialCavity", "materialDensity", "grossWeight",
  "defaultGrossWeight", "materialFormId", "materialScheme", "alternateMaterialFormId",
  "alternateMaterialPitch", "alternateMaterialCavity", "alternateGrossWeight",
  "leadTime", "leadTimeUnit", "notes",
];
const processFields = [
  "processId", "occurrenceCode", "routingNumber", "machineId",
  "machineSpecificationCode", "alternativeMachineIds", "diesId", "routingMode",
  "vendorId", "routingOperationId", "sequence", "cycleTime", "notes",
];

const pick = (source, fields) => Object.fromEntries(fields.map((field) => [field, source[field]]));
const one = (rows, label) => {
  if (rows.length !== 1) throw new Error(`${label}: diharapkan tepat 1 record, ditemukan ${rows.length}.`);
  return rows[0];
};

async function nextNoReg(tx) {
  const prefix = "MBOM-20260901-";
  const latest = await tx.mBOMHeader.findFirst({
    where: { noReg: { startsWith: prefix } },
    orderBy: { noReg: "desc" },
    select: { noReg: true },
  });
  const next = Number(String(latest?.noReg || "").slice(prefix.length)) + 1 || 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

async function loadScope(db) {
  const [rootPart, scopedParts, vendors, routingProcesses] = await Promise.all([
    db.part.findFirst({
      where: { partCode: ROOT_PART_CODE, isDeleted: false },
      select: {
        id: true, partCode: true,
        mbomHeaders: {
          where: { isDeleted: false }, orderBy: [{ revision: "desc" }, { updatedAt: "desc" }], take: 1,
          include: {
            details: {
              where: { isDeleted: false }, orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
              include: { part: { select: { partCode: true } }, mbomProcesses: { where: { isDeleted: false }, orderBy: { sequence: "asc" }, include: { process: { select: { processCode: true } } } } },
            },
          },
        },
      },
    }),
    db.part.findMany({ where: { partCode: { in: ["C003-0010-010", "C003-0010-020"] }, isDeleted: false }, select: { id: true, partCode: true } }),
    db.vendor.findMany({ where: { vendorCode: { in: ["V001", "V002"] }, isDeleted: false, status: "Active" }, select: { id: true, vendorCode: true } }),
    db.process.findMany({ where: { processCode: { in: ["INSP-PACK", "GSN"] }, isDeleted: false }, select: { id: true, processCode: true, processName: true } }),
  ]);
  if (!rootPart) throw new Error(`Part root ${ROOT_PART_CODE} tidak ditemukan.`);
  const source = one(rootPart.mbomHeaders, `BOM aktif ${ROOT_PART_CODE}`);
  const partByCode = new Map(scopedParts.map((row) => [row.partCode, row]));
  const vendorByCode = new Map(vendors.map((row) => [row.vendorCode, row]));
  const processByCode = new Map(routingProcesses.map((row) => [row.processCode, row]));
  ["C003-0010-010", "C003-0010-020"].forEach((code) => { if (!partByCode.has(code)) throw new Error(`Part ${code} tidak ditemukan.`); });
  ["V001", "V002"].forEach((code) => { if (!vendorByCode.has(code)) throw new Error(`Vendor aktif ${code} tidak ditemukan.`); });
  ["INSP-PACK", "GSN"].forEach((code) => { if (!processByCode.has(code)) throw new Error(`Process ${code} tidak ditemukan.`); });
  return { rootPart, source, partByCode, vendorByCode, processByCode };
}

async function repair(tx) {
  const scope = await loadScope(tx);
  const { source, partByCode, vendorByCode, processByCode } = scope;
  const existingRevision = await tx.mBOMHeader.findFirst({
    where: { partId: scope.rootPart.id, revisionNote: REVISION_NOTE, isDeleted: false },
    orderBy: { revision: "desc" },
    select: { id: true, noReg: true, revision: true },
  });

  const vendorProcessByCode = new Map();
  for (const [processCode, vendorCode] of [["INSP-PACK", "V001"], ["GSN", "V002"]]) {
    const process = processByCode.get(processCode);
    const vendorProcess = await tx.vendorProcess.upsert({
      where: { vendorProcessCode: processCode },
      update: { vendorProcessName: process.processName || processCode, isDeleted: false },
      create: { vendorProcessCode: processCode, vendorProcessName: process.processName || processCode, category: processCode === "INSP-PACK" ? "INSPECTION" : "OTHER", notes: "Diselaraskan dengan routing BOM" },
      select: { id: true, vendorProcessCode: true },
    });
    vendorProcessByCode.set(processCode, vendorProcess);
    const vendorId = vendorByCode.get(vendorCode).id;
    const assignment = await tx.entityVendorProcess.findFirst({ where: { entityType: "vendor", vendorProcessId: vendorProcess.id, vendorId }, select: { id: true } });
    if (!assignment) await tx.entityVendorProcess.create({ data: { entityType: "vendor", vendorProcessId: vendorProcess.id, vendorId } });
  }

  const priceRepairs = [
    { partCode: "C003-0010-010", vendorCode: "V001", fromProcessCode: "GSN", toProcessCode: "INSP-PACK", expectedPrice: 45 },
    { partCode: "C003-0010-020", vendorCode: "V002", fromProcessCode: "PAINT", toProcessCode: "GSN", expectedPrice: 260 },
  ];
  for (const item of priceRepairs) {
    const matches = await tx.vendorPriceListDetail.findMany({
      where: {
        isDeleted: false,
        unitPrice: item.expectedPrice,
        vendorPriceList: { is: { isDeleted: false, isActive: true, partId: partByCode.get(item.partCode).id, vendorId: vendorByCode.get(item.vendorCode).id } },
      },
      include: { vendorProcess: { select: { vendorProcessCode: true } } },
    });
    const detail = one(matches, `Harga ${item.vendorCode}/${item.partCode}/${item.expectedPrice}`);
    if (![item.fromProcessCode, item.toProcessCode].includes(detail.vendorProcess.vendorProcessCode)) {
      throw new Error(`Harga ${item.vendorCode}/${item.partCode} terhubung ke proses tak terduga ${detail.vendorProcess.vendorProcessCode}.`);
    }
    await tx.vendorPriceListDetail.update({ where: { id: detail.id }, data: { vendorProcessId: vendorProcessByCode.get(item.toProcessCode).id } });
  }

  if (existingRevision) return { ...scope, revision: existingRevision, alreadyCreated: true };

  const noReg = await nextNoReg(tx);
  const maxRevision = await tx.mBOMHeader.aggregate({ where: { partId: scope.rootPart.id, isDeleted: false }, _max: { revision: true } });
  const header = await tx.mBOMHeader.create({
    data: {
      noReg, partId: scope.rootPart.id, uomCode: source.uomCode,
      revision: Number(maxRevision._max.revision || 0) + 1,
      revisionOfMbomId: source.id, revisionNote: REVISION_NOTE,
      effectiveDate: EFFECTIVE_DATE, expiryDate: null,
      createdBy: "system-vendor-routing-repair", notes: source.notes, isDeleted: false,
    },
    select: { id: true, noReg: true, revision: true },
  });

  const detailIdMap = new Map();
  for (const detail of source.details) {
    const created = await tx.mBOMDetail.create({
      data: { ...pick(detail, detailFields), noReg, parentDetailId: null, vendorId: null, createdBy: "system-vendor-routing-repair", isDeleted: false },
      select: { id: true },
    });
    detailIdMap.set(detail.id, created.id);
    for (const process of detail.mbomProcesses) {
      const processCode = process.process?.processCode;
      const vendorCode = detail.part?.partCode === "C003-0010-010" && processCode === "INSP-PACK" ? "V001"
        : detail.part?.partCode === "C003-0010-020" && processCode === "GSN" ? "V002" : null;
      await tx.mBOMProcess.create({
        data: {
          ...pick(process, processFields), noReg, mbomDetailId: created.id, isDeleted: false,
          ...(vendorCode ? { routingMode: "VENDOR", vendorId: vendorByCode.get(vendorCode).id, machineId: null, machineSpecificationCode: null, alternativeMachineIds: [], cycleTime: 0 } : {}),
        },
      });
    }
  }
  for (const detail of source.details) {
    if (!detail.parentDetailId) continue;
    await tx.mBOMDetail.update({ where: { id: detailIdMap.get(detail.id) }, data: { parentDetailId: detailIdMap.get(detail.parentDetailId) } });
  }
  await tx.mBOMHeader.update({ where: { id: source.id }, data: { expiryDate: new Date(EFFECTIVE_DATE.getTime() - 1) } });
  await queueDirtyPartCodes(tx, [ROOT_PART_CODE, ...partByCode.keys()], { reason: "BOM", sourceNumber: noReg, notes: REVISION_NOTE });
  return { ...scope, revision: header, alreadyCreated: false };
}

async function main() {
  const scope = await loadScope(prisma);
  const summary = {
    mode: execute ? "EXECUTE" : "DRY_RUN",
    sourceBom: `${scope.source.noReg} rev ${scope.source.revision}`,
    effectiveDate: EFFECTIVE_DATE.toISOString(),
    priceCorrections: ["V001 + C003-0010-010 + INSP-PACK = 45/pcs", "V002 + C003-0010-020 + GSN = 260/pcs"],
    routingCorrections: ["C003-0010-010: INSP-PACK -> V001", "C003-0010-020: GSN -> V002"],
  };
  if (!execute) return console.log(JSON.stringify(summary, null, 2));
  const result = await prisma.$transaction((tx) => repair(tx), { timeout: 30000 });
  console.log(JSON.stringify({ ...summary, result: { bom: result.revision, alreadyCreated: result.alreadyCreated } }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(disconnectDatabase);
