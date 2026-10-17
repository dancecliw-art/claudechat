// OpenAI Codex CLI support: finding the `codex` binary, talking to `codex app-server`, and
// turning its events into ClaudeChat messages. Kept free of server state so tests can drive it.
//
// Why app-server and not `codex exec --json`: exec forces approval_policy=never
// (codex-rs/exec/src/lib.rs, "Default to never ask for approvals in headless mode") and
// rejects approval requests ("command execution approval is not supported in exec mode").
// Worse, a command the sandbox blocks never shows up in exec's JSONL at all
// (codex-rs/core/src/unified_exec/process_manager.rs returns the denial as an error, no item),
// so ClaudeChat couldn't even see what to re-check. `codex app-server` is the JSON-RPC
// interface Codex's own IDE extension and its official Python SDK use
// (sdk/python/src/openai_codex/client.py: `codex app-server --listen stdio://`). It streams
// text deltas and sends approval requests to the host, so Codex agents get the same
// Allow/Deny flow as Claude Code agents.
//
// Protocol shapes below come from `codex app-server generate-ts` (codex-cli 0.163.0) and the
// v2 types in codex-rs/app-server-protocol. Messages are JSON-RPC 2.0 without the "jsonrpc"
// field, one JSON object per line on stdin/stdout.

const fs = require('fs');
const path = require('path');

// ---------- finding the binary ----------

// npm's `codex` launcher (bin/codex.js in @openai/codex) is a Node script that runs the
// native binary from the platform package: <pkg>/vendor/<target triple>/bin/codex[.exe].
const TRIPLES = {
  'win32-x64': ['x86_64-pc-windows-msvc', '@openai/codex-win32-x64'],
  'win32-arm64': ['aarch64-pc-windows-msvc', '@openai/codex-win32-arm64'],
  'linux-x64': ['x86_64-unknown-linux-musl', '@openai/codex-linux-x64'],
  'linux-arm64': ['aarch64-unknown-linux-musl', '@openai/codex-linux-arm64'],
  'darwin-x64': ['x86_64-apple-darwin', '@openai/codex-darwin-x64'],
  'darwin-arm64': ['aarch64-apple-darwin', '@openai/codex-darwin-arm64'],
};

// The native codex binary inside an npm global folder (the one holding codex.cmd), if any.
function nativeCodexIn(npmDir, { platform = process.platform, arch = process.arch, exists = fs.existsSync } = {}) {
  const t = TRIPLES[`${platform}-${arch}`];
  if (!t) return null;
  const [triple, pkg] = t;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const root = path.join(npmDir, 'node_modules', '@openai', 'codex');
  for (const vendor of [
    path.join(root, 'node_modules', ...pkg.split('/'), 'vendor'), // npm nests the platform package
    path.join(npmDir, 'node_modules', ...pkg.split('/'), 'vendor'), // or hoists it
    path.join(root, 'vendor'), // older releases bundled every platform
  ]) {
    const p = path.join(vendor, triple, 'bin', exe);
    if (exists(p)) return p;
  }
  return null;
}

// $CODEX_BIN, then PATH, then the usual install folders. On Windows a bare `codex.cmd` can't be
// spawned without a shell, so the native codex.exe behind it is preferred.
function resolveCodex({ env = process.env, platform = process.platform, arch = process.arch, home = require('os').homedir(), exists = fs.existsSync } = {}) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = (env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  if (win) {
    const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    dirs.push(p.join(appData, 'npm'), p.join(local, 'pnpm'), p.join(local, 'Programs', 'codex'), p.join(home, '.codex', 'bin'));
  } else {
    dirs.push(p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  }
  let shim = null;
  for (const dir of dirs) {
    if (win) {
      if (exists(p.join(dir, 'codex.exe'))) return p.join(dir, 'codex.exe');
      if (exists(p.join(dir, 'codex.cmd'))) {
        const native = nativeCodexIn(dir, { platform, arch, exists });
        if (native) return native;
        shim = shim || p.join(dir, 'codex.cmd');
      }
    } else if (exists(p.join(dir, 'codex'))) return p.join(dir, 'codex');
  }
  return shim;
}

// ---------- models ----------

// From `codex app-server` model/list (codex-cli 0.163.0's bundled catalog). Replaced at
// startup by the installed CLI's own list.
const CODEX_FALLBACK_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', isDefault: true },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
];

// model/list result -> ClaudeChat's model entries (v2 Model: id, displayName, hidden,
// supportedReasoningEfforts[].reasoningEffort, defaultReasoningEffort, isDefault).
function parseModelList(result) {
  return (result?.data || []).filter((m) => m && m.id && !m.hidden).map((m) => ({
    id: m.id,
    name: m.displayName || m.id,
    efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter((e) => typeof e === 'string'),
    defaultEffort: m.defaultReasoningEffort || 'medium',
    isDefault: !!m.isDefault,
  }));
}

// The reasoning effort to send for an agent: its own if the model supports it, else the model's default.
function codexEffort(models, agent) {
  const m = models.find((x) => x.id === agent.model);
  if (!m) return agent.effort || null;
  if (m.efforts.includes(agent.effort)) return agent.effort;
  return m.efforts.includes(m.defaultEffort) ? m.defaultEffort : (m.efforts[0] || null);
}

// ---------- permissions ----------

// ClaudeChat permission mode -> thread/start's approvalPolicy + sandbox.
// "untrusted" makes Codex ask before any command that isn't on its known-safe (read-only)
// list and before file edits; ClaudeChat answers with danger.js, so safe work still runs on
// its own. "never" means Codex never asks and its sandbox is the only guard.
function codexPolicy(mode) {
  switch (mode) {
    case 'plan': return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'bypassPermissions': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'auto': return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    default: return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }; // smart, ask, acceptEdits
  }
}

// Codex reports commands wrapped in the shell it runs them with, e.g.
// `/bin/bash -lc 'rm -rf build'` or `"C:\...\powershell.exe" -Command "Remove-Item x"`.
// danger.js ignores quoted text, so the wrapper must come off before the check.
function unwrapShell(cmd) {
  const s = String(cmd || '').trim();
  const m = s.match(/^(?:"[^"]*[\\/])?(?:[^\s"]*[\\/])?(?:bash|zsh|sh|dash|fish)(?:\.exe)?"?\s+-(?:l?c|cl)\s+([\s\S]+)$/i)
    || s.match(/^(?:"[^"]*[\\/])?(?:[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i)
    || s.match(/^(?:"[^"]*[\\/])?(?:[^\s"]*[\\/])?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/);
  if (!m) return s;
  let inner = m[1].trim();
  if (inner.length >= 2 && inner[0] === "'" && inner.endsWith("'")) inner = inner.slice(1, -1).replace(/'\\''/g, "'");
  else if (inner.length >= 2 && inner[0] === '"' && inner.endsWith('"')) inner = inner.slice(1, -1).replace(/\\"/g, '"');
  return inner;
}

// What an approval request is about, ready for danger.js's assess().
// Returns { tool, input, extraReasons } or null for requests ClaudeChat doesn't handle.
function describeApproval(method, params, items, shellTool) {
  if (method === 'item/commandExecution/requestApproval') {
    let command = unwrapShell(params.command);
    if (!command && Array.isArray(params.commandActions)) command = params.commandActions.map((a) => a.command).filter(Boolean).join(' && ');
    const extra = [];
    if (params.networkApprovalContext) extra.push('Needs network access');
    return { tool: shellTool, input: { command, ...(params.cwd ? { cwd: params.cwd } : {}) }, extraReasons: extra, reason: params.reason || '' };
  }
  if (method === 'item/fileChange/requestApproval') {
    // The request only names the item; the paths come from the item/started that preceded it.
    const item = items.get(params.itemId);
    const changes = item?.changes || [];
    const extra = [];
    if (changes.some((c) => changeKind(c) === 'delete')) extra.push('Deletes files');
    if (params.grantRoot) extra.push(`Asks for write access to ${params.grantRoot}`);
    return { tool: 'Edit', input: { file_path: changes[0]?.path || params.grantRoot || '', files: changes.map((c) => c.path) }, changes, extraReasons: extra, reason: params.reason || '' };
  }
  return null;
}

const changeKind = (c) => (typeof c?.kind === 'string' ? c.kind : c?.kind?.type) || 'update';

// Combines assess() over every file of a patch into one verdict.
function assessApproval(desc, assess, cwd, home) {
  if (desc.tool === 'Edit' && desc.changes?.length) {
    const parts = desc.changes.map((c) => assess('Edit', { file_path: c.path }, cwd, home));
    const reasons = [...new Set([...parts.flatMap((a) => a.reasons), ...desc.extraReasons])];
    return {
      risky: reasons.length > 0,
      reasons,
      summary: desc.changes.map((c) => `${changeKind(c)} ${c.path}`).join('\n'),
      ruleKey: parts[0].ruleKey,
    };
  }
  const a = assess(desc.tool, desc.input, cwd, home);
  const reasons = [...new Set([...a.reasons, ...desc.extraReasons])];
  return { ...a, risky: reasons.length > 0, reasons };
}

// ---------- items -> tool cards ----------

const ITEM_STATUS = { inProgress: 'running', completed: 'done', failed: 'error', declined: 'error' };
const clip = (s, n = 6000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '\n… (truncated)' : s; };

// A v2 ThreadItem as a tool card ({ name, input, status, result }), or null for items that
// aren't tool steps (messages, reasoning, plans…).
function toolCard(item, shellTool) {
  switch (item?.type) {
    case 'commandExecution': {
      const status = ITEM_STATUS[item.status] || 'running';
      let result;
      if (item.status === 'declined') result = 'Not run: declined';
      else if (status !== 'running') result = item.aggregatedOutput ? clip(item.aggregatedOutput) : `Exit code ${item.exitCode ?? '?'}`;
      return { name: shellTool, input: { command: unwrapShell(item.command), cwd: item.cwd }, status, result };
    }
    case 'fileChange': {
      const changes = item.changes || [];
      const status = ITEM_STATUS[item.status] || 'running';
      return {
        name: changes.some((c) => changeKind(c) === 'add') && changes.length === 1 ? 'Write' : 'Edit',
        input: { file_path: changes.map((c) => c.path).join(', '), changes: changes.map((c) => ({ path: c.path, kind: changeKind(c) })) },
        status,
        result: status === 'running' ? undefined : item.status === 'declined' ? 'Not applied: declined' : clip(changes.map((c) => `${changeKind(c)} ${c.path}\n${c.diff || ''}`).join('\n')),
      };
    }
    case 'mcpToolCall': {
      const status = ITEM_STATUS[item.status] || 'running';
      const text = item.error?.message || (item.result?.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      return { name: `${item.server}.${item.tool}`, input: item.arguments || {}, status, result: status === 'running' ? undefined : clip(text) };
    }
    case 'dynamicToolCall': {
      const status = item.success === false ? 'error' : (ITEM_STATUS[item.status] || (item.success ? 'done' : 'running'));
      return { name: item.tool, input: item.arguments || {}, status, result: status === 'running' ? undefined : clip((item.contentItems || []).map((c) => c.text || `[${c.type}]`).join('\n')) };
    }
    case 'webSearch':
      return { name: 'WebSearch', input: { query: item.query || '' }, status: 'done' };
    case 'imageView':
      return { name: 'Read', input: { file_path: item.path }, status: 'done' };
    default:
      return null;
  }
}

// ---------- JSON-RPC over lines ----------

// Minimal JSON-RPC peer: request() returns a promise; incoming server requests go to
// onRequest(method, params, id), notifications to onNotification(method, params).
function createRpc(write, { onRequest, onNotification }) {
  let nextId = 1;
  const waiting = new Map();
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject, method });
        write({ id, method, params });
      });
    },
    notify(method, params) { write(params === undefined ? { method } : { method, params }); },
    respond(id, result) { write({ id, result }); },
    respondError(id, message, code = -32601) { write({ id, error: { code, message } }); },
    handle(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.method && msg.id !== undefined && msg.id !== null) return onRequest(msg.method, msg.params || {}, msg.id);
      if (msg.method) return onNotification(msg.method, msg.params || {});
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message || `${w.method} failed`), { code: msg.error.code }));
      else w.resolve(msg.result);
    },
    // Fails everything still waiting (the process exited).
    close(reason) {
      for (const w of waiting.values()) w.reject(new Error(reason));
      waiting.clear();
    },
  };
}

// Splits a stream of chunks into parsed JSON lines.
function lineReader(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  };
}

module.exports = {
  resolveCodex, nativeCodexIn, CODEX_FALLBACK_MODELS, parseModelList, codexEffort, codexPolicy,
  unwrapShell, describeApproval, assessApproval, toolCard, createRpc, lineReader, changeKind,
};
