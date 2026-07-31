const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const ROOT = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".ejs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".prisma",
  ".sql",
  ".ts",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "backups",
  "coverage",
  "dist",
  "node_modules",
  "uploads",
]);
const MOJIBAKE_PATTERNS = [
  { label: "replacement character", regex: /\uFFFD/u },
  {
    label: "UTF-8 decoded as Windows-1252",
    regex: /(?:\u00C3.|\u00C2.|\u00E2(?:\u20AC|\u2020|\u2021|\u02C6|\u2030|\u0160|\u2039|\u0152|\u017D|\u2018|\u2019|\u201C|\u201D|\u2022|\u2013|\u2014|\u02DC|\u2122|\u0161|\u203A|\u0153|\u017E|\u0178)|\u00F0\u0178|\u00EF\u00BF\u00BD)/u,
  },
];

const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];
let scanned = 0;

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanFile(filePath) {
  const relativePath = path.relative(ROOT, filePath);
  const buffer = fs.readFileSync(filePath);
  let text;

  try {
    text = decoder.decode(buffer);
  } catch (error) {
    failures.push(`${relativePath}: invalid UTF-8 (${error.message})`);
    return;
  }

  scanned += 1;
  for (const pattern of MOJIBAKE_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match) {
      failures.push(
        `${relativePath}:${lineNumber(text, match.index)}: ${pattern.label}: ${JSON.stringify(match[0])}`
      );
    }
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      scanFile(target);
    }
  }
}

walk(ROOT);

if (failures.length) {
  console.error(`Encoding check failed with ${failures.length} issue(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Encoding check passed: ${scanned} UTF-8 text files, no mojibake patterns.`);
