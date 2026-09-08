// 双人游戏站点后端
// - 静态托管整个前端（与 API 同源，免 CORS）
// - 账号注册 / 登录 / 登出（scrypt 哈希 + httpOnly Cookie 会话）
// - 账号注册 / 登录 / 登出、房间与座位、P2P 重连所需的 peerId 交换
// - 对局权威结算（双方互相印证才计分）与战绩查询
// - 管理员后台（默认账号 admin / 888888）
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const { data, save, ready, stats } = require('./store');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// 存储层初始化可能是异步的（Postgres 走网络），所有请求先等它 ready
app.use((req, res, next) => { ready.then(() => next(), next); });

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..'); // couple-game 前端根目录

// ---------- 密码与会话工具 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPassword(pw, stored) {
  const [salt, h] = (stored || '').split(':');
  if (!salt || !h) return false;
  const hh = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hh, 'hex'));
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
function cookieVal(req, name) {
  const c = req.headers.cookie;
  if (!c) return null;
  const m = c.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function currentUser(req) {
  const token = cookieVal(req, 'sid');
  if (!token) return null;
  const uid = data.sessions[token];
  if (!uid) return null;
  return data.users.find((u) => u.id === uid) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '未登录' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
const SESSION_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 };

// ---------- 健康检查与存储状态 ----------
// /api/health 公开（Render 健康检查、部署后确认用的是哪个存储），不含任何业务数据
app.get('/api/health', (req, res) => {
  const s = stats();
  res.json({ ok: true, driver: s.driver, schemaVersion: s.schemaVersion });
});
// /api/admin/storage 只有管理员能看，用来确认线上真的连上了外部数据库
app.get('/api/admin/storage', requireAuth, requireAdmin, (req, res) => {
  res.json(stats());
});
// ---------- 路由：账号 ----------
app.post('/api/register', (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: '用户名需 3-20 位字母/数字/下划线' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (data.users.find((u) => u.username === username)) return res.status(400).json({ error: '用户名已存在' });

  const id = 'u' + Date.now().toString(36);
  data.users.push({
    id, username, nickname: nickname || username,
    password: hashPassword(password), role: 'user',
    score: 1000, createdAt: Date.now(), lastLogin: null,
  });
  const token = newToken();
  data.sessions[token] = id;
  save();
  res.cookie('sid', token, SESSION_OPTS).json({ id, username, nickname: nickname || username, role: 'user', score: 1000 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = data.users.find((x) => x.username === username);
  if (!u || !verifyPassword(password || '', u.password)) return res.status(401).json({ error: '用户名或密码错误' });
  const token = newToken();
  data.sessions[token] = u.id;
  u.lastLogin = Date.now();
  save();
  res.cookie('sid', token, SESSION_OPTS).json({ id: u.id, username: u.username, nickname: u.nickname, role: u.role });
});

app.post('/api/logout', (req, res) => {
  const token = cookieVal(req, 'sid');
  if (token) {
    const uid = data.sessions[token];
    if (uid) onlineUsers.delete(uid);
    delete data.sessions[token];
  }
  save();
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '未登录' });
  let cpPartner = null;
  if (u.cpPartnerId) {
    const p = data.users.find((x) => x.id === u.cpPartnerId);
    if (p) cpPartner = { id: p.id, nickname: p.nickname, username: p.username, score: p.score || 0 };
  }
  res.json({
    id: u.id, username: u.username, nickname: u.nickname, role: u.role, score: u.score || 0,
    cpPartnerId: u.cpPartnerId || null,
    cpSince: u.cpSince || null,
    cpWaiting: !u.cpPartnerId && !!u.cpCode,
    cpPartner,
  });
});

// ---------- 路由：游玩记录 ----------
// 记分不再由客户端单方面上报：旧的 POST /api/play 已删除，P2P 结算见下方 /api/match/report，
// 人机模式沿用「不计分」的既有约定。
app.get('/api/me/records', requireAuth, (req, res) => {
  const recs = data.records.filter((r) => r.userId === req.user.id).sort((a, b) => b.ts - a.ts);
  res.json(recs);
});

// ---------- 路由：好友与在线状态 ----------
const ONLINE_TTL = 90 * 1000;        // 90 秒内无心跳视为离线
const onlineUsers = new Map();       // uid -> { lastSeen, roomCode }

function findRel(a, b) {
  return data.friendships.find((f) =>
    (f.userA === a && f.userB === b) || (f.userA === b && f.userB === a));
}
function findBlock(blockerId, blockedId) {
  return data.blocks.find((b) => b.blockerId === blockerId && b.blockedId === blockedId);
}
function publicProfile(uid) {
  const u = data.users.find((x) => x.id === uid);
  if (!u) return null;
  const p = onlineUsers.get(uid);
  const online = !!(p && Date.now() - p.lastSeen < ONLINE_TTL);
  return {
    id: u.id, username: u.username, nickname: u.nickname,
    score: u.score || 0, role: u.role,
    online, roomCode: online ? (p.roomCode || null) : null,
  };
}

// 在线状态心跳（登录后由前端定时上报；退出/离线时带 offline:true）
app.post('/api/presence', requireAuth, (req, res) => {
  const { roomCode, offline } = req.body || {};
  if (offline) { onlineUsers.delete(req.user.id); return res.json({ ok: true }); }
  onlineUsers.set(req.user.id, { lastSeen: Date.now(), roomCode: roomCode || null });
  res.json({ ok: true });
});

// 好友列表 / 收到的请求 / 发出的请求
app.get('/api/friends', requireAuth, (req, res) => {
  const me = req.user.id;
  const friends = [], incoming = [], outgoing = [];
  for (const f of data.friendships) {
    if (f.status === 'accepted') {
      const other = f.userA === me ? f.userB : f.userA;
      const prof = publicProfile(other);
      if (prof) {
        prof.note = f.note || '';
        prof.group = f.group || '';
        friends.push(prof);
      }
    } else if (f.status === 'pending') {
      if (f.requester !== me) {
        const prof = publicProfile(f.requester);
        if (prof) incoming.push(prof);
      } else {
        const other = f.userA === me ? f.userB : f.userA;
        const prof = publicProfile(other);
        if (prof) outgoing.push(prof);
      }
    }
  }
  friends.sort((a, b) => (Number(b.online) - Number(a.online)) || (a.nickname || '').localeCompare(b.nickname || '', 'zh'));
  const blocks = data.blocks
    .filter((b) => b.blockerId === me)
    .map((b) => publicProfile(b.blockedId))
    .filter(Boolean);
  res.json({ friends, incoming, outgoing, blocks, pendingCount: incoming.length });
});

// 发送好友请求（按用户名）
app.post('/api/friends/request', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  const target = data.users.find((u) => u.username === username);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });
  if (findBlock(target.id, req.user.id)) return res.status(403).json({ error: '对方已屏蔽你，无法发送请求' });
  const rel = findRel(req.user.id, target.id);
  if (rel) {
    if (rel.status === 'accepted') return res.status(400).json({ error: '你们已经是好友了' });
    if (rel.requester === req.user.id) return res.status(400).json({ error: '好友请求已发送，等待对方通过' });
    return res.status(400).json({ error: '对方已向你发送好友请求，请到「好友请求」中通过' });
  }
  data.friendships.push({
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    userA: req.user.id, userB: target.id, status: 'pending', requester: req.user.id, createdAt: Date.now(),
  });
  save();
  res.json({ ok: true });
});

// 接受好友请求
app.post('/api/friends/accept', requireAuth, (req, res) => {
  const { userId } = req.body || {};
  const rel = findRel(req.user.id, userId);
  if (!rel || rel.status !== 'pending' || rel.requester === req.user.id)
    return res.status(400).json({ error: '没有待通过的好友请求' });
  rel.status = 'accepted';
  save();
  res.json({ ok: true });
});

// 删除关系：拒绝收到的请求 / 取消发出的请求 / 移除好友（均按对方 userId 删除）
app.delete('/api/friends/:userId', requireAuth, (req, res) => {
  const rel = findRel(req.user.id, req.params.userId);
  if (!rel) return res.status(404).json({ error: '关系不存在' });
  data.friendships = data.friendships.filter((x) => x !== rel);
  save();
  res.json({ ok: true });
});

// 修改好友备注 / 分组
app.patch('/api/friends/:userId', requireAuth, (req, res) => {
  const rel = findRel(req.user.id, req.params.userId);
  if (!rel || rel.status !== 'accepted') return res.status(404).json({ error: '好友关系不存在' });
  const { note, group } = req.body || {};
  if (typeof note === 'string') rel.note = note.slice(0, 30);
  if (typeof group === 'string') rel.group = group.slice(0, 12);
  save();
  res.json({ ok: true, note: rel.note, group: rel.group });
});

// ---------- 路由：黑名单 ----------
// 拉黑某用户（按用户名）
app.post('/api/blocks', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  const target = data.users.find((u) => u.username === username);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能拉黑自己' });
  if (findBlock(req.user.id, target.id)) return res.status(400).json({ error: '已经在黑名单中' });
  // 拉黑的同时解除好友关系（如有）
  data.friendships = data.friendships.filter((x) => !(x.userA === req.user.id && x.userB === target.id) && !(x.userB === req.user.id && x.userA === target.id));
  data.blocks.push({
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    blockerId: req.user.id, blockedId: target.id, createdAt: Date.now(),
  });
  save();
  res.json({ ok: true });
});

// 解除拉黑
app.delete('/api/blocks/:userId', requireAuth, (req, res) => {
  const rel = findBlock(req.user.id, req.params.userId);
  if (!rel) return res.status(404).json({ error: '黑名单中无此用户' });
  data.blocks = data.blocks.filter((x) => x !== rel);
  save();
  res.json({ ok: true });
});

// ---------- 路由：情侣绑定（CP） ----------
// 双方约定同一个情侣码，先输入的一方进入「等待」，后输入相同码的一方与之绑定。
app.post('/api/cp/bind', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const c = (code || '').trim();
  if (!c) return res.status(400).json({ error: '请输入情侣码' });
  if (req.user.cpPartnerId) return res.status(400).json({ error: '你们已经是 CP 啦，先解绑再重新绑定' });
  // 找一位同样输入了该码、且尚未绑定他人的用户作为另一半
  const partner = data.users.find((u) => u.cpCode === c && !u.cpPartnerId && u.id !== req.user.id);
  if (partner) {
    const since = Date.now();
    req.user.cpPartnerId = partner.id;
    req.user.cpSince = since;
    req.user.cpCode = '';
    partner.cpPartnerId = req.user.id;
    partner.cpSince = since;
    partner.cpCode = '';
    save();
    return res.json({ ok: true, partner: { id: partner.id, nickname: partner.nickname, username: partner.username } });
  }
  // 没有匹配的另一半：进入等待（持有该情侣码）
  req.user.cpCode = c;
  save();
  res.json({ ok: true, waiting: true });
});

app.post('/api/cp/unbind', requireAuth, (req, res) => {
  const me = req.user;
  const partner = me.cpPartnerId ? data.users.find((u) => u.id === me.cpPartnerId) : null;
  me.cpPartnerId = null;
  me.cpSince = null;
  me.cpCode = '';
  if (partner) { partner.cpPartnerId = null; partner.cpSince = null; partner.cpCode = ''; }
  save();
  res.json({ ok: true });
});

// ---------- 路由：好友私信 + 房间邀请 ----------
// 发送私信 / 邀请（仅限互为好友；拉黑关系不可发送）
app.post('/api/messages', requireAuth, (req, res) => {
  const { toUserId, type, text, roomCode, gameName } = req.body || {};
  if (!toUserId) return res.status(400).json({ error: '缺少接收人' });
  if (type !== 'chat' && type !== 'invite') return res.status(400).json({ error: '消息类型错误' });
  const target = data.users.find((u) => u.id === toUserId);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (findBlock(target.id, req.user.id) || findBlock(req.user.id, target.id)) {
    return res.status(403).json({ error: '无法给该用户发送消息' });
  }
  if (!findRel(req.user.id, target.id) || findRel(req.user.id, target.id).status !== 'accepted') {
    return res.status(403).json({ error: '只能给好友发送消息' });
  }
  const msg = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    fromId: req.user.id, toId: target.id, type,
    text: type === 'chat' ? (text || '').slice(0, 200) : '',
    roomCode: type === 'invite' ? (roomCode || '') : '',
    gameName: type === 'invite' ? (gameName || '') : '',
    ts: Date.now(), read: false,
  };
  if (type === 'chat' && !msg.text) return res.status(400).json({ error: '消息内容不能为空' });
  data.messages.push(msg);
  save();
  res.json({ ok: true });
});

// 与某好友的会话记录（拉取后标记已读）
app.get('/api/messages', requireAuth, (req, res) => {
  const peer = req.query.peer;
  if (!peer) return res.status(400).json({ error: '缺少 peer' });
  const list = data.messages
    .filter((m) => (m.fromId === req.user.id && m.toId === peer) || (m.fromId === peer && m.toId === req.user.id))
    .sort((a, b) => a.ts - b.ts)
    .slice(-200);
  list.forEach((m) => { if (m.toId === req.user.id) m.read = true; });
  save();
  res.json(list);
});

// 拉取未读消息（用于轮询弹通知）；拉取后标记已读
app.get('/api/messages/unread', requireAuth, (req, res) => {
  const list = data.messages.filter((m) => m.toId === req.user.id && !m.read);
  list.forEach((m) => { m.read = true; });
  save();
  const items = list.map((m) => {
    const from = data.users.find((u) => u.id === m.fromId);
    return {
      id: m.id, fromId: m.fromId, fromName: from ? (from.nickname || from.username) : '好友',
      type: m.type, text: m.text,
      roomCode: m.roomCode, gameName: m.gameName, ts: m.ts,
    };
  });
  res.json({ count: items.length, items });
});

// ---------- 路由：排行榜 ----------
app.get('/api/leaderboard', (req, res) => {
  const list = data.users
    .filter((u) => u.role !== 'admin')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 50)
    .map((u, i) => ({
      rank: i + 1, id: u.id, nickname: u.nickname, username: u.username, score: u.score || 0,
    }));
  res.json(list);
});

// ---------- 路由：房间 ----------
// 内存房间表（重启丢失），房主必须保持心跳，掉线/退出后房间自动消失。
// 结构：code -> { code, peerId, hostPeerId, guestPeerId, password, hostName, hostUserId,
//                 guestName, guestUserId, hostSecret, guestSecret, players, status,
//                 gameId, gameName, createdAt, lastHeartbeat, public,
//                 matchRound, currentMatchId, lastSettledAt }
// hostSecret / guestSecret 是建房、加入时下发的座位凭据：改房、登记新 peerId（重连用）、
// 关房都要带上，避免任何人拿 4 位房间号就能踢人/劫持座位。
const rooms = {};
let nextRoomCode = 1;
const ROOM_HEARTBEAT_MS = 90 * 1000;        // 房主 90 秒内心跳，否则视为离线删房
const ROOM_GC_INTERVAL_MS = 30 * 1000;      // 每 30 秒扫描一次

function newSecret() {
  return crypto.randomBytes(12).toString('hex');
}
// 座位凭据校验：role 为 host / guest
function checkSeat(room, role, secret) {
  if (!room || !secret) return false;
  if (role === 'host') return room.hostSecret === secret;
  if (role === 'guest') return room.guestSecret === secret;
  return false;
}

function allocateRoomCode() {
  for (let i = 0; i < 9999; i++) {
    const code = String(nextRoomCode).padStart(4, '0');
    nextRoomCode = nextRoomCode % 9999 + 1;
    if (!rooms[code]) return code;
  }
  return null;
}

function roomToPublic(room) {
  return {
    code: room.code,
    hostName: room.hostName || '房主',
    players: room.players || 1,
    maxPlayers: 2,
    status: room.status || 'waiting',
    gameId: room.gameId || '',
    gameName: room.gameName || '',
  };
}

app.get('/api/rooms', (req, res) => {
  // 只返回登录用户创建的公开房间；游客房不进入大厅列表（仍可通过房间号加入）
  const list = Object.values(rooms)
    .filter((r) => r.public && !r.password && r.status === 'waiting')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(roomToPublic);
  res.json(list);
});

app.post('/api/rooms', (req, res) => {
  const { peerId, hostName, gameId, gameName } = req.body || {};
  if (!peerId) return res.status(400).json({ error: '缺少 peerId' });
  const hostUser = currentUser(req);
  const code = allocateRoomCode();
  if (!code) return res.status(503).json({ error: '房间号已用完' });
  const now = Date.now();
  rooms[code] = {
    code, peerId, hostPeerId: peerId, guestPeerId: '', password: '',
    hostName: hostName || '',
    hostUserId: hostUser ? hostUser.id : null,
    hostSecret: newSecret(), guestSecret: '',
    guestName: '', guestUserId: null,
    public: !!hostUser,          // 登录用户房间才进入公开列表
    players: 1,
    status: 'waiting',
    gameId: gameId || '',
    gameName: gameName || '',
    createdAt: now,
    lastHeartbeat: now,
    matchRound: 0, currentMatchId: null, lastSettledAt: 0,
  };
  res.json({ code, secret: rooms[code].hostSecret, room: roomToPublic(rooms[code]) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  res.json({ code: room.code, peerId: room.hostPeerId || room.peerId, hasPassword: !!room.password, hostName: room.hostName, status: room.status });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (room.password && room.password !== (req.body.password || '')) {
    return res.status(403).json({ error: '密码错误' });
  }
  const guest = currentUser(req);
  room.guestSecret = newSecret();
  room.guestUserId = guest ? guest.id : null;
  room.guestName = guest ? (guest.nickname || guest.username) : String(req.body.name || '');
  room.players = Math.min((room.players || 1) + 1, 2);
  res.json({
    code: room.code, peerId: room.hostPeerId || room.peerId, secret: room.guestSecret,
    hostName: room.hostName, gameId: room.gameId, gameName: room.gameName,
  });
});

// 重连用：把自己当前的 peerId 登记回房间（页面不掉线、只断连接时 PeerID 会变）
app.post('/api/rooms/:code/seat', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const { role, peerId, secret } = req.body || {};
  if (!peerId) return res.status(400).json({ error: '缺少 peerId' });
  if (!checkSeat(room, role, secret)) return res.status(403).json({ error: '座位凭据不正确' });
  if (role === 'host') { room.hostPeerId = peerId; room.peerId = peerId; }
  else room.guestPeerId = peerId;
  room.lastHeartbeat = Date.now();
  res.json({ ok: true, hostPeerId: room.hostPeerId, guestPeerId: room.guestPeerId });
});

// 重连用：取对方的 peerId（同样要座位凭据，免得外人窥探/投毒）
app.get('/api/rooms/:code/peers', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const role = req.query.role === 'guest' ? 'guest' : 'host';
  if (!checkSeat(room, role, req.query.secret)) return res.status(403).json({ error: '座位凭据不正确' });
  res.json({
    hostPeerId: room.hostPeerId || room.peerId,
    guestPeerId: room.guestPeerId || '',
    status: room.status, gameId: room.gameId || '',
  });
});

app.patch('/api/rooms/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const { password, gameId, gameName, status, players, secret } = req.body || {};
  if (!checkSeat(room, 'host', secret)) return res.status(403).json({ error: '座位凭据不正确' });
  if (typeof password === 'string') room.password = password;
  if (typeof gameId === 'string') room.gameId = gameId;
  if (typeof gameName === 'string') room.gameName = gameName;
  if (typeof status === 'string' && ['waiting', 'playing'].includes(status)) room.status = status;
  if (typeof players === 'number') room.players = Math.max(1, Math.min(2, players));
  res.json({ ok: true });
});

// 房主心跳：保持房间存活
app.post('/api/rooms/:code/heartbeat', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  room.lastHeartbeat = Date.now();
  res.json({ ok: true });
});

app.post('/api/rooms/:code/close', (req, res) => {
  // 页面关闭/刷新时的 beacon 清理接口（同 DELETE 语义，但兼容 sendBeacon POST）
  const room = rooms[req.params.code];
  if (room && !checkSeat(room, 'host', (req.body || {}).secret)) {
    return res.status(403).json({ error: '座位凭据不正确' });
  }
  delete rooms[req.params.code];
  res.json({ ok: true });
});

app.delete('/api/rooms/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (room && !checkSeat(room, 'host', req.query.secret)) {
    return res.status(403).json({ error: '座位凭据不正确' });
  }
  delete rooms[req.params.code];
  res.json({ ok: true });
});

// 定期清理离线房间（房主心跳超时）
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    if (now - rooms[code].lastHeartbeat > ROOM_HEARTBEAT_MS) {
      delete rooms[code];
    }
  }
}, ROOM_GC_INTERVAL_MS);

// 兜底：每小时再清理一次 24 小时未活跃房间
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    if (now - rooms[code].createdAt > 24 * 60 * 60 * 1000) delete rooms[code];
  }
}, 60 * 60 * 1000);

// ---------- 路由：权威结算（Roadmap ③） ----------
// 旧 POST /api/play 的问题：客户端一句 {"result":"win"} 就能给自己加 20 分。
// 现在改成「双方互相印证」：两个参与者各自向服务端声明本局结果，只有两份声明互补
// （我赢 <-> 你输，或者双方都报平局）服务端才真正改分、并给两人各写一条战绩；
// 声明冲突就本局作废（谁都不扣分），客户端显示「结算未确认」。
// 想单方面作弊必须让对方也点一次「我输了」，对情侣应用来说这个成本已经够高了。
// 待结算对局与房间同级放内存：房间本来就随实例消失，落库的只有结算后的战绩。
const SCORE_DELTA = { win: 20, lose: -15, draw: 2 };
// 超时可用环境变量收紧（自动化测试要跑过期分支，不能真等 90 秒）
const MATCH_PENDING_TTL_MS = Number(process.env.MATCH_PENDING_TTL_MS) || 90 * 1000;
const MATCH_KEEP_MS = 10 * 60 * 1000;       // 结束的对局再留 10 分钟，供先上报的一方轮询结果
const MATCH_SETTLE_GAP_MS = 8 * 1000;       // 同房间两次结算的最小间隔，挡脚本连点
const matches = new Map();                  // matchId -> match

function seatOf(room, uid) {
  if (!room || !uid) return null;
  if (room.hostUserId && room.hostUserId === uid) return 'host';
  if (room.guestUserId && room.guestUserId === uid) return 'guest';
  return null;
}
function otherSeatId(room, uid) {
  const seat = seatOf(room, uid);
  if (seat === 'host') return room.guestUserId || null;
  if (seat === 'guest') return room.hostUserId || null;
  return null;
}
function isComplementary(theirs, mine) {
  if (theirs === 'draw' && mine === 'draw') return true;
  return (theirs === 'win' && mine === 'lose') || (theirs === 'lose' && mine === 'win');
}
function matchView(match, uid) {
  const mine = match.reports[uid];
  const otherKey = Object.keys(match.reports).find((k) => k !== uid);
  const settled = match.settled && match.settled[uid];
  return {
    id: match.id, roomId: match.roomCode, gameId: match.gameId, gameName: match.gameName,
    round: match.round, status: match.status,
    result: mine ? mine.result : null,
    theirResult: otherKey ? match.reports[otherKey].result : null,
    delta: settled ? settled.delta : 0,
    score: settled ? settled.score : null,
    createdAt: match.createdAt,
    expiresAt: match.createdAt + MATCH_PENDING_TTL_MS,
  };
}
// 双方声明互补后调用：改两人的分、写两人的战绩
function settleMatch(match) {
  const ids = Object.keys(match.reports);
  const now = Date.now();
  match.settled = {};
  for (const uid of ids) {
    const me = data.users.find((u) => u.id === uid);
    const other = data.users.find((u) => u.id === ids.find((x) => x !== uid));
    if (!me) continue;
    const result = match.reports[uid].result;
    const delta = SCORE_DELTA[result] || 0;
    me.score = (me.score || 1000) + delta;
    match.settled[uid] = { delta, score: me.score };
    data.records.push({
      id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      userId: me.id, username: me.username,
      gameId: match.gameId, gameName: match.gameName,
      opponent: other ? (other.nickname || other.username) : '',
      opponentUsername: other ? other.username : '',
      result, ts: now, delta,
      matchId: match.id, mode: 'p2p',
    });
  }
  match.status = 'settled';
  match.settledAt = now;
  const room = rooms[match.roomCode];
  if (room) {
    room.currentMatchId = null;
    room.lastSettledAt = now;
    room.status = 'waiting';
  }
  save();
}

// 上报本局结果（每个参与者各调一次，服务端凑齐才结算）
app.post('/api/match/report', requireAuth, (req, res) => {
  const { roomCode, gameId, gameName, result, roundHint } = req.body || {};
  if (!roomCode || !gameId) return res.status(400).json({ error: '缺少参数' });
  if (!['win', 'lose', 'draw'].includes(result)) return res.status(400).json({ error: '结果不合法' });
  const room = rooms[String(roomCode)];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (!seatOf(room, req.user.id)) return res.status(403).json({ error: '你不在这个房间里' });
  const otherId = otherSeatId(room, req.user.id);
  if (!otherId || otherId === req.user.id) {
    return res.json({ status: 'unsupported', error: '需要双方都登录账号才会计分' });
  }

  const now = Date.now();
  let match = room.currentMatchId ? matches.get(room.currentMatchId) : null;
  if (match) {
    if (match.status !== 'pending' || now - match.createdAt > MATCH_PENDING_TTL_MS) {
      if (match.status === 'pending') match.status = 'expired';
      room.currentMatchId = null;
      match = null;
    } else if (match.gameId !== gameId) {
      match.status = 'superseded';          // 换游戏了，旧局不再等确认
      room.currentMatchId = null;
      match = null;
    } else if (match.reports[req.user.id]) {
      return res.json(matchView(match, req.user.id));   // 同一局重复上报 -> 幂等
    } else if (typeof roundHint === 'number' && typeof match.roundHint === 'number'
               && match.roundHint !== roundHint) {
      match.status = 'superseded';          // 一方已经开下一局，旧局等不到了
      room.currentMatchId = null;
      match = null;
    }
  }
  if (!match) {
    room.matchRound = (room.matchRound || 0) + 1;
    match = {
      id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 7),
      roomCode: room.code, gameId: String(gameId).slice(0, 24),
      gameName: String(gameName || gameId).slice(0, 24),
      round: room.matchRound,
      roundHint: typeof roundHint === 'number' ? roundHint : null,
      reports: {}, settled: null, status: 'pending', createdAt: now,
    };
    matches.set(match.id, match);
    room.currentMatchId = match.id;
  }

  match.reports[req.user.id] = { result, ts: now };
  const otherReport = match.reports[otherId];
  if (!otherReport) return res.json({ ...matchView(match, req.user.id), status: 'pending' });

  if (!isComplementary(otherReport.result, result)) {
    match.status = 'conflict';
    match.conflictAt = now;
    room.currentMatchId = null;
    return res.json({ ...matchView(match, req.user.id), status: 'conflict' });
  }
  if (room.lastSettledAt && now - room.lastSettledAt < MATCH_SETTLE_GAP_MS) {
    match.status = 'throttled';
    room.currentMatchId = null;
    return res.json({ ...matchView(match, req.user.id), status: 'throttled', error: '结算过于频繁，本局不计分' });
  }
  settleMatch(match);
  res.json({ ...matchView(match, req.user.id), status: 'settled' });
});

// 先上报的一方用它轮询最终结果
app.get('/api/match/:id', requireAuth, (req, res) => {
  const match = matches.get(req.params.id);
  if (!match) return res.status(404).json({ error: '对局不存在或已清理' });
  const room = rooms[match.roomCode];
  if (!seatOf(room, req.user.id)) return res.status(403).json({ error: '无权查看该对局' });
  if (match.status === 'pending' && Date.now() - match.createdAt > MATCH_PENDING_TTL_MS) {
    match.status = 'expired';
    if (room && room.currentMatchId === match.id) room.currentMatchId = null;
  }
  res.json(matchView(match, req.user.id));
});

// 清理已结束 / 超时的对局
setInterval(() => {
  const now = Date.now();
  for (const [id, match] of matches) {
    if (match.status === 'pending' && now - match.createdAt > MATCH_PENDING_TTL_MS) {
      match.status = 'expired';
      const room = rooms[match.roomCode];
      if (room && room.currentMatchId === id) room.currentMatchId = null;
    }
    const stamp = match.settledAt || match.conflictAt || match.createdAt;
    if (match.status !== 'pending' && now - stamp > MATCH_KEEP_MS) matches.delete(id);
  }
}, ROOM_GC_INTERVAL_MS);

// ---------- 路由：管理员 ----------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = data.users.map((u) => ({
    id: u.id, username: u.username, nickname: u.nickname, role: u.role,
    score: u.score || 0, createdAt: u.createdAt, lastLogin: u.lastLogin,
    playCount: data.records.filter((r) => r.userId === u.id).length,
  }));
  res.json(users);
});

app.get('/api/admin/records', requireAuth, requireAdmin, (req, res) => {
  let recs = data.records.slice().sort((a, b) => b.ts - a.ts);
  if (req.query.user) recs = recs.filter((r) => r.userId === req.query.user || r.username === req.query.user);
  res.json(recs);
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = data.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  data.users = data.users.filter((x) => x.id !== u.id);
  data.records = data.records.filter((r) => r.userId !== u.id);
  for (const t in data.sessions) if (data.sessions[t] === u.id) delete data.sessions[t];
  save();
  res.json({ ok: true });
});

// ---------- 静态托管（屏蔽 server 目录，避免源码泄露） ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/server')) return res.status(404).end();
  next();
});
// 前端资源不加强缓存：每次部署后浏览器都会重新校验，避免旧 JS/HTML 被缓存导致功能不更新
app.use((req, res, next) => {
  if (/\.(html|js|css)$/.test(req.path)) res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(ROOT, { extensions: ['html'] }));

// ---------- 首次启动种入管理员 ----------
function seedAdmin() {
  if (data.users.find((u) => u.username === 'admin')) return;
  data.users.push({
    id: 'admin', username: 'admin', nickname: '管理员',
    password: hashPassword('888888'), role: 'admin',
    score: 99999, createdAt: Date.now(), lastLogin: null,
  });
  save();
  console.log('已创建默认管理员账号：admin / 888888（请尽快修改密码）');
}

// data 在 ready 之前是空的（Postgres 要等网络），所以种子账号与字段补全都放在 ready 之后
ready.then(() => {
  seedAdmin();

  // 旧用户积分迁移：没有 score 字段的默认 1000
  let migrated = false;
  data.users.forEach((u) => {
    if (typeof u.score !== 'number') { u.score = 1000; migrated = true; }
    if (u.cpPartnerId === undefined) u.cpPartnerId = null;
    if (u.cpSince === undefined) u.cpSince = null;
    if (u.cpCode === undefined) u.cpCode = '';
  });
  if (migrated) save();
});

// 自建 PeerJS 信令服务器（与 Express 同端口，路径 /peerjs）
// 避免使用 PeerJS 默认国外云信令，解决国内创建房间卡住的问题
const server = http.createServer(app);
const peerServer = ExpressPeerServer(server, {
  path: '/',
  proxied: true,
  allow_discovery: false,
});
app.use('/peerjs', peerServer);

server.listen(PORT, () => {
  console.log('游戏站点运行中： http://localhost:' + PORT);
  console.log('PeerJS 信令服务器运行中： ws://localhost:' + PORT + '/peerjs');
});
