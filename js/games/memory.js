// 记忆翻牌（情侣配对）模块。消息使用 mem_ 前缀。
// 4×4 共 16 张（8 对），玩家轮流翻两张；配对成功则占领并再翻一次，否则盖回换人。
// 玩家 1 = 红方（先手），玩家 2 = 蓝方。房主开局生成牌面并同步给对手。

import { Sound } from '../sound.js';

const GRID = 4;
const ICONS = ['❤️', '🌟', '🌸', '🍓', '🌙', '🐱', '🍰', '💍'];

function genLayout() {
  const pair = [];
  for (let i = 0; i < GRID * GRID / 2; i++) { pair.push(i); pair.push(i); }
  for (let i = pair.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pair[i], pair[j]] = [pair[j], pair[i]];
  }
  return pair;
}

export default {
  id: 'memory',
  name: '记忆翻牌',
  desc: '翻开卡片找相同，配对多者胜',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="mem-status" class="c4-status"></div>
      <div id="mem-grid" class="mem-grid"></div>
      <div id="mem-score" class="rev-score"></div>
      <button id="mem-restart" class="c4-restart">重新开始</button>
    `;
    const statusEl = root.querySelector('#mem-status');
    const gridEl = root.querySelector('#mem-grid');
    const scoreEl = root.querySelector('#mem-score');

    let cards = Array.from({ length: GRID * GRID }, () => ({ pair: -1, up: false, claimed: 0 }));
    let turn = 1;
    let firstIdx = null;
    let busy = false;
    let over = false;
    let finished = false;
    const score = { 1: 0, 2: 0 };

    function applyLayout(layout) {
      layout.forEach((p, i) => (cards[i].pair = p));
    }

    function finish() {
      if (finished) return;
      finished = true;
      let result;
      if (score[1] > score[2]) result = ctx.net.me === 1 ? 'win' : 'lose';
      else if (score[2] > score[1]) result = ctx.net.me === 2 ? 'win' : 'lose';
      else result = 'draw';
      statusEl.textContent = (result === 'win' ? '你赢了！' : result === 'lose' ? '你输了' : '平局！') +
        `  配对 ${score[1]} : ${score[2]}`;
      if (ctx.reportPlay) ctx.reportPlay('memory', '记忆翻牌', ctx.net.peerName, result);
    }

    function render() {
      scoreEl.innerHTML = `<span class="rs r1">红方 ${score[1]}</span><span class="rs r2">蓝方 ${score[2]}</span>`;
      gridEl.innerHTML = '';
      cards.forEach((cd, i) => {
        const el = document.createElement('div');
        el.className = 'mem-card' + (cd.claimed ? ' claimed c' + cd.claimed : cd.up ? ' up' : '');
        if (cd.claimed) el.classList.add('c' + cd.claimed);
        if (cd.up || cd.claimed) el.textContent = ICONS[cd.pair] || '?';
        else el.textContent = '❓';
        el.onclick = () => onClick(i);
        gridEl.appendChild(el);
      });
    }

    function updateStatus() {
      if (over) return;
      if (turn === ctx.net.me) statusEl.textContent = `轮到你了（${ctx.net.me === 1 ? '红方' : '蓝方'}）`;
      else statusEl.textContent = `等待 ${ctx.net.peerName} 翻牌…`;
    }

    function onClick(i) {
      if (busy || over || turn !== ctx.net.me) return;
      if (cards[i].up || cards[i].claimed || firstIdx === i) return;
      onFlip(ctx.net.me, i);
      ctx.net.send('mem_flip', { by: ctx.net.me, idx: i });
    }

    // 翻牌（本地与对手消息共用）
    function onFlip(by, idx) {
      if (cards[idx].up || cards[idx].claimed) return;
      cards[idx].up = true;
      Sound.click();
      if (firstIdx === null) firstIdx = idx;
      else resolve(firstIdx, idx, by);
      render();
    }

    function resolve(a, b, by) {
      firstIdx = null;
      if (cards[a].pair === cards[b].pair) {
        Sound.match();
        cards[a].claimed = by; cards[b].claimed = by;
        score[by]++;
        let total = 0; for (const c of cards) if (c.claimed) total++;
        if (total >= GRID * GRID) { over = true; finish(); }
        else statusEl.textContent = (by === ctx.net.me ? '你' : ctx.net.peerName) + ' 配对成功，继续！';
      } else {
        Sound.invalid();
        busy = true;
        setTimeout(() => {
          cards[a].up = false; cards[b].up = false;
          busy = false; turn = 3 - by;
          render(); updateStatus();
        }, 800);
      }
    }

    const offs = [];
    offs.push(ctx.net.on('mem_flip', (m) => onFlip(m.by, m.idx)));
    offs.push(ctx.net.on('mem_init', (m) => { applyLayout(m.layout); render(); }));
    offs.push(ctx.net.on('mem_restart', () => reset()));

    function reset() {
      if (ctx.net.isHost) {
        const layout = genLayout();
        applyLayout(layout);
        ctx.net.send('mem_init', { layout });
      }
      for (const c of cards) { c.up = false; c.claimed = 0; }
      turn = 1; firstIdx = null; busy = false; over = false; finished = false;
      score[1] = 0; score[2] = 0;
      render(); updateStatus();
    }

    root.querySelector('#mem-restart').onclick = () => { reset(); ctx.net.send('mem_restart'); };

    // 房主开局生成牌面并同步
    if (ctx.net.isHost) {
      const layout = genLayout();
      applyLayout(layout);
      ctx.net.send('mem_init', { layout });
    }

    render();
    updateStatus();

    return { destroy() { offs.forEach((f) => f()); }, restart() { reset(); ctx.net.send('mem_restart'); } };
  },
};

export const MemLogic = { GRID, ICONS, genLayout };
