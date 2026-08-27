import { getLlama, LlamaChatSession } from "node-llama-cpp";
import process from "node:process";

let loaded = null;
let shuttingDown = false;

function toNodeLlamaChatHistory(messages = []) {
  return messages.slice(0, 20).map((message) => {
    const content = String(message?.content || "").slice(0, 24000);
    if (message.role === "system") return { type: "system", text: content };
    if (message.role === "assistant") return { type: "model", response: [content] };
    if (message.role === "tool") return { type: "user", text: `[UNTRUSTED_TOOL_DATA]\n${content}` };
    return { type: "user", text: content };
  });
}

async function disposeLoaded() {
  const current = loaded;
  loaded = null;
  if (current?.model) await current.model.dispose();
}

async function ensureModel(profile) {
  if (loaded?.profileCode === profile.profileCode) return loaded;
  await disposeLoaded();
  const gpu = profile.runtimeConfig.gpuMode === "cpu" ? false : profile.runtimeConfig.gpuMode;
  const llama = await getLlama({ gpu, maxThreads: profile.runtimeConfig.cpuThreads });
  const model = await llama.loadModel({
    modelPath: profile.resolvedModelPath,
    gpuLayers: profile.runtimeConfig.gpuLayers || 0,
  });
  loaded = { profileCode: profile.profileCode, llama, model };
  return loaded;
}

async function generate(message) {
  let context;
  const startedAt = Date.now();
  try {
    const runtime = await ensureModel(message.profile);
    context = await runtime.model.createContext({
      contextSize: message.profile.runtimeConfig.contextSize,
      sequences: 1,
      batchSize: message.profile.runtimeConfig.batchSize,
      threads: message.profile.runtimeConfig.cpuThreads,
    });
    const grammar = await runtime.llama.createGrammarForJsonSchema(message.outputSchema);
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    session.setChatHistory(toNodeLlamaChatHistory(message.messages.slice(0, -1)));
    const text = await session.prompt(String(message.messages.at(-1)?.content || ""), {
      grammar,
      maxTokens: message.maxTokens,
      temperature: message.thinkingMode === "bounded" ? 0.6 : 0.1,
      seed: message.seed,
    });
    process.send?.({
      type: "RESULT",
      requestId: message.requestId,
      text,
      json: grammar.parse(text),
      metrics: { durationMs: Date.now() - startedAt, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
    });
  } catch (error) {
    process.send?.({
      type: "ERROR",
      requestId: message.requestId,
      code: "AI_GENERATION_FAILED",
      message: String(error?.message || "Inference AI gagal."),
    });
  } finally {
    if (context) await context.dispose();
  }
}

process.on("message", (message) => {
  if (message?.type === "SHUTDOWN") {
    shuttingDown = true;
    void disposeLoaded().finally(() => process.exit(0));
    return;
  }
  if (message?.type === "GENERATE" && !shuttingDown) void generate(message);
});

const heartbeat = setInterval(() => {
  process.send?.({ type: "HEARTBEAT", rssMb: Math.round(process.memoryUsage().rss / 1048576) });
}, 1000);
heartbeat.unref();

process.send?.({ type: "READY", environment: { hasPath: Boolean(process.env.PATH) } });
