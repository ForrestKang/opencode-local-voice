"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
// Pass explicit filenames so Windows Node 20 does not depend on shell globbing.
const files = fs.readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.cjs")).sort()
  .map(name => path.join(root, "tests", name));
if (!files.length) throw new Error("No Node regression tests found");
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
