/* eslint-disable no-console */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const base = `http://localhost:${process.env.PORT || 5017}/api`;
const marker = "SIM-BRACKET-COMP-AUG-2026";
const bomNumber = "MBOM-20260729-008";
const fgPartCode = "C002-C004-000";
const paintVendorCode = "V-SIM-PAINT";
let token;

async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
}

const detailPayload = (detail, vendorId, weldMachineId) => ({
  id: detail.id,
  parentDetailId: detail.parentDetailId || null,
  levelComponent: detail.levelComponent,
  partId: detail.partId,
  qty: detail.qty,
  uomCode: detail.uomCode || "pcs",
  category: detail.category,
  assemblyPolicyOverride: detail.assemblyPolicyOverride,
  materialThickness: detail.materialThickness,
  materialWidth: detail.materialWidth,
  materialPitch: detail.materialPitch,
  materialCavity: detail.materialCavity,
  materialDensity: detail.materialDensity,
  grossWeight: detail.grossWeight,
  defaultGrossWeight: detail.defaultGrossWeight,
  materialFormId: detail.materialFormId,
  materialScheme: detail.materialScheme,
  alternateMaterialFormId: detail.alternateMaterialFormId,
  alternateMaterialPitch: detail.alternateMaterialPitch,
  alternateMaterialCavity: detail.alternateMaterialCavity,
  alternateGrossWeight: detail.alternateGrossWeight,
  leadTime: detail.leadTime,
  leadTimeUnit: detail.leadTimeUnit,
  notes: detail.notes,
  mbomProcesses: (detail.mbomProcesses || []).map((process) => {
    const processCode = process.process?.processCode;
    const partCode = detail.partCode || detail.part?.partCode;
    const isPaint = processCode === "PAINT" && partCode === "C002-C004-020";
    const isMissingWeldMachine = processCode === "WELD"
      && partCode === "C002-C004-060"
      && !process.machineId;
    return {
      id: process.id,
      processId: process.processId,
      occurrenceCode: process.occurrenceCode,
      routingNumber: process.routingNumber,
      machineId: isPaint ? null : (isMissingWeldMachine ? weldMachineId : process.machineId),
      alternativeMachineIds: process.alternativeMachineIds || [],
      diesId: process.diesId,
      routingMode: isPaint ? "VENDOR" : process.routingMode,
      vendorId: isPaint ? vendorId : process.vendorId,
      sequence: process.sequence,
      cycleTime: process.cycleTime,
      notes: process.notes,
    };
  }),
});

(async () => {
  const login = await api("POST", "/auth/login", {
    identifier: process.env.DEFAULT_ADMIN_USERNAME || "admin",
    password: process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
  });
  token = login.token;

  const [fg, bom, machines, vendors] = await Promise.all([
    api("GET", `/master-data/parts/${encodeURIComponent(fgPartCode)}`),
    api("GET", `/mbom/mbom/${encodeURIComponent(bomNumber)}`),
    api("GET", "/master-data/machines?status=Active&limit=200"),
    api("GET", "/master-data/vendors?limit=200"),
  ]);

  let vendor = (vendors.items || []).find((row) => row.vendorCode === paintVendorCode);
  if (!vendor) {
    vendor = await api("POST", "/master-data/vendors", {
      vendorCode: paintVendorCode,
      vendorName: "Vendor Painting - Simulation",
      leadTimeDays: 3,
      status: "Active",
      users: ["operational"],
      notes: `${marker}; vendor proses PAINT untuk simulasi end-to-end.`,
    });
  } else if (vendor.status !== "Active") {
    vendor = await api("PATCH", `/master-data/vendors/${encodeURIComponent(vendor.id)}`, {
      status: "Active",
      notes: `${vendor.notes || ""}; ${marker} reactivated`.replace(/^;\s*/, ""),
    });
  }

  const weldMachine = (machines.items || []).find((row) => row.machineCode === "W-1" && row.status === "Active");
  if (!weldMachine) throw new Error("Machine W-1 aktif tidak ditemukan.");

  let updatedFg = fg;
  if (!fg.baseUomCode || !fg.productionUomCode) {
    updatedFg = await api("PATCH", `/master-data/parts/${encodeURIComponent(fg.id)}`, {
      baseUomCode: fg.baseUomCode || "pcs",
      productionUomCode: fg.productionUomCode || "pcs",
    });
  }

  const paintRoute = (bom.details || []).flatMap((detail) => detail.mbomProcesses || [])
    .find((process) => process.process?.processCode === "PAINT");
  const weld060Route = (bom.details || [])
    .find((detail) => (detail.partCode || detail.part?.partCode) === "C002-C004-060")
    ?.mbomProcesses?.find((process) => process.process?.processCode === "WELD");
  const requiresBomPatch = !bom.uomCode
    || paintRoute?.routingMode !== "VENDOR"
    || paintRoute?.vendorId !== vendor.id
    || !weld060Route?.machineId;

  let updatedBom = bom;
  if (requiresBomPatch) {
    updatedBom = await api("PATCH", `/mbom/mbom/${encodeURIComponent(bom.id)}`, {
      header: {
        uomCode: bom.uomCode || "pcs",
        notes: bom.notes,
      },
      details: (bom.details || []).map((detail) => detailPayload(detail, vendor.id, weldMachine.id)),
    });
  }

  const readiness = await api("GET", "/planning/mps/MPS-2026-001/readiness");
  console.log(JSON.stringify({
    fg: {
      partCode: updatedFg.partCode,
      baseUomCode: updatedFg.baseUomCode,
      productionUomCode: updatedFg.productionUomCode,
    },
    vendor: { id: vendor.id, vendorCode: vendor.vendorCode, vendorName: vendor.vendorName, status: vendor.status },
    weldMachine: { id: weldMachine.id, machineCode: weldMachine.machineCode },
    bom: { id: updatedBom.id, noReg: updatedBom.noReg, uomCode: updatedBom.uomCode },
    readiness,
  }, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
