// 个人记录页 与 管理员后台 的渲染逻辑。
import { computeStats, evaluateAchievements } from './achievements.js';
const $ = (id) => document.getElementById(id);

export async function renderProfile(root) {
  root.innerHTML = `
    <button id="pf-back" class="ghost">← 返回大厅</button>
    <h2 class="view-title">我的战绩</h2>
    <div id="pf-stats" class="stats-card"></div>
    <h3 class="view-sub">成就徽章</h3>
    <div id="pf-ach" class="ach-grid"></div>
    <h3 class="view-sub">对局记录</h3>
    <div id="pf-list"></div>`;
  $('pf-back').onclick = () => window.__showLobby && window.__showLobby();
  const statsEl = $('pf-stats');
  const achEl = $('pf-ach');
  const list = $('pf-list');
  try {
    const r = await fetch('/api/me/records');
    if (!r.ok) throw new Error('加载失败');
    const recs = await r.json();
    const stats = computeStats(recs);
    statsEl.innerHTML = statsHtml(stats);
    const achs = evaluateAchievements(stats);
    achEl.innerHTML = achs.map((a) => `
      <div class="ach ${a.unlocked ? 'on' : 'off'}">
        <div class="ach-name">${escapeHtml(a.name)}</div>
        <div class="ach-desc">${escapeHtml(a.desc)}</div>
        <div class="ach-flag">${a.unlocked ? '已达成' : '未达成'}</div>
      </div>`).join('');
    list.innerHTML = recs.length
      ? tableHtml(recs)
      : '<p class="tip">还没有游玩记录，去玩一局吧！</p>';
  } catch (e) {
    list.innerHTML = '<p class="tip">加载失败：' + escapeHtml(e.message) + '</p>';
  }
}

function statsHtml(s) {
  const rows = [
    ['总场次', s.total],
    ['胜 / 负 / 平', `${s.wins} / ${s.loses} / ${s.draws}`],
    ['胜率', s.winRate + '%'],
    ['当前连胜', s.currentStreak],
    ['最高连胜', s.maxStreak],
  ];
  let html = '<div class="stats-row">';
  for (const [k, v] of rows) html += `<div class="stat"><div class="stat-v">${v}</div><div class="stat-k">${escapeHtml(k)}</div></div>`;
  html += '</div>';
  const games = Object.values(s.perGame);
  if (games.length) {
    html += '<div class="per-game">';
    for (const g of games) html += `<span class="pg">${escapeHtml(g.name)}：胜${g.win} 负${g.lose} 平${g.draw}</span>`;
    html += '</div>';
  }
  return html;
}

export async function renderAdmin(root) {
  root.innerHTML = `
    <button id="ad-back" class="ghost">← 返回大厅</button>
    <h2 class="view-title">管理后台</h2>
    <h3 class="view-sub">用户列表</h3>
    <div id="ad-users"></div>
    <h3 class="view-sub">全部游玩记录</h3>
    <div id="ad-records"></div>`;
  $('ad-back').onclick = () => window.__showLobby && window.__showLobby();
  try {
    const [ur, rr] = await Promise.all([fetch('/api/admin/users'), fetch('/api/admin/records')]);
    if (!ur.ok || !rr.ok) throw new Error('权限不足');
    const users = await ur.json();
    const recs = await rr.json();
    $('ad-users').innerHTML = usersHtml(users);
    $('ad-records').innerHTML = recs.length ? tableHtml(recs) : '<p class="tip">暂无记录</p>';
    root.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('确定删除该用户及其全部游玩记录？')) return;
        await fetch('/api/admin/users/' + b.dataset.del, { method: 'DELETE' });
        renderAdmin(root);
      };
    });
  } catch (e) {
    root.innerHTML += '<p class="tip">加载失败：' + escapeHtml(e.message) + '</p>';
  }
}

function tableHtml(recs) {
  const rows = recs.map((r) => `
    <tr>
      <td>${fmt(r.ts)}</td>
      <td>${escapeHtml(r.gameName)}</td>
      <td>${escapeHtml(r.opponent)}</td>
      <td class="r-${r.result}">${resText(r.result)}</td>
    </tr>`).join('');
  return `<table class="rec-table"><thead><tr><th>时间</th><th>游戏</th><th>对手</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function usersHtml(users) {
  const rows = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.nickname || u.username)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? '管理员' : '用户'}</td>
      <td>${u.playCount}</td>
      <td>${u.lastLogin ? fmt(u.lastLogin) : '从未'}</td>
      <td>${u.role === 'admin' ? '' : `<button class="del" data-del="${u.id}">删除</button>`}</td>
    </tr>`).join('');
  return `<table class="rec-table"><thead><tr><th>昵称</th><th>账号</th><th>角色</th><th>游玩次数</th><th>最近登录</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function resText(r) { return r === 'win' ? '胜' : r === 'lose' ? '负' : '平'; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
