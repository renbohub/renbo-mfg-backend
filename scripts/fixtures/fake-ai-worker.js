"use strict";

if (process.send) {
  process.send({
    type: "READY",
    environment: {
      hasDatabaseUrl: Object.prototype.hasOwnProperty.call(process.env, "DATABASE_URL"),
      hasJwtSecret: Object.prototype.hasOwnProperty.call(process.env, "JWT_SECRET"),
      hasPath: Boolean(process.env.PATH),
    },
  });
}

process.on("message", (message) => {
  if (message.type === "SHUTDOWN") process.exit(0);
  if (message.type !== "GENERATE") return;
  const command = String(message.messages?.at(-1)?.content || "OK");
  if (command === "CRASH") process.exit(17);
  if (command === "DELAY") return;
  if (process.send) {
    process.send({
      type: "RESULT",
      requestId: message.requestId,
      text: JSON.stringify({ answer: command }),
      json: { answer: command },
      metrics: { durationMs: 2, rssMb: 32 },
    });
  }
});
