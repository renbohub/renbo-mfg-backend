"use strict";

const assert = require("assert");
const { Prisma } = require("@prisma/client");

const modelNames = new Set(Prisma.dmmf.datamodel.models.map((model) => model.name));
assert(
  modelNames.has("MonthlyPlanRecommendationScenario"),
  "generated client must expose MonthlyPlanRecommendationScenario",
);
assert(
  modelNames.has("MonthlyPlanRecommendationItem"),
  "generated client must expose MonthlyPlanRecommendationItem",
);

const scenario = Prisma.dmmf.datamodel.models.find(
  (model) => model.name === "MonthlyPlanRecommendationScenario",
);
assert(
  scenario.fields.some((field) => field.name === "basePlanUpdatedAt"),
  "scenario must preserve the plan version used for calculation",
);
assert(
  scenario.fields.some(
    (field) =>
      field.name === "items" &&
      field.kind === "object" &&
      field.type === "MonthlyPlanRecommendationItem",
  ),
  "scenario must expose its recommendation item relation",
);
const item = Prisma.dmmf.datamodel.models.find(
  (model) => model.name === "MonthlyPlanRecommendationItem",
);
assert(
  item.fields.some(
    (field) =>
      field.name === "scenario" &&
      field.kind === "object" &&
      field.type === "MonthlyPlanRecommendationScenario",
  ),
  "recommendation item must belong to its scenario",
);

console.log("Monthly plan recommendation schema contract passed.");
