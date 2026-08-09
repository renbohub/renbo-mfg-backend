const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function blockerKey(issue = {}) {
  return [
    issue.code,
    issue.phaseId,
    issue.phaseNumber,
    issue.allocationId,
    issue.relatedAllocationId,
    issue.lineNumber,
    issue.processCode,
  ].map((value) => String(value ?? "-")).join("|");
}

function uniqueBlockers(blockers = []) {
  return [...new Map((blockers || []).map((issue) => [blockerKey(issue), issue])).values()];
}

function phaseReference(value = {}) {
  return {
    id: value.phaseId || value.deliveryPhaseId || value.id || null,
    number: value.phaseNumber ?? value.deliveryPhaseNumber ?? value.number ?? null,
  };
}

function samePhase(left = {}, right = {}) {
  const leftRef = phaseReference(left);
  const rightRef = phaseReference(right);
  if (leftRef.id && rightRef.id) return leftRef.id === rightRef.id;
  return leftRef.number != null && rightRef.number != null
    && Number(leftRef.number) === Number(rightRef.number);
}

function buildAuthoritativePhaseResults({
  phaseResults = [],
  blockers = [],
  allocationPhases = [],
  deliveryPhases = [],
} = {}) {
  const allocationPhaseById = new Map((allocationPhases || []).map((allocation) => [allocation.id, phaseReference(allocation)]));
  const blockedDeliveryPhases = (deliveryPhases || []).filter((phase) => phase.status === "BLOCKED");
  const attributedBlockers = [];
  const globalBlockers = [];

  for (const blocker of blockers || []) {
    const direct = phaseReference(blocker);
    const allocationPhase = allocationPhaseById.get(blocker.allocationId)
      || allocationPhaseById.get(blocker.relatedAllocationId)
      || null;
    const reference = direct.id || direct.number != null ? direct : allocationPhase;
    if (reference?.id || reference?.number != null) attributedBlockers.push({ blocker, reference });
    else globalBlockers.push(blocker);
  }

  return (phaseResults || []).map((phase) => {
    const phaseBlockers = attributedBlockers
      .filter(({ reference }) => samePhase(phase, reference))
      .map(({ blocker }) => blocker);
    const deliveryBlocked = blockedDeliveryPhases.some((deliveryPhase) => samePhase(phase, deliveryPhase));
    const authoritativeBlockers = uniqueBlockers([
      ...phaseBlockers,
      ...(deliveryBlocked ? blockers.filter((blocker) => blocker.code === "DELIVERY_PHASE_NOT_COVERED") : []),
      ...globalBlockers,
    ]);
    const algorithmStatus = phase.algorithmStatus || phase.status || null;
    const blocked = algorithmStatus === "BLOCKED" || deliveryBlocked || authoritativeBlockers.length > 0;
    return {
      ...phase,
      algorithmStatus,
      status: blocked ? "BLOCKED" : "COVERED",
      authoritativeStatus: blocked ? "BLOCKED" : "READY",
      blockerCodes: [...new Set(authoritativeBlockers.map((blocker) => blocker.code).filter(Boolean))],
      authoritativeBlockerCount: authoritativeBlockers.length,
    };
  });
}

function mergeAuthoritativeRecommendationSummary(currentSummary, {
  recommendation,
  allocationBlockers = [],
  validationBlockers = [],
  readiness = {},
  allocationPhases = [],
  deliveryPhases = [],
  validatedAt = new Date().toISOString(),
} = {}) {
  const current = objectValue(currentSummary);
  const algorithmPhaseResults = Array.isArray(recommendation?.phaseResults) ? recommendation.phaseResults : [];
  const blockers = uniqueBlockers([...allocationBlockers, ...validationBlockers]);
  const phaseResults = buildAuthoritativePhaseResults({
    phaseResults: algorithmPhaseResults,
    blockers,
    allocationPhases,
    deliveryPhases,
  });
  const ready = Boolean(recommendation?.allocationReady ?? recommendation?.provisionalReady ?? recommendation?.ready)
    && Boolean(readiness?.ok);

  return {
    ...current,
    blockerCount: blockers.length,
    blockers,
    phaseResults,
    phaseCount: phaseResults.length,
    coveredPhaseCount: phaseResults.filter((phase) => phase.status === "COVERED").length,
    ready,
    provisionalReady: Boolean(recommendation?.allocationReady ?? recommendation?.provisionalReady ?? recommendation?.ready),
    authoritativeValidation: {
      status: ready ? "READY" : "BLOCKED",
      validatedAt,
      blockingCount: blockers.length,
      readinessBlockingCount: Number(readiness?.blockingCount || 0),
      warningCount: Number(readiness?.warningCount || 0),
      overridableCount: Number(readiness?.overridableCount || 0),
      infoCount: Number(readiness?.infoCount || 0),
      categories: objectValue(readiness?.categories),
      algorithmBlockerCount: uniqueBlockers(allocationBlockers).length,
      validationBlockerCount: uniqueBlockers(validationBlockers).length,
    },
  };
}

module.exports = {
  blockerKey,
  uniqueBlockers,
  buildAuthoritativePhaseResults,
  mergeAuthoritativeRecommendationSummary,
};
