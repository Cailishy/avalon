# 发布版本

本文面向维护者，说明可复现的发布方式。内部审批、阶段日志和安全排查原始材料不随源码分发，也不是构建依赖。

## 发布内容

发布源码、锁文件、测试、静态资源、部署模板及使用和开发文档。保留代码与媒体各自的许可和来源说明；不要把完整开发目录压缩上传。

本机环境、数据库、日志、备份、AI 工具配置和会话不在发布范围。Git 忽略规则不能过滤手工压缩包，也不会自动移除已被跟踪的文件。

## 验证最终提交

```bash
npm ci
npm run check
npm run audit:secrets
npm audit --registry=https://registry.npmjs.org --audit-level=low
npm run build:e2e
npm run test:e2e
npm run recovery:verify -- .media/e2e-build
npm run gateway:verify
```

Gitleaks 与 Caddy 需要独立安装。浏览器与恢复测试使用临时端口、数据库和合成玩家，不加入真实玩家的房间。诊断文件保存在忽略目录，不应作为公开发行附件。

锁文件使用 npm 官方 HTTPS registry 并保留完整性摘要；仓库检查拒绝其他下载源、带凭证的地址或缺失摘要。切换本机 registry 不会自动改写已有锁文件地址，应审查锁文件变更，而不是放宽远程包限制。

正式发布前运行 `npm run release:check`，要求必要文件已跟踪、工作区干净、仓库元数据真实、素材清单完整。它不代替凭证扫描、测试、授权判断或 GitHub 网站设置检查。

项目仓库为 [cailishy/avalon](https://github.com/cailishy/avalon)，`package.json` 的 `repository`、`homepage` 和 `bugs` 应与实际地址一致。GitHub 私密漏洞报告、分支保护、通知和权限需管理员在仓库设置中确认，不能用本地布尔值冒充已经启用。

## 独立源码快照

`npm run source:export` 只导出公开白名单内的当前源码，并检查文档、素材与凭证。输出位于忽略的 `.media/exports/avalon-source`，不包含 `.git` 历史、内部维护档案、本机设置或运行数据，不会创建、提交或上传 GitHub 仓库。

可以用 `npm run source:export -- another-name` 指定新的快照名称；已有目录不会被覆盖。快照不是已经验收的 Release，发布前仍须审查内容，从干净环境安装验证，并确认实际 CI 通过。

## 版本与部署

版本号、锁文件、变更记录和标签应对应同一验收提交，不虚构已发布历史。构建物和容器保留项目及依赖的 LICENSE / NOTICE。

部署前备份整个私有数据目录，只保留一个写者。升级、回滚、数据库版本和恢复演练按[部署指南](../deployment/README.md)执行，不为通过健康检查删除数据库或数据卷。

在目标环境验证 HTTPS、代理信任、私有端口、重连、备份恢复和监控。启用语音时另验证麦克风、移动网络、ICE / TURN 和实际终端；没有验收的部分写入版本限制，不承诺任意网络都可用。
