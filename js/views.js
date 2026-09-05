// 个人记录页 与 管理员后台 的渲染逻辑。
import { computeStats, evaluateAchievements } from './achievements.js';
import { Auth } from './auth.js';
const $ = (id) => document.getElementById(id);

// 段位：按积分划分（粉色情侣风称号）
export function tierOf(score) {
  const s = score || 0;
  if (s >= 1700) return { name: '星耀情侣', icon: '🌟' };
  if (s >= 1500) return { name: '钻石情侣', icon: '👑' };
  if (s >= 1350) return { name: '铂金情侣', icon: '💎' };
  if (s >= 1200) return { name: '黄金情侣', icon: '🥇' };
  if (s >= 1100) return { name: '白银情侣', icon: '🥈' };
  if (s >= 1000) return { name: '青铜情侣', icon: '🥉' };
  return { name: '新手', icon: '🌱' };
}

// 排行榜名次图标
function rankIcon(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return '💕';
}

export async function renderProfile(root) {
  root.innerHTML = `
    <button id="pf-back" class="ghost">← 返回大厅</button>
    <h2 class="view-title">我的战绩</h2>
    <div id="pf-stats" class="stats-card"></div>
    <h3 class="view-sub">成就徽章</h3>
    <div id="pf-ach" class="ach-grid"></div>
    <h3 class="view-sub">对局记录 <span class="view-hint">（点击查看详情）</span></h3>
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
    const me = await fetch('/api/me').then((r) => r.ok ? r.json() : {}).catch(() => ({}));
    const score = me.score || 0;
    statsEl.innerHTML = statsHtml(stats, score);
    const achs = evaluateAchievements(stats);
    achEl.innerHTML = achs.map((a) => `
      <div class="ach ${a.unlocked ? 'on' : 'off'}">
        <div class="ach-name">${escapeHtml(a.name)}</div>
        <div class="ach-desc">${escapeHtml(a.desc)}</div>
        <div class="ach-flag">${a.unlocked ? '已达成' : '未达成'}</div>
      </div>`).join('');
    // 拉取好友列表 + CP 对象，用于在对手列标记
    let friendNames = new Set();
    let cpUsername = (me.cpPartner && me.cpPartner.username) ? String(me.cpPartner.username).toLowerCase() : '';
    try {
      const fr = await fetch('/api/friends');
      if (fr.ok) {
        const fd = await fr.json();
        (fd.friends || []).forEach((f) => {
          if (f.username) friendNames.add(String(f.username).toLowerCase());
          if (f.nickname) friendNames.add(String(f.nickname).toLowerCase());
        });
      }
    } catch { /* 标记失败不影响列表 */ }
    list.innerHTML = recs.length
      ? tableHtml(recs, friendNames, cpUsername)
      : '<p class="tip">还没有游玩记录，去玩一局吧！</p>';
    // 绑定行点击 -> 明细弹窗
    list.querySelectorAll('tr[data-idx]').forEach((tr) => {
      tr.onclick = () => { const i = +tr.dataset.idx; if (recs[i]) openRecModal(recs[i]); };
    });
  } catch (e) {
    list.innerHTML = '<p class="tip">加载失败：' + escapeHtml(e.message) + '</p>';
  }
}

// 战绩明细弹窗
function openRecModal(r) {
  const modal = $('recModal');
  const body = $('recBody');
  if (!modal || !body) return;
  const delta = typeof r.delta === 'number' ? r.delta : 0;
  const resultText = r.result === 'win' ? '胜利' : r.result === 'lose' ? '失败' : '平局';
  body.innerHTML = `
    <div class="rd-row"><span class="rd-k">游戏</span><span class="rd-v">${escapeHtml(r.gameName)}</span></div>
    <div class="rd-row"><span class="rd-k">对手</span><span class="rd-v">${escapeHtml(r.opponent || '—')}${r.opponentUsername ? ` <span class="rd-sub">@${escapeHtml(r.opponentUsername)}</span>` : ''}</span></div>
    <div class="rd-row"><span class="rd-k">结果</span><span class="rd-v r-${r.result}">${resultText}</span></div>
    <div class="rd-row"><span class="rd-k">积分变化</span><span class="rd-v ${delta >= 0 ? 'pos' : 'neg'}">${delta >= 0 ? '+' : ''}${delta}</span></div>
    <div class="rd-row"><span class="rd-k">时间</span><span class="rd-v">${fmt(r.ts)}</span></div>`;
  modal.hidden = false;
}

function statsHtml(s, score) {
  const tier = tierOf(score);
  const rows = [
    ['段位', `${tier.icon} ${tier.name}`],
    ['当前积分', score || 0],
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

export async function renderLeaderboard(root) {
  // 先拉自己的信息，便于高亮
  let meId = null, meScore = 0;
  try { const m = await fetch('/api/me').then((r) => r.ok ? r.json() : {}).catch(() => ({})); meId = m.id || null; meScore = m.score || 0; } catch {}
  let friendIds = new Set();
  try { const fr = await fetch('/api/friends'); if (fr.ok) { const fd = await fr.json(); (fd.friends || []).forEach((f) => friendIds.add(f.id)); } } catch {}

  root.innerHTML = `
    <button id="rk-back" class="ghost">← 返回大厅</button>
    <h2 class="view-title">🏆 情侣积分排行榜</h2>
    <p class="tip">积分越高段位越高，和好友 / CP 一起上分吧！</p>
    <div id="rk-body" class="rank-body"></div>`;
  $('rk-back').onclick = () => window.__showLobby && window.__showLobby();
  const body = $('rk-body');
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) throw new Error('加载失败');
    const list = await r.json();
    if (!list.length) { body.innerHTML = '<p class="tip">还没有排行榜数据，去玩几局攒积分吧！</p>'; return; }
    body.innerHTML = list.map((u) => {
      const tier = tierOf(u.score);
      const me = u.id === meId;
      const frd = friendIds.has(u.id);
      const cls = me ? 'me' : (frd ? 'friend' : '');
      const tag = me ? '<span class="rk-tag">我</span>' : (frd ? '<span class="rk-tag frd">好友</span>' : '');
      return `
        <div class="rk-item ${cls}">
          <span class="rk-rank r${u.rank <= 3 ? u.rank : 'n'}">${u.rank}</span>
          <span class="rk-tier" title="第 ${u.rank} 名 · ${escapeHtml(tier.name)}">${rankIcon(u.rank)}</span>
          <span class="rk-name">${escapeHtml(u.nickname || u.username)} ${tag}</span>
          <span class="rk-score">🏆 ${u.score}</span>
        </div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<p class="tip">加载失败：' + escapeHtml(e.message) + '</p>';
  }
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

function tableHtml(recs, friendNames, cpUsername) {
  const isFriend = (r) => {
    if (!friendNames) return false;
    if (r.opponentUsername && friendNames.has(String(r.opponentUsername).toLowerCase())) return true;
    return r.opponent && friendNames.has(String(r.opponent).toLowerCase());
  };
  const isCP = (r) => !!cpUsername && (r.opponentUsername && String(r.opponentUsername).toLowerCase() === cpUsername);
  const rows = recs.map((r, i) => {
    let badge = '';
    if (isCP(r)) badge = ' <span class="cp-badge" title="CP 对局">💞</span>';
    else if (isFriend(r)) badge = ' <span class="friend-badge" title="好友">💕</span>';
    return `
    <tr data-idx="${i}" class="rec-row">
      <td>${fmt(r.ts)}</td>
      <td>${escapeHtml(r.gameName)}</td>
      <td>${escapeHtml(r.opponent || '—')}${badge}</td>
      <td class="r-${r.result}">${resText(r.result)}</td>
    </tr>`;
  }).join('');
  return `<table class="rec-table"><thead><tr><th>时间</th><th>游戏</th><th>对手</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function usersHtml(users) {
  const rows = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.nickname || u.username)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? '管理员' : '用户'}</td>
      <td>${u.score || 0}</td>
      <td>${u.playCount}</td>
      <td>${u.lastLogin ? fmt(u.lastLogin) : '从未'}</td>
      <td>${u.role === 'admin' ? '' : `<button class="del" data-del="${u.id}">删除</button>`}</td>
    </tr>`).join('');
  return `<table class="rec-table"><thead><tr><th>昵称</th><th>账号</th><th>角色</th><th>积分</th><th>游玩次数</th><th>最近登录</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
