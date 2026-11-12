#!/usr/bin/env node
// Regenerates manifest.json host_permissions from config.js so the two never drift.
// Usage (from the extension folder):  node tools/sync-manifest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const cfg = vm.runInNewContext(fs.readFileSync(path.join(root, "config.js"), "utf8") + "\nGUARD_CONFIG", {});
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const domains = cfg.blockedSites.filter(g => g.enabled).flatMap(g => g.domains);
manifest.version = cfg.version;
manifest.version_name = cfg.version;
manifest.host_permissions = [
  `${cfg.lmsOrigin}/*`,
  ...[...new Set(domains)].map(d => `https://*.${d}/*`)
];
manifest.content_scripts[0].matches = [`${cfg.lmsOrigin}/*`];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json synced: ${domains.length} blocked domains, version ${cfg.version}`);
