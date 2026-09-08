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

设计目标是**轻量**：无前端构建步骤（原生 ES Modules），后端单进程 Express + SQLite 存储，整体源码约 350KB。

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
- 首次启动会自动创建 SQLite 库 `server/data/couple-game.sqlite` 并种入管理员账号
- 若同目录还留有旧版 `db.json`，会一次性导入并改名为 `db.imported-<时间戳>.json`（只填空集合，不覆盖已有数据）

单机体验双人对战：开两个浏览器标签页，一个「创建房间」，另一个输入 4 位房间号「加入」。
单机体验人机：大厅点「和电脑玩」→ 选难度 → 选游戏。

---

## 3. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 HTML / CSS / JS（**ES Modules**） | 无构建、无框架、无打包。改完刷新即生效 |
| 通信 | PeerJS（WebRTC 点对点） | 服务端同时运行自建 PeerJS 信令服务 |
| 后端 | Node.js（≥20）+ Express 4 | 单文件 `server/index.js`，同时托管静态资源与 `/api` |
| 存储 | **双驱动**：SQLite（默认）/ Postgres（设了 `DATABASE_URL` 就启用） | 驱动层在 `server/store/`，`index.js` 只看到 `{ data, save, ready, stats }` |
| 部署 | Render（Blueprint，`render.yaml`） | Free 计划 + Manual Deploy；要真正不丢数据就挂 Postgres |

**后端依赖只有四个**（`server/package.json`）：
```json
"express": "^4.19.2",
"peer": "^1.0.2",
"better-sqlite3": "^12.11.1",
"pg": "^8.23.0"
```
保持依赖极少是刻意选择，请勿随意引入前端框架或构建工具。

⚠️ `better-sqlite3` **不要升到 13**：13.0.3 在 Node 22.2 / win32-x64 上 `new Database()` 直接段错误退出（无 JS 异常）。

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
│   ├── net.js              # ★ 通信层 Net 类（PeerJS 封装）：host/join/send/on + 断线重连与消息日志回放
│   ├── ai.js               # ★ AI：AINet 类（与 Net 同接口）+ 8 个游戏大脑 + createBrain
│   ├── auth.js             # 登录/注册/登出、Auth.me 状态、结算后刷新本地分数 applyScore
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
    ├── store/              # 存储层（换数据库只动这里）
    │   ├── index.js        # 门面：选驱动、data/save/flush/stats、旧 db.json 导入
    │   ├── schema.js       # 集合↔表的列定义与行映射（加字段改这里）
    │   ├── ddl.js          # 建表语句生成（两驱动共用）
    │   ├── migrations.js   # SCHEMA_VERSION + 迁移脚本 + prepareDriver()
    │   ├── sqlite.js       # SQLite 驱动（默认）
    │   └── postgres.js     # Postgres 驱动（设 DATABASE_URL 时启用）
    ├── package.json
    └── data/couple-game.sqlite   # 本地运行数据（被 gitignore；位置可用 DATA_DIR / DATABASE_FILE 覆盖）
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

**只有 `Net` 有、`AINet` 没有的部分**（2026-09-08 断线重连引入，人机模式用不到，但游戏模块别去依赖它们）：
`net.roomSecret`（座位凭据，§5.2）、`net.journal`（本局消息日志，§5.4）、`net.reconnecting`、`net.onRebuild(journal)`、`net.replayJournal()`、`net.resetJournal()`、`net.retryReconnect()`、`net.cancelReconnect()`。
真人链路上 `onStatus` 的 type 多出 `reconnecting` / `resyncing` / `resynced`，`closed` 带 `reason`（`left` 主动离开、`gave-up` 重连放弃、`room-gone` 房间已被回收、`cancelled` 用户点取消）——`js/app.js` 用这些驱动 `#netOverlay` 遮罩。

### 5.2 房间生命周期（2026-09-08 起带座位凭据）
- 房主 `POST /api/rooms` 得到 4 位数字房间号（0001–9999 顺序分配）**和 `secret`（房主座位凭据）**，同时把真实 peerId 注册到服务端。
- 加入者 `POST /api/rooms/:code/join` → 服务端校验密码 → 返回房主 peerId **+ `secret`（访客座位凭据）** → 建立 P2P。两个 secret 由 `newSecret()`（12 字节 hex）生成，只存在于前端 `Net.roomSecret` 和内存 `rooms[code].hostSecret/guestSecret`，**不落库、不重启存活**（房间本来就是内存态）。
- **改房 / 关房 / 删房 / 登记 peerId / 查对方 peerId 一律要出示座位凭据**（`checkSeat(room, role, secret)`，不匹配 403）。这之前任何人只要猜到 4 位房间号，就能关掉别人的房、改掉密码、把自己的 peerId 投毒进去顶掉座位。
- 重连时 PeerID 会变（页面没刷新、PeerJS 重新发 ID），所以配了两个端点：`POST /api/rooms/:code/seat` `{role, peerId, secret}` 登记自己的新 peerId；`GET /api/rooms/:code/peers?role=&secret=` 取对方的 peerId 与房间状态。
- **仅登录用户创建的无密码房间进入公开列表**（防止游客房间刷屏）。
- 房主每 30s 心跳 `POST /api/rooms/:code/heartbeat`；服务端每 30s 扫描，**90s 无心跳自动删房**；另有 24h 兜底清理。
- 返回大厅 → `DELETE /api/rooms/:code?secret=`；直接关标签页 → `beforeunload` 用 `navigator.sendBeacon` 打 `/close`（body 里带 `{secret}`）。注意 `/close` 对**不存在的房间**直接放行，避免 beacon 误报。
- 房间字段（`server/index.js` 内注释即权威清单）：原有 `code/peerId/password/hostName/hostUserId/players/status/gameId/gameName/createdAt/lastHeartbeat/public`，本轮加 `hostPeerId/guestPeerId/hostSecret/guestSecret/guestName/guestUserId/matchRound/currentMatchId/lastSettledAt`。

### 5.3 后端
Express 单文件，顺序即大致职责：静态托管 → 屏蔽 `/server` 源码 → 鉴权 → 健康检查 → 房间 → 好友 → CP → 消息 → 排行榜 → 后台。
会话：httpOnly Cookie + `sessions` 表（重启不再掉登录态）；密码：Node `crypto.scrypt` 加盐哈希。

**存储层契约（改动前必读）**
- `index.js` 只认 `{ data, save, ready, stats }`：`data` 是 6 个内存集合，路由照旧 push/filter/改字段，`save()` 负责落库。
- 落库按集合做 JSON 快照比对，**内容没变的表整表跳过**，所以登录一次只重写 users + sessions。
- 因为 Postgres 写入是异步的，`index.js` 在 `express.json()` 之后挂了 ready 门禁中间件，并把 `seedAdmin()` 放进 `ready.then()`。**别在顶层同步读 `data`**（SQLite 下能读到，PG 下会是空数组）。

### 5.4 断线重连 + 服务端权威结算（2026-09-08，Roadmap ②③）

**① 重连状态机（`js/net.js`）**：断开后按 `RECOVER_DELAYS = [800,1600,3000,5000,8000,12000]` 退避，约 30s 内试 6 次，分两级恢复：

1. `_softRecover()` — 先让 PeerJS 自己恢复（代价最小，ID 不变，对方无感）。
2. `_rehandshake()` — 不行就换新 PeerID → `POST /seat` 登记 → `GET /peers` 拿对方 → 重新握手，`_waitReady()` 等 DataConnection open。
3. 6 次都不成 → `closed{reason:'gave-up'}`，遮罩上留「重试 / 取消」两钮（`retryReconnect()` / `cancelReconnect()`）。
4. 后端回 404（房间已被 GC）→ 立刻 `closed{reason:'room-gone'}`，不再白等。

**② 消息日志与回放**：除 `CONTROL_TYPES`（`hello/chat/start_game/room_set_game/room_settings/room_get_settings/resync*`）外的消息，收发两侧都按序进 `net.journal`（上限 `MAX_JOURNAL=4000`）。重连成功后两端在 `hello` 里互报 `{journal: 长度, last: 末条类型}`：

- 完全一致 → 直接续打；
- **日志长的一方为权威**（同长比末条类型，再同则房主），短的一方 `resync_request` → 权威方回整份 `resync` → 接收方覆盖自己的 journal，先调 `net.onRebuild(journal)`（上层重建对局），再 `replayJournal()` 把每条消息灌回各游戏的 `net.on` 处理器，最后发 `resync_done`。
- **回放期间 `send()` 只记不发**（`_replay` 标志），否则会把重建出来的局面再广播一遍；回放中新到的线上消息暂存 `_inbox`，回放完按序补投。
- 换游戏 / 回房间时 `net.resetJournal()`，日志不跨局。
- `js/app.js` 的 `onRebuild` 只对**可回放**的游戏重建：拿 `lastGameId` 找模块，若 `gm.noReplay` 或找不到 → 直接回房间页（连接恢复了，但本局作废）。

**③ 服务端权威结算（`server/index.js`）**：`POST /api/play`（前端单方面报比分就能加分的入口）已**删除**，改为双方互相印证：

- 每人各调一次 `POST /api/match/report` `{roomCode, gameId, gameName, result, roundHint}`；`requireAuth`，且调用者必须命中 `seatOf(room, uid)`（不在这个房间的座位里就 403）。
- 第一份声明进 `pending`；第二份到了才判：`isComplementary()` 要求 **win↔lose 或 draw↔draw**，互补才结算。
- `settleMatch()`：`SCORE_DELTA = {win:20, lose:-15, draw:2}`，改两人 `score`、各写一条 `game_records`（`mode:'p2p'`；**对手的显示名取自库里的用户资料，不采信客户端传来的 opponent**），然后 `save()` 落库。
- 状态机：`pending` / `settled` / `conflict`（两边都报自己赢）/ `expired`（`MATCH_PENDING_TTL_MS`，默认 90s 没人认领）/ `superseded`（换游戏了，或 `roundHint` 对不上=一方已开下一局）/ `throttled`（同房间两次结算间隔 < `MATCH_SETTLE_GAP_MS` = 8s）/ `unsupported`（对面是游客或 AI，不计分）。
- 先上报的一方用 `GET /api/match/:id` 轮询（前端 `waitMatchSettled()`，最多 25s），拿到 `settled` 才刷新分数与结算文案（`applySettlement()`）。
- `matches` 与 `rooms` 同为进程内存态；GC 每 30s 跑一次：`pending` 过期即清，已结束的回执留 10 分钟给人轮询。**只有结算后的战绩落库。**
- 可测性：`MATCH_PENDING_TTL_MS` 支持环境变量覆盖（回归测试用 1500ms 跑过期分支，不真等 90s）。

> 说人话：想给自己加分，必须让对方点一次「我输了」。对情侣应用这个成本足够高了；真正的收益是**误报不再算数**——刷新页面、脚本连点、双开客户端都刷不出分。

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
  noReplay: true,                // 可选：本局含「本地随机且不同步的私有状态」，断线重连不要回放它（§5.4）
};
```

`ctx` 提供：

| 字段 | 用途 |
|---|---|
| `ctx.root` | 游戏要渲染进去的 DOM 容器 |
| `ctx.net` | 通信对象（真人或 AI），见 §5.1 |
| `ctx.back` | 返回房间的回调 |
| `ctx.reportPlay(gameId, gameName, opponent, result)` | 把本局结果交给服务端结算（`result ∈ 'win' \| 'lose' \| 'draw'`）。**要对面也上报互补结果才会计分**，人机模式直接弹结算窗不计分 |

约定与要求：

1. **消息必须带前缀**，避免跨游戏串扰：`go_` / `dw_` / `rev_` / `dots_` / `mem_` / `tt_` / `ld_` / `uno_`。
2. 发送消息带上自己身份：`ctx.net.send('gomoku_move', { ..., by: ctx.net.me })`。
3. 「轮次推进」统一用 `3 - me` 表示对手（1↔2）。
4. `destroy()` 必须解绑所有 `ctx.net.on(...)` 返回的取消订阅函数，否则切游戏会泄漏监听。
5. 终局调用 `ctx.reportPlay(...)`，并用闭包内 `finished` 标志防止重复上报；`reset()` 里要重置它。
6. 音效统一从 `js/sound.js` 引入 `Sound`（`place` / `click` / `match` / `invalid` / `win` / `lose` / `draw`）。
7. **新增游戏若含「本地随机出来、又不通过消息同步的私有状态」（随机密词、随机骰子、随机手牌），必须标 `noReplay: true`**。否则断线重连回放日志时两边会重建出两个不同的局面（`draw.js` / `liarsdice.js` 就是这种，已标）。凡是「局面完全由双方消息决定」的游戏（五子棋、 dots、记忆翻牌、井字棋、UNO 的出牌动作等）默认可回放，不用标。

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
| POST | `/api/match/report` | ✔ | 上报本局结果 `{roomCode,gameId,gameName,result,roundHint}`，**双方互补才结算** → `{id,status,delta,score,...}`（§5.4） |
| GET | `/api/match/:id` | ✔ | 轮询某局结算状态（先上报的一方等对方）→ `matchView` |
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
| POST | `/api/rooms` | ✔ | 创建房间 → `{code, secret, room}`，`secret` 是房主座位凭据 |
| GET | `/api/rooms/:code` | – | 查询房间是否存在 / 是否有密码 |
| POST | `/api/rooms/:code/join` | – | 加入房间（校验密码）→ `{code, peerId, secret}`，`secret` 是访客座位凭据 |
| POST | `/api/rooms/:code/seat` | – | 重连用：登记自己的新 peerId，`{role, peerId, secret}`（凭据不对 403） |
| GET | `/api/rooms/:code/peers` | – | 重连用：取对方 peerId 与房间状态，`?role=&secret=`（凭据不对 403） |
| PATCH | `/api/rooms/:code` | 房主座位 | 改 `password` / `gameId` / `gameName` / `status` / `players`，body 需带 `secret` |
| POST | `/api/rooms/:code/heartbeat` | – | 房主心跳（保持房间存活，不校验凭据） |
| POST | `/api/rooms/:code/close` | 房主座位 | 关闭房间（兼容 `sendBeacon`，body 带 `secret`；房间已不存在则放行） |
| DELETE | `/api/rooms/:code` | 房主座位 | 删除房间，`?secret=` |
| GET | `/api/health` | – | `{ ok, driver, schemaVersion }`，部署后确认连的是哪个存储 |
| GET | `/api/admin/storage` | 管理员 | `store.stats()`：驱动、位置、各集合行数、`lastError` |
| GET | `/api/admin/users` | 管理员 | 全部用户（含积分） |
| GET | `/api/admin/records` | 管理员 | 全部记录 |
| DELETE | `/api/admin/users/:id` | 管理员 | 删除用户 |

---

## 7. 数据模型（SQLite `server/data/couple-game.sqlite` 或 Postgres `DATABASE_URL`）

内存对象是 `users` / `sessions` / `records` / `friendships` / `blocks` / `messages`；落库对应表 `users` / `sessions` / `game_records` / `friendships` / `blocks` / `messages`，另有 `meta(key,value)` 存结构版本与旧数据导入标记。列定义集中在 `server/store/schema.js` 的 `COLLECTIONS`。

- **users**：`id, username, nickname, password(scrypt), role, createdAt, lastLogin, score, cpPartnerId, cpSince, cpCode`
- **sessions**：`{ sessionToken: userId }`
- **records**：`{ id, userId, username, gameId, gameName, opponent, opponentUsername, result, delta, ts }`
- **friendships**：`{ id, userA, userB, status:'pending'|'accepted', requester, createdAt }`（双向存储，用 `findRel` 双向查）
- **blocks**：`{ id, blockerId, blockedId, createdAt }`
- **messages**：`{ id, fromId, toId, type:'chat'|'invite', text, roomCode, gameName, ts, read }`

> ⚠️ **新增集合**要在 `server/store/schema.js` 的 `emptyData()` 和 `COLLECTIONS` 里同时登记；**新增字段**在对应表 `columns` 加一项，并在 `migrations.js` 补一条 `MIGRATIONS`（`SCHEMA_VERSION` +1），老库才会真的 ALTER。
> 每张表都带两列通用字段：`seq`（数组下标，保证两个驱动读回顺序一致）与 `extra`（未登记字段的兜底 JSON，不丢但不可查询）。

> 📌 **本地现状（2026-09-07）**：已从 WorkBuddy 迁来的 `db.json`（2 账号 / 1 会话 / 2 战绩）已一次性导入 SQLite，原文件保留为 `server/data/db.imported-1788781159626.json`。要回到干净状态：删掉 `server/data/` 里的 sqlite 与导入备份再启动，会重建 `admin/888888`。这些文件含真实密码哈希，`server/data/` 已在 `.gitignore` 内，不要提交。

---

## 8. 业务规则（改动前请确认）

| 规则 | 取值 |
|---|---|
| 注册初始积分 | **1000**（管理员 99999，不参与排名） |
| 胜负积分 | 胜 **+20**、负 **−15**、平 **+2**（常量在 `server/index.js` 的 `SCORE_DELTA`） |
| 真人对战计分 | **双方各上报一次且结果互补**（win↔lose / draw↔draw）才结算，见 §5.4；单方声明只进 `pending`，90s 无人认领即过期不计分；同房间两次结算间隔须 ≥8s |
| 人机对战 | **不计积分**（`js/app.js` reportPlay 回调里 `if (net.isAI)` 直接弹结算窗），防刷分 |
| 段位（`views.js` tierOf） | 1700 星耀🌟 / 1500 钻石👑 / 1350 铂金💎 / 1200 黄金🥇 / 1100 白银🥈 / 1000 青铜🥉 / 其他 新手🌱 |
| 排行榜名次图标 | 第1🥇 第2🥈 第3🥉 其余💕（段位放 `title`） |
| 成就 | `achievements.js` 依据 `/api/me/records` 前端实时算，10 个徽章 |
| 游客 | 可以创建/加入房间、以临时昵称游玩，**但不能创建公开房间**（需登录）、不能上线状的 CP/好友功能；**游客对局不计分**（`/api/match/report` 需登录，且要求房间两个座位都是登录账号，否则回 `unsupported`） |
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
- [x] **已上线**：Render Blueprint + Free Postgres 双驱动，`https://chenting.cc.cd`（2026-09-07，详见 §13）

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

**2. 存储层现在是双驱动（2026-09-07），但 Render Free 的磁盘仍是临时的**
账号/会话/战绩/好友/私信已进数据库：本地默认 SQLite（`server/data/couple-game.sqlite`），线上设 `DATABASE_URL` 就走 Postgres。重启不再丢数据，也不会再出现旧版「JSON 写一半损坏」。
⚠️ 仍然存在的限制：Free 版 Render 每次重启/重新部署会清空磁盘，SQLite 文件照丢 —— 解法就是给服务挂一个 Postgres（Render Postgres 或 Neon 免费档）并设 `DATABASE_URL`，见 §13。另一条路是升级实例挂 **Persistent Disk** + 设 `DATA_DIR`。
房间 `rooms` 与在线状态 `onlineUsers` 仍是纯内存：这属于合理设计（服务端重启后 P2P 连接本来也断了），但意味着**多实例部署时房间列表不共享**。

**3. 不要改用公共 PeerJS 云信令**
早期用 `0.peerjs.com`，国内网络下 `peer.on('open')` 长期不触发，表现为「创建房间一直卡住」。现已改为服务端自建信令（`ExpressPeerServer`）。
⚠️ 路径一度错配：服务端必须是 `path:'/'` + `app.use('/peerjs', peerServer)`，客户端保持 `path:'/peerjs'`。实际监听路径是 `/peerjs/peerjs/id`，改配置前先 curl 验证返回 200。

**4. `AINet` 必须始终实现与 `Net` 相同的接口**
给 `Net` 加了新方法（例如某次给握手加 `username`），就必须同步给 `AINet`，否则人机模式会静默失败而不是报错。同理，游戏里引用了 `net` 的新字段要先确认两边都有。

**5. 游戏终局判定容易漏边界**
点格棋曾出现「线画完但格子有混主 → 永不结束」；吹牛的 `resolve()` 曾把胜负判反。**凡是涉及终局/胜负的逻辑，务必写无浏览器的穷举或随机自测**（见 §12），不要只靠手动点两下。

**6. `save()` 在 Postgres 下不保证「返回时已落盘」**
SQLite 驱动是同步写，行为与旧版一致；Postgres 驱动把写请求排队异步执行（见 `server/store/index.js`）。所以：
- 任何「进程启动就要读数据」的逻辑必须 `await store.ready`（`index.js` 里已有 ready 门禁中间件，`seedAdmin()` 也放在 `ready.then()` 里）。
- 测试脚本里杀进程前先 `await` 一个 400ms 的 settle（`tools/test-server-persistence.mjs` 的 `stopServer()` 已内置）。
- 进程收到 SIGINT/SIGTERM 会先 `flush()` 再退出（Render 停止实例时用的就是 SIGTERM）。
- 写失败不会崩，但会记进 `store.stats().lastError`，管理员用 `GET /api/admin/storage` 能看到。
- ⚠️ 整数列在 Postgres 侧是 BIGINT(int8)，`pg` 默认按字符串返回（怕精度溢出）。驱动层注册了 `int8 -> Number` 解析，`server/store/schema.js` 的 `fromStored()` 又兜了一道，**两处都不要删**：否则 `user.score += 20` 会变成字符串拼接（`"1000" + 20` 得到 `100020`）。用外部工具直连库读数表时也要记得 `pg.types.setTypeParser(20, Number)`。

**7. 只有 `server/` 下的改动会自动部署（Root Directory 的坑，2026-09-07 定案）**
线上 Auto-Deploy = **On Commit**，但服务的 **Root Directory = `server`**。Render 后台原文：「If set … code changes **outside of this directory do not trigger an auto-deploy**」。本轮实测对照：
- `4885921` 只改 `server/package.json`、`server/package-lock.json`、`server/store/index.js` → 在 `server/` 内 → **Auto-Deploy 正常触发**。
- `fc7c452` 只改 `HANDOFF.md`、`README.md`、`render.yaml` → 全在 `server/` 外 → **一次部署都没产生，连失败记录都没有**。当时误判成「webhook 漏投递 / Auto Sync 挂了」，白查很久。
- 结论：改根目录文档、`render.yaml`、`tools/**` 想上线，必须去后台点 **「Manual Deploy → Deploy latest commit」**（只部署最新 commit，不动任何配置，安全；另一项「Clear build cache & deploy」见坑 10）。
- 改 `render.yaml` 会触发一次 Blueprint sync —— sync 管的是**资源配置**，不等于把新 commit 部署到服务上。
- 其余排查项已实测正常，别再查：Blueprint **Auto Sync = Yes**、服务 **Auto-Deploy = On Commit**、Included/Ignored Paths 均为空（没有路径过滤）。
- 快速判断线上代码新旧：`curl.exe -s -o NUL -w '%{http_code} %{size_download}' https://chenting.cc.cd/render.yaml`，把返回字节数和新旧 commit 里该文件的大小对比（根目录被整体静态托管，见坑 12）。
- 不想开后台：Blueprint 面板有 **Deploy Hook**，`curl` 一个带密钥的 URL 就能触发部署（密钥当 Secret 保管，**不要**提交进仓库）。
- 💡 省事做法：**纯文档/工具类改动攒成一次 commit，再一次性 Manual Deploy**，别每改一版点一次。

**8. 数据 Dispose/清理要成对**
`ctx.net.on()` 返回取消订阅函数，必须在 `destroy()` 里全部调用。房间心跳 `setInterval` 与临时轮询器同理（`showLobby` 里都要 `clearInterval`）。

**9. 其它**
- 在线状态为内存态，重启后用户重新登录/心跳即恢复；好友关系存在 SQLite `friendships` 表里，是持久的。
- ⚠️ **SQLite 跑在 WAL 模式**：主库文件 `server/data/couple-game.sqlite` 可能只有 4KB，真正的数据在同目录的 `couple-game.sqlite-wal`（本机实测 535KB）。手工备份/复制必须连 `-wal`、`-shm` 一起拷，或先 `PRAGMA wal_checkpoint(TRUNCATE)` 折回主文件，只拷主文件会得到一个空库。`tools/migrate-storage.mjs` 是直接打开原目录里的库，不受这个坑影响。
- 人机模式不计分是**刻意防刷**，若后续要开放请同时设计防刷策略（如人机最高分段上限）。
- `index.html` 里混杂了大量 `data-page-node-id="xxxx..."` 随机串（来自某个可视化页面编辑器），**是无意义的噪音**，可忽略；修改 HTML 结构时不建议依赖这些属性。

**10. 换 Node 版本必须「Clear build cache & deploy」（2026-09-07 线上 exit-1 根因）**
`better-sqlite3` 是原生模块，`.node` 二进制按 `NODE_MODULE_VERSION` 编译。改 `NODE_VERSION` 只重新部署**不会**重装缓存里的二进制：曾出现「按 Node 25（ABI 147）编译的 `better_sqlite3.node` 被 Node 22（需要 127）加载」→ `ERR_DLOPEN_FAILED` → 启动即 `Exited with status 1`，连续 3 次部署全栽这儿。
- 正确姿势：后台「More → Clear build cache & deploy」。
- 代码侧已加固：两个驱动都改成**按需 require**（`server/store/index.js`），只要设了 `DATABASE_URL` 就绝不加载 sqlite 二进制；`better-sqlite3` 也已移到 `optionalDependencies`，装不上不阻断构建。**这两处别回退。**

**11. 连 Render Postgres 有两个隐性必设项**
- 连接串里**不含** `sslmode`，而驱动默认 `disable` → 直连会被拒。必须同时设 `PGSSLMODE=require`（线上 env 与本地跑 `tools/migrate-storage.mjs` 时都一样）。
- 内网/外网是两个不同 host：服务 env 用 Internal（`dpg-xxxx-a`），本地脚本必须用 DB 页面上的 **External** 串（`dpg-xxxx-a.oregon-postgres.render.com`）。
- Free 库**到期即删无宽限期**（当前库 2026-10-07 过期），到期前用 `migrate-storage --from postgres --to sqlite` 反向拉一份回本地当备份。

**12. 线上把整个仓库根目录当静态站暴露（已知现状，本轮刻意不动）**
`server/index.js` 的静态中间件 `express.static(ROOT)` 里 `ROOT` 是**仓库根**，前面只用 `req.path.startsWith('/server')` 挡了源码目录（`server/index.js` 约 561-571 行）。实测 `https://chenting.cc.cd/render.yaml`、`/HANDOFF.md`、`/README.md`、`/tools/check-syntax.mjs` 全部 200 可下载。
- 目前**不算新增泄露面**：GitHub 仓库本身是 public，`render.yaml`/文档里也刻意不写连接串与密码（密码在后台 Environment 页）。
- ⚠️ **但一旦回退到 SQLite 就必须先收紧**：那时库里是真实用户数据，任何落在仓库根附近的备份/导出文件都会直接可被下载。
- 2026-09-07 与用户确认：**这条只记录，不改代码**（怕动到现有页面路径）。下次真要收紧，正确做法是把静态根换成**白名单**（只暴露 `index.html`、`js/`、`css/`、`assets/` 等），而不是继续往黑名单上叠前缀。

**13. 结算接口改了必须两端同时更新（2026-09-08）**
`/api/play` 已删除、换成 `/api/match/report`。**旧前端 + 新后端 = 打完一局不计分**（前端拿到 404，本地分数不动，也不弹错误）；新前端 + 旧后端 = 同样不计分（404/401）。前后端同仓库同部署，正常不会劈叉；**但线上部署失败、只剩旧版在跑时，症状就是「能玩但不加分」**，用 `curl -X POST /api/play` 是否 404 判定后端版本（§13.3）。

**14. 自由实时类游戏的两端日志顺序可能不同**
点格棋 / UNO 这类「双方都能随时连发多条消息」的游戏，同一瞬间的两条消息在两边的记录顺序可能相反，重连 resync 时以**权威方（日志长的一方）**为准整份覆盖。表现是重连后与断线前有一两步细微差异，但**不会出现两边局面不一致的死局**。回合制的五子棋/井字棋/记忆翻牌无此问题。

**15. `noReplay` 游戏的重连语义 = 连接恢复、本局作废**
你画我猜（随机密词）、吹牛骰（本地随机骰子）标了 `noReplay: true`：重连后 `js/app.js` 的 `onRebuild` 把玩家送回房间页，而不是恢复到半局。别为了「体验更好」去掉标记——那会重建出一个错误的私有状态，比回房间更糟。

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

# 4) 服务端持久化回归测试（真起一个隔离端口的服务，写数据 -> 重启 -> 读回）
node tools/test-server-persistence.mjs 4310     # 默认测 SQLite，用临时 DATA_DIR，不碰真实数据
node tools/test-server-persistence.mjs 4310 --url postgres://user:pw@host:5432/cgtest_test   # 同一套断言测 Postgres 驱动
# 不想建云端库也想验证 Postgres 分支：本地拉起一个真 PostgreSQL 跑同一套断言
#   cd server && npm i --no-save embedded-postgres && cd .. && node tools/dev-postgres.mjs
# （跑完自动停服并删除临时数据目录；用完 cd server && npm prune 清掉临时依赖）

# 5) 服务端权威结算回归（隔离端口起服务，测双方互补/冲突/过期/换局/频控/越权，30 项断言）
node tools/test-match-settlement.mjs 4320

# 6) 断线重连 + 日志回放回归（假 PeerJS + 假后端驱动真 net.js，12 项断言，免浏览器免联网）
node tools/test-net-reconnect.mjs

# 7) 本地 <-> 线上数据搬迁（默认 dry-run，加 --apply 才写；目标非空还要 --force）
node tools/migrate-storage.mjs --from sqlite --to postgres --to-url "$DATABASE_URL"
node tools/migrate-storage.mjs --from postgres --from-url "$DATABASE_URL" --to sqlite --apply
# dry-run 也不是完全只读：它会在目标库建表（CREATE TABLE IF NOT EXISTS，幂等）并写一行 meta.schema_version，
# 但六张业务表一行都不写；meta 不会被搬走（json_imported_at 是源库自己的导入标记），目标库自己初始化自己的 meta。
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
5. 人机与真人两条链路都手动点一遍；
6. 改过 `server/store/**`（表结构/列/驱动）或任何写库的路由 → 必跑 `node tools/test-server-persistence.mjs`；动到 Postgres 一侧时，再用 `--url` 对真实 Postgres 跑一遍（只跑 SQLite 不算测过）。
7. 改过 `js/net.js` 或房间/结算路由（`server/index.js` 的 `/api/rooms*`、`/api/match*`）→ 必跑 `node tools/test-net-reconnect.mjs` + `node tools/test-match-settlement.mjs <端口>`；动了某类消息的语义就要重新考虑它进不进日志（`net.js` 的 `CONTROL_TYPES`），否则重连回放会漏步或多步。
8. 新增游戏时问一句：本局有没有「本地随机、且不同步给对面」的私有状态？有 → 标 `noReplay: true`（§6.1 约定 7）。

---

## 13. 上线部署（2026-09-07 已上线，实况记录）

### 13.1 拓扑

```
GitHub mysterious1014/couple-game (main)
   └─ Render Blueprint  exs-dadbs6v10e5c73e86sug   ← 读本仓库 render.yaml，Auto Sync 开着
        ├─ Web 服务  couple-game  srv-dadbu0ajnfac73fa5100   Free / Node / rootDir: server
        │     访问地址  https://chenting.cc.cd        （主域）+ 一个 onrender.com 子域
        └─ Postgres  couple-game-db  dpg-dafbdolbedkc738hrol0-a  PG 18 / Oregon / Free
              ⚠️ 手工在后台建的，**不归 Blueprint 管**（Blueprint 收养不了已有资源，写进
                 render.yaml 反而会让整次 sync 因重名创建失败），所以 render.yaml 里没有 databases: 段
```

代码推送即自动部署（Auto-Deploy = On Commit），但**服务的 Root Directory = `server`** ⇒ 只有 `server/**` 的改动会自动触发；根目录文档 / `render.yaml` / `tools/**` 的改动要在后台点「Manual Deploy → Deploy latest commit」（详见 §11 坑 7）。一次部署约 30–40s。

### 13.2 环境变量（改这些都在后台 Environment 页，不要提交进仓库）

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `NODE_VERSION` | `22` | 原生模块 ABI 绑主版本；**改它必须走「More → Clear build cache & deploy」**，见 §11 坑 10 |
| `DATABASE_URL` | 内网连接串（Secret） | 有值即用 Postgres 驱动，没值退回 SQLite |
| `PGSSLMODE` | `require` | 连接串里不含 `sslmode`，代码默认 `disable`，不设这一项连 Render 内网库会被拒 |
| `PORT` | Render 自动注入 | `server/index.js` 已读取 |

本地另有 `DATA_DIR` / `DATABASE_FILE`（库文件位置）只在 SQLite 分支生效。

### 13.3 部署后验收（三条命令，别开浏览器）

```bash
# ① 驱动与结构版本
curl https://chenting.cc.cd/api/health
#    {"ok":true,"driver":"postgres","schemaVersion":3}

# ② 登录拿 sid（HttpOnly cookie，必须用 cookie jar）
curl -c ck.txt -H 'Content-Type: application/json' \
     -d '{"username":"<管理员>","password":"<密码>"}' https://chenting.cc.cd/api/login

# ③ 存储实况（字段是 records，不是 game_records；users/records/sessions 是各表行数）
curl -b ck.txt https://chenting.cc.cd/api/admin/storage

# ④ 后端版本探针（2026-09-08 之后必加）：旧计分入口要 404，新结算入口要 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://chenting.cc.cd/api/play
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'Content-Type: application/json' -d '{}' https://chenting.cc.cd/api/match/report
```

> 2026-09-08 **本地**实测（`tools/test-match-settlement.mjs` 会真起一个隔离端口的服务）：`/api/play` → 404、`/api/match/report` 未登录 → 401、`/api/rooms/0001/peers` 无凭据 → 403。
> ⚠️ 上面 ①–④ **线上尚未复验**：commit `dd7388f` 改了 `server/index.js`，按 §11 坑 7 会触发 Auto-Deploy，但本机当天直连 `https://chenting.cc.cd` 全程 TLS reset（见 §13.6），跑不了验收。下次开代理第一件事就是把这 4 条补上。
> **若 `/api/play` 还是 200，说明线上跑的是旧版后端**（多半是那次部署失败/没触发），此时症状是「能玩但不加分」。

### 13.4 数据搬迁与回拉

- 本地 → 线上：`node tools/migrate-storage.mjs --from sqlite --to postgres --to-url "<外部连接串>" --apply`
  （外部连接串在 DB 页面右侧，和 `PGSSLMODE=require` 配对使用；目标库非空时再加 `--force`。
  2026-09-07 实测：`users=2 records=2 sessions=4`，回读校验一致。）
- 线上 → 本地（当备份用）：`--from postgres --to sqlite` 反向跑一遍即可，工具两个方向都支持。
- 服务重启（Restart，不重新部署）不会丢数据：数据在 PG 里，不在实例磁盘上。

### 13.5 Free 计划的限制（都会以「网站变慢/打不开」的形式被用户体验到）

1. 闲置即休眠，冷启动 **50 秒上下**；想常驻要升 Starter（约 $7/月）。
2. Free Postgres **2026-10-07 到期即删，无宽限期**：到期前必须升级或 `migrate-storage` 反向导出。
3. 实例磁盘是临时的，所以线上只能靠 PG 持久化（SQLite 分支在线上等于每次部署清空）。
4. 单实例：`rooms` / `onlineUsers` 仍是进程内存态，P2P 房间不受影响，但横向扩容前必须先解决（见 §14-1）。
5. 数据库密码等凭据：轮换入口在 DB 页「New default credential」，换完记得同步 `DATABASE_URL` 并重启服务。

### 13.6 已排除的假故障

- `https://couple-game.onrender.com` 返回 `426 Upgrade Required`：**不是我们的服务**。未占用的 onrender 子域返回 404，被 Blueprint 关掉的子域也返回 404，说明这个名字被别人的服务占了；我们服务的子域名在后台 Overview 的「Show more URLs」里。
- 2026-09-07 21:44 之前那几次 `Exited with status 1` 全部是同一个原因（原生模块 ABI 不匹配，§11 坑 10），不是欠费、不是 426、不是冷启动。
- **2026-09-08：本机直连 `https://chenting.cc.cd` 全部 TLS `Connection was reset`（HTTPS 与明文 HTTP 都 reset，`dns.google` / `cloudflare-dns.com` 同时超时），但 `github.com` / `render.com` 正常。** 是本机网络/代理问题（系统代理 `127.0.0.1:7897` 的客户端没开），**不是站点挂了**——2026-09-07 同一条命令是能通的。判断站点死活要用「代理开着」的通道，或直接看 Render 后台的 Deploy 日志。

---
## 14. 后续优化建议（Roadmap）

**稳定性（建议优先）**
1. ~~数据持久化~~ **已做（2026-09-07）**：`server/store/` 双驱动（SQLite 默认 / Postgres 设 `DATABASE_URL` 即启用）+ 结构版本迁移 + `tools/migrate-storage.mjs` 搬迁 + 33 项回归断言（SQLite 33 项全绿；Postgres 分支 25 项已用本地真实 PostgreSQL 18.4 跑通）。线上 Postgres 已接好并完成数据搬迁（2026-09-07，§13）。剩余：多实例下的房间/在线状态共享（仍是单进程内存，Free 只有单实例所以暂不致命）。
2. ~~看门狗/重连~~ **已做（2026-09-08）**：`js/net.js` 两级恢复（PeerJS 自愈 → 换 PeerID + `/seat` 换座位重新握手），30s 内退避 6 次，失败交给用户「重试/取消」；配合**本局消息日志 + 回放**，回合制游戏能恢复到断线前，2 款含本地随机私有状态的游戏（你画我猜、吹牛骰）标 `noReplay`，只恢复连接不作废对方体验。前端加 `#netOverlay` 遮罩显示进度。实测 `tools/test-net-reconnect.mjs` 12 项断言（含 5↔6 非对称日志收敛、room-gone 立即放弃）。**已知限制**：页面整页刷新不恢复（房间与 journal 都是内存态）；真实 NAT 穿透下的成功率未测，需要她俩实战反馈。
3. ~~后端校验胜负上报~~ **已做（2026-09-08）**：删 `/api/play`，改 `POST /api/match/report` + `GET /api/match/:id`，**双方声明互补才结算**（win↔lose / draw↔draw），对手显示名取自库内资料，另加 8s 频控、90s 过期、换局作废、越权 403。实测 `tools/test-match-settlement.mjs` 30 项断言全绿。顺手补的安全洞：改密/关房/删房/登记 peerId 之前对任何人开放，现在要座位凭据。剩余可做：`matches` 落库，覆盖「结算瞬间其中一端掉线」的补结算（现在靠 10 分钟内存回执 + 前端 25s 轮询兜）。

**功能**
4. 更多游戏：斗地主 / 象棋 / 连连看 / 谁是卧底 / 剧本杀式解谜（本地已有 `3d-game-dev` 等 Godot 技能，若想做独立游戏可另起工程）。
5. 观战模式、房间聊天存档、快捷表情 / 贴纸互动。
6. CP 专属：情侣任务、纪念日、双人协作关卡、情侣主页。
7. 消息实时化：现在私聊是轮询，可升级 WebSocket（`ws` 依赖已在 node_modules 里）或 SSE。

**工程质量**
8. ~~补自动化测试~~ 已做一半：`tools/check-syntax.mjs`（24 文件）、`tools/test-ai-gomoku.mjs`、`tools/test-server-persistence.mjs`（SQLite 33 项 / Postgres 25 项）、`tools/test-match-settlement.mjs`（30 项）、`tools/test-net-reconnect.mjs`（12 项）——后两个是 2026-09-08 新增；`cd server && npm test` 跑 persistence，另有 `npm run test:match` / `npm run test:net`。待补：其余 7 个游戏的对局终局测试、胜负纯函数的正反例断言，以及**真两个浏览器对打的 e2e**（现有测试分别覆盖后端状态机与前端 Net，没串起来）。
9. 拆分 `js/app.js`（32KB）与 `server/index.js`（24KB）——单文件已偏大，但拆分时务必保持 §11 坑 1/4 的约定。
10. 清理 `index.html` 里的 `data-page-node-id` 噪音。
11. 前端错误上报 / `try-catch` 兜底，避免一处报错导致整站白屏。

---

## 附：交接包内容说明

- 包含全部**源码 + 配置 + 文档 + 完整 Git 提交历史**（`.git`，506KB / 13 次提交，含详细 commit message，建议先 `git log --oneline` 过一遍）。
- **未包含**：
  - `server/node_modules/`（18MB）—— 用 `cd server && npm install` 还原；
  - `server/data/`（旧版是 `db.json`，现已迁为 SQLite）—— 含真实账号与密码哈希，**出于隐私未打包**；首次运行会自动重建并种入 `admin/888888`；
  - `push-to-github.bat` —— 内含本机的绝对路径，换机器不可用，改用 §13 的标准 git 命令。
- 若不想让新环境误连原远端仓库，请删掉包内 `.git` 目录或执行 `git remote set-url origin <新地址>`。
