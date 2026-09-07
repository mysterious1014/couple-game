# 项目交接文档 · 情侣双人游戏站（couple-game）

> 面向接手本项目的 AI / 开发者。读完本文档应能：跑起项目、理解架构、新增一款游戏、避开已知的坑。
> 生成日期：2026-09-07 ｜ 代码版本：`1ae578c`（共 13 次提交）｜ 状态：功能完整，可本地运行 & 已部署 Render

---

## 1. 项目是什么

一个**异地双人实时对战的网页小游戏站**，主打情侣同玩。核心特点：

- **8 款双人对战小游戏**（五子棋 / 你画我猜 / 黑白棋 / 点格棋 / 记忆翻牌 / 海龟汤 / 吹牛 / UNO）
- **两种对战模式**：真人 P2P（PeerJS / WebRTC）与 **人机对战**（8 款游戏全部内置 AI，三档难度）
- **社交**：好友系统（请求 / 备注 / 分组 / 拉黑）、好友私聊、房间邀请、情侣（CP）绑定
- **成长**：账号、积分、段位、成就徽章、战绩明细、情侣积分排行榜

设计目标是**轻量**：无前端构建步骤（原生 ES Modules），后端单进程 Express + JSON 文件存储，整体源码约 350KB。

---

## 2. 快速开始

```bash
cd couple-game/server
npm install          # 仅两个依赖：express、peer
npm start            # 等价于 node index.js
```

然后打开 **http://localhost:3000**

> ⚠️ **依赖和启动命令都在 `server/` 子目录里，仓库根目录没有 package.json**（根目录只有前端源码）。
> `npm install` / `npm start` 必须在 `server/` 下执行，否则报 `ENOENT: Could not read package.json`。
> 交接包已实测通过：`cd server && npm install`（108 个包，约 4 秒）→ `npm start` → 首页 200。

- **默认管理员**：`admin` / `888888`（积分固定 99999，不参与排名）
- 端口：默认 `3000`，生产环境读 `process.env.PORT`
- PeerJS 信令服务器挂载在同进程的 `/peerjs` 路径（**不要改成公共 PeerJS 云**，国内网络连不通，见 §11 坑 3）
- 首次启动会自动创建 `server/data/db.json` 并种入管理员账号

单机体验双人对战：开两个浏览器标签页，一个「创建房间」，另一个输入 4 位房间号「加入」。
单机体验人机：大厅点「和电脑玩」→ 选难度 → 选游戏。

---

## 3. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 HTML / CSS / JS（**ES Modules**） | 无构建、无框架、无打包。改完刷新即生效 |
| 通信 | PeerJS（WebRTC 点对点） | 服务端同时运行自建 PeerJS 信令服务 |
| 后端 | Node.js（≥18）+ Express 4 | 单文件 `server/index.js`，同时托管静态资源与 `/api` |
| 存储 | JSON 文件 `server/data/db.json` | 原子写（临时文件 + rename） |
| 部署 | Render（Blueprint，`render.yaml`） | Free 计划，Manual Deploy |

**依赖只有两个**（`server/package.json`）：
```json
"express": "^4.19.2",
"peer": "^1.0.2"
```
保持依赖极少是刻意选择，请勿随意引入前端框架或构建工具。

---

## 4. 目录结构与文件职责

```
couple-game/
├── index.html              # 唯一页面：所有「屏」+ 所有弹窗 DOM 都在这里
├── style.css               # 全部样式（约 49KB），粉色深色主题 + 响应式
├── README.md               # 面向用户的：本地运行 / Render 部署 / 绑域名
├── render.yaml             # Render Blueprint 部署配置（rootDir: server）
├── .gitignore              # 忽略 node_modules / server/data / push-to-github.bat
│
├── js/
│   ├── app.js              # ★ 主控：路由切换、房间流程、大厅、公开房间轮询、心跳
│   ├── net.js              # ★ 通信层 Net 类（PeerJS 封装）：host/join/send/on
│   ├── ai.js               # ★ AI：AINet 类（与 Net 同接口）+ 8 个游戏大脑 + createBrain
│   ├── auth.js             # 登录/注册/登出、Auth.me 状态、战绩上报 reportPlay
│   ├── views.js            # 「我的战绩」「管理后台」「排行榜」视图渲染 + tierOf 段位
│   ├── friends.js          # 好友页：三标签（好友/请求/黑名单）、私聊、邀请
│   ├── achievements.js     # 依据战绩实时计算统计与 10 个成就徽章（纯前端）
│   ├── sound.js            # Web Audio 实时合成音效（无音频文件）
│   └── games/
│       ├── registry.js     # ★ 游戏注册表（数组，加游戏只需改这里）
│       ├── gomoku.js       # 五子棋      消息前缀 go_
│       ├── draw.js         # 你画我猜    消息前缀 dw_
│       ├── reversi.js      # 黑白棋      消息前缀 rev_
│       ├── dots.js         # 点格棋      消息前缀 dots_
│       ├── memory.js       # 记忆翻牌    消息前缀 mem_
│       ├── turtle.js       # 海龟汤      消息前缀 tt_
│       ├── liarsdice.js    # 吹牛        消息前缀 ld_
│       └── uno.js          # UNO         消息前缀 uno_
│
└── server/
    ├── index.js            # ★ 后端全部接口（32 个路由）与房间内存表
    ├── store.js            # JSON 文件读写（原子写）
    ├── package.json
    └── data/db.json        # 运行时数据（被 gitignore，不含在交接包中）
```

### 页面结构（`index.html`）
用 `hidden` 属性做单页多屏切换，由 `js/app.js` 的 `hideAll()` 统一控制：

| 屏 | id | 说明 |
|---|---|---|
| 大厅 | `#lobby` | 昵称、创建/加入房间、公开房间列表、游戏入口 |
| 房间 | `#room` | 房间号、玩家列表、房主设置面板 `#hostPanel`、进入者等待 `#guestPanel` |
| 游戏 | `#game` | 游戏容器 `#gameRoot`，由所选游戏模块 `mount` 填充 |
| 战绩 | `#profile` | 我的战绩 + 成就 + 记录明细 |
| 后台 | `#admin` | 管理员：用户列表、全部记录、删除用户 |
| 排行 | `#rank` | 情侣积分排行榜 |
| 好友 | `#friends` | 好友三标签页 |

弹窗：`#resultModal`（结算）、`#aiModal`（难度）、`#authModal`（登录/注册）、`#cpModal`（CP 绑定）、`#recModal`（战绩详情）、`#chatModal`（私聊）。
常驻浮动：悄悄话面板 `#chatPanel`、重新打开按钮 `#chatLauncher`、装饰背景层 `#decoBg`、未读通知区 `#notifyArea`。

---

## 5. 架构要点

### 5.1 通信层可替换（关键设计）
`get net()` 返回两种实现之一，二者**接口一致**，游戏模块完全无需关心对面是人还是 AI：

- **真人对战** → `js/net.js` 的 `Net` 类：`await net.host(name, username)` / `await net.join(code, name, pwd, username)`，内部走 PeerJS，`/peerjs` 信令，`/api/rooms` 做房间号↔peerId 映射。
- **人机对战** → `js/ai.js` 的 `AINet` 类：不联网，把消息直接路由到本地「大脑」，进入游戏时 `AINet.beginGame(gameId)` 创建对应 Brain。

共享接口：`net.me`（1=房主/红方，2=加入者/蓝方）、`net.peerName`、`net.isAI`、`net.roomCode`、`net.isHost`、`net.send(type, data)`、`net.on(type, cb)`、`net.onStatus(cb)`。
**给 AI 加任何新能力前，先确认 `AINet` 是否也实现了，否则人机模式会静默失效。**

### 5.2 房间生命周期
- 房主 `POST /api/rooms` 得到 4 位数字房间号（0001–9999 顺序分配），把自己的真实 peerId 注册到服务端。
- 加入者 `POST /api/rooms/:code/join` → 服务端校验密码 → 返回房主 peerId → 建立 P2P。
- **仅登录用户创建的无密码房间进入公开列表**（防止游客房间刷屏）。
- 房主每 30s 心跳 `POST /api/rooms/:code/heartbeat`；服务端每 30s 扫描，**90s 无心跳自动删房**；另有 24h 兜底清理。
- 返回大厅 → `DELETE /api/rooms/:code`；直接关标签页 → `beforeunload` 用 `navigator.sendBeacon` 打 `/close`。

### 5.3 后端
Express 单文件，顺序即大致职责：静态托管 → 屏蔽 `/server` 源码 → 鉴权 → 房间 → 好友 → CP → 消息 → 排行榜 → 后台。
会话：httpOnly Cookie + 内存 `sessions`；密码：Node `crypto.scrypt` 加盐哈希。

---

## 6. 核心契约

### 6.1 游戏模块契约

每个游戏导出默认对象：

```js
export default {
  id: 'gomoku',                    // 唯一 id，用于战绩/AI 注册/文案例名
  name: '五子棋',                   // 大厅卡片标题
  desc: '15×15 棋盘，先连成五子者胜', // 卡片副标题
  mount(ctx) { return { destroy(), restart() }; },
};
```

`ctx` 提供：

| 字段 | 用途 |
|---|---|
| `ctx.root` | 游戏要渲染进去的 DOM 容器 |
| `ctx.net` | 通信对象（真人或 AI），见 §5.1 |
| `ctx.back` | 返回房间的回调 |
| `ctx.reportPlay(gameId, gameName, opponent, result)` | 上报战绩，`result ∈ 'win' \| 'lose' \| 'draw'` |

约定与要求：

1. **消息必须带前缀**，避免跨游戏串扰：`go_` / `dw_` / `rev_` / `dots_` / `mem_` / `tt_` / `ld_` / `uno_`。
2. 发送消息带上自己身份：`ctx.net.send('gomoku_move', { ..., by: ctx.net.me })`。
3. 「轮次推进」统一用 `3 - me` 表示对手（1↔2）。
4. `destroy()` 必须解绑所有 `ctx.net.on(...)` 返回的取消订阅函数，否则切游戏会泄漏监听。
5. 终局调用 `ctx.reportPlay(...)`，并用闭包内 `finished` 标志防止重复上报；`reset()` 里要重置它。
6. 音效统一从 `js/sound.js` 引入 `Sound`（`place` / `click` / `match` / `invalid` / `win` / `lose` / `draw`）。

### 6.2 新增一款游戏的完整步骤

1. 新建 `js/games/xxx.js`，按 §6.1 契约实现（建议同时抽出纯逻辑 `XxxLogic`，便于无浏览器测试）。
2. 在 `js/games/registry.js` 数组末尾加上它 → 菜单自动多一张卡片，**无需改其它文件**。
3. （要做人机时）在 `js/ai.js` 写 `XxxBrain` 类并在 `createBrain(gameId, difficulty, net)` 里 `return new XxxBrain(net, difficulty)`。
4. 在 `style.css` 追加 `.xxx-*` 样式（保持粉色主题变量）。
5. 可选：在 `js/app.js` 的 `RESULT_QUIPS` 里为该游戏加专属结算文案。
6. 验证：`node tools/check-syntax.mjs`，再按 §12 做逻辑自测。

**AI Brain 约定**：构造函数 `(net, difficulty)`，需用方法 `onHuman(type, data)`（接收人类动作）、可选 `start()` / `destroy()`；回给对手的动作用 `this.net._emit(type, data)` 发出。难度 `easy / medium / hard` 由各 Brain 自行解释（随机率、搜索深度、是否必拦截）。

### 6.3 后端 API 全表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/register` | – | 注册（用户名 3–20 位，密码 ≥6 位），新用户默认 1000 分 |
| POST | `/api/login` | – | 登录，返回用户信息 + Set-Cookie 会话 |
| POST | `/api/logout` | – | 登出，清会话与在线状态 |
| GET | `/api/me` | – | 当前登录用户（含 `score`、`cpPartner`） |
| GET | `/api/me/records` | ✔ | 我的对局记录（含 `opponentUsername`、`delta`） |
| POST | `/api/play` | ✔ | 上报战绩，`{gameId,gameName,opponent,result,opponentUsername}` → `{ok,score,delta}` |
| POST | `/api/presence` | ✔ | 在线心跳，`{roomCode?,offline?}`，90s TTL |
| GET | `/api/friends` | ✔ | 好友/来/往请求列表 + 好友的 `note`/`group` + `blocks` + `pendingCount` |
| POST | `/api/friends/request` | ✔ | 按用户名发好友请求（含自加/不存在/已好友/被拉黑校验） |
| POST | `/api/friends/accept` | ✔ | 接受请求 |
| DELETE | `/api/friends/:userId` | ✔ | 删除关系（拒绝 / 取消 / 移除） |
| PATCH | `/api/friends/:userId` | ✔ | 改备注（`note`≤30）/ 分组（`group`≤12） |
| POST | `/api/blocks` | ✔ | 拉黑（级联解除好友关系） |
| DELETE | `/api/blocks/:userId` | ✔ | 解除拉黑 |
| POST | `/api/cp/bind` | ✔ | 情侣绑定（需双方用同一邀请码确认） |
| POST | `/api/cp/unbind` | ✔ | 解除绑定 |
| POST | `/api/messages` | ✔ | 发私聊 `type='chat'` 或房间邀请 `type='invite'`（仅好友，互相拉黑则拒） |
| GET | `/api/messages?peer=` | ✔ | 与某好友的会话（拉取后标记已读） |
| GET | `/api/messages/unread` | ✔ | 未读消息（返回 `fromName`，拉取后标记已读） |
| GET | `/api/leaderboard` | – | 积分排行榜（含 `rank`） |
| GET | `/api/rooms` | – | 公开房间列表（仅登录用户建的、无密码、waiting） |
| POST | `/api/rooms` | ✔ | 创建房间，返回 4 位房间号 |
| GET | `/api/rooms/:code` | – | 查询房间是否存在 / 是否有密码 |
| POST | `/api/rooms/:code/join` | – | 加入房间（校验密码），返回房主 peerId |
| PATCH | `/api/rooms/:code` | – | 改 `password` / `gameId` / `gameName` / `status` |
| POST | `/api/rooms/:code/heartbeat` | – | 房主心跳 |
| POST | `/api/rooms/:code/close` | – | 关闭房间（兼容 `sendBeacon`） |
| DELETE | `/api/rooms/:code` | – | 删除房间 |
| GET | `/api/admin/users` | 管理员 | 全部用户（含积分） |
| GET | `/api/admin/records` | 管理员 | 全部记录 |
| DELETE | `/api/admin/users/:id` | 管理员 | 删除用户 |

---

## 7. 数据模型（`server/data/db.json`）

顶层集合：`users`、`sessions`、`records`、`friendships`、`blocks`、`messages`（默认值见 `server/store.js`）。

- **users**：`id, username, nickname, password(scrypt), role, createdAt, lastLogin, score, cpPartnerId, cpSince, cpCode`
- **sessions**：`{ sessionToken: userId }`
- **records**：`{ id, userId, username, gameId, gameName, opponent, opponentUsername, result, delta, ts }`
- **friendships**：`{ id, userA, userB, status:'pending'|'accepted', requester, createdAt }`（双向存储，用 `findRel` 双向查）
- **blocks**：`{ id, blockerId, blockedId, createdAt }`
- **messages**：`{ id, fromId, toId, type:'chat'|'invite', text, roomCode, gameName, ts, read }`

> ⚠️ **服务端侧的数据表变更要同步更新** `store.js` 的默认对象，否则首次启动（无 db.json 时）会缺字段报错。

> 📌 **本地现状（2026-09-07 接手）**：`server/data/db.json` 已从 WorkBuddy 原工作目录一并迁移过来（1437 字节：2 个账号 / 1 个会话 / 2 条战绩 / 键结构与 `store.js` 默认值完全兼容），所以本机**不会**触发"重建并种入 admin/888888"。要回到干净状态，直接删掉该文件再启动即可。此文件含真实密码哈希，不要提交进 git。

---

## 8. 业务规则（改动前请确认）

| 规则 | 取值 |
|---|---|
| 注册初始积分 | **1000**（管理员 99999，不参与排名） |
| 胜负积分 | 胜 **+20**、负 **−15**、平 **+2** |
| 人机对战 | **不计积分**（`js/app.js` reportPlay 回调里 `if (net.isAI) return`），防刷分 |
| 段位（`views.js` tierOf） | 1700 星耀🌟 / 1500 钻石👑 / 1350 铂金💎 / 1200 黄金🥇 / 1100 白银🥈 / 1000 青铜🥉 / 其他 新手🌱 |
| 排行榜名次图标 | 第1🥇 第2🥈 第3🥉 其余💕（段位放 `title`） |
| 成就 | `achievements.js` 依据 `/api/me/records` 前端实时算，10 个徽章 |
| 游客 | 可以创建/加入房间、以临时昵称游玩，**但不能创建公开房间**（需登录）、也不能上线状的 CP/好友功能 |
| 私聊 / 邀请 | 仅限已是好友（accepted）且双向未拉黑 |
| CP 绑定 | 双方用同一邀请码绑定成功后互相展示 ❤️ 横幅 |

---

## 9. 视觉主题约定

当前是**深色玫红 + 粉色渐变**的情侣风（`style.css` `:root`）：

```
--bg-0:#2a1322  --bg-1:#3a1830  --text:#FCEAF4
--accent:#ff8ec0  --accent-grad: linear-gradient(135deg,#ffb3d6,#ff7eb3)
```

- 注意：**背景是深色、文字是浅色**。新增区域不要写死亮色背景 + 深色文字，会破坏一致性。
- `#decoBg` 是固定装饰层（`z-index:0`），含 9 个内联 SVG 萌系图形，低透明度 + 浮动动画；`#app` / `.topbar` 用 `position:relative;z-index:1` 盖在其上。**刻意不画具体三丽鸥角色以免侵权**，请勿添加具体 IP 形象。
- 响应式三档：`≥1024px` 桌面（聊天栏常驻时 `body.chat-open` 右留 320px）、`≤600px` 手机、`≤360px` 超窄屏。

---

## 10. 已完成功能清单

- [x] 账号体系：注册 / 登录 / 登出 / 记住用户名 / 密码强度提示 / 确认密码 / scrypt 哈希 / httpOnly Cookie
- [x] 房间：4 位房间号、房间密码、拷贝房号、公开房间列表（6s 轮询）、房主设置面板
- [x] 对战：真人 P2P + **人机（8 款游戏 × 3 档难度）**、房间内「邀请电脑玩家」
- [x] 游戏：五子棋、你画我猜、黑白棋、点格棋、记忆翻牌、海龟汤、吹牛、UNO
- [x] 结算：结算弹窗（胜/负/平 + 动画 + 积分变化 + 各游戏专属文案）+ 再来一局
- [x] 积分 / 段位 / 成就徽章 / 战绩明细弹窗 / 情侣积分排行榜
- [x] 好友：加好友请求、接受/拒绝/移除、备注、分组、分组筛选、拉黑/解黑、在线状态与「在房间 XXXX」、未读红点
- [x] 好友私聊弹窗 + 房间邀请 + 未读消息轮询通知（15s）
- [x] CP（情侣）绑定 / 解绑 / 大厅 CP 横幅
- [x] 音效系统（Web Audio 合成，无音频文件）+ 顶栏静音开关
- [x] 管理后台：用户列表、全部记录、删除用户
- [x] 响应式（手机 / 平板 / 桌面）+ 粉色萌系主题
- [x] 房间残留治理：心跳 + 90s 自动清理 + `sendBeacon` 关房 + 游客不进公开列表

---

## 11. ⚠️ 已知坑与技术债（**必读，能省大量返工**）

**1. CSS `display` 会覆盖 HTML `hidden` 属性 —— 本项目踩了至少 4 次**
任何要被 `hidden` 隐藏的元素，**不能用 `.xxx { display: flex/grid }` 直接写**，必须写成：

```css
.xxx { display: none; }
.xxx:not([hidden]) { display: flex; }   /* 或 grid */
```

历史踩坑对象：`.modal`（登录弹窗常驻显示）、`#room`（返回大厅后残留）、`.chat-panel`、`.cp-banner`（未登录时空横条）。
**新增任何可被 `hidden` 控制的容器时，一律用 `:not([hidden])` 写法。**

**2. 数据是文件存储 + 部分内存态，重启会丢**
Free 版 Render 每次重启/重新部署会清空本地磁盘，`server/data/db.json`（账号、记录、好友）会重置；在线状态 `onlineUsers`、房间 `rooms` 本来就是纯内存。**生产使用必须挂载 Persistent Disk 或换外部数据库**（SQLite / Postgres / MongoDB），这是目前最大的技术债。

**3. 不要改用公共 PeerJS 云信令**
早期用 `0.peerjs.com`，国内网络下 `peer.on('open')` 长期不触发，表现为「创建房间一直卡住」。现已改为服务端自建信令（`ExpressPeerServer`）。
⚠️ 路径一度错配：服务端必须是 `path:'/'` + `app.use('/peerjs', peerServer)`，客户端保持 `path:'/peerjs'`。实际监听路径是 `/peerjs/peerjs/id`，改配置前先 curl 验证返回 200。

**4. `AINet` 必须始终实现与 `Net` 相同的接口**
给 `Net` 加了新方法（例如某次给握手加 `username`），就必须同步给 `AINet`，否则人机模式会静默失败而不是报错。同理，游戏里引用了 `net` 的新字段要先确认两边都有。

**5. 游戏终局判定容易漏边界**
点格棋曾出现「线画完但格子有混主 → 永不结束」；吹牛的 `resolve()` 曾把胜负判反。**凡是涉及终局/胜负的逻辑，务必写无浏览器的穷举或随机自测**（见 §12），不要只靠手动点两下。

**6. `git push` 不会自动更新线上**
Render 配的是 Manual Deploy，推完代码还要去 Render 后台点一次部署。

**7. 数据 Dispose/清理要成对**
`ctx.net.on()` 返回取消订阅函数，必须在 `destroy()` 里全部调用。房间心跳 `setInterval` 与临时轮询器同理（`showLobby` 里都要 `clearInterval`）。

**8. 其它**
- 在线状态为内存态，重启后用户重新登录/心跳即恢复；好友关系在 db.json 里是持久的。
- 人机模式不计分是**刻意防刷**，若后续要开放请同时设计防刷策略（如人机最高分段上限）。
- `index.html` 里混杂了大量 `data-page-node-id="xxxx..."` 随机串（来自某个可视化页面编辑器），**是无意义的噪音**，可忽略；修改 HTML 结构时不建议依赖这些属性。

---

## 12. 开发与验证工作流

无浏览器也能验证绝大部分逻辑，这是本项目惯用的做法：

```bash
# 1) 语法检查（每次改完都要跑）
node tools/check-syntax.mjs        # 全站语法检查：前端 17 个 ESM + server/ + tools/

# 2) 五子棋 AI 三档难度无头对局（免浏览器）
node tools/test-ai-gomoku.mjs

# 3) 起本地服务 + curl 探活
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s http://localhost:3000/js/games/registry.js | grep -c "from './"   # 应为 8
```

> ⚠️ **不要直接对前端文件用 `node --check`**：`js/` 是 ES Modules 且仓库根目录没有 `package.json`，Node 会按 CommonJS 解析，17 个前端文件会全部误报 `Cannot use import statement outside a module`。`tools/check-syntax.mjs` 的做法是把前端 `.js` 复制为临时 `.mjs` 再检查，检查完自动清理。
>
> （本节命令已于 2026-09-07 接手时按实测修正，见 `E:\codex\docs\couple-game\2026-09-07-接手记录.md`。）

**AI 对局无头测试（首推）**：`node tools/test-ai-gomoku.mjs`（2026-09-07 接手时固化，不再每次重写临时脚本）。它构造 `AINet` 驱动完整五子棋局直到终局，三档难度各 12 局，断言「必应招 + 能终局 + 不僵持」，局数可用 `GOMOKU_AI_GAMES=4` 调整。新增其它游戏的大脑时照抄这个模式：`new AINet(diff)` → `net.beginGame(id)` → `net._brain` → `clearTimeout(brain.timer)` → `brain._move()`（`createBrain`/`GomokuBrain` 未导出，只能走 `net._brain`）。

**改 AI 或游戏逻辑时的 checklist**：
1. `node tools/check-syntax.mjs` 全绿；
2. `node tools/test-ai-gomoku.mjs` 全绿（三档难度都能终局，不僵持/不死循环）；
3. 关键纯函数（如胜负判定）单独断言正反例；
4. 起服务 curl 确认新模块能 200 返回；
5. 人机与真人两条链路都手动点一遍。

---

## 13. 上线部署

Render Blueprint 已配好（`render.yaml`：`rootDir: server`、`buildCommand: npm install`、`startCommand: npm start`）。

```bash
git add -A && git commit -m "..." && git push origin main
```

然后：**Render 后台 → 服务 couple-game → Manual Deploy**（这一步不能省）。

注意事项：
- Free 计划冷启动较慢，首次访问可能要等几十秒。
- 部署后 `server/data/db.json` 会被重置（见 §11 坑 2）。
- 线上核对内容时，`curl https://<host>` 可能返回 `426 Upgrade Required`（对根路径），建议改 curl 具体静态资源或接口来判断版本。

---

## 14. 后续优化建议（Roadmap）

**稳定性（建议优先）**
1. **数据持久化**：换 SQLite（单文件，改动最小）或外部 DB；外接后同时把房间/在线状态也放进存储，解决多实例与重启丢失。
2. **看门狗/重连**：P2P 断线后的自动重连与状态恢复（当前断开只能重开房间）。
3. **后端接收胜负上报做校验**：现在比分由前端上报 `/api/play`，存在作弊可能；若要更严谨，应改为由服务端（房主侧）权威结算。

**功能**
4. 更多游戏：斗地主 / 象棋 / 连连看 / 谁是卧底 / 剧本杀式解谜（本地已有 `3d-game-dev` 等 Godot 技能，若想做独立游戏可另起工程）。
5. 观战模式、房间聊天存档、快捷表情 / 贴纸互动。
6. CP 专属：情侣任务、纪念日、双人协作关卡、情侣主页。
7. 消息实时化：现在私聊是轮询，可升级 WebSocket（`ws` 依赖已在 node_modules 里）或 SSE。

**工程质量**
8. ~~补自动化测试~~ 已做一半：`tools/check-syntax.mjs` + `tools/test-ai-gomoku.mjs`（2026-09-07）。待补：其余 7 个游戏的对局终局测试、胜负纯函数的正反例断言。
9. 拆分 `js/app.js`（32KB）与 `server/index.js`（24KB）——单文件已偏大，但拆分时务必保持 §11 坑 1/4 的约定。
10. 清理 `index.html` 里的 `data-page-node-id` 噪音。
11. 前端错误上报 / `try-catch` 兜底，避免一处报错导致整站白屏。

---

## 附：交接包内容说明

- 包含全部**源码 + 配置 + 文档 + 完整 Git 提交历史**（`.git`，506KB / 13 次提交，含详细 commit message，建议先 `git log --oneline` 过一遍）。
- **未包含**：
  - `server/node_modules/`（18MB）—— 用 `cd server && npm install` 还原；
  - `server/data/db.json` —— 含真实账号与密码哈希，**出于隐私未打包**；首次运行会自动重建并种入 `admin/888888`；
  - `push-to-github.bat` —— 内含本机的绝对路径，换机器不可用，改用 §13 的标准 git 命令。
- 若不想让新环境误连原远端仓库，请删掉包内 `.git` 目录或执行 `git remote set-url origin <新地址>`。
