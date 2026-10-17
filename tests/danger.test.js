// Tests for danger.js, focused on video uploads, which always ask. Run: node tests/danger.test.js
const assert = require('assert');
const { assess } = require('../danger');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const bash = (command) => assess('Bash', { command }, '/home/u/project', '/home/u');

test('uploading a video to YouTube or TikTok always asks', () => {
  for (const cmd of [
    'curl -X POST -F "video=@clip.mp4" https://open.tiktokapis.com/v2/post/publish/video/init/',
    'python upload_video.py --file=final.mp4 --title "Hi"',
    'youtube-upload --title=x video.mov',
    'tiktok-uploader -v out.mp4 -d "caption"',
    'Invoke-RestMethod -Uri https://www.googleapis.com/upload/youtube/v3/videos -Method Post -InFile clip.mp4',
    "node scripts/post.js --upload 'my video.webm'",
  ]) {
    const a = bash(cmd);
    assert.ok(a.risky && a.alwaysAsk, cmd);
    assert.match(a.reasons[0], /Uploads a video online/);
  }
});

test('other video work and other uploads are not video uploads', () => {
  for (const cmd of ['yt-dlp https://youtube.com/watch?v=abc -o x.mp4', 'ffmpeg -i in.mov out.mp4', 'git status', 'curl -F file=@notes.txt https://example.com/upload', 'ls videos/']) {
    assert.ok(!bash(cmd).alwaysAsk, cmd);
  }
});

test('MCP tools that post to YouTube/TikTok always ask, others do not', () => {
  assert.ok(assess('mcp__youtube__upload_video', { path: 'a.mp4' }, '/p', '/h').alwaysAsk);
  assert.ok(assess('mcp__tiktok__publish', { file: 'a.mp4' }, '/p', '/h').alwaysAsk);
  assert.ok(!assess('mcp__youtube__search', { q: 'cats' }, '/p', '/h').alwaysAsk);
});

test('ordinary risky commands can still be always-allowed', () => {
  const a = bash('git push origin main');
  assert.ok(a.risky && !a.alwaysAsk);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✕ ${name}\n${e.stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
