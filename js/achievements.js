// 战绩统计与成就（前端依据游玩记录实时计算，无需后端改动）
export function computeStats(records) {
  const sorted = records.slice().sort((a, b) => a.ts - b.ts);
  let wins = 0, loses = 0, draws = 0;
  const perGame = {};
  let cur = 0, max = 0;
  for (const r of sorted) {
    const g = perGame[r.gameId] || (perGame[r.gameId] = { name: r.gameName, win: 0, lose: 0, draw: 0 });
    if (r.result === 'win') { wins++; g.win++; cur++; if (cur > max) max = cur; }
    else if (r.result === 'lose') { loses++; g.lose++; cur = 0; }
    else { draws++; g.draw++; cur = 0; }
  }
  const total = records.length;
  return {
    total, wins, loses, draws,
    winRate: total ? Math.round((wins / total) * 100) : 0,
    currentStreak: cur, maxStreak: max,
    perGame,
    gamesPlayed: Object.keys(perGame).length,
  };
}

export const ACHIEVEMENTS = [
  { id: 'first', name: '初出茅庐', desc: '完成第一局游戏', check: (s) => s.total >= 1 },
  { id: 'win5', name: '小有胜绩', desc: '累计获胜 5 局', check: (s) => s.wins >= 5 },
  { id: 'win20', name: '常胜将军', desc: '累计获胜 20 局', check: (s) => s.wins >= 20 },
  { id: 'streak3', name: '三连胜', desc: '达成 3 连胜', check: (s) => s.maxStreak >= 3 },
  { id: 'streak10', name: '十连胜', desc: '达成 10 连胜', check: (s) => s.maxStreak >= 10 },
  { id: 'gomoku5', name: '棋逢对手', desc: '五子棋获胜 5 局', check: (s) => (s.perGame.gomoku?.win || 0) >= 5 },
  { id: 'draw5', name: '心有灵犀', desc: '你画我猜猜中 5 次', check: (s) => (s.perGame.draw?.win || 0) >= 5 },
  { id: 'allgames', name: '样样精通', desc: '每个游戏都玩过', check: (s) => s.gamesPlayed >= 2 },
  { id: 'tie10', name: '平局大师', desc: '累计平局 10 次', check: (s) => s.draws >= 10 },
  { id: 'century', name: '百战之士', desc: '累计游玩 100 局', check: (s) => s.total >= 100 },
];

export function evaluateAchievements(stats) {
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: !!a.check(stats) }));
}
