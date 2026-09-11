// 统一的双人同步层：基于 PeerJS 的点对点连接。
// 本版本使用后端 4 位数字房间号映射真实 PeerID，避免公共 PeerJS 服务器上短 ID 冲突。
// 除了收发，本模块还负责两件事（Roadmap ②）：
//   1) 断线重连：连接掉了先试 PeerJS 自带的重连，再退化成「换 PeerID + 后端换座位」重新握手；
//   2) 消息日志 + 回放：把本局所有游戏消息按顺序记下来，重连后日志少的一方按对方的日志
//      重建棋局，两边才能接着打一局，而不是从头开房。
// 用法：
//   const net = new Net();
//   await net.host('昵称')                 创建房间，返回 4 位房间号
//   await net.join('0001','昵称','密码')    加入房间
//   net.send('type', { ... })              发送
//   net.on('type', (msg) => {})            接收，返回取消订阅函数
//   net.onStatus((type, payload) => {})    连接状态变化
//   net.onRebuild = (journal) => {}        重连后需要按日志重建对局时由上层实现
// 状态回调 type：waiting / connected / reconnecting / resyncing / resynced / closed / error / peername
// 属性：net.me(1房主/2加入者) net.myName net.peerName net.roomCode net.isHost net.ready
//       net.journal(本局消息日志) net.reconnecting

// 同步层自己的握手消息：收到就由 Net 内部消化，绝不上抛、不进日志。
const SYNC_TYPES = new Set(['hello', 'resync_request', 'resync', 'resync_done']);
// 房间控制消息：**不进日志、不参与回放**（回放时由上层重新挂载房间与对局），
// 但仍然要交给 app.js / 游戏注册的处理器 —— 它们不是同步层自己的消息。
const CONTROL_TYPES = new Set([
  'chat', 'start_game', 'room_set_game', 'room_settings', 'room_get_settings',
]);

// 重连节奏：约 30 秒内试 6 次，还不行就交给用户决定
const RECOVER_DELAYS = [800, 1600, 3000, 5000, 8000, 12000];
const MAX_JOURNAL = 4000;             // 单局日志上限，防病态膨胀

function peerOptions() {
  // 连接自建 PeerJS 信令服务器，与站点同源（自动适配 http/https）
  const secure = location.protocol === 'https:';
  return {
    host: location.hostname,
    port: secure ? 443 : (parseInt(location.port, 10) || (secure ? 443 : 80)),
    path: '/peerjs',
    secure,
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    },
  };
}

function timeout(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.me = null;
    this.myName = '我';
    this.myUsername = '';
    this.peerName = '对方';
    this.peerUsername = '';
    this._isHost = false;
    this._handlers = {};
    this._status = [];
    this.roomCode = '';
    this.roomSecret = '';      // 建房/加入时下发的座位凭据（重连换 PeerID 时要用）
    this.peerId = '';
    this.ready = false;
    this.journal = [];         // 本局游戏消息日志：{ type, data }，两端顺序一致
    this.reconnecting = false;
    this.onRebuild = null;     // (journal) => void，上层用它重建对局
    this._replay = false;
    this._inbox = [];
    this._waiters = [];
    this._attempt = 0;
    this._recoverTimer = null;
    this._destroyed = false;
    this._peerJournal = 0;
    this._peerLastType = '';
    this._synced = false;
  }

  // 房主：创建 Peer -> 后端注册 4 位房间号 -> 等待连接
  async host(name, username = '') {
    this._cleanup();
    this._isHost = true;
    this.myName = name || '房主';
    this.myUsername = username || '';
    this.peer = new Peer(undefined, peerOptions());

    // 等待 PeerJS open，最多 8 秒；超时报错让用户重试
    const peerId = await Promise.race([
      new Promise((resolve, reject) => {
        this.peer.on('open', (id) => resolve(id));
        this.peer.on('error', (e) => reject(e));
      }),
      timeout(8000, 'PeerJS 连接超时，请刷新重试'),
    ]);

    this.peerId = peerId;
    this.peer.on('connection', (c) => this._onIncoming(c));

    const r = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: this.peerId, hostName: this.myName }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '创建房间失败');
    this.roomCode = j.code;
    this.roomSecret = j.secret || '';
    this._emit('waiting', { code: j.code });
    return j.code;
  }

  // 加入者：查询房间 -> 校验密码 -> 获取真实 PeerID -> 连接
  async join(code, name, password = '', username = '') {
    this._cleanup();
    this._isHost = false;
    this.myName = name || '玩家';
    this.myUsername = username || '';
    this.roomCode = code;

    const r = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, name: this.myName }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '加入房间失败');
    this.peerId = j.peerId;
    this.roomSecret = j.secret || '';
    this.peerName = j.hostName || '房主';

    this.peer = new Peer(undefined, peerOptions());

    await Promise.race([
      new Promise((resolve, reject) => {
        this.peer.on('open', () => resolve());
        this.peer.on('error', (e) => reject(e));
      }),
      timeout(8000, 'PeerJS 连接超时，请刷新重试'),
    ]);
    // 重连时房主要反过来打给我，所以自己也得听连接
    this.peer.on('connection', (c) => this._onIncoming(c));

    const c = this.peer.connect(this.peerId);
    return new Promise((resolve, reject) => {
      const fail = (err) => reject(err);
      this.peer.on('error', (e) => { if (e && e.type !== 'peer-unavailable') fail(e); });
      this._setup(c, resolve, fail);
    });
  }

  // 仅查询房间是否需要密码（用于 UI 提前提示）
  static async peekRoom(code) {
    const r = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '房间不存在');
    return j;
  }

  get isHost() { return this._isHost; }

  // ---------- 连接建立 ----------

  // 主动连接与被动连接都走这里；already 有可用连接时把多余的关掉，避免两边同时 call 打架
  _onIncoming(c) {
    if (this.conn && this.conn.open && this.conn !== c) {
      try { c.close(); } catch { /* 忽略 */ }
      return;
    }
    this._setup(c);
  }

  _setup(c, onOpen, onFail) {
    this.conn = c;
    let called = false;
    const open = () => {
      if (called) return;
      called = true;
      this.reconnecting = false;
      this._recovering = false;
      this._stopRecoveryTimer();
      this.me = this._isHost ? 1 : 2;
      this.ready = true;
      this._synced = false;
      this._peerJournal = 0;
      this._peerLastType = '';
      this.send('hello', {
        name: this.myName, username: this.myUsername,
        journal: this.journal.length, last: this._lastJournalType(),
      });
      this._emit('connected', { reconnected: this._wasRecovering === true });
      this._wasRecovering = false;
      this._drainWaiters(c);
      if (onOpen) onOpen();
    };
    if (c.open) open(); else c.on('open', open);
    c.on('data', (m) => this._onData(m));
    c.on('close', () => this._onConnLost('close'));
    c.on('error', (e) => {
      this._emit('error', e);
      if (onFail && !called) onFail(e);
    });
  }

  // 连接断了：能抢救就抢救，救不回来才告诉上层「关闭」
  _onConnLost(reason) {
    this.ready = false;
    if (this._destroyed) { this._emit('closed', { reason: 'left' }); return; }
    if (!this.roomCode || this._recovering) {
      if (!this._recovering) this._emit('closed', { reason });
      return;
    }
    this._recovering = true;
    this.reconnecting = true;
    this._attempt = 0;
    this._scheduleRecovery(reason);
  }

  _scheduleRecovery(reason) {
    const delay = RECOVER_DELAYS[this._attempt] || 5000;
    this._recoverTimer = setTimeout(() => this._tryRecover(reason), this._attempt === 0 ? 200 : delay);
  }

  async _tryRecover(reason) {
    if (this._destroyed || !this._recovering) return;
    this._attempt += 1;
    this._emit('reconnecting', { attempt: this._attempt, reason });
    if (this._attempt > RECOVER_DELAYS.length) {
      this._recovering = false;
      this.reconnecting = false;
      this._emit('closed', { reason: 'gave-up' });
      return;
    }
    try {
      this._wasRecovering = true;
      if (this._attempt === 1) await this._softRecover();      // 先试 PeerJS 自带的恢复，代价最小
      if (!this.ready) await this._rehandshake();              // 不行就换 PeerID 重新握手
      if (!this.ready) throw new Error('连接尚未建立');
      // ready 由 _setup 的 open 回调置位，日志同步在那之后自动发生
    } catch (e) {
      if (e && e.code === 'room-gone') {
        this._recovering = false;
        this.reconnecting = false;
        this._emit('closed', { reason: 'room-gone', message: e.message });
        return;
      }
      this._lastError = e && e.message ? e.message : String(e);
      this._scheduleRecovery(this._lastError);
    }
  }

  // 轻量恢复：信令断开但 PeerID 还在 -> peer.reconnect()；只有 DataConnection 断了 -> conn.reconnect()
  async _softRecover() {
    const p = this.peer;
    const c = this.conn;
    if (!p || p.destroyed || !c) throw new Error('需要重新握手');
    if (p.disconnected && typeof p.reconnect === 'function') { try { p.reconnect(); } catch { /* 忽略 */ } }
    if (!c.open && typeof c.reconnect === 'function') { try { c.reconnect(); } catch { /* 忽略 */ } }
    await this._waitReady(4000);
    if (!this.ready) throw new Error('需要重新握手');
  }

  // 重量恢复：换新 PeerID -> 用座位凭据登记自己 -> 取对方的 PeerID -> 双向尝试建立连接
  async _rehandshake() {
    this._teardownConn();
    this.peer = new Peer(undefined, peerOptions());
    const peerId = await Promise.race([
      new Promise((resolve, reject) => {
        this.peer.on('open', (id) => resolve(id));
        this.peer.on('error', (e) => { if (!e || e.type !== 'peer-unavailable') reject(e); });
      }),
      timeout(8000, 'PeerJS 连接超时'),
    ]);
    this.peerId = peerId;
    this.peer.on('connection', (c) => this._onIncoming(c));
    const role = this._isHost ? 'host' : 'guest';

    const seatRes = await fetch(`/api/rooms/${encodeURIComponent(this.roomCode)}/seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, peerId, secret: this.roomSecret }),
    });
    if (seatRes.status === 404) {
      throw Object.assign(new Error('房间已关闭'), { code: 'room-gone' });
    }
    if (!seatRes.ok) {
      const j = await seatRes.json().catch(() => ({}));
      throw new Error(j.error || '登记座位失败');
    }
    const peersRes = await fetch(
      `/api/rooms/${encodeURIComponent(this.roomCode)}/peers?role=${role}&secret=${encodeURIComponent(this.roomSecret)}`,
    );
    if (!peersRes.ok) throw new Error('读取房间成员失败');
    const peers = await peersRes.json();
    const otherId = this._isHost ? peers.guestPeerId : peers.hostPeerId;

    const waitMs = this._isHost ? 6000 : 4500;
    const incoming = this._waitForConnection(waitMs);
    if (otherId && otherId !== peerId) {
      try { this._setup(this.peer.connect(otherId)); } catch { /* 等对方打过来 */ }
    }
    const conn = await incoming;
    if (!conn) throw new Error('对方还没连上');
    await this._waitReady(4000);
    if (!this.ready) throw new Error('连接尚未就绪');
  }

  // PeerJS 的 open 是异步事件，重连时轮询等一下，别拿瞬时状态判断成败
  _waitReady(ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this.ready || Date.now() - started > ms) { resolve(); return; }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  _lastJournalType() {
    return this.journal.length ? this.journal[this.journal.length - 1].type : '';
  }

  // 手动「立即重试」/「取消」（重连遮罩上的按钮用）
  retryReconnect() {
    if (this._destroyed) return;
    if (!this._recovering) {
      this._recovering = true;
      this.reconnecting = true;
      this._attempt = 0;
    }
    this._stopRecoveryTimer();
    this._tryRecover('manual');
  }

  cancelReconnect() {
    this._recovering = false;
    this.reconnecting = false;
    this._stopRecoveryTimer();
    this._emit('closed', { reason: 'cancelled' });
  }

  _stopRecoveryTimer() {
    if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
  }

  _waitForConnection(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (c) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._waiters = this._waiters.filter((f) => f !== finish);
        resolve(c);
      };
      const timer = setTimeout(() => finish(null), ms);
      this._waiters.push(finish);
    });
  }

  _drainWaiters(c) {
    const list = this._waiters.slice();
    this._waiters = [];
    list.forEach((f) => f(c));
  }

  // ---------- 消息收发与日志回放 ----------

  _onData(m) {
    if (!m || !m.type) return;
    if (this._replay) { this._inbox.push(m); return; }   // 回放期间先缓存，别打乱顺序
    if (SYNC_TYPES.has(m.type)) { this._onControl(m); return; }
    if (!CONTROL_TYPES.has(m.type)) this._journal({ type: m.type, data: m });
    this._deliver(m);
  }

  _deliver(m) {
    if (!m || !m.type) return;
    if (m.type === 'hello') { this._onControl(m); return; }
    (this._handlers[m.type] || []).forEach((h) => h(m));
  }

  // 只处理同步层自己的握手；其余消息一律走 _deliver 上抛给上层（历史上这些类型被这里
  // 整段吞掉过，表现是「访客收不到房主选的游戏和开始游戏、悄悄话也不显示」）。
  _onControl(m) {
    if (m.type === 'hello') {
      this.peerName = m.name || '对方';
      this.peerUsername = m.username || '';
      this._peerJournal = Number(m.journal) || 0;
      this._peerLastType = String(m.last || '');
      this._emit('peername', this.peerName);
      this._maybeResync();
      return;
    }
    if (m.type === 'resync_request') {
      this.send('resync', { entries: this.journal });
      return;
    }
    if (m.type === 'resync') {
      this._applyResync(m.entries);
      return;
    }
    if (m.type === 'resync_done') {
      this._emit('resynced', { host: true, entries: this.journal.length });
    }
  }

  // 谁的日志长谁当权威：少的那方按权威的日志重建（长度相同则由房主保持原样，不用动）
  _maybeResync() {
    if (this._synced) return;
    const mine = this.journal.length;
    const theirs = this._peerJournal;
    const same = theirs === mine && this._peerLastType === this._lastJournalType();
    this._synced = true;
    if (same) return;                        // 两边日志一致，什么都不用做
    if (theirs > mine || (theirs === mine && !this._isHost)) {
      if (theirs === 0) return;              // 对方也是空的，无需回放
      this.send('resync_request', {});
    } else {
      this._emit('resynced', { host: true, entries: mine });   // 我是权威，等对方来要
    }
  }

  _applyResync(entries) {
    const list = Array.isArray(entries) ? entries.slice(0, MAX_JOURNAL) : [];
    this._synced = true;
    if (!list.length) { this.send('resync_done', { entries: 0 }); this._emit('resynced', { entries: 0 }); return; }
    this._emit('resyncing', { entries: list.length });
    this.journal = list.map((e) => ({ type: e.type, data: e.data || {} }));
    if (typeof this.onRebuild === 'function') {
      try { this.onRebuild(this.journal); } catch { /* 重建失败就走下面的兜底回放 */ }
    }
    this.replayJournal();
    this.send('resync_done', { entries: this.journal.length });
    this._emit('resynced', { entries: this.journal.length });
  }

  // 把日志按顺序当成「收到的消息」灌回当前对局（send 只记不发，回放完再补发）
  replayJournal() {
    const total = this.journal.length;
    this._replay = true;
    for (let i = 0; i < total; i += 1) this._deliver(this.journal[i].data);
    this._replay = false;
    const inbox = this._inbox.splice(0);
    inbox.forEach((m) => this._onData(m));
  }

  _journal(entry) {
    this.journal.push(entry);
    if (this.journal.length > MAX_JOURNAL) this.journal.splice(0, this.journal.length - MAX_JOURNAL);
  }

  // 新的一局开始，日志从空记起（两端都要调）
  resetJournal() {
    this.journal = [];
    this._peerJournal = 0;
    this._peerLastType = '';
    this._synced = false;
    this._inbox = [];
  }

  send(type, data = {}) {
    const message = { type, ...data };
    if (!CONTROL_TYPES.has(type)) this._journal({ type, data: message });
    if (this._replay) return;              // 回放期间的发送只进日志，不发到线上
    if (this.conn && this.conn.open) this.conn.send(message);
  }

  on(type, cb) {
    (this._handlers[type] = this._handlers[type] || []).push(cb);
    return () => { this._handlers[type] = (this._handlers[type] || []).filter((h) => h !== cb); };
  }

  onStatus(cb) {
    this._status.push(cb);
    return () => { this._status = this._status.filter((h) => h !== cb); };
  }

  _emit(type, payload) {
    this._status.forEach((h) => h(type, payload));
  }

  // 只拆连接，保留处理器 / 日志 / 房间信息（重连要用）
  _teardownConn() {
    this.ready = false;
    if (this.conn) { try { this.conn.close(); } catch { /* 忽略 */ } this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch { /* 忽略 */ } this.peer = null; }
  }

  // 注意：**不要在这里清 _status / _handlers**。host() 和 join() 开头都会调 _cleanup()，
  // 而上层的状态回调（bindNetEvents -> onStatus）是在拿到 Net 实例时一次性绑定的，
  // 一清就没 —— 表现就是「访客连进来了，房主界面毫无反应，永远停在等待对方加入…」。
  // 真正要连带监听器一起丢的是 destroy()：对象从此作废，由 showLobby() 换成新实例。
  _cleanup() {
    this._destroyed = false;
    this._recovering = false;
    this.reconnecting = false;
    this._stopRecoveryTimer();
    this._teardownConn();
    this.me = null;
    this._waiters = [];
    this.roomCode = '';
    this.roomSecret = '';
    this.peerId = '';
    this.peerName = '对方';
    this.resetJournal();
  }

  destroy() {
    this._cleanup();
    this._destroyed = true;      // _cleanup() 会把它复位（host/join 复用同一实例），所以要在后面再立一次
    this._handlers = {};
    this._status = [];
  }
}