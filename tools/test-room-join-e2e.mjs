// 房间进房的双浏览器端到端回归（需要本机有 Edge/Chrome + playwright，否则自动 SKIPPED）。
// 自己起隔离端口的本地服务 + 临时 DATA_DIR，绝不连线上库。
// 用法：node tools/test-room-join-e2e.mjs [端口]
// 可选：设环境变量 SHOT_DIR 会把大厅截图存到该目录（人工复核观感用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || 4480);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 环境探测：缺 playwright 或缺浏览器就跳过，不算失败 ----------
function findPlaywright() {
  const dirs = [path.join(os.homedir(), '.cache', 'codex-runtimes'), repoRoot];
  const hit = [];
  const walk = (dir, depth) => {
    if (depth > 5 || hit.length) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'playwright' && fs.existsSync(path.join(full, 'package.json'))) { hit.push(full); return; }
      if (e.name === 'node_modules' || depth < 3) walk(full, depth + 1);
    }
  };
  for (const d of dirs) { walk(d, 0); if (hit.length) break; }
  if (!hit.length) return null;
  try {
    const req = createRequire(path.join(path.dirname(hit[0]), 'noop.cjs'));
    return req('playwright');
  } catch { return null; }
}
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

const pw = findPlaywright();
const exe = findBrowser();
if (!pw) {
  console.log('SKIPPED  没找到 playwright，跳过双浏览器回归（服务端判据请看 tools/test-room-join.mjs）');
  process.exit(0);
}
const { chromium } = pw;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-room-join-e2e-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const server = spawn(process.execPath, ['index.js'], {
  cwd: path.join(repoRoot, 'server'),
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
  stdio: 'ignore',
});

async function api(p, o = {}) {
  const r = await fetch(BASE + p, Object.assign({ headers: { 'Content-Type': 'application/json' } }, o));
  return { status: r.status, ok: r.ok, text: await r.text(), headers: r.headers };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    if ((await api('/api/health').catch(() => ({}))).ok) return;
    await sleep(500);
  }
  throw new Error('本地服务未启动');
}
// 只在本地临时库里造测试号，不碰线上数据
async function ensure(username, nickname) {
  const password = 'pw123456';
  let r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username, password, nickname }) });
  if (!r.ok) r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error('准备账号失败 ' + r.text);
  await sleep(40);                       // 用户 id 取自 Date.now()，同毫秒会撞
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
}

const out = [];
const check = (label, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : `  [${detail}]`));
const text = async (pg, sel) => ((await pg.locator(sel).textContent().catch(() => '')) || '').trim();

let failures = 0;
let browser = null;
async function stopServer() {
  if (!server.killed && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, sleep(4000)]);   // 等它退出，否则 Windows 上 sqlite 文件还锁着
  }
  await sleep(200);
}
try {
  await waitForServer();
  const cookieOf = { alice: await ensure('e2e_alice', '小A'), bob: await ensure('e2e_bob', '小B'), carol: await ensure('e2e_carol', '小C') };
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const open = async (key) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: 'sid', value: key.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const pg = await ctx.newPage();
    pg.on('dialog', (d) => d.accept());
    await pg.goto(BASE + '/');
    return pg;
  };
  const hostSeat = async (pg) => { await pg.waitForSelector('#room:not([hidden])', { timeout: 25000 }); };
  const seats = async (pg) => ({ host: await text(pg, '#hostName'), guest: await text(pg, '#guestName') });

  // ---- 第一轮：A 建房，B 从公开列表进入 ----
  const A = await open(cookieOf.alice);
  await A.click('#createBtn');
  await hostSeat(A);
  const code1 = await text(A, '#roomCodeBig');
  const B = await open(cookieOf.bob);
  await B.waitForSelector(`.pr-item[data-code="${code1}"]`, { timeout: 25000 });
  await B.click(`.pr-item[data-code="${code1}"]`);
  await hostSeat(B);
  await A.waitForFunction(() => { const g = document.getElementById('guestName'); return g && !g.classList.contains('empty'); }, { timeout: 20000 }).catch(() => {});
  const na = await seats(A); const nb = await seats(B);
  check('房主侧看到访客昵称', na.guest === '小B', na.guest);
  check('房主侧房主栏是自己', na.host === '小A', na.host);
  check('访客侧房主栏是真房主（不是自己）', nb.host === '小A', nb.host);
  check('访客侧访客栏是自己', nb.guest === '小B', nb.guest);

  // ---- 第三人：列表里那间已满的房应当置灰不可点（省一次请求），手输房号仍由服务端 409 挡住 ----
  const C = await open(cookieOf.carol);
  const itemSel = `.pr-item[data-code="${code1}"]`;
  await C.waitForSelector(itemSel, { timeout: 25000 });
  check('第三人看到的已满房间被标成不可点', await C.locator(itemSel).evaluate((el) => el.classList.contains('full') && el.dataset.full === '1' && el.getAttribute('aria-disabled') === 'true'), await C.locator(itemSel).getAttribute('class'));
  const cssC = await C.locator(itemSel).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, cursor: cs.cursor, code: getComputedStyle(el.querySelector('.pr-code')).color, tag: getComputedStyle(el.querySelector('.pr-tag')).color };
  });
  check('已满房间看起来是灰的（降透明度 + 禁用指针 + 文字变灰）',
    Number(cssC.opacity) < 1 && cssC.cursor === 'not-allowed' && cssC.code === cssC.tag, JSON.stringify(cssC));
  if (process.env.SHOT_DIR) {
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    await C.screenshot({ path: path.join(process.env.SHOT_DIR, 'lobby-room-full.png') });
  }
  await C.click(itemSel);
  await sleep(1200);
  check('点已满房间不会进房（前端就拦下）', await C.locator('#room').isHidden(), 'roomHidden=' + await C.locator('#room').isHidden());
  check('点已满房间有轻提示并刷新列表', (await text(C, '#appToast')).includes('两个人'), await text(C, '#appToast'));
  check('点已满房间不该报「加入失败」（没打到服务端）', !/加入失败/.test(await text(C, '#lobbyHint')), await text(C, '#lobbyHint'));
  await C.locator('#roomInput').fill(code1);
  await C.click('#joinBtn');
  await C.waitForFunction(() => /房间已满/.test(document.getElementById('lobbyHint').textContent || ''), { timeout: 15000 }).catch(() => {});
  const hintC = await text(C, '#lobbyHint');
  check('手输房号仍被服务端 409 挡住', /加入失败/.test(hintC) && /房间已满/.test(hintC), hintC);
  check('第三人被服务端挡住：仍在大厅', await C.locator('#room').isHidden(), 'roomHidden=' + await C.locator('#room').isHidden());
  check('第三人被挡住：房主侧没多出访客（仍是小B）', (await seats(A)).guest === '小B', (await seats(A)).guest);

  // ---- 悄悄话双向 ----
  await A.locator('#chatInput').fill('第一句来自房主'); await A.click('#chatSend'); await sleep(1500);
  check('访客收到房主的悄悄话', (await B.locator('#chatLog .chat-msg').count()) >= 1, await B.locator('#chatLog .chat-msg').count());
  await B.locator('#chatInput').fill('回访一句'); await B.click('#chatSend'); await sleep(1500);
  check('房主收到访客的悄悄话', (await A.locator('#chatLog .chat-msg').count()) >= 2, await A.locator('#chatLog .chat-msg').count());

  // ---- 开局 + 落子同步（座位登记改了 guestPeerId，这里确认没把 P2P 带坏）----
  await A.locator('#roomGameList .room-game-card', { hasText: '五子棋' }).click({ timeout: 10000 });
  await sleep(1000);
  check('访客同步到房主选的游戏', (await text(B, '#selectedGameName')) === '五子棋', await text(B, '#selectedGameName'));
  await A.click('#startGameBtn');
  await A.waitForSelector('#game:not([hidden])', { timeout: 15000 }).catch(() => {});
  await B.waitForSelector('#game:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('双方都进入对局', (await A.locator('#game').isVisible()) && (await B.locator('#game').isVisible()));
  const cellCount = (pg) => pg.locator('#go-board .go-cell.red, #go-board .go-cell.yellow').count().catch(() => -1);
  const before = await cellCount(B);
  await A.locator('#go-board .go-cell').nth(7 * 15 + 7).click({ timeout: 8000 }).catch(() => {});
  await sleep(3000);
  const after = await cellCount(B);
  check('房主落子同步到访客', after === before + 1, `${before} -> ${after}`);
  await A.click('#backBtn').catch(() => {}); await B.click('#backBtn').catch(() => {});
  await sleep(1000);

  // ---- 新增：访客点「离开房间」让出座位后，第三人不用等 TTL 就能进 ----
  await B.click('#leaveRoomBtn');
  await B.waitForSelector('#lobby:not([hidden])', { timeout: 15000 }).catch(() => {});
  await sleep(800);
  await C.locator('#roomInput').fill(code1);
  await C.click('#joinBtn');
  await C.waitForSelector('#room:not([hidden])', { timeout: 25000 }).catch(() => {});
  const nc = await seats(C);
  check('访客离座后第三人立刻能进', await C.locator('#room').isVisible(), nc.host + ' / ' + nc.guest);
  check('第三人视角里房主仍是小A', nc.host === '小A', nc.host);
  check('房主侧看到的访客换成了小C', (await seats(A)).guest === '小C', (await seats(A)).guest);

  // ---- 房主重开一间后访客仍能进（验 Net 实例换新时订阅没丢）----
  await A.click('#leaveRoomBtn');
  await sleep(1200);
  await A.click('#createBtn');
  await hostSeat(A);
  const code2 = await text(A, '#roomCodeBig');
  await B.waitForSelector(`.pr-item[data-code="${code2}"]`, { timeout: 25000 });
  await B.click(`.pr-item[data-code="${code2}"]`);
  await hostSeat(B);
  await A.waitForFunction(() => { const g = document.getElementById('guestName'); return g && !g.classList.contains('empty'); }, { timeout: 20000 }).catch(() => {});
  check('再开一间：房主侧有访客', (await seats(A)).guest === '小B', (await seats(A)).guest);
  check('再开一间：访客侧房主仍是小A', (await seats(B)).host === '小A', (await seats(B)).host);

  // ---- 人机模式没被这套改动带坏 ----
  const D = await open(cookieOf.carol);
  await D.click('#vsAIBtn');
  await D.locator('[data-diff]').first().click();
  await hostSeat(D);
  await D.locator('#roomGameList .room-game-card', { hasText: '五子棋' }).click({ timeout: 10000 });
  await sleep(800);
  check('人机：房主栏是自己、访客栏是电脑', (await seats(D)).host === '小C' && (await text(D, '#guestName')).length > 0, JSON.stringify(await seats(D)));
  await D.click('#startGameBtn');
  await D.waitForSelector('#game:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('人机：能开局', await D.locator('#game').isVisible());
} catch (e) {
  failures++;
  out.push('FAIL 脚本异常  [' + (e && e.message ? e.message : String(e)) + ']');
}

// 报告先打印，再做清理：清理失败（临时库文件被占用等）绝不能盖掉测试结果
console.log(out.join('\n'));
const bad = out.filter((l) => l.startsWith('FAIL')).length + failures;
console.log(bad ? `RESULT: ${bad} 项失败` : 'RESULT: 全部通过');
if (browser) await browser.close().catch(() => {});
await stopServer();
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 });
} catch {
  console.log('NOTE   临时数据目录没删掉，可手动清理：' + tmp);
}
process.exit(bad ? 1 : 0);