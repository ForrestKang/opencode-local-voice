"""Exercise the real Python HTTP service through the Node desktop client."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "shared"))
from shared.voice_server import ConfigStore, Coordinator, create_server
from test_voice_server import QuickFakeWorker

spec = importlib.util.spec_from_file_location("web_pairing_tool", ROOT / "tools" / "make-web-script.py")
pairing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pairing)


class ClientIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.temp.name) / "voice-home")
        self.coordinator = Coordinator(self.store.get(), worker_factory=QuickFakeWorker)
        self.server = create_server(store=self.store, coordinator=self.coordinator, port=0)
        self.store.update({"port": self.server.server_address[1]})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.coordinator.close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def test_node_client_auth_config_and_parallel_jobs_against_real_server(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the client integration test")
        script = r"""
const assert = require('node:assert/strict');
const {createClient} = require('./shared/desktop-bridge.cjs');
const client = createClient({voiceHome: process.argv[1], jobTimeout: 5000});
const pcm = Buffer.alloc(3200), header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(pcm.length+36,4); header.write('WAVEfmt ',8);
header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
header.writeUInt32LE(16000,24); header.writeUInt32LE(32000,28); header.writeUInt16LE(2,32);
header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40);
(async()=>{
  const config = await client.saveConfig({language:'zh',beam_size:1,initial_prompt:'test prompt'});
  assert.equal(config.language,'zh'); assert.equal(config.beam_size,1);
  const results = await Promise.all([client.transcribe(Buffer.concat([header,pcm])), client.transcribe(Buffer.concat([header,pcm]))]);
  assert.equal(results[0].text,'fake transcript'); assert.equal(results[1].text,'fake transcript');
  assert.notEqual(results[0].id,results[1].id); assert.equal(results[0].timings.audio_seconds,0.1);
  const status=await client.status(); assert.ok(!JSON.stringify(status).includes('Bearer'));
  console.log(JSON.stringify({parallelJobs:results.length,language:config.language}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
"""
        result = subprocess.run([node, "-e", script, str(self.store.home)], cwd=ROOT,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["parallelJobs"], 2)

    def test_node_desktop_and_browser_preview_share_request_local_text_pipeline(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the client integration test")
        web_origin = "http://localhost:4096"
        self.store.update({"allowed_origins": [*self.store.get()["allowed_origins"], web_origin]})
        baseline = self.store.get()
        script = r"""
const assert = require('node:assert/strict');
global.window = global;
global.crypto = require('node:crypto').webcrypto;
const nativeFetch = global.fetch;
const webOrigin = 'http://localhost:4096';
global.fetch = async (url, options) => {
  const headers = Object.assign({}, options && options.headers || {}, {Origin:webOrigin});
  const response = await nativeFetch(url, Object.assign({}, options, {headers}));
  assert.equal(response.headers.get('access-control-allow-origin'), webOrigin);
  return response;
};
require('./shared/browser-transport.js');
const {createClient} = require('./shared/desktop-bridge.cjs');
const desktop = createClient({voiceHome: process.argv[1], jobTimeout: 5000});
const web = global.createOcVoiceTransport({url: process.argv[2], token: process.argv[3]});
const text = 'open code, keep this English phrase';
const config = {
  text_mode: 'custom', punctuation_mode: 'zh', space_mode: 'preserve',
  replacements: [{from: 'open code', to: 'OpenCode'}],
  prompt_template: '请处理：{text}'
};
(async()=>{
  const preflight = await nativeFetch(process.argv[2] + '/v1/text', {method:'OPTIONS', headers:{
    Origin:webOrigin, 'Access-Control-Request-Method':'POST',
    'Access-Control-Request-Headers':'authorization,content-type'
  }});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), webOrigin);
  const [desktopResult, webResult] = await Promise.all([
    desktop.previewText(text, config), web.previewText(text, config)
  ]);
  for (const field of ['raw_text','local_text','text']) {
    assert.equal(desktopResult[field], webResult[field], field + ' must match across transports');
  }
  assert.equal(desktopResult.raw_text, text);
  assert.equal(desktopResult.text, '请处理：OpenCode， keep this English phrase');
  assert.equal(desktopResult.processing_warning, undefined);
  const persisted = await desktop.getConfig();
  assert.equal(persisted.text_mode, 'clean');
  assert.deepEqual(persisted.replacements, []);
  assert.equal(persisted.prompt_template, '{text}');
  assert.equal(persisted.punctuation_mode, 'auto');
  console.log(JSON.stringify({text:desktopResult.text,local:desktopResult.local_text}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
"""
        result = subprocess.run(
            [node, "-e", script, str(self.store.home),
             f"http://127.0.0.1:{self.server.server_address[1]}", self.store.token],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["text"], "请处理：OpenCode， keep this English phrase")
        self.assertEqual(self.store.get(), baseline,
                         "request-local preview rules must not alter persisted user settings")

    def test_private_web_pairing_config_and_scoped_output(self):
        origin = "http://localhost:4096"
        destination = Path(self.temp.name) / "voice.personal.user.js"
        # The production health challenge and authenticated PATCH execute here.
        output = pairing.generate(origin, destination, self.store)
        content = output.read_text(encoding="utf-8")
        self.assertIn("// @match " + origin + "/*", content)
        self.assertIn('if(location.origin!=="' + origin + '")return', content)
        self.assertIn(self.store.token, content)
        self.assertIn(origin, self.store.get()["allowed_origins"])
        self.assertNotIn(self.store.token, json.dumps(self.store.get()))

    def test_invalid_pairing_inputs_have_no_server_side_effect(self):
        with patch.object(pairing, "ensure_server") as ensure:
            with self.assertRaises(ValueError):
                pairing.generate("http://localhost:4096", Path(self.temp.name) / "public.js", self.store)
            with self.assertRaises(ValueError):
                pairing.generate("https://example.com/path", Path(self.temp.name) / "test.personal.user.js", self.store)
            ensure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
