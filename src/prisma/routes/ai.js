"use strict";

const express = require("express");
const { createHandlers: createAssistantHandlers } = require("../controllers/ai/AiAssistantController");

function createAiRouter({
  conversationService,
  draftService,
  runtime,
  registry,
  modelHandlers,
  requireSuperAdmin,
  featurePolicy,
}) {
  const router = express.Router();
  const handlers = createAssistantHandlers({ conversationService, draftService, runtime, registry, featurePolicy });

  router.get("/status", handlers.status);
  router.get("/capabilities", handlers.capabilities);
  router.get("/conversations", handlers.listConversations);
  router.post("/conversations", handlers.createConversation);
  router.get("/conversations/:conversationId", handlers.getConversation);
  router.post("/conversations/:conversationId/messages", handlers.submitMessage);
  router.get("/requests/:requestId", handlers.getRequest);
  router.delete("/requests/:requestId", handlers.cancelRequest);
  router.get("/drafts/:draftId", handlers.getDraft);
  router.post("/drafts/:draftId/reject", handlers.rejectDraft);

  router.get("/admin/model-files", requireSuperAdmin, modelHandlers.listFiles);
  router.get("/admin/model-profiles", requireSuperAdmin, modelHandlers.list);
  router.post("/admin/model-profiles", requireSuperAdmin, modelHandlers.create);
  router.post("/admin/model-profiles/:id/test", requireSuperAdmin, modelHandlers.test);
  router.post("/admin/model-profiles/:id/activate", requireSuperAdmin, modelHandlers.activate);
  router.post("/admin/model-profiles/:id/rollback", requireSuperAdmin, modelHandlers.rollback);

  return router;
}

function createDefaultAiRouter() {
  const { prisma } = require("../index");
  const { requireSuperAdmin } = require("../middleware/auth");
  const { capabilityRegistry } = require("../services/ai/capabilityRegistry");
  const { createCapabilityGateway } = require("../services/ai/capabilityGateway");
  const { aiRuntimeSupervisor } = require("../services/ai/aiRuntimeSupervisor");
  const { createAiOrchestrator } = require("../services/ai/aiOrchestrator");
  const { createAiConversationService } = require("../services/ai/aiConversationService");
  const { createAiDraftService } = require("../services/ai/aiDraftService");
  const { createModelProfileService } = require("../services/ai/aiModelProfileService");
  const { createAiFeaturePolicy } = require("../services/ai/aiFeaturePolicy");
  const { createHandlers: createModelHandlers } = require("../controllers/ai/AiModelProfileController");

  const gateway = createCapabilityGateway({ prisma, registry: capabilityRegistry });
  const orchestrator = createAiOrchestrator({ runtime: aiRuntimeSupervisor, gateway, prisma });
  const conversationService = createAiConversationService({
    prisma,
    runtime: aiRuntimeSupervisor,
    processRequest: (requestId) => orchestrator.runChatRequest(requestId),
  });
  const draftService = createAiDraftService({ prisma });
  const modelService = createModelProfileService({ prisma, runtime: aiRuntimeSupervisor });
  const modelHandlers = createModelHandlers(modelService);
  const featurePolicy = createAiFeaturePolicy({ prisma, runtime: aiRuntimeSupervisor });

  return createAiRouter({
    conversationService,
    draftService,
    runtime: aiRuntimeSupervisor,
    registry: capabilityRegistry,
    modelHandlers,
    requireSuperAdmin,
    featurePolicy,
  });
}

module.exports = { createAiRouter, createDefaultAiRouter };
