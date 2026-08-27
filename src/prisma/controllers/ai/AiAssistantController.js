"use strict";

const { resolvePageContext } = require("../../utils/pageContext");
const { userHasPermission } = require("../../services/ai/permissionEvaluator");
const { contextMatchesRequirement } = require("../../services/ai/capabilityGateway");

function createHandlers({ conversationService, draftService, runtime, registry, featurePolicy }) {
  return {
    status: async (req, res, next) => {
      try {
        const pageContext = resolvePageContext(req);
        const policy = featurePolicy ? await featurePolicy.isAiEnabled({ moduleCode: pageContext.moduleCode, user: req.user }) : { enabled: true, reason: "READY" };
        return res.json({ ...runtime.status(), enabled: policy.enabled, policyReason: policy.reason });
      } catch (error) {
        return next(error);
      }
    },
    capabilities: async (req, res, next) => {
      try {
        const pageContext = resolvePageContext(req);
        const visible = registry.list()
          .filter((item) => contextMatchesRequirement(item.permission, pageContext) && userHasPermission(req.user, item.permission, pageContext))
        const items = [];
        for (const item of visible) {
          const policy = featurePolicy ? await featurePolicy.isAiEnabled({ moduleCode: pageContext.moduleCode, capabilityCode: item.code, user: req.user, requireRuntime: false }) : { enabled: true };
          if (policy.enabled) { const { execute, inputSchema, outputSchema, ...publicItem } = item; items.push(publicItem); }
        }
        return res.json({ items });
      } catch (error) {
        return next(error);
      }
    },
    listConversations: async (req, res, next) => {
      try {
        return res.json({ items: await conversationService.listConversations(req.user) });
      } catch (error) {
        return next(error);
      }
    },
    createConversation: async (req, res, next) => {
      try {
        return res.status(201).json(await conversationService.createConversation({
          user: req.user,
          pageContext: { ...resolvePageContext(req), ...(req.body?.pageContext || {}) },
          title: req.body?.title,
        }));
      } catch (error) {
        return next(error);
      }
    },
    getConversation: async (req, res, next) => {
      try {
        return res.json(await conversationService.getConversation(req.params.conversationId, req.user));
      } catch (error) {
        return next(error);
      }
    },
    submitMessage: async (req, res, next) => {
      try {
        if (featurePolicy) {
          const pageContext = { ...resolvePageContext(req), ...(req.body?.pageContext || {}) };
          const policy = await featurePolicy.isAiEnabled({ moduleCode: pageContext.moduleCode, capabilityCode: req.body?.capabilityCode, user: req.user });
          if (!policy.enabled) return res.status(503).json({ code: "AI_DISABLED", message: `AI tidak tersedia: ${policy.reason}.` });
        }
        const result = await conversationService.submitMessage(
          req.params.conversationId,
          { content: req.body?.content, pageContext: { ...resolvePageContext(req), ...(req.body?.pageContext || {}) } },
          req.user
        );
        return res.status(202).json(result);
      } catch (error) {
        return next(error);
      }
    },
    getRequest: async (req, res, next) => {
      try {
        return res.json(await conversationService.getRequest(req.params.requestId, req.user));
      } catch (error) {
        return next(error);
      }
    },
    cancelRequest: async (req, res, next) => {
      try {
        return res.json(await conversationService.cancelRequest(req.params.requestId, req.user));
      } catch (error) {
        return next(error);
      }
    },
    getDraft: async (req, res, next) => {
      try {
        return res.json(await draftService.getOwnedDraft(req.params.draftId, req.user));
      } catch (error) {
        return next(error);
      }
    },
    rejectDraft: async (req, res, next) => {
      try {
        return res.json(await draftService.rejectAiDraft(req.params.draftId, req.user));
      } catch (error) {
        return next(error);
      }
    },
  };
}

module.exports = { createHandlers };
