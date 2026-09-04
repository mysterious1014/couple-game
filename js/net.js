// 统一的双人同步层：基于 PeerJS 的点对点连接。
// 本版本使用后端 4 位数字房间号映射真实 PeerID，避免公共 PeerJS 服务器上短 ID 冲突。
// 用法：
//   const net = new Net();
//   await net.host('昵称')                 创建房间，返回 4 位房间号
//   await net.join('0001','昵称','密码')    加入房间
//   net.send('type', { ... })              发送
//   net.on('type', (msg) => {})            接收，返回取消订阅函数
//   net.onStatus((type, payload) => {})    连接状态变化
// 属性：net.me(1房主/2加入者) net.myName net.peerName net.roomCode net.isHost net.ready

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.me = null;
    this.myName = '我';
    this.peerName = '对方';
    this._isHost = false;
    this._handlers = {};
    this._status = [];
    this.roomCode = '';
    this.peerId = '';
    this.ready = false;
  }

  // 房主：创建 Peer -> 后端注册 4 位房间号 -> 等待连接
  host(name) {
    this._cleanup();
    this._isHost = true;
    this.myName = name || '房主';
    this.peer = new Peer();
    return new Promise((resolve, reject) => {
      let rejected = false;
      const fail = (err) => { if (!rejected) { rejected = true; reject(err); } };
      this.peer.on('open', async () => {
        this.peerId = this.peer.id;
        try {
          const r = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peerId: this.peerId, hostName: this.myName }),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || '创建房间失败');
          this.roomCode = j.code;
          this._emit('waiting', { code: j.code });
          resolve(j.code);
        } catch (e) { fail(e); }
      });
      this.peer.on('connection', (c) => this._setup(c));
      this.peer.on('error', (e) => fail(e));
    });
  }

  // 加入者：查询房间 -> 校验密码 -> 获取真实 PeerID -> 连接
  async join(code, name, password = '') {
    this._cleanup();
    this._isHost = false;
    this.myName = name || '玩家';
    this.roomCode = code;

    const r = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '加入房间失败');
    this.peerId = j.peerId;
    this.peerName = j.hostName || '房主';

    this.peer = new Peer();
    return new Promise((resolve, reject) => {
      let rejected = false;
      const fail = (err) => { if (!rejected) { rejected = true; reject(err); } };
      this.peer.on('open', () => {
        const c = this.peer.connect(this.peerId);
        this._setup(c, resolve, fail);
      });
      this.peer.on('error', (e) => fail(e));
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

  _setup(c, onOpen, onFail) {
    this.conn = c;
    let called = false;
    const open = () => {
      if (called) return;
      called = true;
      this.me = this._isHost ? 1 : 2;
      this.ready = true;
      this.send('hello', { name: this.myName });
      this._emit('connected');
      if (onOpen) onOpen();
    };
    if (c.open) open(); else c.on('open', open);
    c.on('data', (m) => this._onData(m));
    c.on('close', () => { this.ready = false; this._emit('closed'); });
    c.on('error', (e) => { this._emit('error', e); if (onFail) onFail(e); });
  }

  _onData(m) {
    if (!m || !m.type) return;
    if (m.type === 'hello') {
      this.peerName = m.name || '对方';
      this._emit('peername', this.peerName);
      return;
    }
    (this._handlers[m.type] || []).forEach((h) => h(m));
  }

  send(type, data = {}) {
    if (this.conn && this.conn.open) this.conn.send({ type, ...data });
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

  _cleanup() {
    this.ready = false;
    if (this.conn) { this.conn.close(); this.conn = null; }
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.me = null;
    this._handlers = {};
    this._status = [];
    this.roomCode = '';
    this.peerId = '';
    this.peerName = '对方';
  }

  destroy() {
    this._cleanup();
  }
}
