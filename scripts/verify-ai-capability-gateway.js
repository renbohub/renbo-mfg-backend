"use strict";

const assert = require("assert");
const { userHasPermission } = require("../src/prisma/services/ai/permissionEvaluator");
const { createCapabilityRegistry } = require("../src/prisma/services/ai/capabilityRegistry");
const { createCapabilityGateway } = require("../src/prisma/services/ai/capabilityGateway");

const user = {
  id: "u1",
  isSuperAdmin: false,
  roleAssignments: [
    {
      isActive: true,
      role: {
        isActive: true,
        isDeleted: false,
        permissions: [
          {
            moduleCode: "inventory",
            pageCode: "stock-balances",
            resourceCode: "stockBalance",
            actions: ["read"],
            isActive: true,
            isDeleted: false,
          },
        ],
      },
    },
  ],
};

async function run() {
  assert.strictEqual(
    userHasPermission(
      user,
      { moduleCode: "inventory", pageCode: "stock-balances", resourceCode: "stockBalance", action: "read" },
      { moduleCode: "inventory", pageCode: "stock-balances" }
    ),
    true
  );
  assert.strictEqual(
    userHasPermission(
      user,
      { moduleCode: "purchasing", pageCode: "purchase-order", resourceCode: "purchaseOrder", action: "read" },
      { moduleCode: "purchasing", pageCode: "purchase-order" }
    ),
    false
  );
  assert.strictEqual(
    userHasPermission(
      { id: "legacy", listMenu: [{ resource: "buyers", actions: ["update"] }] },
      { resourceCode: "buyers", action: "read" },
      {}
    ),
    true,
    "legacy update permission must continue implying read"
  );

  const registry = createCapabilityRegistry();
  assert.throws(
    () => registry.register({ code: "bad.final", operationClass: "FINAL_MUTATION" }),
    (error) => error.code === "AI_FINAL_MUTATION_DENIED"
  );
  registry.register({
    code: "inventory.get_stock_summary",
    operationClass: "READ",
    permission: {
      moduleCode: "inventory",
      pageCode: "stock-balances",
      resourceCode: "stockBalance",
      action: "read",
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["partCode"],
      properties: { partCode: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rows", "sources"],
      properties: {
        rows: { type: "array", items: { type: "object" } },
        sources: { type: "array", items: { type: "object" } },
      },
    },
    maxRows: 2,
    fieldAllowlist: ["rows", "sources"],
    execute: async ({ input }) => ({
      rows: [1, 2, 3].map((qty) => ({ partCode: input.partCode, qty })),
      sources: [{ entityType: "STOCK_BALANCE", entityId: "s1" }],
      secret: "must-not-leak",
    }),
  });
  assert.throws(
    () => registry.register({ code: "inventory.get_stock_summary", operationClass: "READ" }),
    /duplicate/i
  );

  const auditRows = [];
  const gateway = createCapabilityGateway({
    prisma: {},
    registry,
    auditStore: { create: async (row) => { auditRows.push(row); return row; } },
  });
  await assert.rejects(
    () => gateway.execute({
      user,
      requestId: "r-invalid",
      conversationId: "c1",
      capabilityCode: "inventory.get_stock_summary",
      input: { partCode: "A", injected: true },
      pageContext: { moduleCode: "inventory", pageCode: "stock-balances" },
    }),
    (error) => error.code === "AI_CAPABILITY_INPUT_INVALID" && error.statusCode === 400
  );
  await assert.rejects(
    () => gateway.execute({
      user,
      requestId: "r-denied",
      conversationId: "c1",
      capabilityCode: "inventory.get_stock_summary",
      input: { partCode: "A" },
      pageContext: { moduleCode: "purchasing", pageCode: "purchase-order" },
    }),
    (error) => error.code === "AI_CAPABILITY_FORBIDDEN" && error.statusCode === 403
  );

  const result = await gateway.execute({
    user,
    requestId: "r-ok",
    conversationId: "c1",
    capabilityCode: "inventory.get_stock_summary",
    input: { partCode: "A" },
    pageContext: { moduleCode: "inventory", pageCode: "stock-balances", recordKey: "A" },
  });
  assert.strictEqual(result.rows.length, 2, "gateway must enforce maxRows");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "secret"), false);
  assert.strictEqual(auditRows.at(-1).data.capabilityCode, "inventory.get_stock_summary");
  assert.deepStrictEqual(auditRows.at(-1).data.requestData, { partCode: "A" });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(auditRows.at(-1).data.permissionContext, "user"), false);

  console.log("AI capability gateway contract passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
