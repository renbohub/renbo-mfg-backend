/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const controller = require("../src/prisma/controllers/planning/MPSController");

function invoke(fn, body) {
  return new Promise((resolve, reject) => {
    const req = { body, user: { username: "system" } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ statusCode: this.statusCode, body: value }); return this; },
    };
    fn(req, res, (error) => reject(error));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const forecastArg = args.find((arg) => arg.startsWith("--forecast="));
  const monthsArg = args.find((arg) => arg.startsWith("--months="));
  const forecastNumber = forecastArg
    ? forecastArg.slice("--forecast=".length).trim()
    : (args.find((arg) => !arg.startsWith("--")) || "FCT-2026-001");
  const months = monthsArg
    ? monthsArg.slice("--months=".length).split(",").map((value) => value.trim()).filter(Boolean)
    : ["2026-08", "2026-09"];
  const result = await invoke(controller.createFromForecast, {
    forecastNumber,
    months,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
