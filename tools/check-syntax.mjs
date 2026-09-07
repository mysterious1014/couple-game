// 语法检查：前端是原生 ES Modules，而仓库根目录没有 package.json（无 type:module），
// 直接 `node --check js/app.js` 会被当作 CommonJS 而误报。
// 这里把每个前端文件复制成临时 .mjs 再检查；server/ 与 tools/ 本身是 CJS，直接检查。
// 用法：node tools/check-syntax.mjs [仓库根相对路径...]   不带参数 = 检查全部
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((a) => path.resolve(repoRoot, a))
  : [...walk(path.join(repoRoot, 'js')), ...walk(path.join(repoRoot, 'server'))];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-check-'));
let failures = 0;

for (const file of targets) {
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  const isCjs = rel.startsWith('server/') || rel.startsWith('tools/');
  const checkFile = isCjs ? file : path.join(tmpDir, path.basename(file, '.js') + '.mjs');
  if (!isCjs) fs.copyFileSync(file, checkFile);
  try {
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe' });
    console.log('OK   ' + rel);
  } catch (err) {
    failures += 1;
    console.log('FAIL ' + rel);
    console.log(String(err.stderr).trim().split('\n').slice(0, 6).join('\n'));
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures ? failures + ' 个文件语法错误' : '全部 ' + targets.length + ' 个文件语法通过');
process.exit(failures ? 1 : 0);
