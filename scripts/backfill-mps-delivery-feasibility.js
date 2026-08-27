"use strict";

const { prisma } = require("../src/prisma");
const { refreshMpsDeliveryFeasibility } = require("../src/prisma/services/planning/mpsDeliveryFeasibilityService");

async function main() {
  const execute = process.argv.includes("--execute");
  const documents = await prisma.mPS.findMany({
    where: {
      isDeleted: false,
      sourceKey: { startsWith: "MONTH:" },
      status: { notIn: ["Superseded", "Cancelled"] },
    },
    select: { mpsNumber: true, status: true, lifecycleStatus: true, revision: true },
    orderBy: [{ periodStart: "asc" }, { mpsNumber: "asc" }],
  });
  console.log(`${documents.length} MPS kanonis ditemukan.`);
  if (!execute) {
    documents.forEach((row) => console.log(`DRY RUN ${row.mpsNumber} · R${row.revision} · ${row.status}/${row.lifecycleStatus}`));
    console.log("Jalankan ulang dengan --execute untuk membentuk snapshot.");
    return;
  }
  for (const document of documents) {
    const gate = await prisma.$transaction((tx) => refreshMpsDeliveryFeasibility(tx, document.mpsNumber), { timeout: 60000 });
    console.log(`${document.mpsNumber} · ${gate.feasibilityStatus} · ${gate.officialGateStatus} · ${gate.blockerCount} blocker · ${gate.snapshots.length} phase`);
  }
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
