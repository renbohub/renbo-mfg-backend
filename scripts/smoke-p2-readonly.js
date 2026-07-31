const { prisma } = require("../src/prisma");
const reports = require("../src/prisma/controllers/reporting/P2ReportingController");
const { buildCapacitySnapshot } = require("../src/prisma/services/planning/capacityPlanningService");

function capture() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function call(handler, query = {}) {
  const response = capture();
  await handler(
    { query },
    response,
    (error) => {
      throw error;
    },
  );
  if (response.statusCode >= 400) {
    throw new Error(response.payload?.message || `HTTP ${response.statusCode}`);
  }
  return response.payload;
}

async function main() {
  const [costing, structure, inventory, margin, trend] = await Promise.all([
    call(reports.mbomCosting, { page: 1, limit: 1 }),
    call(reports.mbomStructure, { page: 1, limit: 1 }),
    call(reports.inventory, { page: 1, limit: 1 }),
    call(reports.salesMargin, { page: 1, limit: 1 }),
    call(reports.costTrend, { year: new Date().getFullYear() }),
  ]);
  for (const [name, payload] of Object.entries({
    costing,
    structure,
    inventory,
    margin,
    trend,
  })) {
    if (!Array.isArray(payload.items) || !payload.summary || !payload.chart) {
      throw new Error(`${name} report contract tidak lengkap`);
    }
    console.log("PASS", name, {
      total: payload.total,
      returned: payload.items.length,
    });
  }

  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1);
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const common = { startDate, endDate, shiftHours: 8, efficiencyPercent: 85 };
  const [normal, maximum] = await Promise.all([
    buildCapacitySnapshot(prisma, {
      ...common,
      scenarioName: "Normal",
      shiftsPerDay: 1,
      overtimeHours: 0,
      includeSaturday: false,
      includeSunday: false,
    }),
    buildCapacitySnapshot(prisma, {
      ...common,
      scenarioName: "Max",
      shiftsPerDay: 3,
      overtimeHours: 4,
      includeSaturday: true,
      includeSunday: false,
    }),
  ]);
  if (!normal.summary || !maximum.summary) {
    throw new Error("Capacity scenario comparison contract tidak lengkap");
  }
  console.log("PASS capacity scenarios", {
    normalAvailable: normal.summary.totalAvailableMinutes,
    maxAvailable: maximum.summary.totalAvailableMinutes,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
