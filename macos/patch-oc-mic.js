"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function parse(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error("unexpected argument: " + key);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("missing value for " + key);
    const name = key.slice(2);
    if (args[name]) throw new Error("duplicate argument: " + key);
    args[name] = value;
  }
  return args;
}

function findArchive(app) {
  const candidate = path.join(app, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error("app.asar not found under --app");
  return candidate;
}

try {
  const args = parse(process.argv.slice(2));
  const app = path.resolve(args.app || process.env.OPENCODE_APP_PATH || path.join(os.homedir(), "Applications", "OpenCode.app"));
  const chosenApp = args.app || process.env.OPENCODE_APP_PATH || (fs.existsSync(app) ? app : "/Applications/OpenCode.app");
  const input = path.resolve(args.input || findArchive(chosenApp));
  const output = path.resolve(args.output || path.join(__dirname, "app.asar.patched"));
  const shared = path.resolve(__dirname, "..", "shared", "patch-package.cjs");
  const result = spawnSync(process.execPath, [shared, "--platform", "macos", "--app", path.resolve(chosenApp), "--input", input, "--output", output], {
    stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
} catch (error) {
  console.error("[patch] ERROR: " + error.message);
  process.exitCode = 1;
}
