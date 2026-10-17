// YouTube for agents, end to end: server.js talks to a fake Google (OAuth + YouTube Data API)
// and an agent (tests/fake-codex.js) asks to upload a video and change the channel.
// Every action must wait for Allow/Deny. Run: node tests/youtube.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claudechat-yt-test-'));
const WORK = path.join(TMP, 'project');
fs.mkdirSync(WORK);
const VIDEO = path.join(WORK, 'clip.mp4');
fs.writeFileSync(VIDEO, Buffer.alloc(4096, 7));
const PORT = 48000 + Math.floor(Math.random() * 1000);
const LOG = path.join(TMP, 'codex-log.jsonl');

// ---- fake Google ----
const google = { uploads: [], channel: { id: 'UC123', snippet: { title: 'My Channel' }, brandingSettings: { channel: { title: 'My Channel', description: 'Old description', keywords: 'games fun' } } }, tokenCalls: [] };
const gserver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body.toString());
      google.tokenCalls.push(Object.fromEntries(f));
      if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'good-code') return send(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
      return send(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer at1') return send(401, { error: { message: 'bad token' } });
    if (u.pathname === '/youtube/v3/channels' && req.method === 'GET') return send(200, { items: [google.channel] });
    if (u.pathname === '/youtube/v3/channels' && req.method === 'PUT') {
      const b = JSON.parse(body.toString());
      google.lastPut = b;
      // Like YouTube can: apply the description, ignore the name change.
      google.channel.brandingSettings = { ...b.brandingSettings, channel: { ...b.brandingSettings.channel, title: google.channel.snippet.title } };
      return send(200, { id: b.id, brandingSettings: google.channel.brandingSettings });
    }
    if (u.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
      google.meta = JSON.parse(body.toString());
      google.declaredSize = req.headers['x-upload-content-length'];
      return send(200, {}, { Location: `http://127.0.0.1:${gserver.address().port}/session/1` });
    }
    if (u.pathname === '/session/1' && req.method === 'PUT') {
      google.uploads.push(body.length);
      return send(200, { id: 'vid123' });
    }
    send(404, { error: { message: 'not found' } });
  });
});

let server;
let serverOut = '';
const win = process.platform === 'win32';
const launcher = path.join(TMP, win ? 'codex.cmd' : 'codex');

function call(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: '/api' + p, headers: { Host: `localhost:${PORT}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j; try { j = JSON.parse(d || '{}'); } catch { j = { text: d }; } resolve({ code: res.statusCode, ...j }); });
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
async function decide(chatId, tool, decision, note) {
  const card = await waitFor(`a ${tool} card`, async () => (await call('GET', `/chats/${chatId}`)).messages?.find((m) => m.role === 'approval' && m.approval.status === 'pending' && m.approval.tool === tool));
  await call('POST', `/chats/${chatId}/approvals/${card.approval.id}`, { decision, note });
  return card.approval;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let agent, key;

test('connecting YouTube: save the Google app, sign in, come back connected', async () => {
  let st = await call('GET', '/youtube');
  assert.deepStrictEqual([st.configured, st.connected], [false, false]);
  const bad = await call('POST', '/youtube/config', { clientId: 'nope', clientSecret: 'x' });
  assert.notStrictEqual(bad.code, 200);
  st = await call('POST', '/youtube/config', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  assert.strictEqual(st.configured, true);
  const { url } = await call('POST', '/youtube/connect');
  const auth = new URL(url);
  assert.strictEqual(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube');
  assert.strictEqual(auth.searchParams.get('redirect_uri'), `http://127.0.0.1:${PORT}/api/youtube/callback`);
  assert.strictEqual(auth.searchParams.get('access_type'), 'offline');
  const stale = await call('GET', `/youtube/callback?code=good-code&state=wrong`);
  assert.match(stale.text, /stale/);
  const page = await call('GET', `/youtube/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.match(page.text, /YouTube connected/);
  st = await call('GET', '/youtube');
  assert.deepStrictEqual([st.connected, st.channel.title], [true, 'My Channel']);
  assert.ok(!JSON.stringify(st).includes('GOCSPX'), 'the secret is never sent back to the page');
});

test('without a running agent\'s ID the API refuses', async () => {
  const r = await call('POST', '/youtube/agent', { action: 'upload', file: VIDEO }, { 'X-ClaudeChat-Agent': 'made-up' });
  assert.strictEqual(r.code, 403);
});

test('an agent gets a private ID in its environment and the YouTube how-to in its instructions', async () => {
  agent = await call('POST', '/chats', { name: 'Uploader', provider: 'codex', model: 'gpt-5.5', cwd: WORK, permissionMode: 'ask' });
  await call('POST', `/chats/${agent.id}/messages`, { text: 'upload clip.mp4' });
  const env = await waitFor('the agent to start', () => codexLog().find((e) => e.env?.agent)?.env);
  assert.strictEqual(codexLog().find((e) => e.env).env.agent, null, 'background calls (the model list) get no ID');
  assert.ok(env.agent && env.agent.length > 20);
  assert.strictEqual(env.url, `http://localhost:${PORT}`);
  key = env.agent;
  const start = await waitFor('thread/start', () => codexLog().find((e) => e.in?.method === 'thread/start')?.in.params);
  assert.match(start.developerInstructions, /api\/youtube\/agent/);
  // The turn is now waiting on its own command card, so the ID stays valid meanwhile.
  await waitFor('the command card', async () => (await call('GET', `/chats/${agent.id}`)).approvals === 1);
});

test('an upload asks first (no Always allow), then really uploads', async () => {
  const pending = call('POST', '/youtube/agent', { action: 'upload', file: VIDEO, title: 'My clip', description: 'Made by an agent', privacy: 'public', tags: ['a', 'b'] }, { 'X-ClaudeChat-Agent': key });
  const card = await decide(agent.id, 'YouTube upload', 'always'); // "always" must count as once
  assert.strictEqual(card.noAlways, true);
  assert.match(card.summary, /Upload “My clip” to My Channel \(public\)/);
  assert.match(card.reasons.join(' '), /publicly/);
  const r = await pending;
  assert.deepStrictEqual([r.status, r.url, r.privacy], ['done', 'https://youtu.be/vid123', 'public']);
  assert.deepStrictEqual(google.uploads, [4096]);
  assert.strictEqual(google.declaredSize, '4096');
  assert.deepStrictEqual([google.meta.snippet.title, google.meta.snippet.description, google.meta.status.privacyStatus], ['My clip', 'Made by an agent', 'public']);
  const c = await call('GET', `/chats/${agent.id}`);
  assert.ok(c.messages.some((m) => m.role === 'system' && m.text.includes('https://youtu.be/vid123')));
  assert.deepStrictEqual(c.allowRules, [], 'no rule saved');
});

test('the next upload asks again, and a denial is passed back', async () => {
  const pending = call('POST', '/youtube/agent', { action: 'upload', file: VIDEO }, { 'X-ClaudeChat-Agent': key });
  await decide(agent.id, 'YouTube upload', 'deny', 'not this one');
  const r = await pending;
  assert.deepStrictEqual([r.status, r.note], ['denied', 'not this one']);
  assert.strictEqual(google.uploads.length, 1, 'nothing uploaded');
});

test('changing the channel keeps other settings and says what YouTube did not apply', async () => {
  const pending = call('POST', '/youtube/agent', { action: 'channel', title: 'New Name', description: 'New description' }, { 'X-ClaudeChat-Agent': key });
  const card = await decide(agent.id, 'YouTube channel', 'allow');
  assert.match(card.summary, /New channel name: New Name/);
  const r = await pending;
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(r.notApplied, ['title']);
  assert.strictEqual(google.channel.brandingSettings.channel.description, 'New description');
  assert.strictEqual(google.lastPut.brandingSettings.channel.keywords, 'games fun', 'other branding settings kept');
  const c = await call('GET', `/chats/${agent.id}`);
  assert.ok(c.messages.some((m) => m.role === 'system' && /didn't apply the title/.test(m.text)));
});

test('bad requests are refused before anyone is asked', async () => {
  const r1 = await call('POST', '/youtube/agent', { action: 'upload', file: path.join(WORK, 'missing.mp4') }, { 'X-ClaudeChat-Agent': key });
  assert.deepStrictEqual([r1.code, r1.status], [400, 'error']);
  fs.writeFileSync(path.join(WORK, 'notes.txt'), 'x');
  const r2 = await call('POST', '/youtube/agent', { action: 'upload', file: path.join(WORK, 'notes.txt') }, { 'X-ClaudeChat-Agent': key });
  assert.match(r2.error, /isn’t a video/);
  const r3 = await call('POST', '/youtube/agent', { action: 'delete' }, { 'X-ClaudeChat-Agent': key });
  assert.strictEqual(r3.code, 400);
});

test('when the turn ends, its ID stops working', async () => {
  await decide(agent.id, process.platform === 'win32' ? 'PowerShell' : 'Bash', 'deny');
  await waitFor('the turn to end', async () => !(await call('GET', `/chats/${agent.id}`)).running);
  const r = await call('POST', '/youtube/agent', { action: 'upload', file: VIDEO }, { 'X-ClaudeChat-Agent': key });
  assert.strictEqual(r.code, 403);
});

test('disconnecting forgets the login', async () => {
  const st = await call('POST', '/youtube/disconnect');
  assert.strictEqual(st.connected, false);
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'youtube.json'), 'utf8'));
  assert.ok(!saved.tokens);
});

(async () => {
  await new Promise((r) => gserver.listen(0, '127.0.0.1', r));
  const g = `http://127.0.0.1:${gserver.address().port}`;
  fs.writeFileSync(launcher, win
    ? `@"${process.execPath}" "${path.join(__dirname, 'fake-codex.js')}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-codex.js')}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(path.join(TMP, 'scenario.json'), JSON.stringify({ turns: [{ command: 'echo working' }] }));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), CLAUDECHAT_DATA: path.join(TMP, 'data'), CODEX_BIN: launcher, AGY_BIN: '',
      FAKE_CODEX_SCENARIO: path.join(TMP, 'scenario.json'), FAKE_CODEX_STATE: path.join(TMP, 'state'), FAKE_CODEX_LOG: LOG, FAKE_CODEX_CWD: WORK,
      CLAUDECHAT_YT_AUTH_URL: `${g}/auth`, CLAUDECHAT_YT_TOKEN_URL: `${g}/token`, CLAUDECHAT_YT_API: g,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  await waitFor('the server', () => call('GET', '/meta').catch(() => null));
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✕ ${name}\n${e.stack}`); break; }
  }
  server.kill();
  gserver.close();
  if (failed) console.log('--- server output ---\n' + serverOut.slice(-3000));
  console.log(`${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
