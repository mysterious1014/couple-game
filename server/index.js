// 双人游戏站点后端
// - 静态托管整个前端（与 API 同源，免 CORS）
// - 账号注册 / 登录 / 登出（scrypt 哈希 + httpOnly Cookie 会话）
// - 游玩记录上报与查询
// - 管理员后台（默认账号 admin / 888888）
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { data, save } = require('./store');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

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
    createdAt: Date.now(), lastLogin: null,
  });
  const token = newToken();
  data.sessions[token] = id;
  save();
  res.cookie('sid', token, SESSION_OPTS).json({ id, username, nickname: nickname || username, role: 'user' });
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
  if (token) delete data.sessions[token];
  save();
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '未登录' });
  res.json({ id: u.id, username: u.username, nickname: u.nickname, role: u.role });
});

// ---------- 路由：游玩记录 ----------
app.get('/api/me/records', requireAuth, (req, res) => {
  const recs = data.records.filter((r) => r.userId === req.user.id).sort((a, b) => b.ts - a.ts);
  res.json(recs);
});

app.post('/api/play', requireAuth, (req, res) => {
  const { gameId, gameName, opponent, result } = req.body || {};
  if (!gameId || !result) return res.status(400).json({ error: '缺少参数' });
  const rec = {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: req.user.id, username: req.user.username,
    gameId, gameName: gameName || gameId, opponent: opponent || '', result, ts: Date.now(),
  };
  data.records.push(rec);
  save();
  res.json({ ok: true });
});

// ---------- 路由：管理员 ----------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = data.users.map((u) => ({
    id: u.id, username: u.username, nickname: u.nickname, role: u.role,
    createdAt: u.createdAt, lastLogin: u.lastLogin,
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
app.use(express.static(ROOT, { extensions: ['html'] }));

// ---------- 首次启动种入管理员 ----------
function seedAdmin() {
  if (data.users.find((u) => u.username === 'admin')) return;
  data.users.push({
    id: 'admin', username: 'admin', nickname: '管理员',
    password: hashPassword('888888'), role: 'admin',
    createdAt: Date.now(), lastLogin: null,
  });
  save();
  console.log('已创建默认管理员账号：admin / 888888（请尽快修改密码）');
}

seedAdmin();
app.listen(PORT, () => {
  console.log('游戏站点运行中： http://localhost:' + PORT);
});
