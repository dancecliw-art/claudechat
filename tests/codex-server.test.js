// End-to-end test of ClaudeChat's Codex runner: starts server.js with tests/fake-codex.js
// standing in for `codex app-server` (replaying recorded sessions), then drives it over HTTP
// like the web page does. Run: node tests/codex-server.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claudechat-codex-test-'));
const WORK = path.join(TMP, 'project');
fs.mkdirSync(WORK);
const PORT = 46000 + Math.floor(Math.random() * 2000);
const LOG = path.join(TMP, 'codex-log.jsonl');

// The runner spawns CODEX_BIN with one argument (app-server), so wrap the fake in a launcher.
const win = process.platform === 'win32';
const launcher = path.join(TMP, win ? 'codex.cmd' : 'codex');
fs.writeFileSync(launcher, win
  ? `@"${process.execPath}" "${path.join(__dirname, 'fake-codex.js')}" %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-codex.js')}" "$@"\n`);
fs.chmodSync(launcher, 0o755);

const scenario = {
  turns: [
    'codex-approve-command.jsonl', // 1: agent asks to write outside its folder -> we allow
    'codex-decline-edits.jsonl', // 2: resumed thread; outside edit, inside edit, rm -rf
    { say: 'On it. @Beta please run the tests.' }, // 3: group, Alpha hands off
    { say: 'All 12 tests pass.' }, // 4: Beta answers
    { say: 'Here is my plan.' }, // 5: plan-mode agent
    'codex-approve-command.jsonl', // 6: stopped while its approval is pending
    { command: 'python upload_video.py --file=final.mp4' }, // 7: video upload, "always" given
    { command: 'python upload_video.py --file=final.mp4' }, // 8: asks again anyway
  ],
};
fs.writeFileSync(path.join(TMP, 'scenario.json'), JSON.stringify(scenario));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), CLAUDECHAT_DATA: path.join(TMP, 'data'), CODEX_BIN: launcher,
    AGY_BIN: '', FAKE_CODEX_SCENARIO: path.join(TMP, 'scenario.json'), FAKE_CODEX_STATE: path.join(TMP, 'state'),
    FAKE_CODEX_LOG: LOG, FAKE_CODEX_CWD: WORK,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: '/api' + p, headers: { Host: `localhost:${PORT}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(60);
  }
}
const codexLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sent = (method) => codexLog().filter((e) => e.in?.method === method).map((e) => e.in.params);
const idle = (id) => waitFor('the agent to finish', async () => { const c = await call('GET', `/chats/${id}`); return !c.running && c; });
async function approve(chatId, decision, note) {
  const card = await waitFor('an approval card', async () => {
    const c = await call('GET', `/chats/${chatId}`);
    return c.messages?.find((m) => m.role === 'approval' && m.approval.status === 'pending');
  });
  await call('POST', `/chats/${chatId}/approvals/${card.approval.id}`, { decision, note });
  return card.approval;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let agent;

test('Codex shows up as an available provider with its models', async () => {
  const meta = await waitFor('the server', () => call('GET', '/meta').catch(() => null));
  const p = meta.providers.codex;
  assert.ok(p, 'codex provider listed');
  assert.strictEqual(p.available, true);
  assert.ok(p.models.some((m) => m.id === 'gpt-5.5' && m.efforts.includes('xhigh')));
});

test('a risky command asks, Allow lets it run, the reply streams in and the thread is kept', async () => {
  agent = await call('POST', '/chats', { name: 'Codey', provider: 'codex', model: 'gpt-5.5', effort: 'high', cwd: WORK, permissionMode: 'smart' });
  assert.strictEqual(agent.provider, 'codex');
  assert.strictEqual(agent.model, 'gpt-5.5');
  await call('POST', `/chats/${agent.id}/messages`, { text: 'write a file' });
  const asked = await approve(agent.id, 'allow');
  assert.strictEqual(asked.tool, process.platform === 'win32' ? 'PowerShell' : 'Bash');
  assert.strictEqual(asked.summary, 'echo hi > /root/outside_codex_test.txt');
  const c = await idle(agent.id);
  const roles = c.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'tool', 'approval', 'assistant']);
  assert.strictEqual(c.messages[1].tool.status, 'done');
  assert.strictEqual(c.messages[2].approval.status, 'allowed');
  assert.strictEqual(c.messages[3].text, 'Wrote the file.');
  assert.ok(c.sessionId, 'thread id stored as sessionId');
  assert.ok(c.stats.turns === 1 && c.stats.tokens > 0, JSON.stringify(c.stats));

  const [start] = sent('thread/start');
  assert.deepStrictEqual([start.approvalPolicy, start.sandbox, start.model, start.cwd], ['untrusted', 'workspace-write', 'gpt-5.5', WORK]);
  assert.strictEqual(sent('turn/start')[0].effort, 'high');
  assert.deepStrictEqual(codexLog().filter((e) => e.decision !== undefined).map((e) => e.decision), ['accept']);
});

test('the next message resumes the thread; safe edits run, a denial note is steered in', async () => {
  await call('POST', `/chats/${agent.id}/messages`, { text: 'more' });
  await approve(agent.id, 'deny', 'keep it inside the project');
  await approve(agent.id, 'deny');
  const c = await idle(agent.id);
  const [resume] = sent('thread/resume');
  assert.ok(resume, 'thread/resume sent');
  assert.strictEqual(resume.threadId, agent.sessionId || c.sessionId);
  // outside edit: declined by you, inside edit: accepted without asking, rm -rf: declined.
  assert.deepStrictEqual(codexLog().filter((e) => e.decision !== undefined).map((e) => e.decision), ['accept', 'decline', 'accept', 'decline']);
  const steer = sent('turn/steer');
  assert.strictEqual(steer.length, 1);
  assert.match(steer[0].input[0].text, /keep it inside the project/);
  const tools = c.messages.filter((m) => m.role === 'tool').slice(1).map((m) => [m.tool.name, m.tool.status]);
  assert.deepStrictEqual(tools, [['Write', 'error'], ['Write', 'error'], [process.platform === 'win32' ? 'PowerShell' : 'Bash', 'error']]);
  assert.strictEqual(c.messages[c.messages.length - 1].text, "OK, I won't delete it.");
});

test('Codex agents work in a team-talk group: an @mention hands off to the next agent', async () => {
  const alpha = await call('POST', '/chats', { name: 'Alpha', provider: 'codex', model: 'gpt-5.5', cwd: WORK });
  const beta = await call('POST', '/chats', { name: 'Beta', provider: 'codex', model: 'gpt-6-luna', cwd: WORK });
  const group = await call('POST', '/chats', { type: 'group', name: 'Team', members: [alpha.id, beta.id], teamTalk: true });
  const before = sent('thread/start').length;
  await call('POST', `/chats/${group.id}/messages`, { text: '@Alpha start the release' });
  const g = await idle(group.id);
  const said = g.messages.filter((m) => m.role === 'assistant').map((m) => `${m.from.name}: ${m.text}`);
  assert.deepStrictEqual(said, ['Alpha: On it. @Beta please run the tests.', 'Beta: All 12 tests pass.']);
  assert.ok(g.memberSessions[alpha.id] && g.memberSessions[beta.id], 'each member keeps its own thread');
  const starts = sent('thread/start').slice(before);
  assert.strictEqual(starts.length, 2);
  assert.match(starts[0].developerInstructions, /You are "Alpha"/);
  assert.match(starts[0].developerInstructions, /@Beta/);
  assert.strictEqual(starts[1].model, 'gpt-6-luna');
  // Group turns count toward each agent's own stats.
  const a = await call('GET', `/chats/${alpha.id}`);
  assert.strictEqual(a.stats.turns, 1);
});

test('plan mode runs Codex with a read-only sandbox', async () => {
  const planner = await call('POST', '/chats', { name: 'Planner', provider: 'codex', model: 'gpt-5.5', cwd: WORK, permissionMode: 'plan' });
  await call('POST', `/chats/${planner.id}/messages`, { text: 'plan it' });
  await idle(planner.id);
  const start = sent('thread/start').pop();
  assert.deepStrictEqual([start.approvalPolicy, start.sandbox], ['never', 'read-only']);
  assert.match(start.developerInstructions, /plan mode/);
});

test('Stop while an approval is pending ends the turn and expires the card', async () => {
  await call('POST', `/chats/${agent.id}/messages`, { text: 'once more' });
  await waitFor('an approval card', async () => (await call('GET', `/chats/${agent.id}`)).approvals === 1);
  await call('POST', `/chats/${agent.id}/stop`);
  const c = await idle(agent.id);
  const card = c.messages.filter((m) => m.role === 'approval').pop();
  assert.strictEqual(card.approval.status, 'expired');
  assert.strictEqual(c.approvals, 0);
  assert.ok(c.messages.some((m) => m.role === 'system' && m.text === 'Stopped.'));
});

test('a video upload always asks: no Always allow, and old rules do not cover it', async () => {
  // Even an existing rule for this exact command must not skip the question.
  await call('PATCH', `/chats/${agent.id}`, { allowRules: ['Bash:python upload_video.py'] });
  for (const round of [1, 2]) {
    await call('POST', `/chats/${agent.id}/messages`, { text: `post the video ${round}` });
    const card = await approve(agent.id, 'always');
    assert.strictEqual(card.noAlways, true, 'the card has no Always allow button');
    assert.match(card.reasons[0], /Uploads a video online/);
    await idle(agent.id);
  }
  const c = await call('GET', `/chats/${agent.id}`);
  const cards = c.messages.filter((m) => m.role === 'approval').slice(-2);
  assert.deepStrictEqual(cards.map((m) => m.approval.status), ['allowed', 'allowed'], '"always" counts as a one-time allow');
  assert.deepStrictEqual(c.allowRules, ['Bash:python upload_video.py'], 'no new rule was saved');
  await call('PATCH', `/chats/${agent.id}`, { allowRules: [] });
});

test('an agent can be duplicated (same settings, fresh memory) and archived', async () => {
  const copy = await call('POST', `/chats/${agent.id}/duplicate`);
  assert.strictEqual(copy.name, 'Codey (copy)');
  assert.deepStrictEqual([copy.provider, copy.model, copy.cwd, copy.permissionMode], ['codex', 'gpt-5.5', WORK, 'smart']);
  assert.strictEqual(copy.sessionId, null);
  assert.strictEqual(copy.messageCount, 0);
  const archived = await call('PATCH', `/chats/${copy.id}`, { archived: true });
  assert.strictEqual(archived.archived, true);
  const list = await call('GET', '/chats');
  assert.strictEqual(list.find((c) => c.id === copy.id).archived, true);
});

test('messages can be starred and show up in the starred list', async () => {
  const c = await call('GET', `/chats/${agent.id}`);
  const reply = c.messages.find((m) => m.role === 'assistant');
  await call('PATCH', `/chats/${agent.id}/messages/${reply.id}`, { starred: true });
  let list = await call('GET', '/starred');
  assert.deepStrictEqual(list.map((s) => [s.chatId, s.message.id]), [[agent.id, reply.id]]);
  await call('PATCH', `/chats/${agent.id}/messages/${reply.id}`, { starred: false });
  list = await call('GET', '/starred');
  assert.strictEqual(list.length, 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✕ ${name}\n${e.stack}`); }
    if (failed) break; // later steps build on earlier ones
  }
  server.kill();
  if (failed) console.log('--- server output ---\n' + serverOut.slice(-4000));
  console.log(`${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
