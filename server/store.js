// 极简文件存储：把用户、会话、游玩记录存在 server/data/db.json。
// 用「写临时文件 + 重命名」保证原子写入，避免并发写损坏。
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'data', 'db.json');
const tmp = file + '.tmp';

let data = { users: [], sessions: {}, records: [], friendships: [], blocks: [], messages: [] };

function load() {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    data = Object.assign({ users: [], sessions: {}, records: [], friendships: [], blocks: [], messages: [] }, parsed);
  } catch {
    // 文件不存在或损坏则使用空数据
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('保存数据库失败：', e.message);
  }
}

load();

module.exports = { data, save };
