# 贡献指南

欢迎提交问题、文档和代码改进。开始前请阅读 [行为准则](CODE_OF_CONDUCT.md)、[安全政策](SECURITY.md) 和 [授权说明](docs/media/licensing.md)。安全漏洞不要提交到公开 Issue。

## 本地开发

推荐 Node.js 24 和 npm。运行时最低版本为 22.13；CI 使用 Node.js 24。首次克隆先用 `.env.example` 创建自己的 `.env` 并设置暗号，不覆盖已有私有配置：

```bash
npm ci
npm run dev
```

默认地址为 http://localhost:3000。常用素材已随仓库提供；`npm run assets` 只在确需恢复第三方素材时运行，避免无关的下载和资源变更。实时语音可选，没有 LiveKit 也能开发基础游戏。开发、测试服务使用独立的数据库路径，不接入真实玩家房间。

## 修改边界

- `src/server/roomManager.ts` 是游戏规则与阶段推进的权威来源，不能只修改前端判断。
- `src/shared/` 定义规则、类型和协议；修改事件时一起更新运行时校验、调用方、回执、测试和架构文档。
- 公开状态不能泄露身份或未公开任务牌；私密投影、刺杀亮明和终局公开分别测试。
- 客户端保留本地选人草稿，不能用同步快照覆盖它；不重建媒体生命周期。
- 数据结构变动须定义版本、迁移、备份和回滚，不能删库绕过失败。
- 公网部署默认接入机器已有 Caddy，不增加第二个对外网关。详见 [部署指南](docs/deployment/README.md)。

## 代码规范

- TypeScript 严格模式；使用 `.editorconfig` 的 UTF-8、LF 和两空格缩进。已有文件只格式化涉及的部分。
- 使用有意义的类型和窄化；生产代码禁止显式 `any`，测试替身可有目的地放宽。
- ESLint 检查错误和未使用代码；有意的安全过滤、测试框架语法等例外需局部注释说明，不能整文件关闭规则。
- 注释解释约束和原因，不复述代码。错误回执不得包含凭证、原始请求或内部堆栈。
- 工具脚本导出可测试函数，CLI 入口单独判断；测试临时目录必须有安全清理边界。
- 不把重命名、整仓格式化、生成素材和功能修改混在一个 PR。

## 验证

基础检查：

```bash
npm run check
npm run build:e2e
```

`check` 包含仓库文件/YAML/素材台账、文档本地链接、lint、类型和单元测试；不读取 `.env` 或启动线上服务。`build:e2e` 只写 `.media/e2e-build`，不覆盖在线 `dist`。完整测试命令及工具目录见 [测试说明](docs/development/testing.md)，文档导航见 [文档索引](docs/README.md)。

新增/替换媒体须按 [素材审核流程](docs/media/provenance.md)复核来源与分发条件，取得批准后更新文件摘要；不能仅因文件名/目录相同就沿用旧许可结论，也不能只重算摘要使 CI 通过。确认范围内的项目自制媒体另有 MIT 素材许可，第三方及 MiniMax 不自动适用。

安装官方 Gitleaks 后运行 `npm run audit:secrets`；也可设置 `GITLEAKS_BIN` 指定本机程序。脚本扫描全部本地 Git 历史，并将 Git 可见的拟提交文件复制到临时目录做内容检查，不导出忽略的 `.env`/运行数据，不修改 Git 或发送源码到外部服务。

多人交互、协议或恢复改动另运行：

```bash
node node_modules/@playwright/test/cli.js install chromium
npm run test:e2e
node scripts/verify/verify-recovery.mjs .media/e2e-build
```

修改 Caddy/网络策略后运行 `npm run gateway:verify`，需标准 Caddy；设置 `CADDY_BIN` 可指定路径。修改媒体授权后按部署文档运行合成音与真实设备验证。未完成的验证在 PR 中写明，不能把模板检查当作公网验收。

部署配置逻辑在 `scripts/deploy/deployment.mjs`，测试仅生成临时合成私有文件。修改 Compose 时同步默认值/环境变量表及测试，保持回环绑定、精确代理 `/32` 和单写者数据卷。不得让配置生成器覆盖已有文件、打印暗号或自动部署；恢复 override 必须显式加载并引用已存在的新卷，不能默认替换原数据卷。

## Issue 与 Pull Request

使用 Bug/功能表单，附版本或提交号、环境、脱敏复现步骤及预期行为。截图须遮挡玩家隐私；不要附原数据库、真实房间 token、Cookie、完整日志或 Playwright trace。

PR 应聚焦一个问题，说明规则/协议/数据库兼容性、测试结果和文档变化。涉及 UI 时提供桌面及手机截图，涉及部署时说明现有 Caddy 的兼容性。不要在 fork PR 中使用真实密钥，也不要要求维护者运行来源不明的安装命令。

提交信息建议 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 或 `refactor:`，不强制重写已有历史。除维护者明确决定外，不自动合并依赖更新、不自动发布版本。

## 贡献授权

项目自行编写的代码、配置、测试和文档采用 [MIT](LICENSE)。提交贡献前确认有权以此许可提供相应内容；第三方资源及 `public/assets` 的授权见独立说明，不能因代码采用 MIT 就重新授权它们。不要求额外 CLA，不收集真实姓名或私密身份信息。
