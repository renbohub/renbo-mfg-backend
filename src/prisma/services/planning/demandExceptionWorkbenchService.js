"use strict";

const crypto = require("crypto");
const { parsePeriod, buildLiveMonthlyDemand } = require("./monthlyDemandReviewService");

const OPEN_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];
const STATUSES = [...OPEN_STATUSES, "RESOLVED", "CLOSED"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? "").trim();
const array = (value) => Array.isArray(value) ? value : [];
const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const asDate = (value) => iso(value) ? new Date(value) : null;
const error = (message, statusCode = 400, code = null) => Object.assign(new Error(message), { statusCode, code });
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

const ISSUE_META = {
  PART_MASTER_MISSING: ["CRITICAL", "P0", "Part Master belum tersedia"],
  UOM_MISSING: ["CRITICAL", "P0", "UOM demand belum tersedia"],
  ACTIVE_MBOM_MISSING: ["CRITICAL", "P0", "MBOM efektif belum tersedia"],
  LEAD_TIME_MASTER_INCOMPLETE: ["CRITICAL", "P0", "Master lead time belum lengkap"],
  FCC_DRAFT: ["MEDIUM", "P2", "Forecast masih Draft"],
  UNPLANNED_PO: ["HIGH", "P1", "PO firm tidak memiliki FCC pasangan"],
  CUSTOMER_MISSING: ["MEDIUM", "P2", "Customer demand belum teridentifikasi"],
};

function phaseClassification(phase, period) {
  const status = text(phase.status).toUpperCase();
  const materialStatus = text(phase.materialStatus).toUpperCase();
  const shortages = array(phase.materialShortages);
  const start = asDate(phase.productionLatestStartDate);
  const startsPreviousMonth = start && start < period.start;
  const incomplete = Boolean(phase.calculationError) || status === "MASTER_DATA_INCOMPLETE" || status === "INCOMPLETE";
  const late = status === "LATE" || phase.feasible === false;
  const shortage = shortages.length > 0 || ["SHORTAGE", "CRITICAL", "NOT_READY"].includes(materialStatus);
  if (incomplete) return { type: "LEAD_TIME_MASTER_INCOMPLETE", severity: "CRITICAL", priority: "P0", title: "Lead time fase belum dapat dihitung" };
  if (late) return { type: "DELIVERY_PHASE_LATE", severity: "CRITICAL", priority: "P0", title: "Delivery phase tidak feasible" };
  if (startsPreviousMonth || status === "START_PREVIOUS_MONTH") return { type: "START_PREVIOUS_MONTH", severity: shortage ? "HIGH" : "MEDIUM", priority: shortage ? "P1" : "P2", title: "Produksi harus mulai bulan sebelumnya" };
  if (shortage) return { type: "MATERIAL_SHORTAGE", severity: "HIGH", priority: "P1", title: "Material belum menutup kebutuhan fase" };
  if (status === "AT_RISK") return { type: "LEAD_TIME_AT_RISK", severity: "HIGH", priority: "P1", title: "Lead time delivery phase berisiko" };
  return null;
}

function phaseDescription(meta, phase) {
  const delivery = iso(phase.targetDeliveryDate || phase.originalTargetDate)?.slice(0, 10) || "tanpa tanggal";
  const start = iso(phase.productionLatestStartDate)?.slice(0, 10) || "belum dapat dihitung";
  const constraint = text(phase.criticalConstraint) || text(phase.calculationError);
  const shortageCount = array(phase.materialShortages).length;
  if (meta.type === "MATERIAL_SHORTAGE") return `${shortageCount || "Ada"} material shortage untuk delivery ${delivery}; latest production start ${start}.`;
  if (meta.type === "START_PREVIOUS_MONTH") return `Delivery ${delivery} membutuhkan latest production start ${start}.`;
  return `${meta.title} untuk delivery ${delivery}${constraint ? `: ${constraint}` : "."}`;
}

function sourceFields(detail, phase = null) {
  return {
    sourceDeliveryTargetId: text(phase?.sourceTargetId || phase?.deliveryTargetId) || null,
    sourceType: text(phase?.sourceType) || null,
    sourceNumber: text(phase?.sourceNumber) || null,
    sourceLineId: text(phase?.sourceLineId) || null,
    phaseNumber: number(phase?.phaseNumber) || null,
    customerCode: text(phase?.customerCode) || array(detail.customerCodes)[0] || null,
    partCode: detail.partCode,
    partNumber: detail.partNumber || null,
    partName: detail.partName || null,
    demandQty: number(phase?.qty || phase?.demandQty || detail.effQty),
    uomCode: phase?.uomCode || detail.uomCode || null,
    targetDeliveryDate: asDate(phase?.targetDeliveryDate || phase?.originalTargetDate),
    productionLatestStartDate: asDate(phase?.productionLatestStartDate),
  };
}

function candidateIdentity(period, fields, exceptionType) {
  const sourceIdentity = fields.sourceDeliveryTargetId || [fields.sourceType, fields.sourceNumber, fields.sourceLineId, fields.phaseNumber].filter(Boolean).join("|") || fields.partCode;
  const basis = `${period.key}|${sourceIdentity}|${exceptionType}`;
  return { basis, identityKey: hash(basis) };
}

function buildCandidates(source) {
  const candidates = [];
  for (const detail of source.details) {
    const trace = detail.sourceTrace && typeof detail.sourceTrace === "object" ? detail.sourceTrace : {};
    const phases = array(trace.effectiveDeliveryPhases);
    for (const phase of phases) {
      const meta = phaseClassification(phase, source.period);
      if (!meta) continue;
      const fields = sourceFields(detail, phase);
      const identity = candidateIdentity(source.period, fields, meta.type);
      candidates.push({
        ...fields, ...meta, exceptionType: meta.type, ...identity,
        description: phaseDescription(meta, phase),
        sourceDetailId: detail.id || null,
        sourceTrace: {
          identityBasis: identity.basis,
          signals: [text(phase.status), text(phase.materialStatus), text(phase.criticalConstraint)].filter(Boolean),
          formula: trace.formula || null,
          leadTimePolicy: trace.leadTimePolicy || null,
          phase,
        },
      });
    }
    const phaseAggregates = new Set(["LEAD_TIME_MASTER_INCOMPLETE", "DELIVERY_PHASE_LATE", "START_PREVIOUS_MONTH", "LEAD_TIME_AT_RISK"]);
    for (const issue of array(detail.readinessIssues)) {
      const code = text(issue.code).toUpperCase();
      if (!ISSUE_META[code] || phaseAggregates.has(code)) continue;
      const [severity, priority, title] = ISSUE_META[code];
      const fields = sourceFields(detail);
      const identity = candidateIdentity(source.period, fields, code);
      candidates.push({
        ...fields, severity, priority, title, exceptionType: code, ...identity,
        description: text(issue.message) || title,
        sourceDetailId: detail.id || null,
        sourceTrace: { identityBasis: identity.basis, formula: trace.formula || null, readinessIssue: issue },
      });
    }
  }
  return candidates;
}

async function loadSource(prisma, input) {
  const period = parsePeriod(input.month);
  const snapshots = await prisma.monthlyDemandSnapshot.findMany({
    where: { periodYear: period.year, periodMonth: period.month, isDeleted: false },
    orderBy: { revision: "desc" },
    select: { id: true, snapshotNumber: true, revision: true, status: true, isCurrentRevision: true, sourceFingerprint: true, sourceDataAsOf: true },
  });
  const requestedId = text(input.snapshotId);
  const selectedHeader = requestedId ? snapshots.find((row) => row.id === requestedId) : snapshots.find((row) => row.isCurrentRevision);
  if (requestedId && !selectedHeader) throw error("Snapshot untuk periode ini tidak ditemukan.", 404, "SNAPSHOT_NOT_FOUND");
  if (selectedHeader) {
    const selected = await prisma.monthlyDemandSnapshot.findFirst({
      where: { id: selectedHeader.id, isDeleted: false },
      include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
    });
    return { period, snapshots, mode: "SNAPSHOT", snapshot: selected, fingerprint: selected.sourceFingerprint, details: selected.details };
  }
  const live = await buildLiveMonthlyDemand(prisma, period.key);
  return { period, snapshots, mode: "LIVE", snapshot: null, fingerprint: live.sourceFingerprint, details: live.items };
}

function exceptionNumber(period, identityKey) {
  return `DEX-${period.year}${String(period.month).padStart(2, "0")}-${identityKey.slice(0, 8).toUpperCase()}`;
}

function syncData(source, candidate, actor, now) {
  return {
    periodYear: source.period.year,
    periodMonth: source.period.month,
    sourceMode: source.mode,
    sourceSnapshotId: source.snapshot?.id || null,
    sourceSnapshotNumber: source.snapshot?.snapshotNumber || null,
    sourceFingerprint: source.fingerprint,
    sourceDetailId: candidate.sourceDetailId,
    sourceDeliveryTargetId: candidate.sourceDeliveryTargetId,
    sourceType: candidate.sourceType,
    sourceNumber: candidate.sourceNumber,
    sourceLineId: candidate.sourceLineId,
    phaseNumber: candidate.phaseNumber,
    customerCode: candidate.customerCode,
    partCode: candidate.partCode,
    partNumber: candidate.partNumber,
    partName: candidate.partName,
    demandQty: candidate.demandQty,
    uomCode: candidate.uomCode,
    targetDeliveryDate: candidate.targetDeliveryDate,
    productionLatestStartDate: candidate.productionLatestStartDate,
    exceptionType: candidate.exceptionType,
    severity: candidate.severity,
    title: candidate.title,
    description: candidate.description,
    sourceActive: true,
    sourceClearedAt: null,
    lastDetectedAt: now,
    sourceTrace: candidate.sourceTrace,
    updatedBy: actor,
  };
}

async function syncExceptions(prisma, input, actor) {
  const source = await loadSource(prisma, input);
  const candidates = buildCandidates(source);
  const now = new Date();
  const identities = candidates.map((row) => row.identityKey);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026081817)`;
    const existing = await tx.demandException.findMany({
      where: { periodYear: source.period.year, periodMonth: source.period.month, isDeleted: false },
      select: { id: true, identityKey: true, status: true, sourceActive: true, sourceFingerprint: true },
    });
    const byIdentity = new Map(existing.map((row) => [row.identityKey, row]));
    let created = 0;
    let refreshed = 0;
    for (const candidate of candidates) {
      const current = byIdentity.get(candidate.identityKey);
      const data = syncData(source, candidate, actor, now);
      if (current) {
        await tx.demandException.update({ where: { id: current.id }, data });
        if (!current.sourceActive || current.sourceFingerprint !== source.fingerprint) {
          await tx.demandExceptionAction.create({ data: { exceptionId: current.id, action: "SOURCE_REFRESH", fromStatus: current.status, toStatus: current.status, actor, metadata: { sourceMode: source.mode, snapshotNumber: source.snapshot?.snapshotNumber || null } } });
        }
        refreshed += 1;
      } else {
        await tx.demandException.create({
          data: {
            exceptionNumber: exceptionNumber(source.period, candidate.identityKey), identityKey: candidate.identityKey,
            ...data, priority: candidate.priority, status: "OPEN", detectedAt: now, createdBy: actor,
            actions: { create: { action: "DETECTED", fromStatus: null, toStatus: "OPEN", actor, metadata: { sourceMode: source.mode, snapshotNumber: source.snapshot?.snapshotNumber || null } } },
          },
        });
        created += 1;
      }
    }
    const clearedRows = existing.filter((row) => row.sourceActive && !identities.includes(row.identityKey));
    for (const row of clearedRows) {
      await tx.demandException.update({ where: { id: row.id }, data: { sourceActive: false, sourceClearedAt: now, updatedBy: actor } });
      await tx.demandExceptionAction.create({ data: { exceptionId: row.id, action: "SOURCE_CLEARED", fromStatus: row.status, toStatus: row.status, actor, metadata: { sourceMode: source.mode, snapshotNumber: source.snapshot?.snapshotNumber || null } } });
    }
    return {
      period: source.period.key, sourceMode: source.mode,
      snapshot: source.snapshot ? { id: source.snapshot.id, snapshotNumber: source.snapshot.snapshotNumber, status: source.snapshot.status } : null,
      detected: candidates.length, created, refreshed, cleared: clearedRows.length,
    };
  }, { maxWait: 30000, timeout: 120000 });
}

function listWhere(options, period) {
  const where = { periodYear: period.year, periodMonth: period.month, isDeleted: false };
  const sourceState = text(options.sourceState || "ACTIVE").toUpperCase();
  if (sourceState !== "ALL") where.sourceActive = sourceState !== "CLEARED";
  const status = text(options.status).toUpperCase();
  if (STATUSES.includes(status)) where.status = status;
  else if (status === "OPEN_QUEUE") where.status = { in: OPEN_STATUSES };
  const severity = text(options.severity).toUpperCase();
  if (SEVERITIES.includes(severity)) where.severity = severity;
  const type = text(options.type).toUpperCase();
  if (type) where.exceptionType = type;
  const owner = text(options.owner);
  if (owner === "UNASSIGNED") where.ownerUserId = null;
  else if (owner) where.ownerUserId = owner;
  if (["1", "TRUE", "YES"].includes(text(options.overdue).toUpperCase())) {
    where.status = { in: OPEN_STATUSES };
    where.targetResolutionDate = { lt: new Date() };
  }
  const q = text(options.q);
  if (q) where.OR = [
    { exceptionNumber: { contains: q, mode: "insensitive" } }, { partCode: { contains: q, mode: "insensitive" } },
    { partNumber: { contains: q, mode: "insensitive" } }, { partName: { contains: q, mode: "insensitive" } },
    { customerCode: { contains: q, mode: "insensitive" } }, { sourceNumber: { contains: q, mode: "insensitive" } },
    { title: { contains: q, mode: "insensitive" } },
  ];
  return where;
}

function compactItem(row, now = new Date()) {
  return {
    ...row,
    overdue: Boolean(row.targetResolutionDate && OPEN_STATUSES.includes(row.status) && row.targetResolutionDate < now),
    sourceTrace: undefined,
  };
}

async function listExceptions(prisma, options = {}) {
  const period = parsePeriod(options.month);
  const pageSize = Math.min(100, Math.max(10, Math.floor(number(options.pageSize) || 25)));
  const page = Math.max(1, Math.floor(number(options.page) || 1));
  const where = listWhere(options, period);
  const baseWhere = { periodYear: period.year, periodMonth: period.month, isDeleted: false };
  const activeWhere = { ...baseWhere, sourceActive: true };
  const now = new Date();
  const [items, filtered, total, open, critical, overdue, unassigned, resolved, cleared, typeRows, users, snapshots] = await Promise.all([
    prisma.demandException.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ sourceActive: "desc" }, { priority: "asc" }, { targetResolutionDate: "asc" }, { targetDeliveryDate: "asc" }, { exceptionNumber: "asc" }] }),
    prisma.demandException.count({ where }),
    prisma.demandException.count({ where: activeWhere }),
    prisma.demandException.count({ where: { ...activeWhere, status: { in: OPEN_STATUSES } } }),
    prisma.demandException.count({ where: { ...activeWhere, severity: "CRITICAL", status: { in: OPEN_STATUSES } } }),
    prisma.demandException.count({ where: { ...activeWhere, targetResolutionDate: { lt: now }, status: { in: OPEN_STATUSES } } }),
    prisma.demandException.count({ where: { ...activeWhere, ownerUserId: null, status: { in: OPEN_STATUSES } } }),
    prisma.demandException.count({ where: { ...activeWhere, status: { in: ["RESOLVED", "CLOSED"] } } }),
    prisma.demandException.count({ where: { ...baseWhere, sourceActive: false } }),
    prisma.demandException.findMany({ where: baseWhere, distinct: ["exceptionType"], select: { exceptionType: true }, orderBy: { exceptionType: "asc" } }),
    prisma.user.findMany({ where: { isDeleted: false }, select: { id: true, username: true, fullName: true, email: true }, orderBy: [{ fullName: "asc" }, { username: "asc" }] }),
    prisma.monthlyDemandSnapshot.findMany({ where: { periodYear: period.year, periodMonth: period.month, isDeleted: false }, select: { id: true, snapshotNumber: true, revision: true, status: true, isCurrentRevision: true }, orderBy: { revision: "desc" } }),
  ]);
  const summary = { total, open, critical, overdue, unassigned, resolved, cleared };
  const types = typeRows.map((row) => row.exceptionType);
  return { period: period.key, items: items.map((row) => compactItem(row, now)), pagination: { page, pageSize, filtered, pages: Math.max(1, Math.ceil(filtered / pageSize)) }, summary, users, snapshots, options: { statuses: STATUSES, priorities: PRIORITIES, severities: SEVERITIES, types } };
}

async function findException(prisma, id, includeActions = false) {
  const row = await prisma.demandException.findFirst({ where: { id, isDeleted: false }, include: includeActions ? { actions: { orderBy: { createdAt: "desc" } } } : undefined });
  if (!row) throw error("Demand exception tidak ditemukan.", 404, "EXCEPTION_NOT_FOUND");
  return row;
}

async function getException(prisma, id) {
  const row = await findException(prisma, id, true);
  const recoveryPlan = row.sourceDeliveryTargetId ? await prisma.dueDateRecoveryPlan.findFirst({ where: { deliveryTargetId: row.sourceDeliveryTargetId, isCurrentPlan: true, isDeleted: false }, orderBy: { revision: "desc" } }) : null;
  return { ...row, overdue: Boolean(row.targetResolutionDate && OPEN_STATUSES.includes(row.status) && row.targetResolutionDate < new Date()), recoveryPlan };
}

async function updateAssignment(prisma, id, input, actor) {
  const current = await findException(prisma, id);
  const priority = text(input.priority || current.priority).toUpperCase();
  if (!PRIORITIES.includes(priority)) throw error("Priority harus P0, P1, P2, atau P3.");
  let owner = null;
  if (text(input.ownerUserId)) {
    owner = await prisma.user.findFirst({ where: { id: text(input.ownerUserId), isDeleted: false }, select: { id: true, username: true, fullName: true } });
    if (!owner) throw error("Owner yang dipilih tidak ditemukan.", 404, "OWNER_NOT_FOUND");
  }
  const due = text(input.targetResolutionDate) ? asDate(input.targetResolutionDate) : null;
  if (text(input.targetResolutionDate) && !due) throw error("Target penyelesaian tidak valid.");
  const updated = await prisma.demandException.update({ where: { id }, data: { ownerUserId: owner?.id || null, ownerUsername: owner?.username || null, ownerName: owner?.fullName || owner?.username || null, targetResolutionDate: due, priority, updatedBy: actor } });
  await prisma.demandExceptionAction.create({ data: { exceptionId: id, action: "ASSIGN", fromStatus: current.status, toStatus: current.status, actor, note: text(input.note) || null, metadata: { ownerUserId: owner?.id || null, ownerName: owner?.fullName || owner?.username || null, targetResolutionDate: iso(due), priority } } });
  return updated;
}

async function transitionException(prisma, id, action, input, actor) {
  const current = await findException(prisma, id);
  const transitions = {
    acknowledge: { from: ["OPEN"], to: "ACKNOWLEDGED" },
    start: { from: ["OPEN", "ACKNOWLEDGED"], to: "IN_PROGRESS" },
    resolve: { from: OPEN_STATUSES, to: "RESOLVED" },
    close: { from: ["RESOLVED"], to: "CLOSED" },
    reopen: { from: ["RESOLVED", "CLOSED"], to: "OPEN" },
  };
  const transition = transitions[action];
  if (!transition || !transition.from.includes(current.status)) throw error(`Status ${current.status} tidak dapat menjalankan aksi ${action}.`, 409, "INVALID_EXCEPTION_TRANSITION");
  if (action === "start" && (!current.ownerUserId || !current.targetResolutionDate)) throw error("Tentukan owner dan target penyelesaian sebelum mulai dikerjakan.", 409, "ASSIGNMENT_REQUIRED");
  const note = text(input.note || input.reason || input.resolutionSummary);
  const data = { status: transition.to, updatedBy: actor };
  let metadata = null;
  if (action === "acknowledge") Object.assign(data, { acknowledgedBy: actor, acknowledgedAt: new Date() });
  if (action === "resolve") {
    const summary = text(input.resolutionSummary);
    const evidenceNote = text(input.evidenceNote);
    if (summary.length < 10) throw error("Ringkasan penyelesaian minimal 10 karakter.");
    if (evidenceNote.length < 5) throw error("Bukti penyelesaian wajib diisi minimal 5 karakter.");
    metadata = { evidenceNote, referenceUrl: text(input.referenceUrl) || null };
    Object.assign(data, { resolvedBy: actor, resolvedAt: new Date(), resolutionSummary: summary, resolutionEvidence: metadata });
  }
  if (action === "close") Object.assign(data, { closedBy: actor, closedAt: new Date() });
  if (action === "reopen") {
    if (note.length < 10) throw error("Alasan buka kembali minimal 10 karakter.");
    Object.assign(data, { acknowledgedBy: null, acknowledgedAt: null, resolvedBy: null, resolvedAt: null, resolutionSummary: null, resolutionEvidence: null, closedBy: null, closedAt: null });
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.demandException.update({ where: { id }, data });
    await tx.demandExceptionAction.create({ data: { exceptionId: id, action: action.toUpperCase(), fromStatus: current.status, toStatus: transition.to, actor, note: note || null, metadata } });
    return updated;
  });
}

async function addNote(prisma, id, input, actor) {
  const current = await findException(prisma, id);
  const note = text(input.note);
  if (note.length < 3) throw error("Catatan minimal 3 karakter.");
  return prisma.demandExceptionAction.create({ data: { exceptionId: id, action: "NOTE", fromStatus: current.status, toStatus: current.status, actor, note } });
}

module.exports = { OPEN_STATUSES, STATUSES, PRIORITIES, SEVERITIES, buildCandidates, syncExceptions, listExceptions, getException, updateAssignment, transitionException, addNote };
