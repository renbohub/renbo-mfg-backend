const jwt = require("jsonwebtoken");
const { prisma } = require("../src/prisma");

const MPS_NUMBER = process.argv[2] || "MPS-2026-001";
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5017";

const BOM_REPAIR_CODES = new Set([
  "MBOM_UOM_MISSING",
  "BOM_DETAIL_UOM_MISSING",
  "ROUTING_MISSING",
  "ROUTING_VENDOR_MISSING",
  "ROUTING_MACHINE_MISSING",
  "ROUTING_CYCLE_TIME_MISSING",
]);

async function main() {
  const user = await prisma.user.findFirst({
    where: { isDeleted: false },
    select: { id: true },
  });

  if (!user) {
    throw new Error("Tidak ada user aktif untuk menjalankan verifikasi API.");
  }

  const token = jwt.sign(
    { id: user.id },
    process.env.JWT_SECRET || "secret-key",
    { expiresIn: "5m" },
  );

  const response = await fetch(
    `${API_BASE_URL}/api/planning/mps/${encodeURIComponent(MPS_NUMBER)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Page-Module": "planning-ppic",
        "X-Page-Code": "mps",
        "X-Page-Record": MPS_NUMBER,
      },
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `API MPS gagal (${response.status}): ${payload.message || "Unknown error"}`,
    );
  }

  const readiness = payload.readiness || {};
  const issues = Array.isArray(readiness.issues) ? readiness.issues : [];
  const bomIssues = issues.filter((issue) => BOM_REPAIR_CODES.has(issue.code));
  const invalidBomIssues = bomIssues.filter((issue) => !issue.bomNumber);
  const invalidPartIssues = issues.filter(
    (issue) =>
      (String(issue.code || "").includes("UOM") ||
        issue.code === "PURCHASE_SUPPLIER_MISSING" ||
        issue.code === "FG_MBOM_MISSING") &&
      !issue.partCode,
  );
  const routingMissingContext = await Promise.all(
    issues
      .filter((issue) => issue.code === "ROUTING_MISSING" && issue.bomNumber && issue.partCode)
      .map(async (issue) => {
        const details = await prisma.mBOMDetail.findMany({
          where: {
            noReg: issue.bomNumber,
            isDeleted: false,
            part: { partCode: issue.partCode },
          },
          select: {
            id: true,
            parentDetailId: true,
            levelComponent: true,
            category: true,
            part: {
              select: {
                partCode: true,
                itemType: true,
                partType: true,
                bomLevel: true,
                mbomHeaders: {
                  where: { isDeleted: false },
                  select: {
                    noReg: true,
                    details: { where: { isDeleted: false }, select: { id: true }, take: 1 },
                  },
                },
              },
            },
            children: {
              where: { isDeleted: false },
              select: { id: true, part: { select: { partCode: true } } },
            },
          },
        });
        return { issue, details };
      }),
  );
  const invalidDerivedFgRoutingIssues = routingMissingContext.filter(({ details }) =>
    details.some((detail) => {
      const isFg = String(detail.part?.itemType || "").toUpperCase() === "FG";
      const hasChildStructure = (detail.children || []).length > 0
        || (detail.part?.mbomHeaders || []).some((header) => (header.details || []).length > 0);
      return isFg && hasChildStructure;
    }));

  if (invalidBomIssues.length || invalidPartIssues.length || invalidDerivedFgRoutingIssues.length) {
    throw new Error(
      JSON.stringify(
        {
          message: "Kontrak readiness MPS belum terpenuhi.",
          invalidBomIssues,
          invalidPartIssues,
          invalidDerivedFgRoutingIssues,
        },
        null,
        2,
      ),
    );
  }

  console.log(
    JSON.stringify(
      {
        mpsNumber: MPS_NUMBER,
        blockingCount: Number(readiness.blockingCount || 0),
        warningCount: Number(readiness.warningCount || 0),
        issueCount: issues.length,
        bomEditorLinks: bomIssues.length,
        partMasterLinks: issues.filter(
          (issue) =>
            String(issue.code || "").includes("UOM") ||
            issue.code === "PURCHASE_SUPPLIER_MISSING",
        ).length,
        newBomLinks: issues.filter((issue) => issue.code === "FG_MBOM_MISSING")
          .length,
        issues: issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          partCode: issue.partCode,
          bomNumber: issue.bomNumber,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
