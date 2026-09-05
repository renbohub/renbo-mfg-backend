"use strict";

const { prisma } = require("../../index");
const recommendationService = require("../../services/planning/monthlyPlanRecommendationService");

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, status: 400 });
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

function validateSelection(value) {
  if (!value || typeof value !== "object") {
    throw badRequest("Selection recommendation wajib diisi.");
  }
  const mode = String(value.mode || "").trim().toUpperCase();
  if (mode === "ALL") return { mode: "ALL" };
  if (mode === "EXISTING_TASKS") return { mode: "EXISTING_TASKS" };
  if (mode === "WORK_CENTER") {
    const workCenterIds = uniqueStrings(value.workCenterIds);
    if (!workCenterIds.length) {
      throw badRequest("Pilih minimal satu Work Center.");
    }
    return { mode, workCenterIds };
  }
  if (mode === "ITEMS") {
    const itemIds = uniqueStrings(value.itemIds);
    if (!itemIds.length) throw badRequest("Pilih minimal satu proposal.");
    return { mode, itemIds };
  }
  throw badRequest("Mode selection recommendation tidak valid.");
}

function actor(req) {
  return (
    req.user?.username || req.user?.email || req.user?.id || "system"
  );
}

function createHandlers(service, prismaClient = prisma) {
  return {
    generate: async (req, res, next) => {
      try {
        const options = { planNumber: req.params.planNumber, actor: actor(req) };
        return res.status(201).json(
          await service.generateRecommendationScenario(prismaClient, options),
        );
      } catch (error) {
        return next(error);
      }
    },
    active: async (req, res, next) => {
      try {
        const scenario = await service.getActiveRecommendationScenario(
          prismaClient,
          req.params.planNumber,
        );
        if (!scenario) {
          return res.status(404).json({
            message: "Scenario recommendation aktif tidak ditemukan.",
          });
        }
        return res.json(scenario);
      } catch (error) {
        return next(error);
      }
    },
    detail: async (req, res, next) => {
      try {
        return res.json(
          await service.getRecommendationScenario(
            prismaClient,
            req.params.scenarioId,
          ),
        );
      } catch (error) {
        return next(error);
      }
    },
    apply: async (req, res, next) => {
      try {
        const selection = validateSelection(req.body?.selection);
        return res.json(
          await service.applyRecommendationScenario(prismaClient, {
            scenarioId: req.params.scenarioId,
            actor: actor(req),
            selection,
          }),
        );
      } catch (error) {
        return next(error);
      }
    },
    discard: async (req, res, next) => {
      try {
        return res.json(
          await service.discardRecommendationScenario(prismaClient, {
            scenarioId: req.params.scenarioId,
            actor: actor(req),
          }),
        );
      } catch (error) {
        return next(error);
      }
    },
  };
}

module.exports = {
  ...createHandlers(recommendationService),
  createHandlers,
  validateSelection,
};
