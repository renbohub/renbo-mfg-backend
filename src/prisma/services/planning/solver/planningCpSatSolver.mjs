import { CpModel, CpSolver, Domain, LinearExpr } from "or-tools-wasm/cp-sat";

const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;

function solveOptions(options = {}) {
  return {
    maxTimeInSeconds: Math.max(Number(options.maxTimeInSeconds || 30), 1),
    numSearchWorkers: Math.max(integer(options.numSearchWorkers, 2), 1),
    randomSeed: Math.max(integer(options.randomSeed, 1), 1),
    logSearchProgress: Boolean(options.logSearchProgress),
  };
}

export async function solveBackwardChain(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (!tasks.length) throw new Error("Backward chain membutuhkan minimal satu task.");
  const horizon = Math.max(integer(input.horizonMinutes), 1);
  const target = Math.min(Math.max(integer(input.targetMinute, horizon), 0), horizon);
  const model = new CpModel();
  const variables = tasks.map((task, index) => {
    const duration = Math.max(integer(task.durationMinutes), 0);
    const allowedStarts = (task.allowedStartMinutes || []).map((value) => integer(value)).filter((value) => value >= 0 && value + duration <= horizon);
    const start = allowedStarts.length
      ? model.newIntVarFromDomain(Domain.fromValues(allowedStarts), `start_${index}_${task.id}`)
      : model.newIntVar(0, horizon, `start_${index}_${task.id}`);
    const end = model.newIntVar(0, horizon, `end_${index}_${task.id}`);
    model.addEquality(end, start.plus(duration));
    return { task, duration, start, end };
  });
  for (let index = 1; index < variables.length; index += 1) {
    model.add(variables[index].start.ge(variables[index - 1].end));
  }
  model.add(variables[variables.length - 1].end.le(target));
  model.maximize(variables[0].start);
  const solver = new CpSolver();
  Object.assign(solver.parameters, solveOptions(input.options));
  const status = await solver.solve(model);
  const statusName = solver.statusName(status);
  if (!["OPTIMAL", "FEASIBLE"].includes(statusName)) {
    return { status: statusName, feasible: false, tasks: [], diagnostics: solver.responseStats() };
  }
  return {
    status: statusName,
    feasible: true,
    objectiveValue: solver.objectiveValue(),
    bestObjectiveBound: solver.bestObjectiveBound(),
    wallTimeSeconds: solver.wallTime,
    tasks: variables.map(({ task, start, end, duration }) => ({
      ...task,
      durationMinutes: duration,
      startMinute: Number(solver.value(start)),
      endMinute: Number(solver.value(end)),
    })),
  };
}

export async function solveFiniteSchedule(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (!tasks.length) return { status: "OPTIMAL", feasible: true, tasks: [], resourceSchedules: {}, objectiveValue: 0 };
  const horizon = Math.max(integer(input.horizonMinutes), 1);
  const model = new CpModel();
  const resources = new Map();
  const byId = new Map();
  const unscheduledPenalties = [];
  const tardinessTerms = [];
  const movementTerms = [];
  const assignmentMovementTerms = [];
  const completionTerms = [];
  const backwardTerms = [];

  for (const [index, task] of tasks.entries()) {
    const id = String(task.id || `TASK-${index + 1}`);
    if (byId.has(id)) throw new Error(`Task solver duplikat: ${id}`);
    const duration = Math.max(integer(task.durationMinutes), 1);
    const release = Math.min(Math.max(integer(task.releaseMinute), 0), horizon);
    const due = Math.min(Math.max(integer(task.dueMinute, horizon), 0), horizon);
    const start = model.newIntVar(release, horizon, `start_${index}`);
    const end = model.newIntVar(release, horizon, `end_${index}`);
    model.addEquality(end, start.plus(duration));
    const present = model.newBoolVar(`present_${index}`);
    const eligible = [...new Set((task.eligibleResourceIds || [task.resourceId]).filter(Boolean).map(String))];
    const assignments = [];
    for (const resourceId of eligible) {
      const selected = model.newBoolVar(`resource_${index}_${assignments.length}`);
      const interval = model.newOptionalIntervalVar(start, duration, end, selected, `interval_${index}_${assignments.length}`);
      assignments.push({ resourceId, selected, interval });
      const resourceIntervals = resources.get(resourceId) || [];
      resourceIntervals.push(interval);
      resources.set(resourceId, resourceIntervals);
      if (task.preferredResourceId && String(task.preferredResourceId) !== resourceId) {
        assignmentMovementTerms.push(selected.times(Math.max(integer(task.resourceMovementWeight, 10), 1)));
      }
    }
    for (const resourceId of [...new Set((task.requiredResourceIds || []).filter(Boolean).map(String))]) {
      const interval = model.newOptionalIntervalVar(start, duration, end, present, `required_resource_${index}_${resourceId}`);
      const resourceIntervals = resources.get(resourceId) || [];
      resourceIntervals.push(interval);
      resources.set(resourceId, resourceIntervals);
    }
    if (assignments.length) model.addEquality(LinearExpr.sum(assignments.map((row) => row.selected)), present);
    else model.addEquality(present, 0);
    if (task.required !== false) model.addEquality(present, 1);
    if (task.fixedStartMinute != null) {
      model.addEquality(present, 1);
      model.addEquality(start, Math.min(Math.max(integer(task.fixedStartMinute), release), horizon));
    }
    const late = model.newIntVar(0, horizon, `late_${index}`);
    model.add(late.ge(end.minus(due))).onlyEnforceIf(present);
    model.addEquality(late, 0).onlyEnforceIf(present.not());
    const unscheduled = model.newIntVar(0, 1, `unscheduled_${index}`);
    model.addEquality(unscheduled, present.not());
    unscheduledPenalties.push(unscheduled.times(Math.max(integer(task.unscheduledPenalty, 1000000), 1)));
    tardinessTerms.push(late.times(Math.max(integer(task.tardinessWeight, 1000), 1)));
    if (task.minimizeCompletion) completionTerms.push(end.times(Math.max(integer(task.completionWeight, 1), 1)));
    if (String(input.scheduleDirection || "").toUpperCase() === "BACKWARD") {
      backwardTerms.push(start.times(-Math.max(integer(task.backwardWeight, 1), 1)));
    }
    if (task.baselineStartMinute != null) {
      const movement = model.newIntVar(0, horizon, `movement_${index}`);
      model.addAbsEquality(movement, start.minus(integer(task.baselineStartMinute)));
      movementTerms.push(movement.times(Math.max(integer(task.movementWeight, 1), 1)));
    }
    byId.set(id, { id, index, task, duration, release, due, start, end, present, assignments, late });
  }

  for (const block of input.resourceBlockedIntervals || []) {
    const resourceId = String(block.resourceId || "");
    const start = Math.max(integer(block.startMinute), 0);
    const duration = Math.max(integer(block.durationMinutes), 0);
    if (!resourceId || !duration || start >= horizon) continue;
    const interval = model.newFixedSizeIntervalVar(Math.min(start, horizon), Math.min(duration, horizon - start), `blocked_${resourceId}_${start}`);
    const resourceIntervals = resources.get(resourceId) || [];
    resourceIntervals.push(interval);
    resources.set(resourceId, resourceIntervals);
  }
  for (const resourceIntervals of resources.values()) model.addNoOverlap(resourceIntervals);
  const assignmentGroups = new Map();
  for (const row of byId.values()) {
    if (!row.task.assignmentGroupId) continue;
    const grouped = assignmentGroups.get(String(row.task.assignmentGroupId)) || [];
    grouped.push(row);
    assignmentGroups.set(String(row.task.assignmentGroupId), grouped);
  }
  for (const grouped of assignmentGroups.values()) {
    const reference = grouped[0];
    for (const row of grouped.slice(1)) {
      for (const candidate of reference.assignments) {
        const matching = row.assignments.find((item) => item.resourceId === candidate.resourceId);
        if (matching) model.addEquality(candidate.selected, matching.selected);
      }
    }
  }
  for (const row of byId.values()) {
    for (const predecessorId of row.task.predecessorIds || []) {
      const predecessor = byId.get(String(predecessorId));
      if (!predecessor) throw new Error(`Predecessor ${predecessorId} untuk ${row.id} tidak ditemukan.`);
      model.addImplication(row.present, predecessor.present);
      model.add(row.start.ge(predecessor.end.plus(Math.max(integer(row.task.predecessorGapMinutes), 0)))).onlyEnforceIf(row.present);
    }
  }
  const objectiveTerms = [...unscheduledPenalties, ...tardinessTerms, ...movementTerms, ...assignmentMovementTerms, ...completionTerms, ...backwardTerms];
  model.minimize(objectiveTerms.length ? LinearExpr.sum(objectiveTerms) : 0);
  const solver = new CpSolver();
  Object.assign(solver.parameters, solveOptions(input.options));
  const status = await solver.solve(model);
  const statusName = solver.statusName(status);
  if (!["OPTIMAL", "FEASIBLE"].includes(statusName)) {
    return { status: statusName, feasible: false, tasks: [], resourceSchedules: {}, diagnostics: solver.responseStats() };
  }
  const resultTasks = [...byId.values()].map((row) => {
    const present = Boolean(solver.booleanValue(row.present));
    const assignment = present ? row.assignments.find((candidate) => solver.booleanValue(candidate.selected)) : null;
    return {
      ...row.task,
      id: row.id,
      scheduled: present,
      resourceId: assignment?.resourceId || null,
      startMinute: present ? Number(solver.value(row.start)) : null,
      endMinute: present ? Number(solver.value(row.end)) : null,
      tardinessMinutes: present ? Number(solver.value(row.late)) : null,
    };
  });
  const resourceSchedules = {};
  for (const task of resultTasks.filter((row) => row.scheduled && row.resourceId)) {
    (resourceSchedules[task.resourceId] ||= []).push(task);
  }
  for (const rows of Object.values(resourceSchedules)) rows.sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
  return {
    status: statusName,
    feasible: true,
    objectiveValue: solver.objectiveValue(),
    bestObjectiveBound: solver.bestObjectiveBound(),
    wallTimeSeconds: solver.wallTime,
    tasks: resultTasks,
    resourceSchedules,
  };
}
