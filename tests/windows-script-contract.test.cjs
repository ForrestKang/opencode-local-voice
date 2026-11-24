"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { makeAsar, baseFiles } = require("./fixtures/asar.cjs");

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

test("Windows installers and Update-Plugin canonicalize a .config/opencode NTFS junction while rejecting inner linked paths", { skip: process.platform !== "win32", timeout: 30000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "oc-windows-junction-test-")));
  const userHome = path.join(root, "user-home");
  const realBase = path.join(root, "real-opencode-config");
  const app = path.join(root, "OpenCodeApp");
  try {
    fs.mkdirSync(path.join(userHome, ".config"), { recursive: true });
    for (const dir of [
      realBase,
      path.join(realBase, "local-voice"),
      path.join(realBase, "whisper"),
      path.join(realBase, "whisper-venv", "Scripts"),
      path.join(realBase, "voice-maintenance"),
      path.join(app, "resources"),
    ]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(realBase, "local-voice", "config.json"), JSON.stringify({ model_path: "D:\\preserved-model" }));
    fs.writeFileSync(path.join(realBase, "whisper-venv", "Scripts", "python.exe"), "fixture");
    fs.writeFileSync(path.join(realBase, "whisper-venv", "Scripts", "pythonw.exe"), "fixture");
    fs.writeFileSync(path.join(app, "OpenCode.exe"), "fixture");
    fs.writeFileSync(path.join(app, "resources", "app.asar"), makeAsar(baseFiles(), "1.18.34"));
    const junction = path.join(userHome, ".config", "opencode");
    try {
      fs.symlinkSync(realBase, junction, "junction");
    } catch (err) {
      return t.skip("junctions unavailable: " + err.message);
    }
    const env = { ...process.env, USERPROFILE: userHome };
    delete env.PSModulePath;
    const runPs = (script, args) => cp.execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve(__dirname, "../windows", script), ...args],
      { encoding: "utf8", timeout: 25000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env }
    );

    const previewOut = runPs("install-feature-preview.ps1", ["-AppPath", app, "-DryRun"]);
    assert.match(previewOut, /Dry-run validation complete/);

    const updateOut = runPs("Update-Plugin.ps1", ["-AppPath", app, "-SkipPull", "-DryRun"]);
    assert.match(updateOut, /Dry-run validation complete/);

    // Re-running dry-run against an already-patched app.asar (backend-only update) must succeed idempotently.
    const patcher = require("../shared/patch-package.cjs");
    const patched = patcher.patchAsar(fs.readFileSync(path.join(app, "resources", "app.asar")), {
      platform: "windows",
      bridgeSource: fs.readFileSync(path.resolve(__dirname, "../shared/desktop-bridge.cjs"), "utf8"),
      micSource: fs.readFileSync(path.resolve(__dirname, "../shared/oc-mic.js"), "utf8"),
    });
    fs.writeFileSync(path.join(app, "resources", "app.asar"), patched.buffer);
    const idempotentOut = runPs("Update-Plugin.ps1", ["-AppPath", app, "-SkipPull", "-DryRun"]);
    assert.match(idempotentOut, /unchanged/);
    assert.match(idempotentOut, /Dry-run validation complete/);

    // Inner junctions under voice-maintenance must remain rejected by feature-update/install-support.
    fs.writeFileSync(path.join(app, "resources", "app.asar"), makeAsar(baseFiles(), "1.18.34"));
    const innerLinkTarget = path.join(root, "evil-backups");
    fs.mkdirSync(innerLinkTarget, { recursive: true });
    fs.symlinkSync(innerLinkTarget, path.join(realBase, "voice-maintenance", "backups"), "junction");
    assert.throws(() => runPs("install-feature-preview.ps1", ["-AppPath", app, "-DryRun"]), /linked path component/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("all Windows PowerShell scripts are pure ASCII, syntactically valid, and share voice-paths helpers", { skip: process.platform !== "win32", timeout: 20000 }, () => {
  const winDir = path.resolve(__dirname, "../windows");
  const psFiles = fs.readdirSync(winDir).filter(name => name.endsWith(".ps1"));
  assert.ok(psFiles.includes("voice-paths.ps1"));
  assert.ok(psFiles.includes("Update-Plugin.ps1"));
  for (const name of psFiles) {
    const raw = fs.readFileSync(path.join(winDir, name));
    for (let i = 0; i < raw.length; i += 1) {
      assert.ok(raw[i] <= 127, `windows/${name} contains non-ASCII byte at offset ${i}`);
    }
  }
  const checkCmd = `
    $ErrorActionPreference = 'Stop'
    $dir = ${JSON.stringify(winDir)}
    Get-ChildItem -LiteralPath $dir -Filter '*.ps1' | ForEach-Object {
      $errs = @()
      [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs)
      if ($errs.Count -gt 0) { throw ($_.Name + ': ' + ($errs | Out-String)) }
    }
    . (Join-Path $dir 'voice-paths.ps1')
    $p = Resolve-OpencodePrefix 'C:\\Users\\demo\\.config\\opencode\\local-voice' 'C:\\Users\\demo\\.config\\opencode' 'D:\\Real\\opencode'
    if ($p -ne 'D:\\Real\\opencode\\local-voice') { throw "unexpected prefix result: $p" }
    Write-Output 'OK'
  `;
  const out = cp.execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", checkCmd], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.match(out, /OK/);

  const updateSrc = fs.readFileSync(path.join(winDir, "Update-Plugin.ps1"), "utf8");
  assert.match(updateSrc, /ContainsKey\("Model"\)/, "Update-Plugin.ps1 must only forward -Model when explicitly provided");
  assert.match(updateSrc, /missing SHA256SUMS\.txt/, "Update-Plugin.ps1 must refuse releases without SHA256SUMS.txt");
});
