// Net 同步层的行为测试（Roadmap ②）：在 Node 里用假的 PeerJS + 假后端跑真实的 js/net.js。
// 覆盖：消息日志、断线重连（换 PeerID + 座位登记）、重连后按日志回放恢复棋局、房间没了就放弃。
// 用法：node tools/test-net-reconnect.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
// 前端是原生 ESM 且仓库根没有 package.json：复制到临时目录补上 type:module 再 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-net-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
fs.cpSync(path.join(repoRoot, 'js', 'net.js'), path.join(tmp, 'net.js'));

// ---------- 假后端：只实现房间 / 座位，够 Net 用 ----------
const backend = {
  rooms: {},
  seq: 0,
  create(hostPeerId) {
    const code = String(++this.seq).padStart(4, '0');
    this.rooms[code] = { code, hostPeerId, guestPeerId: '', hostSecret: 'SH' + code, guestSecret: '' };
    return this.rooms[code];
  },
};

async function fakeFetch(url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (obj, status = 200) => ({ status, ok: status < 400, json: async () => obj });
  if (u === '/api/rooms' && opts.method === 'POST') {
    const room = backend.create(body.peerId);
    return json({ code: room.code, secret: room.hostSecret, room: {} });
  }
  const m = u.match(/^\/api\/rooms\/([0-9]{4})(\/join|\/seat|\/peers)?/);
  if (!m) throw new Error('fakeFetch 未覆盖: ' + u);
  const room = backend.rooms[m[1]];
  if (!room) return json({ error: '房间不存在' }, 404);
  const act = m[2] ? m[2].slice(1) : '';
  if (act === 'join') {
    room.guestSecret = 'SG' + m[1];
    return json({ code: room.code, peerId: room.hostPeerId, secret: room.guestSecret, hostName: '房主', gameId: '', gameName: '' });
  }
  if (act === 'seat') {
    if (body.secret !== (body.role === 'host' ? room.hostSecret : room.guestSecret)) return json({ error: '座位凭据不正确' }, 403);
    if (body.role === 'host') { room.hostPeerId = body.peerId; } else { room.guestPeerId = body.peerId; }
    return json({ ok: true, hostPeerId: room.hostPeerId, guestPeerId: room.guestPeerId });
  }
  if (act === 'peers') {
    const q = new URLSearchParams(u.split('?')[1] || '');
    if (q.get('secret') !== (q.get('role') === 'host' ? room.hostSecret : room.guestSecret)) return json({ error: '座位凭据不正确' }, 403);
    return json({ hostPeerId: room.hostPeerId, guestPeerId: room.guestPeerId, status: 'playing', gameId: 'gomoku' });
  }
  throw new Error('fakeFetch 未覆盖: ' + u);
}

// ---------- 假 PeerJS ----------
const peers = new Map();
let peerSeq = 0;

class FakeConn {
  constructor(owner) { this.owner = owner; this.peer = null; this.open = false; this.h = {}; this._closed = false; }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); }
  once(ev, cb) { const w = (...a) => { this.off(ev, w); cb(...a); }; this.on(ev, w); }
  off(ev, cb) { this.h[ev] = (this.h[ev] || []).filter((f) => f !== cb); }
  fire(ev, ...a) { (this.h[ev] || []).slice().forEach((f) => f(...a)); }
  send(msg) {
    if (!this.open || !this.peer) return;
    const target = this.peer;
    setTimeout(() => { if (target.open && !target._closed) target.fire('data', JSON.parse(JSON.stringify(msg))); }, 0);
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this.open = false;
    this.fire('close');
    const other = this.peer;
    if (other && !other._closed) { other._closed = true; other.open = false; other.fire('close'); }
  }
}

class FakePeer {
  constructor() {
    this.id = 'peer' + (++peerSeq);
    this.h = {};
    this.destroyed = false;
    this.disconnected = false;
    setTimeout(() => { if (!this.destroyed) { peers.set(this.id, this); this.fire('open', this.id); } }, 0);
  }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); }
  fire(ev, ...a) { (this.h[ev] || []).slice().forEach((f) => f(...a)); }
  connect(targetId) {
    const a = new FakeConn(this);
    const target = peers.get(targetId);
    if (!target) { setTimeout(() => this.fire('error', { type: 'peer-unavailable' }), 0); return a; }
    const b = new FakeConn(target);
    a.peer = b;
    b.peer = a;
    setTimeout(() => {
      (target.h.connection || []).slice().forEach((f) => f(b));
      a.open = true;
      b.open = true;
      a.fire('open');
      b.fire('open');
    }, 0);
    return a;
  }
  destroy() { this.destroyed = true; peers.delete(this.id); }
  reconnect() { this.disconnected = false; }
}

globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: '4321' };
globalThis.Peer = FakePeer;
globalThis.fetch = fakeFetch;

const { Net } = await import(pathToFileURL(path.join(tmp, 'net.js')).href);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  OK   ' + name); return 0; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); return 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 假棋局：只记录「应用过的消息」，用来验证回放后两边状态一致
function attachGame(net, sink, keepJournal = false) {
  if (!keepJournal) net.resetJournal();     // 真实上层：新开一局才清日志，回放重建时不清
  sink.applied = [];
  sink.off && sink.off();
  sink.off = net.on('mv', (m) => sink.applied.push(m.n));
}

const hostEvents = [];
const guestEvents = [];

console.log('== 1. 建房 / 加入 / 日志一致 ==');
const host = new Net();
const code = await host.host('房主', 'hh');
host.onStatus((t, p) => hostEvents.push([t, p]));
const guest = new Net();
await guest.join(code, '加入者', '', 'gg');
guest.onStatus((t, p) => guestEvents.push([t, p]));
failures += check('双方都连上了，房主是 1 号、加入者是 2 号', () => {
  assert.strictEqual(host.ready, true);
  assert.strictEqual(guest.ready, true);
  assert.strictEqual(host.me, 1);
  assert.strictEqual(guest.me, 2);
});
failures += check('房间号与座位凭据都拿到了', () => {
  assert.match(code, /^[0-9]{4}$/);
  assert.ok(host.roomSecret && guest.roomSecret);
});
await sleep(30);
const hSink = {};
const gSink = {};
attachGame(host, hSink);
attachGame(guest, gSink);
for (const [from, n] of [[host, 1], [guest, 2], [host, 3], [guest, 4], [host, 5]]) {
  from.send('mv', { n });
  await sleep(20);
}
failures += check('两边日志顺序一致', () => {
  assert.deepStrictEqual(host.journal.map((e) => e.data.n), guest.journal.map((e) => e.data.n));
  assert.strictEqual(host.journal.length, 5);
});
failures += check('控制消息不进日志（hello/chat 等，两侧都要查）', () => {
  // 两侧都查：hello 是「连接建立时 send() 出去」的，只查房主一侧会漏掉加入者那半边的污染。
  for (const [who, net] of [['host', host], ['guest', guest]]) {
    assert.deepEqual(net.journal.map((e) => e.type), ['mv', 'mv', 'mv', 'mv', 'mv'].slice(0, net.journal.length),
      who + ' 日志里混进了非对局消息：' + JSON.stringify(net.journal.map((e) => e.type)));
    assert.ok(net.journal.every((e) => e.type === 'mv'), who + ' 日志含握手/控制消息');
  }
});
failures += check('各自只收到对方发出的那几条', () => {
  assert.deepStrictEqual(gSink.applied, [1, 3, 5]);
  assert.deepStrictEqual(hSink.applied, [2, 4]);
});

console.log('== 2. 断线重连 + 按日志回放 ==');
// 制造不对称：加入者发出第 6 步，紧接着链路就断 -> 这一步只有它自己记进日志了
guest.send('mv', { n: 6 });
guest.conn.close();
failures += check('断开瞬间两边日志不等长', () => {
  assert.strictEqual(guest.journal.length, 6);
  assert.strictEqual(host.journal.length, 5);
});
const rebuilds = [];
host.onRebuild = (entries) => { rebuilds.push(entries.length); attachGame(host, hSink, true); };
guest.onRebuild = (entries) => { rebuilds.push(entries.length); attachGame(guest, gSink, true); };

// 等自动重连收敛（退避节奏见 RECOVER_DELAYS）
for (let i = 0; i < 80 && !(host.ready && guest.ready); i++) await sleep(250);
failures += check('重连后双方都恢复 ready', () => {
  assert.ok(host.ready, 'host ready=false');
  assert.ok(guest.ready, 'guest ready=false');
});
failures += check('重连过程上报过 reconnecting', () => {
  assert.ok(hostEvents.some((e) => e[0] === 'reconnecting') || guestEvents.some((e) => e[0] === 'reconnecting'),
    JSON.stringify({ hostEvents: hostEvents.map((e) => e[0]), guestEvents: guestEvents.map((e) => e[0]) }));
});
failures += check('日志少的一方按对方日志重建（5 -> 6）', () => {
  assert.strictEqual(host.journal.length, 6, 'host.journal=' + host.journal.length);
  assert.strictEqual(guest.journal.length, 6);
  assert.ok(rebuilds.length >= 1, '没人触发重建');
});
failures += check('重建后棋局与断线前完全一致', () => {
  assert.deepStrictEqual(hSink.applied, [1, 2, 3, 4, 5, 6]);
});
await sleep(80);
host.send('mv', { n: 7 });
await sleep(60);
failures += check('重连后链路能继续正常收发', () => {
  assert.ok(gSink.applied.includes(7), JSON.stringify(gSink.applied));
  assert.strictEqual(host.journal.length, guest.journal.length);
});

console.log('== 3. 房间已关就不再空等 ==');
const orphan = new Net();
const orphanCode = await orphan.host('房主2', 'x');
const pal = new Net();
await pal.join(orphanCode, '对手', '');
await sleep(30);
const orphanEvents = [];
orphan.onStatus((t, p) => orphanEvents.push([t, p]));
delete backend.rooms[orphanCode];        // 服务端把房间回收了（心跳超时的效果）
pal.conn.close();
for (let i = 0; i < 200 && !orphanEvents.some((e) => e[0] === 'closed'); i++) await sleep(100);
pal.cancelReconnect();
failures += check('发现房间已关 -> 报 closed/room-gone 并停手', () => {
  const closed = orphanEvents.find((e) => e[0] === 'closed');
  assert.ok(closed, JSON.stringify(orphanEvents.map((e) => e[0])));
  assert.strictEqual(closed[1].reason, 'room-gone');
  assert.strictEqual(orphan.reconnecting, false);
  assert.strictEqual(orphan.ready, false);
});

console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==`);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(failures === 0 ? 0 : 1);