require("dotenv").config({ override: true });

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

function resolveDatabaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { poolConfig: {}, schema: undefined };

  const parsed = new URL(connectionString);
  const schema = parsed.searchParams.get("schema");
  return {
    poolConfig: {
      connectionString,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    },
    schema: schema || undefined,
  };
}

function parsePipeNote(note) {
  const [type, ...parts] = String(note || "").split("|");
  const values = { type };
  for (const part of parts) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    values[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
  }
  return values;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonAfterPrefix(note, prefix) {
  if (!note?.startsWith(prefix)) return null;
  try {
    return JSON.parse(note.slice(prefix.length));
  } catch (error) {
    console.warn(`Skip invalid ${prefix} JSON: ${error.message}`);
    return null;
  }
}

function normalizeSourceQty(source, qty) {
  if (!source) return [];
  return [String(source).includes(":") ? String(source) : `${source}:${numberValue(qty)}`];
}

function mapRequirementBackfill(row) {
  const note = row.notes || "";

  if (note.startsWith("NETTING|")) {
    const parsed = parsePipeNote(note);
    const soConsumedQty = numberValue(parsed.soConsumedQty);
    const forecastQty = numberValue(parsed.forecastQty);
    const effectiveDemandQty = numberValue(parsed.effectiveDemandQty, row.grossRequirement);
    const sources = parsed.sources
      ? parsed.sources.split(",").map((source) => source.trim()).filter(Boolean)
      : [];

    return {
      forecastQty,
      soConsumedQty,
      effectiveDemandQty,
      consumptionSources: sources,
      notes: null,
    };
  }

  if (note.startsWith("SO_DIRECT|") || note.startsWith("SO_ONLY|")) {
    const parsed = parsePipeNote(note);
    const qty = numberValue(parsed.qty, row.grossRequirement);
    return {
      forecastQty: 0,
      soConsumedQty: qty,
      effectiveDemandQty: qty,
      consumptionSources: normalizeSourceQty(parsed.source, qty),
      notes: null,
    };
  }

  if (note.startsWith("SO_ONLY_MBOM|")) {
    const parsed = parsePipeNote(note);
    const qty = numberValue(parsed.qty, row.grossRequirement);
    return {
      forecastQty: 0,
      soConsumedQty: 0,
      effectiveDemandQty: qty,
      consumptionSources: [],
      notes: null,
    };
  }

  return null;
}

async function buildRunSummary(prisma, run) {
  const existingSummary = run.nettingSummary && typeof run.nettingSummary === "object"
    ? run.nettingSummary
    : null;
  const nettingSummary = parseJsonAfterPrefix(run.notes, "NETTING_SUMMARY=") || existingSummary;
  if (nettingSummary) {
    const requirementSources = await buildRequirementConsumptionByPart(prisma, run.runNumber);
    const byPart = Array.isArray(nettingSummary.byPart) ? nettingSummary.byPart : [];
    return {
      soDemandConsumedQty: numberValue(nettingSummary.totalConsumedQty),
      soDemandImpactedLines: numberValue(nettingSummary.impactedMpsLines),
      nettingSummary: {
        totalConsumedQty: numberValue(nettingSummary.totalConsumedQty),
        impactedMpsLines: numberValue(nettingSummary.impactedMpsLines),
        byPart: byPart.map((row) => ({
          partCode: row.partCode,
          consumedQty: numberValue(row.consumedQty),
          sources: [
            ...new Set([
              ...(Array.isArray(row.sources) ? row.sources : []),
              ...(requirementSources.get(row.partCode)?.sources || []),
            ]),
          ],
        })),
      },
      notes: null,
    };
  }

  const soOnlySummary = parseJsonAfterPrefix(run.notes, "SO_ONLY_SUMMARY=");
  if (!soOnlySummary) return null;

  const requirements = await prisma.mRPRequirement.findMany({
    where: { runNumber: run.runNumber, isDeleted: false, levelMBOM: 0, sourceType: "SO" },
    select: {
      partCode: true,
      soConsumedQty: true,
      grossRequirement: true,
      consumptionSources: true,
    },
  });

  const byPartMap = new Map();
  for (const requirement of requirements) {
    const consumedQty = numberValue(requirement.soConsumedQty, requirement.grossRequirement);
    const current = byPartMap.get(requirement.partCode) || { partCode: requirement.partCode, consumedQty: 0, sources: [] };
    current.consumedQty += consumedQty;
    current.sources.push(...(Array.isArray(requirement.consumptionSources) ? requirement.consumptionSources : []));
    byPartMap.set(requirement.partCode, current);
  }

  const byPart = [...byPartMap.values()].map((row) => ({
    ...row,
    sources: [...new Set(row.sources)],
  }));
  const totalConsumedQty = byPart.reduce((sum, row) => sum + numberValue(row.consumedQty), 0);

  return {
    soDemandConsumedQty: totalConsumedQty,
    soDemandImpactedLines: 0,
    nettingSummary: {
      soNumber: soOnlySummary.soNumber || null,
      partCodes: Array.isArray(soOnlySummary.partCodes) ? soOnlySummary.partCodes : [],
      totalConsumedQty,
      impactedMpsLines: 0,
      byPart,
    },
    notes: null,
  };
}

async function buildRequirementConsumptionByPart(prisma, runNumber) {
  const requirements = await prisma.mRPRequirement.findMany({
    where: { runNumber, isDeleted: false, soConsumedQty: { gt: 0 } },
    select: { partCode: true, soConsumedQty: true, consumptionSources: true },
  });

  const byPart = new Map();
  for (const requirement of requirements) {
    const current = byPart.get(requirement.partCode) || { consumedQty: 0, sources: [] };
    current.consumedQty += numberValue(requirement.soConsumedQty);
    current.sources.push(...(Array.isArray(requirement.consumptionSources) ? requirement.consumptionSources : []));
    byPart.set(requirement.partCode, current);
  }
  return byPart;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { poolConfig, schema } = resolveDatabaseConfig();
  const pool = new Pool(poolConfig);
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, schema ? { schema } : undefined),
  });

  try {
    const requirementRows = await prisma.mRPRequirement.findMany({
      where: {
        OR: [
          { notes: { startsWith: "NETTING|" } },
          { notes: { startsWith: "SO_DIRECT|" } },
          { notes: { startsWith: "SO_ONLY|" } },
          { notes: { startsWith: "SO_ONLY_MBOM|" } },
        ],
      },
      select: {
        id: true,
        notes: true,
        grossRequirement: true,
      },
    });

    let requirementsUpdated = 0;
    for (const row of requirementRows) {
      const data = mapRequirementBackfill(row);
      if (!data) continue;
      requirementsUpdated += 1;
      if (!dryRun) {
        await prisma.mRPRequirement.update({ where: { id: row.id }, data });
      }
    }

    const runRows = await prisma.mRPRun.findMany({
      where: {
        OR: [
          { notes: { startsWith: "NETTING_SUMMARY=" } },
          { notes: { startsWith: "SO_ONLY_SUMMARY=" } },
          { nettingSummary: { not: null } },
        ],
      },
      select: { id: true, runNumber: true, notes: true, nettingSummary: true },
    });

    let runsUpdated = 0;
    for (const row of runRows) {
      const data = await buildRunSummary(prisma, row);
      if (!data) continue;
      runsUpdated += 1;
      if (!dryRun) {
        await prisma.mRPRun.update({ where: { id: row.id }, data });
      }
    }

    console.log(JSON.stringify({ dryRun, requirementsUpdated, runsUpdated }, null, 2));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
