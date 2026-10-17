// YouTube support: agents can upload videos and change the channel's name or description
// through YouTube's official Data API v3, and every action waits for the user's Allow/Deny
// in ClaudeChat (see server.js). No screen or mouse control is involved.
//
// Setup is the user's own Google Cloud OAuth client ("Desktop app" type), so their channel
// is only reachable with their consent, and the tokens stay in data/youtube.json on their PC.
// Endpoints and fields are from the YouTube Data API v3 discovery document
// (https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest): videos.insert (resumable
// upload at /upload/youtube/v3/videos), channels.list / channels.update with part
// brandingSettings. Scope https://www.googleapis.com/auth/youtube covers both.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Overridable for tests (a fake Google server); real values otherwise.
const AUTH_URL = process.env.CLAUDECHAT_YT_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.CLAUDECHAT_YT_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API = process.env.CLAUDECHAT_YT_API || 'https://www.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/youtube';

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|3gp|mpeg|mpg)$/i;
const PRIVACY = ['private', 'unlisted', 'public'];

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body);
  });
}

const apiError = (r, what) => {
  const msg = r.data?.error?.message || r.data?.error_description || (typeof r.data?.error === 'string' ? r.data.error : '') || `HTTP ${r.status}`;
  return new Error(`${what}: ${msg}`);
};

function createYouTube(file) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  let pendingAuth = null; // { state, redirectUri }

  async function accessToken() {
    const t = state.tokens;
    if (!t?.refresh_token && !t?.access_token) throw new Error('YouTube is not connected. Connect it in ClaudeChat (▶ YouTube in the sidebar).');
    if (t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
    if (!t.refresh_token) throw new Error('YouTube login expired. Connect it again in ClaudeChat.');
    const r = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: state.clientId, client_secret: state.clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }).toString(),
    });
    if (r.status !== 200) throw apiError(r, 'Refreshing the YouTube login failed');
    state.tokens = { ...t, access_token: r.data.access_token, expires_at: Date.now() + (r.data.expires_in || 3600) * 1000 };
    save();
    return state.tokens.access_token;
  }

  async function api(method, p, body) {
    const token = await accessToken();
    return request(API + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function myChannel() {
    const r = await api('GET', '/youtube/v3/channels?part=snippet,brandingSettings&mine=true');
    if (r.status !== 200) throw apiError(r, 'Reading your channel failed');
    const ch = r.data?.items?.[0];
    if (!ch) throw new Error('This Google account has no YouTube channel.');
    return ch;
  }

  return {
    status() {
      return {
        configured: !!(state.clientId && state.clientSecret),
        connected: !!state.tokens?.refresh_token,
        channel: state.channel || null,
        clientId: state.clientId || '',
      };
    },

    configure(clientId, clientSecret) {
      clientId = String(clientId || '').trim();
      clientSecret = String(clientSecret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('That doesn’t look like an OAuth client ID (it ends in .apps.googleusercontent.com).');
      if (!clientSecret) throw new Error('Paste the client secret too.');
      if (clientId !== state.clientId) delete state.tokens;
      state.clientId = clientId;
      state.clientSecret = clientSecret;
      save();
    },

    // Google's consent page; Google sends the browser back to redirectUri (loopback flow).
    authUrl(redirectUri) {
      if (!state.clientId) throw new Error('Add your OAuth client ID and secret first.');
      pendingAuth = { state: crypto.randomBytes(16).toString('hex'), redirectUri };
      return `${AUTH_URL}?${new URLSearchParams({
        client_id: state.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state: pendingAuth.state,
      })}`;
    },

    async finishAuth(code, returnedState) {
      if (!pendingAuth || returnedState !== pendingAuth.state) throw new Error('This login link is stale. Start “Connect YouTube” again.');
      const { redirectUri } = pendingAuth;
      pendingAuth = null;
      const r = await request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: state.clientId, client_secret: state.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
      });
      if (r.status !== 200) throw apiError(r, 'Google login failed');
      state.tokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + (r.data.expires_in || 3600) * 1000 };
      save();
      const ch = await myChannel();
      state.channel = { id: ch.id, title: ch.snippet?.title || ch.brandingSettings?.channel?.title || '' };
      save();
      return state.channel;
    },

    disconnect() {
      delete state.tokens;
      delete state.channel;
      save();
    },

    // Checks an upload request before anyone is asked about it.
    checkUpload(req) {
      const file = path.resolve(String(req.file || ''));
      if (!req.file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Video file not found: ${req.file || '(none)'}`);
      if (!VIDEO_EXT.test(file)) throw new Error('That file isn’t a video (mp4, mov, webm, mkv…).');
      const title = String(req.title || '').trim() || path.basename(file).replace(VIDEO_EXT, '');
      if (title.length > 100) throw new Error('YouTube titles can be at most 100 characters.');
      const privacy = PRIVACY.includes(req.privacy) ? req.privacy : 'private';
      const tags = Array.isArray(req.tags) ? req.tags.map(String).slice(0, 30) : [];
      return { file, size: fs.statSync(file).size, title, description: String(req.description || '').slice(0, 5000), privacy, tags };
    },

    // Resumable upload: one POST with the metadata, then the file in a single PUT.
    async upload(u) {
      const token = await accessToken();
      const meta = { snippet: { title: u.title, description: u.description, tags: u.tags, categoryId: '22' }, status: { privacyStatus: u.privacy, selfDeclaredMadeForKids: false } };
      const start = await request(`${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(u.size), 'X-Upload-Content-Type': 'video/*' },
        body: JSON.stringify(meta),
      });
      if (start.status !== 200 || !start.headers.location) throw apiError(start, 'Starting the upload failed');
      const put = await request(start.headers.location, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(u.size), 'Content-Type': 'video/*' },
        body: fs.createReadStream(u.file),
      });
      if (put.status !== 200 && put.status !== 201) throw apiError(put, 'Uploading the video failed');
      return { id: put.data.id, url: `https://youtu.be/${put.data.id}`, privacy: u.privacy };
    },

    checkChannel(req) {
      const out = {};
      if (typeof req.title === 'string' && req.title.trim()) out.title = req.title.trim();
      if (typeof req.description === 'string') out.description = req.description;
      if (!('title' in out) && !('description' in out)) throw new Error('Give a new title and/or description.');
      if (out.title && out.title.length > 100) throw new Error('Channel names can be at most 100 characters.');
      if (out.description && out.description.length > 1000) throw new Error('Channel descriptions can be at most 1000 characters.');
      return out;
    },

    // channels.update replaces the whole brandingSettings part, so the current settings are
    // read first and only the requested fields change. Afterwards the channel is read back,
    // because YouTube may ignore a name change (names are tied to the Google account).
    async updateChannel(change) {
      const ch = await myChannel();
      const branding = ch.brandingSettings || {};
      branding.channel = { ...(branding.channel || {}), ...change };
      const r = await api('PUT', '/youtube/v3/channels?part=brandingSettings', { id: ch.id, brandingSettings: branding });
      if (r.status !== 200) throw apiError(r, 'Updating your channel failed');
      const after = await myChannel();
      const now = { title: after.snippet?.title || after.brandingSettings?.channel?.title || '', description: after.brandingSettings?.channel?.description ?? '' };
      state.channel = { id: after.id, title: now.title };
      save();
      const notApplied = Object.keys(change).filter((k) => now[k] !== change[k]);
      return { ...now, notApplied };
    },
  };
}

module.exports = { createYouTube, VIDEO_EXT };
