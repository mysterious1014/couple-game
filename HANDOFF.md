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
| 部署 | Render（Blueprint，`render.yaml`） | Free 计划 + Deploy Hook（`tools/render-deploy.mjs`，见 §13.7）；数据在 Postgres |

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
│   ├── remember.js         # 「记住账号密码」本机存取：XOR+base64 混淆、storage 可注入（§5.5）
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
- **两个座位各自记存活**（`hostSeenAt` / `guestSeenAt`）：`POST /api/rooms/:code/heartbeat` 带 `{role, secret}` 时续对应座位，**房主与访客都每 30s 打一次**（30 < 45，允许丢一次心跳）；服务端每 30s 扫描，房间整体 **90s 无心跳自动删房**，另有 24h 兜底清理。裸 POST（旧前端、`sendBeacon`）仍接受，但只续房间存活、不算「有人坐在访客位上」。
- 访客座位的存活窗口是 `GUEST_SEAT_TTL_MS`（默认 **45s**，环境变量可收紧给测试用）。它 `join` 时开始计时、`/seat` 与带凭据的心跳续期，**过期即视为掉线，房间重新对别人开放**；访客主动点「离开房间」则走 `POST /api/rooms/:code/leave` 立刻让座，不用干等 45s。
- 返回大厅：**房主** → `DELETE /api/rooms/:code?secret=`（整间房关掉）；**访客** → `POST /api/rooms/:code/leave`（只让出自己那个座位，房间留给房主）。直接关标签页 → `beforeunload` 用 `navigator.sendBeacon` 打 `/close` 或 `/leave`（body 里带 `{secret}`）。注意 `/close` 对**不存在的房间**直接放行，避免 beacon 误报；移动端 beacon 丢了也不强求，45s TTL 会兜住。
- 房间字段（`server/index.js` 内注释即权威清单）：原有 `code/peerId/password/hostName/hostUserId/players/status/gameId/gameName/createdAt/lastHeartbeat/public`，其后加 `hostPeerId/guestPeerId/hostSecret/guestSecret/guestName/guestUserId/matchRound/currentMatchId/lastSettledAt`，2026-09-13 再加 `hostSeenAt/guestSeenAt`（两个座位各自的存活时间戳，`guestSeenAt=0` 表示空座）。

### 5.3 后端
Express 单文件，顺序即大致职责：静态托管 → 屏蔽 `/server` 源码 → 鉴权 → 健康检查 → 房间 → 好友 → CP → 消息 → 排行榜 → 后台。
会话：httpOnly Cookie + `sessions` 表（重启不再掉登录态），默认 **7 天**、登录时带 `remember: true` 则 **30 天**（§5.5）；密码：Node `crypto.scrypt` 加盐哈希。

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

### 5.5 「记住账号密码」= 本机混淆存储 + 会话时长（2026-09-08）

先纠正一个常见误解：**这个功能和 IP 无关**。它记的是「这台设备的这个浏览器」。换浏览器、换设备、
清理浏览器数据后就得重新输密码；连同一个 Wi-Fi 的另一台设备也不会被记住。想跨设备保持登录，靠的是
服务端会话 Cookie，不是本地存的这份凭据。

三条互相独立的机制，别混为一谈：

| 机制 | 存在哪 | 活多久 | 没有它会怎样 |
|---|---|---|---|
| 会话 Cookie `sid` | 服务端 `sessions` 表 + 浏览器 httpOnly Cookie | 默认 **7 天**；带 `remember` → **30 天**（`server/index.js` 的 `sessionOpts()`） | 每次进网站都要重新登录 |
| 用户名回填 | 本机 `localStorage['cg_username']` | 直到手动清除浏览器数据 | 下次要自己打用户名（**改动前就有**，不是本轮新增） |
| 密码回填 | 本机 `localStorage['cg_auth_remember']` | 直到取消勾选 / 点退出 | 下次要重新打一次密码（本轮新增） |

- 代码：`js/remember.js`（纯逻辑、不碰 DOM、storage 可注入以便 Node 单测）+ `js/auth.js` 的
  `fillLoginFromRemember()`（模块加载和每次打开弹窗各调一次）/ `loginSubmit` / `logout()`。
- **⚠️ 存的是 XOR + base64 混淆，不是加密**：密钥 `cg-remember-v1` 就写死在 `js/remember.js` 里，
  任何能在页面执行脚本的人（XSS、浏览器扩展、DevTools）都能还原。**公用电脑、别人的手机上不要勾**。
  真要「打开就是登录态且不留密码」，用第一行的持久会话 Cookie 就够了。
- 取消勾选 = **当场** `Remember.clear()` 并清空密码框；点「退出」同样清密码（用户名保留）。
  两条都是即时生效，不会悄悄留着。
- 数据坏了 / `v` 版本对不上 → `load()` 返回 `null` 并顺手 `clear()`，登录框不会炸。
- 注册弹窗**没有**这个勾（`#rememberMe` 只在 `#loginForm` 内），注册走默认 7 天会话。


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
| POST | `/api/register` | – | 注册（用户名 3–20 位，密码 ≥6 位），新用户默认 1000 分；body 可选 `remember`（§5.5） |
| POST | `/api/login` | – | 登录，返回用户信息 + Set-Cookie 会话；body 可选 `remember: true` 把会话从 7 天延长到 30 天（§5.5） |
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
| POST | `/api/rooms/:code/join` | – | 加入房间（校验密码）→ `{code, peerId, secret}`，`secret` 是访客座位凭据。**403** 密码错 / **400** 房主 join 自己的房 / **409** 访客座位上还有活人（本人重进放行）|
| POST | `/api/rooms/:code/leave` | 访客座位 | 访客离座：清 `guestSeenAt/guestPeerId/guestUserId/guestName/guestSecret`、`players` 回 1、`status` 回 `waiting`（body 带 `{secret}`；凭据不对 403，已经离座的再补一次也是 403）|
| POST | `/api/rooms/:code/seat` | 座位凭据 | 登记自己的 peerId，`{role, peerId, secret}`（凭据不对 403）。**`join` 成功后访客也要调一次**：一是让 `guestSeenAt` 有数据源，二是 `guestPeerId` 不再永远为空（房主重连时要反向拨号找访客）|
| GET | `/api/rooms/:code/peers` | – | 重连用：取对方 peerId 与房间状态，`?role=&secret=`（凭据不对 403） |
| PATCH | `/api/rooms/:code` | 房主座位 | 改 `password` / `gameId` / `gameName` / `status` / `players`，body 需带 `secret` |
| POST | `/api/rooms/:code/heartbeat` | – | 心跳（保持房间存活）。body 可选 `{role, secret}`：凭据对得上就顺带标记该座位存活；不传（旧前端 / `sendBeacon` 裸 POST）只续房间 |
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
| 房间满员判定（2026-09-13 起） | **只看访客座位的存活时间，不看 `players`**：`guestSeenAt` 在 45s 内且坐着的不是同一个人 → `/join` 回 **409「房间已满，对方还在房间里」**；回来的若是同一登录账号（`guestUserId` 相同）视为刷新/重连，放行并换发新凭据。房主本人 join 自己的房回 **400**，不再把自己写成访客 |
| 访客掉线多久能被接手 | 45s（`GUEST_SEAT_TTL_MS`，环境变量可改小给测试用）。主动点「离开房间」或关页面 beacon 送达 → 立刻释放 |
| 列表里的「已满」 | 前端按 `players >= 2` 给该条加 `.pr-item.full`（`aria-disabled` + 置灰 + 禁点），点它只弹轻提示并 `loadPublicRooms()` 刷新。**这只是省一次注定 409 的请求，不许当判据**：`players` 房主 `PATCH` 得动，且列表 6s 才刷一次（真判据永远是服务端 `guestSeenAt`）|

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
- **五子棋棋盘尺寸（2026-09-09）**：`.go-board` 不再是固定 `max-width`，而是
  `width: min(100%, max(var(--go-min), calc(100svh - var(--go-reserve))))`，即**同时受容器宽与视口高约束取小者**。
  单元格是 `aspect-ratio:1/1` ⇒ 板宽=板高，只按宽度设上限必然浪费高度，所以矮视口会被高度卡住（`1024×768` 上限就是 600px，物理极限）。
  `--go-min`（地板）= 改动前的旧上限（基线 410 / `≥1024` 档 600），**保证任何尺寸都不会比原来更小**；富余时才放大：
  `1024×1366` 600→992、`1366×1024` 600→792、`1920×1080` 600→848。`--go-reserve` 是实测的上下固定开销（基线 320 / `≥1024` 232 / `≤600` 300）。

---

## 10. 已完成功能清单

- [x] 账号体系：注册 / 登录 / 登出 / 记住用户名 / 密码强度提示 / 确认密码 / scrypt 哈希 / httpOnly Cookie
- [x] **记住账号密码（仅本机）**：勾上后凭据留在本机、会话延长到 30 天，重开网站自动回填；取消勾选或点退出即清除（§5.5）
- [x] 房间：4 位房间号、房间密码、拷贝房号、公开房间列表（6s 轮询，**已满的那条置灰不可点**，点一下给轻提示并顺手刷新）、房主设置面板
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
- [x] **五子棋棋盘自适应放大**：按「视口高 − 固定开销」动态取尺寸，平板/桌面最高 992px；`≥1024` 档把状态行与「重新开始」并排到棋盘上方省出高度（§9）
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
- 结论：**根目录改动不会「触发」部署，但会随任意一次部署的整仓快照一起上线**（服务把仓库根整体静态托管，见坑 12）。所以纯文档 / `tools/**` 改完之后想上线，跑一条命令就行：`node tools/render-deploy.mjs`（Deploy Hook，2026-09-09 起的标准做法，详见 §13.7）。后台点「Manual Deploy → Deploy latest commit」是它的等价手动版；另一项「Clear build cache & deploy」见坑 10。
- 2026-09-08 反证（修正上面这条的判断）：`dd7388f` 因改了 `server/index.js` 触发 Auto-Deploy，部署后线上 `/HANDOFF.md` 从 39219 → **50880 B**（正是该 commit 里的仓库版本），期间**没人点过 Manual Deploy** ⇒ 根目录文件确实跟着上了线。旧说法「根目录改动不上线」过强，准确表述是「**不触发部署，但会随快照上线**」。
- 改 `render.yaml` 会触发一次 Blueprint sync —— sync 管的是**资源配置**，不等于把新 commit 部署到服务上。
- 其余排查项已实测正常，别再查：Blueprint **Auto Sync = Yes**、服务 **Auto-Deploy = On Commit**、Included/Ignored Paths 均为空（没有路径过滤）。
- 快速判断线上代码新旧：`curl.exe -s -o NUL -w '%{http_code} %{size_download}' https://chenting.cc.cd/render.yaml`，把返回字节数和新旧 commit 里该文件的大小对比（根目录被整体静态托管，见坑 12）。
- 不想开后台：Blueprint 面板有 **Deploy Hook**，`curl` 一个带密钥的 URL 就能触发部署（密钥当 Secret 保管，**不要**提交进仓库）。
- 💡 省事做法：**纯文档/工具类改动攒成一次 commit，再一次性 `node tools/render-deploy.mjs`**，别每改一版戳一次（一次部署约 30–40s，且 Free 实例有月流量额度）。

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

**16. 「记住账号密码」的四个必守点（2026-09-08）**
- `localStorage` 在**隐私模式 / 禁用站点数据**时访问会**抛异常**（不是返回 `null`）。`js/remember.js` 的 `resolveStorage()` 先 try 探测再退回内存实现 `memoryStore()`，**别简化成直接读写 `window.localStorage`** —— Safari 隐私模式下整个登录框会连带炸掉。
- 全站有 `input { width: 100%; padding: 13px 15px }`，往里加 `type=checkbox` 必须显式写回 `appearance: auto; width/height: 16px; padding: 0; border: none; box-shadow: none`（见 `style.css` 的 `.remember input[type=checkbox]`），否则复选框会被撑成一条大色块。
- **弹窗节点不销毁**（`#authModal` 只切 `hidden`），所以「清掉已存密码」必须同时清 `#loginPass.value`，否则退出后重开弹窗旧密码还留在框里（本轮实测补上）。
- 浏览器自带的密码管理器（Chrome/Edge「保存密码」）是**另一条独立链路**，不受本功能控制。自动化测试里出现过「我们没存密码，但浏览器自动回填导致登录成功」，别把它当本功能的功劳，也别当它的 bug。

**17. 五子棋棋盘放大依赖 `:has()` 与 `svh`，别改回固定 `max-width`（2026-09-09）**
- 放宽 `#app` / `.topbar` 的条件写成 `body:has(#game:not([hidden]) #go-board)`，**必须带 `#game:not([hidden])`**：
  `mount()` 只在开新局时覆盖 `#gameRoot.innerHTML`，返回房间后 `#go-board` 仍以 0 尺寸留在 DOM 里，
  只写 `body:has(#go-board)` 会让大厅/房间页在桌面档被撑宽（实测 `#app` 880→1180 的回归）。
- 用 `100svh` 而不是 `100dvh`：手机地址栏收放会让 `dvh` 变大 → 棋盘变大 → 出现滚动条 → 再变大，形成正反馈抖动；`svh` 保证永不溢出且零布局跳动。
- `--go-min` 是「不许比改动前更小」的地板，改它会直接造成小屏回归；`--go-reserve` 必须与实测固定开销一致，调 `body` 内边距 / `.game-top` / 顶栏高度后要重新量。
- `≥1024` 档用 `#gameRoot` 的 `grid-template-areas: "status restart" "board board"` 把状态行与按钮压成一行，别改成 flex，否则 `#go-restart` 的 `margin-top` 会重新占高。
- 无头环境（仓库根没有 `node_modules`，也没装 Playwright）验不了响应式，用 Codex 内置浏览器的 `viewport` capability 逐档量 `getBoundingClientRect()` + `scrollWidth>clientWidth`。
- ⚠️ 顺带发现（**未修，与本次改动无关**）：黑白棋在窄屏（≤600px）会横向溢出 —— `.rev-board` 是 `repeat(8,1fr)` 但末两列 `.rev-cell` 实测超出容器约 100px（`scrollWidth` 453 vs `clientWidth` 375）。本次 diff 未触碰任何 `.rev-*` 规则。

**18. 「同步层吞消息 / `_cleanup()` 抹掉监听器」——双人进房类 bug 的两个根因（2026-09-11 修复）**

用户报「从房间列表进别人房间：我能进去，但房主看不到我，而且进去后房主变成了我」。三个独立缺陷叠在一起，任何一个单独修都不够：

1. **`Net._cleanup()` 里清 `_status` / `_handlers`**（`js/net.js`）。`host()` 和 `join()` 开头都调它，而上层的状态回调是「拿到 Net 实例时一次性绑定」的（`bindNetEvents` → `onStatus`）⇒ 建房/加入的瞬间所有状态回调被抹掉。后果：房主侧连接建立后 UI 永远停在「等待对方加入…」、开始按钮不解锁、断线遮罩和「对方掉线」提示全部失效。
   **规则：`_cleanup()` 只复位连接与房间状态；监听器只在 `destroy()` 里清。** 另注意 `_cleanup()` 会把 `_destroyed` 复位成 false，所以 `destroy()` 必须在调用它**之后**再置 `_destroyed = true`（原代码末尾那行看着重复，其实是有意的）。
2. **`_onControl()` 把非握手类控制消息整段吞掉**。`_onData()` 见 `CONTROL_TYPES` 就 `_onControl(m); return;`，而 `_onControl` 只认 `hello`/`resync_*`，于是 `chat` / `start_game` / `room_set_game` / `room_settings` / `room_get_settings` **收到了也不会上抛给上层** ⇒ 访客看不到房主选的游戏、永远进不了对局、悄悄话两边都不显示。现在拆成 `SYNC_TYPES`（同步层自己消化，不上抛）与 `ROOM_CONTROL_TYPES`（不进日志、不参与回放，但**仍要 `_deliver` 上抛**）；`CONTROL_TYPES = 两者并集`，它才是**「要不要记进日志」的唯一口径**（`send()` 与 `_onData()` 都读它）。
   **规则：「不进日志」和「不上抛」是两个正交开关，别拿一个集合同时表达两件事。** 本轮现场翻车：把 `hello` 从 `CONTROL_TYPES` 里挪走（以为它只是「内部消息」）⇒ `send('hello')` 开始被记进日志 ⇒ 每次握手多一条、重连回放直接错乱，`test-net-reconnect` 的「重建后棋局一致」当场变红。所以 `CONTROL_TYPES` 必须是两个子集的并集；那条「控制消息不进日志」断言也已从只查房主一侧加强为**两侧都查**（只查一侧时这个污染刚好溜过去了）。
3. **房间级的 4 个 `net.on(...)` 写在 `js/app.js` 模块作用域**。`showLobby()` 每次回大厅都 `realNet = new Net()`，新实例上根本没有这些订阅 ⇒ 就算 1、2 修好，第二轮进房照样收不到开局。现已挪进 `bindNetEvents(n)`，与 `onStatus` 一样**跟着实例走**；`initChat()` 的 `chat` 订阅同时加了 `chatUnsub` 退订句柄（`backToRoom() → enterRoom() → initChat()` 会在同一实例上重复注册，一条消息会渲染多遍）。
4. 房间头部两栏是固定的**「房主 / 访客」两个座位**，不是「我 / 对方」。`enterRoom()` 原来无条件 `$('hostName').textContent = net.myName` ⇒ 访客视角「房主变成我」，而 `updateRoomPlayers()` 又把 `net.peerName` 写进访客栏 ⇒ 两栏整体对调。现在按 `net.isHost` 分派（`peerName` 在 `join()` 里已由 `/api/rooms/:code/join` 的 `hostName` 回填）。

- **这类 bug 用 Node 级测试测不出来**：`tools/test-net-reconnect.mjs` 只 import `net.js`，没有 app 层绑定，也没有浏览器，所以它对 1、3 全程无感、修复前后都是绿的。要覆盖必须上真浏览器双会话。
- 复现/回归脚本（一次性，不在仓库里）：两个 Edge 会话 + 本地服务，走「公开房间列表点进去」这条真实路径，断言两侧头部两栏、开始按钮解锁、双方进入对局、房主落子同步到访客、悄悄话双向、房主回大厅**再开一间**访客仍能进、人机模式仍能开局。修前 4 项 FAIL，修后 17 项全 PASS。
- 后端另一处相关的口子（**2026-09-13 已收紧，见坑 19**）：`POST /api/rooms/:code/join` 既不检查房间是否已满（`players` 直接 `min(...+1, 2)` 封顶），也不检查加入者是不是房主本人 ⇒ 同一间房可以被第三次、第四次 join，各自都会覆盖 `guestSecret`/`guestName`。
- 同类残留（**仍未处理**）：`PATCH /api/rooms/:code` 只校验房主凭据、不校验语义，房主可以把 `players` 设成 1 或 2 的任意值。它现在只给列表显示用，所以**满员判定绝不能建在它上面**；要当判据用就先删掉这个字段。

**19. `join` 没有判据 + 访客座位没人认领（2026-09-13 修复）**

坑 18 末尾那条口子补上了。服务端 `/join` 现在认三件事：**房主不能 join 自己的房**（400）、**访客座位还有活人时不接手**（409）、**本人重进放行**（`guestUserId` 相同，刷新/断线重连不受影响）。判据是新增的 `guestSeenAt`，不是 `players` —— `players` 只是列表显示用的计数器，房主 `PATCH` 一下就能改，拿它当门会误伤重连。

配套的前端三处（缺一个判据就是假的）：

1. **`join` 成功后登记座位**：`js/net.js` 的 `join()` 在 PeerJS `open` 之后调 `_registerSeat(myPeerId)`。⚠️ 这里最容易踩：`join()` 里的 `this.peerId` 存的是**房主的** peerId（`/join` 下发的，紧接着 `peer.connect(this.peerId)` 用的就是它），自己的 id 只在 `open` 回调参数里 —— 拿 `this.peerId` 去登记等于把房主的 id 写成访客的。现在另存 `this.myPeerId`。顺带修掉一个陈年问题：以前访客从不登记，`guestPeerId` 永远为空，房主断线重连时的反向拨号（`_rehandshake` 取 `peers.guestPeerId`）根本找不到人。
2. **两个座位都要心跳**：`js/app.js` 的 `startRoomHeartbeat()` 改成发 JSON `{role, secret}`，`enterRoom()` 的启动条件从 `net.isHost` 放开成「非人机就要心跳」。间隔 30s < TTL 45s。
3. **离座要立刻让座**：`showLobby()` 按 `net.isHost` 分流 `DELETE /rooms/:code`（房主=关房）与 `POST /rooms/:code/leave`（访客=让座），`beforeunload` 的 beacon 同样分流；访客 join 失败（服务端已占座、P2P 没连上）也在 `catch` 里补一次 `/leave`，别让整间房白等 45s。**离座前先 `stopRoomHeartbeat()`**：否则旧凭据的心跳还在往后打。实测行为是「不报错但也不再续座」（`/leave` 清空 `guestSecret` → `checkSeat` 不过 → 静默不标记），所以不会复活座位，只是白跑请求。

- 45s 这个数是「30s 心跳 + 容错一次」推出来的，别调到 30s 以下：移动端切后台掉一次心跳就会被误判掉线，把座位让别人接走。
- ⚠️ **这类判据只有真浏览器才验得准**：`/leave` 走 `sendBeacon`、`/seat` 依赖 `peer.on('open')` 的回调参数，Node 级测试只能验到 HTTP 契约。两条都入库了：`tools/test-room-join.mjs`（免浏览器 17 项，用 `GUEST_SEAT_TTL_MS=2000` 跑过期分支）+ `tools/test-room-join-e2e.mjs`（双浏览器 24 项，含「已满那条被标成不可点、视觉确实是灰的」「点它不进房不报错、只提示+刷新」「手输房号仍被服务端 409 挡住」「访客离座后第三人立刻能进」；本机探测不到 Playwright 或 Edge/Chrome 时打 `SKIPPED` 并 `exit 0`，不算失败。设 `SHOT_DIR` 会把大厅截图存下来，供人工复核观感）。
- 写 e2e 时踩到：Windows 上 `fs.rmSync(tempDir)` 在服务子进程还锁着 `.sqlite-shm` 时会抛 `EBUSY`，而它挂在 `finally` 里 ⇒ **测试结果被异常盖掉，看起来像脚本本身崩了**。规则：先打印报告、再 `await` 子进程 `exit`、最后 `rmSync` 用 try/catch 包住（清不掉就打印路径提示手动删）。

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

# 8) 「记住账号密码」纯逻辑回归（注入假 storage，29 项断言，免浏览器免联网）
node tools/test-remember.mjs

# 9) 房间进房收紧回归（免浏览器，隔离端口 + 临时 DATA_DIR + GUEST_SEAT_TTL_MS=2000，17 项断言）
node tools/test-room-join.mjs 4320

# 10) 房间进房双浏览器端到端（自己起本地服务；没装 Playwright / 找不到 Edge·Chrome 时打 SKIPPED 并 exit 0）
node tools/test-room-join-e2e.mjs 4480
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
7. 改过 `js/net.js` 或房间/结算路由（`server/index.js` 的 `/api/rooms*`、`/api/match*`）→ 必跑 `node tools/test-net-reconnect.mjs` + `node tools/test-match-settlement.mjs <端口>`；动了某类消息的语义就要重新考虑它进不进日志（`net.js` 的 `CONTROL_TYPES`），否则重连回放会漏步或多步。再动到**进房 / 座位**（`/join`、`/seat`、`/leave`、心跳、`GUEST_SEAT_TTL_MS`）→ 加跑 `node tools/test-room-join.mjs <端口>`；改了联网路径上的前端交互还要跑 `node tools/test-room-join-e2e.mjs <端口>`（坑 19）。
8. 新增游戏时问一句：本局有没有「本地随机、且不同步给对面」的私有状态？有 → 标 `noReplay: true`（§6.1 约定 7）。
9. 改过 `js/remember.js` 或 `js/auth.js` 的回填/清理链路 → 必跑 `node tools/test-remember.mjs`，再手点「勾选登录 → 重开网站 → 取消勾选 → 退出」四条路径。⚠️ 浏览器自动化**读不到** `input[type=password].value`（会被脱敏成空串），要验证密码是否真被回填，用「什么都不改直接点登录，看能不能登进去」当判据（§11.16）。

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

代码推送即自动部署（Auto-Deploy = On Commit），但**服务的 Root Directory = `server`** ⇒ 只有 `server/**` 的改动会**自动触发**部署；纯根目录文档 / `render.yaml` / `tools/**` 的改动不触发（详见 §11 坑 7）。**2026-09-09 起统一用 `node tools/render-deploy.mjs` 补上这一脚**（Deploy Hook + 自动校验），见 §13.7。一次部署约 30–40s。

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

> **2026-09-08 线上已复验通过**（`dd7388f` 的 Auto-Deploy 成功，push 后约 1 分钟生效；当天更早时候因本机 TLS reset 一度没跑成，见 §13.6）：
>
> - ① `/api/health` → `{"ok":true,"driver":"postgres","schemaVersion":3}` ✅ 后端活着、走 Postgres、结构版本对。
> - ④ `POST /api/play` → **404** ✅ 旧刷分入口已下线；`POST /api/match/report` 未登录 → **401** `{"error":"未登录"}` ✅ 新结算入口已就位且要身份。
> - 前端新旧（字节数比法，§11 坑 7）：`/HANDOFF.md` → 200 / **50880 B**，等于 `dd7388f` 的仓库版本（上一版 39219 B）⇒ **新前端确实已上线**，顺带证明根目录文件会随部署快照一起上线。
> - 另试 `GET /api/rooms/0001/peers` → 404 `{"error":"房间不存在"}`（线上没有这个房号，属正常）；「无凭据 → 403」的分支由 `tools/test-match-settlement.mjs` 在本地覆盖。
>
> 上面 ②③ 两条 curl 要账号密码，属按需抽查，本轮没跑线上。
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
- **2026-09-08：本机直连 `https://chenting.cc.cd` 全部 TLS `Connection was reset`（HTTPS 与明文 HTTP 都 reset，`dns.google` / `cloudflare-dns.com` 同时超时），但 `github.com` / `render.com` 正常。** 是本机网络/代理问题（系统代理 `127.0.0.1:7897` 的客户端没开），**不是站点挂了**——2026-09-07 同一条命令是能通的。判断站点死活要用「代理开着」的通道，或直接看 Render 后台的 Deploy 日志。（2026-09-08 稍后代理恢复后实测确认：`dd7388f` 部署成功、站点一切正常，见 §13.3。）**当天连 `github.com:443` 的 `git push` 也会被 reset**，遇到 push 失败先怀疑网络，别怀疑仓库。）

### 13.7 自动上线（2026-09-09 起，**以后不用再手点后台**）

- 根因：服务的 Root Directory = `server`，而站点前端（`index.html` / `style.css` / `js/**`）全在仓库根 ⇒ 大部分提交**不会触发** Auto-Deploy。
- 解法：Render 的 **Deploy Hook**（服务 Settings 页最下面那条 secret URL，GET/POST 都能触发一次「部署最新 commit」）。
  - 密钥存在仓库外：`E:\codex\.secrets\render-deploy-hook-couple-game.txt`（**不进 Git，不要贴进任何文档/回复**）。也可用环境变量 `RENDER_DEPLOY_HOOK_URL` 覆盖；换机台用 `RENDER_DEPLOY_HOOK_FILE` 改路径。
  - 脚本：`tools/render-deploy.mjs`。
    - `node tools/render-deploy.mjs` 触发部署 → 每 10s 轮询，直到「线上内容 == HEAD」且 `/api/health` 正常（默认最多等 5 分钟，`DEPLOY_WAIT_MS` 可调）。
    - `node tools/render-deploy.mjs --verify` 只校验不触发（比对 HEAD 这一笔改动的文件）；再加 `--all` 就把 HEAD 里全部 20 个可访问前端文件逐个和线上做逐字节比对。
    - `--no-verify` 只打一发就走，不等结果。
- **约定：任何 `git push` 之后立刻跑 `node tools/render-deploy.mjs`，并把它打印的结果作为上线证据。** 这条已写进全局 `C:\Users\14760\.codex\AGENTS.md`，后续会话会自动执行，不需要用户再交代。
- 2026-09-09 实测：`63ad16b` 只改根目录 `style.css`，push 后确实没有任何部署（线上仍是 49843 B 的旧文件）；用 hook 触发后返回 HTTP 200，约 40s 后 `--verify --all` 报「比对 20 个前端文件，全部一致」，`/api/health` = `{"ok":true,"driver":"postgres","schemaVersion":3}`。
- 可选升级（**未做，动线上构建配置前先问用户**）：把 `render.yaml` 的 `rootDir` 去掉、构建/启动命令改成 `cd server && ...`，就能让**任意 commit 原生 Auto-Deploy**，连脚本都不用。`server/index.js` 的静态根是 `path.join(__dirname, '..')`，逻辑上不受影响，但 Node buildpack 的探测方式会变，真要改建议配一次「Clear build cache & deploy」（坑 10）。

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
