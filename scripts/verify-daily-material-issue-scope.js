require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const controller = require("../src/prisma/controllers/production/DailyProductionScheduleController");

function invoke(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    Promise.resolve(handler({
      params: {},
      body: {},
      query: {},
      user: { username: "codex-workflow-verifier" },
      ...req,
    }, response, reject)).catch(reject);
  });
}

async function main() {
  const requestedScheduleNumber = process.argv[2] || null;
  const schedules = await prisma.dailyProductionSchedule.findMany({
    where: {
      isDeleted: false,
      status: { in: ["Draft", "Released"] },
      moId: { not: null },
      partCode: { not: null },
      ...(requestedScheduleNumber ? { scheduleNumber: requestedScheduleNumber } : {}),
    },
    orderBy: [{ scheduleDate: "asc" }, { sequence: "asc" }],
    take: 100,
  });
  let selected = null;
  let fallback = null;
  for (const schedule of schedules) {
    const target = await prisma.mBOMDetail.findFirst({
      where: {
        isDeleted: false,
        part: { partCode: schedule.partCode },
        children: { some: { isDeleted: false } },
      },
      select: {
        id: true,
        part: { select: { partCode: true, partName: true } },
        children: {
          where: { isDeleted: false },
          select: {
            id: true,
            category: true,
            part: {
              select: {
                partCode: true,
                partName: true,
                itemType: true,
                partType: true,
                rawType: true,
              },
            },
          },
        },
      },
    });
    if (target?.children?.length) {
      const candidate = { schedule, target };
      if (!fallback) fallback = candidate;
      const hasProductionChild = target.children.some((child) =>
        child.category !== "Purchase"
        || ["FG", "WIP"].includes(String(child.part?.itemType || "").toUpperCase()),
      );
      if (hasProductionChild) {
        selected = candidate;
        break;
      }
    }
  }
  selected = selected || fallback;
  if (!selected) {
    console.log(JSON.stringify({
      skipped: true,
      message: requestedScheduleNumber
        ? `Daily Plan ${requestedScheduleNumber} tidak ditemukan atau tidak mempunyai direct child BOM.`
        : "Tidak ada Daily Plan Draft/Released yang mempunyai direct child BOM.",
    }, null, 2));
    return;
  }

  const result = await invoke(controller.consume, {
    params: { scheduleNumber: selected.schedule.scheduleNumber },
  });
  const issue = result.body?.materialIssue;
  console.log(JSON.stringify({
    statusCode: result.statusCode,
    scheduleNumber: selected.schedule.scheduleNumber,
    productionItem: selected.target.part,
    expectedDirectChildren: selected.target.children.map((child) => ({
      partCode: child.part?.partCode,
      partName: child.part?.partName,
      itemType: child.part?.itemType,
      partType: child.part?.partType,
      rawType: child.part?.rawType,
      category: child.category,
    })),
    materialIssue: issue ? {
      issueNumber: issue.issueNumber,
      status: issue.status,
      details: (issue.details || []).map((detail) => ({
        partCode: detail.partCode,
        partName: detail.partName,
        qtyRequired: detail.qtyRequired,
        qtyIssued: detail.qtyIssued,
        uomCode: detail.uomCode,
        notes: detail.notes,
      })),
    } : null,
    message: result.body?.message || null,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
