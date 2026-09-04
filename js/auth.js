// 前端账号模块：登录 / 注册 / 登出 / 上报战绩。
// 通过 Cookie 会话与同源后端通信，无需手动管理 token。

const $ = (id) => document.getElementById(id);

export const Auth = {
  me: null,
  _listeners: [],

  onChange(cb) {
    this._listeners.push(cb);
    if (this.me !== undefined) cb(this.me);
    return () => { this._listeners = this._listeners.filter((h) => h !== cb); };
  },

  _notify() { this._listeners.forEach((cb) => cb(this.me)); },

  async init() {
    try {
      const r = await fetch('/api/me');
      if (r.ok) this.me = await r.json();
    } catch { /* 离线或非登录态 */ }
    this.renderAuthArea();
    return this.me;
  },

  async login(username, password) {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '登录失败'); }
    this.me = await r.json();
    this.renderAuthArea();
    return this.me;
  },

  async register(username, password, nickname) {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '注册失败'); }
    this.me = await r.json();
    this.renderAuthArea();
    this._notify();
    return this.me;
  },

  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    this.me = null;
    this.renderAuthArea();
  },

  async reportPlay(gameId, gameName, opponent, result) {
    if (!this.me) return;
    try {
      await fetch('/api/play', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, gameName, opponent, result }),
      });
    } catch { /* 上报失败不影响游戏 */ }
  },

  isAdmin() { return !!(this.me && this.me.role === 'admin'); },

  renderAuthArea() {
    const el = $('authArea');
    if (!el) return;
    if (!this.me) {
      el.innerHTML = `<button id="btnLogin">登录</button><button id="btnReg" class="primary">注册</button>`;
      $('btnLogin').onclick = () => openAuth('login');
      $('btnReg').onclick = () => openAuth('register');
    } else {
      let html = `<span class="who">${escapeHtml(this.me.nickname || this.me.username)}</span>`;
      html += `<button id="btnProfile">我的记录</button>`;
      if (this.isAdmin()) html += `<button id="btnAdmin" class="primary">管理后台</button>`;
      html += `<button id="btnLogout">退出</button>`;
      el.innerHTML = html;
      $('btnProfile').onclick = () => window.__showProfile && window.__showProfile();
      $('btnLogout').onclick = () => this.logout();
      if (this.isAdmin()) $('btnAdmin').onclick = () => window.__showAdmin && window.__showAdmin();
    }
  },
};

// 打开登录/注册弹窗
export function openAuth(mode = 'login') {
  const modal = $('authModal');
  if (!modal) return;
  modal.hidden = false;
  const title = $('authTitle');
  const loginForm = $('loginForm');
  const regForm = $('regForm');
  const switchTxt = $('authSwitch');
  if (mode === 'login') {
    title.textContent = '登录';
    loginForm.hidden = false; regForm.hidden = true;
    switchTxt.innerHTML = '还没有账号？<a href="#" id="toReg">去注册</a>';
  } else {
    title.textContent = '注册';
    loginForm.hidden = true; regForm.hidden = false;
    switchTxt.innerHTML = '已有账号？<a href="#" id="toLogin">去登录</a>';
  }
  const toReg = $('toReg'); if (toReg) toReg.onclick = (e) => { e.preventDefault(); openAuth('register'); };
  const toLogin = $('toLogin'); if (toLogin) toLogin.onclick = (e) => { e.preventDefault(); openAuth('login'); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 弹窗交互（模块脚本为 defer，执行时 DOM 已就绪）
(function bindAuthModal() {
  const modal = $('authModal');
  if (!modal) return;
  $('authClose').onclick = () => { modal.hidden = true; };
  $('loginSubmit').onclick = async () => {
    const u = $('loginUser').value.trim();
    const p = $('loginPass').value;
    $('loginErr').textContent = '';
    try { await Auth.login(u, p); modal.hidden = true; }
    catch (e) { $('loginErr').textContent = e.message; }
  };
  $('regSubmit').onclick = async () => {
    const u = $('regUser').value.trim();
    const p = $('regPass').value;
    const n = $('regNick').value.trim();
    $('regErr').textContent = '';
    try { await Auth.register(u, p, n); modal.hidden = true; }
    catch (e) { $('regErr').textContent = e.message; }
  };
})();
