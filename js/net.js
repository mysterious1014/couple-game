// 统一的双人同步层：基于 PeerJS 的点对点连接。
// 用法：
//   const net = new Net();
//   net.host('昵称') / net.join('房间号','昵称')
//   net.send('type', { ... })        发送
//   net.on('type', (msg) => {})      接收，返回取消订阅函数
//   net.onStatus((type, payload) => {})  连接状态变化
// 属性：net.me(1房主/2加入者) net.myName net.peerName net.roomCode

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
  }

  host(name) {
    this._isHost = true;
    this.myName = name || '红方';
    this.peer = new Peer();
    this.peer.on('open', () => this._emit('waiting'));
    this.peer.on('connection', (c) => this._setup(c));
    this.peer.on('error', (e) => this._emit('error', e));
  }

  join(code, name) {
    this._isHost = false;
    this.myName = name || '黄方';
    this.peer = new Peer();
    this.peer.on('open', () => {
      const c = this.peer.connect(code);
      this._setup(c);
    });
    this.peer.on('error', (e) => this._emit('error', e));
  }

  get roomCode() { return this.peer ? this.peer.id : ''; }
  get isHost() { return this._isHost; }

  _setup(c) {
    this.conn = c;
    const open = () => {
      this.me = this._isHost ? 1 : 2;
      this.send('hello', { name: this.myName });
      this._emit('connected');
    };
    if (c.open) open(); else c.on('open', open);
    c.on('data', (m) => this._onData(m));
    c.on('close', () => this._emit('closed'));
    c.on('error', (e) => this._emit('error', e));
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
    return () => {
      this._handlers[type] = (this._handlers[type] || []).filter((h) => h !== cb);
    };
  }

  onStatus(cb) {
    this._status.push(cb);
    return () => { this._status = this._status.filter((h) => h !== cb); };
  }

  _emit(type, payload) {
    this._status.forEach((h) => h(type, payload));
  }
}
