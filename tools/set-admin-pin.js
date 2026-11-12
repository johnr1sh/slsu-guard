#!/usr/bin/env node
// Sets the administrator PIN in config.js (PBKDF2-SHA256, random salt).
// Usage:  node tools/set-admin-pin.js <PIN>      (use 6+ characters)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pin = process.argv[2];
if (!pin || pin.length < 6) { console.error("Usage: node tools/set-admin-pin.js <PIN of at least 6 characters>"); process.exit(1); }

const file = path.join(__dirname, "..", "config.js");
const iterations = 210000;
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(pin, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex");

const src = fs.readFileSync(file, "utf8");
const line = `adminPin: { salt: "${salt}", hash: "${hash}", iterations: ${iterations} },`;
if (!/adminPin:\s*\{[^}]*\},/.test(src)) { console.error("adminPin line not found in config.js"); process.exit(1); }
fs.writeFileSync(file, src.replace(/adminPin:\s*\{[^}]*\},/, line));
console.log("Administrator PIN updated in config.js. Rebuild the extension package before deploying.");
