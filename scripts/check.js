"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const includedRoots = [
  "index.js",
  "bootstrap.js",
  "identity-layer.js",
  "identity-store.js",
  "src",
  "scripts",
];

function collect(target) {
  const absolute = path.join(root, target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return absolute.endsWith(".js") ? [absolute] : [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    collect(path.join(target, entry.name))
  );
}

const files = includedRoots.filter((target) => fs.existsSync(path.join(root, target))).flatMap(collect);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`[check] Syntax OK across ${files.length} JavaScript files.`);
