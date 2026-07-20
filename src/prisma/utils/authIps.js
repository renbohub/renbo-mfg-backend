const crypto = require("crypto");
const os = require("os");

const RAW_AUTH_SERVER_IPS =
  process.env.AUTH_SERVER_IPS ||
  process.env.AUTH_ALLOWED_SERVER_IPS ||
  "";
const AUTH_SERVER_IPS_SECRET = process.env.AUTH_SERVER_IPS_SECRET || process.env.AUTH_IPS_SECRET || "";
const AUTH_SERVER_IPS_ENABLED = !["false", "0", "no", "off", "disabled"].includes(
  String(process.env.AUTH_SERVER_IPS_ENABLED ?? "true").trim().toLowerCase()
);

function base64UrlDecode(value) {
  return Buffer.from(String(value), "base64url");
}

function deriveAuthIpsKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function decryptAuthIps(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("enc:v1:")) {
    throw new Error("AUTH_SERVER_IPS wajib terenkripsi dengan format enc:v1:...");
  }

  if (!AUTH_SERVER_IPS_SECRET) {
    throw new Error("AUTH_SERVER_IPS_SECRET wajib di-set untuk IP terenkripsi");
  }

  const parts = raw.split(":");
  if (parts.length !== 5) {
    throw new Error("Format IP terenkripsi tidak valid");
  }

  const [, , ivRaw, tagRaw, encryptedRaw] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveAuthIpsKey(AUTH_SERVER_IPS_SECRET),
    base64UrlDecode(ivRaw)
  );
  decipher.setAuthTag(base64UrlDecode(tagRaw));

  try {
    return Buffer.concat([
      decipher.update(base64UrlDecode(encryptedRaw)),
      decipher.final(),
    ]).toString("utf8");
  } catch (_err) {
    throw new Error("IP terenkripsi gagal didecrypt");
  }
}

function normalizeIp(value) {
  if (!value) return "";

  const ip = String(value).trim();
  if (!ip) return "";

  if (ip.toLowerCase() === "localhost") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip === "::1") return "127.0.0.1";

  return ip;
}

const AUTH_SERVER_IPS = AUTH_SERVER_IPS_ENABLED
  ? decryptAuthIps(RAW_AUTH_SERVER_IPS)
      .split(/[\n,]+/)
      .map(normalizeIp)
      .filter(Boolean)
  : [];

function ipv4ToNumber(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;

  let total = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    total = (total * 256) + octet;
  }

  return total >>> 0;
}

function isIpInCidr(ip, cidr) {
  const [rangeIp, prefixRaw] = String(cidr).split("/");
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNumber = ipv4ToNumber(ip);
  const rangeNumber = ipv4ToNumber(normalizeIp(rangeIp));
  if (ipNumber === null || rangeNumber === null) return false;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (rangeNumber & mask);
}

function isIpAllowed(ip, allowedIps) {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return false;

  return allowedIps.some((allowedIp) => {
    if (allowedIp.includes("/")) {
      return isIpInCidr(normalizedIp, allowedIp);
    }
    return normalizedIp === allowedIp;
  });
}

function getLocalServerIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === "IPv4")
    .map((network) => normalizeIp(network.address))
    .filter(Boolean);
}

function assertAuthServerIpAllowed() {
  if (!AUTH_SERVER_IPS_ENABLED) return;

  if (AUTH_SERVER_IPS.length === 0) {
    throw new Error("AUTH_SERVER_IPS wajib di-set saat AUTH_SERVER_IPS_ENABLED=true");
  }

  const localIps = getLocalServerIps();
  const matchedIp = localIps.find((ip) => isIpAllowed(ip, AUTH_SERVER_IPS));

  if (!matchedIp) {
    throw new Error(
      `Server IP tidak diizinkan. Local IP: ${localIps.join(", ") || "-"}; allowed: ${AUTH_SERVER_IPS.join(", ")}`
    );
  }

  console.log("✅ Server IP validated:", matchedIp);
}

module.exports = {
  assertAuthServerIpAllowed,
  getLocalServerIps,
};
