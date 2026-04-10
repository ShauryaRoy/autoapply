import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY ?? "";
  if (!secret) {
    throw new Error("ENCRYPTION_KEY must be provided");
  }

  // Hashing stabilizes key length and supports arbitrary user-provided secrets.
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptString(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptString(payload: string): string {
  const [ivB64, tagB64, encryptedB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted payload format");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}
