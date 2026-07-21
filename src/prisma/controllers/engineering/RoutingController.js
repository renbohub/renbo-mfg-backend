const { prisma } = require("../../index");
const { mapDoc } = require("../../utils/mapDoc");

exports.listWorkCenters = async (_req, res, next) => {
  try { res.json({ items: (await prisma.workCenter.findMany({ include: { machines: { include: { machine: true } } }, orderBy: { workCenterCode: "asc" } })).map(mapDoc) }); }
  catch (error) { next(error); }
};
exports.createWorkCenter = async (req, res, next) => {
  try {
    const { machineIds = [], ...data } = req.body;
    const item = await prisma.workCenter.create({ data: { ...data, machines: { create: machineIds.map((machineId, index) => ({ machineId, isPrimary: index === 0 })) } }, include: { machines: { include: { machine: true } } } });
    res.status(201).json(mapDoc(item));
  } catch (error) { next(error); }
};
exports.listRoutings = async (_req, res, next) => {
  try { res.json({ items: (await prisma.routingHeader.findMany({ where: { isDeleted: false }, include: { part: true, operations: { include: { workCenter: true }, orderBy: { sequence: "asc" } } }, orderBy: { routingCode: "asc" } })).map(mapDoc) }); }
  catch (error) { next(error); }
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
