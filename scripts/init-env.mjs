#!/usr/bin/env node
// Create .env from .env.example with fresh random secrets.
//   node scripts/init-env.mjs            # refuses to overwrite an existing .env
//   node scripts/init-env.mjs --force    # overwrite
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".env");
const force = process.argv.includes("--force");

if (existsSync(target) && !force) {
  console.error(".env already exists. Re-run with --force to overwrite it.");
  process.exit(1);
}

const hex = (n) => randomBytes(n).toString("hex");
const values = {
  SESSION_SECRET: hex(32),
  TRACKING_SECRET: hex(32),
  TOKEN_ENCRYPTION_KEY: hex(32),
  POSTGRES_PASSWORD: hex(16),
  ADMIN_PASSWORD: randomBytes(18).toString("base64url"),
};

let text = readFileSync(path.join(root, ".env.example"), "utf8");
for (const [key, value] of Object.entries(values)) {
  text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
}
writeFileSync(target, text, { mode: 0o600 });

console.log("Wrote .env with fresh secrets.");
console.log("");
console.log("  Admin password: " + values.ADMIN_PASSWORD);
console.log("");
console.log("Next: add your Google OAuth client to .env (see README), then:");
console.log("  docker compose up -d");
