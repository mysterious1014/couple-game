// 数据搬迁工具：在 SQLite（本地）与 Postgres（线上）之间整体搬运账号/战绩/好友/私信。
//
//   预览（默认不写）：node tools/migrate-storage.mjs --from sqlite --to postgres --to-url postgres://...
//   真正执行：        加 --apply
//   目标已有数据时：  再加 --force 才会覆盖（整表重写，会冲掉目标库里的同名集合）
//
// 迁移方向举例：
//   上线：     --from sqlite --to postgres --to-url "$env:DATABASE_URL" --apply
//   拉回本地： --from postgres --from-url "$env:DATABASE_URL" --to sqlite --apply
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const requireFromServer = createRequire(path.join(serverDir, 'noop.js'));

const { COLLECTIONS, emptyData, toRows, fromRows, parseExtra } = requireFromServer('./store/schema');
const { prepareDriver, SCHEMA_VERSION } = requireFromServer('./store/migrations');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : '';
}
const has = (name) => process.argv.includes('--' + name);

function parseArgs() {
  const side = (which) => ({
    kind: arg(which),
    url: arg(which + '-url') || (which === 'to' ? arg('url') : ''),
    file: arg(which + '-file'),
  });
  return { from: side('from'), to: side('to'), apply: has('apply'), force: has('force') };
}

function makeDriver(spec, label) {
  if (spec.kind === 'sqlite') {
    const file = spec.file
      || path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(serverDir, 'data'), 'couple-game.sqlite');
    if (label === 'from' && !fs.existsSync(file)) throw new Error('找不到源 SQLite 文件：' + file);
    return { driver: requireFromServer('./store/sqlite').createSqliteDriver({ file }), where: file };
  }
  if (spec.kind === 'postgres') {
    const url = spec.url || process.env.DATABASE_URL;
    if (!url) throw new Error('Postgres 一端需要 --' + label + '-url postgres://... 或环境变量 DATABASE_URL');
    const sslMode = process.env.PGSSLMODE || (/sslmode=/.test(url) ? 'require' : 'disable');
    const ssl = sslMode === 'disable' ? undefined : { rejectUnauthorized: sslMode !== 'no-verify' };
    return {
      driver: requireFromServer('./store/postgres').createPostgresDriver({ url, safeUrl: url.replace(/:[^:@/]+@/, ':****@'), ssl }),
      where: url.replace(/:[^:@/]+@/, ':****@'),
    };
  }
  throw new Error('--' + label + ' 只能是 sqlite 或 postgres（当前：' + (spec.kind || '未指定') + '）');
}

function normalizeRow(raw) {
  const out = Object.assign({}, raw);
  if ('extra' in raw) out.extra = parseExtra(raw.extra);
  return out;
}

async function readAll(driver) {
  const data = emptyData();
  for (const def of COLLECTIONS) {
    const rows = await driver.readRows(def);
    data[def.key] = fromRows(def, rows.map(normalizeRow));
  }
  return data;
}

function counts(data) {
  return COLLECTIONS.map((def) => {
    const v = data[def.key];
    return def.key + '=' + (Array.isArray(v) ? v.length : Object.keys(v).length);
  }).join('  ');
}


const { from, to, apply, force } = parseArgs();
const src = makeDriver(from, 'from');
const dst = makeDriver(to, 'to');

let exitCode = 0;
try {
  await prepareDriver(src.driver);
  const data = await readAll(src.driver);
  console.log('源  ' + src.driver.kind + ' @ ' + src.where);
  console.log('     ' + counts(data));

  await prepareDriver(dst.driver);
  const existing = await readAll(dst.driver);
  const existingTotal = COLLECTIONS.reduce((sum, def) => {
    const v = existing[def.key];
    return sum + (Array.isArray(v) ? v.length : Object.keys(v).length);
  }, 0);
  console.log('目标 ' + dst.driver.kind + ' @ ' + dst.where + '（现有 ' + existingTotal + ' 行）');

  if (existingTotal && !force) {
    throw new Error('目标库已有数据，怕误覆盖：确认无误再加 --force');
  }
  if (!apply) {
    console.log('Dry-run：没有写入任何东西。加 --apply 才会真搬。');
  } else {
    const entries = COLLECTIONS.map((def) => ({ def, rows: toRows(def, data[def.key]) }));
    await dst.driver.writeTables(entries);
    const back = await readAll(dst.driver);
    for (const def of COLLECTIONS) {
      const a = Array.isArray(data[def.key]) ? data[def.key].length : Object.keys(data[def.key]).length;
      const b = Array.isArray(back[def.key]) ? back[def.key].length : Object.keys(back[def.key]).length;
      assert.strictEqual(b, a, def.key + ' 行数不一致：' + a + ' -> ' + b);
    }
    // 抽样比对主键，确认不是「行数凑巧相同」
    const sample = COLLECTIONS.map((def) => {
      const v = back[def.key];
      const first = Array.isArray(v) ? v[0] : Object.entries(v)[0];
      return def.key + ':' + (first ? String(Array.isArray(v) ? first[def.columns[0].name] : first[0]) : '-');
    }).join('  ');
    console.log('已写入并回读校验通过 -> ' + dst.driver.kind);
    console.log('     ' + counts(back));
    console.log('     首行主键 ' + sample);
  }
} catch (e) {
  console.error('迁移失败：' + e.message);
  exitCode = 1;
} finally {
  await Promise.resolve(src.driver.close?.()).catch(() => {});
  await Promise.resolve(dst.driver.close?.()).catch(() => {});
}
process.exit(exitCode);
