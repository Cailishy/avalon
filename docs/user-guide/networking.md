# 网络与终端支持

核对日期：2026-10-25。这里区分“代码支持的部署方式”与“已经在真实设备/网络验收”。游戏不是纯静态网页，也不内置公网穿透；真人语音与游戏状态走不同链路。

## 支持矩阵

| 环境 | 基础对局、音乐及固定旁白 | 真人实时语音 | 条件与边界 |
| --- | --- | --- | --- |
| 单台电脑本机测试 | 支持，含 5–10 人规则 AI | 可选 | 启动 Node；本机语音另启 LiveKit，localhost/127.0.0.1 可用浏览器安全上下文例外 |
| 同一局域网/同一 Wi-Fi | 支持，可在安装完成后不依赖互联网 | 有条件支持 | 防火墙放行游戏端口、终端间可路由；手机访问普通 HTTP 私网 IP 通常不能授权麦克风，语音需可信 HTTPS 和可达媒体服务 |
| 不同家庭网络、异地 Wi-Fi、4G/5G | 支持的公网拓扑，仍需目标部署验收 | 有条件支持 | 所有人可访问同一个 HTTPS 游戏域名；按公网模式部署 Caddy + Node，媒体另验 LiveKit/ICE/TURN |
| VPN/组网工具连接的私网 | 有条件支持 | 有条件支持 | 依赖实际路由、访问控制、DNS/证书与媒体可达性，不自动发现其他节点 |
| 反向隧道/CDN/多层代理 | 需专门配置并验收 | 不能仅靠 HTTP 隧道保证 | 保留正确 Host/Origin、Socket.IO 与受控代理链；不要把所有转发头或整个互联网设为可信 |
| 只开放 HTTPS 443 的受限网络 | Socket.IO polling 可用时可能正常 | 取决于媒体 TCP/TURN/TLS | 游戏通不代表语音通；某些网络会连 polling/升级请求一起阻断，不能保证绕过组织网络策略 |
| 无 Node，仅双击 HTML 或只传 GitHub Pages | 不支持完整游戏 | 不支持 | 房间、鉴权和状态机在 Node，SQLite 在私有服务端；不是无服务端 P2P/PWA 游戏 |

“离线局域网”不等于不安装软件：需事先安装依赖、准备构建与本地资源。当前音乐/旁白运行时不调用 MiniMax、OpenAI 或在线 TTS；规则 AI 也不调用大模型。公网玩家无需安装 Node，只有部署方需要运行后端。

## 游戏连接与 NAT

[main.ts](../../src/client/main.ts) 使用同源 `io()`，游戏操作经 Socket.IO 发到 Node。默认先使用 HTTP long-polling，再尝试 WebSocket 升级；代理应同时允许 `/socket.io/` 的 GET/POST 和正常升级请求，不能仅配置裸 WebSocket。行为依据 [Socket.IO 官方选项](https://socket.io/docs/v4/client-options/#transports)。

公网玩家通常只需建立出站连接，不要求每位玩家都有公网 IP。部署方则必须让服务入口实际可达：家庭主机处于运营商 CGNAT 后，单纯启动 Caddy 或设置域名不会自动得到入站能力。需要有可达服务器、受控隧道或合适的 VPN/端口映射方案；这些不是项目自动提供的服务。

公网配置要求 `APP_MODE=public`、固定 HTTPS `PUBLIC_ORIGIN`、独立强暗号及精确可信代理；仅开放网关，不公开开发服务或 Node 原始端口。默认 Compose 将 app 映射在 `127.0.0.1:3100`，服务器已有 Caddy 可直接接入，不需要再装 Nginx。跨网用户通过网关域名访问，不访问这个回环地址。操作步骤见 [README.md](../deployment/README.md)。

当前网关模板按直接入口设计。再套 CDN 时，Caddy 看到的连接来源会变化，需重新设计防伪造的真实 IP/代理链，再验应用限流。不能仅转发任意客户端提交的 `X-Forwarded-For`。选择隧道也不意味着可删除公网鉴权、HTTPS 或请求预算。

## 真人语音是独立的网络要求

[voice.ts](../../src/client/voice.ts) 通过 LiveKit WebRTC 发布/接收麦克风声音；游戏 Socket 仅处理授权和状态，不传录音文件。只有配置媒体服务并主动加入/开启麦克风时才请求权限；固定旁白不需要麦克风。

浏览器麦克风要求可信安全上下文及用户授权；普通 `http://192.168...` 不具备本机 localhost 的例外。自签证书没有被客户端信任时也不能视为已解决。见 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

除了游戏 HTTPS，还需要浏览器能访问的 `LIVEKIT_URL`、正确公网 ICE 地址及媒体端口。受限 NAT/防火墙可能需要 TURN 转发及 TCP/TLS 路径；按 [LiveKit 端口与防火墙文档](https://docs.livekit.io/transport/self-hosting/ports-firewall/)配置并从两个真实网络验证。Caddy 的 HTTP 反代不是 TURN 服务器，同一个 IP 的 443 也不能被游戏 Caddy 和 TURN/TLS 简单重复占用。

`.media/voice.env` 与本机 LiveKit 示例只绑定回环；发给手机的 `127.0.0.1` 会指向手机自身，不能直接拿来多人联网。项目默认不录制、未启用 Egress，但媒体服务器和获准收听的玩家属于信任边界；传输加密不是端到端加密，也无法阻止玩家自行录音。

## 已验证到哪里

| 层面 | 当前证据 | 尚不能据此承诺 |
| --- | --- | --- |
| 游戏协议/恢复 | 自动测试、隔离真实 Socket 和跨进程恢复验证 | 任意高并发容量、任意运营商网络 |
| 浏览器交互 | 独立 Chromium/Chrome 上下文、5–10 人及移动视口回归 | 真机 Safari/iOS/Android 后台与网络切换全部通过 |
| 网关 | 临时回环 Caddy 验证拒绝策略、WebSocket/polling、限流及日志脱敏 | 目标公网证书、最终容器镜像、CDN/隧道配置已验收 |
| 语音 | 本机 LiveKit 合成音真实收发与阶段权限检查 | 跨运营商、UDP 被阻断、TURN/TLS、真机麦克风体验已验收 |

每次正式部署仍须按部署文档完成目标环境检查。断线可重连、服务重启可从单实例数据库恢复；没有跨服务器自动容灾，也不支持把多个 Node 副本直接连接同一个 SQLite。换网络可能暂时断开，持有有效原会话才可恢复；不承诺无中断切换。
