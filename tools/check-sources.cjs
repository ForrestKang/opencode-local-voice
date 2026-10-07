"use strict";
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const yaml = require("yaml");
const root = path.resolve(__dirname, "..");
const directories = ["shared", "windows", "macos", "linux", "tests", "tools"];
let count = 0;
for (const directory of directories) for (const name of fs.readdirSync(path.join(root, directory))) {
  if (!/\.(c?js)$/.test(name)) continue;
  execFileSync(process.execPath, ["--check", path.join(root, directory, name)]); count++;
}
const canonical = fs.readFileSync(path.join(root, "shared/oc-mic.js"));
for (const platform of ["windows", "macos"]) {
  if (!canonical.equals(fs.readFileSync(path.join(root, platform, "oc-mic.js")))) throw new Error(platform + " renderer copy is out of date; run npm run sync-renderer");
}
console.log(count + " JavaScript files parsed; platform renderers match the shared source.");
const workflow = yaml.parse(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
if (!workflow.on || !workflow.jobs || Object.keys(workflow.jobs).length !== 2) throw new Error("CI workflow is incomplete");
for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
  if (step.uses && step.run) throw new Error("A CI step cannot contain both uses and run");
}
console.log("CI YAML parsed and step structure validated.");
const issue = yaml.parse(fs.readFileSync(path.join(root, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8"));
if (!issue.name || !issue.description || !Array.isArray(issue.body)) throw new Error("Bug report template is incomplete");
const ids = issue.body.filter(field => field.type !== "markdown").map(field => field.id);
if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Bug report fields must have unique IDs");
console.log("Bug report YAML parsed and field structure validated.");
