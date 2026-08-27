"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const migrationPath = path.join(
  root,
  "prisma",
  "migrations",
  "20260825100000_add_offline_ai_assistant_core",
  "migration.sql"
);

assert.ok(fs.existsSync(migrationPath), "AI assistant migration must exist");

const schema = fs.readFileSync(schemaPath, "utf8");
const migration = fs.readFileSync(migrationPath, "utf8");

for (const model of [
  "AiModelProfile",
  "AiConversation",
  "AiMessage",
  "AiRequest",
  "AiCapabilityCall",
  "AiDraft",
]) {
  assert.match(schema, new RegExp(`model ${model} \\{`), `${model} must exist`);
}

for (const table of [
  "tbl_ai_model_profile",
  "tbl_ai_conversation",
  "tbl_ai_message",
  "tbl_ai_request",
  "tbl_ai_capability_call",
  "tbl_ai_draft",
]) {
  assert.match(migration, new RegExp(`CREATE TABLE \\"${table}\\"`), `${table} must be created`);
}

assert.match(schema, /generationSource\s+String\?/);
assert.match(schema, /aiValidationSummary\s+Json\?/);
assert.match(schema, /rollbackProfileId\s+String\?/);
assert.match(schema, /generationSource\s+String\s+@default\("AI_GENERATED"\)/);
assert.match(
  schema,
  /model AiCapabilityCall[\s\S]*?conversation\s+AiConversation\s+@relation\([^\n]*onDelete: Restrict\)/
);
assert.match(
  schema,
  /model AiDraft[\s\S]*?conversation\s+AiConversation\s+@relation\([^\n]*onDelete: Restrict\)/
);
assert.match(migration, /rollback_profile_id/);
assert.match(migration, /ON DELETE RESTRICT/);

console.log("AI assistant schema contract passed.");
