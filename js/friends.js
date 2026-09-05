// 好友系统前端：加好友、好友请求、分组/备注、黑名单、在线状态、邀请/加入、移除。
import { Auth } from './auth.js';
const $ = (id) => document.getElementById(id);

let autoTimer = null;       // 好友页打开时的自动刷新（更新在线状态）
let friendsRoot = null;     // 当前 #friends 容器
let currentTab = 'list';    // 'list' | 'req' | 'block'
let currentGroup = '';      // 分组筛选（'' = 全部）
let lastData = null;        // 缓存最近一次好友数据，供分组筛选使用

const GROUP_OPTIONS = ['闺蜜', '家人', '同事', '同学', '游戏搭子', '其他'];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchFriends() {
  try {
    const r = await fetch('/api/friends');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------- 渲染主框架 ----------
export async function renderFriends(root) {
  friendsRoot = root;
  if (!Auth.me) { root.innerHTML = '<p class="tip">请先登录后再查看好友</p>'; return; }
  root.innerHTML = `
    <button id="fr-back" class="ghost">← 返回大厅</button>
    <h2 class="view-title">好友</h2>
    <div class="fr-add">
      <input id="fr-input" placeholder="输入用户名，添加好友" maxlength="20" />
      <button id="fr-send" class="primary">发送请求</button>
    </div>
    <p id="fr-msg" class="hint"></p>
    <div class="fr-tabs">
      <button class="fr-tab active" data-tab="list">我的好友 <span id="fr-count" class="fr-num"></span></button>
      <button class="fr-tab" data-tab="req">好友请求 <span id="fr-reqcount" class="fr-num"></span></button>
      <button class="fr-tab" data-tab="block">黑名单</button>
    </div>
    <div id="fr-body"></div>`;

  $('fr-back').onclick = () => window.__showLobby && window.__showLobby();
  $('fr-send').onclick = sendRequest;
  $('fr-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRequest(); });
  root.querySelectorAll('.fr-tab').forEach((t) => {
    t.onclick = () => {
      root.querySelectorAll('.fr-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      currentTab = t.dataset.tab;
      loadAndRender();
    };
  });

  await loadAndRender();
  startAuto();
}

// ---------- 数据加载 + 渲染 ----------
async function loadAndRender() {
  const data = await fetchFriends();
  if (!data) { const b = $('fr-body'); if (b) b.innerHTML = '<div class="fr-empty">加载失败，请稍后重试</div>'; return; }
  lastData = data;
  $('fr-count').textContent = data.friends.length ? '(' + data.friends.length + ')' : '';
  $('fr-reqcount').textContent = data.pendingCount ? '(' + data.pendingCount + ')' : '';
  if (currentTab === 'list') renderList(data);
  else if (currentTab === 'req') renderReq(data);
  else renderBlock(data);
  updateFriendBadge(data);
}

// ---------- 分组筛选 chips ----------
function groupChips(data) {
  const groups = Array.from(new Set(data.friends.map((f) => f.group).filter(Boolean)));
  if (!groups.length && !currentGroup) return '';
  const all = ['', ...groups];
  const chip = (g) => `<button class="fr-chip ${currentGroup === g ? 'on' : ''}" data-group="${escapeHtml(g)}">${g ? escapeHtml(g) : '全部'}</button>`;
  return `<div class="fr-chips">${all.map(chip).join('')}</div>`;
}

function renderList(data) {
  const body = $('fr-body');
  const friends = currentGroup ? data.friends.filter((f) => f.group === currentGroup) : data.friends;
  let html = groupChips(data);
  if (!friends.length) {
    html += currentGroup
      ? `<div class="fr-empty">「${escapeHtml(currentGroup)}」分组下还没有好友</div>`
      : '<div class="fr-empty">还没有好友，搜索用户名加个好友吧 💕</div>';
    body.innerHTML = html;
    bindChips();
    return;
  }
  html += friends.map(friendCard).join('');
  body.innerHTML = html;
  bindChips();
  bindActions(body);
}

function friendCard(f) {
  const dot = f.online ? 'on' : 'off';
  const roomBtn = (f.online && f.roomCode)
    ? `<button class="fr-mini" data-act="join" data-code="${escapeHtml(f.roomCode)}">在房间 ${escapeHtml(f.roomCode)} · 加入</button>`
    : '';
  const groupSel = `<select class="fr-group" data-id="${escapeHtml(f.id)}">
      <option value="">未分组</option>
      ${GROUP_OPTIONS.map((g) => `<option value="${escapeHtml(g)}" ${f.group === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}
    </select>`;
  const noteLine = f.note
    ? `<div class="fr-note">备注：${escapeHtml(f.note)} <button class="fr-editnote" data-act="note" data-id="${escapeHtml(f.id)}" data-note="${escapeHtml(f.note)}">✎</button></div>`
    : `<button class="fr-mini ghost" data-act="note" data-id="${escapeHtml(f.id)}" data-note="">＋ 备注</button>`;
  return `
    <div class="fr-card">
      <div class="fr-avatar">${escapeHtml((f.nickname || f.username || '?')[0])}</div>
      <div class="fr-info">
        <div class="fr-name">${escapeHtml(f.nickname || f.username)} <span class="dot ${dot}"></span><span class="fr-st">${f.online ? '在线' : '离线'}</span></div>
        <div class="fr-sub">@${escapeHtml(f.username)} · 🏆 ${f.score}</div>
        ${noteLine}
        ${groupSel}
        ${roomBtn}
      </div>
      <div class="fr-actions">
        <button class="fr-mini" data-act="chat" data-id="${f.id}" data-username="${escapeHtml(f.username)}">💬 私聊</button>
        <button class="fr-mini ghost" data-act="invite" data-id="${f.id}" data-username="${escapeHtml(f.username)}">邀请对战</button>
        <button class="fr-mini ghost danger" data-act="remove" data-id="${escapeHtml(f.id)}">移除</button>
      </div>
    </div>`;
}

function renderReq(data) {
  const body = $('fr-body');
  let html = '';
  if (data.incoming.length) {
    html += '<h3 class="view-sub">收到的请求</h3>';
    html += data.incoming.map((u) => reqCard(u, 'in')).join('');
  }
  if (data.outgoing.length) {
    html += '<h3 class="view-sub">已发出的请求</h3>';
    html += data.outgoing.map((u) => reqCard(u, 'out')).join('');
  }
  if (!html) html = '<div class="fr-empty">暂无好友请求 📭</div>';
  body.innerHTML = html;
  bindActions(body);
}

function renderBlock(data) {
  const body = $('fr-body');
  let html = `
    <div class="fr-add" style="margin-top:10px">
      <input id="blk-input" placeholder="输入用户名，加入黑名单" maxlength="20" />
      <button id="blk-send" class="primary danger">拉黑</button>
    </div>
    <p id="blk-msg" class="hint"></p>`;
  if (!data.blocks || !data.blocks.length) {
    html += '<div class="fr-empty">黑名单为空。被拉黑的人无法给你发好友请求 🚫</div>';
  } else {
    html += '<div class="fr-list">';
    html += data.blocks.map((u) => `
      <div class="fr-card">
        <div class="fr-avatar">${escapeHtml((u.nickname || u.username || '?')[0])}</div>
        <div class="fr-info">
          <div class="fr-name">${escapeHtml(u.nickname || u.username)}</div>
          <div class="fr-sub">@${escapeHtml(u.username)}</div>
        </div>
        <div class="fr-actions">
          <button class="fr-mini ghost" data-act="unblock" data-id="${escapeHtml(u.id)}">解除拉黑</button>
        </div>
      </div>`).join('');
    html += '</div>';
  }
  body.innerHTML = html;
  $('blk-send').onclick = sendBlock;
  $('blk-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBlock(); });
  bindActions(body);
}

function reqCard(u, kind) {
  const actions = kind === 'in'
    ? `<button class="fr-mini" data-act="accept" data-id="${escapeHtml(u.id)}">接受</button>
       <button class="fr-mini ghost danger" data-act="reject" data-id="${escapeHtml(u.id)}">拒绝</button>`
    : `<button class="fr-mini ghost danger" data-act="cancel" data-id="${escapeHtml(u.id)}">取消</button>`;
  const tag = kind === 'in' ? '<span class="fr-tag">想加你为好友</span>' : '<span class="fr-tag out">等待通过</span>';
  return `
    <div class="fr-card">
      <div class="fr-avatar">${escapeHtml((u.nickname || u.username || '?')[0])}</div>
      <div class="fr-info">
        <div class="fr-name">${escapeHtml(u.nickname || u.username)} ${tag}</div>
        <div class="fr-sub">@${escapeHtml(u.username)}</div>
      </div>
      <div class="fr-actions">${actions}</div>
    </div>`;
}

function bindChips() {
  friendsRoot.querySelectorAll('.fr-chip').forEach((c) => {
    c.onclick = () => {
      currentGroup = c.dataset.group;
      if (lastData) renderList(lastData);
    };
  });
}

function bindActions(scope) {
  scope.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const code = btn.dataset.code;
      const username = btn.dataset.username;
      if (act === 'accept') doAccept(id);
      else if (act === 'reject') doDelete(id, '已拒绝该请求');
      else if (act === 'cancel') doDelete(id, '已取消发出的请求');
      else if (act === 'remove') {
        if (confirm('确定移除该好友？')) doDelete(id, '已移除好友');
      } else if (act === 'join') joinFriendRoom(code);
      else if (act === 'chat') window.__openPrivateChat && window.__openPrivateChat(id, username);
      else if (act === 'invite') window.__inviteFriend && window.__inviteFriend(id, username);
      else if (act === 'unblock') doUnblock(id);
      else if (act === 'note') editNote(btn, id);
    };
  });
  scope.querySelectorAll('.fr-group').forEach((sel) => {
    sel.onchange = () => patchFriend(sel.dataset.id, { group: sel.value });
  });
}

// ---------- 备注编辑 ----------
function editNote(btn, id) {
  const cur = btn.dataset.note || '';
  const info = btn.closest('.fr-info');
  if (!info) return;
  const wrap = document.createElement('div');
  wrap.className = 'fr-note-edit';
  wrap.innerHTML = `
    <input class="fr-note-input" maxlength="30" placeholder="给好友写个备注" value="${escapeHtml(cur)}" />
    <button class="fr-mini" data-save="1">保存</button>
    <button class="fr-mini ghost" data-cancel="1">取消</button>`;
  // 用编辑框替换当前备注行（按钮或文字）
  const parent = btn.parentNode;
  parent.replaceChild(wrap, btn);
  const input = wrap.querySelector('.fr-note-input');
  input.focus();
  wrap.querySelector('[data-save]').onclick = async () => {
    await patchFriend(id, { note: input.value.trim() });
    await loadAndRender();
  };
  wrap.querySelector('[data-cancel]').onclick = () => loadAndRender();
}

async function patchFriend(id, patch) {
  try {
    await fetch('/api/friends/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch { /* 忽略 */ }
}

// ---------- 操作 ----------
async function sendRequest() {
  const input = $('fr-input');
  const msg = $('fr-msg');
  const u = input.value.trim();
  if (!u) { msg.textContent = '请输入用户名'; return; }
  msg.textContent = '发送中…';
  try {
    const r = await fetch('/api/friends/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) msg.textContent = j.error || '发送失败';
    else { msg.textContent = '已向 ' + u + ' 发送好友请求 ✅'; input.value = ''; updateFriendBadge(); }
  } catch { msg.textContent = '网络错误，请稍后重试'; }
  await loadAndRender();
}

async function sendBlock() {
  const input = $('blk-input');
  const msg = $('blk-msg');
  const u = input.value.trim();
  if (!u) { msg.textContent = '请输入用户名'; return; }
  msg.textContent = '处理中…';
  try {
    const r = await fetch('/api/blocks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) msg.textContent = j.error || '拉黑失败';
    else { msg.textContent = '已把 ' + u + ' 加入黑名单 🚫'; input.value = ''; }
  } catch { msg.textContent = '网络错误，请稍后重试'; }
  await loadAndRender();
}

async function doAccept(id) {
  try {
    await fetch('/api/friends/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id }),
    });
  } catch { /* 忽略 */ }
  await loadAndRender();
}

async function doDelete(id, tip) {
  try {
    await fetch('/api/friends/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast(tip);
  } catch { /* 忽略 */ }
  await loadAndRender();
}

async function doUnblock(id) {
  try {
    await fetch('/api/blocks/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('已解除拉黑');
  } catch { /* 忽略 */ }
  await loadAndRender();
}

function joinFriendRoom(code) {
  window.__showLobby && window.__showLobby();
  setTimeout(() => {
    const inp = $('roomInput');
    if (inp) inp.value = code;
    if ($('joinBtn')) $('joinBtn').click();
  }, 0);
}

// ---------- 顶栏红点（未读好友请求数） ----------
export async function updateFriendBadge(data) {
  const badge = $('friendBadge');
  if (!badge) return;
  if (!Auth.me) { badge.hidden = true; return; }
  let d = data;
  if (!d) {
    try { const r = await fetch('/api/friends'); if (r.ok) d = await r.json(); } catch { return; }
  }
  if (!d) return;
  const n = d.pendingCount || 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
}

// ---------- 自动刷新（仅好友页打开时） ----------
function startAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(async () => {
    if (!friendsRoot || friendsRoot.hidden) { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } return; }
    const data = await fetchFriends();
    if (!data) return;
    lastData = data;
    $('fr-count').textContent = data.friends.length ? '(' + data.friends.length + ')' : '';
    $('fr-reqcount').textContent = data.pendingCount ? '(' + data.pendingCount + ')' : '';
    if (currentTab === 'list') renderList(data);
    else if (currentTab === 'req') renderReq(data);
    else renderBlock(data);
    updateFriendBadge(data);
  }, 15000);
}

// ---------- 轻提示 ----------
function showToast(msg) {
  let t = document.getElementById('fr-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'fr-toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}
