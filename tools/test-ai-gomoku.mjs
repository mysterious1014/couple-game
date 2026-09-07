// 五子棋电脑 AI 无头对局测试（不需要浏览器，也不需要启动 server）
// 前端是原生 ES Modules 且仓库根没有 package.json，所以这里把 js/ 复制到临时目录，
// 补一个 { "type": "module" } 后再 import。用法：node tools/test-ai-gomoku.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couple-game-ai-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
fs.cpSync(path.join(repoRoot, 'js'), path.join(tmp, 'js'), { recursive: true });

const { AINet } = await import(pathToFileURL(path.join(tmp, 'js', 'ai.js')).href);

const GS = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inB = (r, c) => r >= 0 && r < GS && c >= 0 && c < GS;
const emptyBoard = () => Array.from({ length: GS }, () => new Array(GS).fill(0));

function wins(board, player) {
  for (let r = 0; r < GS; r++) {
    for (let c = 0; c < GS; c++) {
      if (board[r][c] !== player) continue;
      for (const [dr, dc] of DIRS) {
        let n = 1, rr = r + dr, cc = c + dc;
        while (inB(rr, cc) && board[rr][cc] === player) { n++; rr += dr; cc += dc; }
        if (n >= 5) return true;
      }
    }
  }
  return false;
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// 人类方用「随机邻着落子」这种很弱的策略，AI 必须在每一局都正常应招并分出终局
function playGame(diff, seed, maxPlies = 225) {
  const rand = seeded(seed);
  const net = new AINet(diff);
  net.beginGame('gomoku');
  const brain = net._brain;
  if (!brain) throw new Error(diff + ': createBrain 未返回实例');

  const board = emptyBoard();
  let aiMoves = 0;
  net.on('go_move', (d) => { if (d.by === 2) { aiMoves++; board[d.r][d.c] = 2; } });

  let plies = 0, winner = 0, stalled = false;
  for (let t = 0; t < maxPlies; t++) {
    plies++;
    const candidates = [];
    for (let r = 0; r < GS; r++) {
      for (let c = 0; c < GS; c++) {
        if (board[r][c] !== 0) continue;
        let near = false;
        for (let dr = -1; dr <= 1 && !near; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (inB(rr, cc) && board[rr][cc] !== 0) { near = true; break; }
          }
        }
        if (near) candidates.push([r, c]);
      }
    }
    let pick = candidates.length ? candidates[Math.floor(rand() * candidates.length)] : null;
    if (!pick && board[7][7] === 0) pick = [7, 7];
    if (!pick) {
      for (let r = 0; r < GS && !pick; r++)
        for (let c = 0; c < GS && !pick; c++)
          if (board[r][c] === 0) pick = [r, c];
    }
    if (!pick) break;

    board[pick[0]][pick[1]] = 1;
    if (wins(board, 1)) { winner = 1; break; }

    const before = aiMoves;
    brain.onHuman('go_move', { r: pick[0], c: pick[1] });
    clearTimeout(brain.timer);   // 绕过「思考延迟」计时器，让测试可以同步推进
    brain._move();
    if (aiMoves === before) { stalled = true; break; }
    if (wins(board, 2)) { winner = 2; break; }
  }
  net.destroy();
  return { plies, winner, aiMoves, stalled };
}

const GAMES_PER_LEVEL = Number(process.env.GOMOKU_AI_GAMES || 12);
let failures = 0;

for (const diff of ['easy', 'medium', 'hard']) {
  let aiWin = 0, humanWin = 0, unfinished = 0, stalled = 0, maxPlies = 0;
  for (let i = 1; i <= GAMES_PER_LEVEL; i++) {
    const r = playGame(diff, 1000 + i * 7);
    if (r.winner === 2) aiWin++;
    else if (r.winner === 1) humanWin++;
    else unfinished++;
    if (r.stalled) { stalled++; console.log(`  [${diff}] 第 ${i} 局 AI 未应招`); }
    maxPlies = Math.max(maxPlies, r.plies);
  }
  console.log(`${diff.padEnd(6)} AI胜=${aiWin} 人胜=${humanWin} 未终局=${unfinished} 僵持=${stalled} 最长=${maxPlies}手`);
  if (stalled > 0) failures++;
  if (unfinished > 0) failures++;
}

const net = new AINet('hard');
net.beginGame('gomoku');
const brain = net._brain;
brain.board[7][7] = 1;
brain.onHuman('go_restart', {});
const cleared = brain.board.every((row) => row.every((v) => v === 0));
console.log('go_restart 清空棋盘: ' + (cleared ? 'OK' : 'FAIL'));
if (!cleared) failures++;
net.destroy();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\n== 全部通过 ==' : `\n== 失败 ${failures} 项 ==`);
process.exit(failures === 0 ? 0 : 1);

