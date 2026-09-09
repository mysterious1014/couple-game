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
// 用法：node tools/test-server-persistence.mjs [端口] [--url postgres://user:pw@host:port/db]
// 不给 --url = 测默认的 SQLite 驱动；给了 = 测 Postgres 驱动（会先清掉该库里的本应用表）
const argv = process.argv.slice(2);
const PORT = Number(argv[0] || 4310);
const pgUrl = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : '';
const EXPECTED_DRIVER = pgUrl ? 'postgres' : 'sqlite';
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-persist-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function childEnv(dir, port) {
  const env = Object.assign({}, process.env, { PORT: String(port || PORT), DATA_DIR: dir || dataDir });
  if (pgUrl) env.DATABASE_URL = pgUrl;
  return env;
}
let child = null;
const logs = [];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}

function startServer(dir, port) {
  child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: childEnv(dir, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => logs.push(String(b).trim()));
  child.stderr.on('data', (b) => logs.push('STDERR ' + String(b).trim()));
}

async function stopServer() {
  await new Promise((r) => setTimeout(r, 400));   // 等异步写队列落库
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
    return { status: res.status, body, setCookie: set };
  }
  post(pathname, payload) {
    return this.call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }
}

// Set-Cookie 里的 Max-Age（秒）；没有就返回 null
function maxAgeOf(cookieStr) {
  const m = /Max-Age=(\d+)/i.exec(cookieStr);
  return m ? Number(m[1]) : null;
}

// 两个已登录客户端之间完成一次「双方互相印证」的结算（服务端权威记分，见 /api/match/report）。
// 返回双方各自看到的最终结果：先上报的一方要靠 GET /api/match/:id 才知道结局。
async function settle(host, guest, gameId, gameName, hostResult, guestResult, roundHint = 1) {
  const rnd = Math.random().toString(36).slice(2, 8);
  const created = await host.post('/api/rooms', { peerId: 'peer-h-' + rnd, hostName: '房主' });
  if (created.status !== 200) throw new Error('建房失败 ' + JSON.stringify(created.body));
  const code = created.body.code;
  const joined = await guest.post(`/api/rooms/${code}/join`, { password: '' });
  if (joined.status !== 200) throw new Error('加入房间失败 ' + JSON.stringify(joined.body));
  await host.post('/api/match/report', { roomCode: code, gameId, gameName, result: hostResult, roundHint });
  const guestView = await guest.post('/api/match/report', { roomCode: code, gameId, gameName, result: guestResult, roundHint });
  const matchId = (guestView.body && guestView.body.id) || '';
  const hostView = await host.call('/api/match/' + matchId);
  return { code, secret: created.body.secret, guestSecret: joined.body.secret, matchId, hostView: hostView.body, guestView: guestView.body };
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

// Postgres 模式：先清掉这个库里的应用表，保证可以重复跑（只动我们自己那 7 张表）
if (pgUrl) {
  const { createRequire } = await import('node:module');
  const requireFromServer = createRequire(path.join(serverDir, 'noop.js'));
  const pg = requireFromServer('pg');
  const client = new pg.Client({ connectionString: pgUrl });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS users, sessions, game_records, friendships, blocks, messages, meta CASCADE');
  await client.end();
}

console.log('== 1. 旧 db.json 一次性导入' + (pgUrl ? '（Postgres 驱动）' : '（SQLite 驱动）') + ' ==');

startServer();
await waitReady();
const legacy = new Client();
const legacyLogin = await legacy.post('/api/login', { username: 'legacyone', password: legacyPw });
failures += check('旧账号可登录（密码哈希完整往返）', () => assert.strictEqual(legacyLogin.status, 200));
const health = await new Client().call('/api/health');
failures += check('存储驱动符合预期（' + EXPECTED_DRIVER + '）', () => {
  assert.strictEqual(health.body.ok, true);
  assert.strictEqual(health.body.driver, EXPECTED_DRIVER);
  assert.ok(health.body.schemaVersion >= 3, JSON.stringify(health.body));
});
if (!pgUrl) failures += check('sqlite 文件已生成', () => assert.ok(fs.existsSync(path.join(dataDir, 'couple-game.sqlite'))));
failures += check('db.json 已改名备份', () => assert.ok(fs.readdirSync(dataDir).some((f) => /^db\.imported-\d+\.json$/.test(f))));

console.log('== 2. 写入路径（注册/战绩/好友/私信）==');
const a = new Client();
const b = new Client();
const regA = await a.post('/api/register', { username: 'persist_a', password: 'pw123456', nickname: '阿 A' });
const regB = await b.post('/api/register', { username: 'persist_b', password: 'pw123456', nickname: '阿 B' });
failures += check('两个测试账号注册成功', () => { assert.strictEqual(regA.status, 200); assert.strictEqual(regB.status, 200); });

const settled1 = await settle(a, b, 'gomoku', '五子棋', 'win', 'lose');
failures += check('双方确认后 A（胜方）积分 +20', () => {
  assert.strictEqual(settled1.hostView.status, 'settled', JSON.stringify(settled1.hostView));
  assert.strictEqual(settled1.hostView.score, 1020);
});
failures += check('双方确认后 B（负方）积分 -15', () => {
  assert.strictEqual(settled1.guestView.status, 'settled', JSON.stringify(settled1.guestView));
  assert.strictEqual(settled1.guestView.score, 985);
});
const retired = await a.post('/api/play', { gameId: 'gomoku', result: 'win' });
failures += check('POST /api/play 不再存在（防刷分）', () => assert.strictEqual(retired.status, 404));

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

// 「记住账号密码」的会话时长：勾了 remember 给 30 天，不勾维持原来的 7 天
const plainLogin = await new Client().post('/api/login', { username: 'persist_a', password: 'pw123456' });
failures += check('默认登录：会话 Cookie 仍是 7 天且 HttpOnly', () => {
  const c = plainLogin.setCookie.join(' ');
  assert.match(c, /sid=/);
  assert.ok(/HttpOnly/i.test(c), '缺 HttpOnly: ' + c);
  assert.strictEqual(maxAgeOf(c), 7 * 24 * 3600);
});
const rememberLogin = await new Client().post('/api/login', { username: 'persist_a', password: 'pw123456', remember: true });
failures += check('remember=true：会话 Cookie 拉长到 30 天', () => {
  assert.strictEqual(rememberLogin.status, 200);
  assert.strictEqual(maxAgeOf(rememberLogin.setCookie.join(' ')), 30 * 24 * 3600);
});
const rememberReg = await new Client().post('/api/register', { username: 'remember_me_user', password: 'pw123456', remember: true });
failures += check('注册也认 remember', () => {
  assert.strictEqual(rememberReg.status, 200);
  assert.strictEqual(maxAgeOf(rememberReg.setCookie.join(' ')), 30 * 24 * 3600);
});
const plainReg = await new Client().post('/api/register', { username: 'remember_plain_user', password: 'pw123456' });
failures += check('注册不勾时保持 7 天（没被顺手改默认值）', () => {
  assert.strictEqual(maxAgeOf(plainReg.setCookie.join(' ')), 7 * 24 * 3600);
});

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

// 直接 require server/store 门面（不是起 HTTP），验证字段保真：
// 未登记的数组/嵌套对象、已知列里塞对象、数值列类型、中文字符串都要原样回来。
const HELPER_SRC = `
const path = require('path');
const store = require(path.join(process.argv[3], 'store'));
const mode = process.argv[2];
(async () => {
  await store.ready;
  const { data, save, flush } = store;
  if (mode === 'write') {
    data.users.push({
      id: 'fidelity1', username: 'fidelity_one', nickname: '保真用户', password: 'x:y', role: 'user',
      score: 7, createdAt: 1, lastLogin: null, cpPartnerId: null, cpSince: null, cpCode: '',
      tags: ['a', { deep: true }],
      metadata: { nested: { ok: 1 } },
    });
    data.messages.push({ id: 'mf1', fromId: 'fidelity1', toId: 'admin', type: 'chat', text: { weird: 'object' }, ts: 2, read: false });
    save();
    await flush();
    console.log('written');
  } else {
    const u = data.users.find((x) => x.id === 'fidelity1') || null;
    const m = data.messages.find((x) => x.id === 'mf1') || null;
    console.log(JSON.stringify({ user: u, msgText: m ? m.text : null }));
  }
  process.exit(0);
})();
`;

console.log('== 4. store 层字段保真（未登记字段 / 已知列放对象值）==');
const helper = path.join(tmp, 'store-fidelity.cjs');
fs.writeFileSync(helper, HELPER_SRC);
function runHelper(mode) {
  return spawnSync(process.execPath, [helper, mode, serverDir], {
    cwd: serverDir,
    encoding: 'utf8',
    env: childEnv(dataDir),
  });
}
const w = runHelper('write');
failures += check('store 写入保真数据成功', () => assert.ok(w.status === 0 && w.stdout.includes('written'), 'exit=' + w.status + ' out=' + w.stdout + ' err=' + w.stderr));
const r = runHelper('read');
const back = JSON.parse(r.stdout.trim().split('\n').pop());
failures += check('未登记的数组字段（tags）原样读回', () => assert.deepStrictEqual(back.user.tags, ['a', { deep: true }]));
failures += check('未登记的嵌套对象（metadata）原样读回', () => assert.deepStrictEqual(back.user.metadata, { nested: { ok: 1 } }));
failures += check('已知列（messages.text）放对象也不丢，走 extra 往返', () => assert.deepStrictEqual(back.msgText, { weird: 'object' }));
failures += check('数值列仍是数值、文本未被字符串化污染', () => { assert.strictEqual(back.user.score, 7); assert.strictEqual(back.user.username, 'fidelity_one'); });
failures += check('中文字段往返无损', () => assert.strictEqual(back.user.nickname, '保真用户'));

const { createRequire: createRequireForUnit } = await import('node:module');
const requireSchema = createRequireForUnit(path.join(serverDir, 'noop.js'));
const { fromStored, T: Tcol } = requireSchema('./store/schema');
failures += check('整数列被驱动返回成字符串时仍转回 number（防 score 变字符串拼接）', () => {
  assert.strictEqual(fromStored({ type: Tcol.INT }, '7'), 7);
  assert.strictEqual(fromStored({ type: Tcol.INT }, 7), 7);
  assert.strictEqual(fromStored({ type: Tcol.INT }, null), null);
  assert.strictEqual(fromStored({ bool: true }, 0), false);
  assert.strictEqual(fromStored({ bool: true }, 1), true);
});
console.log('== 5. 旧库结构自动升级（v1 缺 seq / extra 列 -> v3）==');
if (pgUrl) {
  console.log('  SKIP 这条只针对 SQLite 老库（Postgres 模式跳过）');
} else {
  const { createRequire } = await import('node:module');
  const requireFromServer = createRequire(path.join(serverDir, 'noop.js'));
  const SQLite = requireFromServer('better-sqlite3');
  const { COLLECTIONS } = requireFromServer('./store/schema');

  // 造一个 v1 形状的库：列齐全但没有 seq（这正是 6c23eae 那版 store 建出来的结构）
  const upgradeDir = path.join(tmp, 'upgrade-data');
  fs.mkdirSync(upgradeDir, { recursive: true });
  const v1File = path.join(upgradeDir, 'couple-game.sqlite');
  const v1 = new SQLite(v1File);
  v1.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const def of COLLECTIONS) {
    const cols = def.columns
      .filter((c) => c.name !== 'seq')
      .map((c) => '"' + c.name + '" ' + c.type + (c.pk ? ' PRIMARY KEY' : '') + (c.notNull ? ' NOT NULL' : '') + (c.unique ? ' UNIQUE' : ''));
    // 旧版 sessions 表连 extra 都没有，这里如实还原成 (token, user_id)
    if (def.key !== 'sessions') cols.push('"extra" TEXT');
    v1.exec('CREATE TABLE ' + def.table + ' (' + cols.join(', ') + ')');
    for (const idx of def.indexes || []) v1.exec('CREATE INDEX idx_' + def.table + '_' + idx + ' ON ' + def.table + ' (' + idx + ')');
  }
  v1.prepare('INSERT INTO users (id, username, nickname, password, role, score, createdAt, lastLogin, cpPartnerId, cpSince, cpCode)'
    + ' VALUES (@id,@username,@nickname,@password,@role,@score,@createdAt,@lastLogin,@cpPartnerId,@cpSince,@cpCode)')
    .run({ id: 'v1user', username: 'legacy_v1', nickname: '老库用户', password: hashPassword('v1pw1234'), role: 'user', score: 55, createdAt: 1, lastLogin: null, cpPartnerId: null, cpSince: null, cpCode: '' });
  v1.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run('tk-v1-1', 'v1user');
  v1.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  v1.close();

  startServer(upgradeDir);
  await waitReady();
  const health5 = await new Client().call('/api/health');
  failures += check('结构版本已升到 v3', () => assert.ok(health5.body.schemaVersion >= 3, JSON.stringify(health5.body)));
  const v1Client = new Client();
  const v1Login = await v1Client.post('/api/login', { username: 'legacy_v1', password: 'v1pw1234' });
  failures += check('老库账号仍可登录', () => assert.strictEqual(v1Login.status, 200));
  const oldToken = new Client();
  oldToken.cookie = 'sid=tk-v1-1';
  const byOldCookie = await oldToken.call('/api/me');
  failures += check('老库的 sessions.user_id 行迁移后仍然有效', () => {
    assert.strictEqual(byOldCookie.status, 200);
    assert.strictEqual(byOldCookie.body.id, 'v1user');
  });
  const adminClient = new Client();
  const seeded = await adminClient.post('/api/login', { username: 'admin', password: '888888' });
  failures += check('ready 之后才种入管理员（不会读到空 data）', () => assert.strictEqual(seeded.status, 200));
  const adminList = await adminClient.call('/api/admin/users');
  failures += check('管理员能看到老库用户 + 新建管理员', () => assert.strictEqual(adminList.body.length, 2, JSON.stringify({ status: adminList.status, body: adminList.body })));
  const settled5 = await settle(v1Client, adminClient, 'reversi', '黑白棋', 'draw', 'draw');
  failures += check('升级后的库仍可正常写入（双方平局各 +2）', () => {
    assert.strictEqual(settled5.hostView.status, 'settled', JSON.stringify(settled5));
    assert.strictEqual(settled5.hostView.score, 57);
  });
  const storage5 = await adminClient.call('/api/admin/storage');
  failures += check('升级后写库无残留错误（旧 sessions 表缺的 extra 已补齐）', () => assert.strictEqual(storage5.body.lastError, null, JSON.stringify(storage5.body)));
  await stopServer();
}
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==\n服务日志:\n` + logs.join('\n'));
process.exit(failures === 0 ? 0 : 1);