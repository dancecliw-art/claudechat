// The Windows exe bundles server.js with its local modules inlined. This checks the bundle
// on any OS (the exe itself can only be built on Windows). Run: node tests/build.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { bundleSource } = require('../build/build-exe.js');

const src = bundleSource();
assert.ok(!/require\('\.\//.test(src), 'every local require is inlined');
assert.ok(src.includes('__claudechat_danger') && src.includes('__claudechat_codex'));
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudechat-bundle-')), 'claudechat.js');
fs.writeFileSync(file, src);
execFileSync(process.execPath, ['--check', file]);
console.log('  ✓ exe bundle inlines danger.js and codex.js and parses');
console.log('1/1 passed');
