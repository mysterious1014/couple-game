// 「记住账号密码」模块的行为测试：在 Node 里跑真实的 js/remember.js（注入假 storage）。
// 重点验证混淆往返（含中文/emoji）、坏数据一律降级成「没记住」、存储不可用时不炸。
// 用法：node tools/test-remember.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
// 前端是原生 ESM 且仓库根没有 package.json：复制到临时目录补上 type:module 再 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-remember-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
fs.cpSync(path.join(repoRoot, 'js', 'remember.js'), path.join(tmp, 'remember.js'));
const M = await import(pathToFileURL(path.join(tmp, 'remember.js')).href);
const { encodeSecret, decodeSecret, createRemember, REMEMBER_KEY, USERNAME_KEY } = M;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  OK   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
function brokenStorage() {
  const boom = () => { throw new Error('SecurityError: storage disabled'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

console.log('\n== 混淆往返 ==');
const samples = [
  'hunter2', 'admin', 'p@ssw0rd!#$%', '情侣游戏站密码', '密码 with 英文 123',
  'emoji-🎮-mix', '&<>"\'', ' leading-and-trailing ', 'x'.repeat(200), '',
];
for (const s of samples) {
  check('roundtrip ' + JSON.stringify(s.length > 18 ? s.slice(0, 15) + '…' : s), () => {
    assert.strictEqual(decodeSecret(encodeSecret(s)), s);
  });
}
check('密文里看不到明文', () => {
  const blob = encodeSecret('supersecretpw');
  assert.ok(!blob.includes('supersecretpw'));
});
check('同明文同结果、不同明文不同结果（没退化成恒等）', () => {
  // 定长密钥 + 定长明文必然相同，这里确认的是「不会退化成恒等」
  assert.strictEqual(encodeSecret('aaaa'), encodeSecret('aaaa'));
  assert.notStrictEqual(encodeSecret('aaaa'), encodeSecret('aaaab'));
});
check('换密钥解不出来（说明密钥确实是必要的）', () => {
  const blob = encodeSecret('secret-pw');
  assert.notStrictEqual(decodeSecret(blob, 'wrong-key'), 'secret-pw');
});

console.log('\n== 存取行为 ==');
check('save / load 往返', () => {
  const r = createRemember(fakeStorage());
  r.save('xiaoming', '情侣密码123');
  assert.deepStrictEqual(r.load(), { username: 'xiaoming', password: '情侣密码123' });
});
check('没存过时 load 返回 null', () => {
  const r = createRemember(fakeStorage());
  assert.strictEqual(r.load(), null);
  assert.strictEqual(r.isRemembered(), false);
});
check('localStorage 里存的是混淆后的密码，不是明文', () => {
  const st = fakeStorage();
  createRemember(st).save('x', 'plainpassword');
  const raw = st.map.get(REMEMBER_KEY);
  assert.ok(raw && !raw.includes('plainpassword'), 'raw=' + raw);
});
check('save 顺带记住用户名（旧行为不回退）', () => {
  const st = fakeStorage();
  createRemember(st).save('chen', 'pw123456');
  assert.strictEqual(st.map.get(USERNAME_KEY), 'chen');
});
check('clear 只抹密码、留用户名', () => {
  const r = createRemember(fakeStorage());
  r.save('chen', 'pw123456');
  r.clear();
  assert.strictEqual(r.load(), null);
  assert.strictEqual(r.isRemembered(), false);
  assert.strictEqual(r.loadUsername(), 'chen');
});
check('saveUsername 不写密码记录', () => {
  const r = createRemember(fakeStorage());
  r.saveUsername('only-name');
  assert.strictEqual(r.load(), null);
  assert.strictEqual(r.loadUsername(), 'only-name');
});

console.log('\n== 坏数据一律降级 ==');
const badCases = {
  '非 JSON': 'not-json-at-all',
  '非法 base64': JSON.stringify({ v: 1, u: 'a', p: '!!!not base64!!!' }),
  '缺字段': JSON.stringify({ v: 1, u: 'a' }),
  '版本不对': JSON.stringify({ v: 99, u: 'a', p: encodeSecret('pw') }),
  '类型不对': JSON.stringify({ v: 1, u: 5, p: encodeSecret('pw') }),
  '空串': '',
};
for (const [name, payload] of Object.entries(badCases)) {
  check(name + ' → load() 为 null', () => {
    const st = fakeStorage({ [REMEMBER_KEY]: payload });
    const r = createRemember(st);
    assert.strictEqual(r.load(), null);
  });
}
check('坏数据会被顺手清掉，不留垃圾', () => {
  const st = fakeStorage({ [REMEMBER_KEY]: 'garbage' });
  const r = createRemember(st);
  r.load();
  assert.strictEqual(st.map.has(REMEMBER_KEY), false);
});

console.log('\n== 存储不可用（隐私模式 / 禁用 Cookie） ==');
check('读写全抛异常时不崩，且等于「没记住」', () => {
  const r = createRemember(brokenStorage());
  assert.strictEqual(r.save('a', 'b'), false);
  assert.strictEqual(r.load(), null);
  assert.strictEqual(r.loadUsername(), '');
  r.clear();
  assert.strictEqual(r.isRemembered(), false);
});
check('拿不到 window 时退回内存实现（Node 环境）', () => {
  const r = createRemember();
  assert.strictEqual(typeof globalThis.window, 'undefined');
  r.save('in-memory', 'pw-123');
  assert.deepStrictEqual(r.load(), { username: 'in-memory', password: 'pw-123' });
});

console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==`);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(failures === 0 ? 0 : 1);