"use strict";

const { prisma } = require("../../index");
const { buildYearlyDemand } = require("../../services/planning/yearlyDemandService");

exports.list = async (req, res, next) => {
  try {
    res.json(await buildYearlyDemand(prisma, {
      year: req.query.year,
      customerCode: req.query.customerCode,
      q: req.query.q,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }));
  } catch (error) {
    next(error);
  }
};
