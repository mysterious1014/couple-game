// 建表语句生成（两个驱动共用，只有类型名不同）
const { COLLECTIONS, SEQ_COLUMN } = require('./schema');

function quote(name) { return '"' + name + '"'; }

function columnDdl(col, sqlType) {
  let sql = quote(col.name) + ' ' + sqlType(col.type);
  if (col.pk) sql += ' PRIMARY KEY';
  if (col.notNull) sql += ' NOT NULL';
  if (col.unique) sql += ' UNIQUE';
  return sql;
}

// extra 用 TEXT 而不是 json/jsonb：它只是「没登记字段的安全垫」，
// 永远按整串读写，不需要在数据库里查询它，两个引擎行为完全一致。
function createTableStatements(sqlType) {
  const out = [
    'CREATE TABLE IF NOT EXISTS meta (key ' + sqlType('TEXT') + ' PRIMARY KEY, value ' + sqlType('TEXT') + ' NOT NULL)',
  ];
  for (const def of COLLECTIONS) {
    const cols = def.columns.concat(SEQ_COLUMN).map((c) => columnDdl(c, sqlType));
    cols.push(quote('extra') + ' ' + sqlType('TEXT'));
    out.push('CREATE TABLE IF NOT EXISTS ' + quote(def.table) + ' (' + cols.join(', ') + ')');
    for (const idx of def.indexes || []) {
      out.push('CREATE INDEX IF NOT EXISTS ' + quote('idx_' + def.table + '_' + idx)
        + ' ON ' + quote(def.table) + ' (' + quote(idx) + ')');
    }
  }
  return out;
}

module.exports = { quote, createTableStatements };