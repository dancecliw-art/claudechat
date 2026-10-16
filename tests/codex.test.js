// Unit tests for codex.js, using events recorded from a real `codex app-server`
// (codex-cli 0.163.0, see tests/fixtures). Run: node tests/codex.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const codex = require('../codex');
const { assess } = require('../danger');

const FIX = path.join(__dirname, 'fixtures');
const lines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- unwrapShell ----------
test('unwrapShell strips the shell Codex runs commands with', () => {
  assert.strictEqual(codex.unwrapShell("/bin/bash -lc 'rm -rf build'"), 'rm -rf build');
  assert.strictEqual(codex.unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'' > a.txt'"), "echo 'hi' > a.txt");
  assert.strictEqual(codex.unwrapShell('bash -c "git push origin main"'), 'git push origin main');
  assert.strictEqual(codex.unwrapShell('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Remove-Item -Recurse x"'), 'Remove-Item -Recurse x');
  assert.strictEqual(codex.unwrapShell('pwsh.exe -NoProfile -Command "Get-ChildItem"'), 'Get-ChildItem');
  assert.strictEqual(codex.unwrapShell('cmd.exe /c del /q build'), 'del /q build');
  assert.strictEqual(codex.unwrapShell('ls -la'), 'ls -la');
  assert.strictEqual(codex.unwrapShell(''), '');
});

test('without unwrapping, danger.js would miss a quoted risky command', () => {
  // The reason this exists: danger.js ignores quoted text.
  assert.strictEqual(assess('Bash', { command: "bash -lc 'git push --force'" }, '/p', '/h').risky, false);
  assert.strictEqual(assess('Bash', { command: codex.unwrapShell("bash -lc 'git push --force'") }, '/p', '/h').risky, true);
  assert.ok(!assess('Bash', { command: "/bin/bash -lc 'rm -rf build'" }, '/p', '/h').reasons.includes('Deletes files'));
  assert.ok(assess('Bash', { command: codex.unwrapShell("/bin/bash -lc 'rm -rf build'") }, '/p', '/h').reasons.includes('Deletes files'));
});

// ---------- finding the binary ----------
test('resolveCodex prefers CODEX_BIN', () => {
  assert.strictEqual(codex.resolveCodex({ env: { CODEX_BIN: '/x/codex' }, exists: () => false }), '/x/codex');
});

test('resolveCodex finds codex on PATH (posix)', () => {
  const have = new Set(['/usr/bin/codex']);
  assert.strictEqual(codex.resolveCodex({ env: { PATH: '/bin:/usr/bin' }, platform: 'linux', home: '/home/u', exists: (p) => have.has(p) }), '/usr/bin/codex');
  assert.strictEqual(codex.resolveCodex({ env: { PATH: '/bin' }, platform: 'linux', home: '/home/u', exists: () => false }), null);
});

test('resolveCodex turns the Windows npm shim into the native codex.exe', () => {
  const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const native = path.win32.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  // nativeCodexIn joins with the host path module, so normalise separators before comparing.
  const norm = (p) => p.replace(/\//g, '\\');
  const have = new Set([path.win32.join(npm, 'codex.cmd'), native]);
  const exists = (p) => have.has(norm(p));
  const env = { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.strictEqual(norm(codex.resolveCodex({ env, platform: 'win32', arch: 'x64', home: 'C:\\Users\\u', exists })), native);
  // Without the native binary it falls back to the shim (spawned through a shell).
  have.delete(native);
  assert.strictEqual(norm(codex.resolveCodex({ env, platform: 'win32', arch: 'x64', home: 'C:\\Users\\u', exists })), path.win32.join(npm, 'codex.cmd'));
  // A standalone codex.exe on PATH wins.
  have.add('C:\\tools\\codex.exe');
  assert.strictEqual(codex.resolveCodex({ env: { ...env, Path: 'C:\\tools' }, platform: 'win32', arch: 'x64', home: 'C:\\Users\\u', exists }), 'C:\\tools\\codex.exe');
});

// ---------- models ----------
test('parseModelList reads the recorded model/list result', () => {
  const list = codex.parseModelList(JSON.parse(fs.readFileSync(path.join(FIX, 'codex-model-list.json'), 'utf8')));
  assert.ok(list.length >= 5);
  const def = list.find((m) => m.isDefault);
  assert.ok(def, 'one model is the default');
  for (const m of list) {
    assert.ok(m.id && m.name && Array.isArray(m.efforts) && m.efforts.length, `model ${m.id} has efforts`);
    assert.ok(typeof m.defaultEffort === 'string');
  }
  // The fallback list matches what the CLI reported.
  assert.deepStrictEqual(codex.CODEX_FALLBACK_MODELS.map((m) => m.id), list.map((m) => m.id));
});

test('codexEffort keeps a supported effort and falls back to the model default', () => {
  const models = codex.CODEX_FALLBACK_MODELS;
  assert.strictEqual(codex.codexEffort(models, { model: 'gpt-5.5', effort: 'high' }), 'high');
  assert.strictEqual(codex.codexEffort(models, { model: 'gpt-5.5', effort: 'ultra' }), 'medium');
  assert.strictEqual(codex.codexEffort(models, { model: 'gpt-6.1-sol', effort: 'ultra' }), 'ultra');
  assert.strictEqual(codex.codexEffort(models, { model: 'unknown', effort: 'low' }), 'low');
});

// ---------- permissions ----------
test('codexPolicy maps ClaudeChat permission modes', () => {
  assert.deepStrictEqual(codex.codexPolicy('smart'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  assert.deepStrictEqual(codex.codexPolicy('ask'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  assert.deepStrictEqual(codex.codexPolicy('acceptEdits'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  assert.deepStrictEqual(codex.codexPolicy('plan'), { approvalPolicy: 'never', sandbox: 'read-only' });
  assert.deepStrictEqual(codex.codexPolicy('auto'), { approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.deepStrictEqual(codex.codexPolicy('bypassPermissions'), { approvalPolicy: 'never', sandbox: 'danger-full-access' });
});

// Replays a recorded session the way the runner sees it: items by id, then the requests.
function requestsOf(name) {
  const items = new Map();
  const out = [];
  for (const m of lines(name)) {
    if (m.method === 'item/started' || m.method === 'item/completed') items.set(m.params.item.id, m.params.item);
    if (m.method && m.id !== undefined) out.push({ ...m, items: new Map(items) });
  }
  return out;
}

test('recorded command approval: outside-folder write is risky', () => {
  const [req] = requestsOf('codex-approve-command.jsonl');
  assert.strictEqual(req.method, 'item/commandExecution/requestApproval');
  const desc = codex.describeApproval(req.method, req.params, req.items, 'Bash');
  assert.strictEqual(desc.tool, 'Bash');
  assert.strictEqual(desc.input.command, 'echo hi > /root/outside_codex_test.txt');
  const a = codex.assessApproval(desc, assess, '/home/user/project', '/home/user');
  assert.strictEqual(a.risky, true);
  assert.match(a.reasons.join(' '), /outside the working folder/);
});

test('recorded edit approvals: outside is risky, inside is safe, rm -rf is risky', () => {
  const reqs = requestsOf('codex-decline-edits.jsonl');
  assert.deepStrictEqual(reqs.map((r) => r.method), ['item/fileChange/requestApproval', 'item/fileChange/requestApproval', 'item/commandExecution/requestApproval']);
  const verdicts = reqs.map((r) => codex.assessApproval(codex.describeApproval(r.method, r.params, r.items, 'Bash'), assess, '/home/user/project', '/home/user'));
  assert.strictEqual(verdicts[0].risky, true);
  assert.match(verdicts[0].summary, /add \/root\/outside_patch\.txt/);
  assert.strictEqual(verdicts[1].risky, false, verdicts[1].reasons.join());
  assert.strictEqual(verdicts[2].risky, true);
  assert.match(verdicts[2].reasons.join(' '), /Deletes files/);
});

test('a patch that deletes a file is risky even inside the folder', () => {
  const items = new Map([['p1', { type: 'fileChange', id: 'p1', changes: [{ path: '/proj/a.txt', kind: { type: 'delete' }, diff: '' }] }]]);
  const desc = codex.describeApproval('item/fileChange/requestApproval', { itemId: 'p1' }, items, 'Bash');
  const a = codex.assessApproval(desc, assess, '/proj', '/home');
  assert.strictEqual(a.risky, true);
  assert.deepStrictEqual(a.reasons, ['Deletes files']);
});

test('unknown server requests are not treated as approvals', () => {
  assert.strictEqual(codex.describeApproval('item/tool/requestUserInput', {}, new Map(), 'Bash'), null);
});

// ---------- items -> tool cards ----------
test('toolCard renders recorded command and file-change items', () => {
  const done = lines('codex-decline-edits.jsonl').filter((m) => m.method === 'item/completed').map((m) => m.params.item);
  const cards = done.map((i) => codex.toolCard(i, 'Bash')).filter(Boolean);
  assert.strictEqual(cards.length, 3);
  assert.deepStrictEqual(cards.map((c) => [c.name, c.status]), [['Write', 'error'], ['Write', 'error'], ['Bash', 'error']]);
  assert.strictEqual(cards[2].input.command, 'rm -rf build');
  assert.strictEqual(cards[2].result, 'Not run: declined');

  const ok = lines('codex-approve-command.jsonl').find((m) => m.method === 'item/completed' && m.params.item.type === 'commandExecution').params.item;
  const card = codex.toolCard(ok, 'Bash');
  assert.strictEqual(card.status, 'done');
  assert.strictEqual(card.result, 'Exit code 0');
});

test('toolCard skips messages and reasoning, handles MCP and web search', () => {
  assert.strictEqual(codex.toolCard({ type: 'agentMessage', id: 'a', text: 'hi' }, 'Bash'), null);
  assert.strictEqual(codex.toolCard({ type: 'reasoning', id: 'r', summary: [] }, 'Bash'), null);
  const mcp = codex.toolCard({ type: 'mcpToolCall', id: 'm', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'x' }, result: { content: [{ type: 'text', text: 'found' }] } }, 'Bash');
  assert.deepStrictEqual([mcp.name, mcp.status, mcp.result], ['docs.search', 'done', 'found']);
  assert.strictEqual(codex.toolCard({ type: 'webSearch', id: 'w', query: 'node sea' }, 'Bash').input.query, 'node sea');
  const long = codex.toolCard({ type: 'commandExecution', id: 'c', command: 'cat big', status: 'completed', aggregatedOutput: 'x'.repeat(7000), exitCode: 0 }, 'Bash');
  assert.ok(long.result.endsWith('(truncated)'));
});

// ---------- JSON-RPC ----------
test('createRpc + lineReader route responses, requests and notifications', async () => {
  const sent = [];
  const seen = [];
  const rpc = codex.createRpc((m) => sent.push(m), {
    onRequest: (method, params, id) => seen.push(['req', method, id]),
    onNotification: (method) => seen.push(['note', method]),
  });
  const p = rpc.request('initialize', { a: 1 });
  assert.deepStrictEqual(sent[0], { id: 1, method: 'initialize', params: { a: 1 } });
  const feed = codex.lineReader((m) => rpc.handle(m));
  const recorded = lines('codex-approve-command.jsonl');
  // Split mid-line to check buffering.
  const text = recorded.map((m) => JSON.stringify(m)).join('\n') + '\n';
  feed(Buffer.from(text.slice(0, 50)));
  feed(Buffer.from(text.slice(50)));
  assert.strictEqual((await p).platformFamily, 'unix');
  assert.ok(seen.some(([k, m]) => k === 'req' && m === 'item/commandExecution/requestApproval'));
  assert.ok(seen.some(([k, m]) => k === 'note' && m === 'item/agentMessage/delta'));
  assert.ok(seen.some(([k, m]) => k === 'note' && m === 'turn/completed'));
  rpc.respond(0, { decision: 'accept' });
  assert.deepStrictEqual(sent[1], { id: 0, result: { decision: 'accept' } });
  const failing = rpc.request('thread/resume', {});
  rpc.handle({ id: 2, error: { code: -32600, message: 'no such thread' } });
  await assert.rejects(failing, /no such thread/);
  const pending = rpc.request('turn/start', {});
  rpc.close('Codex exited');
  await assert.rejects(pending, /Codex exited/);
});

test('recorded deltas add up to the final message', () => {
  const ev = lines('codex-approve-command.jsonl');
  const deltas = ev.filter((m) => m.method === 'item/agentMessage/delta').map((m) => m.params.delta).join('');
  const final = ev.find((m) => m.method === 'item/completed' && m.params.item.type === 'agentMessage').params.item.text;
  assert.strictEqual(deltas, final);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✕ ${name}\n${e.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
