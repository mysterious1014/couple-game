// 结构版本与迁移脚本（SQLite / Postgres 共用一份定义）
//
// 加字段的正确姿势：
//   1) 在 schema.js 的对应表 columns 里加一项；
//   2) SCHEMA_VERSION +1，并在 MIGRATIONS 追加一条 up()（老库才会真的 ALTER）；
//   3) 跑 node tools/test-server-persistence.mjs 回归。
// 新库直接按最新定义建表；迁移里的 up() 都写成幂等（缺了才加），所以老库跳版也安全。
const { COLLECTIONS, SEQ_COLUMN } = require('./schema');

const SCHEMA_VERSION = 3;

// 补齐两张通用列：seq（行顺序）与 extra（未登记字段兜底）
async function ensureCommonColumns(driver) {
  const intType = driver.kind === 'postgres' ? 'BIGINT' : 'INTEGER';
  for (const def of COLLECTIONS) {
    const cols = await driver.listColumns(def.table);
    const missing = [];
    if (!cols.includes(SEQ_COLUMN.name)) missing.push([SEQ_COLUMN.name, intType]);
    if (!cols.includes('extra')) missing.push(['extra', 'TEXT']);
    for (const [name, type] of missing) await driver.addColumn(def.table, name, type);
  }
}

const MIGRATIONS = [
  { version: 2, name: '所有表加 seq 列（两个驱动行顺序一致）', up: ensureCommonColumns },
  { version: 3, name: '补齐 extra 列（旧版 sessions 表没有这一列，写会话会报错）', up: ensureCommonColumns },
];

// 建表（IF NOT EXISTS）+ 补齐缺列 + 记录结构版本；重复调用安全
async function prepareDriver(driver) {
  await driver.ensureSchema();
  const stored = Number(await driver.metaGet('schema_version') || 0);
  if (!stored) {
    await driver.metaSet('schema_version', SCHEMA_VERSION);
    return { from: 0, to: SCHEMA_VERSION, applied: [] };
  }
  if (stored > SCHEMA_VERSION) {
    throw new Error('数据库结构版本(' + stored + ') 高于代码版本(' + SCHEMA_VERSION + ')，请先升级代码');
  }
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version > stored) {
      await m.up(driver);
      await driver.metaSet('schema_version', m.version);
      applied.push(m.version);
    }
  }
  return { from: stored, to: SCHEMA_VERSION, applied };
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, prepareDriver, ensureCommonColumns };