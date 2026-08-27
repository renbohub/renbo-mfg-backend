"use strict";

const Ajv = require("ajv");
const { getPrompt, ASSISTANT_ENVELOPE_SCHEMA } = require("./promptRegistry");
const { resolveModelFile, validateRuntimeConfig } = require("./aiModelProfileService");

function aiError(code, message, statusCode = 502, details) {
  return Object.assign(new Error(message), { code, statusCode, status: statusCode, details });
}

function normalizeValidationErrors(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 20).map((error) => ({
    code: String(error?.code || error?.keyword || "VALIDATION_ERROR").slice(0, 100),
    path: String(error?.instancePath || error?.path || "").slice(0, 200),
    message: String(error?.message || "Output tidak valid.").slice(0, 500),
  }));
}

function createAiOrchestrator({
  runtime,
  gateway,
  prisma,
  modelDir = process.env.AI_MODEL_DIR,
  ajv = new Ajv({ allErrors: true, strict: true }),
  now = () => new Date(),
} = {}) {
  if (!runtime?.enqueue) throw new TypeError("AI runtime wajib tersedia.");
  if (!gateway?.execute) throw new TypeError("Capability gateway wajib tersedia.");
  const validateEnvelope = ajv.compile(ASSISTANT_ENVELOPE_SCHEMA);

  async function runToolLoop({ user, requestId, conversationId, pageContext, profile, messages }) {
    const prompt = getPrompt(profile?.promptCompatibilityVersion || "ERP_ASSISTANT_V1");
    const runtimeMessages = [{ role: "system", content: prompt.system }, ...(messages || [])];
    for (let turn = 0; turn < 5; turn += 1) {
      const result = await runtime.enqueue({
        id: `${requestId}:turn:${turn}`,
        userId: user.id,
        priority: 100,
        profile,
        messages: runtimeMessages,
        outputSchema: prompt.outputSchema,
        maxTokens: Math.min(Number(profile?.runtimeConfig?.maxTokens || 256), 256),
        thinkingMode: "disabled",
        timeoutMs: profile?.runtimeConfig?.chatTimeoutMs || 45000,
        seed: 42,
      });
      if (!validateEnvelope(result.json)) {
        throw aiError("AI_OUTPUT_INVALID", "Output assistant tidak memenuhi schema.", 502, normalizeValidationErrors(validateEnvelope.errors));
      }
      if (result.json.type === "ANSWER") return { ...result.json, metrics: result.metrics || {} };
      if (turn === 4) throw aiError("AI_TOOL_LOOP_LIMIT", "Batas capability tercapai.", 409);
      const tool = await gateway.execute({
        user,
        requestId,
        conversationId,
        capabilityCode: result.json.capabilityCode,
        input: result.json.arguments,
        pageContext,
      });
      runtimeMessages.push({ role: "assistant", content: JSON.stringify(result.json) });
      runtimeMessages.push({
        role: "tool",
        content: JSON.stringify({ capabilityCode: result.json.capabilityCode, data: tool, sources: tool.sources || [] }),
      });
    }
    throw aiError("AI_TOOL_LOOP_LIMIT", "Batas capability tercapai.", 409);
  }

  async function generateStructuredWorkflow({
    requestId,
    userId,
    profile,
    messages,
    outputSchema,
    validateBusiness = async () => [],
    timeoutMs,
  }) {
    const validateSchema = ajv.compile(outputSchema);
    let repairErrors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runtimeMessages = [...messages];
      if (attempt === 1) {
        runtimeMessages.push({
          role: "tool",
          content: JSON.stringify({
            type: "ERP_VALIDATION_ERRORS",
            errors: normalizeValidationErrors(repairErrors),
            instruction: "Perbaiki output satu kali menggunakan ID dan pilihan yang tersedia saja.",
          }),
        });
      }
      const result = await runtime.enqueue({
        id: `${requestId}:workflow:${attempt}`,
        userId,
        priority: 50,
        profile,
        messages: runtimeMessages,
        outputSchema,
        maxTokens: Math.min(Number(profile?.runtimeConfig?.maxTokens || 1200), 1200),
        thinkingMode: "bounded",
        timeoutMs: timeoutMs || profile?.runtimeConfig?.recommendationTimeoutMs || 90000,
        seed: 42,
      });
      const schemaValid = validateSchema(result.json);
      const businessErrors = schemaValid ? await validateBusiness(result.json) : [];
      repairErrors = [
        ...(schemaValid ? [] : normalizeValidationErrors(validateSchema.errors)),
        ...normalizeValidationErrors(businessErrors),
      ];
      if (!repairErrors.length) {
        return { value: result.json, corrected: attempt === 1, attempts: attempt + 1, metrics: result.metrics || {} };
      }
    }
    throw aiError("AI_WORKFLOW_VALIDATION_FAILED", "Draft AI tidak lulus validasi ERP.", 422, repairErrors);
  }

  async function runChatRequest(requestId) {
    if (!prisma) throw aiError("AI_PERSISTENCE_UNAVAILABLE", "Persistence orchestrator belum tersedia.", 503);
    const request = await prisma.aiRequest.findUnique({
      where: { id: requestId },
      include: {
        conversation: { include: { messages: { orderBy: { createdAt: "asc" }, take: 40 } } },
      },
    });
    if (!request || request.status !== "QUEUED") return null;
    const profile = await prisma.aiModelProfile.findFirst({ where: { status: "ACTIVE" } });
    if (!profile) throw aiError("AI_PROFILE_NOT_ACTIVE", "Profile AI aktif belum tersedia.", 503);
    const user = await prisma.user.findUnique({
      where: { id: request.conversation.userId },
      include: {
        roleAssignments: {
          where: { isActive: true },
          include: { role: { include: { permissions: { where: { isDeleted: false, isActive: true } } } } },
        },
      },
    });
    if (!user) throw aiError("AI_USER_NOT_FOUND", "User request AI tidak ditemukan.", 404);
    const runtimeProfile = {
      ...profile,
      resolvedModelPath: resolveModelFile(profile, modelDir),
      runtimeConfig: validateRuntimeConfig(profile.runtimeConfig),
    };
    await prisma.aiRequest.update({
      where: { id: requestId },
      data: { status: "RUNNING", startedAt: now(), modelProfileId: profile.id },
    });
    try {
      const answer = await runToolLoop({
        user,
        requestId,
        conversationId: request.conversationId,
        pageContext: request.payload?.pageContext || {},
        profile: runtimeProfile,
        messages: request.conversation.messages.map((message) => ({ role: message.role, content: message.content })),
      });
      return prisma.$transaction(async (tx) => {
        const assistantMessage = await tx.aiMessage.create({
          data: {
            conversationId: request.conversationId,
            role: "assistant",
            content: answer.answer,
            citations: answer.sources,
            modelProfileId: profile.id,
            promptVersion: profile.promptCompatibilityVersion,
            runtimeMetrics: answer.metrics,
          },
        });
        await tx.aiRequest.update({
          where: { id: requestId },
          data: { status: "COMPLETED", assistantMessageId: assistantMessage.id, finishedAt: now() },
        });
        return assistantMessage;
      });
    } catch (error) {
      await prisma.aiRequest.update({
        where: { id: requestId },
        data: {
          status: "FAILED",
          errorCode: String(error.code || "AI_REQUEST_FAILED"),
          errorMessage: String(error.message || "AI request gagal.").slice(0, 1000),
          finishedAt: now(),
        },
      });
      throw error;
    }
  }

  return { runToolLoop, generateStructuredWorkflow, runChatRequest };
}

module.exports = { aiError, normalizeValidationErrors, createAiOrchestrator };
