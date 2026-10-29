# 文档

想先玩一局，从快速开始和游戏规则读起。准备部署或改代码时，再看对应说明。

## 使用游戏

| 文档 | 内容 |
| --- | --- |
| [快速开始](../README.md#快速开始) | 安装、入场暗号与本地启动 |
| [游戏规则](user-guide/rules.md) | 房间、任务、投票、发言、刺杀及规则变体 |
| [网络与终端](user-guide/networking.md) | 局域网、公网、移动网络与麦克风条件 |

## 部署与开发

| 文档 | 内容 |
| --- | --- |
| [部署指南](deployment/README.md) | 复用已有 Caddy、容器、语音、升级和备份恢复 |
| [架构](development/architecture.md) | 模块、状态机、协议与数据流 |
| [安全设计](development/security.md) | 游戏服务、代理、存储与语音的信任边界 |
| [测试与工具](development/testing.md) | 隔离构建、浏览器、恢复、网关及语音验证 |
| [发布版本](development/releasing.md) | 通用发布方式与独立公开源码快照 |
| [贡献指南](../CONTRIBUTING.md) | 开发环境、改动边界与代码规范 |
| [安全政策](../SECURITY.md) | 私密报告和漏洞处理方式 |

## 媒体

| 文档 | 内容 |
| --- | --- |
| [旁白制作](media/narration.md) | 固定台词、预生成录音、校验与本地发布 |
| [代码与素材许可](media/licensing.md) | 代码 MIT 与各类媒体的独立许可范围 |
| [素材来源](media/provenance.md) | 公开来源、生成说明及分发范围 |
| [素材清单](media/assets.json) | 当前分发文件、大小、摘要与来源依据 |
| [展示图片](images/README.md) | README 实机截图与单张角色卡的来源 |

目录按玩家、部署、开发和媒体用途组织。内部排查过程、阶段验收、历史比较与本机工具配置不属于公开文档，也不是构建或 CI 的依赖。
