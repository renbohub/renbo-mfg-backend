#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const {
  assertLicenseIntegrity,
  computeLicenseIntegrityDigest,
  computeLicenseIntegrityPayload,
  computeLicenseIntegritySignature,
} = require("../src/prisma/security/licenseIntegrity");

const command = process.argv[2] || "verify";

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  if (command === "digest") {
    printJson({
      digest: computeLicenseIntegrityDigest(),
      payload: computeLicenseIntegrityPayload(),
    });
    process.exit(0);
  }

  if (command === "sign") {
    const secret = process.env.LICENSE_INTEGRITY_SECRET || process.argv[3] || "";
    printJson({
      digest: computeLicenseIntegrityDigest(),
      signature: computeLicenseIntegritySignature(secret),
    });
    process.exit(0);
  }

  if (command !== "verify") {
    throw new Error("Command harus salah satu: verify, digest, sign");
  }

  assertLicenseIntegrity();
  printJson({
    ok: true,
    digest: computeLicenseIntegrityDigest(),
  });
} catch (err) {
  console.error(`License integrity check failed: ${err.message}`);
  process.exit(1);
}
