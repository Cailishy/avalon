# 测试与工具

命令在项目根目录执行。单元测试与模块相邻（`*.test.ts`）；多人浏览器测试位于 `tests/e2e/`。测试使用合成玩家、临时端口及独立数据库，不连接现有房间。

## 日常检查

```bash
npm run check
npm run build:e2e
```

`check` 依次执行仓库结构/素材清单、文档本地链接、架构边界、lint、类型检查和单元/集成测试。`build:e2e` 使用生产构建流程，只写 `.media/e2e-build`，不覆盖在线 `dist`。当前测试数量以当次输出为准，构建不能替代类型检查或回归。

## 功能与回归范围

| 能力 | 实现与验证入口 |
| --- | --- |
| 创建/加入、准备/取消、调整人数、踢人、离开、解散与重开 | [房间测试](../../src/server/roomManager.test.ts)、[真实 Socket 测试](../../src/server/socketHandlers.test.ts) |
| 5–10 人配置、随机首任队长、忠臣男女卡面与私密知识 | [共享规则](../../src/shared/game.test.ts)、[房间测试](../../src/server/roomManager.test.ts) |
| 任意未完成任务、选人、30 秒组队/表决/任务、多数反对与强制发车 | [纯判定](../../src/server/domain/roomRules.test.ts)、[流程计算](../../src/server/domain/roomFlow.test.ts)、房间测试 |
| 发车失败、匿名任务牌、任务结果、顺时针发言与两类胜负 | 房间测试、[多人浏览器流程](../../tests/e2e/game.spec.ts) |
| 两分钟刺杀讨论、阶段限制、亮明范围、提前提交与超时 | 房间测试、真实 Socket 测试、多人浏览器流程 |
| AI 补位、随机短昵称、AI 发言顺序及旧动作取消 | 房间测试、[房间生命周期](../../src/server/roomLifecycle.test.ts) |
| 表单保留、选人草稿、弹窗动效、角色与任务详情 | [客户端入口](../../src/client/main.test.ts)、[DOM 更新](../../src/client/domRenderer.test.ts)、[任务详情](../../src/client/questDetails.test.ts) |
| 固定旁白、背景音乐、结果音效、音量和离房清理 | [音频播放器](../../src/client/audio.test.ts)、[静态旁白](../../src/client/narrationAssets.test.ts) |
| 语音短期授权、当前发言人权限和异步授权复验 | [服务端语音](../../src/server/voice.test.ts)、[客户端语音](../../src/client/voice.test.ts)、可选真实 SFU 验证 |
| 幂等回执、提交顺序、提交后广播故障与状态补偿 | [命令执行器](../../src/server/application/commandExecutor.test.ts)、[全部业务命令映射](../../src/server/application/roomApplicationService.test.ts)、[SQLite/Socket 恢复](../../src/server/serverRecovery.test.ts) |
| 私有存档、版本迁移、剩余时间恢复、宽限与故障暂停 | [持久化测试](../../src/server/roomPersistence.test.ts)、SQLite/Socket 恢复、隔离进程验证 |
| 暗号门禁、Origin/代理、schema、配额和 Caddy 接入 | [门禁](../../src/server/accessGate.test.ts)、[安全边界](../../src/server/security.test.ts)、[部署工具](../../scripts/deploy/deployment.test.ts)、独立网关验证 |

应用服务测试逐一覆盖 `COMMAND_EVENTS` 中全部 15 个业务命令，检查原参数/返回值、拒绝时不登记变更，以及需要 AI 的动作只在提交后调度；增加命令时必须同步补齐。执行器测试区分“数据库提交失败”和“已提交、通知失败”，后者不得变更原回执或重复执行。真实 Socket/SQLite 测试另验证广播失败后仍返回原成功结果，并可通过 `room:sync` 修复视图。

### 公开版本兼容

2026-11-02 以公开仓库的固定提交 [1cb8f9c](https://github.com/Cailishy/avalon/tree/1cb8f9c4490b16ca8eeacce29e6483664be1b676)核对：既有 15 个业务命令、同步/重连/校时/语音事件、核心规则、媒体与部署入口保留；原 Socket/持久化路径提供兼容导出。重构增加应用服务和纯规则边界，不增加部署进程，不要求重建数据库。此对照仅针对该提交，不代表自动兼容未来的 `main`。

“保留已有功能”不等于架构迁移全部完成或所有环境均已验收。剩余拆分见[模块化方案](modularization-plan.md)；浏览器回归不覆盖大规模并发、Safari/iOS 真机、跨网络 TURN、真实麦克风听感、目标服务器证书/防火墙和 DDoS 防护。

## 多人浏览器

```bash
node node_modules/@playwright/test/cli.js install chromium
npm run build:e2e
npm run test:e2e
```

每名玩家使用独立浏览器上下文，覆盖 5–10 人投票、任务、发言、刺杀、重开、断线/刷新、丢失响应、服务重启，以及节点/焦点保留、移动视口和设备时钟偏差。Windows 可设置 `PLAYWRIGHT_CHANNEL=chrome` 使用本机独立无头 Chrome。报告和失败 trace 位于 `.media/`，不得上传含真实会话的诊断文件。

同机多客户端流程默认使用静音和减少动态效果偏好，普通操作最多等待 15 秒；发言辅助器会同时等待下一位发言按钮或服务器宣布进入下一阶段，以覆盖 Socket 重连和阶段广播的短暂竞态。服务器阶段计时与同步断言保持真实。音乐、音效、旁白的播放器行为由相邻的音频测试覆盖；这些流程不宣称完成真人麦克风或听感验收。

弱网用例同时控制浏览器离线和 WebSocket 代理：显式关闭页面侧与上游连接，故障窗口内拒绝建立新的代理上游，再解除限制验证原会话恢复。不能仅设置浏览器 `offline` 就假设测试进程代开的上游 Socket 已断开，也不能删除其他玩家看到离线状态的断言来使测试通过。

同步边界的相邻测试覆盖：阶段广播先于提交 ack、丢失 ack 后查回执、不同房间实例的乱序旧包、私密快照的玩家归属、退出后的迟到展示消息，以及 socket 重新绑定和重复入场时连接状态版本号的推进。它们使用确定性事件顺序重现竞态，不依赖浏览器偶发超时来发现问题。

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
