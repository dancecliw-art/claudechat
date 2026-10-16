// ClaudeChat client — WhatsApp-style UI over the local agent server.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  const EFFORT_FRACTION = { low: 0.2, medium: 0.4, high: 0.6, xhigh: 0.8, max: 1 };
  const MODEL_NOTES = {
    'claude-fable-5-1': 'Most capable · slowest, uses the most',
    'claude-opus-5-5': 'Default · great for coding',
    'claude-sonnet-5-5': 'Fast everyday work',
    'claude-haiku-5-5': 'Fastest · lightest on usage',
    'gemini-3.8-flash': 'Google · fast, great default',
    'claude-sonnet-4-6': 'Anthropic, via Antigravity',
    'claude-opus-4-6-thinking': 'Anthropic, via Antigravity',
    'gpt-oss-120b': 'Open model, via Antigravity',
  };
  const PROVIDER_SHORT = { claude: 'Claude Code', antigravity: 'Antigravity' };
  const PERMISSION_INFO = {
    smart: 'Ask when risky: safe actions run, risky ones wait for your OK (recommended)',
    ask: 'Ask every time: approve each edit and command',
    auto: "Claude decides: never asks, blocks what it thinks is risky",
    acceptEdits: 'Accept edits: file edits allowed, risky commands blocked',
    plan: 'Plan: read-only, proposes a plan',
    bypassPermissions: 'Bypass: runs everything, never asks (careful!)',
  };

  let meta = null;
  const chats = new Map();
  let activeId = null;
  let activeMessages = [];
  let filter = 'all';
  let unread = load('cc-unread', {});
  let notifyAsked = false;
  let pendingAtts = [];   // [{ id, name, type, preview, uploaded?: {path,url,...} }]
  let replyTo = null;     // { id, name, text, color }
  let usage = null;

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  // ---------- theme ----------
  const savedTheme = load('cc-theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  else if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';
  $('#btnTheme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    store('cc-theme', next);
  };

  // ---------- helpers ----------
  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener'); }
    });
  }
  const MENTION_RE = /(^|[\s(>])(@[\p{L}\p{N}_-]+)/gu;
  // Wraps @mentions in rendered HTML, skipping code blocks and links.
  function highlightMentions(html) {
    if (!html.includes('@')) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeValue.includes('@') && !n.parentElement?.closest('code, pre, a')) hits.push(n);
    }
    for (const n of hits) {
      const span = document.createElement('span');
      span.innerHTML = esc(n.nodeValue).replace(MENTION_RE, '$1<span class="mention">$2</span>');
      n.replaceWith(...span.childNodes);
    }
    return tpl.innerHTML;
  }
  function md(text) {
    if (window.marked && window.DOMPurify) {
      return highlightMentions(DOMPurify.sanitize(marked.parse(text || '', { breaks: true, gfm: true })))
        .replace(/<pre>/g, '<pre><button type="button" class="copy-code">Copy</button>');
    }
    return esc(text).replace(/\n/g, '<br>');
  }
  const plain = (text) => esc(text).replace(MENTION_RE, '$1<span class="mention">$2</span>').replace(/\n/g, '<br>');

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 3500);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed'); }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function dayLabel(ts) {
    const d = new Date(ts), today = new Date();
    const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function listTime(ts) {
    if (!ts) return '';
    const label = dayLabel(ts);
    if (label === 'Today') return clock(ts);
    if (label === 'Yesterday' || !label.match(/\d/)) return label;
    return new Date(ts).toLocaleDateString();
  }
  // Providers (Claude Code, Antigravity) each have their own models; some models (like
  // Gemini 3.8 Flash's Low/Medium/High variants) have their own effort levels.
  const providerOf = (c) => c?.provider || 'claude';
  const modelsFor = (prov) => meta?.providers?.[prov]?.models || [];
  const modelInfo = (prov, id) => modelsFor(prov).find((m) => m.id === id);
  const effortsFor = (c) => modelInfo(providerOf(c), c.model)?.efforts || [];
  function modelName(id) {
    for (const p of Object.values(meta?.providers || {})) {
      const m = p.models.find((x) => x.id === id);
      if (m) return m.name;
    }
    return meta?.models?.[id] || id;
  }
  const shortPath = (p) => (p || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || p;
  const agents = () => [...chats.values()].filter((c) => c.type !== 'group');
  const membersOf = (g) => (g.members || []).map((id) => chats.get(id)).filter(Boolean);
  const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
  const tokenCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

  const TICKS = '<svg viewBox="0 0 16 11"><path d="M11.07.65 4.5 7.22 1.93 4.65.5 6.07l4 4 8-8zM15.07.65 8.5 7.22l-.7-.7-1.42 1.42 2.12 2.13 8-8z"/></svg>';
  function tickHtml(m) {
    if (m.notSent) return '<span class="failed" title="Not sent">⚠</span>';
    if (m.queued) return '<span class="queued" title="Queued">🕓</span>';
    return `<span class="${m.read ? 'read' : ''}">${TICKS}</span>`;
  }

  // ---------- chat list ----------
  function sortedChats() {
    return [...chats.values()].sort((a, b) => (b.pinned - a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  }

  function renderList() {
    const q = $('#search').value.trim().toLowerCase();
    const list = sortedChats().filter((c) => {
      if (filter === 'working' && !c.running) return false;
      if (filter === 'unread' && !unread[c.id]) return false;
      if (filter === 'pinned' && !c.pinned) return false;
      if (filter === 'groups' && c.type !== 'group') return false;
      if (q && !(c.name.toLowerCase().includes(q) || (c.lastMessage?.text || '').toLowerCase().includes(q))) return false;
      return true;
    });
    const ul = $('#chatList');
    if (!list.length) {
      ul.innerHTML = `<li class="list-empty">${chats.size ? 'Nothing here.' : 'No agents yet.<br>Tap ✚ to create your first one.'}</li>`;
      return;
    }
    ul.innerHTML = list.map((c) => {
      const lm = c.lastMessage;
      const n = unread[c.id] || 0;
      let preview;
      if (c.approvals) preview = `<span class="preview needs-ok">⚠️ Waiting for your approval</span>`;
      else if (c.running) preview = `<span class="preview typing">${esc(c.status || 'typing…')}</span>`;
      else if (lm) {
        const ticks = lm.role === 'user' ? `<span class="stamp" style="float:none;margin:0;top:0">${tickHtml(lm)}</span>` : '';
        const who = c.type === 'group' && lm.role === 'assistant' && lm.from ? `${lm.from.name}: ` : '';
        const body = (lm.text || (lm.attachments?.length ? '📎 Attachment' : '')).replace(/[#*_`>]/g, '');
        preview = `${ticks}<span class="preview">${esc(who + body.slice(0, 120))}</span>`;
      } else preview = `<span class="preview">${esc(c.type === 'group' ? membersOf(c).map((a) => a.name).join(', ') : shortPath(c.cwd))}</span>`;
      const tag = c.type === 'group' ? `${(c.members || []).length} agents` : modelName(c.model);
      return `
        <li class="chat-item ${c.id === activeId ? 'active' : ''}" data-id="${c.id}">
          <div class="avatar" style="--av:${c.color}">${esc(c.avatar)}${c.running ? '<span class="dot"></span>' : ''}</div>
          <div class="meta">
            <div class="row1">
              <span class="name">${esc(c.name)}</span>
              <span class="time ${n ? 'unread' : ''}">${listTime(c.updatedAt)}</span>
            </div>
            <div class="row2">
              ${preview}
              <span class="model-tag">${esc(tag)}</span>
              ${c.muted ? '<span title="Muted">🔕</span>' : ''}
              ${c.pinned ? '<svg class="pin" viewBox="0 0 24 24"><path d="M16 9V4h1V2H7v2h1v5l-2 2v2h5.2v7h1.6v-7H18v-2z"/></svg>' : ''}
              ${n ? `<span class="badge">${n}</span>` : ''}
            </div>
          </div>
        </li>`;
    }).join('');
  }

  $('#chatList').onclick = (e) => {
    const li = e.target.closest('.chat-item');
    if (li) openChat(li.dataset.id);
  };
  $('#search').oninput = renderList;
  $('#chips').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
    renderList();
  };

  // ---------- conversation ----------
  async function openChat(id) {
    if (activeId !== id) { clearReply(); clearAtts(); }
    activeId = id;
    unread[id] = 0;
    store('cc-unread', unread);
    app.classList.add('in-chat');
    $('#empty').hidden = true;
    $('#chat').hidden = false;
    renderList();
    renderHeader();
    $('#messages').innerHTML = '';
    try {
      const full = await api('GET', `/chats/${id}`);
      if (activeId !== id) return;
      const { messages, ...rest } = full;
      activeMessages = messages;
      chats.set(id, { ...chats.get(id), ...rest });
      renderHeader();
      renderMessages();
      if (!$('#drawer').hidden) renderDrawer();
    } catch (e) {
      toast(e.message);
    }
    if (matchMedia('(min-width: 901px)').matches) $('#input').focus();
  }

  function closeChat() {
    activeId = null;
    app.classList.remove('in-chat');
    $('#chat').hidden = true;
    $('#empty').hidden = false;
    $('#drawer').hidden = true;
    renderList();
  }
  $('#btnBack').onclick = closeChat;

  function renderHeader() {
    const c = chats.get(activeId);
    if (!c) return;
    const av = $('#headAvatar');
    av.textContent = c.avatar;
    av.style.setProperty('--av', c.color);
    $('#headName').textContent = c.name;
    const sub = $('#headSub');
    const isGroup = c.type === 'group';
    if (c.running) {
      sub.textContent = (c.status || 'typing…') + (c.queued ? ` · ${c.queued} queued` : '');
      sub.className = 'head-sub typing';
    } else {
      const modes = [c.teamTalk ? '🗣️ Team talk' : '', c.parallel ? '⚡ Same time' : ''].filter(Boolean).join(' · ');
      sub.textContent = isGroup
        ? `${modes ? modes + ' · ' : ''}${[...membersOf(c).map((a) => a.name), 'You'].join(', ')}`
        : `online · ${PROVIDER_SHORT[providerOf(c)]} · ${shortPath(c.cwd)}${c.fullAccess !== false ? ' · full PC access' : ''}`;
      sub.title = isGroup ? '' : c.cwd || '';
      sub.className = 'head-sub';
    }
    $('#modelWrap').hidden = isGroup;
    if (!isGroup) {
      const efforts = effortsFor(c);
      const effort = efforts.includes(c.effort) ? c.effort : (efforts.includes('medium') ? 'medium' : efforts[0]);
      $('#mpModel').textContent = modelName(c.model);
      $('#mpEffort').textContent = effort ? EFFORT_LABEL[effort] || effort : '';
      $('#mpRing').hidden = !effort;
      $('#mpRing').querySelector('.ring-fg').style.strokeDashoffset = 44 * (1 - (EFFORT_FRACTION[effort] || 0.6));
    }
    $('#btnStopHead').hidden = !c.running;
    $('#drawerTitle').textContent = isGroup ? 'Group info' : 'Agent info';
    $('#input').placeholder = isGroup ? `Message the team, e.g. “@${membersOf(c)[0]?.name || 'Backend'} create the API”` : 'Type a message';
  }

  const isBubble = (m) => m.role === 'user' || m.role === 'assistant';
  const sameSender = (a, b) => a.role === b.role && (a.from?.id || '') === (b.from?.id || '');

  function attsHtml(atts) {
    if (!atts?.length) return '';
    return `<div class="atts">${atts.map((a) => (a.type || '').startsWith('image/') && a.url
      ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-full="${esc(a.url)}">`
      : `<a class="att-file" href="${esc(a.url)}" target="_blank" rel="noopener">📄 ${esc(a.name)}</a>`).join('')}</div>`;
  }

  function messageHtml(m, prev) {
    const dayBreak = !prev || dayKey(prev.ts) !== dayKey(m.ts) ? `<div class="day">${dayLabel(m.ts)}</div>` : '';
    if (m.role === 'system') return dayBreak + `<div class="sys ${m.error ? 'error' : ''}" data-id="${m.id}">${esc(m.text)}</div>`;
    if (m.role === 'tool') return dayBreak + toolHtml(m);
    if (m.role === 'approval') return dayBreak + approvalHtml(m);
    const out = m.role === 'user';
    const first = dayBreak || !prev || !isBubble(prev) || !sameSender(prev, m);
    const stamp = `<span class="stamp">${clock(m.ts)}${out ? tickHtml(m) : ''}</span>`;
    const sender = !out && m.from && first ? `<span class="sender" style="color:${esc(m.from.color)}">${esc(m.from.avatar)} ${esc(m.from.name)}</span>` : '';
    const quote = m.replyTo ? `<span class="quote" data-goto="${esc(m.replyTo.id)}"><b>${esc(m.replyTo.name)}</b><span>${esc(m.replyTo.text)}</span></span>` : '';
    const body = out ? plain(m.text) : md(m.text);
    return dayBreak + `
      <div class="msg ${out ? 'out' : 'in'} ${first ? 'first' : ''}" data-id="${m.id}">
        <div class="msg-actions">
          <button type="button" data-act="reply" title="Reply">↩</button>
          <button type="button" data-act="copy" title="Copy">⧉</button>
        </div>
        <div class="bubble">
          ${sender}
          ${m.broadcast ? '<span class="bc-tag">📣 Broadcast</span>' : ''}
          ${quote}${attsHtml(m.attachments)}
          <div class="text ${m.streaming ? 'cursor' : ''}">${body}</div>${stamp}
        </div>
      </div>`;
  }

  function toolArg(t) {
    const i = t.input || {};
    const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.skill;
    if (v !== undefined) return String(v);
    const k = Object.keys(i)[0];
    return k ? `${k}: ${typeof i[k] === 'string' ? i[k] : JSON.stringify(i[k])}` : '';
  }

  function toolHtml(m) {
    const t = m.tool;
    const state = t.status === 'running' ? '<span class="spin"></span>' : t.status === 'error' ? '✕' : '✓';
    return `
      <div class="tool" data-id="${m.id}">
        <details>
          <summary>
            <span class="tstate ${t.status}">${state}</span>
            ${m.from ? `<span class="who">${esc(m.from.avatar)}</span>` : ''}
            <span class="tname">${esc(t.name)}</span>
            <span class="targ">${esc(toolArg(t))}</span>
          </summary>
          <div class="plabel">Input</div>
          <pre>${esc(JSON.stringify(t.input, null, 2))}</pre>
          ${t.result !== undefined ? `<div class="plabel">${t.status === 'error' ? 'Error' : 'Result'}</div><pre>${esc(t.result || '(empty)')}</pre>` : ''}
        </details>
      </div>`;
  }

  const APPROVAL_DONE = {
    allowed: ['✓', 'Allowed'],
    always: ['✓', 'Always allowed'],
    denied: ['✕', 'Denied'],
    expired: ['⌛', 'Expired. The agent stopped before you answered'],
  };
  const TOOL_VERB = { Bash: 'run a command', PowerShell: 'run a command', Write: 'write a file', Edit: 'edit a file', MultiEdit: 'edit a file', NotebookEdit: 'edit a notebook' };

  function approvalHtml(m) {
    const a = m.approval;
    const pending = a.status === 'pending';
    const who = m.from?.name || a.agentName || 'The agent';
    const done = APPROVAL_DONE[a.status];
    return `
      <div class="approval ${pending ? 'pending' : a.status}" data-id="${m.id}">
        <div class="ap-head"><span class="ap-icon">${pending ? '⚠️' : done[0]}</span>
          <b>${esc(who)} wants to ${esc(TOOL_VERB[a.tool] || `use ${a.tool}`)}</b><span class="ap-time">${clock(m.ts)}</span></div>
        <pre class="ap-cmd">${esc(a.summary)}</pre>
        <ul class="ap-why">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${pending ? `
          <input class="ap-note" placeholder="Optional: tell it what to do instead (sent if you deny)" maxlength="500">
          <div class="ap-actions">
            <button type="button" class="ap-deny" data-approve="deny" data-aid="${a.id}">Deny</button>
            <button type="button" class="ap-always" data-approve="always" data-aid="${a.id}" title="Don't ask again for similar actions by this agent">Always allow</button>
            <button type="button" class="ap-allow" data-approve="allow" data-aid="${a.id}">Allow</button>
          </div>` : `<div class="ap-result">${esc(done[1])}${a.note ? `: “${esc(a.note)}”` : ''}</div>`}
      </div>`;
  }

  function nearBottom() {
    const el = $('#messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }
  function scrollBottom(force) {
    const el = $('#messages');
    if (force || nearBottom()) el.scrollTop = el.scrollHeight;
  }

  function renderMessages() {
    const el = $('#messages');
    el.innerHTML = activeMessages.map((m, i) => messageHtml(m, activeMessages[i - 1])).join('');
    renderTyping();
    el.scrollTop = el.scrollHeight;
  }

  function renderTyping() {
    const el = $('#messages');
    el.querySelector('.typing-bubble')?.remove();
    const c = chats.get(activeId);
    const last = activeMessages[activeMessages.length - 1];
    if (c?.running && !(last?.role === 'assistant' && last.streaming)) {
      el.insertAdjacentHTML('beforeend', '<div class="typing-bubble"><i></i><i></i><i></i></div>');
    }
  }

  function appendMessage(m) {
    const stick = nearBottom();
    const prev = activeMessages[activeMessages.length - 1];
    activeMessages.push(m);
    const el = $('#messages');
    el.querySelector('.typing-bubble')?.remove();
    el.insertAdjacentHTML('beforeend', messageHtml(m, prev));
    renderTyping();
    if (stick || m.role === 'user') scrollBottom(true);
  }

  function replaceMessage(m) {
    const idx = activeMessages.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    activeMessages[idx] = m;
    const node = $('#messages').querySelector(`[data-id="${m.id}"]`);
    if (!node) return;
    const wasOpen = node.querySelector('details')?.open;
    const tmp = document.createElement('div');
    tmp.innerHTML = messageHtml(m, activeMessages[idx - 1] || m);
    const fresh = tmp.querySelector(`[data-id="${m.id}"]`);
    if (fresh) {
      if (wasOpen) fresh.querySelector('details')?.setAttribute('open', '');
      node.replaceWith(fresh);
    }
    renderTyping();
  }

  // Streaming text: re-render the bubble at most once per frame.
  const pendingDeltas = new Set();
  function applyDelta(messageId, text) {
    const m = activeMessages.find((x) => x.id === messageId);
    if (!m) return;
    m.text += text;
    pendingDeltas.add(m);
    if (pendingDeltas.size === 1) requestAnimationFrame(flushDeltas);
  }
  function flushDeltas() {
    const stick = nearBottom();
    for (const m of pendingDeltas) {
      const node = $('#messages').querySelector(`[data-id="${m.id}"] .text`);
      if (node) node.innerHTML = md(m.text);
    }
    pendingDeltas.clear();
    if (stick) scrollBottom(true);
  }

  // message interactions: reply, copy, code copy, quote jump, image zoom
  $('#messages').addEventListener('click', async (e) => {
    const ap = e.target.closest('[data-approve]');
    if (ap) {
      const card = ap.closest('.approval');
      card.querySelectorAll('button').forEach((b) => (b.disabled = true));
      const note = card.querySelector('.ap-note')?.value.trim();
      try {
        await api('POST', `/chats/${activeId}/approvals/${ap.dataset.aid}`, { decision: ap.dataset.approve, note: ap.dataset.approve === 'deny' ? note : '' });
      } catch (err) {
        toast(err.message);
        card.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      const id = act.closest('[data-id]').dataset.id;
      const m = activeMessages.find((x) => x.id === id);
      if (!m) return;
      if (act.dataset.act === 'copy') copyText(m.text);
      if (act.dataset.act === 'reply') {
        const c = chats.get(activeId);
        setReply({ id: m.id, name: m.role === 'user' ? 'You' : m.from?.name || c.name, text: (m.text || '').slice(0, 300), color: m.from?.color });
      }
      return;
    }
    const cc = e.target.closest('.copy-code');
    if (cc) return copyText(cc.parentElement.querySelector('code')?.innerText ?? cc.parentElement.innerText.replace(/^Copy/, ''));
    const q = e.target.closest('[data-goto]');
    if (q) {
      const node = $('#messages').querySelector(`[data-id="${q.dataset.goto}"]`);
      if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1300); }
      return;
    }
    const img = e.target.closest('img[data-full]');
    if (img) {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${esc(img.dataset.full)}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.append(lb);
    }
  });

  // ---------- composer ----------
  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  function syncSendButton() {
    const hasContent = input.value.trim() || pendingAtts.length;
    $('#btnSend').hidden = !hasContent && !!Speech;
    $('#btnMic').hidden = !!hasContent || !Speech;
  }
  input.addEventListener('input', () => { autosize(); syncSendButton(); updateMentions(); });
  input.addEventListener('keydown', (e) => {
    if (handleMentionKeys(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#btnSend').onclick = send;
  $('#btnStopHead').onclick = () => activeId && api('POST', `/chats/${activeId}/stop`).catch((e) => toast(e.message));

  async function send() {
    const text = input.value.trim();
    if ((!text && !pendingAtts.length) || !activeId) return;
    if (pendingAtts.some((a) => !a.uploaded)) return toast('Still uploading attachments…');
    askNotify();
    const body = {
      text,
      attachments: pendingAtts.map((a) => a.uploaded),
      replyTo: replyTo ? { id: replyTo.id, name: replyTo.name, text: replyTo.text } : undefined,
    };
    input.value = '';
    autosize();
    clearAtts();
    clearReply();
    syncSendButton();
    try {
      await api('POST', `/chats/${activeId}/messages`, body);
    } catch (e) {
      input.value = text;
      autosize();
      syncSendButton();
      toast(e.message);
    }
  }

  function askNotify() {
    if (notifyAsked || !('Notification' in window)) return;
    notifyAsked = true;
    if (Notification.permission === 'default') Notification.requestPermission();
  }

  // reply bar
  function setReply(r) {
    replyTo = r;
    $('#rbName').textContent = r.name;
    $('#rbName').style.color = r.color || '';
    $('#rbText').textContent = r.text;
    $('#replyBar').hidden = false;
    input.focus();
  }
  function clearReply() { replyTo = null; $('#replyBar').hidden = true; }
  $('#rbClose').onclick = clearReply;

  // attachments: paperclip, paste, drag & drop
  $('#btnAttach').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  let dragDepth = 0;
  $('#chat').addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
  $('#chat').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  $('#chat').addEventListener('dragover', (e) => e.preventDefault());
  $('#chat').addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    addFiles([...(e.dataTransfer?.files || [])]);
  });

  function addFiles(files) {
    for (const f of files) {
      if (f.size > 20e6) { toast(`${f.name} is over 20 MB`); continue; }
      const att = { id: Math.random().toString(36).slice(2), name: f.name || 'pasted.png', type: f.type, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      pendingAtts.push(att);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = String(reader.result).split(',')[1] || '';
          att.uploaded = await api('POST', '/uploads', { name: att.name, type: att.type, data });
        } catch (e) {
          toast(`Upload failed: ${e.message}`);
          pendingAtts = pendingAtts.filter((a) => a !== att);
        }
        renderAtts();
      };
      reader.readAsDataURL(f);
    }
    renderAtts();
    syncSendButton();
  }
  function renderAtts() {
    const strip = $('#attachStrip');
    strip.hidden = !pendingAtts.length;
    strip.innerHTML = pendingAtts.map((a) => `
      <div class="att-chip ${a.uploaded ? '' : 'loading'}" title="${esc(a.name)}">
        ${a.preview ? `<img src="${a.preview}" alt="">` : `📄<br>${esc(a.name.slice(0, 18))}`}
        <button type="button" data-rm="${a.id}" aria-label="Remove">✕</button>
      </div>`).join('');
    syncSendButton();
  }
  $('#attachStrip').onclick = (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    pendingAtts = pendingAtts.filter((a) => a.id !== b.dataset.rm);
    renderAtts();
  };
  function clearAtts() { pendingAtts = []; renderAtts(); }

  // voice dictation (Chrome / Edge)
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  $('#btnMic').onclick = () => {
    if (!Speech) return;
    if (rec) { rec.stop(); return; }
    rec = new Speech();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    const base = input.value ? input.value + ' ' : '';
    rec.onresult = (e) => {
      let txt = '';
      for (const r of e.results) txt += r[0].transcript;
      input.value = base + txt;
      autosize();
    };
    rec.onerror = (e) => toast(`Voice input: ${e.error}`);
    rec.onend = () => { rec = null; $('#btnMic').classList.remove('rec'); syncSendButton(); };
    rec.start();
    $('#btnMic').classList.add('rec');
  };

  // @mentions in groups
  let mentionIdx = 0;
  let mentionList = [];
  function mentionQuery() {
    const c = chats.get(activeId);
    if (c?.type !== 'group') return null;
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/@([\w-]*)$/);
    return m ? m[1].toLowerCase() : null;
  }
  function updateMentions() {
    const q = mentionQuery();
    const pop = $('#mentionPop');
    if (q === null) { pop.hidden = true; return; }
    const c = chats.get(activeId);
    mentionList = [...membersOf(c), { id: 'all', name: 'all', avatar: '📣', color: 'var(--accent)' }]
      .filter((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(q));
    if (!mentionList.length) { pop.hidden = true; return; }
    mentionIdx = Math.min(mentionIdx, mentionList.length - 1);
    pop.innerHTML = mentionList.map((a, i) => `<button type="button" class="${i === mentionIdx ? 'sel' : ''}" data-i="${i}"><span>${esc(a.avatar)}</span>${esc(a.name)}</button>`).join('');
    pop.hidden = false;
  }
  function insertMention(a) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos).replace(/@([\w-]*)$/, `@${a.name} `);
    input.value = before + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = before.length;
    $('#mentionPop').hidden = true;
    input.focus();
    syncSendButton();
  }
  function handleMentionKeys(e) {
    if ($('#mentionPop').hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + mentionList.length) % mentionList.length;
      updateMentions();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionList[mentionIdx]); return true; }
    if (e.key === 'Escape') { $('#mentionPop').hidden = true; return true; }
    return false;
  }
  $('#mentionPop').onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (b) insertMention(mentionList[+b.dataset.i]);
  };

  // ---------- model / effort popover ----------
  const pop = $('#modelPop');
  $('#modelPill').onclick = (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderPopover();
  };
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
    const card = $('#usageCard');
    if (!card.hidden && !card.contains(e.target) && !$('#usageMini').contains(e.target)) card.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!pop.hidden) pop.hidden = true;
    else if (!$('#usageCard').hidden) $('#usageCard').hidden = true;
    else if (!$('#drawer').hidden) $('#drawer').hidden = true;
    else if (replyTo) clearReply();
  });

  function renderPopover() {
    const c = chats.get(activeId);
    if (!c) return;
    const prov = providerOf(c);
    $('#popModels').innerHTML = `<div class="pop-label" style="padding-top:0">${esc(meta.providers?.[prov]?.name || prov)}</div>` +
      modelsFor(prov).map((m) => `
      <button class="pop-model ${m.id === c.model ? 'sel' : ''}" data-model="${esc(m.id)}">
        <span><span>${esc(m.name)}</span><small>${esc(MODEL_NOTES[m.id] || m.id)}</small></span>
        <span class="check">✓</span>
      </button>`).join('');
    const efforts = effortsFor(c);
    const current = efforts.includes(c.effort) ? c.effort : (efforts.includes('medium') ? 'medium' : efforts[0]);
    const selIdx = efforts.indexOf(current);
    $('#popEfforts').style.gridTemplateColumns = `repeat(${Math.max(efforts.length, 1)}, 1fr)`;
    $('#popEfforts').innerHTML = efforts.length
      ? efforts.map((e, i) => `<button class="effort-btn ${i < selIdx ? 'on' : ''} ${e === current ? 'sel' : ''}" data-effort="${e}">${EFFORT_LABEL[e]}</button>`).join('')
      : '<span class="pop-hint" style="padding:0">This model has a fixed thinking level.</span>';
  }
  pop.onclick = async (e) => {
    e.stopPropagation();
    const mb = e.target.closest('[data-model]');
    const eb = e.target.closest('[data-effort]');
    if (!mb && !eb) return;
    await updateChat(activeId, mb ? { model: mb.dataset.model } : { effort: eb.dataset.effort });
    renderPopover();
  };

  async function updateChat(id, patch) {
    try {
      const c = await api('PATCH', `/chats/${id}`, patch);
      chats.set(id, { ...chats.get(id), ...c });
      if (id === activeId) renderHeader();
      renderList();
      return c;
    } catch (e) { toast(e.message); }
  }

  // ---------- settings fields (shared by drawer + new agent dialog) ----------
  function agentSettingsHtml(c) {
    const opt = (list, sel, label = (x) => x) => list.map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
    const drives = (meta.drives || []).join(' ');
    const prov = providerOf(c);
    const isAgy = prov === 'antigravity';
    const efforts = effortsFor(c);
    const providerOpts = Object.entries(meta.providers || { claude: { name: 'Claude Code', available: true } }).map(([id, p]) =>
      `<option value="${id}" ${id === prov ? 'selected' : ''} ${p.available ? '' : 'disabled'}>${esc(p.name)}${p.available ? '' : ' (not installed)'}</option>`).join('');
    return `
      <label class="field"><span>Provider</span>
        <select name="provider">${providerOpts}</select>
        <small>${isAgy ? 'Runs Google Antigravity’s agent (<code>agy</code>) with your Google account.' : 'Runs Claude Code (<code>claude</code>) with your Claude plan.'}</small></label>
      <label class="field"><span>Model</span>
        <select name="model">${opt(modelsFor(prov).map((m) => m.id), c.model, modelName)}</select></label>
      <label class="field"><span>Effort</span>
        ${efforts.length
          ? `<select name="effort">${opt(efforts, efforts.includes(c.effort) ? c.effort : (efforts.includes('medium') ? 'medium' : efforts[0]), (e) => EFFORT_LABEL[e])}</select>`
          : '<select disabled><option>Fixed for this model</option></select>'}</label>
      <div class="field"><span>Working folder</span>
        <div class="inline"><input name="cwd" value="${esc(c.cwd)}" placeholder="${esc(meta.home)}" spellcheck="false"><button type="button" data-browse="cwd">Browse…</button></div>
        <small>Where the agent starts, like running <code>${isAgy ? 'agy' : 'claude'}</code> in this folder.</small></div>
      <label class="switch"><input type="checkbox" name="fullAccess" ${c.fullAccess !== false ? 'checked' : ''}>
        <span><b>Full PC access</b><small class="muted" style="text-align:left;display:block">Lets the agent read and edit files on every drive (${esc(drives)}), not just its folder.</small></span></label>
      <label class="field"><span>Permissions</span>
        <select name="permissionMode">${opt(meta.permissionModes, c.permissionMode, (p) => PERMISSION_INFO[p] || p)}</select>
        <small class="${c.permissionMode === 'bypassPermissions' ? 'warn' : ''}">${c.permissionMode === 'bypassPermissions'
          ? 'Bypass lets the agent run any command without checks.' + (c.fullAccess !== false ? ' Combined with full PC access it can change anything on this computer.' : '')
          : (c.permissionMode === 'smart' || c.permissionMode === 'ask') && isAgy
            ? 'Antigravity can’t ask mid-task, so ClaudeChat checks every command it wants to run: safe ones run, risky ones wait for your Allow/Deny. File edits inside its folders happen directly.'
          : c.permissionMode === 'smart' || c.permissionMode === 'ask'
            ? 'Risky means deleting files, editing outside the working folder, system or registry changes, git push, admin rights, secrets and the like. The agent pauses and you get Allow/Deny in the chat.'
            : 'This mode never asks you. Pick “Ask when risky” to approve dangerous actions yourself.'}</small></label>
      ${(c.allowRules || []).length ? `
      <div class="field"><span>Always allowed</span>
        <div class="rules">${c.allowRules.map((r) => `<span class="rule">${esc(r.replace(':', ' · '))}<button type="button" data-rmrule="${esc(r)}" aria-label="Remove">✕</button></span>`).join('')}</div>
        <small>Similar actions run without asking. Remove one to be asked again.</small></div>` : ''}
      <label class="field"><span>About / instructions</span>
        <textarea name="systemPrompt" rows="3" placeholder="e.g. You are my backend reviewer. Be terse.">${esc(c.systemPrompt || '')}</textarea>
        <small>Added to the agent’s system prompt.</small></label>
      <label class="field"><span>Resume session ID</span>
        <input name="sessionId" value="${esc(c.sessionId || '')}" placeholder="optional: continue an existing Claude Code conversation" spellcheck="false" pattern="[0-9a-fA-F-]{36}">
        <small>Paste a session ID (shown by <code>claude --resume</code>) to reconnect this agent to that conversation's memory.</small></label>`;
  }

  function groupSettingsHtml(g) {
    const all = agents();
    const turns = [4, 8, 12, 20, 30, 50];
    return `
      <label class="switch"><input type="checkbox" name="teamTalk" ${g.teamTalk ? 'checked' : ''}>
        <span><b>🗣️ Team talk</b><small class="muted" style="text-align:left;display:block">Agents @mention each other to hand off work and keep going until the job is done.</small></span></label>
      <label class="switch"><input type="checkbox" name="parallel" ${g.parallel ? 'checked' : ''}>
        <span><b>⚡ Work at the same time</b><small class="muted" style="text-align:left;display:block">Everyone who's asked works in parallel instead of waiting their turn.</small></span></label>
      <label class="field"><span>Hand-off limit per message</span>
        <select name="maxTurns" ${g.teamTalk ? '' : 'disabled'}>${turns.map((n) => `<option value="${n}" ${n === (g.maxTurns || 12) ? 'selected' : ''}>${n} hand-offs</option>`).join('')}</select>
        <small>How many times agents can pull each other in before pausing for you, so a long back-and-forth can't eat your limits.</small></label>
      <div class="field"><span>Shared project folder</span>
        <div class="inline"><input name="cwd" value="${esc(g.cwd || '')}" placeholder="Empty: each agent uses its own folder" spellcheck="false"><button type="button" data-browse="cwd">Browse…</button></div>
        <small>Set one folder and the whole team builds the project there.</small></div>
      <label class="field"><span>Project / topic</span>
        <textarea name="systemPrompt" rows="3" placeholder="What is this team building?">${esc(g.systemPrompt || '')}</textarea></label>
      <div class="field"><span>Members${g.parallel ? '' : ' · answer in this order'}</span>
        ${all.length ? all.map((a) => `
          <label class="member-row">
            <input type="checkbox" name="member" value="${a.id}" ${(g.members || []).includes(a.id) ? 'checked' : ''}>
            <div class="avatar" style="--av:${a.color}">${esc(a.avatar)}</div>
            <span>${esc(a.name)}<br><small>${esc(modelName(a.model))} · ${esc(shortPath(a.cwd))}</small></span>
          </label>`).join('') : '<small>Create some agents first.</small>'}
        <small>Each agent keeps its own model and permissions here, with a separate memory for this group. The first line of an agent's “About” tells the team what its role is.</small></div>`;
  }

  // Browse buttons in any form open the folder picker for the named input.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-browse]');
    if (!b) return;
    const inputEl = b.closest('form').querySelector(`[name="${b.dataset.browse}"]`);
    const picked = await pickFolder(inputEl.value);
    if (picked) {
      inputEl.value = picked;
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // ---------- info drawer ----------
  $('#btnInfo').onclick = $('#headInfo').onclick = () => {
    const d = $('#drawer');
    d.hidden = !d.hidden;
    if (!d.hidden) renderDrawer();
  };
  $('#btnCloseDrawer').onclick = () => ($('#drawer').hidden = true);

  function renderDrawer() {
    const c = chats.get(activeId);
    if (!c) return;
    const isGroup = c.type === 'group';
    const av = $('#infoAvatar');
    av.textContent = c.avatar;
    av.style.setProperty('--av', c.color);
    $('#infoName').value = c.name;
    const cost = c.totalCost ? ` · ${money(c.totalCost)} est.` : '';
    const count = c.messageCount ?? activeMessages.length;
    $('#infoMeta').innerHTML = isGroup
      ? `Group · ${(c.members || []).length} agents · ${count} messages${cost}`
      : `${esc(modelName(c.model))} · ${count} messages${cost}<br><small>${c.sessionId ? 'session ' + esc(c.sessionId.slice(0, 8)) : 'no session yet'}</small>`;
    $('#infoForm').innerHTML = isGroup ? groupSettingsHtml(c) : agentSettingsHtml(c);
    $('#btnPin').textContent = c.pinned ? '📌 Unpin chat' : '📌 Pin chat';
    $('#btnMute').textContent = c.muted ? '🔔 Unmute notifications' : '🔕 Mute notifications';
    $('#btnDelete').textContent = isGroup ? '🗑️ Delete group' : '🗑️ Delete agent';
    $('#infoEmojis').innerHTML = meta.avatars.map((a) => `<button type="button" data-a="${a}">${a}</button>`).join('');
  }

  $('#infoAvatar').onclick = () => ($('#infoEmojis').hidden = !$('#infoEmojis').hidden);
  $('#infoEmojis').onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    $('#infoEmojis').hidden = true;
    await updateChat(activeId, { avatar: b.dataset.a });
    renderDrawer();
  };
  $('#infoName').addEventListener('change', (e) => updateChat(activeId, { name: e.target.value }));
  $('#infoName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#infoForm').addEventListener('change', async (e) => {
    const f = e.target;
    if (!f.name) return;
    let patch;
    if (f.name === 'provider') {
      if (!confirm(`Switch this agent to ${meta.providers[f.value]?.name || f.value}? It starts a fresh conversation (it won't remember this chat's earlier messages).`)) { renderDrawer(); return; }
    }
    if (f.name === 'member') patch = { members: [...$('#infoForm').querySelectorAll('[name=member]:checked')].map((x) => x.value) };
    else if (f.type === 'checkbox') patch = { [f.name]: f.checked };
    else patch = { [f.name]: f.value };
    await updateChat(activeId, patch);
    if (['permissionMode', 'fullAccess', 'member', 'provider', 'model', 'teamTalk', 'parallel'].includes(f.name)) renderDrawer();
  });
  $('#infoForm').addEventListener('submit', (e) => e.preventDefault());
  $('#infoForm').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rmrule]');
    if (!b) return;
    const c = chats.get(activeId);
    await updateChat(activeId, { allowRules: (c.allowRules || []).filter((r) => r !== b.dataset.rmrule) });
    renderDrawer();
  });
  $('#btnPin').onclick = async () => { const c = chats.get(activeId); await updateChat(activeId, { pinned: !c.pinned }); renderDrawer(); };
  $('#btnMute').onclick = async () => { const c = chats.get(activeId); await updateChat(activeId, { muted: !c.muted }); renderDrawer(); };
  $('#btnExport').onclick = () => { window.location.href = `/api/chats/${activeId}/export`; };
  $('#btnReset').onclick = async () => {
    if (!confirm('Start a new session? The chat history is cleared and the agent forgets this conversation.')) return;
    await api('POST', `/chats/${activeId}/reset`).catch((e) => toast(e.message));
    openChat(activeId);
  };
  $('#btnDelete').onclick = async () => {
    const c = chats.get(activeId);
    if (!confirm(`Delete “${c.name}”? This removes the chat from ClaudeChat. Files on your PC are untouched.`)) return;
    await api('DELETE', `/chats/${activeId}`).catch((e) => toast(e.message));
  };

  // ---------- new agent ----------
  const newDialog = $('#newDialog');
  let newAvatar = null;
  function openNew() {
    newAvatar = meta.avatars[agents().length % meta.avatars.length];
    const defaults = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'smart', fullAccess: true, cwd: meta.home, systemPrompt: '' };
    $('#newAvatars').innerHTML = meta.avatars.map((a) => `<button type="button" data-a="${a}" class="${a === newAvatar ? 'sel' : ''}">${a}</button>`).join('');
    renderNewSettings(defaults, '');
    newDialog.showModal();
  }
  function renderNewSettings(values, name) {
    $('#newSettings').innerHTML = `
      <label class="field"><span>Name</span><input name="name" required maxlength="60" placeholder="e.g. Frontend dev" value="${esc(name)}" autofocus></label>
      ${agentSettingsHtml(values)}`;
  }
  // Picking a provider or model in the new-agent form refreshes the model and effort lists.
  $('#newSettings').addEventListener('change', (e) => {
    if (e.target.name !== 'provider' && e.target.name !== 'model') return;
    const form = $('#newForm');
    const v = Object.fromEntries(new FormData(form));
    v.fullAccess = form.querySelector('[name=fullAccess]').checked;
    if (e.target.name === 'provider') {
      const first = modelsFor(v.provider)[0];
      v.model = first?.id;
      v.effort = v.provider === 'antigravity' ? 'medium' : 'high';
      if (v.provider === 'antigravity' && newAvatar === meta.avatars[agents().length % meta.avatars.length]) {
        newAvatar = '✨';
        $('#newAvatars').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x.dataset.a === newAvatar));
      }
    }
    renderNewSettings(v, v.name || '');
  });
  $('#btnNew').onclick = $('#btnNewEmpty').onclick = openNew;
  $('#newAvatars').onclick = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    newAvatar = b.dataset.a;
    $('#newAvatars').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
  };
  newDialog.addEventListener('close', async () => {
    if (newDialog.returnValue !== 'ok') return;
    const form = $('#newForm');
    const data = Object.fromEntries(new FormData(form));
    data.fullAccess = form.querySelector('[name=fullAccess]').checked;
    try {
      const c = await api('POST', '/chats', { ...data, avatar: newAvatar });
      chats.set(c.id, c);
      openChat(c.id);
    } catch (e) { toast(e.message); }
  });

  // ---------- new group ----------
  const groupDialog = $('#groupDialog');
  function openGroup() {
    const all = agents();
    if (all.length < 2) return toast('Create at least two agents first, then group them.');
    $('#groupForm').reset();
    $('#groupMembers').innerHTML = all.map((a) => `
      <label class="bc-item">
        <input type="checkbox" value="${a.id}" checked>
        <div class="avatar sm" style="--av:${a.color}">${esc(a.avatar)}</div>
        <span>${esc(a.name)}</span><span class="busy">${esc(modelName(a.model))}</span>
      </label>`).join('');
    groupDialog.showModal();
  }
  $('#btnGroup').onclick = $('#btnGroupEmpty').onclick = openGroup;
  groupDialog.addEventListener('close', async () => {
    if (groupDialog.returnValue !== 'ok') return;
    const form = $('#groupForm');
    const members = [...$('#groupMembers').querySelectorAll('input:checked')].map((i) => i.value);
    if (!members.length) return toast('Pick at least one agent.');
    try {
      const c = await api('POST', '/chats', {
        type: 'group',
        name: form.name.value,
        systemPrompt: form.systemPrompt.value,
        members,
        teamTalk: form.teamTalk.checked,
        parallel: form.parallel.checked,
        cwd: form.cwd.value.trim(),
      });
      chats.set(c.id, c);
      openChat(c.id);
    } catch (e) { toast(e.message); }
  });

  // ---------- broadcast ----------
  const bcDialog = $('#bcDialog');
  $('#btnBroadcast').onclick = () => {
    if (!chats.size) return toast('Create an agent first.');
    $('#bcList').innerHTML = sortedChats().map((c) => `
      <label class="bc-item">
        <input type="checkbox" value="${c.id}" ${c.type === 'group' ? '' : 'checked'}>
        <div class="avatar sm" style="--av:${c.color}">${esc(c.avatar)}</div>
        <span>${esc(c.name)}</span>
        ${c.running ? '<span class="busy">busy · will queue</span>' : ''}
      </label>`).join('');
    $('#bcText').value = '';
    bcDialog.showModal();
  };
  bcDialog.addEventListener('close', async () => {
    if (bcDialog.returnValue !== 'ok') return;
    const chatIds = [...$('#bcList').querySelectorAll('input:checked')].map((i) => i.value);
    const text = $('#bcText').value.trim();
    if (!chatIds.length || !text) return;
    askNotify();
    try {
      const { results } = await api('POST', '/broadcast', { chatIds, text });
      const q = results.filter((r) => r.queued).length;
      toast(`Sent to ${results.length} chat${results.length === 1 ? '' : 's'}${q ? ` · ${q} queued` : ''}`);
    } catch (e) { toast(e.message); }
  });

  // ---------- folder picker ----------
  const folderDialog = $('#folderDialog');
  let fpPath = null;
  let fpResolve = null;

  function pickFolder(start) {
    return new Promise((resolve) => {
      fpResolve = resolve;
      folderDialog.showModal();
      loadFolder(start || meta.home);
    });
  }
  async function loadFolder(p) {
    try {
      const r = await api('GET', `/fs/list?path=${encodeURIComponent(p)}${$('#fpHidden').checked ? '&hidden=1' : ''}`);
      fpPath = r.path;
      $('#fpInput').value = r.path;
      $('#fpUp').disabled = !r.parent;
      $('#fpUp').dataset.parent = r.parent || '';
      $('#fpPlaces').innerHTML = [
        ...r.places.map((pl) => `<button type="button" data-go="${esc(pl.path)}">${pl.name === 'Home' ? '🏠' : '📁'} ${esc(pl.name)}</button>`),
        ...r.drives.map((d) => `<button type="button" data-go="${esc(d)}">💽 ${esc(d.replace(/\\$/, ''))}</button>`),
      ].join('');
      const sep = r.path.endsWith('\\') || r.path.endsWith('/') ? '' : (r.path.includes('\\') ? '\\' : '/');
      $('#fpList').innerHTML = r.dirs.length
        ? r.dirs.map((d) => `<li data-go="${esc(r.path + sep + d)}">📁 ${esc(d)}</li>`).join('')
        : '<li class="fp-empty">No subfolders</li>';
      $('#fpList').scrollTop = 0;
    } catch (e) {
      toast(e.message);
    }
  }
  folderDialog.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) loadFolder(go.dataset.go);
  });
  $('#fpUp').onclick = () => { const p = $('#fpUp').dataset.parent; if (p) loadFolder(p); };
  $('#fpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadFolder(e.target.value); } });
  $('#fpHidden').onchange = () => fpPath && loadFolder(fpPath);
  $('#fpMkdir').onclick = async () => {
    const name = prompt('New folder name');
    if (!name) return;
    try {
      const r = await api('POST', '/fs/mkdir', { path: fpPath, name });
      loadFolder(r.path);
    } catch (e) { toast(e.message); }
  };
  folderDialog.addEventListener('close', () => {
    const r = fpResolve;
    fpResolve = null;
    r?.(folderDialog.returnValue === 'ok' ? fpPath : null);
  });

  // ---------- usage ----------
  function levelClass(p) { return p >= 90 ? 'bad' : p >= 75 ? 'warn' : ''; }
  function resetIn(ts) {
    const ms = ts * 1000 - Date.now();
    if (ms <= 0) return 'Resets now · refresh to update';
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return `Resets in ${h ? `${h} hr ` : ''}${m} min`;
  }
  function resetAt(ts) {
    const d = new Date(ts * 1000);
    if (d < new Date()) return 'Resets now · refresh to update';
    return `Resets ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  function renderUsage() {
    const lim = usage?.limits;
    const set = (barSel, pctSel, w) => {
      const p = w ? Math.round((w.utilization || 0) * 100) : null;
      const bar = $(barSel);
      bar.style.width = p === null ? '0' : Math.min(p, 100) + '%';
      bar.className = p === null ? '' : levelClass(p);
      return p;
    };
    const s = set('#umSession', '', lim?.fiveHour);
    const w = set('#umWeekly', '', lim?.sevenDay);
    $('#umSessionPct').textContent = s === null ? '–' : s + '%';
    $('#umWeeklyPct').textContent = w === null ? '–' : w + '%';
    set('#ucSessionBar', '', lim?.fiveHour);
    set('#ucWeeklyBar', '', lim?.sevenDay);
    $('#ucSessionPct').textContent = s === null ? '–' : `${s}% used`;
    $('#ucWeeklyPct').textContent = w === null ? '–' : `${w}% used`;
    $('#ucSessionReset').textContent = lim?.fiveHour?.resetsAt ? resetIn(lim.fiveHour.resetsAt) : 'No data yet. Send a message or press refresh.';
    $('#ucWeeklyReset').textContent = lim?.sevenDay?.resetsAt ? resetAt(lim.sevenDay.resetsAt) : 'No data yet';
    const foot = $('#ucFoot');
    const limited = lim && lim.status && !String(lim.status).startsWith('allowed');
    foot.className = 'uc-foot' + (limited ? ' bad' : '');
    foot.textContent = limited
      ? `Limit reached. Agents will fail until the ${lim.rateLimitType === 'seven_day' ? 'weekly' : 'session'} limit resets.`
      : lim?.updatedAt ? `Updated ${ago(lim.updatedAt)}, from your agents' replies.` : '';

    const sp = usage?.spend;
    $('#ucSpend').innerHTML = sp ? `
      <div class="sp-tot"><span>Today ${money(sp.today)}</span><span>7 days ${money(sp.week)}</span></div>
      ${usage.agents.filter((a) => a.total > 0 || a.tokens > 0).slice(0, 8).map((a) => `
        <div class="sp-row"><span>${esc(a.avatar)}</span><span>${esc(a.name)}</span><span>${a.provider === 'antigravity' ? `${tokenCount(a.tokens)} tokens` : `${money(a.today)} today · ${money(a.total)}`}</span></div>`).join('') || '<div class="sp-row"><span></span><span>No activity yet</span><span></span></div>'}
      <div class="uc-foot">Estimated API-equivalent cost reported by Claude Code. On a Pro/Max plan your agents count against the limits above instead. Antigravity agents show tokens used, which count against your Google plan, not the limits above.</div>` : '';
  }

  $('#usageMini').onclick = (e) => {
    e.stopPropagation();
    $('#usageCard').hidden = !$('#usageCard').hidden;
    if (!$('#usageCard').hidden) api('GET', '/usage').then((u) => { usage = u; renderUsage(); }).catch(() => {});
  };
  $('#ucSpendBtn').onclick = () => { $('#ucSpend').hidden = !$('#ucSpend').hidden; };
  $('#ucRefresh').onclick = async () => {
    const b = $('#ucRefresh');
    b.disabled = true;
    b.style.animation = 'spin 1s linear infinite';
    try { usage = await api('POST', '/usage/refresh'); renderUsage(); }
    catch (e) { toast(e.message); }
    finally { b.disabled = false; b.style.animation = ''; }
  };
  setInterval(renderUsage, 30000);

  // ---------- live events ----------
  function onEvent(ev) {
    switch (ev.type) {
      case 'chat': {
        const prev = chats.get(ev.chat.id);
        chats.set(ev.chat.id, { ...prev, ...ev.chat });
        if (ev.chat.id === activeId) { renderHeader(); if (!$('#drawer').hidden && !$('#drawer').contains(document.activeElement)) renderDrawer(); }
        renderList();
        break;
      }
      case 'chat_deleted':
        chats.delete(ev.chatId);
        if (ev.chatId === activeId) closeChat();
        renderList();
        break;
      case 'message': {
        const c = chats.get(ev.chatId);
        if (!c) break;
        c.updatedAt = ev.message.ts;
        // Copy: the open conversation holds its own object and appends deltas to it.
        if (isBubble(ev.message)) c.lastMessage = { ...ev.message };
        c.messageCount = (c.messageCount || 0) + 1;
        if (ev.chatId === activeId) appendMessage(ev.message);
        const away = ev.chatId !== activeId || document.hidden;
        if ((ev.message.role === 'assistant' || ev.message.role === 'approval') && away) {
          unread[ev.chatId] = (unread[ev.chatId] || 0) + 1;
          store('cc-unread', unread);
        }
        // An agent is blocked until you answer, so this alerts even for muted chats.
        if (ev.message.role === 'approval' && away) {
          beep();
          if ('Notification' in window && Notification.permission === 'granted') {
            const a = ev.message.approval;
            const n = new Notification(`⚠️ ${c.name} needs your approval`, { body: `${a.tool}: ${a.summary}`.slice(0, 160), tag: ev.message.id, requireInteraction: true });
            n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
          }
        }
        renderList();
        break;
      }
      case 'message_update': {
        const c = chats.get(ev.chatId);
        if (c?.lastMessage?.id === ev.message.id) c.lastMessage = { ...ev.message };
        if (ev.chatId === activeId) replaceMessage(ev.message);
        renderList();
        break;
      }
      case 'delta': {
        const c = chats.get(ev.chatId);
        if (c?.lastMessage?.id === ev.messageId) c.lastMessage.text += ev.text;
        if (ev.chatId === activeId) applyDelta(ev.messageId, ev.text);
        break;
      }
      case 'status': {
        const c = chats.get(ev.chatId);
        if (!c) break;
        const finished = c.running && !ev.running;
        c.status = ev.status;
        c.running = ev.running;
        if (ev.chatId === activeId) { renderHeader(); renderTyping(); }
        renderList();
        if (finished) notifyDone(c);
        break;
      }
      case 'usage':
        usage = ev.usage;
        renderUsage();
        break;
    }
  }

  function notifyDone(c) {
    if (c.muted) return;
    const away = document.hidden || c.id !== activeId;
    if (!away) return;
    beep();
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(`${c.avatar} ${c.name}`, { body: (c.lastMessage?.text || 'Finished').slice(0, 140), tag: c.id });
      n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
    }
  }

  let audio;
  function beep() {
    try {
      audio = audio || new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, audio.currentTime);
      o.frequency.setValueAtTime(1320, audio.currentTime + 0.09);
      g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.26);
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeId && unread[activeId]) { unread[activeId] = 0; store('cc-unread', unread); renderList(); }
  });

  async function refreshAll() {
    const list = await api('GET', '/chats');
    chats.clear();
    for (const c of list) chats.set(c.id, c);
    for (const id of Object.keys(unread)) if (!chats.has(id)) delete unread[id];
    renderList();
    if (activeId && chats.has(activeId)) openChat(activeId);
    else if (activeId) closeChat();
  }

  // ---------- boot ----------
  (async () => {
    meta = await api('GET', '/meta');
    syncSendButton();
    await refreshAll();
    usage = await api('GET', '/usage').catch(() => null);
    renderUsage();
    const es = new EventSource('/api/events');
    let first = true;
    es.onopen = () => { if (!first) refreshAll(); first = false; };
    es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    if (!chats.size) openNew();
  })().catch((e) => toast('Could not reach the ClaudeChat server: ' + e.message));
})();
