"use strict";

function actor(req) {
  return req.user?.id || req.user?.username || req.user?.email || "system";
}

function createHandlers(service) {
  if (!service) throw new TypeError("AI model profile service wajib tersedia.");
  return {
    listFiles: async (_req, res, next) => {
      try {
        return res.json({ items: service.listAllowlistedModelFiles() });
      } catch (error) {
        return next(error);
      }
    },
    list: async (_req, res, next) => {
      try {
        return res.json({ items: await service.listModelProfiles() });
      } catch (error) {
        return next(error);
      }
    },
    create: async (req, res, next) => {
      try {
        return res.status(201).json(await service.createModelProfile(req.body, actor(req)));
      } catch (error) {
        return next(error);
      }
    },
    test: async (req, res, next) => {
      try {
        return res.json(await service.testModelProfile(req.params.id, actor(req)));
      } catch (error) {
        return next(error);
      }
    },
    activate: async (req, res, next) => {
      try {
        return res.json(await service.activateModelProfile(req.params.id, actor(req)));
      } catch (error) {
        return next(error);
      }
    },
    rollback: async (req, res, next) => {
      try {
        return res.json(await service.rollbackModelProfile(req.params.id, actor(req)));
      } catch (error) {
        return next(error);
      }
    },
  };
}

module.exports = { createHandlers };
