"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const patcher=require("../shared/patch-package.cjs"),{inspectHooks}=require("../shared/maintenance-inspect.cjs"),{makeAsar,baseFiles}=require("./fixtures/asar.cjs");
const source=path.resolve(__dirname,".."),options={platform:"windows",bridgeSource:fs.readFileSync(path.join(source,"shared/desktop-bridge.cjs"),"utf8"),micSource:fs.readFileSync(path.join(source,"shared/oc-mic.js"),"utf8")};
test("maintenance activation verifies unique hooks and exact embedded bridge/renderer without executing them",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"oc-hook-inspect-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const archive=path.join(root,"candidate.asar"),result=patcher.patchAsar(makeAsar(baseFiles()),options);fs.writeFileSync(archive,result.buffer);
 const readback=inspectHooks(archive,source);assert.equal(readback.updateHook,true);assert.equal(readback.asarSha256,result.outputHash);
 const wrong=path.join(root,"wrong-source");fs.mkdirSync(path.join(wrong,"shared"),{recursive:true});fs.writeFileSync(path.join(wrong,"shared/update-bridge.cjs"),"module.exports={};\n");
 assert.throws(()=>inspectHooks(archive,wrong),/differs from the verified source/);assert.deepEqual(fs.readFileSync(archive),result.buffer);
});
test("an archive without the updater markers cannot activate maintenance",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"oc-hook-missing-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const archive=path.join(root,"official.asar");fs.writeFileSync(archive,makeAsar(baseFiles()));assert.throws(()=>inspectHooks(archive,source),/marker must be unique/);
});
