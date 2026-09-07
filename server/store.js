// 数据持久化：SQLite（better-sqlite3），单文件数据库，默认 server/data/couple-game.sqlite。
//
// 对外接口与旧版 JSON 存储完全一致：module.exports = { data, save }，
// 所以 server/index.js 里 `data.users.push(...)` / `data.records = ...filter(...)` / `save()`
// 这些写法都不用改。
//
// 行为：
//   启动：建表 -> 把表里的行读回内存对象（保持数组顺序）-> 若存在旧 db.json 则一次性导入
//   save()：一个事务里按表整表重写（数据量很小，且不可能出现内存与库不一致）
// 为什么保留内存对象：房间/在线状态本来就是内存态，且 index.js 大量依赖对象身份
// （例如 data.blocks.filter((x) => x !== rel)），改成逐条 SQL 会牵动 40 多处调用点。
//
// ⚠️ 新增集合/字段时：在下面的 TABLES 里加列即可；没在 TABLES 里声明的字段会自动落进
//    该行的 extra 列（JSON），不会丢，但也不可查询。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const dbFile = process.env.DATABASE_FILE
  ? path.resolve(process.env.DATABASE_FILE)
  : path.join(dataDir, 'couple-game.sqlite');
const legacyJsonFile = path.join(dataDir, 'db.json');

const SCHEMA_VERSION = 1;

// 与 index.js 约定的默认结构（新增集合时这里也要加，否则 load 后属性缺失）
function emptyData() {
  return { users: [], sessions: {}, records: [], friendships: [], blocks: [], messages: [] };
}
const data = emptyData();

const T = { TEXT: 'TEXT', INT: 'INTEGER' };
const TABLES = [
  {
    key: 'users', table: 'users',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'username', type: T.TEXT, notNull: true, unique: true },
      { name: 'nickname', type: T.TEXT },
      { name: 'password', type: T.TEXT },
      { name: 'role', type: T.TEXT },
      { name: 'score', type: T.INT },
      { name: 'createdAt', type: T.INT },
      { name: 'lastLogin', type: T.INT },
      { name: 'cpPartnerId', type: T.TEXT },
      { name: 'cpSince', type: T.INT },
      { name: 'cpCode', type: T.TEXT },
    ],
  },
  {
    key: 'records', table: 'game_records',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'userId', type: T.TEXT },
      { name: 'username', type: T.TEXT },
      { name: 'gameId', type: T.TEXT },
      { name: 'gameName', type: T.TEXT },
      { name: 'opponent', type: T.TEXT },
      { name: 'opponentUsername', type: T.TEXT },
      { name: 'result', type: T.TEXT },
      { name: 'ts', type: T.INT },
      { name: 'delta', type: T.INT },
    ],
    indexes: ['userId', 'ts'],
  },
  {
    key: 'friendships', table: 'friendships',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'userA', type: T.TEXT },
      { name: 'userB', type: T.TEXT },
      { name: 'status', type: T.TEXT },
      { name: 'requester', type: T.TEXT },
      { name: 'createdAt', type: T.INT },
    ],
    indexes: ['userA', 'userB'],
  },
  {
    key: 'blocks', table: 'blocks',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'blockerId', type: T.TEXT },
      { name: 'blockedId', type: T.TEXT },
      { name: 'createdAt', type: T.INT },
    ],
    indexes: ['blockerId', 'blockedId'],
  },
  {
    key: 'messages', table: 'messages',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'fromId', type: T.TEXT },
      { name: 'toId', type: T.TEXT },
      { name: 'type', type: T.TEXT },
      { name: 'text', type: T.TEXT },
      { name: 'roomCode', type: T.TEXT },
      { name: 'gameName', type: T.TEXT },
      { name: 'ts', type: T.INT },
      { name: 'read', type: T.INT, bool: true },
    ],
    indexes: ['toId', 'fromId', 'ts'],
  },
];
// ---------- 以下为存储引擎实现 ----------
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');      // 读写不互相阻塞，崩溃只丢最后一个事务
db.pragma('synchronous = NORMAL');    // WAL 下兼顾性能与掉电安全
db.pragma('busy_timeout = 5000');

function columnSql(col) {
  let sql = '"' + col.name + '" ' + col.type;
  if (col.pk) sql += ' PRIMARY KEY';
  if (col.notNull) sql += ' NOT NULL';
  if (col.unique) sql += ' UNIQUE';
  return sql;
}

function createSchema() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)');
  for (const table of TABLES) {
    const cols = table.columns.map(columnSql).concat('"extra" TEXT').join(', ');
    db.exec('CREATE TABLE IF NOT EXISTS "' + table.table + '" (' + cols + ')');
    for (const col of table.indexes || []) {
      db.exec('CREATE INDEX IF NOT EXISTS "idx_' + table.table + '_' + col + '" ON "' + table.table + '" ("' + col + '")');
    }
  }
}

function toStored(col, value) {
  if (col.bool) return value ? 1 : 0;
  if (col.type === T.INT) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return null;   // 对象/数组走 extra 列，不在此处丢失
  return String(value);
}

function fromStored(col, value) {
  if (col.bool) return !!value;
  return value === null || value === undefined ? null : value;
}

function toRow(table, item) {
  const row = { extra: null };
  for (const col of table.columns) row[col.name] = toStored(col, item ? item[col.name] : null);
  const colNames = new Set(table.columns.map((c) => c.name));
  const extra = {};
  for (const key of Object.keys(item || {})) {
    if (!colNames.has(key)) extra[key] = item[key];
  }
  if (Object.keys(extra).length) {
    try { row.extra = JSON.stringify(extra); } catch { row.extra = null; }
  }
  return row;
}

function fromRow(table, raw) {
  const item = {};
  for (const col of table.columns) item[col.name] = fromStored(col, raw[col.name]);
  if (raw.extra) {
    try { Object.assign(item, JSON.parse(raw.extra)); } catch { /* 忽略损坏的 extra */ }
  }
  return item;
}

const stmt = {};

function prepareStatements() {
  for (const table of TABLES) {
    const names = table.columns.map((c) => '"' + c.name + '"').concat('"extra"').join(', ');
    const params = table.columns.map((c) => '@' + c.name).concat('@extra').join(', ');
    stmt[table.table] = {
      del: db.prepare('DELETE FROM "' + table.table + '"'),
      ins: db.prepare('INSERT INTO "' + table.table + '" (' + names + ') VALUES (' + params + ')'),
      all: db.prepare('SELECT * FROM "' + table.table + '" ORDER BY rowid'),
    };
  }
  stmt.sessionsDel = db.prepare('DELETE FROM sessions');
  stmt.sessionsIns = db.prepare('INSERT INTO sessions (token, user_id) VALUES (@token, @userId)');
  stmt.sessionsAll = db.prepare('SELECT token, user_id AS userId FROM sessions ORDER BY rowid');
}

// 单个事务里整表重写：数据量很小（几百行级），换来的是「内存与库绝不错位」，
// 且不会出现旧版 JSON 那种写一半损坏的文件。
const writeAll = db.transaction(() => {
  for (const table of TABLES) {
    const rows = Array.isArray(data[table.key]) ? data[table.key] : [];
    stmt[table.table].del.run();
    for (const item of rows) stmt[table.table].ins.run(toRow(table, item));
  }
  stmt.sessionsDel.run();
  for (const [token, userId] of Object.entries(data.sessions || {})) {
    stmt.sessionsIns.run({ token, userId });
  }
});

function loadAll() {
  for (const table of TABLES) {
    data[table.key] = stmt[table.table].all.all().map((raw) => fromRow(table, raw));
  }
  data.sessions = {};
  for (const row of stmt.sessionsAll.all()) data.sessions[row.token] = row.userId;
}

function save() {
  try {
    writeAll();
  } catch (e) {
    console.error('写入 SQLite 失败（内存数据仍在，下次 save 会重试；但重启会丢这部分变更）：', e.message);
  }
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function checkSchemaVersion() {
  const stored = getMeta('schema_version');
  if (stored === null) { setMeta('schema_version', SCHEMA_VERSION); return; }
  if (Number(stored) > SCHEMA_VERSION) {
    console.error('数据库 schema 版本(' + stored + ') 高于代码版本(' + SCHEMA_VERSION + ')，请升级代码后再启动');
  } else if (Number(stored) < SCHEMA_VERSION) {
    // 以后的版本在这里逐级 ALTER TABLE
    setMeta('schema_version', SCHEMA_VERSION);
  }
}

// 一次性把旧版 server/data/db.json 导入 SQLite（只导入空的集合，不覆盖已有数据）
function migrateFromLegacyJson() {
  if (getMeta('json_imported_at')) return;
  if (!fs.existsSync(legacyJsonFile)) { setMeta('json_imported_at', 'skipped:no-file'); return; }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8'));
  } catch (e) {
    setMeta('json_imported_at', 'failed:' + e.message);
    console.error('旧 db.json 解析失败，跳过导入：', e.message);
    return;
  }

  const imported = [];
  for (const table of TABLES) {
    const current = Array.isArray(data[table.key]) ? data[table.key] : [];
    if (current.length) continue;
    if (Array.isArray(parsed[table.key]) && parsed[table.key].length) {
      data[table.key] = parsed[table.key];
      imported.push(table.key + '=' + parsed[table.key].length);
    }
  }
  if (!Object.keys(data.sessions).length && parsed.sessions && typeof parsed.sessions === 'object') {
    data.sessions = Object.assign({}, parsed.sessions);
    imported.push('sessions=' + Object.keys(data.sessions).length);
  }

  setMeta('json_imported_at', Date.now());
  save();

  const backup = path.join(dataDir, 'db.imported-' + Date.now() + '.json');
  try {
    fs.renameSync(legacyJsonFile, backup);
    console.log('已导入旧 db.json（' + (imported.join(' ') || '无数据') + '），原文件改名为 ' + path.basename(backup));
  } catch (e) {
    console.error('旧 db.json 改名失败（不影响运行，重复导入由 meta 挡住）：', e.message);
  }
}

function stats() {
  const out = { file: dbFile, schemaVersion: Number(getMeta('schema_version') || 0), jsonImportedAt: getMeta('json_imported_at') };
  for (const table of TABLES) out[table.key] = stmt[table.table].all.all().length;
  out.sessions = stmt.sessionsAll.all().length;
  return out;
}

createSchema();
checkSchemaVersion();
prepareStatements();
loadAll();
migrateFromLegacyJson();

module.exports = { data, save, stats, db, dbFile };