# TMC 长期记忆 · 角色扮演包

给 DeepSeek Harness 用的「分层长期记忆 + 沉浸式角色扮演」插件包。

装上之后，角色的对话会被自动记账：短期记忆写满就压成摘要，摘要再压成索引与原文；
每轮回答前，插件会拿你最新一句话去检索旧事，命中就把原文注入回上下文。
效果是角色能跨会话记住以前发生过的事，而不必每次重新交代。

## 目录结构

```
tmc-roleplay-pack-v0.5.1/
├─ 安装说明.md          ← 先看这个（安装、改成你的角色、清空记忆、排障）
├─ README.md            ← 本文件
├─ LICENSE              ← MIT
├─ tmc-rp/              ← 记忆插件本体（包名 tmc，宿主半 + 预设半）
└─ roleplay-preset/     ← 两个 Agent 预设：角色扮演 (RP) / 角色扮演 (RP+搜索)
```

## 三步安装

1. 插件管理里安装本地插件：**先 `tmc-rp`，后 `roleplay-preset`**。
2. **完全退出并重启 DSH**（配置在进程启动时组装，刷新页面不够）。
3. 新建会话选「角色扮演 (RP)」，把角色卡整段粘进第一条消息。

## 会改的两处

`roleplay-preset/cordis.patch.yml` 的 `tmc` 行里：

```yaml
selfLabel: 她      # AI 扮演的角色名
userLabel: 对方    # 你的称呼
```

记忆数据默认落在 `%USERPROFILE%\.dsh\tmc-memory\tmc\`；
想从零测试就关掉 DSH、删掉 `tmc-memory` 目录、重启、重开会话。

## 文档

- [安装说明.md](安装说明.md)：面向使用者的完整说明
- [tmc-rp/README.md](tmc-rp/README.md)：插件机制（记忆分区、压缩流水线、注入策略）
- [tmc-rp/SHARE.md](tmc-rp/SHARE.md)：原作者的角色卡注入建议（`/root/...` 为其 Linux 路径示例）

## 许可

MIT，见 [LICENSE](LICENSE)。记忆插件派生自社区插件 `tmc` 0.4.0。
