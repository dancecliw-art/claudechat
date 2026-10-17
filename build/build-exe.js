// Builds dist/exe-builder/ClaudeChat.exe: a Node single-executable app (Node runtime +
// bundled server + embedded web files). Windows x64. Run: node build/build-exe.js
//
// Steps: bundle server.js + danger.js + codex.js + youtube.js -> SEA blob with public/ as assets -> copy node.exe ->
// inject blob (build/inject.cs, compiled with Windows' built-in csc) -> flip the SEA fuse.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Assemble in the temp folder: antivirus scanning a just-written exe on the Desktop can lock
// it between steps (EndUpdateResource error 110). Only the finished exe is copied to dist/.
const WORK = path.join(require('os').tmpdir(), 'claudechat-build');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// server.js with its local modules inlined: each require('./x') becomes an inline module.
// Exported so tests can check the bundle on any OS.
const LOCAL_MODULES = ['danger', 'codex', 'youtube'];
function bundleSource() {
  let server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  let head = '';
  for (const name of LOCAL_MODULES) {
    const marker = `require('./${name}')`;
    if (!server.includes(marker)) throw new Error(`server.js no longer contains ${marker}; update the bundler.`);
    const src = fs.readFileSync(path.join(ROOT, `${name}.js`), 'utf8');
    if (/require\('\.\//.test(src)) throw new Error(`${name}.js requires a local file; the bundler only inlines server.js's own.`);
    const v = `__claudechat_${name}`;
    head += `const ${v} = (() => { const module = { exports: {} }; const exports = module.exports;\n${src}\nreturn module.exports; })();\n`;
    server = server.split(marker).join(v);
  }
  return head + server;
}
if (require.main !== module) { module.exports = { bundleSource }; return; }

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error(`This build makes a Windows x64 exe and must run on Windows x64 Node (this is ${process.platform}-${process.arch}).`);
  process.exit(1);
}

function step(msg) { console.log(`\n> ${msg}`); }

// Fresh output folder: never overwrite an earlier build.
function outputDir() {
  const base = path.join(ROOT, 'dist', 'exe-builder');
  if (!fs.existsSync(base) || fs.readdirSync(base).length === 0) return base;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(base, `build-${stamp}`);
}

// Clear only this script's own intermediates. Never wipe the folder: if someone runs the
// intermediate exe from here, its data/ (their chats) lives in this folder too.
fs.mkdirSync(WORK, { recursive: true });
for (const f of ['claudechat.js', 'sea-config.json', 'sea-prep.blob', 'ClaudeChat.exe', 'inject.exe', 'icon.exe', 'ClaudeChat.ico']) {
  fs.rmSync(path.join(WORK, f), { force: true });
}

step(`Bundling server.js + ${LOCAL_MODULES.map((n) => n + '.js').join(' + ')}`);
const bundle = bundleSource();
const bundlePath = path.join(WORK, 'claudechat.js');
fs.writeFileSync(bundlePath, bundle);

step('Collecting web files as embedded assets');
const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else assets[path.relative(ROOT, p).split(path.sep).join('/')] = p;
  }
})(path.join(ROOT, 'public'));
console.log(Object.keys(assets).join(', '));

step('Generating the single-executable blob');
const blobPath = path.join(WORK, 'sea-prep.blob');
const configPath = path.join(WORK, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify({
  // Relative on purpose: Node stores this path inside the exe, and an absolute one would
  // leak the builder's Windows username (C:\Users\<name>\...).
  main: path.basename(bundlePath),
  output: path.basename(blobPath),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.basename(configPath)], { stdio: 'inherit', cwd: WORK });

step(`Copying the Node runtime (${process.version})`);
const exeTmp = path.join(WORK, 'ClaudeChat.exe');
fs.copyFileSync(process.execPath, exeTmp);

step('Compiling the injector with the built-in C# compiler');
if (!fs.existsSync(CSC)) throw new Error(`C# compiler not found at ${CSC}`);
const injector = path.join(WORK, 'inject.exe');
execFileSync(CSC, ['/nologo', '/optimize', `/out:${injector}`, path.join(__dirname, 'inject.cs')], { stdio: 'inherit' });

step('Injecting the app into the exe');
execFileSync(injector, [exeTmp, blobPath], { stdio: 'inherit' });

step('Drawing and setting the app icon');
const iconTool = path.join(WORK, 'icon.exe');
const icoPath = path.join(WORK, 'ClaudeChat.ico');
execFileSync(CSC, ['/nologo', '/optimize', '/r:System.Drawing.dll', `/out:${iconTool}`, path.join(__dirname, 'icon.cs')], { stdio: 'inherit' });
execFileSync(iconTool, [exeTmp, icoPath], { stdio: 'inherit' });

step('Flipping the SEA fuse and making it a windowed app (no console)');
const exe = fs.readFileSync(exeTmp);
const at = exe.indexOf(Buffer.from(`${FUSE}:0`));
if (at < 0) throw new Error('SEA fuse not found in the Node binary.');
if (exe.indexOf(Buffer.from(`${FUSE}:0`), at + 1) >= 0) throw new Error('SEA fuse found more than once.');
exe[at + FUSE.length + 1] = '1'.charCodeAt(0);
const pe = exe.readInt32LE(0x3c);
const subsystemAt = pe + 4 + 20 + 68; // IMAGE_OPTIONAL_HEADER.Subsystem
if (exe.readUInt16LE(subsystemAt) !== 3) throw new Error('Unexpected PE subsystem; expected a console exe.');
exe.writeUInt16LE(2, subsystemAt); // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(exeTmp, exe);

const out = outputDir();
fs.mkdirSync(out, { recursive: true });
const final = path.join(out, 'ClaudeChat.exe');
fs.copyFileSync(exeTmp, final);
fs.copyFileSync(icoPath, path.join(out, 'ClaudeChat.ico'));
const size = fs.statSync(final).size;
console.log(`\nBuilt ${final} (${(size / 1048576).toFixed(1)} MB)`);
