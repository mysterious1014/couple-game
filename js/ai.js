// 人机对战模块。
// AINet 实现了与 Net 相同的接口（me / send / on / isAI / peerName / myName / ready），
// 但把所有消息路由到本地的「AI 大脑」，无需 PeerJS 连接。
// 目前支持：五子棋（gomoku）、你画我猜（draw）。

const DIFF_LABEL = { easy: '轻松', medium: '普通', hard: '困难' };

// ---------------------------------------------------------------------------
// AINet：对游戏而言就是一个「虚拟对手」
// ---------------------------------------------------------------------------
export class AINet {
  constructor(difficulty = 'medium') {
    this.me = 1;                 // 人类始终是 1 号（先手）
    this.myName = '我';
    this.peerName = '电脑·' + (DIFF_LABEL[difficulty] || '普通');
    this.isAI = true;
    this.isHost = true;
    this.ready = true;
    this.roomCode = 'AI';
    this.handlers = {};
    this._difficulty = difficulty;
    this._brain = null;
  }

  // 进入具体游戏时再创建对应大脑（不同游戏逻辑不同）
  beginGame(gameId) {
    if (this._brain && this._brain.destroy) this._brain.destroy();
    this._brain = createBrain(gameId, this._difficulty, this);
  }

  send(type, data = {}) {
    if (type === 'chat') { this._chatReply(data.text); return; }
    if (this._brain && this._brain.onHuman) this._brain.onHuman(type, data);
  }

  on(type, cb) {
    (this.handlers[type] = this.handlers[type] || []).push(cb);
    return () => { this.handlers[type] = (this.handlers[type] || []).filter((h) => h !== cb); };
  }

  _emit(type, data = {}) {
    (this.handlers[type] || []).forEach((h) => h(data));
  }

  // 由游戏在挂载后调用，让 AI 开始行动（如你画我猜先画第一幅）
  aiStart() { if (this._brain && this._brain.start) this._brain.start(); }
  aiNext() { if (this._brain && this._brain.next) this._brain.next(); }

  destroy() {
    if (this._brain && this._brain.destroy) this._brain.destroy();
    this.handlers = {};
  }

  _chatReply(text) {
    const replies = [
      '这步我看好你～', '加油，别让我赢太轻松😏', '要不换个游戏？',
      '嘿嘿，我也在想这步', '你今天手感不错嘛', '稳住，我们能赢',
    ];
    const t = setTimeout(() => {
      this._emit('chat', { name: this.peerName, text: replies[Math.floor(Math.random() * replies.length)] });
    }, 600 + Math.random() * 600);
    this._timers = this._timers || [];
    this._timers.push(t);
  }
}

function createBrain(gameId, difficulty, net) {
  if (gameId === 'gomoku') return new GomokuBrain(net, difficulty);
  if (gameId === 'draw') return new DrawBrain(net, difficulty);
  return null;
}

// ===========================================================================
// 五子棋 AI
// ===========================================================================
const GS = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function inB(r, c) { return r >= 0 && r < GS && c >= 0 && c < GS; }
function emptyBoard() { return Array.from({ length: GS }, () => new Array(GS).fill(0)); }

function shapeScore(count, openEnds) {
  if (count >= 5) return 100000;
  if (count === 4) return openEnds === 2 ? 10000 : openEnds === 1 ? 1200 : 0;
  if (count === 3) return openEnds === 2 ? 1000 : openEnds === 1 ? 120 : 0;
  if (count === 2) return openEnds === 2 ? 120 : openEnds === 1 ? 18 : 0;
  if (count === 1) return openEnds === 2 ? 12 : openEnds === 1 ? 2 : 0;
  return 0;
}

function lineCount(board, r, c, p) {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let open = 0;
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc) && board[nr][nc] === p) { count++; nr += dr; nc += dc; }
    if (inB(nr, nc) && board[nr][nc] === 0) open++;
    nr = r - dr; nc = c - dc;
    while (inB(nr, nc) && board[nr][nc] === p) { count++; nr -= dr; nc -= dc; }
    if (inB(nr, nc) && board[nr][nc] === 0) open++;
    total += shapeScore(count, open);
  }
  return total;
}

function makesFive(board, r, c, p) {
  board[r][c] = p;
  let win = false;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc) && board[nr][nc] === p) { count++; nr += dr; nc += dc; }
    nr = r - dr; nc = c - dc;
    while (inB(nr, nc) && board[nr][nc] === p) { count++; nr -= dr; nc -= dc; }
    if (count >= 5) { win = true; break; }
  }
  board[r][c] = 0;
  return win;
}

function findImmediate(board, p) {
  for (let r = 0; r < GS; r++)
    for (let c = 0; c < GS; c++)
      if (board[r][c] === 0 && makesFive(board, r, c, p)) return { r, c };
  return null;
}

function near(board, r, c) {
  for (let dr = -2; dr <= 2; dr++)
    for (let dc = -2; dc <= 2; dc++) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc) && board[nr][nc] !== 0) return true;
    }
  return false;
}

function randomMove(board) {
  const empties = [];
  for (let r = 0; r < GS; r++)
    for (let c = 0; c < GS; c++)
      if (board[r][c] === 0) empties.push({ r, c });
  if (!empties.length) return null;
  return empties[Math.floor(Math.random() * empties.length)];
}

function heuristicMove(board, ai) {
  const human = 3 - ai;
  let best = null, bestScore = -1;
  for (let r = 0; r < GS; r++) {
    for (let c = 0; c < GS; c++) {
      if (board[r][c] !== 0 || !near(board, r, c)) continue;
      const off = lineCount(board, r, c, ai);
      const def = lineCount(board, r, c, human);
      let s = off * 1.0 + def * 0.9;
      s += (7 - Math.abs(r - 7)) + (7 - Math.abs(c - 7)); // 轻微中心偏好
      if (s > bestScore) { bestScore = s; best = { r, c }; }
    }
  }
  return best || randomMove(board);
}

function chooseMove(board, ai, diff) {
  const human = 3 - ai;
  const win = findImmediate(board, ai);
  if (win && (diff !== 'easy' || Math.random() < 0.85)) return win;
  const block = findImmediate(board, human);
  if (block) {
    if (diff === 'hard' || diff === 'medium') return block;
    if (diff === 'easy' && Math.random() < 0.6) return block;
  }
  if (diff === 'easy' && Math.random() < 0.55) return randomMove(board);
  if (diff === 'medium' && Math.random() < 0.25) return randomMove(board);
  return heuristicMove(board, ai);
}

class GomokuBrain {
  constructor(net, diff) { this.net = net; this.diff = diff; this.board = emptyBoard(); this.timer = null; }
  onHuman(type, data) {
    if (type === 'go_move') {
      if (this.board[data.r] && this.board[data.r][data.c] === 0) this.board[data.r][data.c] = 1;
      this._schedule();
    } else if (type === 'go_restart') {
      this.board = emptyBoard();
    }
  }
  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._move(), 320 + Math.random() * 420);
  }
  _move() {
    const mv = chooseMove(this.board, 2, this.diff);
    if (!mv) return;
    this.board[mv.r][mv.c] = 2;
    this.net._emit('go_move', { r: mv.r, c: mv.c, by: 2 });
  }
  destroy() { clearTimeout(this.timer); }
}

// ===========================================================================
// 你画我猜 AI（AI 当画手，人类猜词）
// ===========================================================================
function P(x, y) { return { x, y }; }
function segLine(x1, y1, x2, y2, n = 14) {
  const a = [];
  for (let i = 0; i <= n; i++) a.push(P(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n));
  return a;
}
function circleStroke(cx, cy, r, seg = 28) {
  const a = [];
  for (let i = 0; i <= seg; i++) {
    const t = (Math.PI * 2 * i) / seg;
    a.push(P(cx + r * Math.cos(t), cy + r * Math.sin(t)));
  }
  return a;
}
function polyStroke(pts, close = true) {
  const a = [];
  const n = pts.length;
  for (let i = 0; i <= n; i++) a.push(pts[i % n]);
  if (!close) a.pop();
  return a;
}
function starStroke(cx, cy, R, r, points = 5) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const ang = (Math.PI / points) * i - Math.PI / 2;
    pts.push(P(cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)));
  }
  return polyStroke(pts);
}
function heartStroke(cx, cy, s) {
  const a = [];
  for (let i = 0; i <= 40; i++) {
    const t = Math.PI * 2 * i / 40;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    a.push(P(cx + (x / 16) * s, cy - (y / 16) * s));
  }
  return a;
}
function crescentStroke(cx, cy, r) {
  const a = [];
  // 外弧（左半圆）
  for (let i = 0; i <= 20; i++) {
    const t = Math.PI * 0.5 + (Math.PI * i) / 20;
    a.push(P(cx + r * Math.cos(t), cy + r * Math.sin(t)));
  }
  // 内弧返回
  for (let i = 20; i >= 0; i--) {
    const t = Math.PI * 0.5 + (Math.PI * i) / 20;
    a.push(P(cx + r * 0.55 * Math.cos(t), cy + r * 0.55 * Math.sin(t)));
  }
  return a;
}

const WORD_LIB = [
  { word: '太阳', cat: '天体', strokes: [circleStroke(0.5, 0.5, 0.13), ...[0, 45, 90, 135, 180, 225, 270, 315].map((d) => segLine(0.5 + 0.16 * Math.cos(d * Math.PI / 180), 0.5 + 0.16 * Math.sin(d * Math.PI / 180), 0.5 + 0.27 * Math.cos(d * Math.PI / 180), 0.5 + 0.27 * Math.sin(d * Math.PI / 180), 5))] },
  { word: '月亮', cat: '天体', strokes: [crescentStroke(0.5, 0.5, 0.2)] },
  { word: '星星', cat: '形状', strokes: [starStroke(0.5, 0.5, 0.2, 0.09)] },
  { word: '心', cat: '符号', strokes: [heartStroke(0.5, 0.52, 0.2)] },
  { word: '房子', cat: '建筑', strokes: [polyStroke([P(0.32, 0.5), P(0.32, 0.86), P(0.68, 0.86), P(0.68, 0.5)]), polyStroke([P(0.28, 0.52), P(0.5, 0.32), P(0.72, 0.52)]), polyStroke([P(0.45, 0.66), P(0.45, 0.86), P(0.55, 0.86), P(0.55, 0.66)])] },
  { word: '树', cat: '植物', strokes: [segLine(0.5, 0.55, 0.5, 0.88, 8), circleStroke(0.5, 0.45, 0.17)] },
  { word: '花', cat: '植物', strokes: [circleStroke(0.5, 0.5, 0.05), ...[0, 72, 144, 216, 288].map((d) => circleStroke(0.5 + 0.13 * Math.cos(d * Math.PI / 180), 0.5 + 0.13 * Math.sin(d * Math.PI / 180), 0.05, 16)), segLine(0.5, 0.55, 0.5, 0.9, 8)] },
  { word: '鱼', cat: '动物', strokes: [circleStroke(0.44, 0.5, 0.17), polyStroke([P(0.6, 0.5), P(0.74, 0.38), P(0.74, 0.62)]), circleStroke(0.38, 0.45, 0.02, 8)] },
  { word: '苹果', cat: '食物', strokes: [circleStroke(0.5, 0.56, 0.16), segLine(0.5, 0.4, 0.5, 0.32, 4), segLine(0.5, 0.36, 0.58, 0.3, 4)] },
  { word: '雨伞', cat: '物品', strokes: [(() => { const a = []; for (let i = 0; i <= 16; i++) { const t = Math.PI * i / 16; a.push(P(0.3 + 0.4 * Math.sin(t), 0.5 - 0.2 * Math.cos(t))); } return a; })(), segLine(0.5, 0.5, 0.5, 0.85, 10), segLine(0.5, 0.5, 0.36, 0.66, 5), segLine(0.5, 0.5, 0.64, 0.66, 5)] },
];

const WRONG_REPLIES = ['不对哦，再想想～', '差一点！', '嗯…不是这个', '再猜猜看嘛', '提示一下，别急😉'];

class DrawBrain {
  constructor(net, diff) {
    this.net = net; this.diff = diff;
    this.word = ''; this.cat = ''; this.strokes = null;
    this.wrong = 0; this.timer = null; this.drawing = false;
  }
  start() { this._next(); }
  _next() {
    clearTimeout(this.timer);
    const w = WORD_LIB[Math.floor(Math.random() * WORD_LIB.length)];
    this.word = w.word; this.cat = w.cat; this.strokes = w.strokes; this.wrong = 0;
    this.net._emit('dw_clear', {});
    if (this.diff === 'easy') this.net._emit('dw_hint', { text: '提示：' + this.cat });
    this._draw();
  }
  _draw() {
    const items = [];
    for (const s of this.strokes) for (let i = 0; i < s.length - 1; i++) items.push({ from: s[i], to: s[i + 1] });
    const color = this.diff === 'hard' ? '#3a3a3a' : '#2b6cb0';
    let i = 0;
    const step = () => {
      if (i >= items.length) { this.drawing = false; return; }
      const it = items[i++];
      this.net._emit('dw_draw', { from: it.from, to: it.to, color });
      this.timer = setTimeout(step, 16);
    };
    step();
  }
  onHuman(type, data) {
    if (type !== 'dw_guess') return;
    const g = (data.text || '').trim();
    if (!g) return;
    if (this._match(g, this.word)) {
      this.net._emit('dw_correct', { winner: 1 });
    } else {
      this.wrong++;
      if (this.diff !== 'hard' && this.wrong >= 3) this.net._emit('dw_hint', { text: '提示：' + this.cat });
      else if (this.diff === 'hard' && this.wrong >= 6) this.net._emit('dw_hint', { text: '首字提示：' + this.word[0] });
      this.net._emit('dw_ai_say', { text: WRONG_REPLIES[Math.floor(Math.random() * WRONG_REPLIES.length)] });
    }
  }
  _match(g, w) { return g === w || w.includes(g) || g.includes(w); }
  destroy() { clearTimeout(this.timer); }
}
