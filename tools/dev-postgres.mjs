// 本地起一个真 Postgres 并跑 Postgres 驱动的持久化回归（不装依赖就不起，纯可选）。
//
//   cd server && npm i --no-save embedded-postgres   # 临时装，不进 package.json
//   node tools/dev-postgres.mjs                      # 建库 -> 跑持久化回归（Postgres 驱动）
//
// 想连线上那个真的 Postgres：直接把 URL 传给测试就行
//   node tools/test-server-persistence.mjs 4310 --url "postgres://user:pw@host:5432/db"
// ⚠️ 传进去的库会被先 DROP 掉本项目那 7 张表，别拿生产库当测试库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const requireFromServer = createRequire(path.join(serverDir, 'noop.js'));
const PORT = Number(process.argv[2] || 55432);
const APP_PORT = Number(process.argv[3] || 4399);
const DATABASE = 'cgtest';

// embedded-postgres 是纯 ESM 包（"type": "module"，只能 import 不能 require），
// 而它只装在 server/node_modules 下，本脚本在 tools/ 里，直接 import('embedded-postgres') 也找不到。
// 办法：用 createRequire 只解析出绝对路径（不加载），再 import() 那个 file:// URL。
// ⚠️ 别用 import.meta.resolve(name, parent)：Node 22 会忽略第二个参数，仍从 tools/ 往上找。
function resolveEmbeddedPackage() {
  try {
    return requireFromServer.resolve('embedded-postgres');
  } catch {
    const pkgDir = path.join(serverDir, 'node_modules', 'embedded-postgres');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const mapped = typeof pkg.exports === 'string'
      ? pkg.exports
      : (typeof pkg.exports?.['.'] === 'string'
        ? pkg.exports['.']
        : (pkg.exports?.['.']?.import || pkg.exports?.['.']?.default));
    if (!mapped) throw new Error('解析不到 embedded-postgres 的入口');
    return path.join(pkgDir, String(mapped).replace(/^\.\//, ''));
  }
}

async function loadEmbeddedPostgres() {
  const mod = await import(pathToFileURL(resolveEmbeddedPackage()).href);
  return mod.default ?? mod.EmbeddedPostgres;
}

let EmbeddedPostgres;
let pg;
try {
  EmbeddedPostgres = await loadEmbeddedPostgres();
  pg = requireFromServer('pg');
} catch (e) {
  console.log('没找到 embedded-postgres / pg（' + String(e.message).split('\n')[0] + '）。先执行：');
  console.log('  cd server && npm i --no-save embedded-postgres');
  console.log('（--no-save 不会写进 package.json，因此不影响 Render 构建）');
  process.exit(2);
}

const databaseDir = path.join(os.tmpdir(), 'couple-game-pg-' + Date.now());
const server = new EmbeddedPostgres({ databaseDir, user: 'cg', password: 'cg', port: PORT, persistent: false });

function runAppTest(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join('tools', 'test-server-persistence.mjs'), String(APP_PORT), '--url', url,
    ], { cwd: repoRoot, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let exitCode = 1;
try {
  await server.initialise();
  await server.start();
  console.log('[dev-postgres] 真 Postgres 已启动在 127.0.0.1:' + PORT);
  const admin = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'cg', password: 'cg', database: 'postgres' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ' + DATABASE);
  await admin.query('CREATE DATABASE ' + DATABASE);
  await admin.end();
  const version = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'cg', password: 'cg', database: DATABASE });
  await version.connect();
  console.log('[dev-postgres] ' + (await version.query('SELECT version() AS v')).rows[0].v);
  await version.end();
  exitCode = await runAppTest('postgres://cg:cg@127.0.0.1:' + PORT + '/' + DATABASE);
} catch (e) {
  console.error('[dev-postgres] 启动失败：', e.message);
  exitCode = 1;
} finally {
  await server.stop().catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(databaseDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 });
  console.log('[dev-postgres] 已停止并清理临时数据目录');
}
process.exit(exitCode);
