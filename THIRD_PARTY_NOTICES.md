# 第三方声明与授权范围

根目录 [LICENSE](LICENSE) 适用于本项目自行编写的代码、测试、配置和文档。它不会重新授权第三方依赖、第三方素材或 `public/assets` 中的媒体文件；后者以 [素材授权说明](public/assets/LICENSE.md)、[来源表](public/assets/ATTRIBUTION.md) 及上游许可为准。

## 运行依赖

下表列出直接运行依赖的上游声明，不代替随发行物保留完整许可证、版权和 NOTICE。实际版本以 `package-lock.json` 为准，传递依赖也需一并核对：

| 依赖 | 上游许可证 | 上游项目 |
| --- | --- | --- |
| express | MIT | https://github.com/expressjs/express |
| helmet | MIT | https://github.com/helmetjs/helmet |
| livekit-client | Apache-2.0 | https://github.com/livekit/client-sdk-js |
| livekit-server-sdk | Apache-2.0 | https://github.com/livekit/node-sdks |
| lucide | ISC；部分源自 Feather 的图标另含 MIT 声明 | https://github.com/lucide-icons/lucide |
| morphdom | MIT | https://github.com/patrick-steele-idem/morphdom |
| proxy-addr | MIT | https://github.com/jshttp/proxy-addr |
| socket.io / socket.io-client | MIT | https://github.com/socketio/socket.io |
| zod | MIT | https://github.com/colinhacks/zod |

安装后的各包 `LICENSE*`、`NOTICE*` 和 `package.json` 是核对入口。前端构建自动生成 `dist/assets/third-party-licenses.txt`，包含构建器收集到的已打包依赖许可，并在 JS 中注明其访问路径；必须随前端产物一起分发。后端依赖未打包，运行容器保留安装包内许可证，另附项目 LICENSE 和本声明。自动收集不替代核对缺失/特殊 NOTICE，也不涵盖媒体许可。Node.js、Caddy、LiveKit 服务端及基础镜像另遵循各自分发条款。

## 非官方素材

项目不包含官方阿瓦隆牌面授权声明，也不代表与原游戏权利人存在合作或认可。角色题材、名称、第三方来源和商标使用应独立审查；没有使用官方图片不等于已经完成所有权利审查。

来源表中的 CC0 是上游声明，不由本项目改成 MIT。2026-10-25 已核对 CC0 文件及派生头像，维护者另同意四张生成图、站点图标和两份自制音效采用 MIT 素材许可；2026-10-29 维护者明确确认现有 16 条 MiniMax 旁白可随本项目公开分发，范围见[录音说明](public/assets/narration/NOTICE.md)，不改为 MIT 或 CC0。确切范围与证据见 [素材审核](docs/media/provenance.md)和 [授权台账](docs/media/assets.json)；技术生成或完整解码通过不是独立的第三方授权证明。
