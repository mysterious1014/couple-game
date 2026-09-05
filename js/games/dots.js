// 点格棋（Dots & Boxes）模块。消息使用 dots_ 前缀。
// n×n 的格子，玩家轮流连接相邻圆点；连成闭合方格者占领该格并再走一步。
// 玩家 1 = 红方（先手），玩家 2 = 蓝方。使用 Canvas 绘制，点击就近的线段落子。

import { Sound } from '../sound.js';

const N = 5;                 // 5×5 个方格
const SIZE = 380;            // 画布像素
const CELL = SIZE / N;
const C1 = '#ff5d7e';        // 红方
const C2 = '#6c7bff';        // 蓝方

function emptyLines() {
  const H = Array.from({ length: N + 1 }, () => new Array(N).fill(0)); // H[r][c]: 横线 点(r,c)-(r,c+1)
  const V = Array.from({ length: N }, () => new Array(N + 1).fill(0)); // V[r][c]: 竖线 点(r,c)-(r+1,c)
  return { H, V, boxes: Array.from({ length: N }, () => new Array(N).fill(0)) };
}

function boxComplete(S, r, c, p) {
  return S.H[r][c] === p && S.V[r][c] === p && S.V[r][c + 1] === p && S.H[r + 1][c] === p;
}

// 落子 (orient,r,c) 后，返回因此被占领的方格坐标数组
function completeBoxes(S, orient, r, c, p) {
  const res = [];
  if (orient === 'h') {
    if (r > 0 && boxComplete(S, r - 1, c, p)) res.push([r - 1, c]);
    if (r < N && boxComplete(S, r, c, p)) res.push([r, c]);
  } else {
    if (c > 0 && boxComplete(S, r, c - 1, p)) res.push([r, c - 1]);
    if (c < N && boxComplete(S, r, c, p)) res.push([r, c]);
  }
  return res;
}

function allLines(S) {
  const out = [];
  for (let r = 0; r <= N; r++) for (let c = 0; c < N; c++) if (!S.H[r][c]) out.push({ orient: 'h', r, c });
  for (let r = 0; r < N; r++) for (let c = 0; c <= N; c++) if (!S.V[r][c]) out.push({ orient: 'v', r, c });
  return out;
}

function giveBoxes(S, orient, r, c, opp) {
  // 若 (orient,r,c) 归 opp，会给 opp 带来几个方格
  const tmp = { H: S.H.map((x) => x.slice()), V: S.V.map((x) => x.slice()), boxes: S.boxes };
  if (orient === 'h') tmp.H[r][c] = opp; else tmp.V[r][c] = opp;
  return completeBoxes(tmp, orient, r, c, opp).length;
}

export default {
  id: 'dots',
  name: '点格棋',
  desc: '连接圆点围方格，围得多者胜',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="dots-status" class="c4-status"></div>
      <div id="dots-wrap" class="dots-wrap"><canvas id="dots-canvas" width="${SIZE}" height="${SIZE}"></canvas></div>
      <div id="dots-score" class="rev-score"></div>
      <button id="dots-restart" class="c4-restart">重新开始</button>
    `;
    const statusEl = root.querySelector('#dots-status');
    const scoreEl = root.querySelector('#dots-score');
    const canvas = root.querySelector('#dots-canvas');
    const g = canvas.getContext('2d');

    let S = emptyLines();
    let current = 1;
    let over = false;
    let finished = false;
    let busy = false;

    function take(o, r, c, p) {
      if (o === 'h') S.H[r][c] = p; else S.V[r][c] = p;
      const done = completeBoxes(S, o, r, c, p);
      done.forEach(([br, bc]) => (S.boxes[br][bc] = p));
      return done.length;
    }

    function finish() {
      if (finished) return;
      finished = true;
      let a = 0, b = 0;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (S.boxes[r][c] === 1) a++; else if (S.boxes[r][c] === 2) b++;
      }
      let result;
      if (a > b) result = ctx.net.me === 1 ? 'win' : 'lose';
      else if (b > a) result = ctx.net.me === 2 ? 'win' : 'lose';
      else result = 'draw';
      statusEl.textContent = (result === 'win' ? '你赢了！' : result === 'lose' ? '你输了' : '平局！') + `  比分 ${a} : ${b}`;
      if (ctx.reportPlay) ctx.reportPlay('dots', '点格棋', ctx.net.peerName, result);
    }

    function render() {
      let a = 0, b = 0;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (S.boxes[r][c] === 1) a++; else if (S.boxes[r][c] === 2) b++;
      }
      scoreEl.innerHTML = `<span class="rs r1">红方 ${a}</span><span class="rs r2">蓝方 ${b}</span>`;
      g.clearRect(0, 0, SIZE, SIZE);
      // 已占领方格填充
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (S.boxes[r][c]) {
          g.fillStyle = S.boxes[r][c] === 1 ? 'rgba(255,93,126,0.22)' : 'rgba(108,123,255,0.22)';
          g.fillRect(c * CELL + 3, r * CELL + 3, CELL - 6, CELL - 6);
        }
      }
      // 线段
      const drawLine = (x1, y1, x2, y2, color) => {
        g.strokeStyle = color; g.lineWidth = color === 'rgba(0,0,0,0)' ? 1 : 6; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      };
      for (let r = 0; r <= N; r++) for (let c = 0; c < N; c++) {
        const col = S.H[r][c] === 1 ? C1 : S.H[r][c] === 2 ? C2 : 'rgba(255,255,255,0.18)';
        drawLine(c * CELL, r * CELL, (c + 1) * CELL, r * CELL, col);
      }
      for (let r = 0; r < N; r++) for (let c = 0; c <= N; c++) {
        const col = S.V[r][c] === 1 ? C1 : S.V[r][c] === 2 ? C2 : 'rgba(255,255,255,0.18)';
        drawLine(c * CELL, r * CELL, c * CELL, (r + 1) * CELL, col);
      }
      // 圆点
      g.fillStyle = '#ffd6e6';
      for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) {
        g.beginPath(); g.arc(c * CELL, r * CELL, 4, 0, Math.PI * 2); g.fill();
      }
    }

    function updateStatus() {
      if (over) return;
      if (current === ctx.net.me) statusEl.textContent = `轮到你了（${ctx.net.me === 1 ? '红方' : '蓝方'}）`;
      else statusEl.textContent = `等待 ${ctx.net.peerName} 落子…`;
    }

    function mapLine(x, y) {
      // x,y 为画布内坐标
      let best = null, bestD = 1e9;
      const consider = (orient, r, c, mx, my) => {
        const d = Math.hypot(x - mx, y - my);
        if (d < bestD) { bestD = d; best = { orient, r, c }; }
      };
      for (let r = 0; r <= N; r++) for (let c = 0; c < N; c++) consider('h', r, c, c * CELL + CELL / 2, r * CELL);
      for (let r = 0; r < N; r++) for (let c = 0; c <= N; c++) consider('v', r, c, c * CELL, r * CELL + CELL / 2);
      if (bestD > CELL * 0.36) return null;
      return best;
    }

    function click(e) {
      if (over || busy || current !== ctx.net.me) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width * SIZE;
      const y = (e.clientY - rect.top) / rect.height * SIZE;
      const ln = mapLine(x, y);
      if (!ln) return;
      if (ln.orient === 'h' ? S.H[ln.r][ln.c] : S.V[ln.r][ln.c]) return;
      doMove(ln.orient, ln.r, ln.c, ctx.net.me);
      ctx.net.send('dots_line', { orient: ln.orient, r: ln.r, c: ln.c, by: ctx.net.me });
    }

    function doMove(orient, r, c, p) {
      const gained = take(orient, r, c, p);
      if (gained) Sound.match();   // 围出方格：成功音
      else Sound.place();          // 普通连线：落子音
      if (gained) { /* 占领方格，同一玩家继续 */ }
      else current = 3 - p;
      const total = N * N;
      let filled = 0;
      for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++) if (S.boxes[rr][cc]) filled++;
      const remaining = allLines(S).length;
      if (filled >= total || remaining === 0) { over = true; finish(); }
      render(); updateStatus();
    }

    canvas.addEventListener('click', click);

    const offs = [];
    offs.push(ctx.net.on('dots_line', (m) => {
      if (over) return;
      const owned = m.orient === 'h' ? S.H[m.r][m.c] : S.V[m.r][m.c];
      if (owned) return;
      busy = false;
      doMove(m.orient, m.r, m.c, m.by);
    }));
    offs.push(ctx.net.on('dots_restart', () => reset()));

    function reset() {
      S = emptyLines();
      current = 1; over = false; finished = false; busy = false;
      render(); updateStatus();
    }

    root.querySelector('#dots-restart').onclick = () => { reset(); ctx.net.send('dots_restart'); };

    render();
    updateStatus();

    return { destroy() { offs.forEach((f) => f()); }, restart() { reset(); ctx.net.send('dots_restart'); } };
  },
};

export const DotsLogic = { N, CELL, SIZE, emptyLines, completeBoxes, allLines, giveBoxes };
