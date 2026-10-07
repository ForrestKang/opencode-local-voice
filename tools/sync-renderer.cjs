"use strict";
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
for (const platform of ["windows", "macos"]) fs.copyFileSync(path.join(root, "shared/oc-mic.js"), path.join(root, platform, "oc-mic.js"));
console.log("Renderer compatibility copies synchronized.");
