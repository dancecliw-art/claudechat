// Runs every tests/*.test.js in its own process. Run: node tests/run.js (or npm test)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let failed = 0;
for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  console.log(f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
