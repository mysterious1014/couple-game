import gomoku from './gomoku.js';
import draw from './draw.js';

// 想加新游戏：写一个模块（见 gomoku.js / draw.js 的格式），
// 在这里 import 并加到数组里即可，菜单会自动出现。
export const games = [gomoku, draw];
