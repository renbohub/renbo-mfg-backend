"use strict";
async function cleanupExpiredAiData(prisma, now = new Date(), retentionDays = 30) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400000);
  const expiredDrafts = await prisma.aiDraft.updateMany({ where: { status: "WAITING_CONFIRMATION", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });
  const conversations = await prisma.aiConversation.findMany({ where: { updatedAt: { lt: cutoff }, status: { not: "ARCHIVED" } }, select: { id: true, _count: { select: { capabilityCalls: true, drafts: true } } }, take: 1000 });
  let deleted = 0, archived = 0, redactedMessages = 0;
  for (const conversation of conversations) {
    const hasAudit = Number(conversation._count?.capabilityCalls || 0) + Number(conversation._count?.drafts || 0) > 0;
    if (!hasAudit) {
      await prisma.$transaction([
        prisma.aiRequest.deleteMany({ where: { conversationId: conversation.id } }),
        prisma.aiMessage.deleteMany({ where: { conversationId: conversation.id } }),
        prisma.aiConversation.delete({ where: { id: conversation.id } }),
      ]);
      deleted += 1; continue;
    }
    await prisma.$transaction([
      prisma.aiConversation.update({ where: { id: conversation.id }, data: { status: "ARCHIVED", title: "[REDACTED_BY_RETENTION]" } }),
      prisma.aiMessage.updateMany({ where: { conversationId: conversation.id }, data: { content: "[REDACTED_BY_RETENTION]", citations: null, runtimeMetrics: null } }),
      prisma.aiRequest.updateMany({ where: { conversationId: conversation.id }, data: { payload: { redacted: true } } }),
    ]);
    archived += 1; redactedMessages += 1;
  }
  return { expiredDrafts: expiredDrafts.count, deleted, archived, redactedMessages };
}
module.exports = { cleanupExpiredAiData };
