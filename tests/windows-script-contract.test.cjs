"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

test("Windows install and apply dry runs reject unsupported app.asar layouts before patching", { skip: process.platform !== "win32", timeout: 20000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-windows-layout-test-"));
  const app = path.join(root, "OpenCode");
  try {
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "app.asar"), "unsupported layout fixture");
    const invoke = (script, args) => {
      try {
        cp.execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve(__dirname, "../windows", script), ...args], { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
        assert.fail(`${script} unexpectedly accepted an alternate archive layout`);
      } catch (error) {
        assert.notEqual(error.status, 0, `${script} must reject an alternate archive layout`);
        assert.match(`${error.stdout || ""}\n${error.stderr || ""}`, /Only AppPath\\resources\\app\.asar is supported/);
      }
    };
    invoke("install.ps1", ["-AppPath", app, "-DryRun"]);
    invoke("apply-oc-mic.ps1", ["--app", app, "--dry-run"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
