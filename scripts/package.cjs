'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
const files = ['manifest.json','background.js','agent.js','content.js','lib/core.js','lib/selection.js','lib/layout.js','lib/answer.js','icons/16.png','icons/32.png','icons/48.png','icons/128.png','README.md','PRIVACY.md','CHECKPOINT.md','SUBMISSION-v0.1.9.md'];
const local = [], central = []; let offset = 0;
for (const file of files) {
  const name = Buffer.from(file), data = fs.readFileSync(path.join(root, file)), compressed = zlib.deflateRawSync(data), crc = crc32(data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(8,8); header.writeUInt16LE(0x21,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
  local.push(header,name,compressed);
  const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20,4); entry.writeUInt16LE(20,6); entry.writeUInt16LE(8,10); entry.writeUInt16LE(0x21,14); entry.writeUInt32LE(crc,16); entry.writeUInt32LE(compressed.length,20); entry.writeUInt32LE(data.length,24); entry.writeUInt16LE(name.length,28); entry.writeUInt32LE(offset,42);
  central.push(entry,name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
fs.mkdirSync(path.join(root,'dist'), { recursive:true });
const zip = Buffer.concat([...local,directory,end]); const version = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version; const output = path.join(root,'dist',`tmp.chat-${version}.zip`); fs.writeFileSync(output,zip);
console.log(`${output} (${(zip.length / 1024).toFixed(1)} KiB)`);
