import { Net } from './net.js';
import { AINet } from './ai.js';
import { Auth, openAuth } from './auth.js';
import { games } from './games/registry.js';
import { renderProfile, renderAdmin, renderLeaderboard } from './views.js';
import { renderFriends, updateFriendBadge } from './friends.js';
import { Sound } from './sound.js';

// 各游戏专属的结算文案（按 游戏id -> 结果 取用）
const RESULT_QUIPS = {
  gomoku: {
    win: '五子连珠，你就是棋圣本圣 ✨',
    lose: '对方先一步连成五子，下次记得堵他 🛡️',
    draw: '棋盘下满了，平局收场 🤝',
  },
  reversi: {
    win: '满盘皆是你翻出的甜蜜，赢麻了 🖤🤍',
    lose: '棋子都被翻成了对方的颜色，翻回来！💪',
    draw: '黑白平分，这是默契的平局 🤝',
  },
  dots: {
    win: '你把爱心格子都圈走啦，满满都是你 ❤️',
    lose: '方格被对方圈走了，再来抢一次 🔗',
    draw: '格子平分，谁也没占到便宜 📦',
  },
  memory: {
    win: '你记住了每一张脸，默契满分 💕',
    lose: '对手记性更好，下次你也记牢点 🧠',
    draw: '记性不相上下，平局收场 🃏',
  },
  draw: {
    win: '你猜中啦，默契爆表 🎨',
    lose: '没猜中，再接再厉 💡',
    draw: '平局，再来一局 🤝',
  },
};

let realNet = new Net();
let net = realNet;                 // 当前使用的网络（双人 = realNet，人机 = AINet）
const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const room = $('room');
const game = $('game');
const gameRoot = $('gameRoot');
const profile = $('profile');
const admin = $('admin');
const friends = $('friends');
const rank = $('rank');
const chatPanel = $('chatPanel');

let currentGame = null;
let selectedGameId = '';
let roomPasswordSet = false;
let publicRoomTimer = null;
let roomHeartbeatTimer = null;  // 房主房间心跳
let roomOwnedCode = null;      // 当前持有的真实房间号（用于页面关闭时清理）

async function serverDeleteRoom(code) {
  try {
    await fetch(`/api/rooms/${code}?secret=${encodeURIComponent(net.roomSecret || '')}`, { method: 'DELETE' });
  } catch { /* 忽略 */ }
}

function startRoomHeartbeat(code) {
  stopRoomHeartbeat();
  roomOwnedCode = code;
  const ping = () => {
    if (!roomOwnedCode) return;
    // 带上座位凭据，服务端才知道续的是哪个座位（房主 / 访客各算各的存活）
    fetch(`/api/rooms/${roomOwnedCode}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: net && net.isHost ? 'host' : 'guest', secret: (net && net.roomSecret) || '' }),
    }).catch(() => {});
  };
  ping();
  roomHeartbeatTimer = setInterval(ping, 30 * 1000);
}

function stopRoomHeartbeat() {
  if (roomHeartbeatTimer) { clearInterval(roomHeartbeatTimer); roomHeartbeatTimer = null; }
  roomOwnedCode = null;
}

// 访客离座：只让出自己那个座位，房间留给房主，别人也立刻能进来（不用干等 45s TTL）
async function serverLeaveRoom(code) {
  try {
    await fetch(`/api/rooms/${code}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: (net && net.roomSecret) || '' }),
    });
  } catch { /* 忽略 */ }
}

// 改房间（选游戏 / 状态 / 密码）必须带建房时下发的座位凭据，服务端据此拒绝外人乱改
async function serverPatchRoom(code, patch) {
  try {
    await fetch(`/api/rooms/${code}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, secret: net.roomSecret || '' }),
    });
  } catch { /* 后端同步失败不影响 P2P 游戏 */ }
}

// ---------- P2P 结算：服务端权威，双方互相印证才计分 ----------
// 每局结束各自上报一次自己看到的结果；服务端凑齐两份互补的声明才改分。
// 先上报的一方拿 matchId 轮询，等对方确认后刷新积分显示。
let roundHint = 0;      // 本房间内第几局（两端各自累加，服务端用它区分「一方已经开下一局」）
async function settleP2P(gameId, gameName, result) {
  try {
    const r = await fetch('/api/match/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: net.roomCode, gameId, gameName, result, roundHint }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'error', message: j.error || '结算请求失败' };
    if (j.status === 'pending' && j.id) return (await waitMatchSettled(j.id)) || j;
    return j;
  } catch {
    return { status: 'error', message: '网络异常，本局未结算' };
  }
}
async function waitMatchSettled(matchId, budgetMs = 25000) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const r = await fetch(`/api/match/${encodeURIComponent(matchId)}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status !== 'pending') return j;
    } catch { /* 继续轮询 */ }
  }
  return { status: 'timeout' };
}
function applySettlement(j) {
  const modal = $('resultModal');
  const score = $('resultScore');
  const open = modal && !modal.hidden;
  const note = (txt) => { if (open) { score.style.fontSize = '14px'; score.textContent = txt; } };
  if (j.status === 'settled') {
    if (typeof j.score === 'number') Auth.applyScore(j.score);
    if (open) { score.style.fontSize = ''; score.textContent = (j.delta > 0 ? '+' : '') + j.delta + ' 积分'; }
    showToast('双方已确认，本局结算完成 ✅');
    return;
  }
  if (j.status === 'conflict') note('双方上报的结果不一致，本局不计分');
  else if (j.status === 'unsupported') note(j.error || '双方都登录后才会计分');
  else if (j.status === 'throttled') note('结算太频繁，本局不计分');
  else if (j.status === 'expired' || j.status === 'superseded') note('对方未确认，本局不计分');
  else note(j.message || '本局未结算');
  if (j.status !== 'unsupported') Sound.draw();
}

// ---------- 视图切换 ----------
function hideAll() { [lobby, room, game, profile, admin, friends, rank].forEach((s) => (s.hidden = true)); }
function showLobby() {
  // 房主离开 = 整间房关掉；访客离开 = 只让出座位，房间继续留给房主
  if (net && !net.isAI && net.roomCode) {
    if (net.isHost) serverDeleteRoom(net.roomCode);
    else serverLeaveRoom(net.roomCode);
  }
  stopRoomHeartbeat();             // 停止房主心跳
  reportPresence(null);            // 离开房间，清除「所在房间」状态
  hideAll(); lobby.hidden = false;
  chatPanel.hidden = true;
  document.body.classList.remove('chat-open');
  $('chatLauncher').hidden = true;
  if (net) net.destroy();
  realNet = new Net();
  net = realNet;
  bindNetEvents(net);
  selectedGameId = '';
  roomPasswordSet = false;
  renderCPBanner();
  loadPublicRooms();
  startPublicRoomPolling();
}
function showProfile() { hideAll(); profile.hidden = false; renderProfile(profile); }
function showAdmin() { hideAll(); admin.hidden = false; renderAdmin(admin); }
function showRank() { hideAll(); rank.hidden = false; renderLeaderboard(rank); }
function showFriends() {
  if (!Auth.me) { openAuth('login'); return; }
  hideAll(); friends.hidden = false; renderFriends(friends);
}
window.__showLobby = showLobby;
window.__showProfile = showProfile;
window.__showAdmin = showAdmin;
window.__showRank = showRank;
window.__showFriends = showFriends;

// 在线状态心跳：登录后由前端定时上报，便于好友列表显示在线/房间
let presenceTimer = null;
function reportPresence(roomCode) {
  if (!Auth.me) return;
  fetch('/api/presence', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode: roomCode || null }),
  }).catch(() => {});
}

function showResultModal(result, delta, gameId, note) {
  const modal = $('resultModal');
  const title = $('resultTitle');
  const desc = $('resultDesc');
  const score = $('resultScore');
  const anim = $('resultAnim');
  modal.classList.remove('win', 'lose', 'draw');
  if (result === 'win') {
    modal.classList.add('win');
    title.textContent = '胜利！';
    anim.textContent = '🏆';
  } else if (result === 'lose') {
    modal.classList.add('lose');
    title.textContent = '失败';
    anim.textContent = '😢';
  } else {
    modal.classList.add('draw');
    title.textContent = '平局';
    anim.textContent = '⚖️';
  }
  // 优先使用当前游戏的专属文案，否则用通用文案
  const quip = RESULT_QUIPS[gameId] && RESULT_QUIPS[gameId][result];
  desc.textContent = quip || (result === 'win' ? '太棒了，这场你赢了 🎉'
    : result === 'lose' ? '别灰心，下一局赢回来 💪' : '势均力敌，再来一局吧 🤝');
  // 播放对应结算音效
  if (result === 'win') Sound.win();
  else if (result === 'lose') Sound.lose();
  else Sound.draw();
  if (net && net.isAI) {
    score.textContent = '人机模式不计积分';
    score.style.fontSize = '14px';
  } else if (note) {
    score.style.fontSize = '14px';
    score.textContent = note;
  } else if (typeof delta === 'number') {
    score.style.fontSize = '';
    score.textContent = (delta > 0 ? '+' : '') + delta + ' 积分';
  } else {
    score.style.fontSize = '14px';
    score.textContent = '积分未更新';
  }
  modal.hidden = false;
}

$('resultReplay').onclick = () => {
  $('resultModal').hidden = true;
  if (currentGame && typeof currentGame.restart === 'function') currentGame.restart();
  else backToRoom();
};
$('resultBack').onclick = () => {
  $('resultModal').hidden = true;
  backToRoom();
};

// ---------- 情侣绑定（CP） ----------
function renderCPBanner() {
  const el = $('cpBanner');
  if (!el) return;
  if (!Auth.me) { el.hidden = true; el.innerHTML = ''; return; }
  const cp = Auth.me.cpPartner;
  if (cp) {
    const days = Auth.me.cpSince ? Math.max(1, Math.floor((Date.now() - Auth.me.cpSince) / 86400000)) : 1;
    el.hidden = false;
    el.innerHTML = `
      <span class="cp-heart">💞</span>
      <span class="cp-text">你和 <b>${escapeHtml(cp.nickname || cp.username)}</b> 已经在一起 <b>${days}</b> 天啦</span>
      <button id="cpUnbindBtn" class="cp-unbind">解绑</button>`;
    $('cpUnbindBtn').onclick = unbindCP;
  } else if (Auth.me.cpWaiting) {
    el.hidden = false;
    el.innerHTML = `
      <span class="cp-heart">💗</span>
      <span class="cp-text">正在等待 TA 输入相同的情侣码…</span>
      <button id="cpUnbindBtn" class="cp-unbind">取消</button>`;
    $('cpUnbindBtn').onclick = unbindCP;
  } else {
    el.hidden = false;
    el.innerHTML = `
      <span class="cp-heart">💗</span>
      <span class="cp-text">还没有绑定情侣？绑定后首页显示「在一起 N 天」</span>
      <button id="cpBindOpen" class="cp-bind-open">绑定情侣</button>`;
    $('cpBindOpen').onclick = () => { $('cpModal').hidden = false; $('cpInput').focus(); };
  }
}
async function bindCP() {
  const code = $('cpInput').value.trim();
  const msg = $('cpMsg');
  if (!code) { msg.textContent = '请输入情侣码'; return; }
  msg.textContent = '绑定中…';
  try {
    const r = await fetch('/api/cp/bind', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg.textContent = j.error || '绑定失败'; return; }
    if (j.waiting) msg.textContent = '已记录情侣码，等 TA 输入相同一串即可绑定 ✅';
    else msg.textContent = '绑定成功，你们是 CP 啦 ❤️';
    const me = await fetch('/api/me').then((r) => r.ok ? r.json() : null).catch(() => null);
    if (me) Auth.me = me;
    setTimeout(() => { $('cpModal').hidden = true; renderCPBanner(); }, 1200);
  } catch { msg.textContent = '网络错误，请稍后重试'; }
}
async function unbindCP() {
  if (!confirm('确定解绑情侣关系？')) return;
  try {
    await fetch('/api/cp/unbind', { method: 'POST' });
    const me = await fetch('/api/me').then((r) => r.ok ? r.json() : null).catch(() => null);
    if (me) Auth.me = me;
  } catch { /* 忽略 */ }
  renderCPBanner();
}
$('cpBindBtn').onclick = bindCP;
$('cpClose').onclick = () => { $('cpModal').hidden = true; };
$('cpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') bindCP(); });
// 战绩明细弹窗
$('recClose').onclick = () => { $('recModal').hidden = true; };
$('recBack').onclick = () => { $('recModal').hidden = true; };
// 排行榜
$('rankToggle').onclick = () => showRank();

// ---------- 好友私聊 + 房间邀请 ----------
let chatPeer = null;        // { id, name }
let chatPoll = null;
async function openPrivateChat(friendId, friendUsername) {
  if (!Auth.me) { openAuth('login'); return; }
  chatPeer = { id: friendId, name: friendUsername };
  const modal = $('chatModal');
  $('chatModalTitle').textContent = '💬 与 ' + (friendUsername || '好友') + ' 私聊';
  $('chatModalLog').innerHTML = '<div class="cm-empty">加载中…</div>';
  modal.hidden = false;
  await loadChat();
  if (chatPoll) clearInterval(chatPoll);
  chatPoll = setInterval(loadChat, 4000);
}
async function loadChat() {
  if (!chatPeer) return;
  try {
    const r = await fetch('/api/messages?peer=' + encodeURIComponent(chatPeer.id));
    if (!r.ok) return;
    const list = await r.json();
    const log = $('chatModalLog');
    if (!list.length) { log.innerHTML = '<div class="cm-empty">还没有消息，打个招呼吧～</div>'; return; }
    log.innerHTML = list.map((m) => {
      const me = m.fromId === (Auth.me && Auth.me.id);
      return `<div class="cm-msg ${me ? 'me' : 'peer'}"><div class="cm-bubble">${escapeHtml(m.text || '')}</div><div class="cm-time">${fmtTime(m.ts)}</div></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  } catch { /* 忽略 */ }
}
async function sendChat() {
  if (!chatPeer) return;
  const inp = $('chatModalInput');
  const t = inp.value.trim();
  if (!t) return;
  try {
    await fetch('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toUserId: chatPeer.id, type: 'chat', text: t }),
    });
    inp.value = '';
    await loadChat();
  } catch { /* 忽略 */ }
}
$('chatModalClose').onclick = () => {
  $('chatModal').hidden = true;
  if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }
};
$('chatModalSend').onclick = sendChat;
$('chatModalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// 邀请好友进房间（先确保自己在房间，再发邀请消息）
async function inviteFriend(friendId, friendUsername) {
  if (!Auth.me) { openAuth('login'); return; }
  const doSend = async (code) => {
    const gameName = selectedGameId ? (games.find((g) => g.id === selectedGameId) || {}).name || '' : '';
    try {
      await fetch('/api/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: friendId, type: 'invite', roomCode: code, gameName }),
      });
    } catch { /* 忽略 */ }
  };
  if (net && net.isHost && net.roomCode && !net.isAI) {
    await doSend(net.roomCode);
    showToast('已向 ' + (friendUsername || '好友') + ' 发送房间邀请 ✨');
  } else {
    try {
      net = realNet;
      const code = await net.host(currentName(), Auth.me ? Auth.me.username : '');
      enterRoom(code);
      await new Promise((r) => setTimeout(r, 300));
      await doSend(code);
      showToast('已创建房间并向 ' + (friendUsername || '好友') + ' 发送邀请 ✨');
    } catch (e) {
      showToast('创建房间失败：' + (e.message || '请重试'));
    }
  }
}
window.__openPrivateChat = openPrivateChat;
window.__inviteFriend = inviteFriend;

// 轮询未读私信 / 邀请，弹通知
let lastMsgTs = 0;
async function pollUnread() {
  if (!Auth.me) return;
  try {
    const r = await fetch('/api/messages/unread');
    if (!r.ok) return;
    const j = await r.json();
    (j.items || []).forEach((m) => {
      if (m.ts <= lastMsgTs) return;       // 已经提示过的不再重复
      if (m.type === 'invite') showInviteNotify(m);
      else showChatNotify(m);
    });
    if (j.items && j.items.length) lastMsgTs = Math.max(lastMsgTs, ...j.items.map((m) => m.ts));
  } catch { /* 忽略 */ }
}
function showInviteNotify(m) {
  const area = $('notifyArea');
  if (!area) return;
  const card = document.createElement('div');
  card.className = 'notify-card invite';
  card.innerHTML = `
    <div class="nf-ico">💌</div>
    <div class="nf-body">
      <div class="nf-title">${escapeHtml(m.fromName || '好友')} 邀请你一起玩</div>
      <div class="nf-sub">房间 ${escapeHtml(m.roomCode)} ${m.gameName ? '· ' + escapeHtml(m.gameName) : ''}</div>
    </div>
    <div class="nf-actions">
      <button class="nf-btn join">加入</button>
      <button class="nf-btn close">忽略</button>
    </div>`;
  area.appendChild(card);
  card.querySelector('.join').onclick = () => {
    card.remove();
    window.__showLobby && window.__showLobby();
    setTimeout(() => { $('roomInput').value = m.roomCode; $('joinBtn').click(); }, 0);
  };
  card.querySelector('.close').onclick = () => card.remove();
  setTimeout(() => card.remove(), 15000);
}
function showChatNotify(m) {
  showToast('💬 ' + (m.fromName || '好友') + ' 给你发来新消息');
}

// 轻提示
function showToast(msg) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 大厅 ----------
function currentName() {
  if (Auth.me) return Auth.me.nickname || Auth.me.username;
  const input = $('nickInput');
  return (input ? input.value.trim() : '') || '游客';
}

function renderNickLine() {
  const input = $('nickInput');
  const display = $('nickDisplay');
  const edit = $('nickEdit');
  if (!input || !display || !edit) return;
  if (Auth.me) {
    input.hidden = true;
    display.hidden = false;
    display.textContent = Auth.me.nickname || Auth.me.username;
    edit.hidden = false;
    edit.onclick = () => window.__showProfile && window.__showProfile();
  } else {
    input.hidden = false;
    display.hidden = true;
    edit.hidden = true;
    input.value = input.value.trim() || '游客';
  }
}

$('createBtn').onclick = async () => {
  if (!Auth.me) {
    $('lobbyHint').textContent = '创建公开房间请先登录，或选择和电脑玩 / 输入房间号加入';
    openAuth('login');
    return;
  }
  net = realNet;
  $('createBtn').disabled = true;
  $('lobbyHint').textContent = '正在创建房间…';
  try {
    const code = await net.host(currentName(), Auth.me ? Auth.me.username : '');
    enterRoom(code);
  } catch (e) {
    $('lobbyHint').textContent = '创建失败：' + (e.message || '网络异常，请重试');
  } finally {
    $('createBtn').disabled = false;
  }
};

$('joinBtn').onclick = async () => {
  const raw = $('roomInput').value.trim();
  if (!/^\d{4}$/.test(raw)) { $('lobbyHint').textContent = '请输入 4 位数字房间号'; return; }

  net = realNet;
  $('joinBtn').disabled = true;
  $('lobbyHint').textContent = '正在加入房间…';
  try {
    const info = await Net.peekRoom(raw);
    let password = '';
    if (info.hasPassword) {
      password = window.prompt('该房间已设置密码，请输入：') || '';
      if (!password) { $('lobbyHint').textContent = '已取消加入'; return; }
    }
    await net.join(raw, currentName(), password, Auth.me ? Auth.me.username : '');
    enterRoom(raw);
  } catch (e) {
    $('lobbyHint').textContent = '加入失败：' + (e.message || '网络异常，请重试');
    // 座位已经在服务端登记上、但 P2P 没连成的话，立刻还座，别让别人白等 45 秒
    if (net && net.roomCode && net.roomSecret) serverLeaveRoom(net.roomCode);
  } finally {
    $('joinBtn').disabled = false;
  }
};

// 人机对战入口
$('vsAIBtn').onclick = () => { $('aiModal').hidden = false; };
$('addAIBtn').onclick = () => { $('aiModal').hidden = false; };
$('removeAIBtn').onclick = async () => {
  // 移除电脑玩家：销毁 AI 房间，重新创建真实房间等待真人加入
  if (net && net.isAI) net.destroy();
  realNet = new Net();
  net = realNet;
  bindNetEvents(net);
  selectedGameId = '';
  roomPasswordSet = false;
  try {
    const code = await net.host(currentName(), Auth.me ? Auth.me.username : '');
    enterRoom(code);
  } catch (e) {
    $('lobbyHint').textContent = '创建房间失败：' + (e.message || '网络异常');
    showLobby();
  }
};
document.querySelectorAll('[data-diff]').forEach((b) => {
  b.onclick = () => {
    const diff = b.dataset.diff;
    $('aiModal').hidden = true;
    realNet.destroy();          // 离开真实房间，避免挂着空房间
    net = new AINet(diff);
    net.myName = currentName();
    enterRoom('AI');
  };
});
$('aiClose').onclick = () => { $('aiModal').hidden = true; };

// ---------- 断线重连遮罩（Roadmap ②） ----------
function showNetOverlay(title, sub, canRetry) {
  const box = $('netOverlay');
  if (!box) return;
  $('netOverlayTitle').textContent = title;
  $('netOverlaySub').textContent = sub;
  $('netRetryBtn').hidden = !canRetry;
  box.hidden = false;
}
function hideNetOverlay() {
  const box = $('netOverlay');
  if (box) box.hidden = true;
}

function bindNetEvents(n) {
  n.onStatus((type, payload) => {
    if (type === 'connected') {
      hideNetOverlay();
      updateRoomPlayers();
      if (!n.isHost) n.send('room_get_settings');
      if (payload && payload.reconnected) showToast('已重新连接 ✅');
    } else if (type === 'reconnecting') {
      showNetOverlay('📶 连接中断', `正在尝试重新连接…（第 ${payload.attempt} 次）`, true);
    } else if (type === 'resyncing') {
      showNetOverlay('正在恢复这局', `按对方进度回放 ${payload.entries} 步…`, false);
    } else if (type === 'resynced') {
      hideNetOverlay();
      if (payload && !payload.host && payload.entries) showToast('棋局已恢复到断线前 🎯');
    } else if (type === 'closed') {
      hideNetOverlay();
      updateRoomPlayers();
      if (!game.hidden) {
        const why = payload && (payload.reason === 'room-gone' || payload.reason === 'cancelled')
          ? '房间已关闭，回到大厅重新开一个吧' : '对方掉线了，返回大厅可重新连接';
        alert(why);
        showLobby();
      }
    } else if (type === 'error') {
      $('lobbyHint').textContent = '连接出错：' + payload;
    } else if (type === 'peername') {
      updateRoomPlayers();
    }
  });
  // 房间级消息：必须跟着实例走。历史上它们写在模块作用域里，而 showLobby() 每次回大厅
  // 都会 new Net()，新实例上根本没有这些订阅 ⇒ 访客收不到「房主选了游戏 / 开始游戏」。
  n.on('room_set_game', (m) => {
    if (n.isHost) return;
    selectedGameId = m.gameId;
    $('selectedGameName').textContent = m.gameName || '未选择';
  });
  n.on('room_settings', (m) => {
    if (n.isHost) return;
    selectedGameId = m.gameId;
    $('selectedGameName').textContent = m.gameName || '未选择';
  });
  n.on('room_get_settings', () => {
    if (!n.isHost) return;
    const gm = games.find((g) => g.id === selectedGameId);
    n.send('room_settings', { gameId: selectedGameId, gameName: gm ? gm.name : '' });
  });
  n.on('start_game', (m) => startGame(m.gameId));

  // 重连后由同步层按日志要求重建对局；不可回放的游戏就老实回到房间重开
  n.onRebuild = (entries) => {
    if (!lastGameId) return;
    const gm = games.find((g) => g.id === lastGameId);
    if (!gm || gm.noReplay) {
      backToRoom();
      showToast('这类对局无法恢复，已回到房间');
      return;
    }
    startGame(lastGameId, { replay: entries });
  };
}
bindNetEvents(net);

// 重连遮罩上的两个按钮：立刻再试一次 / 放弃（只绑一次，换 Net 也不重复挂）
if ($('netRetryBtn')) $('netRetryBtn').onclick = () => { if (net && net.retryReconnect) net.retryReconnect(); };
if ($('netCancelBtn')) $('netCancelBtn').onclick = () => { if (net && net.cancelReconnect) net.cancelReconnect(); };

// ---------- 公开房间列表 ----------
function startPublicRoomPolling() {
  stopPublicRoomPolling();
  publicRoomTimer = setInterval(loadPublicRooms, 6000);
}
function stopPublicRoomPolling() {
  if (publicRoomTimer) { clearInterval(publicRoomTimer); publicRoomTimer = null; }
}

async function loadPublicRooms() {
  const listEl = $('publicRoomList');
  const statusEl = $('prStatus');
  if (!listEl) return;
  try {
    const r = await fetch('/api/rooms?public=1', { cache: 'no-store' });
    if (!r.ok) throw new Error('加载失败');
    const rooms = await r.json();
    statusEl.textContent = `共 ${rooms.length} 个房间`;
    renderPublicRooms(rooms);
  } catch (e) {
    statusEl.textContent = '刷新失败';
    listEl.innerHTML = '<div class="pr-empty">房间列表加载失败，请稍后再试</div>';
  }
}

function renderPublicRooms(rooms) {
  const listEl = $('publicRoomList');
  if (!rooms || rooms.length === 0) {
    listEl.innerHTML = '<div class="pr-empty">暂无公开房间，自己开一个吧 💕</div>';
    return;
  }
  listEl.innerHTML = rooms.map((r) => {
    const statusText = r.players >= 2 ? '已满' : '等待中';
    const statusCls = r.players >= 2 ? '' : 'waiting';
    const gameText = r.gameName || '未选择游戏';
    const gameCls = r.gameName ? 'game' : '';
    return `
      <div class="pr-item" data-code="${escapeHtml(r.code)}">
        <div class="pr-meta">
          <span class="pr-code">${escapeHtml(r.code)}</span>
          <span class="pr-host">房主：${escapeHtml(r.hostName || '房主')}</span>
        </div>
        <div class="pr-tags">
          <span class="pr-tag ${statusCls}">${statusText}</span>
          <span class="pr-tag ${gameCls}">${escapeHtml(gameText)}</span>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.pr-item').forEach((item) => {
    item.onclick = () => {
      const code = item.dataset.code;
      $('roomInput').value = code;
      $('joinBtn').click();
    };
  });
}

// ---------- 房间 ----------
function enterRoom(code) {
  stopPublicRoomPolling();
  hideAll();
  room.hidden = false;
  $('roomCodeBig').textContent = net.isAI ? 'AI' : code;
  // 房间头部两栏是固定的「房主 / 访客」两个座位，不是「我 / 对方」：访客进房时房主那栏
  // 必须写真正的房主，否则看起来像房主被换成了自己（peerName 由 /join 响应回填）。
  $('hostName').textContent = net.isHost || net.isAI ? net.myName : (net.peerName || '房主');
  selectedGameId = '';
  roomPasswordSet = false;
  chatPanel.hidden = net.isAI;     // 人机模式不显示悄悄话
  $('chatLauncher').hidden = true; // 人机模式也不显示重新打开按钮

  if (net.isAI) {
    $('hostPanel').hidden = false;
    $('guestPanel').hidden = true;
    $('pwdRow').hidden = true;     // 人机无需密码
    $('addAIBtn').hidden = true;
    $('removeAIBtn').hidden = false;
    $('guestName').textContent = net.peerName;
    $('guestName').classList.remove('empty');
    $('guestTag').hidden = false;
    $('guestTag').textContent = '电脑';
    renderRoomGameList();
    bindHostRoomEvents();
    updateStartButton();
  } else if (net.isHost) {
    $('hostPanel').hidden = false;
    $('guestPanel').hidden = true;
    $('pwdRow').hidden = false;
    $('addAIBtn').hidden = net.ready;
    $('removeAIBtn').hidden = true;
    $('roomPwd').value = '';
    $('setPwdBtn').hidden = false;
    $('clearPwdBtn').hidden = true;
    renderRoomGameList();
    bindHostRoomEvents();
  } else {
    $('hostPanel').hidden = true;
    $('guestPanel').hidden = false;
    $('addAIBtn').hidden = true;
    $('removeAIBtn').hidden = true;
    $('selectedGameName').textContent = '未选择';
  }

  updateRoomPlayers();
  if (!net.isAI) initChat();

  $('leaveRoomBtn').onclick = () => {
    if (currentGame) { if (currentGame.destroy) currentGame.destroy(); currentGame = null; }
    showLobby();
  };
  $('copyRoomCode').onclick = () => {
    navigator.clipboard.writeText(net.roomCode).then(() => {
      const btn = $('copyRoomCode');
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = old), 1500);
    });
  };

  // 房主和访客都要心跳：房主那份让房间不被 GC 清掉，访客那份证明自己还坐在座位上
  if (!net.isAI && net.roomCode) startRoomHeartbeat(net.roomCode);

  // 上报在线状态与所在房间，让好友在列表里看到「在房间 XXXX」
  reportPresence(net.isAI ? null : net.roomCode);
}

function updateRoomPlayers() {
  const both = net.ready;
  const guestName = $('guestName');
  const guestTag = $('guestTag');
  // 头部两栏随时按「谁是房主」重排：访客视角下房主栏 = 对方，访客栏 = 自己
  $('hostName').textContent = net.isAI || net.isHost ? net.myName : (net.peerName || '房主');
  if (both) {
    guestName.textContent = net.isAI || net.isHost ? net.peerName : net.myName;
    guestName.classList.remove('empty');
    guestTag.hidden = false;
    if (!net.isAI && net.isHost) { $('addAIBtn').hidden = true; $('removeAIBtn').hidden = true; }
  } else {
    guestName.textContent = '等待对方加入…';
    guestName.classList.add('empty');
    guestTag.hidden = true;
    if (!net.isAI && net.isHost) { $('addAIBtn').hidden = false; $('removeAIBtn').hidden = true; }
  }
  updateStartButton();
}

function updateStartButton() {
  const btn = $('startGameBtn');
  if (!btn) return;
  const both = net.ready;
  const hasGame = !!selectedGameId;
  btn.disabled = !(both && hasGame);
  if (!both) btn.textContent = '等待对方加入';
  else if (!hasGame) btn.textContent = '请选择游戏';
  else btn.textContent = '开始游戏';
}

function renderRoomGameList() {
  const list = $('roomGameList');
  list.innerHTML = '';
  games.forEach((gm) => {
    const card = document.createElement('div');
    card.className = 'room-game-card' + (selectedGameId === gm.id ? ' on' : '');
    card.innerHTML = `<div class="rg-name">${escapeHtml(gm.name)}</div><div class="rg-desc">${escapeHtml(gm.desc)}</div>`;
    card.onclick = () => {
      selectedGameId = gm.id;
      renderRoomGameList();
      updateStartButton();
      if (!net.isAI) {
        net.send('room_set_game', { gameId: gm.id, gameName: gm.name });
        if (net.isHost && net.roomCode) {
          serverPatchRoom(net.roomCode, { gameId: gm.id, gameName: gm.name });
        }
      }
    };
    list.appendChild(card);
  });
}

function bindHostRoomEvents() {
  $('setPwdBtn').onclick = async () => {
    const pwd = $('roomPwd').value;
    try {
      const r = await fetch(`/api/rooms/${net.roomCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, secret: net.roomSecret || '' }),
      });
      if (!r.ok) throw new Error('设置失败');
      roomPasswordSet = !!pwd;
      $('setPwdBtn').hidden = roomPasswordSet;
      $('clearPwdBtn').hidden = !roomPasswordSet;
      $('roomHint').textContent = roomPasswordSet ? '密码已设置' : '密码已清除';
      if (!net.isAI) net.send('room_set_game', { gameId: selectedGameId, gameName: games.find((g) => g.id === selectedGameId)?.name || '' });
    } catch (e) { $('roomHint').textContent = e.message; }
  };

  $('clearPwdBtn').onclick = async () => {
    $('roomPwd').value = '';
    try {
      const r = await fetch(`/api/rooms/${net.roomCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '', secret: net.roomSecret || '' }),
      });
      if (!r.ok) throw new Error('清除失败');
      roomPasswordSet = false;
      $('setPwdBtn').hidden = false;
      $('clearPwdBtn').hidden = true;
      $('roomHint').textContent = '密码已清除';
      if (!net.isAI) net.send('room_set_game', { gameId: selectedGameId, gameName: games.find((g) => g.id === selectedGameId)?.name || '' });
    } catch (e) { $('roomHint').textContent = e.message; }
  };

  $('startGameBtn').onclick = () => {
    if (!selectedGameId) return;
    if (net.isAI) {
      net.beginGame(selectedGameId);
      startGame(selectedGameId);
    } else {
      if (!net.ready) return;
      net.send('start_game', { gameId: selectedGameId });
      startGame(selectedGameId);
    }
  };
}

// 房间级的 4 个订阅已挪进 bindNetEvents()：那里才能保证「每个 Net 实例都绑一次」。

// ---------- 游戏路由 ----------
// opts.replay：重连后按日志重建这一局，此时不能清日志、也不能重置局数计数
let lastGameId = '';
function startGame(id, opts = {}) {
  const gm = games.find((g) => g.id === id);
  if (!gm) return;
  if (currentGame && currentGame.destroy) currentGame.destroy();
  gameRoot.innerHTML = '';
  hideAll();
  game.hidden = false;
  $('gameTitle').textContent = gm.name;
  if (!opts.replay) {
    lastGameId = id;
    if (!net.isAI) { net.resetJournal(); roundHint = 0; }
  }
  if (net.isHost && net.roomCode && !net.isAI) {
    serverPatchRoom(net.roomCode, { status: 'playing' });
  }
  currentGame = gm.mount({
    root: gameRoot, net, back: backToRoom,
    reportPlay: async (gameId, gameName, opponent, result) => {
      if (net.isAI) {
        showResultModal(result, 0, gameId);
        return;
      }
      roundHint += 1;
      showResultModal(result, null, gameId, '等待对方确认结算…');
      const j = await settleP2P(gameId, gameName || gm.name, result);
      applySettlement(j);
    },
  });
}

function backToRoom() {
  if (currentGame && currentGame.destroy) currentGame.destroy();
  currentGame = null;
  lastGameId = '';
  // 返回房间时把状态改回 waiting，方便再次开始
  if (net.isHost && net.roomCode && !net.isAI) {
    serverPatchRoom(net.roomCode, { status: 'waiting' });
  }
  enterRoom(net.roomCode);
}

$('backBtn').onclick = backToRoom;

// ---------- 聊天 ----------
let chatUnsub = null;   // initChat() 可能被同一实例重复调用，留着上一次的退订句柄
function initChat() {
  chatPanel.hidden = false;
  document.body.classList.add('chat-open');  // 通知 CSS 给右侧聊天栏留位
  // 窄屏（手机）默认收成小条，避免聊天抽屉遮挡游戏内容；宽屏自动展开
  if (window.innerWidth <= 600) chatPanel.classList.add('minimized');
  else chatPanel.classList.remove('minimized');
  $('chatLauncher').hidden = true;            // 隐藏重新打开按钮
  const log = $('chatLog');
  const input = $('chatInput');
  const sendBtn = $('chatSend');
  log.innerHTML = '';

  // 缩小 / 展开
  $('chatMin').onclick = () => chatPanel.classList.toggle('minimized');
  // 关闭面板，显示浮动按钮以便重新打开
  $('chatClose').onclick = () => {
    chatPanel.hidden = true;
    document.body.classList.remove('chat-open');
    $('chatLauncher').hidden = false;
  };
  // 通过浮动按钮重新打开
  $('chatLauncher').onclick = () => {
    $('chatLauncher').hidden = true;
    chatPanel.hidden = false;
    document.body.classList.add('chat-open');
    chatPanel.classList.remove('minimized');
  };

  function append(name, text, me) {
    const d = document.createElement('div');
    d.className = 'chat-msg ' + (me ? 'me' : 'peer');
    d.textContent = name + '：' + text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  if (chatUnsub) chatUnsub();            // 同一个 Net 实例反复进房间时先退订，避免一条消息渲染多遍
  chatUnsub = net.on('chat', (m) => append(m.name, m.text, false));
  function send() {
    const t = input.value.trim();
    if (!t) return;
    net.send('chat', { name: net.myName, text: t });
    append(net.myName, t, true);
    input.value = '';
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

// ---------- 启动 ----------
Auth.onChange((me) => {
  renderNickLine();
  if (me) {
    reportPresence();                 // 登录后立即上报在线
  } else {
    updateFriendBadge();              // 登出后清空红点
  }
});
Auth.init();

// 在线心跳 + 好友红点轮询（仅登录态运行）
if (Auth.me) {
  reportPresence();
  presenceTimer = setInterval(() => reportPresence(), 30000);
}
setInterval(() => { if (Auth.me) updateFriendBadge(); }, 20000);
// 未读私信 / 房间邀请通知轮询
setInterval(() => { pollUnread(); }, 8000);

// ---------- 音效 ----------
// 浏览器要求音频在用户手势后才能播放，首次交互时解锁
function unlockAudioOnce() {
  Sound.unlock();
  window.removeEventListener('pointerdown', unlockAudioOnce);
  window.removeEventListener('keydown', unlockAudioOnce);
}
window.addEventListener('pointerdown', unlockAudioOnce);
window.addEventListener('keydown', unlockAudioOnce);

// 静音开关（顶栏 🔊/🔇）
function syncSoundBtn() {
  const btn = $('soundToggle');
  if (!btn) return;
  btn.textContent = Sound.enabled ? '🔊' : '🔇';
  btn.setAttribute('aria-label', Sound.enabled ? '关闭音效' : '开启音效');
}
$('soundToggle').onclick = () => {
  Sound.enabled = !Sound.enabled;   // setter 会自动写入 localStorage
  if (Sound.enabled) Sound.unlock();
  syncSoundBtn();
};
syncSoundBtn();

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 初始进入页面时拉取一次公开房间
loadPublicRooms();
startPublicRoomPolling();

// 页面关闭/刷新前，若当前持有真实房间，尝试立刻通知后端清理（避免房主直接关标签导致残留）
window.addEventListener('beforeunload', () => {
  if (roomOwnedCode) {
    // 房主关页面 = 关房；访客关页面 = 离座。访客用 /close 会被 403 挡掉，所以以前这步是空操作。
    // 移动端 beacon 不可靠也不强求：访客的座位 45 秒没心跳就自动释放了。
    const endpoint = (net && net.isHost === false) ? 'leave' : 'close';
    const body = JSON.stringify({ secret: (net && net.roomSecret) || '' });
    try { navigator.sendBeacon && navigator.sendBeacon(`/api/rooms/${roomOwnedCode}/${endpoint}`, new Blob([body], { type: 'application/json' })); } catch {}
  }
});
