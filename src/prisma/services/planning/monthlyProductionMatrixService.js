const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
};
const dateKey = (value) => String(value instanceof Date ? value.toISOString() : value || "").slice(0, 10);
const LOAD_SOURCES = new Set(["FIRM", "MANUAL", "RECOMMENDED", "PUBLISHED"]);
const { classifyCapacity } = require("./workingHourCalendarService");

function ensureDay(row, key) {
  if (!row.days[key]) row.days[key] = { qty: 0, minutes: 0, availableMinutes: 0, loadMinutes: 0, loadPercent: 0, capacityState: "NO_LOAD", uomCodes: [], planNumbers: [], fgRequiredDates: [], allocations: [], machines: [], itemCount: 0, blocker: null };
  return row.days[key];
}

function editorAllocation(item = {}, inputStockByPart = new Map()) {
  return {
    allocationId: item.allocationId || null,
    planNumber: item.planNumber || item.reference || null,
    lineNumber: item.lineNumber ?? null,
    mbomProcessId: item.mbomProcessId || null,
    machineId: item.machineId || null,
    vendorId: item.vendorId || null,
    routingMode: item.routingMode || null,
    shift: item.shift || null,
    plannedStartTime: item.plannedStartTime || null,
    plannedEndTime: item.plannedEndTime || null,
    minutes: round(item.minutes, 2),
    scheduleDate: dateKey(item.scheduleDate || item.sendDate),
    vendorSendDate: dateKey(item.sendDate),
    vendorReturnDate: dateKey(item.returnDate),
    qty: round(item.qty, 3),
    expectedReturnQty: item.expectedReturnQty == null ? null : round(item.expectedReturnQty, 3),
    uomCode: item.uomCode || "PCS",
    processCode: item.operationCode || item.processCode || null,
    partCode: item.partCode || null,
    latestFinishDate: dateKey(item.latestFinishDate || item.requiredDate || item.fgRequiredDate),
    fgRequiredDate: dateKey(item.fgRequiredDate),
    predecessorAllocationIds: item.predecessorAllocationIds || [],
    editable: Boolean(item.allocationId) && ["MANUAL", "RECOMMENDED"].includes(String(item.source || "").toUpperCase()),
    ...(inputStockByPart.get(item.partCode) || {}),
  };
}

function addEditorAllocation(day, item, inputStockByPart = new Map()) {
  if (!item?.allocationId) return;
  if (!day.allocations.some((row) => row.allocationId === item.allocationId)) day.allocations.push(editorAllocation(item, inputStockByPart));
}

function pushUnique(list, value) {
  if (value != null && value !== "" && !list.includes(value)) list.push(value);
}

function buildPlanningMetricsByPart(sources = []) {
  const metrics = new Map();
  for (const source of sources || []) {
    const sourceKey = source.id || source.partCode || source.mpsNumber || `SOURCE:${metrics.size}`;
    const components = source.components || [];
    const nodes = new Map(components.map((component) => [component.partCode, component]));
    if (source.partCode) nodes.set(source.partCode, {
      ...source,
      partCode: source.partCode,
      qtyPerFg: 1,
      uomCode: source.uomCode || "PCS",
      dependencies: [],
      processes: [{ processCode: "FG" }],
    });

    for (const component of components) {
      const partCode = component.partCode;
      if (!partCode) continue;
      const qtyPerFg = Math.max(number(component.qtyPerFg), 0);
      const current = metrics.get(partCode) || {
        currentStockQty: 0,
        stockOnHandQty: 0,
        stockReservedQty: 0,
        stockQcQty: 0,
        efdQty: 0,
        bufferQty: 0,
        shortageM1Qty: 0,
        totalRequirementQty: 0,
        uomCode: component.uomCode || "PCS",
        sourceFgKeys: new Set(),
        coverageByPart: new Map(),
      };
      // Workbench mengulang snapshot stock yang sama pada setiap FG parent.
      // Ambil nilai tertinggi agar inventory fisik tidak terhitung berulang.
      current.currentStockQty = Math.max(current.currentStockQty, number(component.availableStockQty));
      current.stockOnHandQty = Math.max(current.stockOnHandQty, number(component.currentStockQty));
      current.stockReservedQty = Math.max(current.stockReservedQty, number(component.stockReservedQty));
      current.stockQcQty = Math.max(current.stockQcQty, number(component.stockQcQty));
      current.efdQty += number(source.efdM) * qtyPerFg;
      current.bufferQty += number(source.bufferQty) * qtyPerFg;
      current.shortageM1Qty += number(source.shortageM1) * qtyPerFg;
      current.sourceFgKeys.add(sourceKey);

      // Untuk proses sebelumnya, stock pada WIP parent berarti proses tersebut
      // sudah selesai. Telusuri parent hingga FG dan konversi kembali ke
      // ekuivalen part target memakai qtyPerParent pada setiap level.
      const localCoverage = new Map();
      const visitCoverage = (nodeCode, multiplier, path = new Set()) => {
        if (!nodeCode || path.has(nodeCode)) return;
        const node = nodes.get(nodeCode);
        if (!node) return;
        const nextPath = new Set(path);
        nextPath.add(nodeCode);
        const availableStockQty = Math.max(number(node.availableStockQty), 0);
        if (availableStockQty > 0) {
          const kind = nodeCode === partCode ? "CURRENT" : nodeCode === source.partCode ? "FG" : "WIP";
          const existing = localCoverage.get(nodeCode) || {
            kind,
            partCode: nodeCode,
            processCode: kind === "FG" ? "FG" : (node.processes || []).map((process) => process.processCode).filter(Boolean).join(" · ") || null,
            availableStockQty,
            equivalentQty: 0,
          };
          existing.equivalentQty += availableStockQty * multiplier;
          localCoverage.set(nodeCode, existing);
        }
        for (const dependency of node.dependencies || []) {
          visitCoverage(
            dependency.parentPartCode,
            multiplier * Math.max(number(dependency.qtyPerParent), 0),
            nextPath,
          );
        }
      };
      visitCoverage(partCode, 1);
      for (const [coveragePartCode, coverage] of localCoverage) {
        const existing = current.coverageByPart.get(coveragePartCode);
        if (!existing || number(coverage.equivalentQty) > number(existing.equivalentQty)) {
          current.coverageByPart.set(coveragePartCode, coverage);
        }
      }
      metrics.set(partCode, current);
    }
  }
  return new Map([...metrics.entries()].map(([partCode, value]) => {
    const efdQty = round(value.efdQty, 6);
    const bufferQty = round(value.bufferQty, 6);
    const shortageM1Qty = round(value.shortageM1Qty, 6);
    const kindOrder = { CURRENT: 0, WIP: 1, FG: 2 };
    const stockCoverageSources = [...value.coverageByPart.values()]
      .map((source) => ({
        ...source,
        availableStockQty: round(source.availableStockQty, 6),
        equivalentQty: round(source.equivalentQty, 6),
      }))
      .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.partCode.localeCompare(right.partCode));
    const stockCoverageQty = round(stockCoverageSources.reduce((sum, source) => sum + number(source.equivalentQty), 0), 6);
    const wipCoverageQty = round(stockCoverageSources.filter((source) => source.kind === "WIP").reduce((sum, source) => sum + number(source.equivalentQty), 0), 6);
    const fgCoverageQty = round(stockCoverageSources.filter((source) => source.kind === "FG").reduce((sum, source) => sum + number(source.equivalentQty), 0), 6);
    return [partCode, {
      currentStockQty: round(value.currentStockQty, 6),
      stockOnHandQty: round(value.stockOnHandQty, 6),
      stockReservedQty: round(value.stockReservedQty, 6),
      stockQcQty: round(value.stockQcQty, 6),
      stockCoverageQty,
      wipCoverageQty,
      fgCoverageQty,
      stockCoverageSources,
      efdQty,
      bufferQty,
      shortageM1Qty,
      totalRequirementQty: round(efdQty + bufferQty + shortageM1Qty, 6),
      uomCode: value.uomCode || "PCS",
      sourceFgCount: value.sourceFgKeys.size,
    }];
  }));
}

function buildInputStockByPart(sources = [], partByCode = new Map()) {
  const result = new Map();
  for (const source of sources || []) {
    const components = source.components || [];
    const componentPart = (component = {}) => partByCode.get(component.partCode) || component;
    const sameProductIdentity = (left = {}, right = {}) => {
      const leftPart = componentPart(left);
      const rightPart = componentPart(right);
      const leftNumber = String(leftPart.partNumber || left.partNumber || "").trim().toUpperCase();
      const rightNumber = String(rightPart.partNumber || right.partNumber || "").trim().toUpperCase();
      return Boolean(leftNumber && rightNumber && leftNumber === rightNumber);
    };
    const sourceRow = (component, options = {}) => {
      const part = componentPart(component);
      const availableQty = Math.max(number(component.availableStockQty), 0);
      const reservedQty = Math.max(number(component.stockReservedQty), 0);
      const stockWhQty = component.currentStockQty == null
        ? availableQty + reservedQty
        : Math.max(number(component.currentStockQty), 0);
      const qtyPerParent = Math.max(number(options.qtyPerParent), 0.000001);
      return {
        partCode: component.partCode,
        partNumber: part.partNumber || component.partNumber || null,
        partName: part.partName || component.partName || null,
        itemType: part.itemType || part.partType || component.itemType || component.partType || null,
        sourceRole: options.sourceRole || "DIRECT_INPUT",
        requiredPartCode: options.requiredPartCode || component.partCode,
        inputGroupKey: options.inputGroupKey || options.requiredPartCode || component.partCode,
        stockWhQty: round(stockWhQty, 6),
        stockReservedQty: round(reservedQty, 6),
        availableQty: round(availableQty, 6),
        qtyPerParent: round(qtyPerParent, 6),
        equivalentOutputQty: round(availableQty / qtyPerParent, 6),
        uomCode: component.uomCode || part.uomCode || "PCS",
      };
    };
    for (const parent of components) {
      if (!parent.partCode) continue;
      const inputSources = [];
      const inputStockGroups = [];
      const directGroups = new Map();
      for (const child of components) {
        const links = (child.dependencies || []).filter((dependency) => dependency.parentPartCode === parent.partCode);
        for (const link of links) {
          const qtyPerParent = Math.max(number(link.qtyPerParent), 0);
          if (!child.partCode || qtyPerParent <= 0) continue;
          const current = directGroups.get(child.partCode) || { component: child, qtyPerParent: 0 };
          current.qtyPerParent += qtyPerParent;
          directGroups.set(child.partCode, current);
        }
      }
      for (const { component: directInput, qtyPerParent } of directGroups.values()) {
        const inputGroupKey = directInput.partCode;
        const groupSources = [sourceRow(directInput, {
          qtyPerParent,
          sourceRole: "DIRECT_INPUT",
          requiredPartCode: directInput.partCode,
          inputGroupKey,
        })];
        const directType = String(groupSources[0].itemType || "").toUpperCase();
        if (directType === "FG") {
          const previousWip = components.filter((candidate) => candidate.partCode
            && candidate.partCode !== directInput.partCode
            && String(componentPart(candidate).itemType || candidate.itemType || "").toUpperCase() === "WIP"
            && sameProductIdentity(candidate, directInput)
            && (candidate.dependencies || []).some((dependency) => dependency.parentPartCode === directInput.partCode));
          for (const previous of previousWip) {
            const dependencyQty = (previous.dependencies || [])
              .filter((dependency) => dependency.parentPartCode === directInput.partCode)
              .reduce((sum, dependency) => sum + Math.max(number(dependency.qtyPerParent), 0), 0);
            if (dependencyQty <= 0) continue;
            groupSources.push(sourceRow(previous, {
              qtyPerParent: qtyPerParent * dependencyQty,
              sourceRole: "PREVIOUS_WIP",
              requiredPartCode: directInput.partCode,
              inputGroupKey,
            }));
          }
        }
        inputSources.push(...groupSources);
        inputStockGroups.push({
          requiredPartCode: directInput.partCode,
          inputGroupKey,
          availableOutputQty: round(groupSources.reduce((sum, item) => sum + item.equivalentOutputQty, 0), 6),
        });
      }
      if (!inputSources.length) continue;
      const inputAvailableQty = Math.min(...inputStockGroups.map((item) => item.availableOutputQty));
      const current = result.get(parent.partCode);
      // The same physical inventory can repeat under multiple FG demand rows;
      // keep the highest snapshot instead of summing it.
      if (!current || inputAvailableQty > current.inputAvailableQty) {
        result.set(parent.partCode, {
          inputAvailableQty: round(inputAvailableQty, 6),
          inputStockSources: inputSources,
          inputStockGroups,
        });
      }
    }
  }
  return result;
}

function emptyChild(key, partCode, partName, processCode, type = "PART", part = {}, planning = null) {
  return {
    key,
    partCode,
    partNumber: part.partNumber || null,
    partName: partName || part.partName || null,
    itemType: part.itemType || part.partType || null,
    processCodes: processCode ? [processCode] : [],
    fgRequiredDates: [],
    planning: type === "PART" ? planning : null,
    type,
    days: {},
  };
}

function addDemandTrace(child, day, item = {}) {
  const fgRequiredDate = dateKey(
    item.fgRequiredDate
      || item.customerTargetDate
      || item.recommendationScoreBreakdown?.audit?.demandTrace?.fgRequiredDate,
  );
  pushUnique(child.fgRequiredDates, fgRequiredDate);
  pushUnique(day.fgRequiredDates, fgRequiredDate);
}

function buildMonthlyProductionMatrix(snapshot = {}, workCenters = [], partCatalog = [], fgRequirements = [], planningSources = []) {
  const dates = Array.isArray(snapshot.dates) ? snapshot.dates.map(dateKey).filter(Boolean) : [];
  const firstDate = dates[0] || null;
  const partByCode = new Map(partCatalog.map((part) => [part.partCode, part]));
  const planningByPart = buildPlanningMetricsByPart(planningSources);
  const inputStockByPart = buildInputStockByPart(planningSources, partByCode);
  const machineToCenter = new Map();

  for (const center of workCenters) {
    for (const link of center.machines || []) {
      const machine = link.machine || link;
      if (machine?.id) machineToCenter.set(machine.id, center);
    }
  }

  const rows = new Map();
  const unallocatedRequirements = [];
  const ensureCenter = ({ key, code, name, type = "INHOUSE", lineCode = null }) => {
    if (!rows.has(key)) rows.set(key, { key, workCenterCode: code, workCenterName: name || code, type, lineCode, machineCodes: [], children: new Map(), fgRequirements: new Map(), days: {}, blockerCount: 0, peakLoadPercent: 0, capacityState: "NO_LOAD" });
    return rows.get(key);
  };

  const ensureMachineCenter = (machine = {}) => {
    const center = machineToCenter.get(machine.id);
    if (center) return ensureCenter({ key: `WC:${center.id}`, code: center.workCenterCode, name: center.workCenterName, type: "INHOUSE", lineCode: center.lineCode || machine.lineCode || null });
    const fallbackCode = machine.lineCode || machine.machineSpecificationCode || machine.machineFamily || machine.machineCode || "UNASSIGNED";
    return ensureCenter({ key: `MACHINE:${fallbackCode}`, code: fallbackCode, name: machine.lineCode ? `Line ${machine.lineCode}` : (machine.machineSpecificationName || machine.machineFamily || machine.machineName || machine.machineCode || "Mesin belum dikelompokkan"), type: "INHOUSE", lineCode: machine.lineCode || null });
  };

  for (const machine of snapshot.machines || []) {
    const center = ensureMachineCenter(machine);
    pushUnique(center.machineCodes, machine.machineCode);
    for (const key of dates) {
      const sourceCell = machine.cells?.[key] || {};
      const day = ensureDay(center, key);
      const proposedItems = (sourceCell.items || []).filter((item) => String(item.source || "").toUpperCase() === "PROPOSED" && !item.allocationId);
      for (const item of proposedItems) {
        unallocatedRequirements.push({
          planNumber: item.planNumber || item.reference || null,
          ...(item.lineNumber == null ? {} : { lineNumber: item.lineNumber }),
          partCode: item.partCode || null,
          processCode: item.operationCode || item.processCode || null,
          machineCode: machine.machineCode || null,
          suggestedDate: key,
          qty: round(item.qty, 3),
          uomCode: item.uomCode || "PCS",
          minutes: round(item.minutes, 2),
          reason: "Belum menjadi allocation tersimpan",
        });
      }
      day.availableMinutes += number(sourceCell.availableMinutes);
      const authoritativeLoadMinutes = Math.max(number(sourceCell.loadMinutes) - proposedItems.reduce((sum, item) => sum + number(item.minutes), 0), 0);
      day.loadMinutes += authoritativeLoadMinutes;
      day.machines.push({ id: machine.id, machineCode: machine.machineCode, machineName: machine.machineName || machine.machineCode, availableMinutes: round(sourceCell.availableMinutes, 2), loadMinutes: round(authoritativeLoadMinutes, 2), active: number(sourceCell.availableMinutes) > 0 });
      const loadItems = (sourceCell.items || []).filter((item) => LOAD_SOURCES.has(String(item.source || "").toUpperCase()));
      for (const item of loadItems) {
        const partCode = item.partCode || "PART-BELUM-DITENTUKAN";
        const part = partByCode.get(partCode);
        const childKey = `PART:${partCode}`;
        const operationCode = item.operationCode || item.processCode;
        if (!center.children.has(childKey)) center.children.set(childKey, emptyChild(childKey, partCode, part?.partName, operationCode, "PART", part, planningByPart.get(partCode) || null));
        const child = center.children.get(childKey);
        pushUnique(child.processCodes, operationCode);
        const childDay = ensureDay(child, key);
        childDay.qty += number(item.qty);
        childDay.minutes += number(item.minutes);
        childDay.itemCount += 1;
        pushUnique(childDay.uomCodes, item.uomCode || "PCS");
        pushUnique(childDay.planNumbers, item.planNumber || item.reference);
        addDemandTrace(child, childDay, item);
        addEditorAllocation(childDay, item, inputStockByPart);
        day.qty += number(item.qty);
        day.minutes += number(item.minutes);
        day.itemCount += 1;
        pushUnique(day.uomCodes, item.uomCode || "PCS");
        pushUnique(day.planNumbers, item.planNumber || item.reference);
        addEditorAllocation(day, item, inputStockByPart);
      }
    }
  }

  const vendorById = new Map((snapshot.catalogs?.vendors || []).map((vendor) => [vendor.id, vendor]));
  const requirementsByPlan = new Map();
  for (const requirement of fgRequirements) {
    if (!requirement?.planNumber) continue;
    if (!requirementsByPlan.has(requirement.planNumber)) requirementsByPlan.set(requirement.planNumber, []);
    requirementsByPlan.get(requirement.planNumber).push(requirement);
  }
  for (const item of snapshot.vendorAssignments || []) {
    const key = dateKey(item.sendDate || item.scheduleDate);
    const isVisibleMonth = dates.includes(key);
    if (String(item.source || "").toUpperCase() === "PROPOSED" && !item.allocationId) {
      unallocatedRequirements.push({
        planNumber: item.planNumber || item.reference || null,
        ...(item.lineNumber == null ? {} : { lineNumber: item.lineNumber }),
        ...(item.mbomProcessId ? { mbomProcessId: item.mbomProcessId } : {}),
        partCode: item.partCode || null,
        processCode: item.operationCode || item.processCode || null,
        routingMode: "VENDOR",
        ...(item.vendorId ? { vendorId: item.vendorId } : {}),
        suggestedDate: key,
        qty: round(item.qty, 3),
        uomCode: item.uomCode || "PCS",
        minutes: round(item.minutes, 2),
        ...(isVisibleMonth ? {} : {
          crossMonth: true,
          timingScope: key && firstDate && key < firstDate ? "PREVIOUS_MONTH" : "NEXT_MONTH",
        }),
        reason: isVisibleMonth
          ? "Belum menjadi allocation tersimpan"
          : "Kebutuhan lintas bulan belum menjadi allocation tersimpan",
      });
      continue;
    }
    if (!isVisibleMonth) continue;
    const vendor = vendorById.get(item.vendorId);
    const code = vendor?.vendorCode || item.processCode || "VENDOR";
    const center = ensureCenter({ key: `VENDOR:${item.vendorId || code}`, code: `VENDOR · ${code}`, name: vendor?.vendorName || item.processName || "Vendor process", type: "OUTSOURCE" });
    const partCode = item.partCode || "PART-BELUM-DITENTUKAN";
    const part = partByCode.get(partCode);
    const operationCode = item.operationCode || item.processCode;
    const childKey = `PART:${partCode}:${operationCode || "VENDOR"}`;
    if (!center.children.has(childKey)) center.children.set(childKey, emptyChild(childKey, partCode, part?.partName, operationCode, "PART", part, planningByPart.get(partCode) || null));
    const child = center.children.get(childKey);
    pushUnique(child.processCodes, operationCode);
    const childDay = ensureDay(child, key);
    childDay.qty += number(item.qty);
    childDay.itemCount += 1;
    pushUnique(childDay.uomCodes, item.uomCode || "PCS");
    pushUnique(childDay.planNumbers, item.planNumber);
    addDemandTrace(child, childDay, item);
    addEditorAllocation(childDay, item, inputStockByPart);
    const day = ensureDay(center, key);
    day.qty += number(item.qty);
    day.itemCount += 1;
    pushUnique(day.uomCodes, item.uomCode || "PCS");
    pushUnique(day.planNumbers, item.planNumber);
    addEditorAllocation(day, item, inputStockByPart);

    const requiredDate = dateKey(
      item.fgRequiredDate
        || item.customerTargetDate
        || item.recommendationScoreBreakdown?.audit?.demandTrace?.fgRequiredDate,
    );
    const planRequirements = requirementsByPlan.get(item.planNumber) || [];
    const exactPhaseRequirements = item.deliveryPhaseId
      ? planRequirements.filter((requirement) => requirement.deliveryPhaseId === item.deliveryPhaseId)
      : [];
    const matchingRequirements = exactPhaseRequirements.length
      ? exactPhaseRequirements
      : planRequirements.filter((requirement) => dateKey(requirement.fgRequiredDate) === requiredDate
        && (!item.deliveryPhaseId || !requirement.deliveryPhaseId));
    for (const requirement of matchingRequirements) {
      const fgDate = dateKey(requirement.fgRequiredDate);
      const requirementPart = partByCode.get(requirement.partCode) || {};
      const requirementKey = [item.processCode || "VENDOR", requirement.deliveryPhaseId || "BUFFER", fgDate, requirement.partCode].join(":");
      if (center.fgRequirements.has(requirementKey)) continue;
      center.fgRequirements.set(requirementKey, {
        key: requirementKey,
        processCode: item.processCode || "VENDOR",
        processName: item.processName || item.processCode || "Vendor process",
        planNumber: requirement.planNumber,
        deliveryPhaseId: requirement.deliveryPhaseId || null,
        partCode: requirement.partCode,
        partNumber: requirementPart.partNumber || null,
        partName: requirementPart.partName || null,
        itemType: requirementPart.itemType || requirementPart.partType || "FG",
        qty: round(requirement.qty, 3),
        uomCode: requirement.uomCode || "PCS",
        fgRequiredDate: fgDate,
      });
    }
  }

  // A route can be entirely unallocated, so it will not exist in either the
  // authoritative machine cells or vendor assignments above. Seed only the
  // row identity from the canonical remaining catalog. Its dated cells stay
  // empty until PPIC explicitly allocates the quantity in Editor Mode.
  for (const candidate of snapshot.manualAllocationCatalog || []) {
    if (number(candidate.remainingQty) <= 0 || !candidate.partCode) continue;
    const routingMode = String(candidate.routingMode || "INHOUSE").toUpperCase();
    const operationCode = candidate.processCode || candidate.baseProcessCode || "PROCESS";
    const part = partByCode.get(candidate.partCode);
    let center;
    let childKey;

    if (routingMode === "VENDOR") {
      const vendor = vendorById.get(candidate.vendorId);
      const code = vendor?.vendorCode || operationCode || "VENDOR";
      center = ensureCenter({
        key: `VENDOR:${candidate.vendorId || code}`,
        code: `VENDOR · ${code}`,
        name: vendor?.vendorName || candidate.processName || "Vendor process",
        type: "OUTSOURCE",
      });
      childKey = `PART:${candidate.partCode}:${operationCode || "VENDOR"}`;
    } else {
      const eligibleMachine = (candidate.allowedMachineIds || [])
        .map((machineId) => (snapshot.machines || []).find((machine) => machine.id === machineId))
        .find(Boolean);
      center = eligibleMachine
        ? ensureMachineCenter(eligibleMachine)
        : ensureCenter({
          key: `UNALLOCATED:${operationCode}`,
          code: `UNALLOCATED · ${operationCode}`,
          name: "Remaining allocation belum memiliki mesin",
          type: "BLOCKER",
        });
      if (eligibleMachine) pushUnique(center.machineCodes, eligibleMachine.machineCode);
      childKey = `PART:${candidate.partCode}`;
    }

    if (!center.children.has(childKey)) {
      center.children.set(childKey, emptyChild(
        childKey,
        candidate.partCode,
        part?.partName,
        operationCode,
        "PART",
        part,
        planningByPart.get(candidate.partCode) || null,
      ));
    }
    pushUnique(center.children.get(childKey).processCodes, operationCode);
  }

  for (const row of rows.values()) {
    for (const key of dates) {
      const day = ensureDay(row, key);
      day.qty = round(day.qty, 3);
      day.minutes = round(day.minutes, 2);
      day.availableMinutes = round(day.availableMinutes, 2);
      day.loadMinutes = round(day.loadMinutes, 2);
      day.loadPercent = day.availableMinutes > 0 ? round(day.loadMinutes / day.availableMinutes * 100, 1) : (day.loadMinutes > 0 ? 999 : 0);
      day.capacityState = row.type === "OUTSOURCE"
        ? (day.allocations.some((allocation) => allocation.vendorReturnDate && allocation.latestFinishDate && allocation.vendorReturnDate > allocation.latestFinishDate) ? "LATE" : (day.allocations.length ? "ON_TIME" : "NO_LOAD"))
        : classifyCapacity(day.loadMinutes, day.availableMinutes);
      row.peakLoadPercent = Math.max(row.peakLoadPercent, day.loadPercent);
      if (day.loadPercent > 100) row.blockerCount += 1;
    }
    for (const child of row.children.values()) {
      for (const key of dates) {
        const day = ensureDay(child, key);
        day.qty = round(day.qty, 3);
        day.minutes = round(day.minutes, 2);
      }
    }
    const states = dates.map((key) => row.days[key]?.capacityState);
    row.capacityState = states.includes("OVERLOAD") || states.includes("LATE") ? (row.type === "OUTSOURCE" ? "LATE" : "OVERLOAD")
      : states.includes("WARNING") ? "WARNING"
        : states.includes("NO_CALENDAR") ? "NO_CALENDAR"
          : states.includes("OK") || states.includes("ON_TIME") ? (row.type === "OUTSOURCE" ? "ON_TIME" : "OK") : "NO_LOAD";
  }

  if (firstDate) {
    for (const row of rows.values()) {
      const overloaded = dates.map((key) => row.days[key]).filter((day) => day.loadPercent > 100);
      if (!overloaded.length) continue;
      const totalExcess = overloaded.reduce((sum, day) => sum + Math.max(day.loadMinutes - day.availableMinutes, 0), 0);
      const peakPercent = Math.max(...overloaded.map((day) => day.loadPercent));
      row.days[firstDate].blocker = { count: overloaded.length, peakPercent: round(peakPercent, 1), excessMinutes: round(totalExcess, 2) };
      const blockerKey = "CAPACITY_BLOCKER";
      const blocker = emptyChild(blockerKey, "CAPACITY BLOCKER", `${overloaded.length} hari overload harus dialokasikan manual`, null, "BLOCKER");
      ensureDay(blocker, firstDate).blocker = row.days[firstDate].blocker;
      row.children.set(blockerKey, blocker);
    }

    for (const item of snapshot.unscheduled || []) {
      const machine = (snapshot.machines || []).find((candidate) => candidate.machineCode === item.machineCode);
      const center = machine
        ? ensureMachineCenter(machine)
        : ensureCenter({ key: `UNALLOCATED:${item.processCode || "GENERAL"}`, code: `UNALLOCATED · ${item.processCode || "GENERAL"}`, name: "Capacity blocker belum memiliki slot", type: "BLOCKER" });
      const blockerKey = `UNSCHEDULED:${item.partCode || item.reference || center.children.size}`;
      if (!center.children.has(blockerKey)) center.children.set(blockerKey, emptyChild(blockerKey, item.partCode || "UNSCHEDULED", item.reason || "Belum terjadwal", item.processCode, "BLOCKER"));
      const childDay = ensureDay(center.children.get(blockerKey), firstDate);
      childDay.qty += number(item.qty);
      childDay.minutes += number(item.minutes);
      childDay.itemCount += 1;
      pushUnique(childDay.uomCodes, item.uomCode || "PCS");
      pushUnique(childDay.planNumbers, item.planNumber || item.reference);
      const day = ensureDay(center, firstDate);
      day.qty += number(item.qty);
      day.minutes += number(item.minutes);
      day.itemCount += 1;
      pushUnique(day.uomCodes, item.uomCode || "PCS");
      pushUnique(day.planNumbers, item.planNumber || item.reference);
      center.blockerCount += 1;
    }

    for (const row of rows.values()) {
      const entryDay = ensureDay(row, firstDate);
      if (row.blockerCount <= 0 || entryDay.blocker) continue;
      const queuedMinutes = [...row.children.values()]
        .filter((child) => child.type === "BLOCKER")
        .reduce((sum, child) => sum + number(child.days[firstDate]?.minutes), 0);
      const referenceAvailableMinutes = dates.map((key) => number(row.days[key]?.availableMinutes)).find((value) => value > 0) || 0;
      const queuePercent = referenceAvailableMinutes > 0 ? queuedMinutes / referenceAvailableMinutes * 100 : (queuedMinutes > 0 ? 999 : 0);
      entryDay.qty = round(entryDay.qty, 3);
      entryDay.minutes = round(entryDay.minutes, 2);
      entryDay.blocker = {
        count: row.blockerCount,
        peakPercent: round(queuePercent, 1),
        excessMinutes: round(Math.max(queuedMinutes - referenceAvailableMinutes, 0), 2),
        queuedMinutes: round(queuedMinutes, 2),
      };
    }
  }

  const resultRows = [...rows.values()].map((row) => ({
    ...row,
    children: [...row.children.values()].map((child) => ({
      ...child,
      monthlyProductionQty: round(dates.reduce((sum, key) => sum + number(child.days[key]?.qty), 0), 3),
    })).sort((left, right) => (left.type === "BLOCKER" ? -1 : right.type === "BLOCKER" ? 1 : left.partCode.localeCompare(right.partCode))),
    fgRequirements: [...row.fgRequirements.values()].sort((left, right) => left.processCode.localeCompare(right.processCode) || left.fgRequiredDate.localeCompare(right.fgRequiredDate) || left.partCode.localeCompare(right.partCode)),
  })).filter((row) => row.children.length || Object.values(row.days).some((day) => day.loadMinutes > 0))
    .sort((left, right) => (left.blockerCount > 0 ? -1 : 1) - (right.blockerCount > 0 ? -1 : 1) || left.type.localeCompare(right.type) || left.workCenterCode.localeCompare(right.workCenterCode));

  const resultFgRequirements = fgRequirements.map((requirement, index) => {
    const part = partByCode.get(requirement.partCode) || {};
    return {
      key: [requirement.planNumber || "PLAN", requirement.deliveryPhaseId || "BUFFER", dateKey(requirement.fgRequiredDate), requirement.partCode || index].join(":"),
      planNumber: requirement.planNumber || null,
      deliveryPhaseId: requirement.deliveryPhaseId || null,
      partCode: requirement.partCode,
      partNumber: part.partNumber || null,
      partName: part.partName || null,
      itemType: part.itemType || part.partType || "FG",
      qty: round(requirement.qty, 3),
      uomCode: requirement.uomCode || "PCS",
      fgRequiredDate: dateKey(requirement.fgRequiredDate),
    };
  }).filter((requirement) => requirement.partCode && requirement.fgRequiredDate)
    .sort((left, right) => left.fgRequiredDate.localeCompare(right.fgRequiredDate) || left.partCode.localeCompare(right.partCode));

  const overloadedCells = resultRows.reduce((sum, row) => sum + dates.filter((key) => number(row.days[key]?.loadPercent) > 100).length, 0);
  const crossMonthRequirements = unallocatedRequirements.filter((item) => item.crossMonth);
  return {
    dates,
    rows: resultRows,
    fgRequirements: resultFgRequirements,
    remainingAllocations: Array.isArray(snapshot.manualAllocationCatalog) ? snapshot.manualAllocationCatalog.map((candidate) => ({
      ...candidate,
      ...(inputStockByPart.get(candidate.partCode) || {}),
    })) : [],
    unallocatedRequirements: unallocatedRequirements.sort((left, right) => left.suggestedDate.localeCompare(right.suggestedDate) || String(left.machineCode).localeCompare(String(right.machineCode)) || String(left.partCode).localeCompare(String(right.partCode))),
    summary: {
      workCenterCount: resultRows.length,
      partCount: resultRows.reduce((sum, row) => sum + row.children.filter((child) => child.type === "PART").length, 0),
      planCount: new Set([...resultRows.flatMap((row) => Object.values(row.days).flatMap((day) => day.planNumbers)), ...unallocatedRequirements.map((item) => item.planNumber)].filter(Boolean)).size,
      blockerCount: resultRows.reduce((sum, row) => sum + row.blockerCount, 0),
      unallocatedCount: unallocatedRequirements.length,
      unallocatedQty: round(unallocatedRequirements.reduce((sum, item) => sum + number(item.qty), 0), 3),
      unallocatedMinutes: round(unallocatedRequirements.reduce((sum, item) => sum + number(item.minutes), 0), 2),
      crossMonthCount: crossMonthRequirements.length,
      crossMonthQty: round(crossMonthRequirements.reduce((sum, item) => sum + number(item.qty), 0), 3),
      overloadedCells,
      attentionCount: overloadedCells + unallocatedRequirements.length,
      totalPlannedQty: round(resultRows.reduce((sum, row) => sum + Object.values(row.days).reduce((daySum, day) => daySum + number(day.qty), 0), 0), 3),
    },
  };
}

module.exports = { buildMonthlyProductionMatrix };
