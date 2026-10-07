"use strict";
const test=require("node:test"),path=require("node:path"),cp=require("node:child_process");
const assert=require("node:assert/strict"),recovery=require("../shared/update-recovery.cjs");
test("Windows live process query excludes idle PID 0 and parses into recovery identities",{skip:process.platform!=="win32",timeout:20000},()=>{
 const env={...process.env};
 for(const key of Object.keys(env)) if(key.toLowerCase()==="psmodulepath") delete env[key];
 const output=cp.execFileSync("powershell.exe",["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(__dirname,"../windows/maintenance-processes.ps1")],{windowsHide:true,timeout:15000,encoding:"utf8",env});
 const records=recovery.parseProcessOutput(output);
 assert.ok(records.length>0);
 assert.ok(records.every(record=>record.pid>0));
 assert.ok(records.some(record=>record.pid===process.pid));
});
test("Windows maintenance installs, rebinds and restores only isolated WSH shortcuts",{skip:process.platform!=="win32",timeout:120000},()=>{
 cp.execFileSync(process.execPath,[path.join(__dirname,"maintenance-windows.cjs")],{windowsHide:true,timeout:115000,stdio:"pipe"});
});
