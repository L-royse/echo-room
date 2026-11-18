# 分析与实现方案

## 目标与边界

目标机器：2 vCPU、1GB RAM、40GB SSD、每月 1TB 传输。目标使用方式是朋友间的小型语音社区；不是大规模 Kook 复刻。默认 8 人同时语音是主动设置的容量保护线，不是压力测试结论。

前一轮建议堆叠 MySQL、Redis、Node、SFU、Coturn，对 1GB 主机的余量过小。这里改为 SQLite + Node 业务进程 + 一个 mediasoup worker；Caddy 提供网站入口。默认不另启数据库、缓存、TURN、转码或录制进程。

## 架构

```text
浏览器 ── HTTPS/WSS:443 ── Caddy ── 127.0.0.1:3000 Node + SQLite
  │                                             │
  └── WebRTC UDP/TCP:40000 ── mediasoup worker ────┘
```

HTTP 提供登录、历史记录、管理接口。WebSocket 提供在线状态、实时消息和 WebRTC 信令。SFU 只转发音频，不混音、不转码，每个参与者上传一路音频、接收其他人的音频。所有用户到服务器，不依赖用户间 P2P。

采用单个 Router，并在每次列表/订阅请求上核对当前频道归属；不能订阅其他房间的音频。一个账号最多一个发送和一个接收 transport、一路音频 producer。一个共享 WebRTC 端口同时支持 UDP/TCP，避免开放大段媒体端口。视频和数据通道不启用。

官方技术依据：

- [mediasoup 架构与 API](https://mediasoup.org/documentation/v3/mediasoup/api/)
- [客户端与服务器信令流程](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)
- [安装与预编译 worker](https://mediasoup.org/documentation/v3/mediasoup/installation/)
- [客户端 Opus 配置](https://mediasoup.org/documentation/v3/mediasoup-client/api/)

依赖具体版本已锁定到 package-lock.json；部署使用 npm ci。

## 内存与 CPU

只分配一个 SFU worker，Node 堆上限 192MiB，整个 app 容器上限 420MiB，Caddy 上限 100MiB。上述是**限制值，不是测得的占用**。超出限制会退出/重启，不能以限制替代容量测试。剩余内存给 Linux、Docker、缓存和突发分配。

服务端无需视频编解码，2 vCPU 的小规模音频转发值得尝试。用户数、同时讲话人数、包率、TLS 和日志均会影响负载。建议从 2 人开始，逐步到 4/8 人，观察 docker stats、丢包和 CPU；不要直接提高配置上限。

## 流量估算

近似公式（SFU，下行单方向，不含协议开销）：

`总下行 kbps = 同时发送音频的人数 × (房间人数 - 1) × 每路音频 kbps`

8 人房间、每路 32kbps：

| 同时讲话 | 理论总下行 | 每小时下行 |
|---|---:|---:|
| 1 人 | 224kbps | 约 0.10GB |
| 2 人 | 448kbps | 约 0.20GB |
| 8 人 | 1792kbps | 约 0.81GB |

还需计入 RTP/UDP/IP/DTLS 开销、重传、入站计费规则、TURN 和非语音流量。Opus DTX 可降低静默期间的带宽，但不能当成完全零流量。8 人都连续讲话 30 天，纯音频下行已约 581GB，加上开销和入站可能进一步接近配额。

这修正了前面对“在线人数直接决定月流量”的过度简化：同时讲话人数和每日使用时长很关键。1TB 是流量额度，不代表峰值带宽或延迟，仍需确认服务商 Mbps、地域和用户网络。

## 数据与权限

- 用户与频道、消息、会话存 SQLite；WAL 模式，预编译参数化 SQL。
- 密码用异步 scrypt 与独立随机盐，不存明文；同时最多 2 个密码运算。
- 会话是随机 token；数据库只存 token 哈希。Cookie 使用 HttpOnly/SameSite=Strict，生产环境 Secure。七天到期，重新登录替换旧会话。
- HTTP 写请求和 WebSocket 都校验 Origin；代理重写真实 IP，业务仅监听回环地址。
- 消息前端使用 textContent；CSP 禁止内联脚本；信令有大小、速率和队列限制。
- 超时/掉线/频道删除会清理 transport/consumer/producer。
- 不录音；服务器转发的 WebRTC 传输有加密，但**没有提供参与者之间的端到端加密保证**。服务器拥有者应被信任。
- 一个空间内的所有已注册成员能读取文字频道并加入语音频道；邀请码应只发给可信朋友。

## 尚未实现

账号封禁、密码找回邮件、好友、私信、复杂频道 ACL、文件上传、推送、机器人、跨节点扩展、录音、端到端加密均不包含在这一版。多人语音、基础消息与管理已经是真实实现，不是静态演示。
