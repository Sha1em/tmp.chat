'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const runtime = ['background.js', 'agent.js', 'content.js', 'lib/core.js', 'lib/selection.js', 'lib/layout.js', 'lib/answer.js'];
for (const file of runtime) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  new vm.Script(source, { filename: file });
  if (/\beval\s*\(|new Function\s*\(|backend-api|https?:\/\/(?!chatgpt\.com)/.test(source)) throw new Error(`Unexpected executable code or external service in ${file}`);
}
for (const file of Object.values(manifest.icons)) {
  const data = fs.readFileSync(path.join(root, file));
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://chatgpt.com/*'])) throw new Error('Host access should be limited to ChatGPT.');
const bytes = runtime.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, fs.statSync(path.join(root, 'manifest.json')).size);
console.log(`Manifest and ${runtime.length} scripts valid. Runtime source: ${(bytes / 1024).toFixed(1)} KiB. No runtime dependencies.`);
