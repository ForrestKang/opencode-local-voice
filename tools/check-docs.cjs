"use strict";
// Check public documentation without contacting external sites or reading user data.
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(filename);
    return entry.isFile() && entry.name.endsWith(".md") ? [filename] : [];
  });
}
const files = fs.readdirSync(root).filter(name => name.endsWith(".md")).map(name => path.join(root, name)).concat(markdownFiles(path.join(root, "docs")));
const errors = []; let links = 0;
for (const filename of files) {
  const source = fs.readFileSync(filename, "utf8");
  const lines = []; let fence;
  for (const line of source.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) { fence = marker[1]; continue; }
    if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = undefined; continue; }
    if (!fence) lines.push(line);
  }
  if (fence) errors.push(path.relative(root, filename) + ": unclosed code fence");
  const prose = lines.join("\n").replace(/`+[^`\n]*`+/g, "");
  for (const match of prose.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const relative = decodeURIComponent(target.split("#")[0]);
    const resolved = path.resolve(path.dirname(filename), relative);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) errors.push(path.relative(root, filename) + ": broken or non-repository link " + target);
    links++;
  }
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(`PASS ${files.length} Markdown files, ${links} local links and code fences`);
