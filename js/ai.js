// 人机对战模块。
// AINet 实现了与 Net 相同的接口（me / send / on / isAI / peerName / myName / ready），
// 但把所有消息路由到本地的「AI 大脑」，无需 PeerJS 连接。
// 目前支持：五子棋（gomoku）、你画我猜（draw）、黑白棋（reversi）、点格棋（dots）、记忆翻牌（memory）、
// 海龟汤（turtle）、吹牛（liars）、UNO（uno）。

import { RevLogic } from './games/reversi.js';
import { DotsLogic } from './games/dots.js';
import { TurtleLogic } from './games/turtle.js';
import { UnoLogic } from './games/uno.js';
import { LiarsLogic, truthProb } from './games/liarsdice.js';

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

// ===========================================================================
// 黑白棋 AI
// ===========================================================================
const REV_INIT = (b) => {
  b[3][3] = 2; b[3][4] = 1; b[4][3] = 1; b[4][4] = 2;
};

class ReversiBrain {
  constructor(net, diff) {
    this.net = net; this.diff = diff;
    this.board = Array.from({ length: 8 }, () => new Array(8).fill(0));
    REV_INIT(this.board);
    this.current = 1; this.over = false; this.timer = null;
  }
  onHuman(type, data) {
    if (type === 'rev_move') {
      RevLogic.applyAt(this.board, data.r, data.c, data.by);
      this._advance(data.by);
      if (!this.over && this.current === 2) this._schedule();
    } else if (type === 'rev_restart') {
      this.board = Array.from({ length: 8 }, () => new Array(8).fill(0));
      REV_INIT(this.board); this.current = 1; this.over = false;
    }
  }
  _advance(mover) {
    const opp = 3 - mover;
    if (RevLogic.legalMoves(this.board, opp).length) this.current = opp;
    else if (RevLogic.legalMoves(this.board, mover).length) { /* mover 继续 */ }
    else this.over = true;
  }
  _schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this._move(), 350 + Math.random() * 350); }
  _move() {
    const mv = this._choose();
    if (!mv) {
      if (RevLogic.legalMoves(this.board, 1).length) this.current = 1; else this.over = true;
      return;
    }
    RevLogic.applyAt(this.board, mv.r, mv.c, 2);
    this.net._emit('rev_move', { r: mv.r, c: mv.c, by: 2 });
    this._advance(2);
    if (!this.over && this.current === 2) this._schedule();
  }
  _choose() {
    const moves = RevLogic.legalMoves(this.board, 2);
    if (!moves.length) return null;
    if (this.diff === 'easy' && Math.random() < 0.8) return moves[Math.floor(Math.random() * moves.length)];
    let best = null, bestS = -1e9;
    for (const m of moves) {
      const b2 = this.board.map((r) => r.slice());
      RevLogic.applyAt(b2, m.r, m.c, 2);
      const opMob = RevLogic.legalMoves(b2, 1).length;
      const myMob = RevLogic.legalMoves(b2, 2).length;
      let s = RevLogic.W[m.r][m.c];
      if (this.diff === 'hard') s -= 2 * opMob + 0.5 * myMob;
      else if (this.diff === 'medium') s -= opMob;
      s += Math.random() * 2;
      if (s > bestS) { bestS = s; best = m; }
    }
    return best;
  }
  destroy() { clearTimeout(this.timer); }
}

// ===========================================================================
// 点格棋 AI
// ===========================================================================
class DotsBrain {
  constructor(net, diff) {
    this.net = net; this.diff = diff;
    const s = DotsLogic.emptyLines(); this.H = s.H; this.V = s.V; this.boxes = s.boxes;
    this.current = 1; this.over = false; this.timer = null;
  }
  onHuman(type, data) {
    if (type === 'dots_line') {
      this._take(data.orient, data.r, data.c, data.by);
      if (!this.over && this.current === 2) this._schedule();
    } else if (type === 'dots_restart') {
      const s = DotsLogic.emptyLines(); this.H = s.H; this.V = s.V; this.boxes = s.boxes;
      this.current = 1; this.over = false;
    }
  }
  _take(orient, r, c, p) {
    if (orient === 'h') this.H[r][c] = p; else this.V[r][c] = p;
    const done = DotsLogic.completeBoxes({ H: this.H, V: this.V, boxes: this.boxes }, orient, r, c, p);
    done.forEach(([br, bc]) => (this.boxes[br][bc] = p));
    if (!done.length) this.current = 3 - p;
    let filled = 0;
    for (let rr = 0; rr < 5; rr++) for (let cc = 0; cc < 5; cc++) if (this.boxes[rr][cc]) filled++;
    if (filled >= 25) this.over = true;
  }
  _schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this._move(), 350 + Math.random() * 350); }
  _any() { return DotsLogic.allLines({ H: this.H, V: this.V, boxes: this.boxes }).length > 0; }
  _move() {
    const mv = this._choose();
    if (!mv) { if (this._any()) this.current = 1; else this.over = true; return; }
    this.net._emit('dots_line', { orient: mv.orient, r: mv.r, c: mv.c, by: 2 });
    this._take(mv.orient, mv.r, mv.c, 2);
    if (!this.over && this.current === 2) this._schedule();
  }
  _choose() {
    const S = { H: this.H, V: this.V, boxes: this.boxes };
    const lines = DotsLogic.allLines(S);
    if (!lines.length) return null;
    const gainers = lines.filter((l) => DotsLogic.completeBoxes(S, l.orient, l.r, l.c, 2).length > 0);
    if (gainers.length && !(this.diff === 'easy' && Math.random() < 0.5)) {
      gainers.sort((a, b) => DotsLogic.completeBoxes(S, b.orient, b.r, b.c, 2).length - DotsLogic.completeBoxes(S, a.orient, a.r, a.c, 2).length);
      return gainers[0];
    }
    const safe = lines.filter((l) => DotsLogic.giveBoxes(S, l.orient, l.r, l.c, 1) === 0);
    const pool = safe.length ? safe : lines;
    if (this.diff === 'easy' && Math.random() < 0.5) return lines[Math.floor(Math.random() * lines.length)];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  destroy() { clearTimeout(this.timer); }
}

// ===========================================================================
// 记忆翻牌 AI（自带完整牌面，靠记忆配对）
// ===========================================================================
class MemoryBrain {
  constructor(net, diff) {
    this.net = net; this.diff = diff;
    this.layout = null; this.claimed = new Set(); this.humanFirst = null; this.timer = null;
  }
  onHuman(type, data) {
    if (type === 'mem_init') {
      this.layout = data.layout.slice(); this.claimed.clear(); this.humanFirst = null;
    } else if (type === 'mem_flip' && data.by === 1) {
      if (this.humanFirst === null) this.humanFirst = data.idx;
      else {
        const f = this.humanFirst;
        if (this.layout[f] === this.layout[data.idx]) { this.claimed.add(f); this.claimed.add(data.idx); }
        else { this.timer = setTimeout(() => this._aiTurn(), 550); }
        this.humanFirst = null;
      }
    }
  }
  _aiTurn() {
    if (!this.layout || this.claimed.size >= 16) return;
    const avail = [...Array(16).keys()].filter((i) => !this.claimed.has(i));
    if (avail.length < 2) return;
    const useSmart = this.diff === 'hard' ? true : this.diff === 'medium' ? Math.random() < 0.7 : Math.random() < 0.3;
    let a, b;
    if (useSmart) {
      const groups = {};
      avail.forEach((i) => { (groups[this.layout[i]] = groups[this.layout[i]] || []).push(i); });
      const pair = Object.values(groups).find((g) => g.length >= 2);
      if (pair) { a = pair[0]; b = pair[1]; }
    }
    if (a === undefined) {
      a = avail[Math.floor(Math.random() * avail.length)];
      do { b = avail[Math.floor(Math.random() * avail.length)]; } while (b === a);
    }
    this.net._emit('mem_flip', { by: 2, idx: a });
    this.timer = setTimeout(() => {
      this.net._emit('mem_flip', { by: 2, idx: b });
      if (this.layout[a] === this.layout[b]) {
        this.claimed.add(a); this.claimed.add(b);
        if (this.claimed.size < 16) this.timer = setTimeout(() => this._aiTurn(), 600);
      }
    }, 520);
  }
  destroy() { clearTimeout(this.timer); }
}

function createBrain(gameId, difficulty, net) {
  if (gameId === 'gomoku') return new GomokuBrain(net, difficulty);
  if (gameId === 'draw') return new DrawBrain(net, difficulty);
  if (gameId === 'reversi') return new ReversiBrain(net, difficulty);
  if (gameId === 'dots') return new DotsBrain(net, difficulty);
  if (gameId === 'memory') return new MemoryBrain(net, difficulty);
  if (gameId === 'turtle') return new TurtleBrain(net, difficulty);
  if (gameId === 'liars') return new LiarsBrain(net, difficulty);
  if (gameId === 'uno') return new UnoBrain(net, difficulty);
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

// ===========================================================================
// 海龟汤 AI（汤主：知道答案，按关键词回答 / 判定猜测）
// ===========================================================================
class TurtleBrain {
  constructor(net, diff) { this.net = net; this.diff = diff; this.story = null; this.timer = null; }
  start() {
    const i = Math.floor(Math.random() * TurtleLogic.stories.length);
    this.story = TurtleLogic.stories[i];
    this.net._emit('tt_select', { storyId: this.story.id });
  }
  onHuman(type, data) {
    if (type === 'tt_question') {
      if (!this.story) return;
      const ans = TurtleLogic.answer(this.story, data.text || '');
      const map = { yes: '是', no: '不是', na: '无关', unsure: '不确定，换种问法' };
      this.net._emit('tt_answer', { text: map[ans] || '不确定，换种问法', type: ans });
    } else if (type === 'tt_guess') {
      if (!this.story) return;
      const correct = TurtleLogic.verify(this.story, data.text || '');
      this.net._emit('tt_verify', { correct });
    } else if (type === 'tt_giveup') {
      this.net._emit('tt_giveup', {});
    }
  }
  destroy() { clearTimeout(this.timer); }
}

// ===========================================================================
// 吹牛 AI（玩家2 / 蓝方，持有自己的骰子，按概率诈唬或开）
// ===========================================================================
class LiarsBrain {
  constructor(net, diff) {
    this.net = net; this.diff = diff;
    this.dice = LiarsLogic.roll5();
    this.lives = { 1: 3, 2: 3 };
    this.bid = null; this.over = false; this.timer = null;
  }
  applyResult(loser) {
    this.lives[loser] = Math.max(0, this.lives[loser] - 1);
    if (this.lives[1] === 0 || this.lives[2] === 0) this.over = true;
  }
  bestOpen() {
    const cnt = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    this.dice.forEach((d) => { cnt[d]++; });
    let best = 1, mx = 0;
    for (let f = 1; f <= 6; f++) if (cnt[f] > mx) { mx = cnt[f]; best = f; }
    return { count: Math.max(2, mx), face: best };
  }
  decideRaise(prev) {
    // 最小合法加叫：同数量升点数，或升数量
    if (prev.face < 6) return { count: prev.count, face: prev.face + 1 };
    return { count: prev.count + 1, face: 1 };
  }
  onHuman(type, data) {
    if (this.over) return;
    if (type === 'ld_start') {
      this.dice = LiarsLogic.roll5(); this.bid = null;
      if (data.starter === 2) {
        const o = this.bestOpen();
        this.bid = { count: o.count, face: o.face, by: 2 };
        this.net._emit('ld_bid', this.bid);
      }
      return;
    }
    if (type === 'ld_bid') {
      this.bid = data;
      const p = truthProb(this.dice, data.count, data.face);
      const thr = this.diff === 'easy' ? 0.25 : this.diff === 'hard' ? 0.5 : 0.4;
      if (data.count >= 10 || p < thr) {
        this.net._emit('ld_challenge', { by: 2 });
      } else {
        const nb = this.decideRaise(data);
        this.bid = { count: nb.count, face: nb.face, by: 2 };
        this.net._emit('ld_bid', this.bid);
      }
      return;
    }
    if (type === 'ld_challenge') {
      // 人类(by=1)开 → AI 是 bidder，亮骰
      this.net._emit('ld_reveal', { dice: this.dice.slice(), player: 2 });
      return;
    }
    if (type === 'ld_reveal') {
      if (data.player !== 1) return;            // 只有人类(红)亮骰时 AI 才计算
      if (!this.bid) return;                    // 防御：未叫数不裁判
      const d1 = data.dice, d2 = this.dice;
      const loser = LiarsLogic.resolve(this.bid, d1, d2);
      this.net._emit('ld_result', { loser, dice1: d1, dice2: d2 });
      this.applyResult(loser);
      return;
    }
    if (type === 'ld_result') {
      // 人类(挑战方)已计算并广播结果，AI 仅更新本地血量
      this.applyResult(data.loser);
      return;
    }
    if (type === 'ld_restart') { this.lives = { 1: 3, 2: 3 }; this.over = false; this.bid = null; }
  }
  destroy() { clearTimeout(this.timer); }
}

// ===========================================================================
// UNO AI（权威方：持有完整牌局，处理人类动作后自动出牌）
// ===========================================================================
class UnoBrain {
  constructor(net, diff) { this.net = net; this.diff = diff; this.state = null; this.timer = null; }
  start() {
    this.state = UnoLogic.newGame();
    this.net._emit('uno_state', this.state);
  }
  play() {
    if (!this.state || this.state.winner) return;
    let guard = 0;
    while (this.state && this.state.current === 2 && !this.state.winner && guard < 8) {
      guard++;
      const action = UnoLogic.chooseAI(this.state, 2, this.diff);
      UnoLogic.apply(this.state, action);
      this.net._emit('uno_state', this.state);
    }
  }
  onHuman(type, data) {
    if (type === 'uno_action') {
      if (!this.state) return;
      UnoLogic.apply(this.state, data);
      this.net._emit('uno_state', this.state);
      if (this.state.winner) return;
      if (this.state.current === 2) this.play();
    } else if (type === 'uno_restart') {
      this.start();
    }
  }
  destroy() { clearTimeout(this.timer); }
}

// 供逻辑测试 / 外部复用
export { TurtleBrain, LiarsBrain, UnoBrain };
