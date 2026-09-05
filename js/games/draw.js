// 你画我猜模块。消息使用 dw_ 前缀。
// 双人模式：画家(默认1号)画，猜词者输入猜测，猜中后轮换。
// 人机模式（ctx.net.isAI）：AI 当画手，人类猜词；人类猜中后 AI 自动画下一幅。
// 笔迹用归一化坐标(0~1)传输，适配不同屏幕尺寸。

import { Sound } from '../sound.js';

const WORDS = [
  '猫', '狗', '太阳', '苹果', '雨伞', '飞机', '房子', '星星', '花', '鱼',
  '汽车', '蛋糕', '书', '时钟', '月亮', '树', '手机', '篮球', '眼镜', '帽子',
  '熊猫', '西瓜', '彩虹', '雪人', '钢琴', '气球', '灯塔', '风车', '蘑菇', '咖啡',
];

export default {
  id: 'draw',
  name: '你画我猜',
  desc: '一人画一人猜，笔迹实时同步',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="dw-status" class="dw-status"></div>
      <div id="dw-info" class="dw-info">
        <span id="dw-role"></span>
        <span id="dw-word"></span>
        <span id="dw-score"></span>
      </div>
      <div id="dw-canvasWrap"><canvas id="dw-canvas" width="600" height="400"></canvas></div>
      <div id="dw-tools" class="dw-tools"></div>
      <div id="dw-guessRow" class="dw-guess">
        <input id="dw-guessInput" placeholder="输入你猜的词，回车提交" />
        <button id="dw-guessBtn">猜！</button>
      </div>
      <div id="dw-feed" class="dw-feed"></div>
    `;

    const canvas = root.querySelector('#dw-canvas');
    const g = canvas.getContext('2d');
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const isAI = !!ctx.net.isAI;
    let drawer = isAI ? 2 : 1;   // 人机模式：AI 当画手(2号)
    let word = '';
    let score = { 1: 0, 2: 0 };
    let drawing = false;
    let last = null;
    let color = '#222222';

    const statusEl = root.querySelector('#dw-status');
    const roleEl = root.querySelector('#dw-role');
    const wordEl = root.querySelector('#dw-word');
    const scoreEl = root.querySelector('#dw-score');
    const toolsEl = root.querySelector('#dw-tools');
    const guessRow = root.querySelector('#dw-guessRow');
    const guessInput = root.querySelector('#dw-guessInput');
    const feed = root.querySelector('#dw-feed');

    const amDrawer = () => ctx.net.me === drawer;
    const isCorrect = (guess, w) => guess.trim() === w.trim();
    function clearCanvas() { g.clearRect(0, 0, canvas.width, canvas.height); }
    function newWord() { word = WORDS[Math.floor(Math.random() * WORDS.length)]; updateInfo(); }

    function updateInfo() {
      roleEl.textContent = amDrawer() ? '你负责画画，对方猜' : '你负责猜词，对方画';
      wordEl.textContent = amDrawer() ? ('词：' + word) : '';
      scoreEl.textContent = '比分  ' + ctx.net.myName + ' ' + (score[ctx.net.me] || 0) +
        ' : ' + (score[3 - ctx.net.me] || 0) + ' ' + ctx.net.peerName;
      toolsEl.style.display = amDrawer() ? 'flex' : 'none';
      guessRow.style.display = amDrawer() ? 'none' : 'flex';
    }

    function roundWin(winner) {
      Sound.match();
      // 人机模式：AI 始终是画手，人类猜中后 AI 直接画下一幅
      if (isAI) {
        score[1] = (score[1] || 0) + 1;
        clearCanvas();
        feed.innerHTML = '';
        statusEl.textContent = '你猜中啦！' + ctx.net.peerName + ' 正在画下一个…';
        updateInfo();
        if (ctx.reportPlay) ctx.reportPlay('draw', '你画我猜', ctx.net.peerName, 'win');
        ctx.net.aiNext();
        return;
      }
      score[winner] = (score[winner] || 0) + 1;
      drawer = winner;
      clearCanvas();
      feed.innerHTML = '';
      if (amDrawer()) newWord();
      updateInfo();
      statusEl.textContent = (winner === ctx.net.me ? '你' : '对方') + ' 猜中啦！换人画～';
    }

    // 调色盘与工具（仅画手可见）
    const colors = ['#222222', '#e74c3c', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad'];
    colors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'dw-color' + (i === 0 ? ' on' : '');
      b.style.background = c;
      b.onclick = () => { color = c; toolsEl.querySelectorAll('.dw-color').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
      toolsEl.appendChild(b);
    });
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空'; clearBtn.className = 'dw-act';
    clearBtn.onclick = () => { clearCanvas(); ctx.net.send('dw_clear'); };
    toolsEl.appendChild(clearBtn);
    const skipBtn = document.createElement('button');
    skipBtn.textContent = '换词'; skipBtn.className = 'dw-act';
    skipBtn.onclick = () => { if (amDrawer()) { newWord(); clearCanvas(); ctx.net.send('dw_clear'); } };
    toolsEl.appendChild(skipBtn);

    // 画图
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }
    function drawLine(from, to, c) {
      g.strokeStyle = c; g.lineWidth = 4;
      g.beginPath();
      g.moveTo(from.x * canvas.width, from.y * canvas.height);
      g.lineTo(to.x * canvas.width, to.y * canvas.height);
      g.stroke();
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (!amDrawer()) return;
      drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!amDrawer() || !drawing) return;
      const p = pos(e);
      drawLine(last, p, color);
      ctx.net.send('dw_draw', { from: last, to: p, color });
      last = p;
    });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // 猜词
    function addFeed(name, text, me) {
      const d = document.createElement('div');
      d.className = 'dw-msg ' + (me ? 'me' : 'peer');
      d.textContent = name + '：' + text;
      feed.appendChild(d);
      feed.scrollTop = feed.scrollHeight;
    }
    function guess() {
      const t = guessInput.value.trim();
      if (!t) return;
      ctx.net.send('dw_guess', { text: t, name: ctx.net.myName });
      addFeed(ctx.net.myName, t, true);
      guessInput.value = '';
    }
    guessInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') guess(); });
    root.querySelector('#dw-guessBtn').onclick = guess;

    // 网络
    const offs = [];
    offs.push(ctx.net.on('dw_draw', (m) => drawLine(m.from, m.to, m.color)));
    offs.push(ctx.net.on('dw_clear', () => { clearCanvas(); feed.innerHTML = ''; }));
    offs.push(ctx.net.on('dw_guess', (m) => {
      addFeed(m.name, m.text, false);
      if (isCorrect(m.text, word)) ctx.net.send('dw_correct', { winner: 3 - drawer });
    }));
    offs.push(ctx.net.on('dw_correct', (m) => {
      roundWin(m.winner);
      if (!isAI && ctx.reportPlay) ctx.reportPlay('draw', '你画我猜', ctx.net.peerName, m.winner === ctx.net.me ? 'win' : 'lose');
    }));
    offs.push(ctx.net.on('dw_hint', (m) => addFeed('提示', m.text, false)));
    offs.push(ctx.net.on('dw_ai_say', (m) => addFeed(ctx.net.peerName, m.text, false)));

    function restart() {
      score = { 1: 0, 2: 0 };
      clearCanvas();
      feed.innerHTML = '';
      if (isAI) {
        drawer = 2;
        ctx.net.aiStart();
      } else {
        drawer = 1;
        if (amDrawer()) newWord();
      }
      updateInfo();
      statusEl.textContent = '新的一局开始了！';
    }

    if (isAI) {
      // 人类是猜词方，AI 先画第一幅
      ctx.net.aiStart();
    } else if (amDrawer()) {
      newWord();
    }
    updateInfo();

    return { destroy() { offs.forEach((f) => f()); }, restart };
  },
};
