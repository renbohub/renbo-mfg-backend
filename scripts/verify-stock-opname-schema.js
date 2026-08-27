"use strict";

const assert = require("assert");
const { Prisma } = require("@prisma/client");

const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
const header = models.get("StockOpnameHeader");
const detail = models.get("StockOpnameDetail");
const round = models.get("StockOpnameCountRound");
const attempt = models.get("StockOpnameCountAttempt");

assert(header, "StockOpnameHeader model must exist");
assert(detail, "StockOpnameDetail model must exist");
assert(round, "StockOpnameCountRound model must exist");
assert(attempt, "StockOpnameCountAttempt model must exist");

const fieldNames = (model) => new Set(model.fields.map((field) => field.name));
["countMode", "scopeJson", "snapshotAt", "toleranceQty", "tolerancePercent", "currentRoundNo", "submittedBy", "submittedAt", "countRounds"]
  .forEach((field) => assert(fieldNames(header).has(field), `StockOpnameHeader missing ${field}`));
["isUnexpected", "resolutionStatus", "countAttempts"]
  .forEach((field) => assert(fieldNames(detail).has(field), `StockOpnameDetail missing ${field}`));
["header", "attempts", "roundNo", "status"].forEach((field) => assert(fieldNames(round).has(field), `StockOpnameCountRound missing ${field}`));
["round", "detail", "sequenceNo", "actualQty", "isCurrent"].forEach((field) => assert(fieldNames(attempt).has(field), `StockOpnameCountAttempt missing ${field}`));

console.log("Balanced Stock Opname generated-schema checks passed");