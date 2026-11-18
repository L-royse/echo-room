# 回声 · Echo Room

为小型朋友圈做的网页版文字与语音空间。深色界面、中文交互，桌面与手机浏览器均有布局。

本项目是新写的独立应用，不是 Kook 或 BilldDesk 的分支，也不连接其服务器。

## 功能

- 邀请码注册、账号登录、HttpOnly 会话；首次启动创建管理员。
- 文字频道、实时消息、每次加载 50 条历史；每频道最多保留 2000 条。
- 语音频道、Opus 32kbps 音频、mediasoup SFU 转发、说话指示、麦克风静音、耳机静音。
- 管理员创建/删除频道、禁言/解除禁言、移出语音并冷却 60 秒。
- 单账号单连接，掉线清理资源；消息连接自动重连，语音需手动重新加入。
- 默认全站最多 8 人同时语音、40 个网页连接、100 个注册账号、12 个频道。
- 自有 TURN 可选配置；HTTPS 和证书续签由 Caddy 完成。

语音、文字频道对这个私有空间的所有注册成员开放；暂不包含私密分组、私信、好友系统、文件上传、录音、视频和屏幕共享。耳机静音仅停止收听，不自动关闭麦克风。管理员禁言与移出冷却跨网页重连生效，服务端重启后清除。

## 下载包部署

部署包已包含 `dist/`，服务器无需编译网页。Linux x86_64 公网 VPS 推荐：

```bash
tar -xzf echo-room-1.0.0.tar.gz
cd echo-room-1.0.0
bash setup.sh
docker compose up -d --build
```

先准备域名、DNS、Docker Engine/Compose 和防火墙。完整步骤见 **[DEPLOY.md](DEPLOY.md)**，资源评估和技术选择见 **[DESIGN.md](DESIGN.md)**。

`setup.sh` 会为你生成随机管理员密码和邀请码。`.env` 已存在时不会覆盖。启动后访问自己的 HTTPS 域名，用 `admin` 和 `.env` 中的密码登录。

## 本地开发

需要 Node.js 24。首次安装 mediasoup 会下载本机对应的原生 worker。

```bash
npm ci
cp .env.example .env
# 修改 .env 中 ADMIN_PASSWORD / INVITE_CODE，至少 12 位，不要使用示例值。
npm run build
npm start
```

打开 `http://localhost:3000`。本机 localhost 可使用麦克风；局域网 HTTP IP 不满足浏览器的安全上下文要求。

```bash
npm run check
npm test
npm run build
npm run package
```

`npm test` 使用真实 mediasoup worker、内存数据库和本地 HTTP/WebSocket，覆盖权限与音频信令。浏览器合成音频验证：`node scripts/local-test.mjs`，访问 `http://localhost:3000/__test__/media`。测试服务只监听本机、数据库不落盘，使用独立测试账号，**不可作为生产启动入口**。

## GitHub

将本目录作为仓库根目录上传到你自己的 `L-royse/echo-room`。不要上传父目录，不要提交 `.env`、`data/`、`node_modules/`。

仓库包含 GitHub Actions：安装、测试、构建、Docker 镜像构建检查、生成可下载部署包。在源代码仓库中 `dist/` 不提交，由 Actions 生成；直接克隆仓库部署前应先在本机或 CI 执行 `npm run build`。

## 实际验证范围

详见 [TEST-REPORT.md](TEST-REPORT.md)。本地测试通过不等于已经在你的 VPS 部署或承诺并发容量。1GB 场景的默认限制需要根据实际 CPU、内存、线路与使用时长调整。

原创代码 MIT，依赖保留各自许可。`dist/THIRD-PARTY-NOTICES.txt` 随部署包交付。
