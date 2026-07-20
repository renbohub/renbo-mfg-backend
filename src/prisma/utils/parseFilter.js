const parseFilter = (value, options = {}) => {
  const {
    separator = ",",
    transform = item => item,
  } = options;

  if (value === undefined || value === null || value === "") {
    return null;
  }

  const items = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(separator))
    .map(item => item.trim())
    .filter(Boolean)
    .map(transform)
    .filter(item => item !== undefined && item !== null && item !== "");

  if (items.length === 0) {
    return null;
  }

  return items.length === 1 ? items[0] : { in: items };
};

module.exports = { parseFilter };
