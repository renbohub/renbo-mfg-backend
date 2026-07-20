const crypto = require("crypto");
require("dotenv").config({ override: true, quiet: true });

function usage() {
  console.log("Usage:");
  console.log("  AUTH_SERVER_IPS_SECRET=your-secret node scripts/auth-ips-crypto.js encrypt \"192.168.10.139\"");
  console.log("  AUTH_SERVER_IPS_SECRET=your-secret node scripts/auth-ips-crypto.js decrypt \"enc:v1:...\"");
}

function getSecret() {
  const secret = process.env.AUTH_SERVER_IPS_SECRET || process.env.AUTH_IPS_SECRET || "";
  if (!secret) {
    throw new Error("AUTH_SERVER_IPS_SECRET wajib di-set");
  }
  return secret;
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "enc",
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decrypt(value, secret) {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Format encrypted value tidak valid");
  }

  const [, , ivRaw, tagRaw, encryptedRaw] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function main() {
  const [, , command, ...args] = process.argv;
  const value = args.join(" ").trim();

  if (!command || !value || !["encrypt", "decrypt"].includes(command)) {
    usage();
    process.exit(1);
  }

  const secret = getSecret();
  console.log(command === "encrypt" ? encrypt(value, secret) : decrypt(value, secret));
}

main();
