# 测试与工具

命令在项目根目录执行。单元测试与模块相邻（`*.test.ts`）；多人浏览器测试位于 `tests/e2e/`。测试使用合成玩家、临时端口及独立数据库，不连接现有房间。

## 日常检查

```bash
npm run check
npm run build:e2e
```

`check` 依次执行仓库结构/素材清单、文档本地链接、lint、类型检查和单元测试。`build:e2e` 只写 `.media/e2e-build`，不覆盖在线 `dist`。当前测试数量以当次输出为准，构建不能替代类型检查或回归。

## 多人浏览器

```bash
node node_modules/@playwright/test/cli.js install chromium
npm run build:e2e
npm run test:e2e
```

每名玩家使用独立浏览器上下文，覆盖 5–10 人投票、任务、发言、刺杀、重开、断线/刷新、丢失响应、服务重启，以及节点/焦点保留、移动视口和设备时钟偏差。Windows 可设置 `PLAYWRIGHT_CHANNEL=chrome` 使用本机独立无头 Chrome。报告和失败 trace 位于 `.media/`，不得上传含真实会话的诊断文件。

同机多客户端流程默认使用静音和减少动态效果偏好，单次操作最多等待 15 秒，服务器阶段计时与同步断言保持真实。音乐、音效、旁白的播放器行为由相邻的音频测试覆盖；这些流程不宣称完成真人麦克风或听感验收。页面节点被阶段切换移除时应及时报告操作失败，而不是一直等到整例超时。

## 恢复与网关

```bash
npm run recovery:verify -- .media/e2e-build
npm run gateway:verify
```

恢复验证在隔离生产进程中强制退出并重建服务，核对身份、部分投票、剩余时间与重复结算。网关验证需要标准 Caddy，可用 `CADDY_BIN` 指定可执行文件，检查临时回环拓扑的来源/路径/方法/体积限制、WebSocket/polling、限流及日志脱敏，不申请公网证书。

## 本机语音

安装官方 LiveKit 二进制后执行：

```bash
npm run voice:local
livekit-server --config .media/livekit.yaml
```

另一个终端运行 `npm run voice:verify`，用合成音经过真实 SFU 验证收发和阶段权限，不采集麦克风。生成的凭证与媒体配置留在忽略的 `.media/`；本机测试不替代跨网络 TURN、手机麦克风、Safari/iOS 或切后台验收。详见[部署指南](../deployment/README.md)。

## 工具目录

| 目录 | 用途 | 常用命令 |
| --- | --- | --- |
| `scripts/build/` | 前后端及隔离构建 | `build`、`build:server`、`build:e2e` |
| `scripts/deploy/` | 配置生成、脱敏预检、网关片段和本机媒体设置 | `deploy:init`、`deploy:check`、`deploy:caddy`、`start:public`、`voice:local` |
| `scripts/media/` | 恢复第三方素材、合成音效、固定旁白制作工具 | `assets`、`narration:script`、`narration:verify`、`narration:publish` |
| `scripts/checks/` | 仓库、文档、凭证及发行检查 | `repo:check`、`docs:check`、`audit:secrets`、`release:check` |
| `scripts/verify/` | 跨进程、网关、媒体与手工多人辅助验证 | `recovery:verify`、`gateway:verify`、`voice:verify` |

优先使用 npm 命令。手工辅助工具用法为 `node scripts/verify/ui-smoke-peers.mjs ROOM_CODE [1-9] [ORIGIN]`，只应连接自己新建的专用测试房间，不要让它接入真实玩家房间。

`npm run source:export` 使用公开目录白名单生成独立源码快照，需安装 Gitleaks；会检查文档、素材及凭证，不导出内部档案、本机工具、环境、数据和 Git 历史。具体边界见[发布说明](releasing.md)。

安装、凭证扫描与贡献要求见[贡献指南](../../CONTRIBUTING.md)。严格发行检查、人工审核和远端设置放在[维护者发布流程](../development/releasing.md)，不属于玩家或普通开发的启动步骤。
