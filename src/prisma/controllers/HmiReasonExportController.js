"use strict";
const { prisma } = require("../index");
const service = require("../services/hmiReasonMasterService");
// A narrow read endpoint: existing registered/revocable export-token auth is
// applied by the router. HMI cannot send SQL or mutate master data here.
exports.catalog = async (req, res, next) => {
  try {
    if (typeof req.query.areaCode !== "string" || !req.query.areaCode.trim()) {
      return res.status(400).json({ message: "areaCode wajib diisi untuk katalog HMI." });
    }
    const catalog = await service.catalog(prisma, { areaCode: req.query.areaCode });
    const clean = rows => rows.map(row => ({ id: row.id, description: row.description, areaCode: row.areaCode,
      ...(row.stopClass ? { stopClass: row.stopClass, countsAsLoss: row.countsAsLoss } : {}),
      children: row.children.map(child => ({ id: child.id, description: child.description })) }));
    res.set("Cache-Control", "no-store").json({ source: catalog.source, rejections: clean(catalog.rejections), downtimes: clean(catalog.downtimes) });
  } catch (error) { next(error); }
};
