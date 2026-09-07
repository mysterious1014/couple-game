// 服务端持久化回归测试（免浏览器）：真起一个隔离端口的 node index.js，
// 用临时 DATA_DIR，验证「写入 -> 重启 -> 读回」全链路，并验证旧 db.json 一次性导入。
// 用法：node tools/test-server-persistence.mjs [端口]
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

const HELPER_SRC = `// 直接 require server/store.js，验证「未登记字段」和「已知列里放对象」都不会丢
const path = require('path');
const mode = process.argv[2];
const { data, save } = require(path.join(process.argv[3], 'store.js'));
if (mode === 'write') {
  data.users.push({
    id: 'fidelity1', username: 'fidelity_one', nickname: '保真用户', password: 'x:y', role: 'user',
    score: 7, createdAt: 1, lastLogin: null, cpPartnerId: null, cpSince: null, cpCode: '',
    tags: ['a', { deep: true }],
    metadata: { nested: { ok: 1 } },
  });
  data.messages.push({ id: 'mf1', fromId: 'fidelity1', toId: 'admin', type: 'chat', text: { weird: 'object' }, ts: 2, read: false });
  save();
  console.log('written');
} else {
  const u = data.users.find((x) => x.id === 'fidelity1') || null;
  const m = data.messages.find((x) => x.id === 'mf1') || null;
  console.log(JSON.stringify({ user: u, msgText: m ? m.text : null }));
}`;
console.log('== 4. store.js 字段保真（未登记字段 / 已知列放对象值）==');
const helper = path.join(tmp, 'store-fidelity.cjs');
fs.writeFileSync(helper, HELPER_SRC);
function runHelper(mode) {
  return spawnSync(process.execPath, [helper, mode, serverDir], {
    cwd: serverDir,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DATA_DIR: dataDir }),
  });
}
const w = runHelper('write');
failures += check('store.js 写入保真数据成功', () => assert.ok(w.status === 0 && w.stdout.includes('written'), 'exit=' + w.status + ' out=' + w.stdout + ' err=' + w.stderr));
const r = runHelper('read');
const back = JSON.parse(r.stdout.trim().split('\n').pop());
failures += check('未登记的数组字段（tags）原样读回', () => assert.deepStrictEqual(back.user.tags, ['a', { deep: true }]));
failures += check('未登记的嵌套对象（metadata）原样读回', () => assert.deepStrictEqual(back.user.metadata, { nested: { ok: 1 } }));
failures += check('已知列（messages.text）放对象也不丢，走 extra 往返', () => assert.deepStrictEqual(back.msgText, { weird: 'object' }));
failures += check('数值列仍是数值、文本未被字符串化污染', () => { assert.strictEqual(back.user.score, 7); assert.strictEqual(back.user.username, 'fidelity_one'); });
failures += check('中文字段往返无损', () => assert.strictEqual(back.user.nickname, '保真用户'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==\n服务日志:\n` + logs.join('\n'));
process.exit(failures === 0 ? 0 : 1);