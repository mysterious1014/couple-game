// 自动上线：触发 Render Deploy Hook，并验证线上内容确实等于当前 commit。
//
// 为什么需要它：本服务的 rootDir=server，Render 官方规则是「rootDir 之外的改动不触发
// Auto-Deploy」，而站点前端（index.html / style.css / js/**）全在仓库根 —— 也就是说
// 绝大多数改动 push 之后线上并不会自己更新，必须显式戳一下。这个脚本就是那「一下」。
//
// 用法：
//   node tools/render-deploy.mjs              触发部署 → 等待 → 校验线上 == HEAD
//   node tools/render-deploy.mjs --verify     只校验线上是否已等于 HEAD（不触发部署）
//   node tools/render-deploy.mjs --no-verify  只触发，不等结果
//
// Deploy Hook URL 的读取顺序（密钥一律不进 Git）：
//   1) 环境变量 RENDER_DEPLOY_HOOK_URL
//   2) 文件 RENDER_DEPLOY_HOOK_FILE（默认 E:/codex/.secrets/render-deploy-hook-couple-game.txt）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const BASE_URL = (process.env.SITE_URL || 'https://chenting.cc.cd').replace(/\/+$/, '');
const HOOK_FILE = process.env.RENDER_DEPLOY_HOOK_FILE
  || 'E:/codex/.secrets/render-deploy-hook-couple-game.txt';
const FLAGS = new Set(process.argv.slice(2));
const VERIFY_ONLY = FLAGS.has('--verify') || FLAGS.has('--check');
const NO_VERIFY = FLAGS.has('--no-verify');
const ALL_FILES = FLAGS.has('--all');
const WAIT_TOTAL = Number(process.env.DEPLOY_WAIT_MS || 300000);   // 最多等 5 分钟
const POLL_MS = 10000;

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function masked(url) {
  return url.replace(/([?&]key=)[^&]*/i, '$1***');
}

function readHookUrl() {
  const fromEnv = (process.env.RENDER_DEPLOY_HOOK_URL || '').trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(HOOK_FILE)) {
    const v = fs.readFileSync(HOOK_FILE, 'utf8').trim();
    if (v) return v;
  }
  return null;
}

// 仓库里会被 express.static 直接公开的文件（含 HANDOFF/README，见 §11 坑 12）（server/** 属于后端，线上无对应公开路径）
function servableFiles(ref) {
  const changed = ALL_FILES
    ? git('ls-tree', '-r', '--name-only', ref)
    : git('show', '--pretty=format:', '--name-only', ref);
  return changed.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((f) => f === 'index.html' || f === 'style.css' || f === 'HANDOFF.md' || f === 'README.md'
      || (f.startsWith('js/') && f.endsWith('.js')))
    .filter((f) => {
      try { git('cat-file', '-e', ref + ':' + f); return true; } catch { return false; }
    });
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// 逐个比对「线上内容」与「git 里该 commit 的内容」，返回不一致的文件
async function verifyRef(ref) {
  const short = git('rev-parse', '--short', ref).trim();
  const files = servableFiles(ref);
  if (!files.length) return { ok: true, ref: short, files: [], checked: 0, note: '该 commit 没有前端文件改动' };
  const bad = [];
  for (const f of files) {
    const expected = git('show', ref + ':' + f).replace(/\r\n/g, '\n');
    let actual = null;
    let err = null;
    try { actual = (await fetchText(BASE_URL + '/' + f + '?cb=' + short)).replace(/\r\n/g, '\n'); }
    catch (e) { err = e.message; }
    if (err || actual !== expected) bad.push({ file: f, reason: err || ('内容不一致 线上 ' + (actual || '').length + 'B / 期望 ' + expected.length + 'B') });
  }
  return { ok: bad.length === 0, ref: short, files, checked: files.length, bad };
}

async function health() {
  try { return JSON.parse(await fetchText(BASE_URL + '/api/health')); }
  catch (e) { return { ok: false, error: e.message }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = readHookUrl();
  if (!url) {
    console.error('找不到 Deploy Hook URL。设置 RENDER_DEPLOY_HOOK_URL，或写入 ' + HOOK_FILE);
    process.exitCode = 2;
    return;
  }
  if (!VERIFY_ONLY && !NO_VERIFY) {
    console.log('触发部署 → ' + masked(url));
    const res = await fetch(url, { method: 'POST' }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
    const status = res.status;
    if (res._err) console.log('请求异常：' + res._err + '（Render 偶尔会对 POST 重定向，改用 GET 重试）');
    if (res._err || status >= 400) {
      const res2 = await fetch(url, { method: 'GET', redirect: 'follow' }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
      if (res2._err || !res2.ok) {
        console.error('触发失败：HTTP ' + res2.status + ' ' + res2._err);
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('已接受：HTTP ' + status + '（200=新建部署，202=已有部署在跑）');
    }
  }
  if (NO_VERIFY) { console.log('已触发，跳过校验。'); return; }

  if (VERIFY_ONLY) {
    const v = await verifyRef('HEAD');
    const h = await health();
    console.log('health：' + (h.ok ? JSON.stringify(h) : '不可用 ' + h.error));
    if (v.note) { console.log('OK(无前端改动) ' + v.note); if (!h.ok) { process.exitCode = 1; } return; }
    console.log((v.ok ? 'YES 线上 == ' : 'NO  线上还没到 ') + v.ref + '（比对 ' + v.checked + ' 个公开文件）');
    (v.bad || []).forEach((b) => console.log('   - ' + b.file + '：' + b.reason));
    if (!v.ok || !h.ok) process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + WAIT_TOTAL;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await sleep(attempt === 1 ? 25000 : POLL_MS);
    const v = await verifyRef('HEAD');
    const h = await health();
    console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] 第 ' + attempt + ' 次检查：'
      + (v.ok ? '线上 == ' + v.ref : v.ref + ' 尚未生效（' + v.bad.map((b) => b.file).join(', ') + '）')
      + '；health ' + (h.ok ? h.driver + '/v' + h.schemaVersion : '不可用'));
    if (v.ok && h.ok) { console.log('✅ 上线完成：' + BASE_URL + ' 已反映 ' + v.ref); return; }
    if (Date.now() > deadline) {
      console.error('❌ 超时：' + BASE_URL + ' 还没有更新到 ' + v.ref);
      if (v.bad) v.bad.slice(0, 5).forEach((b) => console.error('   - ' + b.file + '：' + b.reason));
      console.error('   去后台看构建日志：https://dashboard.render.com/web/srv-dadbu0ajnfac73fa5100/deploys');
      process.exitCode = 1;
      return;
    }
  }
}

main().catch((e) => { console.error('出错：' + e.message); process.exitCode = 1; });