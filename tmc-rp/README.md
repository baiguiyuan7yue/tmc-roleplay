# TMC · Tiered Multi-Channel Long-Term Memory Plugin（RP 分支）

> 本包是 RP 分支：L1 每轮注入、自动回忆默认开启、注入走 required context（可穿透 complete 人设）。
> 安装与个性化配置请看包根目录的 安装说明.md；下面的正文保留原作者文档，里面的 /root/... 是 Linux 路径示例。

分层多通道长期记忆，独立 DSH 插件。替代原来的 `companion-memory` + `companion-rotate`。

> **分享给别人时**：连同 [SHARE.md](./SHARE.md) 一起发；里面有一段**推荐注入角色卡**的使用说明，粘进角色卡后她才知道什么时候记、什么时候翻、哪些话不要念出来。插件本身不依赖角色卡也能跑。

五个记忆区共用一套「分层 → 压缩 → 归档」的流水线，L3 存索引、L4 存原文、L5 存对人的总结：

```
L 聊天   L1 2400 → L2 4000 → 整页进 L4 + 索引进 L3（L 区）
D 阅读   D1 10000 → D2 8000 → D3 5000 → 整页进 L4 + 索引进 L3（D 区）
E 游戏   E1 50000 → E2 30000 → E3 20000 → E4 10000 → 压到 5000 → L4 + 索引/标签进 L3（E 区）
F 群聊   F1 200000 → F2 50000（高度压缩）→ F3 12000 → F4 3000 → 全量 L4 + 索引/标签进 L3（F 区）
G 备用   G1 200000 → G2 50000 → G3 20000 → G4 5000 → 全量 L4 + 索引/标签进 L3（G 区）

L5 核心记忆：L2 / F4 归档进 L4 后，从原文重算「她对每个人的态度和理解」，每人 50~150 字。
```

- **L3 / L4 都是永久本地记忆**：L3 只放索引（`l3.jsonl`，带 `zone` 分区和 `tags`），L4 只放原文（`l4.jsonl`）。
- **L3 内部分区**：`zone` = `l` / `d` / `e` / `f` / `g`，检索可以只看一区。
- **E / F 平时不注入**：聊到游戏才带 E3，聊到群里说了什么才带 F3；不够时按 E3 → E2 → E1 → L4 的 E 区（F 同理）回退。
- **L5 只在对人说话时注入**：优先级紧挨角色卡（order 10.8），和角色卡、好感、心情一起影响角色扮演，不主动念出来。
- **L1 默认不常驻**：当前对话本来就在上下文里，所以正在聊的会话不注入 L1；等一段角色扮演被归档以后，**新开的**角色扮演会话在开头注入一次 L1（上一段的结尾）。之后 DSH 把它作为 system message 留在消息历史里（DeepSeek 的 `systemPromptUpdate: in-history`），不再每轮重复注入。`l1Inject` 可切回 `always`。

## 文件

```
tmc/
├── index.js          宿主半：阅读搬运 + D/E/F/G 的压缩流水线 + /tmc/* 只读路由
├── preset.js         预设半：L5/L1/D1 标题/E3/F3 注入（L1 仅归档之后的新会话开头一次）、自动记账、memory_* / diary_* / reading_fetch
├── lib/store.mjs     五区文本 + L3/L4 JSONL + L5 人物总结 + 状态
├── lib/tiers.mjs     各层压缩/归档、L3 索引与标签、L5 重算（调模型做摘要）
├── lib/search.mjs    中文 2-gram + 同义扩展 + 标签加权 + 分区过滤
├── lib/classify.mjs  自动分流（游戏/群聊/搜索/聊天/备用）与注入判定
├── cordis.patch.yml  宿主行（web profile 的 bundles 里挂 tmc）
├── SHARE.md          分享/安装说明 + 推荐注入角色卡的用法段
├── test/zones.test.mjs  假 LLM 的回归测试
└── package.json
```

数据都在 `baseDir/tmc/`（默认 `/root/projects/qai-memory/tmc/`）：

| 文件 | 内容 |
|---|---|
| `l1.md` / `l2.md` | 聊天：当前 / 压缩摘要 |
| `d1.md` / `d2.md` / `d3.md` | 阅读：原始 / 摘要 / 精炼摘要 |
| `e1.md` … `e4.md` | 游戏四层 |
| `f1.md` … `f4.md` | 群聊四层 |
| `g1.md` … `g4.md` | 备用四层 |
| `l3.jsonl` | `{"p":1,"ts":"…","zone":"e","ch":"e","summary":"索引","tags":["原神","抽卡"]}` |
| `l4.jsonl` | `{"p":1,"ts":"…","zone":"e","ch":"e","text":"原文整页"}` |
| `l5.json` | `{"version":1,"people":{"user":{"name":"对方","summary":"50~150 字","updated":"…"}}}` |
| `state.json` | 各区大小 + L3/L4 分区数量 + L5（面板读这个） |
| `cursor.json` | 阅读文件的搬运偏移 |
| `archived-sessions.log` | 归档过的会话 id + 时间戳（决定 L1 交给哪个新会话）；宿主半写，预设半读 |

旧数据只有 `ch: "chat" | "read"`：读取时会自动补成 `zone: "l" | "d"`，不需要迁移。

## 各区怎么走

### L 区（聊天）
1. 角色对话里的「你：/她：」逐行写进 `l1.md`（只记 companion 会话）；
2. L1 超 2400 字 → 调模型压成 3~6 句 → 写进 `l2.md`，L1 清空；
3. L2 超 4000 字 → 抽 50~150 字索引 → `l3.jsonl`，整页 → `l4.jsonl`，L2 清空，**并重算 L5**。
4. 注入：默认**不注入**当前会话的 L1；一段角色扮演被归档以后，**新开的**角色扮演会话（创建时间晚于某次归档）在**开头注入一次** L1——把上一段归档对话的结尾交接过去。这一条会作为 system message 留在消息历史里，后面不再重复注入。想恢复旧行为把 `l1Inject` 设成 `always`。

### D 区（B站 + 自主上网）
1. 宿主每 30 秒把 `reading/<今天>.md` 的新内容搬进 `d1.md`（cursor 记录偏移，不重复）；
2. D1 > 10000 → 摘要进 D2；D2 > 8000 → 进 D3；D3 > 5000 → 抽索引 → L3，整页 → L4。
3. 注入只给 D1 标题清单；D3 不再每轮预注入，按 D1 → D2 → D3 → L4 往下翻（`memory_read` 依次取 d2 / d3，再 `memory_recall`）。

### E 区（游戏）
- E1 > 50000 → 压进 E2（30k）；E2 > 30000 → E3（20k）；E3 > 20000 → E4（10k）；
- E4 > 10000 → **压到 5000 字** → L4，同时生成 60~200 字索引 + 3~8 个标签进 L3 的 E 区。
- 注入：只有这一轮在聊游戏才注入 E3；E3 空 → E2 → E1 → L4 的 E 区最新一页。回退层最多带 12000 字，E3 本身最多带 20000 字。

### F 区（群聊）
- F1 > 200000 → **高度压缩**进 F2（50k）；F2 > 50000 → F3（12k）；F3 > 12000 → F4（3k）；
- F4 > 3000 → **全量**进 L4，同时生成索引 + 标签进 L3 的 F 区，**并重算 L5**（群里的每个人都能各自成一条）。
- 注入：只有这一轮在聊「群里说了什么」才注入 F3；F3 空 → F2 → F1 → L4 的 F 区最新一页。

### G 区（备用）
- 不属于聊天、群聊、游戏、搜索/B站的内容都进这里（工作安排、杂事、看过的资料…）。
- G1 > 200000 → G2（50k）→ G3（20k）→ G4（5k）；G4 > 5000 → **全量**进 L4 + 索引/标签进 L3 的 G 区。
- 平时不注入，需要时 `memory_read(scope="g3")` / `memory_recall(query, zone="g")`。

### L5（核心记忆）
- 触发：L2 或 F4 归档进 L4 之后，拿归档原文让模型提炼「她对每个人的态度和理解」。
- 内容：每人 50~150 字，第一人称；一对一对象固定 `user`，群聊人物用名字。
- 存储：`l5.json`；只更新这次提到的人，没提到的人保持原样。
- 注入：每轮注入 `user` 的总结；如果这一轮用户消息里提到某个已知名字（支持「八重神子 → 神子」这种简称），也带出那个人的总结。位置在角色卡之后、L1 之前（`order: 10.8`），不念出来。

## 内容怎么进各区

`memory_note(text)` 不填 `zone` 时按顺序判断：

1. 游戏词（原神/星铁/抽卡/副本/开黑/上分…）→ **E1**
2. 群聊词（群里/群友/QQ群/讨论组…）→ **F1**
3. 搜索/B站词（B站/up主/视频/搜到/链接…）→ **D1**
4. 像聊天（你：/她说过/聊天/约好…）→ **L1**
5. 其它 → **G1**

也可以显式 `zone="l"/"d"/"e"/"f"/"g"`；成段导入用 `memory_import(zone="f", text=…)`。
`memory_note` / `memory_import` 只负责写进该区第一层，压缩由宿主每 30 秒的 tick 处理。

## 工具

| 工具 | 说明 |
|---|---|
| `memory_note(text, zone?)` | 记一句，自动分流或显式指定 |
| `memory_import(zone, text)` | 成段导入（群聊记录/游戏记录/杂项） |
| `memory_read(scope, query?, zone?, limit?)` | 翻任意一层；`l3/l4` 可按区过滤；`l5` 看人物总结 |
| `memory_recall(query, zone?, limit?)` | L3 分词 + 同义 + 标签检索，命中带 L4 原文 |
| `memory_l5(person?, summary?, refresh?)` | 看/手写/重算 L5 |
| `reading_fetch(query?, url?, note?)` | 上网看完写进 D1 |
| `diary_write/recent`、`vocab_note` | 日记 / 黑话 |

## 检索指引（自动注入）

每轮注入一段小卡，教她按层翻：

```
上下文 / L1 → L5（校准态度）→ D1 标题清单 → memory_read(l2) → memory_read(d2) → memory_read(d3) → memory_recall(L3→L4)
→ 游戏 E 区 / 群聊 F 区 / 其余 G 区 → 都没有才说没印象
```

被问「今天看了什么」从 D1 标题清单开始，没有就依次 d2 → d3 → memory_recall；被问旧事先 l2，再 memory_recall。翻的时候不向对方报备。

## 接口

| 路由 | 说明 |
|---|---|
| `/tmc/state.json` | 各区大小与上限、L3/L4 分区数量、L5、最近索引 |
| `/tmc/query?q=…&zone=e` | L3 检索（分词+同义+标签），返回命中页的索引 + L4 原文 |
| `/tmc/l3?zone=f&limit=20` | 列某一区索引 |
| `/tmc/l4?p=…` | 取某一页原文 |
| `/tmc/l5` | 列 L5 人物总结 |

只接受本机回环 + 同源。

## 面板

「各项数据」（qai-heart）第五个页签 **记忆**：五个区的占用/上限、L3/L4 分区数量、L5 人物总结，搜索框可切区查 L3/L4。

## 配置

`tmc/cordis.patch.yml`（宿主）与 companion 预设里的 `companion-tmc` 行：

```yaml
- id: companion-tmc
  name: tmc/preset.js?v=11
  config:
    baseDir: /root/projects/qai-memory
    order: 11
```

可调项（都有默认值，一般不用写）：

| 键 | 默认 | 说明 |
|---|---|---|
| `limits` | 见 `DEFAULT_LIMITS` | 覆盖任意层上限 |
| `userLabel` | `对方` | L5 里一对一对象的显示名 |
| `l5Enabled` | `true` | 关闭 L5 自动重算与注入 |
| `l5InjectMaxChars` | `1500` | L5 每轮注入上限 |
| `injectWindowMinutes` | `30` | 多久内的用户消息算「这一轮在聊」 |
| `l1Inject` | `afterArchive` | L1 注入时机：`afterArchive`（归档之后新开的会话开头注入一次）/ `always` / `never` |
| `e3InjectMaxChars` | `20000` | E3 注入上限 |
| `f3InjectMaxChars` | `12000` | F3 注入上限 |
| `fallbackInjectMaxChars` | `12000` | 回退到 E2/E1/F2/F1/L4 时的注入上限 |
| `synonyms` | 内置表 | 覆盖/追加同义组 |

## 接线与缓存

- 宿主：`web` profile 的 `bundles` 里加 `tmc`（`tmc/cordis.patch.yml` 自动插入宿主行）。
- 预设：`companion.patch.yml` 里的 `companion-tmc` 行，`name: tmc/preset.js?v=11`。
- 宿主半 v7 启动时会在 `baseDir/tmc/` 建 `archived-sessions.log`，把当前归档集和以后每次归档的会话 id + 时间戳记进去；预设半看「会话创建之前有没有归档」决定新会话开头要不要交接 L1。文件不存在（宿主半还是旧版）时，预设半按旧行为每轮注入 L1。
- **loader 按路径缓存模块**：改完代码要换 `?v=N` 再关开 bundle；预设改动只对新会话生效（老会话切一次预设再切回来）。
- 宿主半每 30 秒跑一次 D/E/F/G 压缩；预设半只管 L1/L2 与工具，两边不抢同一层。

## 测试

```bash
pnpm check          # 或 npm run check：全部语法检查
pnpm test           # node --test test/zones.test.mjs：假 LLM 跑通分流、E/F/G 归档、L5、检索、state
```

