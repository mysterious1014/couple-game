import { Net } from './net.js';
import { Auth, openAuth } from './auth.js';
import { games } from './games/registry.js';
import { renderProfile, renderAdmin } from './views.js';

const net = new Net();
const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const room = $('room');
const game = $('game');
const gameRoot = $('gameRoot');
const profile = $('profile');
const admin = $('admin');

let currentGame = null;
let selectedGameId = '';
let chatReady = false;
let roomPasswordSet = false;

// ---------- 视图切换 ----------
function hideAll() { [lobby, room, game, profile, admin].forEach((s) => (s.hidden = true)); }
function showLobby() {
  hideAll(); lobby.hidden = false;
  $('chatPanel').hidden = true;
  net.destroy();
  selectedGameId = '';
  roomPasswordSet = false;
}
function showProfile() { hideAll(); profile.hidden = false; renderProfile(profile); }
function showAdmin() { hideAll(); admin.hidden = false; renderAdmin(admin); }
window.__showLobby = showLobby;
window.__showProfile = showProfile;
window.__showAdmin = showAdmin;

// ---------- 大厅 ----------
function currentName() {
  const input = $('nickInput');
  let name = input ? input.value.trim() : '';
  if (Auth.me) name = Auth.me.nickname || Auth.me.username;
  return name || '游客';
}
function setLobbyNick(name) {
  const input = $('nickInput');
  if (input) input.value = name;
}

$('createBtn').onclick = async () => {
  $('createBtn').disabled = true;
  $('lobbyHint').textContent = '正在创建房间…';
  try {
    const code = await net.host(currentName());
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

  $('joinBtn').disabled = true;
  $('lobbyHint').textContent = '正在加入房间…';
  try {
    const info = await Net.peekRoom(raw);
    let password = '';
    if (info.hasPassword) {
      password = window.prompt('该房间已设置密码，请输入：') || '';
      if (!password) { $('lobbyHint').textContent = '已取消加入'; return; }
    }
    await net.join(raw, currentName(), password);
    enterRoom(raw);
  } catch (e) {
    $('lobbyHint').textContent = '加入失败：' + (e.message || '网络异常，请重试');
  } finally {
    $('joinBtn').disabled = false;
  }
};

net.onStatus((type, payload) => {
  if (type === 'connected') {
    updateRoomPlayers();
    if (!net.isHost) net.send('room_get_settings');
  } else if (type === 'closed') {
    updateRoomPlayers();
    if (!game.hidden) {
      alert('对方掉线了，返回大厅可重新连接');
      showLobby();
    }
  } else if (type === 'error') {
    $('lobbyHint').textContent = '连接出错：' + payload;
  } else if (type === 'peername') {
    updateRoomPlayers();
  }
});

// ---------- 房间 ----------
function enterRoom(code) {
  hideAll();
  room.hidden = false;
  $('chatPanel').hidden = false;
  $('roomCodeBig').textContent = code;
  $('hostName').textContent = net.isHost ? net.myName : net.peerName;

  selectedGameId = '';
  roomPasswordSet = false;

  if (net.isHost) {
    $('hostPanel').hidden = false;
    $('guestPanel').hidden = true;
    $('roomPwd').value = '';
    $('setPwdBtn').hidden = false;
    $('clearPwdBtn').hidden = true;
    renderRoomGameList();
    bindHostRoomEvents();
  } else {
    $('hostPanel').hidden = true;
    $('guestPanel').hidden = false;
    $('selectedGameName').textContent = '未选择';
  }

  updateRoomPlayers();
  initChat();

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
}

function updateRoomPlayers() {
  const both = net.ready;
  const guestName = $('guestName');
  const guestTag = $('guestTag');
  if (both) {
    guestName.textContent = net.peerName;
    guestName.classList.remove('empty');
    guestTag.hidden = false;
  } else {
    guestName.textContent = '等待对方加入…';
    guestName.classList.add('empty');
    guestTag.hidden = true;
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
      net.send('room_set_game', { gameId: gm.id, gameName: gm.name });
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
        body: JSON.stringify({ password: pwd }),
      });
      if (!r.ok) throw new Error('设置失败');
      roomPasswordSet = !!pwd;
      $('setPwdBtn').hidden = roomPasswordSet;
      $('clearPwdBtn').hidden = !roomPasswordSet;
      $('roomHint').textContent = roomPasswordSet ? '密码已设置' : '密码已清除';
      net.send('room_set_game', { gameId: selectedGameId, gameName: games.find((g) => g.id === selectedGameId)?.name || '' });
    } catch (e) { $('roomHint').textContent = e.message; }
  };

  $('clearPwdBtn').onclick = async () => {
    $('roomPwd').value = '';
    try {
      const r = await fetch(`/api/rooms/${net.roomCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' }),
      });
      if (!r.ok) throw new Error('清除失败');
      roomPasswordSet = false;
      $('setPwdBtn').hidden = false;
      $('clearPwdBtn').hidden = true;
      $('roomHint').textContent = '密码已清除';
      net.send('room_set_game', { gameId: selectedGameId, gameName: games.find((g) => g.id === selectedGameId)?.name || '' });
    } catch (e) { $('roomHint').textContent = e.message; }
  };

  $('startGameBtn').onclick = () => {
    if (!selectedGameId || !net.ready) return;
    net.send('start_game', { gameId: selectedGameId });
    startGame(selectedGameId);
  };
}

net.on('room_set_game', (m) => {
  if (!net.isHost) {
    selectedGameId = m.gameId;
    $('selectedGameName').textContent = m.gameName || '未选择';
  }
});

net.on('room_settings', (m) => {
  if (!net.isHost) {
    selectedGameId = m.gameId;
    $('selectedGameName').textContent = m.gameName || '未选择';
  }
});

net.on('room_get_settings', () => {
  if (net.isHost) {
    const gm = games.find((g) => g.id === selectedGameId);
    net.send('room_settings', { gameId: selectedGameId, gameName: gm ? gm.name : '' });
  }
});

net.on('start_game', (m) => startGame(m.gameId));

// ---------- 游戏路由 ----------
function startGame(id) {
  const gm = games.find((g) => g.id === id);
  if (!gm) return;
  if (currentGame && currentGame.destroy) currentGame.destroy();
  gameRoot.innerHTML = '';
  hideAll();
  game.hidden = false;
  $('gameTitle').textContent = gm.name;
  currentGame = gm.mount({
    root: gameRoot, net, back: backToRoom,
    reportPlay: (gameId, gameName, opponent, result) =>
      Auth.reportPlay(gameId, gameName, opponent, result),
  });
}

function backToRoom() {
  if (currentGame && currentGame.destroy) currentGame.destroy();
  currentGame = null;
  enterRoom(net.roomCode);
}

$('backBtn').onclick = backToRoom;

// ---------- 聊天 ----------
function initChat() {
  if (chatReady) { $('chatLog').innerHTML = ''; return; }
  chatReady = true;
  $('chatPanel').hidden = false;
  const log = $('chatLog');
  const input = $('chatInput');
  const sendBtn = $('chatSend');
  log.innerHTML = '';

  function append(name, text, me) {
    const d = document.createElement('div');
    d.className = 'chat-msg ' + (me ? 'me' : 'peer');
    d.textContent = name + '：' + text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  net.on('chat', (m) => append(m.name, m.text, false));
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
  if (me) setLobbyNick(me.nickname || me.username);
  else setLobbyNick('游客');
});
Auth.init();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
