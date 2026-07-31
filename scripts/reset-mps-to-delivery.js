/* eslint-disable no-console */
// Destructive reset for the requested planning-to-delivery test run.
// Keeps master data, users, and Forecast/ForecastDetail; clears transactional data.
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const { resetPlanningFlow } = require("../src/prisma/services/system/planningFlowResetService");

async function main() {
  console.log(JSON.stringify(await resetPlanningFlow(prisma, { forecastStatus: "Confirmed" }), null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
