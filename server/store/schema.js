// 存储层的数据定义与行映射（两个驱动共用，不含任何 SQL 引擎代码）。
//
// 内存对象结构（index.js 直接用的那份）：
//   users/records/friendships/blocks/messages -> 对象数组
//   sessions                                  -> { sessionToken: userId }
// 落库时一一对应到表；列以外的字段自动进 extra(JSON) 列，因此加字段不会丢数据。
//
// ⚠️ 新增集合：emptyData() 和 COLLECTIONS 都要加。
// ⚠️ 新增字段：在对应 columns 里加一列；如果是要改结构（比如加 NOT NULL），
//    记得在 MIGRATIONS 里补一条，老库才会真正 ALTER。

const T = { TEXT: 'TEXT', INT: 'INTEGER' };

function emptyData() {
  return { users: [], sessions: {}, records: [], friendships: [], blocks: [], messages: [] };
}

const COLLECTIONS = [
  {
    key: 'users', table: 'users', kind: 'list',
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
    key: 'records', table: 'game_records', kind: 'list',
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
    key: 'friendships', table: 'friendships', kind: 'list',
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
    key: 'blocks', table: 'blocks', kind: 'list',
    columns: [
      { name: 'id', type: T.TEXT, pk: true },
      { name: 'blockerId', type: T.TEXT },
      { name: 'blockedId', type: T.TEXT },
      { name: 'createdAt', type: T.INT },
    ],
    indexes: ['blockerId', 'blockedId'],
  },
  {
    key: 'messages', table: 'messages', kind: 'list',
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
  {
    // 会话是 { token: userId } 映射，用 kind:'map' 特殊处理
    key: 'sessions', table: 'sessions', kind: 'map',
    columns: [
      { name: 'token', type: T.TEXT, pk: true },
    // 列名沿用旧版 user_id，避免与已存在的库/索引名不一致
      { name: 'user_id', type: T.TEXT },
    ],
    indexes: ['user_id'],
  },
];

// 每张表都有一列 seq 记录数组下标：两个驱动都按 seq 排序读回，行顺序才不会漂。
const SEQ_COLUMN = { name: 'seq', type: T.INT };

function columnNames(def) {
  return def.columns.concat(SEQ_COLUMN).map((c) => c.name);
}

function toStored(col, value) {
  if (col.bool) return value ? 1 : 0;
  if (col.type === T.INT) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return null;   // 对象走 extra，不在这里被字符串化
  return String(value);
}

function fromStored(col, value) {
  if (col.bool) return !!value;
  if (value === undefined || value === null) return null;
  // Postgres 的整数列是 BIGINT(int8)，pg 驱动默认按字符串返回（怕精度溢出）。
  // 驱动层注册了 int8 -> Number 的 parser，这里再兜一道：绝不让 "1000" 混进内存，
  // 否则 index.js 里 score += 20 会变成字符串拼接。
  if (col.type === T.INT) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

// list 集合：内存对象 -> 数据库行
function toRow(def, item, seq) {
  const names = new Set(def.columns.map((c) => c.name));
  const row = { extra: null, seq };
  const extra = {};
  for (const col of def.columns) {
    const value = item ? item[col.name] : null;
    if (value !== null && typeof value === 'object') {
      extra[col.name] = value;
      row[col.name] = null;
    } else {
      row[col.name] = toStored(col, value);
    }
  }
  for (const key of Object.keys(item || {})) {
    if (!names.has(key)) extra[key] = item[key];
  }
  if (Object.keys(extra).length) {
    try { row.extra = JSON.stringify(extra); } catch { row.extra = null; }
  }
  return row;
}

function fromRow(def, raw) {
  const item = {};
  for (const col of def.columns) item[col.name] = fromStored(col, raw[col.name]);
  if (raw.extra !== null && raw.extra !== undefined) {
    const extra = typeof raw.extra === 'string' ? JSON.parse(raw.extra) : raw.extra;
    if (extra && typeof extra === 'object') Object.assign(item, extra);
  }
  return item;
}

function toRows(def, value) {
  if (def.kind === 'map') {
    const keyCol = def.columns[0].name;
    const valCol = def.columns[1].name;
    return Object.entries(value || {}).map(([token, userId], seq) => {
      const row = { extra: null, seq };
      row[keyCol] = token;
      row[valCol] = userId;
      return row;
    });
  }
  const list = Array.isArray(value) ? value : [];
  return list.map((item, seq) => toRow(def, item, seq));
}

function fromRows(def, rows) {
  if (def.kind === 'map') {
    const map = {};
    const keyCol = def.columns[0].name;
    const valCol = def.columns[1].name;
    for (const raw of rows) map[raw[keyCol]] = raw[valCol];
    return map;
  }
  return rows.map((raw) => fromRow(def, raw));
}

function parseExtra(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = {
  T, COLLECTIONS, SEQ_COLUMN, emptyData,
  columnNames, toStored, fromStored, toRow, fromRow, toRows, fromRows, parseExtra,
};