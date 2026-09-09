// 前端账号模块：登录 / 注册 / 登出 / 上报战绩。
// 通过 Cookie 会话与同源后端通信，无需手动管理 token。
// 「记住账号密码」的存取在 js/remember.js（本地混淆存储，不是加密，见该文件顶部说明）。

import { Remember } from './remember.js';

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
    this._notify();
    return this.me;
  },

  // remember=true 时后端把会话 Cookie 拉长到 30 天（不勾也有默认 7 天）。
  async login(username, password, remember = false) {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember: !!remember }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '登录失败'); }
    this.me = await r.json();
    this.renderAuthArea();
    this._notify();
    return this.me;
  },

  async register(username, password, nickname, remember = false) {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname, remember: !!remember }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '注册失败'); }
    this.me = await r.json();
    this.renderAuthArea();
    this._notify();
    return this.me;
  },

  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    // 主动退出 = 这台机器不再被信任：抹掉本机存过的密码，用户名留着方便下次回填
    Remember.clear();
    const box = $('rememberMe');
    if (box) {
      box.checked = false;
      const wrap = box.closest('.remember'); if (wrap) wrap.classList.remove('on');
    }
    const passEl = $('loginPass'); if (passEl) passEl.value = '';   // 弹窗节点不销毁，别让旧密码留在框里
    this.me = null;
    this.renderAuthArea();
    this._notify();
  },

  // 结算后的积分直接采用服务端返回的那份，不再由客户端自己算（见 /api/match/report）
  applyScore(score) {
    if (!this.me || typeof score !== 'number') return;
    this.me.score = score;
    this.renderAuthArea();
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
      let html = `<span class="who">${escapeHtml(this.me.nickname || this.me.username)}`;
      html += ` <span class="score" title="积分">🏆 ${this.me.score || 0}</span></span>`;
      html += `<button id="btnProfile">我的记录</button>`;
      html += `<button id="btnFriends">好友<span id="friendBadge" class="fr-badge" hidden></span></button>`;
      if (this.isAdmin()) html += `<button id="btnAdmin" class="primary">管理后台</button>`;
      html += `<button id="btnLogout">退出</button>`;
      el.innerHTML = html;
      $('btnProfile').onclick = () => window.__showProfile && window.__showProfile();
      $('btnFriends').onclick = () => window.__showFriends && window.__showFriends();
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
    loginForm.classList.add('active');
    regForm.classList.remove('active');
    switchTxt.innerHTML = '还没有账号？<a href="#" id="toReg">去注册</a>';
  } else {
    title.textContent = '注册';
    loginForm.classList.remove('active');
    regForm.classList.add('active');
    switchTxt.innerHTML = '已有账号？<a href="#" id="toLogin">去登录</a>';
    renderStrength('');                 // 重置强度提示
    const p2 = $('regPass2'); if (p2) p2.value = '';  // 清空确认框
  }
  fillLoginFromRemember();          // 每次打开都按本机存过的凭据回填一次
  const toReg = $('toReg'); if (toReg) toReg.onclick = (e) => { e.preventDefault(); openAuth('register'); };
  const toLogin = $('toLogin'); if (toLogin) toLogin.onclick = (e) => { e.preventDefault(); openAuth('login'); };
}

// 用本机存过的凭据回填登录框：勾过「记住」就连密码一起填，否则只填用户名。
// 已经打了字就不覆盖，免得把她正在输入的内容冲掉。
function fillLoginFromRemember() {
  const user = $('loginUser');
  if (!user) return;
  const pass = $('loginPass');
  const box = $('rememberMe');
  const wrap = box && box.closest('.remember');
  const saved = Remember.load();
  if (saved) {
    if (!user.value) user.value = saved.username;
    if (pass && !pass.value) pass.value = saved.password;
    if (box) { box.checked = true; if (wrap) wrap.classList.add('on'); }
  } else {
    const name = Remember.loadUsername();
    if (name && !user.value) user.value = name;
    if (box) { box.checked = false; if (wrap) wrap.classList.remove('on'); }
  }
}

function toggleEye(btn) {
  const inputId = btn.dataset.eyeFor;
  const input = $(inputId);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '👁‍🗨';
  btn.classList.toggle('slash', !showing);
}

// 密码强度评分（0-4）
function scorePassword(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}

function renderStrength(pw) {
  const el = $('pwdStrength');
  if (!el) return;
  const s = scorePassword(pw);
  const labels = ['', '弱', '一般', '较强', '很强'];
  el.className = 'pwd-strength s' + s;
  el.innerHTML = `<span class="pwd-bars"><i></i><i></i><i></i><i></i></span><span class="label">${pw ? '密码强度：' + labels[s] : ''}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 弹窗交互（模块脚本为 defer，执行时 DOM 已就绪）
(function bindAuthModal() {
  const modal = $('authModal');
  if (!modal) return;
  $('authClose').onclick = () => { modal.hidden = true; };
  document.querySelectorAll('.eye').forEach((b) => { b.onclick = () => toggleEye(b); });

  // 回填上次登录的账号（勾过「记住账号密码」就连密码一起填）
  fillLoginFromRemember();

  // 取消勾选 = 当场抹掉本机存过的密码，不让它悄悄留着
  const rememberBox = $('rememberMe');
  if (rememberBox) {
    rememberBox.addEventListener('change', () => {
      const wrap = rememberBox.closest('.remember');
      if (wrap) wrap.classList.toggle('on', rememberBox.checked);
      if (!rememberBox.checked) {
        Remember.clear();
        const pass = $('loginPass'); if (pass) pass.value = '';
      }
    });
  }

  // 注册时实时显示密码强度
  const regPass = $('regPass');
  if (regPass) regPass.addEventListener('input', () => renderStrength(regPass.value));

  $('loginSubmit').onclick = async () => {
    const u = $('loginUser').value.trim();
    const p = $('loginPass').value;
    const box = $('rememberMe');
    const remember = !!(box && box.checked);
    $('loginErr').textContent = '';
    try {
      await Auth.login(u, p, remember);
      Remember.saveUsername(u);                       // 用户名一直记住（沿用旧行为）
      if (remember) Remember.save(u, p); else Remember.clear();
      modal.hidden = true;
    }
    catch (e) { $('loginErr').textContent = e.message; }
  };
  $('regSubmit').onclick = async () => {
    const u = $('regUser').value.trim();
    const p = $('regPass').value;
    const p2 = $('regPass2') ? $('regPass2').value : p;
    const n = $('regNick').value.trim();
    $('regErr').textContent = '';
    if (p.length < 6) { $('regErr').textContent = '密码至少 6 位'; return; }
    if (p !== p2) { $('regErr').textContent = '两次输入的密码不一致'; return; }
    try { await Auth.register(u, p, n); modal.hidden = true; }
    catch (e) { $('regErr').textContent = e.message; }
  };
})();
