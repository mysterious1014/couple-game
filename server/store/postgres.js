// Postgres 驱动（pg 连接池）。用于线上部署：设置 DATABASE_URL 即自动启用。
//
// 与 SQLite 驱动实现同一组方法，所以 server/store/index.js 不关心底下是谁。
// ⚠️ 两个地方需要特别注意，都是 pg 的默认行为坑：
//   1) 时间戳用 BIGINT（INTEGER 装不下 1.7e12 的毫秒数）；
//      而 pg 默认把 int8 当字符串返回，所以这里注册了 int8 → Number 解析器。
//   2) 整表重写会一次插入很多行，用分块多值 INSERT，避免一行一个网络往返。
const { types } = require('pg');
const { Pool } = require('pg');
const { SEQ_COLUMN } = require('./schema');
const { quote, createTableStatements } = require('./ddl');

types.setTypeParser(20, (value) => (value === null ? null : Number(value)));   // int8
types.setTypeParser(1700, (value) => (value === null ? null : Number(value))); // numeric

const sqlType = (t) => (t === 'INTEGER' ? 'BIGINT' : 'TEXT');
const CHUNK_ROWS = 200;

function createPostgresDriver(options) {
  const pool = new Pool(Object.assign({
    connectionString: options.url,
    max: options.max || 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  }, options.ssl ? { ssl: options.ssl } : {}));

  async function run(client, sql, params) {
    return client.query(sql, params);
  }

  return {
    kind: 'postgres',
    location: options.safeUrl,

    async ensureSchema() {
      const client = await pool.connect();
      try {
        for (const sql of createTableStatements(sqlType)) await run(client, sql);
      } finally { client.release(); }
    },

    async listColumns(table) {
      const res = await pool.query(
        'SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1',
        [table],
      );
      return res.rows.map((r) => r.name);
    },

    async addColumn(table, name, type) {
      await pool.query('ALTER TABLE ' + quote(table) + ' ADD COLUMN ' + quote(name) + ' ' + type);
    },

    async readRows(def) {
      const res = await pool.query(
        'SELECT * FROM ' + quote(def.table) + ' ORDER BY ' + quote('seq') + ', ' + quote(def.columns[0].name),
      );
      return res.rows;
    },

    async writeTables(entries) {
      const client = await pool.connect();
      try {
        await run(client, 'BEGIN');
        for (const { def, rows } of entries) {
          await run(client, 'DELETE FROM ' + quote(def.table));
          const names = def.columns.concat(SEQ_COLUMN).map((c) => c.name).concat('extra');
          const cols = names.map(quote).join(', ');
          const perRow = names.map((_, i) => '$' + (i + 1)).join(', ');
          for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
            const chunk = rows.slice(start, start + CHUNK_ROWS);
            const values = [];
            const params = [];
            chunk.forEach((row, r) => {
              values.push('(' + names.map((_, i) => '$' + (r * names.length + i + 1)).join(', ') + ')');
              for (const name of names) params.push(row[name] === undefined ? null : row[name]);
            });
            if (values.length) {
              await run(client, 'INSERT INTO ' + quote(def.table) + ' (' + cols + ') VALUES ' + values.join(', '), params);
            }
          }
        }
        await run(client, 'COMMIT');
      } catch (e) {
        await run(client, 'ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async metaGet(key) {
      const res = await pool.query('SELECT value FROM meta WHERE key = $1', [key]);
      return res.rows.length ? res.rows[0].value : null;
    },

    async metaSet(key, value) {
      await pool.query(
        'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
        [key, String(value)],
      );
    },

    async close() { await pool.end(); },
  };
}

module.exports = { createPostgresDriver };