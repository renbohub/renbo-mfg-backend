const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function routingNumberValue(value) {
  const parts = routingNumberParts(value);
  return parts?.[0] ?? null;
}

function routingNumberParts(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const matches = text.match(/\d+/g);
  if (!matches?.length) return null;
  return matches.map(Number);
}

function compareRoutingNumbers(left, right) {
  const leftParts = routingNumberParts(left);
  const rightParts = routingNumberParts(right);
  if (!leftParts && !rightParts) return 0;
  if (!leftParts) return 1;
  if (!rightParts) return -1;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? -1;
    const rightValue = rightParts[index] ?? -1;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function routeLevel(route) {
  return number(route?.levelComponent ?? route?.mbomDetail?.levelComponent);
}

function compareRoutingOperations(left, right) {
  const routingDifference = compareRoutingNumbers(
    left?.routingNumber ?? left?.process?.routingNumber,
    right?.routingNumber ?? right?.process?.routingNumber,
  );
  if (routingDifference) return routingDifference;

  const levelDifference = routeLevel(left) - routeLevel(right);
  if (levelDifference) return levelDifference;

  const sequenceDifference = number(left?.sourceSequence ?? left?.sequence) -
    number(right?.sourceSequence ?? right?.sequence);
  if (sequenceDifference) return sequenceDifference;

  return String(left?.id ?? left?.process?.id ?? "").localeCompare(
    String(right?.id ?? right?.process?.id ?? ""),
  );
}

function canonicalizeRoutingOperations(routes = [], step = 10) {
  return [...routes]
    .sort(compareRoutingOperations)
    .map((route, index) => ({
      ...route,
      sourceSequence: number(route?.sourceSequence ?? route?.sequence),
      sequence: (index + 1) * step,
    }));
}

module.exports = {
  routingNumberValue,
  routingNumberParts,
  compareRoutingNumbers,
  compareRoutingOperations,
  canonicalizeRoutingOperations,
};
