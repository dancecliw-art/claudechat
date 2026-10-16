// ClaudeChat — a WhatsApp-style messenger where every contact is a Claude Code agent.
// Zero dependencies: plain Node http + Server-Sent Events. Each agent runs the local
// `claude` CLI in headless stream-json mode and resumes its own session per message.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { assess } = require('./danger');

const PORT = Number(process.env.PORT) || 4317;

// Find the claude CLI: $CLAUDE_BIN, then PATH, then the default native-install location.
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) if (dir && fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  const local = path.join(os.homedir(), '.local', 'bin', names[0]);
  return fs.existsSync(local) ? local : 'claude';
}
const CLAUDE_BIN = resolveClaude();

// Packaged as ClaudeChat.exe (Node single-executable app): web files live inside the exe
// and data/ sits next to the exe. Run with plain node: everything is next to this file.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const APP_DIR = sea ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = process.env.CLAUDECHAT_DATA || path.join(APP_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'chats.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MODELS = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// 'smart' and 'ask' are ClaudeChat's own approval modes: the CLI runs in manual mode and
// sends every permission prompt here, where danger.js decides what needs the user.
const PERMISSION_MODES = ['smart', 'ask', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];
const CLI_MODE = { smart: 'manual', ask: 'manual' };
const AVATARS = ['🤖', '🧠', '🛠️', '🚀', '🦊', '🐙', '🦉', '⚡', '🧪', '🎨', '📚', '🔍', '👥', '🎯', '🐞', '💡'];
const COLORS = ['#25d366', '#53bdeb', '#ff8a65', '#c792ea', '#ffcb6b', '#f07178', '#89ddff', '#a5e075'];

// ---------- persistence ----------

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// The packaged exe has no console window, so its output goes to data/claudechat.log.
if (sea) {
  const util = require('util');
  const log = fs.createWriteStream(path.join(DATA_DIR, 'claudechat.log'), { flags: 'w' });
  const write = (...a) => log.write(`[${new Date().toLocaleTimeString()}] ${util.format(...a)}\n`);
  console.log = console.info = console.warn = console.error = write;
  process.on('uncaughtException', (e) => { write('Uncaught:', e && e.stack || e); });
}

let db = { chats: [], usage: null, costLog: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'chats.backup.json')); // last good copy, refreshed each start
} catch {}

// Upgrade chats saved by older versions and clear state left over from a previous run.
for (const c of db.chats) {
  c.type ??= 'agent';
  c.fullAccess ??= true;
  c.members ??= [];
  c.memberSessions ??= {};
  c.memberCursor ??= {};
  c.allowRules ??= [];
  if (!PERMISSION_MODES.includes(c.permissionMode)) c.permissionMode = 'smart';
  c.status = null;
  for (const m of c.messages) {
    if (m.approval?.status === 'pending') m.approval.status = 'expired';
    if (m.queued) { m.queued = false; m.notSent = true; }
    if (m.streaming) m.streaming = false;
    if (m.tool?.status === 'running') m.tool.status = 'error';
  }
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();
const findChat = (id) => db.chats.find((c) => c.id === id);

// ---------- live state ----------

const runs = new Map();   // chatId -> current run { proc, stopped, ... }
const busy = new Set();   // chatIds whose queue is being processed
const queues = new Map(); // chatId -> [{ messageId }]
const stopFlags = new Set();
const approvals = new Map(); // approvalId -> { chat, run, agent, requestId, input, ruleKey, message }

const pendingApprovals = (chatId) => [...approvals.values()].filter((a) => a.chat.id === chatId).length;

function summary(chat) {
  const { messages, ...rest } = chat;
  const last = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  return {
    ...rest,
    running: busy.has(chat.id),
    approvals: pendingApprovals(chat.id),
    queued: (queues.get(chat.id) || []).length,
    lastMessage: last || null,
    messageCount: messages.length,
  };
}

const clients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

function pushMessage(chat, msg) {
  const m = { id: uid(), ts: now(), ...msg };
  chat.messages.push(m);
  chat.updatedAt = m.ts;
  broadcast({ type: 'message', chatId: chat.id, message: m });
  return m;
}

function patchMessage(chat, m, patch) {
  Object.assign(m, patch);
  broadcast({ type: 'message_update', chatId: chat.id, message: m });
}

function setStatus(chat, status) {
  chat.status = status;
  broadcast({ type: 'status', chatId: chat.id, status, running: busy.has(chat.id) });
}

// ---------- drives & folders ----------

let driveCache = { at: 0, list: [] };
function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  if (now() - driveCache.at < 60000) return driveCache.list;
  const list = [];
  for (let i = 67; i <= 90; i++) { // C: … Z: (skip floppy letters)
    const d = String.fromCharCode(i) + ':\\';
    try { if (fs.existsSync(d)) list.push(d); } catch {}
  }
  driveCache = { at: now(), list };
  return list;
}

function places() {
  const home = os.homedir();
  const cands = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Desktop (OneDrive)', path.join(home, 'OneDrive', 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
  ];
  return cands.filter(([, p]) => fs.existsSync(p)).map(([name, p]) => ({ name, path: p }));
}

// ---------- usage (rate limits reported by the CLI) ----------

function updateUsage(info) {
  if (!info) return;
  const w = info.unifiedWindows || {};
  db.usage = {
    status: info.status,
    rateLimitType: info.rateLimitType,
    fiveHour: w.five_hour || db.usage?.fiveHour || null,
    sevenDay: w.seven_day || db.usage?.sevenDay || null,
    isUsingOverage: !!info.isUsingOverage,
    updatedAt: now(),
  };
  broadcast({ type: 'usage', usage: usageReport() });
}

function logCost(chat, cost) {
  if (!cost) return;
  db.costLog.push({ ts: now(), chatId: chat.id, cost });
  const cutoff = now() - 31 * 864e5;
  db.costLog = db.costLog.filter((e) => e.ts > cutoff);
}

function usageReport() {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = now() - 7 * 864e5;
  let today = 0, week = 0;
  const perChatToday = {};
  for (const e of db.costLog) {
    if (e.ts >= weekAgo) week += e.cost;
    if (e.ts >= startOfDay.getTime()) {
      today += e.cost;
      perChatToday[e.chatId] = (perChatToday[e.chatId] || 0) + e.cost;
    }
  }
  const agents = db.chats
    .map((c) => ({ id: c.id, name: c.name, avatar: c.avatar, color: c.color, today: perChatToday[c.id] || 0, total: c.totalCost || 0 }))
    .sort((a, b) => b.today - a.today || b.total - a.total);
  return { limits: db.usage, spend: { today, week }, agents };
}

// A tiny Haiku request, only to read the current limits.
function probeUsage() {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-5-5', '--effort', 'low'],{ cwd: os.tmpdir(), windowsHide: true });
    proc.stdin.end('Reply with just: ok');
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { const ev = JSON.parse(line); if (ev.type === 'rate_limit_event') updateUsage(ev.rate_limit_info); } catch {}
      }
    });
    proc.on('close', () => { save(); resolve(); });
    proc.on('error', () => resolve());
  });
}

// ---------- running the claude CLI ----------

function runOnce({ chat, agent, sessionId, systemPrompt, prompt, from }) {
  return new Promise((resolve) => {
    // Two-way stdio: the prompt goes in as a stream-json message, and the CLI sends its
    // permission prompts back to us as control requests (answered in onControlRequest).
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', agent.model, '--effort', agent.effort,
      '--permission-mode', CLI_MODE[agent.permissionMode] || agent.permissionMode,
      '--permission-prompt-tool', 'stdio',
    ];
    if (sessionId) args.push('--resume', sessionId);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    const dirs = new Set([UPLOAD_DIR]);
    if (agent.fullAccess !== false) for (const d of listDrives()) dirs.add(d);
    for (const d of dirs) args.push('--add-dir', d);

    let cwd = agent.cwd;
    if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();

    const proc = spawn(CLAUDE_BIN, args, { cwd, windowsHide: true, env: process.env });
    const run = { proc, agent, cwd, from, who: from?.name, sessionId, streamed: new Map(), streamedMsgIds: new Set(), tools: new Map(), pending: new Set(), stderr: '' };
    runs.set(chat.id, run);
    status(chat, run, 'typing…');
    proc.stdin.on('error', () => {});
    send(run, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null });

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        try { handleEvent(chat, run, ev); } catch (e) { console.error('event error', e); }
      }
    });
    proc.stderr.on('data', (d) => { run.stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      run.spawnError = true;
      pushMessage(chat, { role: 'system', text: `Could not start the claude CLI: ${err.message}. Is Claude Code installed and on your PATH?`, error: true });
    });
    proc.on('close', (code) => {
      runs.delete(chat.id);
      for (const id of run.pending) {
        const a = approvals.get(id);
        approvals.delete(id);
        if (a) patchMessage(chat, a.message, { approval: { ...a.message.approval, status: 'expired' } });
      }
      for (const m of run.streamed.values()) if (m.streaming) patchMessage(chat, m, { streaming: false });
      for (const m of run.tools.values()) if (m.tool.status === 'running') patchMessage(chat, m, { tool: { ...m.tool, status: 'error', result: run.stopped ? 'Stopped' : m.tool.result } });
      if (!run.gotResult && code !== 0 && !run.stopped && !run.spawnError) {
        const tail = run.stderr.trim().split('\n').slice(-6).join('\n');
        pushMessage(chat, { role: 'system', text: `${run.who ? run.who + ' ' : 'Agent '}exited (code ${code}).${tail ? '\n' + tail : ''}`, error: true });
      }
      save();
      resolve({ sessionId: run.sessionId, ok: run.gotResult && !run.isError, stopped: run.stopped });
    });
  });
}

function status(chat, run, s) {
  setStatus(chat, run.who ? `${run.who} is ${s}` : s);
}

function send(run, obj) {
  const s = run.proc.stdin;
  if (s.writable && !s.destroyed) s.write(JSON.stringify(obj) + '\n');
}

// ---------- approvals (Codex-style) ----------

function onControlRequest(chat, run, ev) {
  const req = ev.request || {};
  if (req.subtype !== 'can_use_tool') {
    console.log('[control] unsupported request', req.subtype);
    return send(run, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `Unsupported request: ${req.subtype}` } });
  }
  const agent = run.agent;
  const allow = () => send(run, { type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { behavior: 'allow', updatedInput: req.input } } });
  const a = assess(req.tool_name, req.input, run.cwd, os.homedir());
  const mustAsk = agent.permissionMode === 'ask' || a.risky;
  const remembered = (agent.allowRules || []).includes(a.ruleKey);
  console.log(`[control] ${agent.name}: ${req.tool_name} ${a.summary.slice(0, 80)} -> ${mustAsk && !remembered ? 'ASK' : 'allow'}${a.reasons.length ? ' (' + a.reasons.join('; ') + ')' : ''}`);
  if (!mustAsk || remembered) return allow();

  const id = uid();
  const message = pushMessage(chat, {
    role: 'approval',
    from: run.from,
    approval: {
      id,
      tool: req.tool_name,
      input: req.input,
      summary: a.summary,
      reasons: a.reasons.length ? a.reasons : ['This agent asks before every change'],
      agentName: agent.name,
      status: 'pending',
    },
  });
  approvals.set(id, { chat, run, agent, requestId: ev.request_id, input: req.input, ruleKey: a.ruleKey, message });
  run.pending.add(id);
  status(chat, run, 'waiting for your approval');
  broadcast({ type: 'chat', chat: summary(chat) });
}

function decideApproval(id, decision, note) {
  const p = approvals.get(id);
  if (!p) return false;
  approvals.delete(id);
  p.run.pending.delete(id);
  const { chat, run, agent } = p;
  if (decision === 'always' && !agent.allowRules.includes(p.ruleKey)) agent.allowRules.push(p.ruleKey);
  const allowed = decision === 'allow' || decision === 'always';
  if (!allowed) run.userDenials = (run.userDenials || 0) + 1;
  const response = allowed
    ? { behavior: 'allow', updatedInput: p.input }
    : { behavior: 'deny', message: note ? `The user denied this action and said: ${note}` : 'The user denied this action. Do not retry it. Take a different approach or ask the user.' };
  send(run, { type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response } });
  patchMessage(chat, p.message, { approval: { ...p.message.approval, status: allowed ? (decision === 'always' ? 'always' : 'allowed') : 'denied', note: note || undefined } });
  status(chat, run, run.pending.size ? 'waiting for your approval' : 'typing…');
  broadcast({ type: 'chat', chat: summary(chat) });
  save();
  return true;
}

function handleEvent(chat, run, ev) {
  if (ev.type === 'control_request') return onControlRequest(chat, run, ev);
  if (ev.type === 'control_cancel_request') {
    for (const [id, a] of approvals) if (a.requestId === ev.request_id) {
      approvals.delete(id); run.pending.delete(id);
      patchMessage(chat, a.message, { approval: { ...a.message.approval, status: 'expired' } });
    }
    return;
  }
  if (ev.type === 'rate_limit_event') return updateUsage(ev.rate_limit_info);
  // Sub-agent chatter stays out of the chat; only the main conversation shows.
  if (ev.parent_tool_use_id) return;

  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) run.sessionId = ev.session_id;
    return;
  }

  if (ev.type === 'stream_event') {
    const e = ev.event;
    const key = `${ev.api_message_id}:${e.index}`;
    if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
      const m = pushMessage(chat, { role: 'assistant', text: '', streaming: true, from: run.from });
      run.streamed.set(key, m);
      run.streamedMsgIds.add(ev.api_message_id);
      status(chat, run, 'typing…');
    } else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') {
      status(chat, run, 'thinking…');
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      const m = run.streamed.get(key);
      if (m) {
        m.text += e.delta.text;
        broadcast({ type: 'delta', chatId: chat.id, messageId: m.id, text: e.delta.text });
      }
    } else if (e.type === 'content_block_stop') {
      const m = run.streamed.get(key);
      if (m?.streaming) patchMessage(chat, m, { streaming: false });
    }
    return;
  }

  if (ev.type === 'assistant' && ev.message) {
    for (const block of ev.message.content || []) {
      if (block.type === 'text' && !run.streamedMsgIds.has(ev.message.id) && block.text?.trim()) {
        pushMessage(chat, { role: 'assistant', text: block.text, from: run.from });
      } else if (block.type === 'tool_use') {
        const m = pushMessage(chat, { role: 'tool', from: run.from, tool: { id: block.id, name: block.name, input: block.input, status: 'running' } });
        run.tools.set(block.id, m);
        status(chat, run, `using ${block.name}…`);
      }
    }
    return;
  }

  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type !== 'tool_result') continue;
      const m = run.tools.get(block.tool_use_id);
      if (!m) continue;
      let out = block.content;
      if (Array.isArray(out)) out = out.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      out = String(out ?? '');
      if (out.length > 6000) out = out.slice(0, 6000) + '\n… (truncated)';
      patchMessage(chat, m, { tool: { ...m.tool, status: block.is_error ? 'error' : 'done', result: out } });
    }
    status(chat, run, 'typing…');
    return;
  }

  if (ev.type === 'result') {
    run.gotResult = true;
    run.proc.stdin.end(); // one prompt per process; closing stdin lets the CLI exit
    run.isError = !!ev.is_error;
    if (ev.session_id) run.sessionId = ev.session_id;
    chat.totalCost = (chat.totalCost || 0) + (ev.total_cost_usd || 0);
    logCost(chat, ev.total_cost_usd);
    chat.lastTurn = { durationMs: ev.duration_ms, cost: ev.total_cost_usd, turns: ev.num_turns };
    if (ev.is_error) {
      const msg = ev.result || (ev.errors || []).join('\n') || ev.subtype || 'Unknown error';
      pushMessage(chat, { role: 'system', text: `${run.who ? run.who + ': ' : ''}Error: ${msg}`, error: true });
    }
    const denied = (ev.permission_denials || []).map((d) => d.tool_name).filter(Boolean);
    // Denials you made on an approval card are already visible there.
    if (denied.length > (run.userDenials || 0)) {
      pushMessage(chat, { role: 'system', text: `Blocked by permissions: ${[...new Set(denied)].join(', ')}. Change the agent's permission mode in its info panel to allow this.` });
    }
  }
}

// ---------- turns ----------

function promptFor(m) {
  let text = m.text || '';
  if (m.replyTo) text = `> Replying to ${m.replyTo.name}: "${m.replyTo.text}"\n\n${text}`;
  if (m.attachments?.length) {
    text += `\n\n[Attached files — open them with the Read tool]\n` + m.attachments.map((a) => `- ${a.path}`).join('\n');
  }
  return text;
}

async function runAgentTurn(chat, userMsg) {
  const r = await runOnce({ chat, agent: chat, sessionId: chat.sessionId, systemPrompt: chat.systemPrompt, prompt: promptFor(userMsg) });
  if (r.sessionId) chat.sessionId = r.sessionId;
}

function mentioned(text, members) {
  const t = (text || '').toLowerCase();
  if (t.includes('@all') || t.includes('@everyone')) return members;
  return members.filter((a) => t.includes('@' + a.name.toLowerCase()));
}

function groupSystemPrompt(group, agent, members) {
  const others = members.filter((a) => a.id !== agent.id).map((a) => a.name);
  return [
    `You are "${agent.name}", one member of a group chat called "${group.name}" in ClaudeChat, a WhatsApp-style app.`,
    `The group has the user and these other AI agents: ${others.join(', ') || 'none'}.`,
    'Each turn shows the newest group messages as "Name: message". Write only your own reply, without prefixing your name.',
    'Keep replies short and conversational unless the task needs more. Build on what the others said instead of repeating it.',
    'You can still use your tools.',
    group.systemPrompt ? `Group topic / instructions: ${group.systemPrompt}` : '',
    agent.systemPrompt ? `Your own instructions: ${agent.systemPrompt}` : '',
  ].filter(Boolean).join('\n');
}

async function runGroupTurn(group, userMsg) {
  const members = group.members.map(findChat).filter((a) => a && a.type === 'agent');
  if (!members.length) {
    pushMessage(group, { role: 'system', text: 'This group has no agents. Add some in the group info.' });
    return;
  }
  let responders = mentioned(userMsg.text, members);
  if (!responders.length) responders = members;

  for (const agent of responders) {
    if (stopFlags.has(group.id)) break;
    const cursor = group.memberCursor[agent.id] || 0;
    const fresh = group.messages.slice(cursor).filter((m) =>
      m.role === 'user' || (m.role === 'assistant' && m.from?.id !== agent.id && !m.streaming));
    const transcript = fresh.map((m) => `${m.role === 'user' ? 'User' : m.from?.name || 'Agent'}: ${m.role === 'user' ? promptFor(m) : m.text}`).join('\n\n');
    group.memberCursor[agent.id] = group.messages.length;
    const r = await runOnce({
      chat: group,
      agent,
      sessionId: group.memberSessions[agent.id],
      systemPrompt: groupSystemPrompt(group, agent, members),
      prompt: transcript || 'Continue.',
      from: { id: agent.id, name: agent.name, avatar: agent.avatar, color: agent.color },
    });
    if (r.sessionId) group.memberSessions[agent.id] = r.sessionId;
  }
}

async function processQueue(chat) {
  if (busy.has(chat.id)) return;
  busy.add(chat.id);
  stopFlags.delete(chat.id);
  try {
    const q = queues.get(chat.id) || [];
    while (q.length) {
      const item = q.shift();
      const msg = chat.messages.find((m) => m.id === item.messageId);
      if (!msg) continue;
      patchMessage(chat, msg, { queued: false });
      broadcast({ type: 'chat', chat: summary(chat) });
      if (chat.type === 'group') await runGroupTurn(chat, msg);
      else await runAgentTurn(chat, msg);
      patchMessage(chat, msg, { read: true });
      if (stopFlags.has(chat.id)) {
        for (const left of q.splice(0)) {
          const lm = chat.messages.find((m) => m.id === left.messageId);
          if (lm) patchMessage(chat, lm, { queued: false, notSent: true });
        }
        pushMessage(chat, { role: 'system', text: 'Stopped.' });
      }
    }
  } finally {
    busy.delete(chat.id);
    stopFlags.delete(chat.id);
    setStatus(chat, null);
    broadcast({ type: 'chat', chat: summary(chat) });
    save();
  }
}

function enqueue(chat, msg) {
  const m = pushMessage(chat, { role: 'user', ...msg, queued: true });
  if (!queues.has(chat.id)) queues.set(chat.id, []);
  queues.get(chat.id).push({ messageId: m.id });
  processQueue(chat);
  return m;
}

// ---------- HTTP ----------

function readBody(req, limit = 30e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function applySettings(chat, body) {
  if (typeof body.name === 'string' && body.name.trim()) chat.name = body.name.trim().slice(0, 60);
  if (typeof body.avatar === 'string' && body.avatar.trim()) chat.avatar = body.avatar.trim().slice(0, 8);
  if (MODELS[body.model]) chat.model = body.model;
  if (EFFORTS.includes(body.effort)) chat.effort = body.effort;
  if (PERMISSION_MODES.includes(body.permissionMode)) chat.permissionMode = body.permissionMode;
  if (typeof body.cwd === 'string') chat.cwd = body.cwd.trim();
  if (typeof body.systemPrompt === 'string') chat.systemPrompt = body.systemPrompt.slice(0, 8000);
  if (typeof body.pinned === 'boolean') chat.pinned = body.pinned;
  if (typeof body.muted === 'boolean') chat.muted = body.muted;
  if (typeof body.fullAccess === 'boolean') chat.fullAccess = body.fullAccess;
  if (Array.isArray(body.members)) chat.members = body.members.filter((id) => findChat(id)?.type === 'agent');
  if (typeof body.sessionId === 'string') {
    const s = body.sessionId.trim();
    if (!s || /^[0-9a-f-]{36}$/i.test(s)) chat.sessionId = s || null;
  }
  if (Array.isArray(body.allowRules)) chat.allowRules = body.allowRules.filter((r) => typeof r === 'string').slice(0, 200);
}

function exportMarkdown(chat) {
  const lines = [`# ${chat.avatar} ${chat.name}`, '', `Exported from ClaudeChat on ${new Date().toLocaleString()}`, ''];
  for (const m of chat.messages) {
    const t = new Date(m.ts).toLocaleString();
    if (m.role === 'user') lines.push(`**You** · ${t}`, '', promptFor(m), '');
    else if (m.role === 'assistant') lines.push(`**${m.from?.name || chat.name}** · ${t}`, '', m.text, '');
    else if (m.role === 'tool') lines.push(`> 🛠 ${m.tool.name}: \`${JSON.stringify(m.tool.input).slice(0, 200)}\``, '');
    else lines.push(`_${m.text}_`, '');
  }
  return lines.join('\n');
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };

function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // Agents can touch the whole PC, so only this machine's own page may drive them:
  // reject foreign Host headers (DNS rebinding) and cross-site writes (CSRF).
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) { res.writeHead(403); return res.end('Forbidden host'); }
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) { res.writeHead(403); return res.end('Forbidden origin'); }
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end('JSON only'); }
  }

  try {
    const url = new URL(req.url, `http://${host}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] !== 'api') {
      if (sea) {
        const key = 'public/' + (url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
        let body;
        try { body = Buffer.from(sea.getAsset(key)); } catch { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream' });
        return res.end(body);
      }
      const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      return serveFile(res, file);
    }

    const route = parts[1];

    if (route === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (route === 'meta') {
      return json(res, 200, { models: MODELS, efforts: EFFORTS, permissionModes: PERMISSION_MODES, home: os.homedir(), avatars: AVATARS, drives: listDrives(), platform: process.platform });
    }

    if (route === 'usage' && !parts[2]) return json(res, 200, usageReport());
    if (route === 'usage' && parts[2] === 'refresh' && req.method === 'POST') {
      await probeUsage();
      return json(res, 200, usageReport());
    }

    // ----- folder browser -----
    if (route === 'fs' && parts[2] === 'list') {
      const p = path.resolve(url.searchParams.get('path') || os.homedir());
      const showHidden = url.searchParams.get('hidden') === '1';
      let dirs = [];
      try {
        dirs = fs.readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .filter((n) => showHidden || !(n.startsWith('.') || n.startsWith('$') || ['System Volume Information', 'node_modules'].includes(n)))
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      } catch (e) {
        return json(res, 400, { error: `Can't open ${p}: ${e.code || e.message}` });
      }
      const parent = path.dirname(p);
      return json(res, 200, { path: p, parent: parent === p ? null : parent, dirs, drives: listDrives(), places: places() });
    }
    if (route === 'fs' && parts[2] === 'mkdir' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name || /[<>:"/\\|?*]/.test(name)) return json(res, 400, { error: 'Invalid folder name' });
      const p = path.join(path.resolve(body.path), name);
      fs.mkdirSync(p, { recursive: true });
      return json(res, 200, { path: p });
    }

    // ----- attachments -----
    if (route === 'uploads' && req.method === 'POST') {
      const body = await readBody(req);
      const safe = String(body.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);
      const fileName = `${uid()}-${safe}`;
      const file = path.join(UPLOAD_DIR, fileName);
      fs.writeFileSync(file, Buffer.from(String(body.data || ''), 'base64'));
      return json(res, 200, { name: safe, path: file, url: `/api/uploads/${encodeURIComponent(fileName)}`, type: body.type || '' });
    }
    if (route === 'uploads' && parts[2] && req.method === 'GET') {
      const file = path.join(UPLOAD_DIR, path.basename(parts[2]));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      return serveFile(res, file);
    }

    // ----- broadcast -----
    if (route === 'broadcast' && req.method === 'POST') {
      const body = await readBody(req);
      const results = [];
      for (const id of body.chatIds || []) {
        const chat = findChat(id);
        if (!chat) continue;
        enqueue(chat, { text: body.text, broadcast: true });
        results.push({ id, ok: true, queued: busy.has(id) });
      }
      save();
      return json(res, 200, { results });
    }

    // ----- chats -----
    if (route === 'chats') {
      const id = parts[2];

      if (!id && req.method === 'GET') {
        const list = db.chats.map(summary).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
        return json(res, 200, list);
      }

      if (!id && req.method === 'POST') {
        const body = await readBody(req);
        const n = db.chats.length;
        const isGroup = body.type === 'group';
        const chat = {
          id: uid(),
          type: isGroup ? 'group' : 'agent',
          name: isGroup ? 'New group' : 'New agent',
          avatar: isGroup ? '👥' : AVATARS[n % AVATARS.length],
          color: COLORS[n % COLORS.length],
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: 'smart',
          allowRules: [],
          fullAccess: true,
          cwd: os.homedir(),
          systemPrompt: '',
          sessionId: null,
          members: [],
          memberSessions: {},
          memberCursor: {},
          createdAt: now(),
          updatedAt: now(),
          totalCost: 0,
          pinned: false,
          muted: false,
          messages: [],
        };
        applySettings(chat, body);
        if (isGroup) pushMessage(chat, { role: 'system', text: `Group created. Messages go to every agent in turn; @mention names to ask only some of them.` });
        db.chats.push(chat);
        save();
        broadcast({ type: 'chat', chat: summary(chat) });
        return json(res, 201, summary(chat));
      }

      const chat = findChat(id);
      if (!chat) return json(res, 404, { error: 'Chat not found' });
      const sub = parts[3];

      if (!sub && req.method === 'GET') return json(res, 200, { ...summary(chat), messages: chat.messages });

      if (!sub && req.method === 'PATCH') {
        applySettings(chat, await readBody(req));
        save();
        broadcast({ type: 'chat', chat: summary(chat) });
        return json(res, 200, summary(chat));
      }

      if (!sub && req.method === 'DELETE') {
        stopFlags.add(chat.id);
        queues.delete(chat.id);
        runs.get(chat.id)?.proc.kill();
        db.chats = db.chats.filter((c) => c !== chat);
        for (const g of db.chats) if (g.type === 'group') g.members = g.members.filter((m) => m !== chat.id);
        save();
        broadcast({ type: 'chat_deleted', chatId: chat.id });
        return json(res, 200, { ok: true });
      }

      if (sub === 'messages' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10).map((a) => ({ name: String(a.name), path: String(a.path), url: String(a.url || ''), type: String(a.type || '') })) : [];
        if (!text && !attachments.length) return json(res, 400, { error: 'Empty message' });
        const replyTo = body.replyTo ? { id: String(body.replyTo.id), name: String(body.replyTo.name).slice(0, 60), text: String(body.replyTo.text).slice(0, 300) } : undefined;
        enqueue(chat, { text, attachments, replyTo });
        save();
        return json(res, 202, { ok: true });
      }

      // POST /api/chats/:id/approvals/:approvalId  { decision: allow|always|deny, note? }
      if (sub === 'approvals' && parts[4] && req.method === 'POST') {
        const body = await readBody(req);
        if (!['allow', 'always', 'deny'].includes(body.decision)) return json(res, 400, { error: 'Bad decision' });
        const a = approvals.get(parts[4]);
        if (!a || a.chat.id !== chat.id) return json(res, 410, { error: 'This request has already expired.' });
        decideApproval(parts[4], body.decision, String(body.note || '').slice(0, 500));
        return json(res, 200, { ok: true });
      }

      if (sub === 'stop' && req.method === 'POST') {
        if (busy.has(chat.id)) stopFlags.add(chat.id);
        const run = runs.get(chat.id);
        if (run) { run.stopped = true; run.proc.kill(); }
        return json(res, 200, { ok: true });
      }

      // Start fresh Claude sessions but keep the chat (like "clear chat").
      if (sub === 'reset' && req.method === 'POST') {
        stopFlags.add(chat.id);
        queues.delete(chat.id);
        runs.get(chat.id)?.proc.kill();
        chat.sessionId = null;
        chat.memberSessions = {};
        chat.memberCursor = {};
        chat.messages = [];
        pushMessage(chat, { role: 'system', text: 'New session started. The agent no longer remembers earlier messages.' });
        save();
        broadcast({ type: 'chat', chat: summary(chat) });
        return json(res, 200, { ok: true });
      }

      if (sub === 'export' && req.method === 'GET') {
        const name = chat.name.replace(/[^\w\- ]+/g, '').trim() || 'chat';
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.md"` });
        return res.end(exportMarkdown(chat));
      }
    }

    json(res, 404, { error: 'Unknown endpoint' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function shutdown() {
  for (const r of runs.values()) { try { r.proc.kill(); } catch {} }
  try { saveNow(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);

// ---------- app window ----------
// The exe (or CLAUDECHAT_APP=1) shows ClaudeChat in its own window using Edge/Chrome
// "app mode": no tabs or address bar, own taskbar entry. Closing the window quits.

const APP_URL = `http://localhost:${PORT}`;
const APP_MODE = !!sea || process.env.CLAUDECHAT_APP === '1';

function findAppBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((p) => fs.existsSync(p));
}

function openBrowserTab() {
  if (process.platform === 'win32') spawn('explorer.exe', [APP_URL], { detached: true, stdio: 'ignore' }).unref();
}

// Returns the window's process, or null when it fell back to a normal browser tab.
function openAppWindow() {
  const browser = findAppBrowser();
  if (!browser) { openBrowserTab(); return null; }
  // A separate profile makes it its own app (own taskbar icon, remembered size,
  // notification and mic permissions) instead of a window of your everyday browser.
  const profile = path.join(process.env.LOCALAPPDATA || DATA_DIR, 'ClaudeChat', 'window');
  console.log(`Opening app window with ${browser}`);
  return spawn(browser, [
    `--app=${APP_URL}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,820',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ], { stdio: 'ignore' });
}

let lastClientAt = now();
function watchWindow(win) {
  const started = now();
  if (win) {
    win.on('exit', () => {
      // An instant exit means the window was handed to an already-running instance;
      // the idle check below then decides when to quit.
      if (now() - started > 4000) { console.log('App window closed, quitting.'); shutdown(); }
    });
  }
  // Safety net: quit when no window has been connected for a minute and nothing is running.
  setInterval(() => {
    if (clients.size) { lastClientAt = now(); return; }
    if (busy.size || runs.size) return;
    if (now() - lastClientAt > 60000) { console.log('No window open, quitting.'); shutdown(); }
  }, 10000).unref();
}

server.on('error', (e) => {
  // Starting ClaudeChat again while it runs just opens another window of the running app.
  if (e.code === 'EADDRINUSE' && APP_MODE) { openAppWindow(); setTimeout(() => process.exit(0), 1500); return; }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ClaudeChat running at ${APP_URL}`);
  console.log(`Chats are saved in ${DATA_DIR}`);
  if (APP_MODE) {
    process.title = 'ClaudeChat';
    watchWindow(openAppWindow());
  }
});
