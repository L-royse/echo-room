# 在你的 Linux VPS 上部署

这份指南面向独立 Linux VPS（推荐 Debian 12/13 或 Ubuntu 24.04、x86_64），有公网 IPv4 和可绑定的媒体端口。Compose 使用 host 网络，不面向 Windows 容器或无 UDP 的网页托管平台。ARM64 需要先确认锁定版本的 mediasoup 有兼容预编译 worker；此交付未做 ARM 验证。

## 1. 准备域名与端口

给例如 `voice.example.com` 添加 A 记录指向 VPS 公网 IPv4。若使用 Cloudflare，这个记录先设成 **仅 DNS / 灰云**。不要给没有正确配置 IPv6 的机器添加 AAAA 记录。

云安全组和系统防火墙同时放行：

| 端口 | 用途 |
|---|---|
| 80/TCP | 自动签发证书、跳转 HTTPS |
| 443/TCP | 网页、API、WebSocket |
| 40000/UDP | 首选 WebRTC 语音 |
| 40000/TCP | WebRTC TCP 回退 |

保留你实际使用的 SSH 管理端口。**不用开放 3000**，业务服务只监听 127.0.0.1。80/443/40000 必须没有其他服务占用；若已部署宝塔或其他反向代理，请复用原来的 HTTPS 代理并只启动 `app`，不要让两个代理争抢端口。转发 WebSocket 到 127.0.0.1:3000，并覆盖 `X-Real-IP` 为实际客户端 IP。

公网直达 SFU 时，通常不必另部署 TURN。某些企业网/校园网只允许 HTTPS 出口，40000 UDP/TCP 都可能受阻，此时需要额外 TURN（见后文），不能承诺所有网络都能连接。

## 2. 安装运行环境

按系统对应的 [Docker 官方安装说明](https://docs.docker.com/engine/install/) 安装 Docker Engine 与 Compose 插件。确认：

```bash
docker --version
docker compose version
```

需要 `tar`、`bash`、`openssl`；常见 Linux 已预装。如果当前用户没有 Docker 权限，使用你既有的 sudo 管理方式。不要把 Docker socket 暴露到公网。

1GB 内存机器建议保持系统轻量。Swap 可以缓冲瞬时内存压力，但不能代替 RAM，也不能保证低延迟。不要在这台机器上编译原生媒体引擎。

## 3. 上传部署包并启动

把 `echo-room-1.0.0.tar.gz` 上传到服务器自己的应用目录：

```bash
tar -xzf echo-room-1.0.0.tar.gz
cd echo-room-1.0.0
bash setup.sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 app caddy
```

setup 会询问域名、公网 IPv4、证书通知邮箱，然后生成只允许当前用户读取的 `.env`。密码和邀请码使用 openssl 随机生成，无默认生产密码。域名应不带协议/路径，IP 填公网 IP。

部署包包含预构建网页 `dist`；Docker 构建只安装生产依赖，下载 mediasoup 预编译 worker。首次安装需要访问 npm 和 GitHub Releases。如果下载失败，镜像没有编译工具，构建会失败；不要尝试在 1GB VPS 上强行编译，优先解决网络、或在配置充足的同架构 Linux/CI 上构建镜像再 `docker save/load` 迁移。

打开 `https://你的域名`。管理员用户名是 `admin`，密码位于 `.env` 的 `ADMIN_PASSWORD`。把 `INVITE_CODE` 单独发给朋友注册。

管理员仅在数据库没有同名用户时创建。已有数据库后修改 `.env` 的 ADMIN_PASSWORD **不会自动重置旧密码**。请在首次部署保存密码。

## 4. 上线后验收

1. 两台不同网络的设备打开 HTTPS 网站，分别登录不同账号。
2. 加入同一个语音频道，允许麦克风，确认双方听得见。
3. 检查静音、耳机静音、切换房间、离开和重新加入。
4. 管理员禁言/移出另一成员，验证状态同步。
5. 发送文字并刷新确认历史；尝试手机窄屏侧栏。
6. 从 2 人增至 4 人，再到 8 人，观察 `docker stats --no-stream`；留意 app 是否反复重启、语音是否断续。

不要在单个浏览器里用同一账号开多个标签来模拟多人；应用会保留最新连接。两台设备或独立浏览器资料夹更适合测试。

## 5. 运维与数据备份

```bash
docker compose logs --tail=100 app
docker stats --no-stream
docker compose restart app
```

数据库保存在命名卷 `echo-room_echo-data`；应用重建不会清空它。**不要使用 `docker compose down -v`**，那会删除数据和证书卷。

一致性备份建议短暂停服后复制整个数据目录（SQLite 的 WAL/SHM 文件也一起保留）：

```bash
mkdir -p backups
docker compose stop app
docker compose cp app:/data "backups/data-$(date +%Y%m%d-%H%M%S)"
docker compose start app
```

如果复制失败，也应先重新启动 app，再排查备份。把备份另存到其他机器，权限按包含账户数据的敏感文件处理。

恢复前先停止 app，保存当前卷的备份；将备份目录里的 `echo.sqlite` 及可能存在的 `echo.sqlite-wal`/`echo.sqlite-shm` 作为同一套恢复，不混用新旧文件，保持 UID/GID 为容器 `node` 用户（1000:1000）。不要仅在运行中拷贝一个 sqlite 主文件。

每频道保留最多 2000 条消息，Docker 日志各最多 2×5MB。SQLite 删除旧记录后会复用空页，数据库文件不一定立即变小，这是正常行为。

## 6. 配置说明

| 变量 | 说明 |
|---|---|
| PUBLIC_ORIGIN | 完整 HTTPS 来源，无尾部斜杠，例如 https://voice.example.com |
| RTC_ANNOUNCED_ADDRESS | 浏览器可达的公网 IPv4；不能填 Docker 内网 IP |
| RTC_PORT | 默认 40000，修改后同步云安全组和防火墙 |
| MAX_VOICE_USERS | 全站语音人数上限，默认 8 |
| MAX_ROOM_USERS | 单频道上限，默认 8 |
| MAX_CONNECTIONS | 网页在线连接上限，默认 40 |
| MAX_USERS | 注册人数上限，默认 100 |
| INVITE_CODE | 注册邀请码，修改后可使旧邀请码失效；不影响已有账号 |

修改 `.env` 后执行 `docker compose up -d --force-recreate app`。人数上限不能作为容量承诺，1GB 机器建议保持默认值。

## 7. 可选 TURN

项目支持基于共享密钥生成有时效的 TURN 凭证，不在浏览器下发永久共享密钥。如果你已经有 Coturn：

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=与Coturn的static-auth-secret一致的随机长密钥
```

Coturn 需要开启 `use-auth-secret` 并设置 `static-auth-secret`，正确配置 realm、external-ip、监听端口和中继端口，所有相应端口须放行。应限制私网/环回目标，避免将中继变成访问内部网络的通道。具体按 [Coturn 官方配置](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) 操作。

若需要 `turns:...:443?transport=tcp` 穿过只允许 443 的网络，通常应另用一个公网 IP 或另一台 TURN 主机，因为本项目 Caddy 已使用 443；不要把普通 HTTPS 反向代理误当成 TURN 代理。

本次没有部署或实测 Coturn。短期凭证有效 24 小时；超长会话或网络变化后建议退出并重新加入语音。

## 8. 常见问题

- **网页正常，语音连接失败**：检查 40000/UDP+TCP、公网 IP、容器日志、网络出口限制；网站 HTTPS 成功不说明媒体端口通。
- **麦克风不可用**：需要 HTTPS、浏览器麦克风权限与系统权限；移动浏览器切到后台可能暂停音频。
- **听不到声音**：确认不是耳机静音、系统静音或管理员禁言；若显示“恢复声音播放”请点击。
- **来源不匹配**：访问地址与 PUBLIC_ORIGIN 必须完全一致，包括协议和端口；不应带结尾 `/`。
- **登录服务繁忙**：为了控制 scrypt 内存，同时只处理 2 个登录/注册；稍后重试。
- **验证码？**：此版本没有邮件找回或验证码；用户应自行保管密码。
- **流量多**：看服务商控制台实际统计。SFU 会转发每位讲话者给其他参与者，持续多人讲话的流量远高于安静挂房。

## 9. 上传到 GitHub

在 GitHub 的 L-royse 账号下新建空仓库 `echo-room`，以项目目录为根上传。若使用 Git：

```bash
git init
git add .
git commit -m "Initial Echo Room voice community"
git branch -M main
git remote add origin https://github.com/L-royse/echo-room.git
git push -u origin main
```

首次推送需要你自己的 GitHub 登录授权。本交付未替你创建远程仓库，也不包含 GitHub token。Actions 成功后可以从对应运行的 Artifacts 下载预构建部署包。
