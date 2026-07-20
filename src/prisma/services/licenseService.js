const os = require("os");
const jwt = require("jsonwebtoken");

const LICENSE_DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

let cache = {
  valid: false,
  checkedAt: 0,
  expiresAt: 0,
  graceUntil: 0,
  payload: null,
  error: null,
};

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return !LICENSE_DISABLED_VALUES.has(String(value).trim().toLowerCase());
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig() {
  const isProduction = ["production", "prod"].includes(
    String(process.env.NODE_ENV || "").toLowerCase()
  );
  const enabled = toBool(process.env.LICENSE_ENFORCED, false);
  const serverUrl = (process.env.LICENSE_SERVER_URL || "").replace(/\/+$/, "");
  const licenseKey = process.env.LICENSE_KEY || "";
  const instanceId =
    process.env.LICENSE_INSTANCE_ID ||
    `${os.hostname()}-${process.env.PORT || "app"}`;

  return {
    enabled,
    serverUrl,
    licenseKey,
    instanceId,
    appId: process.env.LICENSE_APP_ID || "mitsutoyo-erp",
    appVersion: process.env.npm_package_version || "unknown",
    tokenSecret: process.env.LICENSE_TOKEN_SECRET || "",
    cacheMs: toPositiveInt(process.env.LICENSE_CACHE_SECONDS, 300) * 1000,
    graceMs: toPositiveInt(process.env.LICENSE_GRACE_SECONDS, 86400) * 1000,
    failOpen: isProduction ? false : toBool(process.env.LICENSE_FAIL_OPEN, false),
  };
}

function assertConfigured(config) {
  if (!config.serverUrl) throw new Error("LICENSE_SERVER_URL belum di-set");
  if (!config.licenseKey) throw new Error("LICENSE_KEY belum di-set");
}

function verifyLeaseToken(token, config) {
  if (!token) throw new Error("License server tidak mengirim token");
  if (!config.tokenSecret) return jwt.decode(token);

  return jwt.verify(token, config.tokenSecret, {
    audience: config.appId,
    issuer: "license-server",
  });
}

async function requestLicense(config) {
  assertConfigured(config);

  const response = await fetch(`${config.serverUrl}/api/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `mitsutoyo-backend/${config.appVersion}`,
    },
    body: JSON.stringify({
      licenseKey: config.licenseKey,
      instanceId: config.instanceId,
      appId: config.appId,
      appVersion: config.appVersion,
      hostname: os.hostname(),
      platform: os.platform(),
    }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(`License server response tidak valid (${response.status})`);
  }

  if (!response.ok || body.valid !== true) {
    throw new Error(body?.message || `License ditolak (${response.status})`);
  }

  return verifyLeaseToken(body.token, config);
}

async function refreshLicense({ force = false } = {}) {
  const config = getConfig();
  const now = Date.now();

  if (!config.enabled) {
    cache = {
      valid: true,
      checkedAt: now,
      expiresAt: now + DEFAULT_CACHE_MS,
      graceUntil: now + DEFAULT_GRACE_MS,
      payload: { disabled: true },
      error: null,
    };
    return cache;
  }

  if (!force && cache.valid && cache.expiresAt > now) {
    return cache;
  }

  try {
    const payload = await requestLicense(config);
    const leaseExpiresAt = payload?.exp ? payload.exp * 1000 : now + config.cacheMs;

    cache = {
      valid: true,
      checkedAt: now,
      expiresAt: Math.min(leaseExpiresAt, now + config.cacheMs),
      graceUntil: now + config.graceMs,
      payload,
      error: null,
    };
  } catch (err) {
    const withinGrace = cache.valid && cache.graceUntil > now;

    cache = {
      ...cache,
      valid: config.failOpen || withinGrace,
      checkedAt: now,
      expiresAt: now + Math.min(config.cacheMs, 60 * 1000),
      error: err.message,
    };
  }

  return cache;
}

async function isLicenseValid() {
  const result = await refreshLicense();
  return result.valid;
}

function getLicenseStatus() {
  const config = getConfig();
  return {
    enabled: config.enabled,
    valid: cache.valid,
    checkedAt: cache.checkedAt ? new Date(cache.checkedAt).toISOString() : null,
    expiresAt: cache.expiresAt ? new Date(cache.expiresAt).toISOString() : null,
    graceUntil: cache.graceUntil ? new Date(cache.graceUntil).toISOString() : null,
    appId: config.appId,
    instanceId: config.instanceId,
    licenseId: cache.payload?.licenseId || null,
    clientName: cache.payload?.clientName || null,
    error: cache.error,
  };
}

module.exports = {
  refreshLicense,
  isLicenseValid,
  getLicenseStatus,
};
