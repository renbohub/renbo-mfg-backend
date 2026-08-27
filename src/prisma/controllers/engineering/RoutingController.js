const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");
const { compareRoutingOperations } = require("../../utils/routingSequence");

const text = (value) => String(value || "").trim();
const safeCode = (value) => text(value).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "UNCLASSIFIED";
const machineGroupKey = (machine) => text(machine.machineSpecificationCode || machine.machineFamily || machine.machineType || "UNCLASSIFIED");

function projectedWorkCenter(groupKey, machines) {
  const activeMachines = machines.filter((machine) => machine.status === "Active");
  const representative = activeMachines[0] || machines[0] || {};
  const capacityMinutesPerDay = activeMachines.reduce((total, machine) => total + (Number(machine.defaultShiftHours) || 8) * 60, 0);
  return {
    id: `machine-spec:${safeCode(groupKey)}`,
    workCenterCode: `WC-${safeCode(groupKey)}`,
    workCenterName: representative.machineSpecificationName || representative.machineFamily || representative.machineType || groupKey,
    plantCode: representative.warehouseCode || null,
    lineCode: [...new Set(machines.map((machine) => machine.lineCode).filter(Boolean))].join(", ") || null,
    capacityMinutesPerDay,
    efficiencyPercent: 100,
    workingHourProfileId: null,
    isActive: activeMachines.length > 0,
    notes: "Sumber: Machine Specification pada Master Machine",
    source: "MACHINE_MASTER",
    machines: machines.map((machine, index) => ({ machineId: machine.id, isPrimary: index === 0, machine })),
  };
}

async function loadWorkCenters() {
  const [stored, machines] = await Promise.all([
    prisma.workCenter.findMany({ include: { machines: { include: { machine: true } } }, orderBy: { workCenterCode: "asc" } }),
    prisma.machine.findMany({
      where: { isDeleted: false },
      select: { id: true, machineCode: true, machineName: true, machineType: true, machineFamily: true, machineSpecificationCode: true, machineSpecificationName: true, status: true, defaultShiftHours: true, warehouseCode: true, lineCode: true, capacity: true, capacityUnit: true },
      orderBy: [{ machineSpecificationCode: "asc" }, { machineCode: "asc" }],
    }),
  ]);
  const assignedMachineIds = new Set(stored.flatMap((center) => center.machines.map((link) => link.machineId)));
  const groups = new Map();
  machines.filter((machine) => !assignedMachineIds.has(machine.id)).forEach((machine) => {
    const key = machineGroupKey(machine);
    const rows = groups.get(key) || [];
    rows.push(machine);
    groups.set(key, rows);
  });
  const projected = [...groups.entries()].map(([key, rows]) => projectedWorkCenter(key, rows));
  return [...stored.map((item) => ({ ...item, source: "WORK_CENTER_MASTER" })), ...projected]
    .sort((left, right) => left.workCenterCode.localeCompare(right.workCenterCode, undefined, { numeric: true }));
}

function workCenterForProcess(process) {
  if (String(process.routingMode || "INHOUSE").toUpperCase() === "VENDOR") return null;
  const specification = process.machineSpecificationCode || process.machine?.machineSpecificationCode;
  if (!specification && !process.machine) return null;
  return projectedWorkCenter(specification || machineGroupKey(process.machine), process.machine ? [process.machine] : []);
}

function workCenterDocument(item) {
  const document = mapDoc(item);
  const links = Array.isArray(document.machines) ? document.machines : [];
  const primary = links.find((link) => link.isPrimary) || links[0] || null;
  return {
    ...document,
    machineIds: links.map((link) => link.machineId),
    primaryMachineId: primary?.machineId || null,
    primaryMachineCode: primary?.machine?.machineCode || null,
    machineCount: links.length,
    effectiveCapacityMinutes: Math.round((Number(document.capacityMinutesPerDay) || 0) * (Number(document.efficiencyPercent) || 0)) / 100,
    isVirtual: document.source === "MACHINE_MASTER",
    sourceLabel: document.source === "MACHINE_MASTER" ? "Otomatis dari spesifikasi mesin" : "Master Work Center",
  };
}

function workCenterInput(body = {}, fallback = {}) {
  const machineIds = [...new Set((Array.isArray(body.machineIds) ? body.machineIds : fallback.machineIds || []).map(text).filter(Boolean))];
  const primaryMachineId = text(body.primaryMachineId || fallback.primaryMachineId || machineIds[0]);
  if (!text(body.workCenterCode || fallback.workCenterCode)) throw Object.assign(new Error("Kode Work Center wajib diisi."), { statusCode: 400 });
  if (!text(body.workCenterName || fallback.workCenterName)) throw Object.assign(new Error("Nama Work Center wajib diisi."), { statusCode: 400 });
  if (!machineIds.length) throw Object.assign(new Error("Pilih minimal satu mesin untuk Work Center."), { statusCode: 400 });
  if (primaryMachineId && !machineIds.includes(primaryMachineId)) throw Object.assign(new Error("Mesin primary harus termasuk dalam mesin yang dipilih."), { statusCode: 400 });
  const efficiencyPercent = Number(body.efficiencyPercent ?? fallback.efficiencyPercent ?? 100);
  if (!Number.isFinite(efficiencyPercent) || efficiencyPercent <= 0 || efficiencyPercent > 100) throw Object.assign(new Error("Efisiensi Work Center harus lebih dari 0 dan maksimal 100%."), { statusCode: 400 });
  const capacityMinutesPerDay = Number(body.capacityMinutesPerDay ?? fallback.capacityMinutesPerDay ?? 0);
  if (!Number.isFinite(capacityMinutesPerDay) || capacityMinutesPerDay < 0) throw Object.assign(new Error("Kapasitas harian tidak boleh negatif."), { statusCode: 400 });
  return {
    data: {
      workCenterCode: text(body.workCenterCode || fallback.workCenterCode).toUpperCase(),
      workCenterName: text(body.workCenterName || fallback.workCenterName),
      plantCode: text(body.plantCode ?? fallback.plantCode) || null,
      lineCode: text(body.lineCode ?? fallback.lineCode) || null,
      capacityMinutesPerDay,
      efficiencyPercent,
      workingHourProfileId: text(body.workingHourProfileId ?? fallback.workingHourProfileId) || null,
      isActive: body.isActive === undefined ? fallback.isActive !== false : Boolean(body.isActive),
      notes: text(body.notes ?? fallback.notes) || null,
    },
    machineIds,
    primaryMachineId: primaryMachineId || machineIds[0],
  };
}

async function assertMachinesAvailable(client, machineIds, excludedWorkCenterId = null) {
  const machines = await client.machine.findMany({ where: { id: { in: machineIds }, isDeleted: false }, select: { id: true, machineCode: true } });
  if (machines.length !== machineIds.length) throw Object.assign(new Error("Satu atau lebih mesin yang dipilih tidak ditemukan."), { statusCode: 400 });
  const conflicts = await client.workCenterMachine.findMany({
    where: { machineId: { in: machineIds }, ...(excludedWorkCenterId ? { workCenterId: { not: excludedWorkCenterId } } : {}) },
    include: { machine: { select: { machineCode: true } }, workCenter: { select: { workCenterCode: true } } },
  });
  if (conflicts.length) {
    const labels = conflicts.map((link) => `${link.machine.machineCode} → ${link.workCenter.workCenterCode}`).join(", ");
    throw Object.assign(new Error(`Mesin sudah terhubung ke Work Center lain: ${labels}.`), { statusCode: 409 });
  }
}

async function loadRoutings() {
  const [stored, mboms] = await Promise.all([
    prisma.routingHeader.findMany({
      where: { isDeleted: false },
      include: { part: true, operations: { include: { workCenter: true }, orderBy: { sequence: "asc" } } },
      orderBy: { routingCode: "asc" },
    }),
    prisma.mBOMHeader.findMany({
      where: { isDeleted: false },
      include: {
        part: true,
        details: {
          where: { isDeleted: false },
          include: {
            part: { select: { id: true, partCode: true, partNumber: true, partName: true } },
            mbomProcesses: {
              where: { isDeleted: false },
              include: { process: true, machine: true, vendor: true },
            },
          },
        },
      },
      orderBy: [{ noReg: "asc" }, { revision: "desc" }],
    }),
  ]);
  const storedCodes = new Set(stored.map((item) => item.routingCode));
  const projected = mboms.map((header) => {
    const processes = header.details.flatMap((detail) => detail.mbomProcesses.map((process) => ({ ...process, detail })))
      .sort(compareRoutingOperations);
    return {
      id: `mbom-routing:${header.id}`,
      routingCode: `MBOM-${header.noReg}`,
      partId: header.partId,
      part: header.part,
      revision: String(header.revision || 1),
      status: processes.length ? "ACTIVE" : "INCOMPLETE",
      effectiveFrom: header.effectiveDate,
      effectiveUntil: header.expiryDate,
      notes: `Sumber routing MBOM ${header.noReg}`,
      source: "MBOM",
      noReg: header.noReg,
      operations: processes.map((process, index) => {
        const workCenter = workCenterForProcess(process);
        return {
          id: `mbom-operation:${process.id}`,
          routingHeaderId: `mbom-routing:${header.id}`,
          sequence: (index + 1) * 10,
          routingNumber: process.routingNumber,
          occurrenceCode: process.occurrenceCode,
          processId: process.processId,
          process: process.process,
          componentPart: process.detail.part,
          workCenterId: workCenter?.id || null,
          workCenter,
          setupMinutes: 0,
          cycleSeconds: Number(process.cycleTime || 0),
          runMinutes: Number(process.cycleTime || 0) / 60,
          yieldPercent: 100,
          isSubcontract: String(process.routingMode || "INHOUSE").toUpperCase() === "VENDOR",
          isActive: true,
          machine: process.machine,
          machineSpecificationCode: process.machineSpecificationCode || process.machine?.machineSpecificationCode || null,
          vendor: process.vendor,
          mbomProcessId: process.id,
        };
      }),
    };
  }).filter((item) => !storedCodes.has(item.routingCode));
  return [...stored.map((item) => ({ ...item, source: "ROUTING_MASTER" })), ...projected]
    .sort((left, right) => left.routingCode.localeCompare(right.routingCode, undefined, { numeric: true }));
}

exports.listWorkCenters = async (req, res, next) => {
  try {
    const q = text(req.query.q).toLowerCase();
    const inactive = String(req.query.isDeleted || "false") === "true";
    const all = (await loadWorkCenters()).map(workCenterDocument);
    const items = all.filter((item) => Boolean(item.isActive) !== inactive)
      .filter((item) => !q || `${item.workCenterCode} ${item.workCenterName} ${item.plantCode || ""} ${item.lineCode || ""} ${item.primaryMachineCode || ""} ${(item.machines || []).map((link) => `${link.machine?.machineCode || ""} ${link.machine?.machineName || ""}`).join(" ")}`.toLowerCase().includes(q));
    res.json({ items, total: items.length });
  }
  catch (error) { next(error); }
};

exports.getWorkCenter = async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const item = (await loadWorkCenters()).find((row) => row.id === key || row.workCenterCode === key);
    if (!item) return res.status(404).json({ message: "Work Center tidak ditemukan." });
    res.json(workCenterDocument(item));
  } catch (error) { next(error); }
};

exports.createWorkCenter = async (req, res, next) => {
  try {
    const input = workCenterInput(req.body);
    const item = await prisma.$transaction(async (tx) => {
      await assertMachinesAvailable(tx, input.machineIds);
      return tx.workCenter.create({
        data: { ...input.data, machines: { create: input.machineIds.map((machineId) => ({ machineId, isPrimary: machineId === input.primaryMachineId })) } },
        include: { machines: { include: { machine: true } } },
      });
    });
    res.status(201).json(workCenterDocument({ ...item, source: "WORK_CENTER_MASTER" }));
  } catch (error) { next(error); }
};

exports.updateWorkCenter = async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const stored = await prisma.workCenter.findFirst({ where: { OR: [{ id: key }, { workCenterCode: key }] }, include: { machines: { include: { machine: true } } } });
    const projected = stored ? null : (await loadWorkCenters()).find((item) => item.id === key || item.workCenterCode === key);
    if (!stored && !projected) return res.status(404).json({ message: "Work Center tidak ditemukan." });
    const fallback = workCenterDocument(stored ? { ...stored, source: "WORK_CENTER_MASTER" } : projected);
    const input = workCenterInput(req.body, fallback);
    const item = await prisma.$transaction(async (tx) => {
      await assertMachinesAvailable(tx, input.machineIds, stored?.id || null);
      if (!stored) {
        return tx.workCenter.create({
          data: { ...input.data, machines: { create: input.machineIds.map((machineId) => ({ machineId, isPrimary: machineId === input.primaryMachineId })) } },
          include: { machines: { include: { machine: true } } },
        });
      }
      await tx.workCenterMachine.deleteMany({ where: { workCenterId: stored.id } });
      return tx.workCenter.update({
        where: { id: stored.id },
        data: { ...input.data, machines: { create: input.machineIds.map((machineId) => ({ machineId, isPrimary: machineId === input.primaryMachineId })) } },
        include: { machines: { include: { machine: true } } },
      });
    });
    res.json(workCenterDocument({ ...item, source: "WORK_CENTER_MASTER" }));
  } catch (error) { next(error); }
};

exports.removeWorkCenter = async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const item = await prisma.workCenter.findFirst({ where: { OR: [{ id: key }, { workCenterCode: key }] } });
    if (!item) return res.status(404).json({ message: "Work Center master tidak ditemukan." });
    const updated = await prisma.workCenter.update({ where: { id: item.id }, data: { isActive: false }, include: { machines: { include: { machine: true } } } });
    res.json(workCenterDocument({ ...updated, source: "WORK_CENTER_MASTER" }));
  } catch (error) { next(error); }
};

exports.bulkRemoveWorkCenters = async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(text).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ message: "Pilih Work Center yang akan dinonaktifkan." });
    const result = await prisma.workCenter.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
    res.json({ updated: result.count });
  } catch (error) { next(error); }
};

exports.listRoutings = async (_req, res, next) => {
  try { res.json({ items: (await loadRoutings()).map(mapDoc) }); }
  catch (error) { next(error); }
};

exports.getRouting = async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const item = (await loadRoutings()).find((row) => row.id === key || row.routingCode === key || row.noReg === key);
    if (!item) return res.status(404).json({ message: "Routing tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.createRouting = async (req, res, next) => {
  try {
    const { operations = [], ...data } = req.body;
    const sequences = operations.map((item) => item.sequence);
    if (new Set(sequences).size !== sequences.length) return res.status(400).json({ message: "Routing operation sequence must be unique" });
    const item = await prisma.routingHeader.create({ data: { ...data, operations: { create: operations } }, include: { part: true, operations: { include: { workCenter: true }, orderBy: { sequence: "asc" } } } });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.linkMbomProcess = async (req, res, next) => {
  try {
    const item = await prisma.mBOMProcess.update({ where: { id: req.params.id }, data: { routingOperationId: req.body.routingOperationId || null }, include: { routingOperation: true, machine: true, process: true } });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};
