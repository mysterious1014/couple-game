import gomoku from './gomoku.js';
import draw from './draw.js';
import reversi from './reversi.js';
import dots from './dots.js';
import memory from './memory.js';
import turtle from './turtle.js';
import liars from './liarsdice.js';
import uno from './uno.js';

// 想加新游戏：写一个模块（见 gomoku.js / draw.js 的格式），
// 在这里 import 并加到数组里即可，菜单会自动出现。
export const games = [gomoku, draw, reversi, dots, memory, turtle, liars, uno];
