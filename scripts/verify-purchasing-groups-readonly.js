require("dotenv").config();

const controller = require("../src/prisma/controllers/purchasing/PurchaseRequisitionController");
const { prisma } = require("../src/prisma");

const categories = [
  "material",
  "purchase-part",
  "universal-purchase-part",
  "non-production",
];

function invokeList(category) {
  return new Promise((resolve, reject) => {
    const req = { query: { category, page: 1, limit: 5 } };
    const res = {
      json(payload) { resolve(payload); },
      status(code) {
        return {
          json(payload) { reject(new Error(`${code}: ${payload?.message || "request failed"}`)); },
        };
      },
    };
    controller.list(req, res, reject);
  });
}

(async () => {
  for (const category of categories) {
    const payload = await invokeList(category);
    if (!Array.isArray(payload.items)) throw new Error(`${category}: items bukan array.`);
    console.log(`PASS ${category}: ${payload.total} PR`);
  }

  const [groupedHeaders, normalizedSources] = await Promise.all([
    prisma.purchaseRequisition.count({ where: { procurementGroup: { not: null }, isDeleted: false } }),
    prisma.purchaseRequisitionSource.count({ where: { isDeleted: false } }),
  ]);
  console.log(`PASS schema runtime: ${groupedHeaders} grouped header, ${normalizedSources} source allocation`);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
