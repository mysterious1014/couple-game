// P2P 权威结算 + 房间座位凭据的端到端测试（Roadmap ②③）。
// 起一个隔离端口 / 隔离 DATA_DIR 的真服务，走 HTTP 断言：
//   - 单方面的知识性上报不加分，必须双方互相印证才结算；
//   - 声明冲突 / 非房间成员 / 游客房 / 刷新频率都不得分；
//   - 改房、登记新 PeerID（重连用）、关房都要座位凭据。
// 用法：node tools/test-match-settlement.mjs [端口]
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const PORT = Number(process.argv[2] || 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-match-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const logs = [];
let child = null;

function startServer() {
  child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, MATCH_PENDING_TTL_MS: '1500' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => logs.push(String(b).trim()));
  child.stderr.on('data', (b) => logs.push('STDERR ' + String(b).trim()));
}

async function stopServer() {
  await new Promise((r) => setTimeout(r, 300));
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
  constructor(tag) { this.cookie = ''; this.tag = tag || ''; }
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
    return this.call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
  }
  patch(pathname, payload) {
    return this.call(pathname, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
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

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  OK   ' + name); return 0; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); return 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeRoom(host, guest, rnd) {
  const created = await host.post('/api/rooms', { peerId: 'peer-h-' + rnd, hostName: '房主' });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const code = created.body.code;
  const joined = await guest.post(`/api/rooms/${code}/join`, { password: '' });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
  return { code, hostSecret: created.body.secret, guestSecret: joined.body.secret };
}

startServer();
await waitReady();

console.log('== 1. 房间座位凭据 ==');
const A = new Client('A');
const B = new Client('B');
const OUT = new Client('OUT');
const regA = await A.post('/api/register', { username: 'match_a', password: 'pw123456', nickname: '阿 A' });
const regB = await B.post('/api/register', { username: 'match_b', password: 'pw123456', nickname: '阿 B' });
const regOut = await OUT.post('/api/register', { username: 'match_out', password: 'pw123456', nickname: '路人' });
failures += check('三个账号注册成功', () => {
  assert.strictEqual(regA.status, 200); assert.strictEqual(regB.status, 200); assert.strictEqual(regOut.status, 200);
});
const room1 = await makeRoom(A, B, 'aaa1');
failures += check('建房/加入各拿到一份座位凭据', () => {
  assert.ok(/^[0-9a-f]{24}$/.test(room1.hostSecret), room1.hostSecret);
  assert.ok(/^[0-9a-f]{24}$/.test(room1.guestSecret), room1.guestSecret);
});
const patchNoSecret = await A.patch(`/api/rooms/${room1.code}`, { status: 'playing' });
failures += check('不带凭据不能改房间（旧版任何人可改）', () => assert.strictEqual(patchNoSecret.status, 403));
const patchBadSecret = await OUT.patch(`/api/rooms/${room1.code}`, { status: 'playing', secret: 'deadbeef' });
failures += check('带错凭据同样被拒', () => assert.strictEqual(patchBadSecret.status, 403));
const patchOk = await A.patch(`/api/rooms/${room1.code}`, { status: 'playing', secret: room1.hostSecret });
failures += check('房主凭据可以改房间', () => assert.strictEqual(patchOk.status, 200));
const peersNoSecret = await A.call(`/api/rooms/${room1.code}/peers`);
failures += check('取 peerId 也要凭据', () => assert.strictEqual(peersNoSecret.status, 403));
const seatBad = await A.post(`/api/rooms/${room1.code}/seat`, { role: 'host', peerId: 'peer-new-1', secret: 'nope' });
failures += check('乱登别人座位被拒', () => assert.strictEqual(seatBad.status, 403));
const seatOk = await A.post(`/api/rooms/${room1.code}/seat`, { role: 'host', peerId: 'peer-new-1', secret: room1.hostSecret });
failures += check('重连登记新 PeerID 成功', () => assert.strictEqual(seatOk.body.hostPeerId, 'peer-new-1'));
const peersOk = await B.call(`/api/rooms/${room1.code}/peers?role=guest&secret=${room1.guestSecret}`);
failures += check('加入者能看到房主的新 PeerID', () => assert.strictEqual(peersOk.body.hostPeerId, 'peer-new-1'));
const deleteByStranger = await OUT.call(`/api/rooms/${room1.code}`, { method: 'DELETE' });
failures += check('路人关不掉别人的房间', () => assert.strictEqual(deleteByStranger.status, 403));

console.log('== 2. 结算必须双方互相印证 ==');
const solo = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'win', roundHint: 1 });
failures += check('只有一方上报 -> pending，不改分', () => {
  assert.strictEqual(solo.body.status, 'pending', JSON.stringify(solo.body));
  assert.strictEqual(solo.body.score, null);
});
const soloAgain = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'win', roundHint: 1 });
failures += check('同一方重复上报幂等（不新建对局）', () => {
  assert.strictEqual(soloAgain.body.id, solo.body.id);
  assert.strictEqual(soloAgain.body.status, 'pending');
});
const strangerReport = await OUT.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', result: 'lose', roundHint: 1 });
failures += check('不是这个房间的人 -> 403', () => assert.strictEqual(strangerReport.status, 403));
const badResult = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', result: 'champ', roundHint: 1 });
failures += check('结果取值受白名单约束', () => assert.strictEqual(badResult.status, 400));
const confirmed = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'lose', roundHint: 1 });
failures += check('对方确认「我输了」-> 结算生效，负方 -15', () => {
  assert.strictEqual(confirmed.body.status, 'settled', JSON.stringify(confirmed.body));
  assert.strictEqual(confirmed.body.delta, -15);
  assert.strictEqual(confirmed.body.score, 985);
});
const hostView = await A.call('/api/match/' + solo.body.id);
failures += check('先上报的一方轮询到自己的结算（+20）', () => {
  assert.strictEqual(hostView.body.status, 'settled');
  assert.strictEqual(hostView.body.delta, 20);
  assert.strictEqual(hostView.body.score, 1020);
});
const meA = await A.call('/api/me');
const recsA = await A.call('/api/me/records');
failures += check('战绩由服务端写，对手名取自库内资料（不采信客户端传的 opponent）', () => {
  assert.strictEqual(meA.body.score, 1020);
  assert.strictEqual(recsA.body.length, 1);
  assert.strictEqual(recsA.body[0].opponent, '阿 B');
  assert.strictEqual(recsA.body[0].mode, 'p2p');
  assert.strictEqual(recsA.body[0].delta, 20);
});
const recsB = await B.call('/api/me/records');
failures += check('负方也各有一条战绩', () => {
  assert.strictEqual(recsB.body.length, 1);
  assert.strictEqual(recsB.body[0].result, 'lose');
});

console.log('== 3. 冲突 / 频控 / 超时 ==');
const scoreBefore = (await A.call('/api/me')).body.score;
const clashA = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'win', roundHint: 2 });
const clashB = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'win', roundHint: 2 });
failures += check('双方都自称赢 -> conflict，谁都不扣分', () => {
  assert.strictEqual(clashB.body.status, 'conflict', JSON.stringify(clashB.body));
});
const scoreAfterClash = (await A.call('/api/me')).body.score;
failures += check('冲突不改分', () => assert.strictEqual(scoreAfterClash, scoreBefore));
const drawA = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'memory', gameName: '记忆翻牌', result: 'draw', roundHint: 3 });
const drawB = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'memory', gameName: '记忆翻牌', result: 'draw', roundHint: 3 });
failures += check('双方都报平局 -> 各 +2（但受频控约束）', () => {
  assert.ok(['settled', 'throttled'].includes(drawB.body.status), JSON.stringify(drawB.body));
});
const fastA = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'reversi', gameName: '黑白棋', result: 'win', roundHint: 4 });
const fastB = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'reversi', gameName: '黑白棋', result: 'lose', roundHint: 4 });
failures += check('8 秒内连续结算被频控（本局不计分）', () => {
  assert.strictEqual(fastB.body.status, 'throttled', JSON.stringify(fastB.body));
});
const aheadA = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'win', roundHint: 7 });
const aheadB = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'gomoku', gameName: '五子棋', result: 'lose', roundHint: 9 });
const staleView = await A.call('/api/match/' + aheadA.body.id);
failures += check('一方已经开下一局时，旧局标记 superseded 而不是误结算', () => {
  assert.strictEqual(aheadB.body.status, 'pending', JSON.stringify(aheadB.body));
  assert.strictEqual(staleView.body.status, 'superseded', JSON.stringify(staleView.body));
});
const ttlA = await A.post('/api/match/report', { roomCode: room1.code, gameId: 'dots', gameName: '点格棋', result: 'win', roundHint: 11 });
await sleep(2200);
const ttlView = await A.call('/api/match/' + ttlA.body.id);
failures += check('等不到对方确认 -> expired（测试里 TTL=1.5s）', () => assert.strictEqual(ttlView.body.status, 'expired', JSON.stringify(ttlView.body)));
const ttlB = await B.post('/api/match/report', { roomCode: room1.code, gameId: 'dots', gameName: '点格棋', result: 'lose', roundHint: 11 });
failures += check('过期后对方再报，只开新局不改分', () => assert.strictEqual(ttlB.body.status, 'pending'));

console.log('== 4. 游客房不计分 ==');
const C = new Client('C');
const regC = await C.post('/api/register', { username: 'match_c', password: 'pw123456', nickname: '阿 C' });
const anon = new Client('anon');
const room2 = await makeRoom(C, anon, 'ccc1');
const guestFree = await C.post('/api/match/report', { roomCode: room2.code, gameId: 'gomoku', result: 'win', roundHint: 1 });
failures += check('对方是游客（无账号）-> unsupported，不掉分', () => {
  assert.strictEqual(regC.status, 200);
  assert.strictEqual(guestFree.body.status, 'unsupported', JSON.stringify(guestFree.body));
});

console.log('== 5. 旧接口下线 ==');
const oldPlay = await A.post('/api/play', { gameId: 'gomoku', result: 'win' });
failures += check('POST /api/play 返回 404', () => assert.strictEqual(oldPlay.status, 404));
const badMatch = await A.call('/api/match/m-does-not-exist');
failures += check('查不存在的对局 -> 404', () => assert.strictEqual(badMatch.status, 404));
const spyMatch = await OUT.call('/api/match/' + solo.body.id);
failures += check('外人不能偷看别人的对局结算', () => assert.strictEqual(spyMatch.status, 403));

await stopServer();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==\n服务日志:\n` + logs.slice(-25).join('\n'));
process.exit(failures === 0 ? 0 : 1);