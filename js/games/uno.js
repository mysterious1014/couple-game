// UNO 模块。消息使用 uno_ 前缀。
// 房主(me=1)权威：持有完整牌局状态并向客人广播 uno_state；客人只发 uno_action、收状态渲染。
// 人机模式：人类是玩家1，AI 是玩家2；AINet 的大脑(UnoBrain)是唯一权威，人类仅发动作、收状态渲染。
// 2 人规则简化：reverse 等同 skip（对手跳过）；+2/+4 对手摸牌且跳过。

import { Sound } from '../sound.js';

const COLORS = ['r', 'y', 'g', 'b'];
const COLOR_HEX = { r: '#ff5d7e', y: '#ffc24d', g: '#5fd6a6', b: '#6c9bff', w: '#b07bd6' };
const COLOR_NAME = { r: '红', y: '黄', g: '绿', b: '蓝', w: '百搭' };
const NUMS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export const UnoLogic = {
  buildDeck() {
    const d = [];
    for (const c of COLORS) {
      d.push({ c, n: 0 });
      for (let i = 1; i <= 9; i++) { d.push({ c, n: i }); d.push({ c, n: i }); }
      d.push({ c, n: 'skip' }); d.push({ c, n: 'skip' });
      d.push({ c, n: 'rev' }); d.push({ c, n: 'rev' });
      d.push({ c, n: '+2' }); d.push({ c, n: '+2' });
    }
    for (let i = 0; i < 4; i++) { d.push({ c: 'w', n: 'wild' }); d.push({ c: 'w', n: '+4' }); }
    return d;
  },
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    return a;
  },
  newGame() {
    const deck = this.shuffle(this.buildDeck());
    const hands = { 1: [], 2: [] };
    for (let i = 0; i < 7; i++) { hands[1].push(deck.pop()); hands[2].push(deck.pop()); }
    let top;
    do { top = deck.pop(); } while (top.c === 'w');
    return { deck, hands, discard: [top], current: 1, winner: null, mustColor: null, pendingDraw: 0, event: '' };
  },
  top(state) { return state.discard[state.discard.length - 1]; },
  legalPlay(state, card) {
    if (card.c === 'w') return true;
    const t = this.top(state);
    const eff = state.mustColor || t.c;
    if (card.c === eff) return true;
    if (card.n === t.n) return true;
    return false;
  },
  hasLegal(hand, state) { return hand.some((c) => this.legalPlay(state, c)); },
  drawCards(state, player, n) {
    for (let i = 0; i < n; i++) {
      if (!state.deck.length) {
        const keep = state.discard.pop();
        state.deck = this.shuffle(state.discard);
        state.discard = [keep];
      }
      if (!state.deck.length) break;
      state.hands[player].push(state.deck.pop());
    }
  },
  apply(state, action) {
    const p = state.current;
    if (action.type === 'play') {
      const card = state.hands[p].splice(action.index, 1)[0];
      if (card.c === 'w') state.mustColor = action.color || 'r';
      else state.mustColor = null;
      state.discard.push(card);
      const n = card.n;
      if (n === 'skip' || n === 'rev') { state.current = p; state.event = '跳过对手'; }
      else if (n === '+2') { this.drawCards(state, 3 - p, 2); state.current = p; state.event = '对手 +2'; }
      else if (n === '+4') { this.drawCards(state, 3 - p, 4); state.current = p; state.mustColor = action.color || 'r'; state.event = '对手 +4'; }
      else { state.current = 3 - p; state.event = ''; }
      if (state.hands[p].length === 0) state.winner = p;
    } else if (action.type === 'draw') {
      if (state.pendingDraw > 0) { this.drawCards(state, p, state.pendingDraw); state.pendingDraw = 0; }
      else this.drawCards(state, p, 1);
      state.current = 3 - p; state.event = '摸牌';
      if (state.hands[p].length === 0) state.winner = p;
    }
  },
  chooseAI(state, player, diff) {
    const hand = state.hands[player];
    const legalIdx = hand.map((c, i) => (this.legalPlay(state, c) ? i : -1)).filter((i) => i >= 0);
    if (!legalIdx.length) return { type: 'draw' };
    // 优先出非百搭；困难优先出数字大的、或功能牌
    const pick = () => {
      if (diff === 'easy' && Math.random() < 0.5) return legalIdx[Math.floor(Math.random() * legalIdx.length)];
      // 能出功能牌就出
      const fns = legalIdx.filter((i) => ['skip', 'rev', '+2', '+4'].includes(hand[i].n));
      const pool = fns.length && !(diff === 'easy') ? fns : legalIdx;
      // 选与当前 mustColor/顶色一致的
      const t = this.top(state); const eff = state.mustColor || t.c;
      const sameColor = pool.filter((i) => hand[i].c === eff);
      const idx = (sameColor.length ? sameColor : pool)[0];
      return idx;
    };
    const index = pick();
    const card = hand[index];
    const color = card.c === 'w' ? this.bestColor(state, player) : undefined;
    return { type: 'play', index, color };
  },
  bestColor(state, player) {
    const cnt = { r: 0, y: 0, g: 0, b: 0 };
    state.hands[player].forEach((c) => { if (c.c !== 'w') cnt[c.c]++; });
    let best = 'r', mx = -1;
    for (const c of COLORS) if (cnt[c] > mx) { mx = cnt[c]; best = c; }
    return best;
  },
};

function sym(n) {
  if (n === 'skip') return '⊘';
  if (n === 'rev') return '⇄';
  if (n === '+2') return '+2';
  if (n === '+4') return '+4';
  if (n === 'wild') return '★';
  return String(n);
}

export default {
  id: 'uno',
  name: 'UNO',
  desc: '经典卡牌，先出完手牌者胜',

  mount(ctx) {
    const root = ctx.root;
    const me = ctx.net.me;
    const isAuth = !ctx.net.isAI && me === 1;
    root.innerHTML = `
      <div id="uno-turn" class="uno-turn"></div>
      <div class="uno-table">
        <div id="uno-opp" class="uno-opp"></div>
        <div class="uno-center">
          <div id="uno-top" class="uno-top"></div>
          <button id="uno-draw" class="uno-draw">摸牌堆</button>
        </div>
        <div id="uno-me" class="uno-me"></div>
      </div>
      <div id="uno-color" class="uno-color" hidden>
        <span>选择颜色：</span>
        <button data-c="r" style="background:#ff5d7e">红</button>
        <button data-c="y" style="background:#ffc24d">黄</button>
        <button data-c="g" style="background:#5fd6a6">绿</button>
        <button data-c="b" style="background:#6c9bff">蓝</button>
      </div>
      <button id="uno-restart" class="c4-restart" hidden>再来一局</button>
    `;
    const turnEl = root.querySelector('#uno-turn');
    const oppEl = root.querySelector('#uno-opp');
    const topEl = root.querySelector('#uno-top');
    const meEl = root.querySelector('#uno-me');
    const drawBtn = root.querySelector('#uno-draw');
    const colorEl = root.querySelector('#uno-color');
    const restartBtn = root.querySelector('#uno-restart');

    let state = null;
    let over = false;
    let pendingWild = null; // {index} 等待选色

    function cardHTML(card, opts = {}) {
      const cls = 'uno-card c-' + card.c + (opts.dim ? ' dim' : '');
      return `<div class="${cls}" ${opts.dataIndex != null ? `data-idx="${opts.dataIndex}"` : ''}>${sym(card.n)}</div>`;
    }

    function render() {
      if (!state) return;
      const top = UnoLogic.top(state);
      const eff = state.mustColor || top.c;
      topEl.style.background = COLOR_HEX[eff];
      topEl.innerHTML = `<span class="uno-sym">${sym(top.n)}</span>`;
      const opp = 3 - me;
      oppEl.innerHTML = `<div class="uno-opp-cnt">对手手牌：${state.hands[opp].length} 张</div>` +
        state.hands[opp].map(() => `<div class="uno-card c-back"></div>`).join('');
      const hand = state.hands[me];
      const myTurn = state.current === me && !over;
      meEl.innerHTML = hand.map((c, i) => {
        const legal = myTurn && UnoLogic.legalPlay(state, c);
        return cardHTML(c, { dataIndex: i, dim: !legal });
      }).join('');
      meEl.querySelectorAll('.uno-card[data-idx]').forEach((el) => {
        el.onclick = () => {
          const idx = +el.dataset.idx;
          const card = hand[idx];
          if (!myTurn) { Sound.invalid(); return; }
          if (!UnoLogic.legalPlay(state, card)) { Sound.invalid(); return; }
          if (card.c === 'w') { pendingWild = { index: idx }; colorEl.hidden = false; return; }
          act({ type: 'play', index: idx });
        };
      });
      drawBtn.onclick = () => { if (myTurn) act({ type: 'draw' }); else Sound.invalid(); };
      colorEl.querySelectorAll('[data-c]').forEach((b) => {
        b.onclick = () => {
          colorEl.hidden = true;
          if (pendingWild) { act({ type: 'play', index: pendingWild.index, color: b.dataset.c }); pendingWild = null; }
        };
      });
      turnEl.textContent = over ? '本局结束' : (myTurn ? '轮到你出牌' : '等待 ' + ctx.net.peerName + ' 出牌…');
      if (state.hands[me].length === 1 && myTurn && !over) turnEl.textContent += '  🔊 UNO!';
    }

    function act(action) {
      if (isAuth) {
        UnoLogic.apply(state, action);
        broadcast();
        render();
        if (state.winner) finish(state.winner);
      } else {
        ctx.net.send('uno_action', action);
      }
    }

    function broadcast() { ctx.net.send('uno_state', state); }

    function finish(winner) {
      over = true;
      const result = winner === me ? 'win' : 'lose';
      Sound[result === 'win' ? 'win' : 'lose'] && Sound[result === 'win' ? 'win' : 'lose']();
      restartBtn.hidden = false;
      turnEl.textContent = result === 'win' ? '🏆 你赢了！' : '😢 你输了';
      ctx.reportPlay('uno', 'UNO', ctx.net.peerName, result);
    }

    const offs = [];
    offs.push(ctx.net.on('uno_state', (s) => { state = s; render(); if (s.winner) { if (!over) finish(s.winner); } }));
    offs.push(ctx.net.on('uno_action', (a) => {
      if (!isAuth) return;
      UnoLogic.apply(state, a);
      broadcast();
      render();
      if (state.winner) finish(state.winner);
    }));
    offs.push(ctx.net.on('uno_restart', () => { newRound(); }));

    restartBtn.onclick = () => {
      over = false; restartBtn.hidden = true;
      newRound();
      ctx.net.send('uno_restart');
    };

    function newRound() {
      over = false; restartBtn.hidden = true; pendingWild = null; colorEl.hidden = true;
      if (isAuth) { state = UnoLogic.newGame(); broadcast(); render(); }
      else if (ctx.net.isAI) ctx.net.aiStart();
    }

    // 启动
    if (isAuth) { state = UnoLogic.newGame(); broadcast(); render(); }
    else if (ctx.net.isAI) { render(); ctx.net.aiStart(); }
    else { render(); } // 客人在等房主广播

    return {
      destroy() { offs.forEach((f) => f()); },
      restart() { over = false; restartBtn.hidden = true; ctx.net.send('uno_restart'); newRound(); },
    };
  },
};
