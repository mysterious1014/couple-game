# Couple Game Site

一个可以异地双人同玩的网页小游戏站。

- 五子棋（实时对战）
- 你画我猜（实时同步笔迹）
- 战绩与成就系统

> 默认管理员账号：`admin` / `888888`，部署后请尽快修改或限制访问。

## 本地运行

需要 Node.js 20 及以上（`better-sqlite3@12` 的要求）。

```bash
cd server
npm install
npm start
```

开发期自测（都不用打开浏览器）：

```bash
node tools/check-syntax.mjs              # 全站语法检查
node tools/test-ai-gomoku.mjs            # 五子棋 AI 三档难度跑完整对局
node tools/test-server-persistence.mjs   # 存储层回归：写数据 -> 重启进程 -> 读回
```

打开浏览器访问 `http://localhost:3000`：

1. 注册两个账号（或用默认管理员登录）。
2. 一人创建房间，得到房间号。
3. 另一人输入房间号加入。
4. 进入游戏菜单，选择想玩的游戏。

## 部署到 Render + 绑定自己的域名

本项目根目录已包含 `render.yaml`，支持 Render Blueprint 一键部署。

### 1. 推代码到 GitHub

确保当前仓库已推送到你的 GitHub 仓库（如 `mysterious1014/couple-game`）。

### 2. 在 Render 创建服务

1. 登录 [Render](https://render.com)。
2. 点击右上角 **New** → **Blueprint**。
3. 连接你的 GitHub 账号，选择 `couple-game` 仓库。
4. Render 会自动读取 `render.yaml` 配置：
   - 服务名：可自定义
   - 根目录：`server`
   - 构建命令：`npm install`
   - 启动命令：`npm start`
   - 计划：Free
5. 点击 **Deploy**。

等待约 1–2 分钟，部署完成后会得到一个 `xxx.onrender.com` 地址。

### 3. 绑定自己的域名

1. 进入 Render 服务页面 → **Settings** → **Custom Domains**。
2. 输入你想要的子域名，例如 `play.yourdomain.com`。
3. Render 会给出一条 CNAME 记录值。
4. 去你的域名注册商/ DNS 服务商后台，添加一条 CNAME 记录：
   - 主机记录：`play`（或你想要的子域名前缀）
   - 记录值：Render 提供的地址
5. 等待 DNS 生效（通常几分钟到几小时）。
6. 访问 `https://play.yourdomain.com` 即可。

### 4. 注意事项

- **数据持久化**：账号/战绩/好友/私信存在数据库里，进程重启不再丢失。本地默认是单文件 SQLite（`server/data/couple-game.sqlite`）。
- **但 Render Free 的磁盘是临时的**：每次部署/重启会清空 `server/data/`，SQLite 也随之丢失（会重建默认管理员 `admin/888888`）。**推荐做法：给服务挂一个 Postgres**，在 Render 环境变量里设 `DATABASE_URL`，代码会自动切到 Postgres 驱动，数据存在数据库服务里而不是实例磁盘上：

  ```bash
  # 1) 建好 Postgres 后，把本地已有账号搬上去（默认 dry-run，看清行数再加 --apply）
  node tools/migrate-storage.mjs --from sqlite --to postgres --to-url "$DATABASE_URL"
  node tools/migrate-storage.mjs --from sqlite --to postgres --to-url "$DATABASE_URL" --apply
  # 2) 部署后确认驱动已切换
  curl https://<host>/api/health     # 期望 {"ok":true,"driver":"postgres",...}
  ```

  另一条路是升级实例并挂载 **Persistent Disk**，再把 `render.yaml` 里的 `DATA_DIR` 注释打开指向挂载点。
- **环境变量**：`PORT`（服务端口）、`DATABASE_URL`（设了就用 Postgres）、`PGSSLMODE`（`disable`/`require`/`no-verify`，默认按连接串里的 `sslmode` 推断）、`DATA_DIR` / `DATABASE_FILE`（改 SQLite 位置）。
- **管理员密码**：默认密码是 `888888`，建议部署后通过后台管理页面尽快修改，或限制管理员账号的使用。
- **HTTPS**：Render 默认提供 HTTPS，无需额外配置。

## 技术栈

- 前端：原生 HTML / CSS / JavaScript（ES Modules）
- 实时同步：PeerJS（WebRTC 点对点）
- 后端：Node.js + Express
- 存储：双驱动 —— SQLite（默认，`better-sqlite3`）/ Postgres（设 `DATABASE_URL` 即启用，`pg`）；驱动层在 `server/store/`
- 部署：Render Blueprint

## 项目结构

```
couple-game/
├── index.html              # 页面入口
├── style.css               # 样式
├── js/
│   ├── app.js              # 大厅、菜单、路由
│   ├── auth.js             # 登录/注册/战绩上报
│   ├── views.js            # 我的战绩/管理后台视图
│   ├── achievements.js     # 成就统计
│   ├── net.js              # PeerJS 同步层
│   └── games/
│       ├── registry.js     # 游戏注册表
│       ├── gomoku.js       # 五子棋
│       └── draw.js         # 你画我猜
├── server/
│   ├── index.js            # Express 服务
│   ├── store/              # 存储层：index(门面) / schema / ddl / migrations / sqlite / postgres
│   └── package.json        # 后端依赖
└── render.yaml             # Render 部署配置
```

## 添加新游戏

1. 在 `js/games/` 下新建一个模块（参考 `gomoku.js` 或 `draw.js`）。
2. 导出 `{ id, name, desc, mount(ctx) }`。
3. 在 `js/games/registry.js` 中 import 并加入数组。
4. 游戏大厅会自动多一张卡片。

游戏内消息建议使用唯一前缀（例如 `ttt_`），避免与其他游戏冲突。
