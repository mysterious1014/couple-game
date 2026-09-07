// SQLite 驱动（better-sqlite3）。同步 API，全部方法都返回普通值，门面层 await 也能用。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { COLLECTIONS, SEQ_COLUMN } = require('./schema');
const { quote, createTableStatements } = require('./ddl');

const sqlType = (t) => t;   // SQLite 的 TEXT / INTEGER 就是原生类型

function createSqliteDriver(options) {
  const file = options.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');      // 读写不互相阻塞；崩溃只丢最后一个事务
  db.pragma('synchronous = NORMAL');    // WAL 下兼顾性能与掉电安全
  db.pragma('busy_timeout = 5000');

  const inserters = new Map();
  function inserter(def) {
    if (!inserters.has(def.table)) {
      const names = def.columns.concat(SEQ_COLUMN).map((c) => c.name).concat('extra');
      const params = names.map((n) => '@' + n).join(', ');
      const sql = 'INSERT INTO ' + quote(def.table) + ' (' + names.map(quote).join(', ')
        + ') VALUES (' + params + ')';
      inserters.set(def.table, db.prepare(sql));
    }
    return inserters.get(def.table);
  }

  return {
    kind: 'sqlite',
    location: file,

    ensureSchema() {
      for (const sql of createTableStatements(sqlType)) db.exec(sql);
    },

    listColumns(table) {
      return db.prepare('PRAGMA table_info(' + quote(table) + ')').all().map((r) => r.name);
    },

    addColumn(table, name, type) {
      db.exec('ALTER TABLE ' + quote(table) + ' ADD COLUMN ' + quote(name) + ' ' + type);
    },

    readRows(def) {
      return db
        .prepare('SELECT * FROM ' + quote(def.table) + ' ORDER BY ' + quote('seq') + ', ' + quote(def.columns[0].name))
        .all();
    },

    writeTables(entries) {
      const run = db.transaction(() => {
        for (const { def, rows } of entries) {
          db.prepare('DELETE FROM ' + quote(def.table)).run();
          const ins = inserter(def);
          for (const row of rows) ins.run(row);
        }
      });
      run();
    },

    metaGet(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    metaSet(key, value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
    },

    close() { db.close(); },
  };
}

module.exports = { createSqliteDriver, COLLECTIONS };