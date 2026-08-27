"use strict";

function conversationError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code });
}

function sanitizePageContext(value = {}) {
  const clean = (input, max = 160) => String(input || "").trim().slice(0, max);
  return {
    moduleCode: clean(value.moduleCode, 80),
    pageCode: clean(value.pageCode, 120),
    recordKey: clean(value.recordKey, 160) || null,
    period: clean(value.period, 40) || null,
    filters: value.filters && typeof value.filters === "object" ? value.filters : {},
    selectedIds: Array.isArray(value.selectedIds) ? value.selectedIds.map((item) => clean(item)).filter(Boolean).slice(0, 50) : [],
  };
}

function markStaleAiRequestsFailed(prisma, finishedAt = new Date()) {
  return prisma.aiRequest.updateMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "FAILED",
      errorCode: "AI_RUNTIME_RESTARTED",
      errorMessage: "Runtime restarted.",
      finishedAt,
    },
  });
}

function createAiConversationService({ prisma, runtime, processRequest, now = () => new Date() } = {}) {
  if (!prisma?.aiConversation || !prisma?.aiRequest || !prisma?.aiMessage) {
    throw new TypeError("Prisma AI conversation delegates wajib tersedia.");
  }

  function ownerId(user) {
    return String(user?.id || "").trim();
  }

  async function createConversation({ user, pageContext, title }) {
    const context = sanitizePageContext(pageContext);
    if (!ownerId(user) || !context.moduleCode || !context.pageCode) {
      throw conversationError(400, "AI_CONVERSATION_CONTEXT_REQUIRED", "Konteks halaman AI belum lengkap.");
    }
    return prisma.aiConversation.create({
      data: {
        userId: ownerId(user),
        moduleCode: context.moduleCode,
        pageCode: context.pageCode,
        recordKey: context.recordKey,
        title: String(title || `${context.moduleCode} · ${context.pageCode}`).slice(0, 200),
        expiresAt: new Date(now().getTime() + 30 * 86400000),
      },
    });
  }

  async function listConversations(user) {
    return prisma.aiConversation.findMany({
      where: { userId: ownerId(user), status: "ACTIVE" },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
    });
  }

  async function getConversation(id, user) {
    const row = await prisma.aiConversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: "asc" }, take: 100 },
        requests: { orderBy: { createdAt: "desc" }, take: 20 },
        drafts: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!row || (!user?.isSuperAdmin && row.userId !== ownerId(user))) {
      throw conversationError(404, "AI_CONVERSATION_NOT_FOUND", "Conversation AI tidak ditemukan.");
    }
    return row;
  }

  async function submitMessage(conversationId, { content, pageContext }, user) {
    const conversation = await getConversation(conversationId, user);
    const text = String(content || "").trim();
    if (!text || text.length > 6000) {
      throw conversationError(400, "AI_MESSAGE_INVALID", "Pesan AI wajib diisi dan maksimal 6.000 karakter.");
    }
    if (conversation.status !== "ACTIVE") {
      throw conversationError(409, "AI_CONVERSATION_INACTIVE", "Conversation AI sudah tidak aktif.");
    }
    const context = sanitizePageContext(pageContext || conversation);
    const created = await prisma.$transaction(async (tx) => {
      const message = await tx.aiMessage.create({
        data: { conversationId, role: "user", content: text },
      });
      const request = await tx.aiRequest.create({
        data: {
          conversationId,
          userMessageId: message.id,
          requestType: "CHAT",
          status: "QUEUED",
          payload: { pageContext: context },
        },
      });
      await tx.aiConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now(), expiresAt: new Date(now().getTime() + 30 * 86400000) },
      });
      return request;
    });
    if (processRequest) {
      setImmediate(() => Promise.resolve(processRequest(created.id)).catch(() => {}));
    }
    return { requestId: created.id, status: created.status };
  }

  async function getRequest(id, user) {
    const row = await prisma.aiRequest.findUnique({
      where: { id },
      include: { conversation: true, assistantMessage: true },
    });
    if (!row || (!user?.isSuperAdmin && row.conversation.userId !== ownerId(user))) {
      throw conversationError(404, "AI_REQUEST_NOT_FOUND", "Request AI tidak ditemukan.");
    }
    return row;
  }

  async function cancelRequest(id, user) {
    const row = await getRequest(id, user);
    if (!["QUEUED", "RUNNING"].includes(row.status)) {
      throw conversationError(409, "AI_REQUEST_NOT_CANCELLABLE", "Request AI sudah selesai.");
    }
    runtime?.cancel(id, row.conversation.userId);
    return prisma.aiRequest.update({
      where: { id },
      data: { status: "CANCELLED", finishedAt: now(), errorCode: "AI_CANCELLED" },
    });
  }

  async function failStaleRequests() {
    return markStaleAiRequestsFailed(prisma, now());
  }

  return { createConversation, listConversations, getConversation, submitMessage, getRequest, cancelRequest, failStaleRequests };
}

module.exports = { conversationError, sanitizePageContext, markStaleAiRequestsFailed, createAiConversationService };
