"use strict";

function draftError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code });
}

function actorId(actor) {
  return String(actor?.id || actor?.username || actor?.email || actor || "").trim();
}

function createAiDraftService({ prisma, now = () => new Date() } = {}) {
  if (!prisma?.aiDraft) throw new TypeError("Prisma aiDraft delegate wajib tersedia.");

  async function createAiDraft(input, actor) {
    const userId = actorId(actor);
    if (!userId) throw draftError(401, "AI_DRAFT_USER_REQUIRED", "User draft wajib tersedia.");
    return prisma.aiDraft.create({
      data: {
        conversationId: input.conversationId,
        requestId: input.requestId,
        capabilityCallId: input.capabilityCallId || null,
        userId,
        moduleCode: String(input.moduleCode || "").trim(),
        pageCode: String(input.pageCode || "").trim(),
        draftType: String(input.draftType || "").trim(),
        generationSource: "AI_GENERATED",
        status: "WAITING_CONFIRMATION",
        payload: input.payload || {},
        sourceRefs: input.sourceRefs || [],
        validationSummary: input.validationSummary || { valid: false, issues: [] },
        expiresAt: input.expiresAt || new Date(now().getTime() + 7 * 86400000),
      },
    });
  }

  async function getOwnedDraft(id, actor) {
    const draft = await prisma.aiDraft.findUnique({ where: { id } });
    if (!draft || (!actor?.isSuperAdmin && draft.userId !== actorId(actor))) {
      throw draftError(404, "AI_DRAFT_NOT_FOUND", "Draft AI tidak ditemukan.");
    }
    return draft;
  }

  async function rejectAiDraft(id, actor) {
    const draft = await getOwnedDraft(id, actor);
    if (draft.status !== "WAITING_CONFIRMATION") {
      throw draftError(409, "AI_DRAFT_NOT_PENDING", "Draft AI sudah diproses.");
    }
    return prisma.aiDraft.update({
      where: { id },
      data: { status: "REJECTED", rejectedBy: actorId(actor), rejectedAt: now() },
    });
  }

  async function markAiDraftConfirmed({ draftId, userId, officialEntityType, officialEntityId }) {
    const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.userId !== String(userId || "")) {
      throw draftError(404, "AI_DRAFT_NOT_FOUND", "Draft AI tidak ditemukan.");
    }
    if (draft.status === "CONFIRMED" && draft.officialEntityType === officialEntityType && draft.officialEntityId === officialEntityId) {
      return draft;
    }
    if (draft.status !== "WAITING_CONFIRMATION") {
      throw draftError(409, "AI_DRAFT_NOT_PENDING", "Draft AI sudah diproses.");
    }
    if (new Date(draft.expiresAt).getTime() <= now().getTime()) {
      throw draftError(409, "AI_DRAFT_EXPIRED", "Draft AI sudah kedaluwarsa.");
    }
    if (!officialEntityType || !officialEntityId) {
      throw draftError(400, "AI_OFFICIAL_REFERENCE_REQUIRED", "Referensi transaksi resmi wajib tersedia.");
    }
    return prisma.aiDraft.update({
      where: { id: draftId },
      data: {
        status: "CONFIRMED",
        confirmedBy: String(userId),
        confirmedAt: now(),
        officialEntityType: String(officialEntityType),
        officialEntityId: String(officialEntityId),
      },
    });
  }

  async function validateDraftForOfficial({ draftId, actor, draftType, moduleCode, pageCode }) {
    const draft = await getOwnedDraft(draftId, actor);
    if (draft.status !== "WAITING_CONFIRMATION") throw draftError(409, "AI_DRAFT_NOT_PENDING", "Draft AI tidak lagi menunggu konfirmasi.");
    if (new Date(draft.expiresAt).getTime() <= now().getTime()) throw draftError(409, "AI_DRAFT_EXPIRED", "Draft AI sudah kedaluwarsa.");
    if (draftType && draft.draftType !== draftType) throw draftError(409, "AI_DRAFT_TYPE_MISMATCH", "Tipe draft AI tidak sesuai form resmi.");
    if (moduleCode && draft.moduleCode !== moduleCode) throw draftError(409, "AI_DRAFT_MODULE_MISMATCH", "Module draft AI tidak sesuai.");
    if (pageCode && draft.pageCode !== pageCode) throw draftError(409, "AI_DRAFT_PAGE_MISMATCH", "Halaman draft AI tidak sesuai.");
    return draft;
  }

  return { createAiDraft, getOwnedDraft, rejectAiDraft, markAiDraftConfirmed, validateDraftForOfficial };
}

module.exports = { draftError, createAiDraftService };
