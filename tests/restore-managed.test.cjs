"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

test("managed restore follows feature-first order and retries maintenance after a restored feature", { skip: process.platform !== "win32", timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-managed-restore-test-"));
  try {
    const app = path.join(root, "OpenCode");
    const archive = path.join(app, "resources", "app.asar");
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "home");
    const backupRoot = path.join(root, "backups");
    const maintenanceRoot = path.join(root, "maintenance");
    const transaction = path.join(maintenanceRoot, "transactions", "0.2.0-maintenance");
    const feature = path.join(backupRoot, "v0.2.0-feature");
    const packageRoot = path.join(root, "package");
    const trace = path.join(root, "trace.log");
    const activePath = path.join(maintenanceRoot, "active.json");
    const receiptPath = path.join(maintenanceRoot, "shortcut-receipt.json");
    const sourceHash = "a".repeat(64), patchedHash = "b".repeat(64), packageHash = "c".repeat(64);
    for (const directory of [path.dirname(archive), runtime, home, backupRoot, maintenanceRoot, transaction, feature,
      path.join(packageRoot, "shared"), path.join(packageRoot, "windows")]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(archive, "fixture archive");
    fs.writeFileSync(receiptPath, "{}\n");
    fs.writeFileSync(path.join(packageRoot, "shared", "update-recovery.cjs"),
      "process.stdout.write(JSON.stringify({targetAsar:process.env.OC_MANAGED_ARCHIVE,archive:{version:'1.18.33',hash:process.env.OC_MANAGED_HASH}}));\n");
    fs.writeFileSync(path.join(packageRoot, "shared", "feature-update.cjs"),
      "const fs=require('node:fs'); fs.appendFileSync(process.env.OC_MANAGED_TRACE,'feature:'+process.argv[2]+':'+(process.argv.includes('--dry-run')?'dry-run':'actual')+'\\n');\n");
    fs.writeFileSync(path.join(packageRoot, "windows", "restore-maintenance.ps1"), [
      "param([string]$Transaction,[switch]$DryRun)",
      "$kind = if ($DryRun) { 'dry-run' } else { 'actual' }",
      "Add-Content -LiteralPath $env:OC_MANAGED_TRACE -Value ('maintenance:' + $kind)",
      "if ($env:OC_MANAGED_FAIL -eq '1' -and -not $DryRun) { $path = Join-Path $Transaction 'maintenance-transaction.json'; $m = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json; $m.state = 'restore-failed'; $m | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path; exit 1 }",
    ].join("\n"));
    const active = {
      schema: 1, featureVersion: "0.2.0", packageRoot, packageManifestSha256: packageHash,
      node: process.execPath, python: process.execPath, app, home, runtime, backupRoot, maintenanceRoot,
      shortcutReceipt: receiptPath, transactionPath: transaction,
    };
    fs.writeFileSync(activePath, JSON.stringify(active));
    const featureManifest = {
      schema: 1, featureVersion: "0.2.0", app, input: archive, home, runtime,
      appVersion: "1.18.33", sourceAsarSha256: sourceHash, patchedAsarSha256: patchedHash,
      state: "applied", appliedAt: "2026-10-07T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(feature, "feature-manifest.json"), JSON.stringify(featureManifest));
    const unrelatedFeature = path.join(backupRoot, "v0.2.0-unrelated");
    fs.mkdirSync(unrelatedFeature, { recursive: true });
    fs.writeFileSync(path.join(unrelatedFeature, "feature-manifest.json"), JSON.stringify({
      ...featureManifest, app: path.join(root, "OtherOpenCode"), input: path.join(root, "OtherOpenCode", "resources", "app.asar"),
      state: "applied", appliedAt: "2026-10-07T00:02:00.000Z",
    }));
    const maintenanceManifest = {
      schema: 1, featureVersion: "0.2.0", state: "applied", transaction,
      activePath, receiptPath, packageRoot, packageManifestSha256: packageHash, appPath: app,
    };
    fs.writeFileSync(path.join(transaction, "maintenance-transaction.json"), JSON.stringify(maintenanceManifest));
    const env = { ...process.env, OC_MANAGED_ARCHIVE: archive, OC_MANAGED_HASH: patchedHash, OC_MANAGED_TRACE: trace };
    const script = path.resolve(__dirname, "../windows/restore-voice-managed.ps1");
    const invoke = (...extra) => cp.execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ConfigPath", activePath, ...extra], { env, encoding: "utf8", timeout: 15000, windowsHide: true });

    env.OC_MANAGED_FAIL = "1";
    assert.throws(() => invoke(), /Maintenance restore failed/);
    assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split(/\r?\n/), [
      "feature:restore:dry-run", "maintenance:dry-run", "feature:restore:actual", "maintenance:actual"
    ]);

    delete env.OC_MANAGED_FAIL;
    featureManifest.state = "restored";
    featureManifest.restoredAt = "2026-10-07T00:01:00.000Z";
    featureManifest.patchedAsarSha256 = patchedHash;
    featureManifest.sourceAsarSha256 = patchedHash;
    fs.writeFileSync(path.join(feature, "feature-manifest.json"), JSON.stringify(featureManifest));
    fs.writeFileSync(trace, "");
    invoke();
    assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split(/\r?\n/), ["maintenance:dry-run", "maintenance:actual"]);

    maintenanceManifest.packageManifestSha256 = "d".repeat(64);
    fs.writeFileSync(path.join(transaction, "maintenance-transaction.json"), JSON.stringify(maintenanceManifest));
    assert.throws(() => invoke(), /active\.json and maintenance transaction do not match/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
