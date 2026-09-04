import { Net } from './net.js';
import { Auth, openAuth } from './auth.js';
import { games } from './games/registry.js';
import { renderProfile, renderAdmin } from './views.js';

const net = new Net();
const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const menu = $('menu');
const game = $('game');
const gameRoot = $('gameRoot');
const profile = $('profile');
const admin = $('admin');
let currentGame = null;

// ---------- 视图切换 ----------
function hideAll() { [lobby, menu, game, profile, admin].forEach((s) => (s.hidden = true)); }
function showLobby() { hideAll(); lobby.hidden = false; }
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

$('createBtn').onclick = () => {
  net.host(currentName());
};
$('joinBtn').onclick = () => {
  const c = $('roomInput').value.trim();
  if (!c) { $('lobbyHint').textContent = '请输入房间号'; return; }
  net.join(c, currentName());
};

net.onStatus((type, payload) => {
  if (type === 'waiting') {
    $('lobbyHint').textContent = '房间已创建！把房间号发给对方：' + net.roomCode;
  } else if (type === 'connected') {
    enterMenu();
  } else if (type === 'closed') {
    alert('对方掉线了，刷新页面可重连');
    location.reload();
  } else if (type === 'error') {
    $('lobbyHint').textContent = '出错了：' + payload;
  }
});

// ---------- 菜单 ----------
function enterMenu() {
  hideAll();
  menu.hidden = false;
  $('roomCode').textContent = net.roomCode;
  $('menuStatus').textContent = '已连接！你是 ' + (net.me === 1 ? '红方' : '黄方');
  renderGameList();
  initChat();
}

function renderGameList() {
  const list = $('gameList');
  list.innerHTML = '';
  games.forEach((gm) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `<div class="gc-name">${gm.name}</div><div class="gc-desc">${gm.desc}</div>`;
    card.onclick = () => { net.send('goto', { game: gm.id }); startGame(gm.id); };
    list.appendChild(card);
  });
}

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
    root: gameRoot, net, back: backToMenu,
    reportPlay: (gameId, gameName, opponent, result) =>
      Auth.reportPlay(gameId, gameName, opponent, result),
  });
}

function backToMenu() {
  if (currentGame && currentGame.destroy) currentGame.destroy();
  currentGame = null;
  hideAll();
  menu.hidden = false;
}

net.on('goto', (m) => startGame(m.game));

$('backBtn').onclick = backToMenu;
$('copyBtn').onclick = () => {
  navigator.clipboard.writeText(net.roomCode).then(() => {
    $('copyBtn').textContent = '已复制';
    setTimeout(() => ($('copyBtn').textContent = '复制'), 1500);
  });
};

// ---------- 聊天 ----------
let chatReady = false;
function initChat() {
  if (chatReady) return;
  chatReady = true;
  $('chatPanel').hidden = false;
  const log = $('chatLog');
  const input = $('chatInput');
  const sendBtn = $('chatSend');

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
