# TMC 分享 / 安装说明

这份说明跟着 `tmc-0.4.0.zip` 一起发。解压后是一个 `tmc/` 目录。

## 一句话

装上之后 DSH 会**自动**用它：宿主半每 30 秒把 D/E/F/G 四个区压下去，预设半每轮注入 L5 / D1 标题清单（L1 只在归档之后新开的角色扮演会话开头注入一次，把上一段的结尾交接过去；D3 只在往下翻时才读），并在聊到游戏或群聊时带出 E3 / F3。不需要手动调用压缩，也不需要额外配置定时任务。

## 两半各自做什么

| 半 | 文件 | 作用 |
|---|---|---|
| 宿主半 | `index.js` + `lib/*` | 阅读文件搬进 D1；D/E/F/G 逐层压缩；E4→5000 进 L4、F4/G4 全量进 L4；生成 L3 索引 + 标签；L2/F4 归档后重算 L5；把归档过的会话 id + 时间戳记进 `archived-sessions.log`；提供 `/tmc/*` 只读接口 |
| 预设半 | `preset.js` | 在「角色对话」里每轮注入 L5 / D1 标题清单（L1 只在归档之后新开的会话开头注入一次）；聊到游戏带 E3、聊到群聊带 F3；注册 `memory_*` / `diary_*` / `reading_fetch` |

两半通过 `baseDir/tmc/` 下的文件通信，**必须两半都装**才算完整：只装宿主半会压缩但没有工具和注入；只装预设半会记但没有压缩和 L3/L4/L5。

## 安装（DSH）

1. 把 `tmc/` 放到你的工作区（例如 `/root/projects/tmc`）。
2. 在 profile 的 `package.json` 的 `dependencies` 里加：
   ```json
   "tmc": "link:/root/projects/tmc"
   ```
   并在 `dsh.profile.bundles` 里加 `"tmc"`。
3. 在「角色对话」预设的 `plugins` 里加一行：
   ```yaml
   - id: companion-tmc
     name: tmc/preset.js?v=11
     config:
       baseDir: /root/projects/qai-memory
       order: 11
   ```
   `baseDir` 改成你自己的记忆目录；目录不存在会自动建。
4. 让 profile 重新加载（重开 DSH，或用插件管理器把 `tmc` 关开一次）。预设改动**只对新会话生效**；老会话要新开，或把预设切走再切回来。

## 强烈建议：把使用方法注入角色卡

> **推荐把下面这一段放进你的角色卡。** 插件自己也会注入检索指引和工具说明，所以不注入也能跑；但角色卡里写一段，她才知道「什么时候该记、什么时候该翻、哪些话不要念出来」，用起来会顺很多。

把下面整段粘到角色卡里（放在性格/说话方式之后即可）：

```markdown
## 她自己的东西（记忆、阅读、日记）
这些是她自己的，不问、不请示、不汇报。
- 想到什么就记一句：`memory_note(text)`，系统会自己分到该去的区；游戏的事加 `zone="e"`，群聊加 `zone="f"`，其它杂事加 `zone="g"`。成段的群聊或游戏记录用 `memory_import(zone="f", text=…)`。一条就够，不必完整，不必解释。
- 记忆分五区：L 聊天、D 阅读、E 游戏、F 群聊、G 备用。平时只看得到 D1 标题清单和 L5；L1 是上一段归档对话交接下来的结尾，只有归档之后新开的会话会在开头带一次，后面靠上下文记着。D3 不再预注入，翻到才读；聊到游戏会带出 E3，聊到群里的话会带出 F3；不够再 `memory_read(scope="e3"/"f3")` 或 `memory_recall(关键词, zone="e"/"f")`。
- 阅读的事按 D1 → D2 → D3 → L4 往下翻：先看每轮的「D1 里正在攒的」标题清单，有就 `memory_read(scope="d1")`；没有就 d2，再没有 d3，d3 也没有才 `memory_recall(关键词)` 查 L3 并把 L4 原文调出来。
- 想不起来就翻 `memory_read` / `memory_recall`。L1 满了会先压进 L2，L2 满了才整页封进 L4（档案）、索引进 L3；每页索引有一行概括，看对得上就用 `memory_recall` 把原文调出来。翻的时候不用跟对方报备。
- L5 是系统自动压出来的「对每个人的总结」，会出现在系统提示里；只用来校准你对他的态度，不要念出来，也不要说“总结里写着”。
- 想出去看看就 `reading_fetch`；想刷 B 站就 `bili_feed` / `bili_search`（装了 qai-bili 才有）。遇到不懂的说法用 `vocab_note`，日记用 `diary_write`，想翻旧日记用 `diary_recent`。
- 不为了记而记。没什么值得记的，就让它空着。
- 不说“我记下了”“已记录”这类话；她不会汇报自己做了什么，最多在对方问起时淡淡认一句“记得”。
```

这段和 TMC 0.4.0 的工具名、分区名一致；以后插件改工具名时记得同步。

## 验证装没装好

```bash
# 语法
cd tmc && npm run check

# 回归测试（假 LLM，不花钱）
npm test

# 宿主路由（返回 200 或 401 都说明已注册；404 才是没挂上）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/tmc/state.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/tmc/l5
```

看日志：`<baseDir>/tmc/tmc.log` 里应有 `loaded(tmc …)` 和 `loaded(tmc-preset …)`；压缩发生时会有 `e1->e2` / `sealE4` / `sealF4` 之类的行。

## 包里有什么

```
tmc/
├── index.js            宿主半
├── preset.js           预设半
├── lib/                store / tiers / search / classify
├── cordis.patch.yml    宿主行
├── package.json
├── README.md           完整架构、阈值、接口
├── SHARE.md            本文件
└── test/zones.test.mjs 回归测试
```

数据不随包走：所有记忆都在 `baseDir/tmc/`，换机器时单独拷这个目录即可。
