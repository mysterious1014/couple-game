# Couple Game Site

一个可以异地双人同玩的网页小游戏站。

- 五子棋（实时对战）
- 你画我猜（实时同步笔迹）
- 战绩与成就系统

> 默认管理员账号：`admin` / `888888`，部署后请尽快修改或限制访问。

## 本地运行

```bash
cd server
npm install
npm start
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

- **数据持久化**：Render Free 计划实例每次重启/重新部署时，本地 `server/data/db.json` 会被清空。系统会自动重新创建默认管理员账号 `admin/888888`。如果你希望账号和记录永久保存，请在 Render 服务设置里挂载 **Persistent Disk**，或改用外部数据库（如 MongoDB Atlas / PostgreSQL）。
- **管理员密码**：默认密码是 `888888`，建议部署后通过后台管理页面尽快修改，或限制管理员账号的使用。
- **HTTPS**：Render 默认提供 HTTPS，无需额外配置。

## 技术栈

- 前端：原生 HTML / CSS / JavaScript（ES Modules）
- 实时同步：PeerJS（WebRTC 点对点）
- 后端：Node.js + Express
- 存储：JSON 文件（`server/data/db.json`）
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
│   ├── store.js            # JSON 数据存储
│   └── package.json        # 后端依赖
└── render.yaml             # Render 部署配置
```

## 添加新游戏

1. 在 `js/games/` 下新建一个模块（参考 `gomoku.js` 或 `draw.js`）。
2. 导出 `{ id, name, desc, mount(ctx) }`。
3. 在 `js/games/registry.js` 中 import 并加入数组。
4. 游戏大厅会自动多一张卡片。

游戏内消息建议使用唯一前缀（例如 `ttt_`），避免与其他游戏冲突。
