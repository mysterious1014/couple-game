// 房间进房收紧回归（免浏览器）：真起一个隔离端口 + 临时 DATA_DIR 的服务端，
// 验证 /join 的新判据（房主自 join、房间已满、本人重进）与 /seat、/heartbeat、/leave 的座位存活联动。
// 用法：node tools/test-room-join.mjs [端口]
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || 4320);
const BASE = `http://127.0.0.1:${PORT}`;
const TTL = 2000;                       // 座位存活窗口收紧到 2s，过期分支不用真等 45s
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-join-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let child = null;
const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child = spawn(process.execPath, ['index.js'], {
  cwd: path.join(repoRoot, 'server'),
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, GUEST_SEAT_TTL_MS: String(TTL) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (b) => logs.push(String(b).trim()));
child.stderr.on('data', (b) => logs.push('STDERR ' + String(b).trim()));

async function stopServer() {
  await sleep(300);                     // 等异步写队列落库
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill();
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('服务未启动：' + logs.slice(-5).join(' | '));
}

class Client {
  constructor(tag) { this.tag = tag; this.cookie = ''; this.code = ''; this.secret = ''; }
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
    return this.call(pathname, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
  }
  async register(username) {
    const r = await this.post('/api/register', { username, password: 'pw-123456', nickname: username });
    assert.strictEqual(r.status, 200, '注册失败 ' + JSON.stringify(r.body));
    await sleep(25);                    // 用户 id 取自 Date.now()，同毫秒会撞
  }
  createRoom(peerId) { return this.post('/api/rooms', { peerId, hostName: this.tag }); }
  join(code) { return this.post(`/api/rooms/${code}/join`, { password: '', name: this.tag }); }
  seat(code, role, peerId, secret) { return this.post(`/api/rooms/${code}/seat`, { role, peerId, secret }); }
  heartbeat(code, payload) { return this.post(`/api/rooms/${code}/heartbeat`, payload); }
  leave(code, secret) { return this.post(`/api/rooms/${code}/leave`, { secret }); }
  peers(code, role, secret) { return this.call(`/api/rooms/${code}/peers?role=${role}&secret=${encodeURIComponent(secret)}`); }
  async roomItem() {
    const r = await this.call('/api/rooms');
    return (r.body || []).find((x) => x.code === this.code) || null;
  }
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  OK   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

await waitForServer();

// ---------- 登录态房间：房主 / 访客 / 第三人 ----------
const host = new Client('房主甲');
const guest = new Client('访客乙');
const third = new Client('第三人丙');
await host.register('join_host');
await guest.register('join_guest');
await third.register('join_third');

const created = await host.createRoom('peer-host-1');
assert.strictEqual(created.status, 200, '建房失败 ' + JSON.stringify(created.body));
const code = created.body.code;
const hostSecret = created.body.secret;
[host, guest, third].forEach((c) => { c.code = code; });
console.log('\n房间 ' + code + '（座位 TTL ' + TTL + 'ms）');

await check('房主不能加入自己的房间（400，不再把自己写成访客）', async () => {
  const r = await host.join(code);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /你自己的房间/);
  const item = await host.roomItem();
  assert.strictEqual(item.players, 1, '被挡下后人数不该变');
});

await check('房间空着时访客能进，房间变成 2 人', async () => {
  const r = await guest.join(code);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.secret, '缺少座位凭据');
  assert.strictEqual(r.body.peerId, 'peer-host-1', '应当拿到真房主的 PeerID');
  guest.secret = r.body.secret;
  const item = await guest.roomItem();
  assert.strictEqual(item.players, 2);
});

await check('第三人被挡住（409，座位上还有活人）', async () => {
  const r = await third.join(code);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /房间已满/);
});

await check('访客本人重进放行（刷新/重连），并换发新座位凭据', async () => {
  const prev = guest.secret;
  const again = await guest.join(code);
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.notStrictEqual(prev, again.body.secret, '重进应当换发凭据');
  guest.secret = again.body.secret;
  guest.prevSecret = prev;
});

await check('旧座位凭据立即失效（轮换过就不认）', async () => {
  const r = await guest.peers(code, 'guest', guest.prevSecret);
  assert.strictEqual(r.status, 403, JSON.stringify(r.body));
});

await check('/seat 认座位凭据：用别人的凭据登记 403', async () => {
  const r = await third.seat(code, 'guest', 'peer-evil', hostSecret);
  assert.strictEqual(r.status, 403, JSON.stringify(r.body));
  const p = await host.peers(code, 'host', hostSecret);
  assert.notStrictEqual(p.body.guestPeerId, 'peer-evil');
});

await check('/seat 登记后 /peers 能看到 guestPeerId（房主重连靠它反向拨号）', async () => {
  const r = await guest.seat(code, 'guest', 'peer-guest-1', guest.secret);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.guestPeerId, 'peer-guest-1');
  const p = await host.peers(code, 'host', hostSecret);
  assert.strictEqual(p.body.guestPeerId, 'peer-guest-1');
});

await check('心跳带 role+secret 能续座位（跨过 TTL 也不被人接手）', async () => {
  await sleep(TTL * 0.6);
  const hb = await guest.heartbeat(code, { role: 'guest', secret: guest.secret });
  assert.strictEqual(hb.status, 200, JSON.stringify(hb.body));
  await sleep(TTL * 0.9);               // 距上次 /seat 已超过 TTL，但中间心跳续过
  const r = await third.join(code);
  assert.strictEqual(r.status, 409, '续了座还被接手 ' + JSON.stringify(r.body));
});

await check('旧前端裸 POST 心跳仍然接受（兼容性）', async () => {
  await guest.seat(code, 'guest', 'peer-guest-1', guest.secret);   // 重置座位时钟，避免和下一条的过期判断抢时间
  const res = await fetch(BASE + `/api/rooms/${code}/heartbeat`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const r = await third.join(code);
  assert.strictEqual(r.status, 409, '座位刚续过，第三人应当还是被挡住');
});

await check('访客掉线超过 TTL 后座位自动释放', async () => {
  await sleep(TTL * 1.6);                                          // 之后不再有任何心跳，座位应当自己释放
  const r = await third.join(code);
  assert.strictEqual(r.status, 200, '座位没释放 ' + JSON.stringify(r.body));
  third.secret = r.body.secret;
});

await check('/leave 认座位凭据：错的 403', async () => {
  const r = await guest.leave(code, 'not-my-secret');
  assert.strictEqual(r.status, 403, JSON.stringify(r.body));
});

await check('/leave 只清访客座位，房间保留、人数回到 1', async () => {
  const r = await third.leave(code, third.secret);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const peek = await guest.call(`/api/rooms/${code}`);
  assert.strictEqual(peek.status, 200, '房被误删了');
  const item = await third.roomItem();
  assert.ok(item, '房间应当仍在公开列表');
  assert.strictEqual(item.players, 1);
  assert.strictEqual(item.status, 'waiting');
});

await check('/leave 之后新人立刻能进（不用干等 TTL）', async () => {
  const r = await guest.join(code);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  guest.secret = r.body.secret;
});

await check('离座者拿旧凭据补心跳不会重新占座', async () => {
  const left = await guest.leave(code, guest.secret);
  assert.strictEqual(left.status, 200);
  const hb = await guest.heartbeat(code, { role: 'guest', secret: guest.secret });
  assert.strictEqual(hb.status, 200, '心跳本身不该报错');
  const item = await guest.roomItem();
  assert.strictEqual(item.players, 1, '旧凭据把座位又占上了');
});

// ---------- 游客房（全程不登录） ----------
const anonHost = new Client('游客房主');
const anonGuest = new Client('游客访客');
const anonThird = new Client('游客第三人');
const anonRoom = await anonHost.createRoom('peer-anon-host');
assert.strictEqual(anonRoom.status, 200, JSON.stringify(anonRoom.body));
const acode = anonRoom.body.code;
[anonHost, anonGuest, anonThird].forEach((c) => { c.code = acode; });

await check('游客房：第一个访客能进', async () => {
  const r = await anonGuest.join(acode);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  anonGuest.secret = r.body.secret;
});

await check('游客房：没登录的第三人同样被 409 挡住', async () => {
  const r = await anonThird.join(acode);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
});

await check('游客房主的心跳续的是自己那个座位', async () => {
  const hb = await anonHost.heartbeat(acode, { role: 'host', secret: anonRoom.body.secret });
  assert.strictEqual(hb.status, 200, JSON.stringify(hb.body));
});

await stopServer();

console.log('\n' + (failures ? `失败 ${failures} 项` : `全部通过`));
if (failures) {
  console.log('--- 服务端日志尾部 ---');
  console.log(logs.slice(-12).join('\n'));
  process.exit(1);
}
fs.rmSync(tmp, { recursive: true, force: true });