// 音效模块：使用 Web Audio API 实时合成，无需任何外部音频文件（方便静态部署）。
// 提供：落子/翻牌等交互音、配对成功音、以及胜利/失败/平局三种结算音。

let ctx = null;
let enabled = true;
try { enabled = localStorage.getItem('cg_sound') !== 'off'; } catch { /* 忽略 */ }

function getCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  } catch { ctx = null; }
  return ctx;
}

// 播放一个音符（指数包络，避免爆音）
function tone(freq, start, dur, type = 'sine', vol = 0.18) {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

export const Sound = {
  get enabled() { return enabled; },
  set enabled(v) {
    enabled = !!v;
    try { localStorage.setItem('cg_sound', enabled ? 'on' : 'off'); } catch { /* 忽略 */ }
  },
  // 在首次用户手势后调用，解锁浏览器音频自动播放限制
  unlock() {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  },
  // 落子 / 连线
  place() { if (!enabled) return; tone(523.25, 0, 0.07, 'triangle', 0.10); },
  // 翻牌
  click() { if (!enabled) return; tone(660, 0, 0.05, 'sine', 0.07); },
  // 配对成功 / 占领方格
  match() { if (!enabled) return; tone(784, 0, 0.10, 'triangle', 0.16); tone(1046.5, 0.09, 0.12, 'triangle', 0.16); },
  // 非法操作
  invalid() { if (!enabled) return; tone(150, 0, 0.16, 'sawtooth', 0.10); },
  // 胜利：上行欢快琶音
  win() {
    if (!enabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.11, 0.28, 'triangle', 0.20));
  },
  // 失败：下行柔和音
  lose() {
    if (!enabled) return;
    [392, 329.63, 261.63].forEach((f, i) => tone(f, i * 0.15, 0.32, 'sawtooth', 0.13));
  },
  // 平局：两声同音
  draw() {
    if (!enabled) return;
    tone(440, 0, 0.18, 'sine', 0.16);
    tone(440, 0.2, 0.18, 'sine', 0.16);
  },
};
