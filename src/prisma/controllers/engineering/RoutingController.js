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

exports.listWorkCenters = async (_req, res, next) => {
  try { res.json({ items: (await loadWorkCenters()).map(mapDoc) }); }
  catch (error) { next(error); }
};

exports.getWorkCenter = async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const item = (await loadWorkCenters()).find((row) => row.id === key || row.workCenterCode === key);
    if (!item) return res.status(404).json({ message: "Work Center tidak ditemukan." });
    res.json(mapDoc(item));
  } catch (error) { next(error); }
};

exports.createWorkCenter = async (req, res, next) => {
  try {
    const { machineIds = [], ...data } = req.body;
    const item = await prisma.workCenter.create({ data: { ...data, machines: { create: machineIds.map((machineId, index) => ({ machineId, isPrimary: index === 0 })) } }, include: { machines: { include: { machine: true } } } });
    res.status(201).json(mapDoc(item));
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
