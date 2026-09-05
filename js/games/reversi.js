// 黑白棋（奥赛罗 / Reversi）模块。消息使用 rev_ 前缀。
// 8x8 棋盘，落子需夹住对方棋子并翻转；无子可下时跳过；子多者胜。
// 玩家 1 = 红方（先手），玩家 2 = 蓝方。

import { Sound } from '../sound.js';

const N = 8;
const RD = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const W = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];

function inB(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

function flipsFor(board, r, c, p) {
  if (board[r][c] !== 0) return [];
  const opp = 3 - p;
  const out = [];
  for (const [dr, dc] of RD) {
    const line = [];
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc) && board[nr][nc] === opp) { line.push([nr, nc]); nr += dr; nc += dc; }
    if (line.length && inB(nr, nc) && board[nr][nc] === p) out.push(...line);
  }
  return out;
}

function legalMoves(board, p) {
  const out = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      if (board[r][c] === 0 && flipsFor(board, r, c, p).length) out.push({ r, c });
  return out;
}

function applyAt(board, r, c, p) {
  const fl = flipsFor(board, r, c, p);
  if (!fl.length) return false;
  board[r][c] = p;
  fl.forEach(([fr, fc]) => (board[fr][fc] = p));
  return true;
}

function count(board) {
  let a = 0, b = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (board[r][c] === 1) a++; else if (board[r][c] === 2) b++;
  }
  return { 1: a, 2: b };
}

export default {
  id: 'reversi',
  name: '黑白棋',
  desc: '8×8 棋盘，夹住对方翻面，子多者胜',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="rev-status" class="c4-status"></div>
      <div id="rev-board" class="rev-board"></div>
      <div id="rev-score" class="rev-score"></div>
      <button id="rev-restart" class="c4-restart">重新开始</button>
    `;
    const statusEl = root.querySelector('#rev-status');
    const boardEl = root.querySelector('#rev-board');
    const scoreEl = root.querySelector('#rev-score');

    let board = Array.from({ length: N }, () => new Array(N).fill(0));
    board[3][3] = 2; board[3][4] = 1; board[4][3] = 1; board[4][4] = 2;
    let current = 1;
    let over = false;
    let finished = false;
    let busy = false;

    const name = (p) => (p === 1 ? '红方' : '蓝方');

    function finish() {
      if (finished) return;
      finished = true;
      const sc = count(board);
      let result;
      if (sc[1] > sc[2]) result = ctx.net.me === 1 ? 'win' : 'lose';
      else if (sc[2] > sc[1]) result = ctx.net.me === 2 ? 'win' : 'lose';
      else result = 'draw';
      statusEl.textContent = (result === 'win' ? '你赢了！' : result === 'lose' ? '你输了' : '平局！') +
        `  比分 ${sc[1]} : ${sc[2]}`;
      if (ctx.reportPlay) ctx.reportPlay('reversi', '黑白棋', ctx.net.peerName, result);
    }

    function render() {
      const sc = count(board);
      scoreEl.innerHTML = `<span class="rs r1">红方 ${sc[1]}</span><span class="rs r2">蓝方 ${sc[2]}</span>`;
      boardEl.innerHTML = '';
      const moves = over ? [] : legalMoves(board, current);
      const canMove = !over && current === ctx.net.me;
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const cell = document.createElement('div');
          cell.className = 'rev-cell';
          if (board[r][c] === 1) cell.classList.add('black');
          else if (board[r][c] === 2) cell.classList.add('white');
          else if (canMove && moves.some((m) => m.r === r && m.c === c)) cell.classList.add('hint');
          cell.onclick = () => place(r, c);
          boardEl.appendChild(cell);
        }
      }
    }

    function updateStatus() {
      if (over) return;
      const sc = count(board);
      if (current === ctx.net.me) statusEl.textContent = `轮到你了（${name(current)}）  比分 ${sc[1]} : ${sc[2]}`;
      else statusEl.textContent = `等待 ${ctx.net.peerName}（${name(current)}）落子…`;
    }

    function place(r, c) {
      if (over || busy || current !== ctx.net.me) return;
      if (!applyAt(board, r, c, ctx.net.me)) return;
      Sound.place();
      const opp = 3 - ctx.net.me;
      advance(opp);
      render();
      updateStatus();
      ctx.net.send('rev_move', { r, c, by: ctx.net.me });
    }

    // 落子后决定下一步：对方有子则换，否则对方跳过；双方皆无可走则结束
    function advance(mover) {
      const opp = 3 - mover;
      if (legalMoves(board, opp).length) current = opp;
      else if (legalMoves(board, mover).length) {
        statusEl.textContent = `${name(opp)} 无子可下，跳过`;
      } else { over = true; finish(); }
    }

    const offs = [];
    offs.push(ctx.net.on('rev_move', (m) => {
      if (over) return;
      if (!applyAt(board, m.r, m.c, m.by)) return;
      Sound.place();
      advance(m.by);
      render();
      updateStatus();
    }));
    offs.push(ctx.net.on('rev_restart', () => reset()));

    function reset() {
      board = Array.from({ length: N }, () => new Array(N).fill(0));
      board[3][3] = 2; board[3][4] = 1; board[4][3] = 1; board[4][4] = 2;
      current = 1; over = false; finished = false; busy = false;
      render(); updateStatus();
    }

    root.querySelector('#rev-restart').onclick = () => { reset(); ctx.net.send('rev_restart'); };

    render();
    updateStatus();

    return { destroy() { offs.forEach((f) => f()); }, restart() { reset(); ctx.net.send('rev_restart'); } };
  },
};

// 暴露给 AI 大脑使用的纯逻辑
export const RevLogic = { N, RD, W, inB, flipsFor, legalMoves, applyAt, count };
