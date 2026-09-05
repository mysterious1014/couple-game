// 海龟汤（情境推理）模块。消息使用 tt_ 前缀。
// 玩家 1（房主/me=1）= 汤主（知道答案），玩家 2（客人）= 猜手（提问猜底）。
// 人机模式：人类是猜手，AI 是汤主（自动按关键词回答、判定猜测）。
// 汤主选好题目后双方都看到「汤面」（谜面）；汤主额外看到「汤底」。
// 猜手可随时提问（是/否类）或猜测答案；猜中即胜。

import { Sound } from '../sound.js';

// 题库：answerer 看到 answer；facts 用于 AI 关键词判定（kw 命中则按 ans 答）
const STORIES = [
  {
    id: 's1',
    title: '电梯里的陌生人',
    soup: '一个男人在电梯里按了 10 楼，电梯到了 5 楼，进来一个女人。男人看了女人一眼，脸色大变，立刻冲出电梯逃走了。',
    answer: '男人是小偷，口袋里装着刚偷来的东西。女人是便衣警察，男人认出了她制服露出的一角警徽，怕被抓所以逃跑。',
    facts: [
      { kw: ['警察', '便衣', '警', '抓', '抓我', '公安'], ans: 'yes' },
      { kw: ['小偷', '偷', '贼', '作案', '犯罪'], ans: 'yes' },
      { kw: ['认识', '熟人', '朋友', '亲戚'], ans: 'no' },
      { kw: ['鬼', '幽灵', '死人', '鬼魂', '灵异'], ans: 'no' },
      { kw: ['喜欢', '爱', '暗恋', '情人'], ans: 'no' },
      { kw: ['杀人', '凶手', '命案'], ans: 'no' },
    ],
    keys: ['小偷', '警察', '便衣', '逃走', '偷'],
  },
  {
    id: 's2',
    title: '沙漠里的两个人',
    soup: '两个人在沙漠里走，又渴又累。他们找到一顶帐篷，进去后发现一具尸体，旁边有根火柴。两人看了一眼，松了口气，继续赶路了。',
    answer: '两人是热气球驾驶员，热气球故障被迫减重，抽签用火柴决定谁跳下去。抽到半根火柴的人跳了（死了）。活下来的两人看到尸体，知道自己不用跳了，所以松了口气。',
    facts: [
      { kw: ['热气球', '气球', '飞', '空中'], ans: 'yes' },
      { kw: ['抽签', '火柴', '抽', '决定'], ans: 'yes' },
      { kw: ['跳', '跳下去', '跳楼'], ans: 'yes' },
      { kw: ['杀人', '谋杀', '杀', '凶手'], ans: 'no' },
      { kw: ['自杀'], ans: 'no' },
      { kw: ['鬼', '灵异', '诅咒'], ans: 'no' },
      { kw: ['沙暴', '渴死', '饿死'], ans: 'no' },
    ],
    keys: ['热气球', '抽签', '火柴', '跳', '减重'],
  },
  {
    id: 's3',
    title: '半夜的敲门声',
    soup: '一个女孩独自在家，半夜听到敲门声。她从猫眼看出去，门外没人。她回屋睡了。第二天，她在新闻上看到一则消息，吓得浑身发抖。',
    answer: '门外的其实是小偷/变态，他踩着梯子从猫眼往外看——女孩从猫眼看到的是小偷的眼睛。第二天新闻播报：附近有人专挑独居女孩，从猫眼确认家中有人后破门作案。',
    facts: [
      { kw: ['小偷', '贼', '入侵', '坏人', '变态'], ans: 'yes' },
      { kw: ['猫眼', '看', '眼睛', '盯着'], ans: 'yes' },
      { kw: ['鬼', '幽灵', '灵异'], ans: 'no' },
      { kw: ['朋友', '熟人', '家人', '亲戚'], ans: 'no' },
      { kw: ['快递', '外卖', '送'], ans: 'no' },
    ],
    keys: ['小偷', '猫眼', '眼睛', '独居', '破门'],
  },
  {
    id: 's4',
    title: '哥哥的遗书',
    soup: '一个男人在哥哥的葬礼上，对一个陌生女人一见钟情。葬礼结束后他到处找那个女人，却怎么也找不到。几天后，男人杀了另一个人。',
    answer: '男人想再见那个女人，但他只在家族葬礼上见过她。他认为"再办一场葬礼，那个女人就会再来"，于是杀了自己的亲人，好再办一次葬礼。',
    facts: [
      { kw: ['葬礼', '死人', '哥哥死', '办丧'], ans: 'yes' },
      { kw: ['为了再见', '想见', '见她', '钟情', '喜欢'], ans: 'yes' },
      { kw: ['意外', '事故'], ans: 'no' },
      { kw: ['仇杀', '报复', '仇恨'], ans: 'no' },
      { kw: ['鬼', '灵异'], ans: 'no' },
    ],
    keys: ['葬礼', '想见', '再办', '杀', '亲人'],
  },
  {
    id: 's5',
    title: '不能说的名字',
    soup: '一对情侣去海边玩，女孩在沙滩上写了一个男人的名字，写完后却哭了。男孩看了，什么也没说，默默把字抹平了。',
    answer: '那个名字是女孩的前任。女孩本来想坦白，但写着写着想起自己还放不下，又愧疚又难过所以哭了。男孩看懂了，没有追问，只是帮她抹平——选择包容过去。',
    facts: [
      { kw: ['前任', '前男友', '旧爱', '以前', 'ex'], ans: 'yes' },
      { kw: ['放不下', '忘不掉', '还爱', '愧疚'], ans: 'yes' },
      { kw: ['出轨', '劈腿', '背叛'], ans: 'no' },
      { kw: ['死', '去世', '车祸'], ans: 'no' },
      { kw: ['鬼', '灵异'], ans: 'no' },
    ],
    keys: ['前任', '放不下', '愧疚', '包容', '坦白'],
  },
];

function findStory(id) { return STORIES.find((s) => s.id === id) || STORIES[0]; }

export const TurtleLogic = {
  stories: STORIES,
  find: findStory,
  // AI 汤主：根据问题文本给出 是/否/无关/不确定
  answer(story, question) {
    const q = (question || '').toLowerCase();
    for (const f of story.facts) {
      const hit = f.kw.some((k) => q.includes(k.toLowerCase()));
      if (hit) return f.ans; // 'yes' | 'no' | ...
    }
    if (/(鬼|灵异|死人|幽灵)/.test(q)) return 'na';
    return 'unsure';
  },
  // AI 汤主：判定猜测是否正确
  verify(story, guess) {
    const g = (guess || '').toLowerCase();
    if (!g) return false;
    return story.keys.some((k) => g.includes(k.toLowerCase())) || g.includes(story.title.toLowerCase());
  },
};

export default {
  id: 'turtle',
  name: '海龟汤',
  desc: '悬疑推理，看你能不能问出真相',

  mount(ctx) {
    const root = ctx.root;
    root.innerHTML = `
      <div id="tt-soup" class="tt-soup"></div>
      <div id="tt-answer" class="tt-answer" hidden></div>
      <div id="tt-log" class="tt-log"></div>
      <div id="tt-guesser" class="tt-controls"></div>
      <div id="tt-answerer" class="tt-controls" hidden></div>
      <button id="tt-restart" class="c4-restart" hidden>换一题</button>
    `;
    const soupEl = root.querySelector('#tt-soup');
    const answerEl = root.querySelector('#tt-answer');
    const logEl = root.querySelector('#tt-log');
    const guesserEl = root.querySelector('#tt-guesser');
    const answererEl = root.querySelector('#tt-answerer');
    const restartBtn = root.querySelector('#tt-restart');

    const amAnswerer = !ctx.net.isAI && ctx.net.me === 1;
    let story = null;
    let over = false;

    function log(who, text, cls) {
      const d = document.createElement('div');
      d.className = 'tt-line ' + (cls || '');
      d.innerHTML = `<span class="tt-who">${who}：</span>${text}`;
      logEl.appendChild(d);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function renderSoup() {
      if (!story) return;
      soupEl.innerHTML = `<div class="tt-label">🍲 汤面</div>${escapeHtml(story.soup)}`;
      if (amAnswerer) {
        answerEl.hidden = false;
        answerEl.innerHTML = `<div class="tt-label">🥣 汤底（只有汤主可见）</div>${escapeHtml(story.answer)}`;
      } else {
        answerEl.hidden = true;
      }
    }

    function renderGuesser() {
      if (over) { guesserEl.innerHTML = ''; return; }
      guesserEl.innerHTML = `
        <input id="tt-q" placeholder="问一个问题（建议是/否类，如：和警察有关吗？）" maxlength="60" />
        <button id="tt-ask" class="fr-mini">提问</button>
        <input id="tt-g" placeholder="或者…猜猜真相？（输入你的答案）" maxlength="60" />
        <button id="tt-guess" class="fr-mini ghost">猜答案</button>
        <button id="tt-giveup" class="fr-mini ghost danger">放弃看答案</button>`;
      const q = guesserEl.querySelector('#tt-q');
      const g = guesserEl.querySelector('#tt-g');
      guesserEl.querySelector('#tt-ask').onclick = () => {
        const t = q.value.trim(); if (!t) return;
        q.value = '';
        log('🕵️ 猜手', escapeHtml(t));
        ctx.net.send('tt_question', { text: t });
      };
      guesserEl.querySelector('#tt-guess').onclick = () => {
        const t = g.value.trim(); if (!t) return;
        g.value = '';
        log('🕵️ 猜手', '我猜：' + escapeHtml(t));
        ctx.net.send('tt_guess', { text: t });
      };
      guesserEl.querySelector('#tt-giveup').onclick = () => {
        if (confirm('确定放弃？将显示答案，本局你输。')) {
          if (ctx.net.isAI) finish(false);   // AI 模式下人类即猜手，本地直接结算
          ctx.net.send('tt_giveup', {});
        }
      };
    }

    function renderAnswerer() {
      if (over) { answererEl.innerHTML = ''; return; }
      answererEl.innerHTML = `
        <div class="tt-tip">你是汤主，根据提问自由回答：</div>
        <div class="tt-ans-btns">
          <button class="fr-mini" data-a="yes">✅ 是</button>
          <button class="fr-mini" data-a="no">❌ 否</button>
          <button class="fr-mini" data-a="na">🚫 无关</button>
          <button class="fr-mini" data-a="unsure">❓ 不确定</button>
        </div>
        <div class="tt-tip">猜手猜答案时，由你判定：</div>
        <div class="tt-ver-btns" hidden>
          <button class="fr-mini" data-v="1">✔️ 猜对了</button>
          <button class="fr-mini ghost danger" data-v="0">✖️ 没猜中</button>
        </div>`;
      answererEl.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = () => {
          const map = { yes: '是', no: '不是', na: '无关', unsure: '不确定，换种问法' };
          const t = map[b.dataset.a];
          log('🍲 汤主', escapeHtml(t));
          ctx.net.send('tt_answer', { text: t, type: b.dataset.a });
        };
      });
      answererEl.querySelectorAll('[data-v]').forEach((b) => {
        b.onclick = () => {
          const correct = b.dataset.v === '1';
          ctx.net.send('tt_verify', { correct });
          answererEl.querySelector('.tt-ver-btns').hidden = true;
        };
      });
    }

    function showVerifyButtons() {
      if (amAnswerer) {
        const v = answererEl.querySelector('.tt-ver-btns');
        if (v) v.hidden = false;
      }
    }

    function finish(correct) {
      over = true;
      const result = amAnswerer ? (correct ? 'lose' : 'win') : (correct ? 'win' : 'lose');
      Sound[result === 'win' ? 'win' : 'lose'] && Sound[result === 'win' ? 'win' : 'lose']();
      log('📣', correct ? '猜手猜中了真相！' : '猜手放弃了 / 没猜中，汤主守住了秘密。', 'tt-final');
      if (amAnswerer) {
        answerEl.hidden = false;
        answerEl.innerHTML = `<div class="tt-label">🥣 汤底</div>${escapeHtml(story.answer)}`;
      }
      restartBtn.hidden = false;
      ctx.reportPlay('turtle', '海龟汤', ctx.net.peerName, result);
    }

    // ---------- 事件 ----------
    const offs = [];
    offs.push(ctx.net.on('tt_select', (m) => {
      story = findStory(m.storyId);
      renderSoup();
      log('📜', '新题目已发：' + escapeHtml(story.title));
    }));
    offs.push(ctx.net.on('tt_question', (m) => {
      if (!amAnswerer) log('🕵️ 猜手', escapeHtml(m.text));
      else { log('🕵️ 猜手', escapeHtml(m.text)); showVerifyButtons(); }
    }));
    offs.push(ctx.net.on('tt_answer', (m) => {
      if (amAnswerer) return;
      const cls = m.type === 'yes' ? 'tt-yes' : m.type === 'no' ? 'tt-no' : m.type === 'na' ? 'tt-na' : 'tt-un';
      log('🍲 汤主', escapeHtml(m.text), cls);
    }));
    offs.push(ctx.net.on('tt_guess', (m) => {
      if (!amAnswerer) return;
      log('🕵️ 猜手', '我猜：' + escapeHtml(m.text));
      showVerifyButtons();
    }));
    offs.push(ctx.net.on('tt_verify', (m) => { if (!over) finish(m.correct); }));
    offs.push(ctx.net.on('tt_giveup', () => { if (!over) finish(false); }));

    restartBtn.onclick = () => {
      over = false; restartBtn.hidden = true;
      ctx.net.send('tt_restart', {});
      newRound();
    };
    offs.push(ctx.net.on('tt_restart', () => { if (!over) { over = false; restartBtn.hidden = true; newRound(); } }));

    function newRound() {
      logEl.innerHTML = '';
      if (amAnswerer) {
        story = STORIES[Math.floor(Math.random() * STORIES.length)];
        renderSoup();
        renderAnswerer();
        log('📜', '新题目已发：' + escapeHtml(story.title));
        ctx.net.send('tt_select', { storyId: story.id });
      } else {
        renderGuesser();
      }
    }

    // 启动：汤主（me=1 / AI）选题目
    if (amAnswerer) {
      story = STORIES[Math.floor(Math.random() * STORIES.length)];
      renderSoup(); renderAnswerer();
      log('📜', '新题目已发：' + escapeHtml(story.title));
      ctx.net.send('tt_select', { storyId: story.id });
    } else {
      renderGuesser();
      if (ctx.net.isAI) ctx.net.aiStart(); // AI 汤主选题目并发 tt_select
    }

    return {
      destroy() { offs.forEach((f) => f()); },
      restart() { over = false; restartBtn.hidden = true; ctx.net.send('tt_restart', {}); newRound(); },
    };
  },
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
