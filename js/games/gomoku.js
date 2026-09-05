// 五子棋模块。消息使用 go_ 前缀。
// 15x15 棋盘，任意空位落子，先连成五子(横/竖/斜)者胜。
// 模块接口：export default { id, name, desc, mount(ctx) -> { destroy } }

import { Sound } from '../sound.js';

const SIZE = 15;

function createBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

export default {
  id: 'gomoku',
  name: '五子棋',
  desc: '15×15 棋盘，先连成五子者胜',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="go-status" class="c4-status"></div>
      <div id="go-board" class="go-board"></div>
      <button id="go-restart" class="c4-restart">重新开始</button>
    `;
    const statusEl = root.querySelector('#go-status');
    const boardEl = root.querySelector('#go-board');

    let board = createBoard();
    let current = 1;
    let over = false;
    let finished = false;

    function finish(result) {
      if (finished) return;
      finished = true;
      if (ctx.reportPlay) ctx.reportPlay('gomoku', '五子棋', ctx.net.peerName, result);
    }

    const label = (p) => (p === 1 ? '红方' : '黄方');

    function render() {
      boardEl.innerHTML = '';
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const cell = document.createElement('div');
          cell.className = 'go-cell' + (board[r][c] === 1 ? ' red' : board[r][c] === 2 ? ' yellow' : '');
          cell.onclick = () => place(r, c);
          boardEl.appendChild(cell);
        }
      }
    }
    function updateStatus() {
      if (over) return;
      if (current === ctx.net.me) statusEl.textContent = '轮到你了（' + label(ctx.net.me) + '）';
      else statusEl.textContent = '等待 ' + ctx.net.peerName + '（' + label(current) + '）落子…';
    }
    function place(r, c) {
      if (over || current !== ctx.net.me) return;
      if (board[r][c] !== 0) return;
      board[r][c] = ctx.net.me;
      Sound.place();
      const won = checkWin(r, c, ctx.net.me);
      if (!won) {
        current = 3 - ctx.net.me;
        if (isFull()) { over = true; statusEl.textContent = '平局！'; finish('draw'); }
      } else {
        finish('win');
      }
      render();
      updateStatus();
      ctx.net.send('go_move', { r, c, by: ctx.net.me });
    }
    function applyMove(r, c, p) {
      if (board[r][c] !== 0) return false;
      board[r][c] = p;
      return true;
    }
    function checkWin(r, c, p) {
      const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
      for (const [dr, dc] of dirs) {
        let cnt = 1;
        for (const s of [1, -1]) {
          let nr = r + dr * s, nc = c + dc * s;
          while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] === p) {
            cnt++; nr += dr * s; nc += dc * s;
          }
        }
        if (cnt >= 5) {
          over = true;
          statusEl.textContent = label(p) + ' 获胜！';
          finish(p === ctx.net.me ? 'win' : 'lose');
          return true;
        }
      }
      return false;
    }
    function isFull() {
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) return false;
      return true;
    }
    function reset() {
      board = createBoard();
      current = 1;
      over = false;
      finished = false;
      render();
      updateStatus();
    }

    const offs = [];
    offs.push(ctx.net.on('go_move', (m) => {
      if (over) return;
      if (applyMove(m.r, m.c, m.by)) {
        Sound.place();
        if (!checkWin(m.r, m.c, m.by)) {
          current = 3 - m.by;
          if (isFull()) { over = true; statusEl.textContent = '平局！'; finish('draw'); }
        }
        render();
        updateStatus();
      }
    }));
    offs.push(ctx.net.on('go_restart', () => reset()));
    root.querySelector('#go-restart').onclick = () => { reset(); ctx.net.send('go_restart'); };

    render();
    updateStatus();

    return {
      destroy() { offs.forEach((f) => f()); },
      restart() { reset(); ctx.net.send('go_restart'); },
    };
  },
};
