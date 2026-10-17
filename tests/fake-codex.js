// A stand-in for `codex app-server` that replays recorded sessions, so ClaudeChat's Codex
// runner can be tested without a Codex login. It speaks the same JSON-RPC lines.
//
// FAKE_CODEX_SCENARIO  JSON file: { "turns": [ turn, ... ] }, one turn per turn/start, in order
//                      across processes. A turn is either a fixture file name (recorded real
//                      app-server output in tests/fixtures; everything from turn/started on is
//                      replayed, server requests wait for ClaudeChat's answer),
//                      { "say": "text" } for a plain reply, or { "command": "…" } for one
//                      command approval request.
// FAKE_CODEX_STATE     file holding the index of the next turn.
// FAKE_CODEX_LOG       every message ClaudeChat sends is appended here as a JSON line.
// FAKE_CODEX_CWD       replaces the recorded working folder (/home/user/project) in replayed events.

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const log = (o) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function nextTurn() {
  const f = process.env.FAKE_CODEX_STATE;
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
  fs.writeFileSync(f, String(n + 1));
  return scenario.turns[n];
}

const recorded = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const firstResult = recorded('codex-approve-command.jsonl')[0].result; // initialize response

let threadId = null;
let turnSeq = 0;
let reqSeq = 100;
const waiting = new Map();

// Recorded sessions ran in /home/user/project; point them at the test's working folder.
function retarget(params, turnId) {
  let json = JSON.stringify(params);
  if (process.env.FAKE_CODEX_CWD) json = json.split('/home/user/project').join(process.env.FAKE_CODEX_CWD.replace(/\\/g, '/'));
  const p = JSON.parse(json);
  if ('threadId' in p) p.threadId = threadId;
  if ('turnId' in p) p.turnId = turnId;
  if (p.turn) p.turn.id = turnId;
  return p;
}

function sayTurn(text, turnId) {
  const half = Math.ceil(text.length / 2);
  return [
    { method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } } },
    { method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: '' } } },
    { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `msg-${turnId}`, delta: text.slice(0, half) } },
    { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `msg-${turnId}`, delta: text.slice(half) } },
    { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } } },
    { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { totalTokens: 1000 + turnSeq * 100 }, last: { totalTokens: 100 } } } },
    { method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: 'completed', error: null, durationMs: 5 } } },
  ];
}

// A turn where Codex asks to run one command, then says whether it ran.
function commandTurn(command, turnId) {
  const item = { type: 'commandExecution', id: `cmd-${turnId}`, command: `/bin/bash -lc '${command}'`, cwd: process.env.FAKE_CODEX_CWD || '/', status: 'inProgress', commandActions: [{ type: 'unknown', command }], aggregatedOutput: null, exitCode: null };
  return [
    { method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } } },
    { method: 'item/started', params: { threadId, turnId, item } },
    { id: 0, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId, turnId, itemId: item.id, command: item.command, cwd: item.cwd, commandActions: item.commandActions } },
    { method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'uploaded' } } },
    ...sayTurn('Done.', turnId).slice(1),
  ];
}

async function play(turn, turnId) {
  let lines;
  if (typeof turn === 'string') {
    const all = recorded(turn);
    lines = all.slice(all.findIndex((m) => m.method === 'turn/started')).filter((m) => m.method);
  } else if (turn.command) lines = commandTurn(turn.command, turnId);
  else lines = sayTurn(turn.say, turnId);
  for (const m of lines) {
    if (m.id !== undefined) {
      // A server request: ask ClaudeChat and wait for its decision.
      const id = reqSeq++;
      const answer = new Promise((r) => waiting.set(id, r));
      out({ id, method: m.method, params: retarget(m.params, turnId) });
      const res = await answer;
      log({ decision: res.result?.decision ?? null, error: res.error?.message, method: m.method });
    } else {
      out({ method: m.method, params: retarget(m.params, turnId) });
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// What ClaudeChat put in this agent's environment (its private ID for local APIs).
log({ env: { agent: process.env.CLAUDECHAT_AGENT || null, url: process.env.CLAUDECHAT_URL || null } });

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    log({ in: msg });
    if (msg.method === undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); continue; }
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': out({ id: msg.id, result: firstResult }); break;
      case 'model/list': out({ id: msg.id, result: JSON.parse(fs.readFileSync(path.join(FIX, 'codex-model-list.json'), 'utf8')) }); break;
      case 'thread/start':
      case 'thread/resume':
        threadId = msg.method === 'thread/resume' ? p.threadId : `thread-${Date.now().toString(36)}-${process.pid}`;
        out({ id: msg.id, result: { thread: { id: threadId }, model: p.model, cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: p.sandbox } } });
        out({ method: 'thread/started', params: { thread: { id: threadId } } });
        break;
      case 'turn/start': {
        const turnId = `turn-${++turnSeq}`;
        out({ id: msg.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
        const turn = nextTurn();
        if (turn) play(turn, turnId);
        else out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'fake-codex: no turn left in the scenario' } } } });
        break;
      }
      case 'turn/steer': out({ id: msg.id, result: { turnId: p.expectedTurnId } }); break;
      case 'initialized': break;
      default: if (msg.id !== undefined) out({ id: msg.id, error: { code: -32601, message: `fake-codex: ${msg.method} not supported` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
