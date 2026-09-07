// 服务端持久化回归测试（免浏览器）：真起一个隔离端口的 node index.js，
// 用临时 DATA_DIR，验证「写入 -> 重启 -> 读回」全链路，并验证旧 db.json 一次性导入。
// 用法：node tools/test-server-persistence.mjs [端口]
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const PORT = Number(process.argv[2] || 4310);
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-persist-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let child = null;
const logs = [];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}

function startServer() {
  child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => logs.push(String(b).trim()));
  child.stderr.on('data', (b) => logs.push('STDERR ' + String(b).trim()));
}

async function stopServer() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill();
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
  });
}

class Client {
  constructor() { this.cookie = ''; }
  async call(pathname, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }
  post(pathname, payload) {
    return this.call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/leaderboard');
      if (res.status === 200) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务未在预期时间内就绪\n' + logs.join('\n'));
}

function check(name, fn) {
  try { fn(); console.log('  OK   ' + name); return 0; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); return 1; }
}

let failures = 0;
const legacyPw = 'legacy123';

// 预置一份旧版 JSON 库，验证一次性迁移
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  users: [{ id: 'legacy1', username: 'legacyone', nickname: '旧版用户', password: hashPassword(legacyPw), role: 'user', score: 1234, createdAt: 1700000000000, lastLogin: null, cpPartnerId: null, cpSince: null, cpCode: '' }],
  sessions: {}, records: [], friendships: [], blocks: [], messages: [],
}));

console.log('== 1. 旧 db.json 一次性导入 SQLite ==');
startServer();
await waitReady();
const legacy = new Client();
const legacyLogin = await legacy.post('/api/login', { username: 'legacyone', password: legacyPw });
failures += check('旧账号可登录（密码哈希完整往返）', () => assert.strictEqual(legacyLogin.status, 200));
failures += check('sqlite 文件已生成', () => assert.ok(fs.existsSync(path.join(dataDir, 'couple-game.sqlite'))));
failures += check('db.json 已改名备份', () => assert.ok(fs.readdirSync(dataDir).some((f) => /^db\.imported-\d+\.json$/.test(f))));

console.log('== 2. 写入路径（注册/战绩/好友/私信）==');
const a = new Client();
const b = new Client();
const regA = await a.post('/api/register', { username: 'persist_a', password: 'pw123456', nickname: '阿 A' });
const regB = await b.post('/api/register', { username: 'persist_b', password: 'pw123456', nickname: '阿 B' });
failures += check('两个测试账号注册成功', () => { assert.strictEqual(regA.status, 200); assert.strictEqual(regB.status, 200); });

const play = await a.post('/api/play', { gameId: 'gomoku', gameName: '五子棋', opponent: '阿 B', result: 'win' });
failures += check('战绩上报后积分 +20', () => { assert.strictEqual(play.status, 200); assert.strictEqual(play.body.score, 1020); });

const reqRel = await a.post('/api/friends/request', { username: 'persist_b' });
failures += check('A 向 B 发起好友请求', () => assert.strictEqual(reqRel.status, 200));
const accRel = await b.post('/api/friends/accept', { userId: regA.body.id });
failures += check('B 接受好友请求', () => assert.strictEqual(accRel.status, 200));

const msg = await a.post('/api/messages', { toUserId: regB.body.id, type: 'chat', text: '重启后还在吗' });
failures += check('A 给 B 发私信', () => assert.strictEqual(msg.status, 200));
const unread = await b.call('/api/messages/unread');
failures += check('B 拉取未读并标记已读', () => { assert.strictEqual(unread.body.count, 1); assert.strictEqual(unread.body.items[0].text, '重启后还在吗'); });

console.log('== 3. 重启进程后数据仍在 ==');
await stopServer();
startServer();
await waitReady();

const oldSession = await a.call('/api/me');
failures += check('重启前的登录态（sessions 表）仍然有效', () => assert.strictEqual(oldSession.status, 200));

const a2 = new Client();
const relogin = await a2.post('/api/login', { username: 'persist_a', password: 'pw123456' });
failures += check('重启后仍可登录', () => assert.strictEqual(relogin.status, 200));
const myRecs = await a2.call('/api/me/records');
failures += check('战绩记录持久化', () => {
  assert.strictEqual(myRecs.status, 200);
  assert.strictEqual(myRecs.body.length, 1);
  assert.strictEqual(myRecs.body[0].gameId, 'gomoku');
});
const me = await a2.call('/api/me');
failures += check('积分持久化（1020）', () => assert.strictEqual(me.body.score, 1020));

const b2 = new Client();
await b2.post('/api/login', { username: 'persist_b', password: 'pw123456' });
const thread = await b2.call('/api/messages?peer=' + encodeURIComponent(relogin.body.id));
failures += check('私信内容持久化（含中文）', () => {
  assert.strictEqual(thread.body.length, 1);
  assert.strictEqual(thread.body[0].text, '重启后还在吗');
});
const unread2 = await b2.call('/api/messages/unread');
failures += check('已读状态持久化（不再重复未读）', () => assert.strictEqual(unread2.body.items.length, 0));
const friends = await b2.call('/api/friends');
failures += check('好友关系持久化（出现在好友列表）', () => {
  assert.strictEqual(friends.status, 200);
  assert.ok(Array.isArray(friends.body.friends));
  assert.ok(friends.body.friends.some((f) => f.id === relogin.body.id));
});
const friendsA = await a2.call('/api/friends');
failures += check('反向好友关系也持久化', () => assert.ok(friendsA.body.friends.some((f) => f.id === regB.body.id)));

failures += check('旧 db.json 未被重复导入（无第二个 imported 文件）', () => {
  assert.strictEqual(fs.readdirSync(dataDir).filter((f) => /^db\.imported-\d+\.json$/.test(f)).length, 1);
});

await stopServer();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==\n服务日志:\n` + logs.join('\n'));
process.exit(failures === 0 ? 0 : 1);