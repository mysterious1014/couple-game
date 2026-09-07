// 存储门面：对 server/index.js 暴露 { data, save, stats, ready, flush }。
// 底下可切换 SQLite（默认，本地开发/自托管）或 Postgres（线上，设了 DATABASE_URL 就启用）。
//
// 为什么 index.js 可以完全不感知数据库：
//   data 仍然是那 6 个内存集合，index.js 照旧 push/filter/改字段，save() 负责把变更落库。
//   落库策略：每个集合算一份 JSON 快照，跟上次落库的内容一样就整表跳过，
//   所以「登录一次」只会重写 users + sessions 两张小表，消息表再大也不受影响。
//
// ⚠️ 唯一的接口差异：Postgres 写入是异步的，save() 不再保证「返回时已落盘」。
//    因此本模块导出 ready（初始化完成）并在退出前 flush；改到 PG 时请 await ready 后再读 data。
const fs = require('fs');
const path = require('path');

const { COLLECTIONS, emptyData, toRows, fromRows, parseExtra } = require('./schema');
const { createSqliteDriver } = require('./sqlite');
const { prepareDriver, SCHEMA_VERSION } = require('./migrations');
const { createPostgresDriver } = require('./postgres');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const sqliteFile = process.env.DATABASE_FILE
  ? path.resolve(process.env.DATABASE_FILE)
  : path.join(dataDir, 'couple-game.sqlite');
const legacyJsonFile = path.join(dataDir, 'db.json');

// 把 pg 连接串里的密码打码，方便安全地写日志
function safeUrl(url) {
  return String(url).replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@');
}

function createDriver() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sslMode = process.env.PGSSLMODE || (/sslmode=(require|verify-full|no-verify)/.test(url) ? 'require' : 'disable');
    let ssl = false;
    if (sslMode === 'require') ssl = { rejectUnauthorized: false };
    else if (sslMode === 'no-verify') ssl = { rejectUnauthorized: false };
    else if (sslMode !== 'disable') ssl = true;
    return createPostgresDriver({ url, safeUrl: safeUrl(url), ssl });
  }
  return createSqliteDriver({ file: sqliteFile });
}

const driver = createDriver();
const data = emptyData();

// 写状态（loadAll 会用到，必须声明在它之前）
const snapshots = new Map();
const syncDriver = driver.kind === 'sqlite';

// ---------- 读 ----------
function normalizeRow(raw) {
  const out = {};
  for (const key of Object.keys(raw)) out[key] = raw[key];
  if ('extra' in raw) out.extra = parseExtra(raw.extra);
  return out;
}

async function loadAll() {
  for (const def of COLLECTIONS) {
    const rows = await driver.readRows(def);
    data[def.key] = fromRows(def, rows.map(normalizeRow));
  }
  for (const def of COLLECTIONS) snapshots.set(def.key, fingerprint(def));
}

// ---------- 写 ----------
let queue = Promise.resolve();
let dirty = false;
let running = false;
let lastError = null;

function fingerprint(def) {
  try { return JSON.stringify(data[def.key]); } catch { return null; }
}

function changedEntries() {
  const entries = [];
  for (const def of COLLECTIONS) {
    const now = fingerprint(def);
    if (snapshots.get(def.key) === now) continue;
    snapshots.set(def.key, now);
    entries.push({ def, rows: toRows(def, data[def.key]) });
  }
  return entries;
}

async function writeChanged() {
  const entries = changedEntries();
  if (!entries.length) return;
  try {
    await driver.writeTables(entries);
    lastError = null;
  } catch (e) {
    lastError = e.message;
    // 快照回退，下一次 save() 会把这些表再写一遍，不会因为一次失败就永久丢变更
    for (const { def } of entries) snapshots.delete(def.key);
    console.error('写入 ' + driver.kind + ' 失败（下次 save 会重试；重启会丢这部分变更）：' + e.message);
  }
}

function save() {
  if (syncDriver) { writeChanged(); return Promise.resolve(); }
  dirty = true;
  if (running) return queue;
  running = true;
  queue = (async () => {
    while (dirty) { dirty = false; await writeChanged(); }
  })().finally(() => { running = false; });
  return queue;
}

async function flush() {
  if (syncDriver) return writeChanged();
  while (running || dirty) {
    if (!running) save();
    await queue;
  }
}

// ---------- 旧版 JSON 一次性导入 ----------
async function migrateFromLegacyJson() {
  if (await driver.metaGet('json_imported_at')) return;
  // 文件不存在时不写标记：以后手工放回一份 db.json 仍会被导入
  if (!fs.existsSync(legacyJsonFile)) return;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8'));
  } catch (e) {
    await driver.metaSet('json_imported_at', 'failed:' + e.message);
    console.error('旧 db.json 解析失败，跳过导入：', e.message);
    return;
  }

  const imported = [];
  for (const def of COLLECTIONS) {
    if (def.kind === 'map') {
      if (!Object.keys(data.sessions).length && parsed[def.key] && typeof parsed[def.key] === 'object') {
        data[def.key] = Object.assign({}, parsed[def.key]);
        imported.push(def.key + '=' + Object.keys(data[def.key]).length);
      }
      continue;
    }
    if (data[def.key].length) continue;
    if (Array.isArray(parsed[def.key]) && parsed[def.key].length) {
      data[def.key] = parsed[def.key];
      imported.push(def.key + '=' + parsed[def.key].length);
    }
  }

  await driver.metaSet('json_imported_at', Date.now());
  await flush();

  const backup = path.join(dataDir, 'db.imported-' + Date.now() + '.json');
  try {
    fs.renameSync(legacyJsonFile, backup);
    console.log('已导入旧 db.json（' + (imported.join(' ') || '无数据') + '），原文件改名为 ' + path.basename(backup));
  } catch (e) {
    console.error('旧 db.json 改名失败（不影响运行，重复导入由 meta 标记挡住）：', e.message);
  }
}

// ---------- 初始化 ----------
const ready = (async () => {
  const mig = await prepareDriver(driver);
  if (mig.applied.length) console.log('已执行数据库迁移到 v' + mig.to + '（步骤：' + mig.applied.join(', ') + '）');
  await loadAll();
  await migrateFromLegacyJson();
  console.log('存储：' + driver.kind + ' @ ' + driver.location);
})().catch((e) => {
  console.error('数据库初始化失败：', e.message);
  throw e;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush().catch(() => {}).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
process.on('beforeExit', () => { flush().catch(() => {}); });

function stats() {
  const out = { driver: driver.kind, location: driver.location, schemaVersion: SCHEMA_VERSION, lastError };
  for (const def of COLLECTIONS) out[def.key] = Array.isArray(data[def.key]) ? data[def.key].length : Object.keys(data[def.key]).length;
  return out;
}

module.exports = { data, save, stats, ready, flush, driver, COLLECTIONS, SCHEMA_VERSION };