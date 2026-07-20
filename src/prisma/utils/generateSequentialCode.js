const extractSequentialNumber = (code, prefix = "") => {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();

  const prefixedPattern = normalizedPrefix
    ? new RegExp(`^${normalizedPrefix}(\\d+)$`)
    : null;
  const prefixedMatch = prefixedPattern ? normalizedCode.match(prefixedPattern) : null;
  const numericMatch = normalizedCode.match(/^\d+$/);
  const value = prefixedMatch?.[1] || numericMatch?.[0];

  if (!value) return null;

  const number = Number.parseInt(value, 10);
  return Number.isNaN(number) ? null : number;
};

const generateSequentialCode = (codes, prefix = "", width = 3) => {
  const existingNumbers = codes
    .map((code) => extractSequentialNumber(code, prefix))
    .filter((num) => num !== null)
    .sort((a, b) => a - b);

  let nextNumber = 1;
  for (const num of existingNumbers) {
    if (num === nextNumber) {
      nextNumber++;
    } else if (num > nextNumber) {
      break;
    }
  }

  return `${prefix}${String(nextNumber).padStart(width, "0")}`;
};

module.exports = {
  generateSequentialCode,
};
