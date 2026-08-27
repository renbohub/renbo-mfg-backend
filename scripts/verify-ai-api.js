"use strict";

const assert = require("assert");
const express = require("express");
const { createAiRouter } = require("../src/prisma/routes/ai");
const { markStaleAiRequestsFailed } = require("../src/prisma/services/ai/aiConversationService");

async function run() {
  let staleUpdate = null;
  await markStaleAiRequestsFailed({
    aiRequest: { updateMany: async (args) => { staleUpdate = args; return { count: 2 }; } },
  }, new Date("2026-08-25T09:00:00.000Z"));
  assert.deepStrictEqual(staleUpdate.where.status.in, ["QUEUED", "RUNNING"]);
  assert.strictEqual(staleUpdate.data.errorCode, "AI_RUNTIME_RESTARTED");

  const service = {
    listConversations: async () => [],
    createConversation: async () => ({ id: "c1" }),
    getConversation: async (id, user) => {
      if (id === "other" && user.id !== "owner") throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { id, userId: user.id };
    },
    submitMessage: async () => ({ requestId: "r1", status: "QUEUED" }),
    getRequest: async () => ({ id: "r1", status: "COMPLETED", assistantMessage: { content: "done" } }),
    cancelRequest: async () => ({ id: "r1", status: "CANCELLED" }),
  };
  const draftService = {
    getOwnedDraft: async (id) => ({ id, status: "WAITING_CONFIRMATION" }),
    rejectAiDraft: async (id) => ({ id, status: "REJECTED" }),
  };
  const modelHandlers = {
    listFiles: (_req, res) => res.json({ items: [] }),
    list: (_req, res) => res.json({ items: [] }),
    create: (_req, res) => res.status(201).json({ id: "p1" }),
    test: (_req, res) => res.json({ status: "INACTIVE" }),
    activate: (_req, res) => res.json({ status: "ACTIVE" }),
    rollback: (_req, res) => res.json({ status: "ACTIVE" }),
  };
  const router = createAiRouter({
    conversationService: service,
    draftService,
    runtime: { status: () => ({ state: "OFFLINE" }) },
    registry: { list: () => [] },
    modelHandlers,
    requireSuperAdmin: (req, res, next) => req.user.isSuperAdmin ? next() : res.status(403).json({ message: "Forbidden" }),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.headers["x-user"] || "u1", isSuperAdmin: req.headers["x-admin"] === "true" };
    next();
  });
  app.use("/api/ai", router);
  app.use((_req, res) => res.status(404).json({ message: "not found" }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  try {
    const queuedResponse = await fetch(`${base}/conversations/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "u1" },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.strictEqual(queuedResponse.status, 202);
    assert.deepStrictEqual(await queuedResponse.json(), { requestId: "r1", status: "QUEUED" });

    const denied = await fetch(`${base}/conversations/other`, { headers: { "x-user": "u1" } });
    assert.strictEqual(denied.status, 404);

    const completed = await fetch(`${base}/requests/r1`, { headers: { "x-user": "u1" } });
    assert.strictEqual((await completed.json()).assistantMessage.content, "done");

    const cancelled = await fetch(`${base}/requests/r1`, { method: "DELETE", headers: { "x-user": "u1" } });
    assert.strictEqual((await cancelled.json()).status, "CANCELLED");

    const noGenericConfirm = await fetch(`${base}/drafts/d1/confirm`, { method: "POST", headers: { "x-user": "u1" } });
    assert.strictEqual(noGenericConfirm.status, 404, "generic AI draft confirmation route must not exist");

    const adminDenied = await fetch(`${base}/admin/model-files`, { headers: { "x-user": "u1" } });
    assert.strictEqual(adminDenied.status, 403);
    const adminAllowed = await fetch(`${base}/admin/model-files`, { headers: { "x-user": "admin", "x-admin": "true" } });
    assert.strictEqual(adminAllowed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("AI API contract passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
