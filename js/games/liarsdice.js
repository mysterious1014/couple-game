// 吹牛（大话骰 / Liar's Dice）模块。消息使用 ld_ 前缀。
// 两人各 5 颗骰子，1 点为百搭（可当任意点数）。轮流喊数或开（质疑）。
// 玩家 1 = 红方（先手），玩家 2 = 蓝方。房主(me=1)权威？本游戏双方各自持有自己骰子，
// 亮骰时只交换明面，逻辑对称，无需服务器权威。

import { Sound } from '../sound.js';

export const LiarsLogic = {
  roll5() { return Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6)); },
  // 统计某点数出现次数（1 为百搭，计入）
  countFace(dice, face) { return dice.filter((d) => d === face || d === 1).length; },
  C(n, k) { let r = 1; if (k > n - k) k = n - k; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; },
  // P(Y >= k)，Y~Binom(n,p)
  pAtLeast(n, k, p) {
    if (k <= 0) return 1; if (k > n) return 0;
    let s = 0; for (let i = k; i <= n; i++) s += this.C(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
    return s;
  },
  legalRaise(prev, count, face) {
    if (!(count >= 1 && count <= 30 && face >= 1 && face <= 6)) return false;
    if (!prev) return true;
    return count > prev.count || (count === prev.count && face > prev.face);
  },
  // 亮骰后判定：返回输家编号（1 或 2）
  // 规则：叫数被质疑后亮骰。若实际数量 ≥ 叫数（叫数成立），则质疑方(挑战者)输；
  //       若实际数量 < 叫数（叫数吹牛），则叫数方(叫家)输。
  resolve(bid, dice1, dice2) {
    const ten = dice1.concat(dice2);
    const actual = this.countFace(ten, bid.face);
    const bidderWins = actual >= bid.count;   // 叫数成立 → 叫家赢
    return bidderWins ? 3 - bid.by : bid.by;  // 叫家赢则挑战者(3-by)输，否则叫家(by)输
  },
};

// 概率辅助：给定自己 5 颗骰子，喊 (count,face) 为真的概率
function truthProb(own, count, face) {
  const ownRel = LiarsLogic.countFace(own, face);
  const p = face === 1 ? 1 / 6 : 1 / 3; // 对方 5 颗中每颗成为"face 或 1"的概率
  return LiarsLogic.pAtLeast(5, Math.max(0, count - ownRel), p);
}

export default {
  id: 'liars',
  name: '吹牛',
  desc: '喊骰诈唬，看谁先被开',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="ld-status" class="c4-status"></div>
      <div class="ld-life">红方 <span id="ld-life1" class="ld-hearts"></span> &nbsp; 蓝方 <span id="ld-life2" class="ld-hearts"></span></div>
      <div id="ld-mine" class="ld-dice"></div>
      <div id="ld-bid" class="ld-bid">当前叫数：—</div>
      <div id="ld-controls" class="ld-controls"></div>
      <div id="ld-log" class="ld-log"></div>
      <button id="ld-restart" class="c4-restart" hidden>再来一局</button>
    `;
    const statusEl = root.querySelector('#ld-status');
    const life1El = root.querySelector('#ld-life1');
    const life2El = root.querySelector('#ld-life2');
    const mineEl = root.querySelector('#ld-mine');
    const bidEl = root.querySelector('#ld-bid');
    const ctlEl = root.querySelector('#ld-controls');
    const logEl = root.querySelector('#ld-log');
    const restartBtn = root.querySelector('#ld-restart');

    let myDice = LiarsLogic.roll5();
    let bid = null;            // {count, face, by}
    let current = 1;          // 当前该谁喊/开
    let lives = { 1: 3, 2: 3 };
    let over = false;
    let mateDice = null;      // 对方亮出的骰子（结算时）
    let busy = false;

    function log(t) { logEl.innerHTML += `<div>${t}</div>`; logEl.scrollTop = logEl.scrollHeight; }

    function renderMine() { mineEl.innerHTML = myDice.map((d) => `<div class="ld-die">${d}</div>`).join(''); }
    function renderLives() {
      const h = (n) => '❤️'.repeat(n) + '🖤'.repeat(Math.max(0, 3 - n));
      life1El.textContent = ''; life1El.append(h(lives[1]));
      life2El.textContent = ''; life2El.append(h(lives[2]));
    }
    function renderStatus() {
      if (over) return;
      if (current === ctx.net.me) statusEl.textContent = '轮到你了（' + (ctx.net.me === 1 ? '红方' : '蓝方') + '）';
      else statusEl.textContent = '等待 ' + ctx.net.peerName + ' 行动…';
    }
    function renderBid() { bidEl.textContent = bid ? `当前叫数：${bid.count} 个 ${bid.face} 点（${bid.by === 1 ? '红方' : '蓝方'} 喊的）` : '当前叫数：—（你来开叫）'; }

    function renderControls() {
      if (over || current !== ctx.net.me) { ctlEl.innerHTML = ''; return; }
      // 选点数 + 选数量 + 喊 / 开
      let opts = '';
      for (let f = 1; f <= 6; f++) opts += `<option value="${f}">${f} 点</option>`;
      let cnt = '';
      for (let c = 1; c <= 12; c++) cnt += `<option value="${c}">${c}</option>`;
      ctlEl.innerHTML = `
        <div class="ld-row">
          <select id="ld-face" class="ld-sel">${opts}</select>
          <select id="ld-count" class="ld-sel">${cnt}</select>
          <button id="ld-bidbtn" class="fr-mini">喊这个</button>
          <button id="ld-challenge" class="fr-mini ghost danger">开！</button>
        </div>`;
      root.querySelector('#ld-bidbtn').onclick = () => {
        const face = +root.querySelector('#ld-face').value;
        const count = +root.querySelector('#ld-count').value;
        if (!LiarsLogic.legalRaise(bid, count, face)) { Sound.invalid(); return; }
        doBid(count, face);
        ctx.net.send('ld_bid', { count, face, by: ctx.net.me });
      };
      root.querySelector('#ld-challenge').onclick = () => {
        if (!bid) { Sound.invalid(); return; }
        Sound.invalid();
        ctx.net.send('ld_challenge', { by: ctx.net.me });
      };
    }

    function doBid(count, face) {
      bid = { count, face, by: ctx.net.me };
      Sound.place();
      log(`<b>${ctx.net.me === 1 ? '红方' : '蓝方'}</b> 喊：${count} 个 ${face} 点`);
      current = 3 - ctx.net.me;
      renderBid(); renderStatus(); renderControls();
    }

    function challenge(by) {
      // by 是质疑方；bidder 需亮骰
      log(`<b>${by === 1 ? '红方' : '蓝方'}</b> 开！`);
      const bidder = 3 - by;
      // 我是 bidder？则亮自己的骰给质疑方
      if (ctx.net.me === bidder) {
        ctx.net.send('ld_reveal', { dice: myDice.slice(), player: ctx.net.me });
      }
      // 我是质疑方？等待对方亮骰后计算
    }

    function onReveal(dice, player) {
      // player 是亮骰方；我方（质疑方）据此计算
      mateDice = dice;
      const d1 = ctx.net.me === 1 ? myDice : dice;
      const d2 = ctx.net.me === 1 ? dice : myDice;
      const loser = LiarsLogic.resolve(bid, d1, d2);
      ctx.net.send('ld_result', { loser, dice1: d1, dice2: d2 });
      applyResult(loser, d1, d2);
    }

    function applyResult(loser, d1, d2) {
      lives[loser] = Math.max(0, lives[loser] - 1);
      Sound.match();
      log(`亮骰：红方 [${d1.join(',')}] 蓝方 [${d2.join(',')}] → <b>${loser === 1 ? '红方' : '蓝方'} 输 1 血</b>`);
      renderLives();
      bid = null; mateDice = null;
      if (lives[1] === 0 || lives[2] === 0) {
        over = true;
        const winner = lives[1] === 0 ? 2 : 1;
        const result = ctx.net.me === winner ? 'win' : 'lose';
        statusEl.textContent = (result === 'win' ? '🏆 你赢了！' : '😢 你输了') + ' 比分 ' + lives[1] + ' : ' + lives[2];
        restartBtn.hidden = false;
        ctx.reportPlay('liars', '吹牛', ctx.net.peerName, result);
        return;
      }
      // 输家开下一局
      startRound(loser);
    }

    function startRound(starter) {
      myDice = LiarsLogic.roll5();
      bid = null; current = starter; busy = false;
      renderMine(); renderBid(); renderStatus(); renderControls();
      log('— 新一局，' + (starter === 1 ? '红方' : '蓝方') + ' 先叫 —');
      ctx.net.send('ld_start', { starter });
    }

    // ---------- 事件 ----------
    const offs = [];
    offs.push(ctx.net.on('ld_start', (m) => {
      if (over) return;
      myDice = LiarsLogic.roll5();
      bid = null; current = m.starter;
      renderMine(); renderBid(); renderStatus(); renderControls();
      log('— 新一局，' + (m.starter === 1 ? '红方' : '蓝方') + ' 先叫 —');
    }));
    offs.push(ctx.net.on('ld_bid', (m) => {
      if (over) return;
      bid = m; current = 3 - m.by;
      Sound.place();
      log(`<b>${m.by === 1 ? '红方' : '蓝方'}</b> 喊：${m.count} 个 ${m.face} 点`);
      renderBid(); renderStatus(); renderControls();
    }));
    offs.push(ctx.net.on('ld_challenge', (m) => {
      if (over) return;
      challenge(m.by);
    }));
    offs.push(ctx.net.on('ld_reveal', (m) => {
      if (over) return;
      // 我方是质疑方才计算
      onReveal(m.dice, m.player);
    }));
    offs.push(ctx.net.on('ld_result', (m) => {
      if (over) return;
      applyResult(m.loser, m.dice1, m.dice2);
    }));
    offs.push(ctx.net.on('ld_restart', () => { lives = { 1: 3, 2: 3 }; over = false; restartBtn.hidden = true; startRound(1); }));

    restartBtn.onclick = () => {
      lives = { 1: 3, 2: 3 }; over = false; restartBtn.hidden = true;
      startRound(1);
      ctx.net.send('ld_restart');
    };

    // 初始
    renderMine(); renderLives(); renderBid(); renderStatus(); renderControls();
    // 房主(me=1)先叫：发一个开始信号让对方也开新局
    if (ctx.net.me === 1) ctx.net.send('ld_start', { starter: 1 });

    return {
      destroy() { offs.forEach((f) => f()); },
      restart() { lives = { 1: 3, 2: 3 }; over = false; restartBtn.hidden = true; startRound(1); ctx.net.send('ld_restart'); },
    };
  },
};

export { truthProb };
