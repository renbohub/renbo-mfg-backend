const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const PROTECTED_FILES = [
  "server.js",
  "src/prisma/routes/index.js",
  "src/prisma/middleware/license.js",
  "src/prisma/services/licenseService.js",
  "src/prisma/security/licenseIntegrity.js",
  "src/prisma/utils/authIps.js",
];

const REQUIRED_PATTERNS = [
  {
    file: "server.js",
    pattern: /assertLicenseIntegrity\(\);/,
    message: "server.js wajib menjalankan assertLicenseIntegrity() saat bootstrap",
  },
  {
    file: "server.js",
    pattern: /assertAuthServerIpAllowed\(\);/,
    message: "server.js wajib validasi IP server sebelum listen",
  },
  {
    file: "server.js",
    pattern: /refreshLicense\(\{\s*force:\s*true\s*\}\)/,
    message: "server.js wajib validasi license secara force sebelum listen",
  },
  {
    file: "src/prisma/utils/authIps.js",
    pattern: /AUTH_SERVER_IPS wajib terenkripsi dengan format enc:v1:\.\.\./,
    message: "authIps.js wajib menolak AUTH_SERVER_IPS plaintext",
  },
  {
    file: "src/prisma/utils/authIps.js",
    pattern: /function assertAuthServerIpAllowed\(\)/,
    message: "authIps.js wajib memiliki assertAuthServerIpAllowed()",
  },
  {
    file: "src/prisma/utils/authIps.js",
    pattern: /os\.networkInterfaces\(\)/,
    message: "authIps.js wajib membaca IP lokal server",
  },
  {
    file: "src/prisma/routes/index.js",
    pattern: /api\.use\(\s*licenseGuard\(\)\s*\);/,
    message: "routes/index.js wajib memasang licenseGuard() sebelum route bisnis",
  },
  {
    file: "src/prisma/middleware/license.js",
    pattern: /isLicenseValid\(\)/,
    message: "middleware/license.js wajib memanggil isLicenseValid()",
  },
  {
    file: "src/prisma/middleware/license.js",
    pattern: /res\.status\(\s*403\s*\)/,
    message: "middleware/license.js wajib menolak request tanpa license valid",
  },
  {
    file: "src/prisma/services/licenseService.js",
    pattern: /isProduction\s*\?\s*false\s*:\s*toBool\(process\.env\.LICENSE_FAIL_OPEN,\s*false\)/,
    message: "licenseService.js tidak boleh fail-open di production",
  },
  {
    file: "src/prisma/services/licenseService.js",
    pattern: /const enabled\s*=\s*toBool\(process\.env\.LICENSE_ENFORCED,\s*false\)/,
    message: "licenseService.js wajib mengikuti LICENSE_ENFORCED untuk enable/disable license",
  },
];

function isProductionLike() {
  return ["production", "prod"].includes(String(process.env.NODE_ENV || "").toLowerCase());
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "off", "no", "disabled"].includes(String(value).trim().toLowerCase());
}

function readProtectedFile(relativePath) {
  const absolutePath = path.join(PROJECT_ROOT, relativePath);
  if (!absolutePath.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path integrity tidak valid: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function normalizeSource(source) {
  return source.replace(/\r\n/g, "\n").trimEnd();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function computeLicenseIntegrityPayload() {
  const files = PROTECTED_FILES.map((file) => ({
    file,
    sha256: sha256(normalizeSource(readProtectedFile(file))),
  }));

  return {
    algorithm: "license-integrity-v1",
    files,
  };
}

function computeLicenseIntegrityDigest() {
  return sha256(JSON.stringify(computeLicenseIntegrityPayload()));
}

function computeLicenseIntegritySignature(secret) {
  if (!secret) throw new Error("LICENSE_INTEGRITY_SECRET belum di-set");
  return hmacSha256(computeLicenseIntegrityDigest(), secret);
}

function assertRequiredPatterns() {
  const byFile = new Map();

  for (const check of REQUIRED_PATTERNS) {
    if (!byFile.has(check.file)) {
      byFile.set(check.file, readProtectedFile(check.file));
    }

    const source = byFile.get(check.file);
    if (!check.pattern.test(source)) {
      throw new Error(check.message);
    }
  }

  const routesSource = byFile.get("src/prisma/routes/index.js") || readProtectedFile("src/prisma/routes/index.js");
  const guardIndex = routesSource.indexOf("api.use(licenseGuard())");
  const authIndex = routesSource.indexOf('api.use("/auth", authRouter)');
  const usersIndex = routesSource.indexOf('api.use("/users", auth, userRouter)');

  if (guardIndex === -1 || authIndex === -1 || usersIndex === -1 || guardIndex > authIndex || guardIndex > usersIndex) {
    throw new Error("licenseGuard() harus terpasang sebelum /auth dan route bisnis lain");
  }
}

function assertSignedIntegrity() {
  const secret = process.env.LICENSE_INTEGRITY_SECRET || "";
  const expectedSignature = process.env.LICENSE_INTEGRITY_SIGNATURE || "";
  const requireSignature = isProductionLike() || toBool(process.env.LICENSE_INTEGRITY_REQUIRE_SIGNATURE, true);

  if (!secret || !expectedSignature) {
    if (requireSignature) {
      throw new Error("Production wajib mengisi LICENSE_INTEGRITY_SECRET dan LICENSE_INTEGRITY_SIGNATURE");
    }
    return;
  }

  const actualSignature = computeLicenseIntegritySignature(secret);
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const actualBuffer = Buffer.from(actualSignature, "hex");

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error("License integrity signature tidak cocok. Kode license kemungkinan diubah tanpa otorisasi.");
  }
}

function assertLicenseIntegrity() {
  assertRequiredPatterns();
  assertSignedIntegrity();
}

module.exports = {
  PROTECTED_FILES,
  assertLicenseIntegrity,
  computeLicenseIntegrityDigest,
  computeLicenseIntegrityPayload,
  computeLicenseIntegritySignature,
};
