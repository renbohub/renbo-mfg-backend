"use strict";

const { prisma } = require("../src/prisma");
const { validateBomGraphStructure } = require("../src/prisma/services/planning/solver/bomGraphValidationService");

async function main() {
  const fixLevels = process.argv.includes("--fix-levels");
  const fixActiveRevisions = process.argv.includes("--fix-active-revisions");
  const headers = await prisma.mBOMHeader.findMany({
    where: { isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false },
        include: {
          part: { select: { id: true, partCode: true } },
          mbomProcesses: { where: { isDeleted: false } },
        },
      },
    },
  });
  const affected = [];
  const levelUpdates = [];
  const now = new Date();
  const activeByPart = new Map();
  for (const header of headers) {
    const effective = header.effectiveDate ? new Date(header.effectiveDate) : null;
    const expiry = header.expiryDate ? new Date(header.expiryDate) : null;
    if ((effective && effective > now) || (expiry && expiry < now)) continue;
    const rows = activeByPart.get(String(header.partId)) || [];
    rows.push(header);
    activeByPart.set(String(header.partId), rows);
  }
  const activeRevisionAmbiguities = [...activeByPart.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([partId, rows]) => ({
      partId,
      revisions: rows
        .sort((left, right) => Number(right.revision) - Number(left.revision) || new Date(right.updatedAt) - new Date(left.updatedAt))
        .map((row) => ({ id: row.id, noReg: row.noReg, revision: row.revision, effectiveDate: row.effectiveDate, expiryDate: row.expiryDate })),
    }));
  const activeRevisionUpdates = [];
  if (fixActiveRevisions) {
    for (const ambiguity of activeRevisionAmbiguities) {
      const [keeper, ...superseded] = ambiguity.revisions;
      const keeperHeader = headers.find((row) => row.id === keeper.id);
      const cutoff = new Date(keeperHeader.effectiveDate || keeperHeader.createdAt || now);
      const expiryDate = new Date(cutoff.getTime() - 1);
      for (const row of superseded) {
        activeRevisionUpdates.push(prisma.mBOMHeader.update({ where: { id: row.id }, data: { expiryDate } }));
      }
    }
  }
  for (const header of headers) {
    const validation = validateBomGraphStructure(header);
    if (validation.issueCount) {
      affected.push({
        id: header.id,
        noReg: header.noReg,
        revision: header.revision,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
    if (fixLevels && validation.valid) {
      for (const detail of header.details) {
        const expectedLevel = validation.normalizedLevels[String(detail.id)];
        if (expectedLevel != null && Number(detail.levelComponent) !== expectedLevel) {
          levelUpdates.push(prisma.mBOMDetail.update({
            where: { id: detail.id },
            data: { levelComponent: expectedLevel },
          }));
        }
      }
    }
  }
  const repairOperations = [...levelUpdates, ...activeRevisionUpdates];
  if (repairOperations.length) await prisma.$transaction(repairOperations);
  const payload = {
    headerCount: headers.length,
    affectedCount: affected.length,
    errorCount: affected.reduce((sum, row) => sum + row.errors.length, 0),
    warningCount: affected.reduce((sum, row) => sum + row.warnings.length, 0),
    normalizedLevelCount: levelUpdates.length,
    activeRevisionAmbiguityCount: activeRevisionAmbiguities.length,
    activeRevisionRepairCount: activeRevisionUpdates.length,
    activeRevisionAmbiguities,
    affected,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (payload.errorCount) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
