const jwt = require("jsonwebtoken");
const { prisma } = require("../src/prisma");

const backendUrl = (process.env.BACKEND_URL || "http://localhost:5017").replace(/\/$/, "");
const fixture = {
  module: "sales",
  page: "page-context-contract",
  record: `CTX-${Date.now()}`,
  message: `Context isolation test ${Date.now()}`,
};
let createdId = null;

async function request(path, token, options = {}) {
  const response = await fetch(`${backendUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Page-Module": fixture.module,
      "X-Page-Code": fixture.page,
      "X-Page-Record": fixture.record,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${payload.message || "request failed"}`);
  return payload;
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { isDeleted: false },
    select: { id: true },
  });
  if (!user) throw new Error("Tidak ada user aktif untuk kontrak authenticated endpoint.");
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || "secret-key", { expiresIn: "5m" });

  const created = await request("/api/page-context/comments", token, {
    method: "POST",
    body: JSON.stringify(fixture),
  });
  createdId = created.id;

  const expectedEvents = ["CREATE", "UPDATE", "DELETE", "SUBMIT", "NEED_APPROVAL", "APPROVED", "REJECTED"];
  await prisma.log.createMany({
    data: [...expectedEvents, "READ"].map((action) => ({
      nameRoute: fixture.page,
      action,
      method: action === "DELETE" ? "DELETE" : action === "UPDATE" ? "PATCH" : "POST",
      url: `/api/contract/${action.toLowerCase()}`,
      statusCode: 200,
      userId: user.id,
      entityId: fixture.record,
      moduleCode: fixture.module,
      pageCode: fixture.page,
      recordKey: fixture.record,
      logType: "ACTIVITY",
    })),
  });
  const alarm = await prisma.log.create({
    data: {
      nameRoute: fixture.page,
      action: "BLOCKER",
      method: "PATCH",
      url: "/api/planning/mps/contract/confirm",
      statusCode: 409,
      userId: user.id,
      entityId: fixture.record,
      errorMessage: "MPS belum siap dikonfirmasi: 2 blocker routing/UOM harus diperbaiki.",
      changes: {
        errorDetails: {
          code: "MPS_READINESS_BLOCKED",
          readiness: {
            blockingCount: 2,
            issues: [
              { severity: "BLOCKING", code: "ROUTING_MISSING", message: "Routing belum tersedia." },
              { severity: "BLOCKING", code: "BOM_DETAIL_UOM_MISSING", message: "UOM belum tersedia." },
            ],
          },
        },
      },
      moduleCode: fixture.module,
      pageCode: fixture.page,
      recordKey: fixture.record,
      logType: "ALARM",
    },
  });
  const reportedError = await request("/api/page-context/errors", token, {
    method: "POST",
    body: JSON.stringify({ ...fixture, message: "Synthetic client error", stack: "contract-stack", url: "/contract" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const matching = await request(`/api/page-context?module=${fixture.module}&page=${fixture.page}&record=${fixture.record}`, token);
  const isolated = await request(`/api/page-context?module=${fixture.module}&page=${fixture.page}&record=OTHER-RECORD`, token);
  const overview = await request(`/api/page-context/overview?module=${fixture.module}&type=COMMENT&q=${encodeURIComponent(fixture.message)}`, token);
  const errorOverview = await request(`/api/page-context/overview?module=${fixture.module}&type=ALARM`, token);

  const assertions = {
    matchingComment: matching.comments.some((item) => item.id === createdId),
    otherRecordExcluded: !isolated.comments.some((item) => item.id === createdId),
    overviewGrouped: overview.items.some((item) => item.id === createdId && item.module === fixture.module),
    matchingActivityEvents: expectedEvents.every((event) => matching.activities.some((item) => item.action === event && item.type === "LOG")),
    readActivityExcluded: !matching.activities.some((item) => item.action === "READ"),
    matchingError: matching.errors.some((item) => item.id === reportedError.id),
    matchingAlarmDetails: matching.errors.some((item) => item.id === alarm.id && item.type === "ALARM" && item.details?.readiness?.issues?.length === 2),
    otherRecordErrorExcluded: !isolated.errors.some((item) => item.id === reportedError.id),
    errorOverviewGrouped: errorOverview.items.some((item) => item.id === alarm.id && item.module === fixture.module),
  };
  if (Object.values(assertions).some((value) => !value)) {
    throw new Error(`Page context contract gagal: ${JSON.stringify(assertions)}`);
  }
  console.log(`Page context contract passed: ${JSON.stringify(assertions)}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (createdId) await prisma.pageComment.deleteMany({ where: { id: createdId } });
    await prisma.log.deleteMany({
      where: {
        moduleCode: fixture.module,
        pageCode: fixture.page,
        recordKey: fixture.record,
      },
    });
    await prisma.$disconnect();
  });
