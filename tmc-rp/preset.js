// TMC 预设半（RP 分支）：跑在「角色扮演」预设里。
//
//   · 每轮注入（全部走 systemPrompt.context(required: true)，可穿透 complete 人设）：
//       L5（对眼前人的总结）+ L1（当前记忆，默认每轮）+ 自动回忆（L2 摘要 / L3→L4 命中）
//       + E3/F3（聊到游戏/群聊时）+ 检索指引 + D1 标题清单
//   · 自动记账：角色对话逐行写进 L1；L1 满 → 压缩进 L2；L2 满 → 整页进 L4 + 索引进 L3
//   · 自动回忆：拿用户最新一句话去匹配 L2 摘要与 L3 索引，命中把 L4 原文直接注入上下文，
//     不依赖模型主动调工具；memory_read / memory_recall 保留作深挖手段
//   · 工具：memory_note / memory_import / memory_read / memory_recall / memory_l5 /
//           reading_fetch / diary_* / vocab_note
//
// 检索顺序：上下文 / L1 → 自动回忆（L2 / L3→L4）→ memory_read(l2) → memory_recall → 都没有才说没印象。
import fs from 'node:fs'
import path from 'node:path'

import {
  createStore, DEFAULT_LIMITS, DEFAULT_UTC_OFFSET, zoneLabel, zoneShort,
} from './lib/store.mjs?v=6'
import {
  sealL1, sealL2, stamp, updateL5, writeState,
} from './lib/tiers.mjs?v=6'
import { searchPages, tokenize, expand } from './lib/search.mjs?v=6'
import { classifyContent, isGameTalk, isGroupTalk, resolveZone } from './lib/classify.mjs?v=6'

export const name = 'tmc-preset'
export const inject = ['systemPrompt', 'tools']

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
const appendText = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, text, 'utf8')
    return true
  } catch { return false }
}

const tailText = (text, cap) => {
  const body = String(text ?? '')
  if (!cap || body.length <= cap) return body
  const cut = body.slice(-cap)
  const nl = cut.indexOf('\n')
  return `…${nl >= 0 && nl < 400 ? cut.slice(nl + 1) : cut}`
}

const toList = (value, fallback) => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const list = raw.map((item) => String(item ?? '').trim()).filter(Boolean)
  return list.length ? list : fallback
}

export function apply(ctx, config = {}) {
  const cfg = {
    baseDir: String(config.baseDir ?? '/root/projects/qai-memory'),
    utcOffset: Number(config.utcOffset ?? DEFAULT_UTC_OFFSET),
    order: Number(config.order ?? 11),
    limits: { ...DEFAULT_LIMITS, ...(config.limits ?? {}) },
    lineMaxChars: Number(config.lineMaxChars ?? 200),
    userLabel: String(config.userLabel ?? '对方'),
    selfLabel: String(config.selfLabel ?? '她'),
    injectWindowMinutes: Number(config.injectWindowMinutes ?? 30),
    e3InjectMaxChars: Number(config.e3InjectMaxChars ?? 20000),
    f3InjectMaxChars: Number(config.f3InjectMaxChars ?? 12000),
    fallbackInjectMaxChars: Number(config.fallbackInjectMaxChars ?? 12000),
    l5Enabled: config.l5Enabled !== false,
    l5InjectMaxChars: Number(config.l5InjectMaxChars ?? 1500),
    // 自动回忆：每轮拿用户最新一句话匹配 L2 摘要与 L3→L4，命中直接注入。
    autoRecall: config.autoRecall !== false,
    autoRecallMaxChars: Number(config.autoRecallMaxChars ?? 3000),
    // always：每轮注入 L1（RP 分支默认）；afterArchive：归档之后新开的会话开头注入一次；
    // never：完全不注入。
    l1Inject: ['always', 'afterArchive', 'never'].includes(String(config.l1Inject ?? ''))
      ? String(config.l1Inject)
      : 'always',
    // 哪些预设 id 的会话要自动记账（RP 分支默认认 roleplay 双预设 + 原版 companion）。
    adoptPresets: toList(config.adoptPresets, ['companion', 'roleplay', 'roleplay-web']),
  }
  const adoptSet = new Set(cfg.adoptPresets)
  const store = createStore(cfg.baseDir)
  const diaryFile = path.join(cfg.baseDir, 'diary', 'diary.jsonl')
  const vocabFile = path.join(cfg.baseDir, 'vocab.md')
  const archivedFile = path.join(cfg.baseDir, 'tmc', 'archived-sessions.log')
  const log = (msg) => store.log(`[preset] ${msg}`)
  const ts = () => stamp(cfg.utcOffset)
  const clock = () => ts().slice(11)

  // ── 最近一条用户消息（驱动自动回忆 / E3 / F3 / L5 提及）─────────
  // systemPrompt 的 text 函数拿不到消息，所以在 session/event 里记一份；
  // 超过窗口就不再算数，避免很久以后还在带旧话题的记忆。
  const lastUser = { text: '', at: 0, sid: '' }
  const recentUserText = () => {
    if (!lastUser.text) return ''
    if (Date.now() - lastUser.at > Math.max(1, cfg.injectWindowMinutes) * 60_000) return ''
    return lastUser.text
  }

  // ── L1 什么时候注入：RP 分支默认每轮（always）────────────────────
  // afterArchive 模式保留原版行为：宿主半把每次归档写成「会话 id + 时间戳」，
  // 会话创建之前只要有过一次归档，就在开头注入一次 L1（交接上一段的结尾）。
  // 文件不存在 = 宿主半还是旧版，退回「总是注入」，避免升级踩空。
  let archiveCache = { key: '', times: undefined }
  const archiveTimes = () => {
    try {
      const stat = fs.statSync(archivedFile)
      const key = `${stat.mtimeMs}:${stat.size}`
      if (archiveCache.key === key) return archiveCache.times
      const times = []
      for (const line of fs.readFileSync(archivedFile, 'utf8').split('\n')) {
        const [id, rawAt] = line.trim().split('\t')
        const at = Number(rawAt)
        if (!id || !Number.isFinite(at)) continue
        times.push(at)
      }
      const value = times.length ? times : null
      archiveCache = { key, times: value }
      return value
    } catch {
      archiveCache = { key: '', times: undefined }
      return undefined
    }
  }
  let l1ModeCache = { sid: '', value: false }
  const l1Active = (context) => {
    if (cfg.l1Inject === 'always') return true
    if (cfg.l1Inject === 'never') return false
    const session = context?.agent?.session
    const sid = String(session?.id ?? lastUser.sid ?? '')
    if (sid && l1ModeCache.sid === sid) return l1ModeCache.value
    const times = archiveTimes()
    let value
    if (times === undefined) value = true
    else if (times === null) value = false
    else {
      const createdAt = Number(session?.header?.createdAt ?? 0)
      value = Number.isFinite(createdAt) && createdAt > 0
        && times.some((at) => at < createdAt)
    }
    if (sid) l1ModeCache = { sid, value }
    return value
  }
  // L1 在 afterArchive 模式下是「交接一次」；always 模式每轮随运行时上下文重渲。
  let l1Injected = false
  let l1HadBody = false

  const compose = (label, body) => (body ? `【${label}】\n${body}` : '')

  // ── L5：对眼前这个人的总结 ──────────────────────────────────────
  const l5Section = () => {
    if (!cfg.l5Enabled) return ''
    const people = store.l5().people
    const lines = []
    const user = people.user
    if (user?.summary) lines.push(`- ${cfg.userLabel}（正在和我说话的人）：${String(user.summary).slice(0, 150)}`)
    const mentioned = recentUserText()
    if (mentioned) {
      for (const [person, entry] of Object.entries(people)) {
        if (person === 'user' || !entry?.summary) continue
        // 允许简称：记的是「八重神子」，对方说「神子」也算提到。
        const short = person.length > 2 ? [person.slice(0, 2), person.slice(-2)] : []
        if (mentioned.includes(person) || short.some((alias) => mentioned.includes(alias))) {
          lines.push(`- ${person}：${String(entry.summary).slice(0, 150)}`)
        }
      }
    }
    if (!lines.length) return ''
    return compose(
      '我记着的这个人（L5 核心记忆；和角色卡、好感、心情一起决定我怎么说话，不要念出来）',
      lines.join('\n').slice(0, Math.max(200, cfg.l5InjectMaxChars)),
    )
  }

  // ── E 区：只在聊到游戏时带 E3；空了按 E3→E2→E1→L4 的 E 区回退 ──
  const eSection = () => {
    if (!isGameTalk(recentUserText())) return ''
    let pick = null
    for (const tier of ['e3', 'e2', 'e1']) {
      const body = store.read(tier).trim()
      if (body) { pick = { tier, body, from: 'tier' }; break }
    }
    if (!pick) {
      const pages = store.l4().filter((page) => page.zone === 'e')
      const last = pages[pages.length - 1]
      if (last) pick = { tier: 'l4', p: last.p, body: String(last.text ?? '').trim(), from: 'archive' }
    }
    if (!pick || !pick.body) return ''
    const cap = pick.tier === 'e3' ? cfg.e3InjectMaxChars : cfg.fallbackInjectMaxChars
    const body = tailText(pick.body, cap)
    const where = pick.from === 'archive' ? `L4 的 E 区第 ${pick.p} 页` : pick.tier.toUpperCase()
    const hint = pick.tier === 'e3' ? '细节用 memory_read(scope="e2"/"e1")' : '细节用 memory_read / memory_recall(zone="e")'
    return compose(`游戏记忆（${where}；${hint}，不要主动背出来）`, body)
  }

  // ── F 区：只在聊到群里说了什么时带 F3；同理回退 ────────────────
  const fSection = () => {
    if (!isGroupTalk(recentUserText())) return ''
    let pick = null
    for (const tier of ['f3', 'f2', 'f1']) {
      const body = store.read(tier).trim()
      if (body) { pick = { tier, body, from: 'tier' }; break }
    }
    if (!pick) {
      const pages = store.l4().filter((page) => page.zone === 'f')
      const last = pages[pages.length - 1]
      if (last) pick = { tier: 'l4', p: last.p, body: String(last.text ?? '').trim(), from: 'archive' }
    }
    if (!pick || !pick.body) return ''
    const cap = pick.tier === 'f3' ? cfg.f3InjectMaxChars : cfg.fallbackInjectMaxChars
    const body = tailText(pick.body, cap)
    const where = pick.from === 'archive' ? `L4 的 F 区第 ${pick.p} 页` : pick.tier.toUpperCase()
    const hint = pick.tier === 'f3' ? '细节用 memory_read(scope="f2"/"f1")' : '细节用 memory_read / memory_recall(zone="f")'
    return compose(`群聊记忆（${where}；${hint}，不要主动背出来）`, body)
  }

  const l1Section = (context) => {
    if (cfg.l1Inject === 'always') {
      return compose('当前记忆（L1，最近发生的事）', store.read('l1').trim())
    }
    if (l1Injected || !l1Active(context)) return ''
    // 只交接一次：这一轮注入的 L1 会作为 system message 留在上下文里。
    l1Injected = true
    const body = store.read('l1').trim()
    l1HadBody = body.length > 0
    return body ? compose('当前记忆（L1，最近发生的事）', body) : ''
  }

  // ── 自动回忆：L1 之外，系统替 TA 翻 L2 / L3→L4 ─────────────────
  // 拿用户最新一句话打分：L2 里逐行匹配（还没封进 L3 的近期摘要），
  // L3 索引命中则把对应 L4 原文整页带出。同一句话的后续 step 不重复注入。
  const scoreText = (text, query) => {
    const tokens = tokenize(query)
    if (!tokens.length) return 0
    const hay = String(text ?? '').toLowerCase()
    if (!hay) return 0
    let score = 0
    for (const token of tokens) {
      if (token.length >= 2 && hay.includes(token)) score += 1 + Math.min(3, token.length / 2)
    }
    for (const syn of expand(tokens, undefined)) {
      if (syn.length >= 2 && hay.includes(syn)) score += 0.5
    }
    return score
  }
  let lastRecall = { query: '', text: '' }
  const recallSection = () => {
    if (!cfg.autoRecall) return ''
    const query = recentUserText()
    if (!query) return ''
    const parts = []
    // 1) L2 当前层逐行匹配（L2 还没封页时它就是最新的压缩记忆）。
    const l2 = store.read('l2')
    if (l2.trim()) {
      const scored = l2.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 8)
        .map((line) => ({ line, score: scoreText(line, query) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
      let used = 0
      const picked = []
      for (const row of scored) {
        if (used + row.line.length > Math.floor(cfg.autoRecallMaxChars / 2)) break
        picked.push(row.line)
        used += row.line.length
        if (picked.length >= 4) break
      }
      if (picked.length) parts.push(picked.join('\n'))
    }
    // 2) L3 索引 → L4 原文（只看 L 聊天区；E/F 有各自的话题触发注入）。
    const pages = store.l4()
    const byP = new Map(pages.map((page) => [Number(page.p), page.text]))
    const hits = searchPages(store.l3(), (p) => byP.get(Number(p)) ?? '', query, {
      limit: 2, zone: 'l',
    })
    if (hits.length) {
      parts.push(hits.map((hit) => (
        `【${hit.ts}】${hit.summary}${hit.tags?.length ? `（标签：${hit.tags.join('、')}）` : ''}\n${hit.text}`
      )).join('\n\n'))
    }
    const text = parts.join('\n\n').slice(0, Math.max(500, cfg.autoRecallMaxChars))
    if (!text) {
      lastRecall = { query, text: '' }
      return ''
    }
    if (query === lastRecall.query && text === lastRecall.text) return ''
    lastRecall = { query, text }
    return compose('长期记忆自动命中（L2 摘要 / L3 索引→L4 原文；回答时自然引用即可，不要念出这一段）', text)
  }

  // ── D1 标题清单（每轮注入）：D1 里有什么一眼能看到，没有就往下翻 d2 ──
  const d1IndexSection = () => {
    const body = store.read('d1').trim()
    if (!body) return ''
    const items = []
    for (const line of body.split('\n')) {
      const h = line.match(/^###\s+(.+)$/)
      if (h) items.push(h[1].replace(/^《|》$/g, '').trim())
    }
    if (!items.length) return ''
    const rows = []
    for (let i = 0; i < items.length; i += 5) rows.push(items.slice(i, i + 5).join('；'))
    const text = `共 ${items.length} 条：\n${rows.join('\n')}`
    return compose('D1 里正在攒的（全部标题；标题里没有你要找的，就按 D1 → D2 → D3 → L4 往下翻：memory_read d2 → d3 → memory_recall）', text.slice(0, 8000))
  }

  // ── 检索指引（每轮注入，教 TA 按层翻，不凭印象）─────────────────
  const guideSection = (context) => {
    const hasL1 = cfg.l1Inject === 'always'
      ? store.read('l1').trim().length > 0
      : l1Active(context) && l1Injected && l1HadBody
    return [
      '【想不起来时按这个顺序找，不要凭印象说“不记得”】',
      hasL1
        ? '1. 当前上下文和上面的「当前记忆（L1）」覆盖最近发生的事；L5 只用来校准对眼前人的态度。'
        : '1. 当前上下文（这个会话开头注入过一次 L1 交接）；L5 只用来校准对眼前人的态度。',
      '2. 更早的聊天：和对方这句话相关的 L2 摘要 / L3→L4 旧记忆已经自动带在「长期记忆自动命中」里；没带出来，说明近期记忆里没有。',
      '3. 要再往前翻：memory_read(scope="l2") 看完整的 L2 → memory_recall("关键词") 查 L3 索引（同义自动扩展，命中会把 L4 原文调出来）。',
      '4. 游戏的事在 E 区（聊到游戏会自动带出 E3）；群里的话在 F 区（聊到会带出 F3）；阅读过的事看「D1 里正在攒的」标题清单；其它杂事 memory_read(scope="g3")。',
      '5. memory_read(scope="l3"/"l4", zone="e"/"f"/"g") 可以只看某一区的索引或原文。',
      '6. 全都空，才说没印象。翻记忆不用告诉对方，也别念“记录里写着”。',
    ].join('\n')
  }

  // 全部走 required context：既能穿透角色卡 persona 的 complete 模式，
  // 也不会被 includeRuntimeContext: false 抑制（system-prompt assemble 源码保证）。
  const contexts = [
    ['qai-tmc-l5', cfg.order - 0.2, l5Section],
    ['qai-tmc-l1', cfg.order, l1Section],
    ['qai-tmc-recall', cfg.order + 0.5, recallSection],
    ['qai-tmc-e3', cfg.order + 1.5, eSection],
    ['qai-tmc-f3', cfg.order + 1.6, fSection],
    ['qai-tmc-guide', cfg.order + 2, guideSection],
    ['qai-tmc-d1', cfg.order + 3, d1IndexSection],
  ]
  for (const [sectionName, order, text] of contexts) {
    try {
      ctx.effect(() => ctx.systemPrompt.context({ name: sectionName, order, text, required: true }))
    } catch (error) {
      log(`context failed: ${sectionName} ${error?.message ?? error}`)
    }
  }

  // ── 自动记账 + L 区分层（D/E/F/G 的压缩归宿主半）──────────────
  let sealing = false
  const sealIfNeeded = async () => {
    if (sealing) return
    sealing = true
    try {
      if (store.size('l1') > cfg.limits.l1) await sealL1(store, ctx, cfg)
      if (store.size('l2') > cfg.limits.l2) await sealL2(store, ctx, cfg)
    } catch (error) {
      log(`seal failed: ${error?.message ?? error}`)
    } finally {
      sealing = false
    }
  }

  const companions = new Set()
  const seen = new Set()
  const textOf = (data) => {
    const blocks = data?.message?.content ?? data?.content
    if (!Array.isArray(blocks)) return ''
    return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
  }
  const systemText = (event) => textOf(event?.data) || ''

  // 懒识别：第一条用户消息时问一次 agentPresets（事件可能比预设提交晚）。
  const tryAdopt = (sid) => {
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agent = typeof agents?.get === 'function' ? agents.get(sid) : undefined
      if (!agent?.ctx) return false
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      const preset = typeof presets?.composedPreset === 'function' ? presets.composedPreset(agent.ctx) : undefined
      if (preset && adoptSet.has(String(preset))) {
        companions.add(sid)
        log(`adopt sid=${sid} preset=${preset} (lazy)`)
        return true
      }
    } catch { /* ignore */ }
    return false
  }

  try {
    ctx.on('agent-preset/selected', (sessionId, preset) => {
      const sid = String(sessionId ?? '')
      if (!sid) return
      if (adoptSet.has(String(preset))) {
        companions.add(sid)
        log(`adopt sid=${sid} preset=${preset}`)
      } else {
        companions.delete(sid)
      }
    })
  } catch { /* ignore */ }

  try {
    ctx.on('session/event', (session, event) => {
      const sid = String(session?.id ?? '')
      if (!sid || !event || typeof event.type !== 'string') return
      const key = `${sid}:${event.seq}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 20000) seen.clear()

      if (event.type === 'system/message' && !companions.has(sid)) {
        if (systemText(event).includes('【当前角色：')) {
          companions.add(sid)
          log(`adopt sid=${sid}`)
        }
      }
      if (!companions.has(sid) && !tryAdopt(sid)) return

      if (event.type === 'user/message') {
        const text = textOf(event.data).replace(/\s+/g, ' ').trim()
        if (text && !/^Current runtime context\b/.test(text) && !/^Time sampled while preparing\b/.test(text) && !/^〔心跳〕/.test(text)) {
          lastUser.text = text.slice(0, 4000)
          lastUser.at = Date.now()
          lastUser.sid = sid
          appendText(store.files.l1, `- ${clock()} ${cfg.userLabel}：${text.slice(0, cfg.lineMaxChars)}\n`)
          void sealIfNeeded()
        }
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data).replace(/\s+/g, ' ').trim()
        if (text) {
          appendText(store.files.l1, `- ${clock()} ${cfg.selfLabel}：${text.slice(0, cfg.lineMaxChars)}\n`)
          void sealIfNeeded()
        }
      }
    })
  } catch { /* ignore */ }

  // ── 工具 ─────────────────────────────────────────────────────
  const textOut = (text) => [{ type: 'text', text: String(text ?? '') }]
  const okSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' }, text: { type: 'string' }, detail: { type: 'string' } },
    required: ['ok'],
  }
  const register = (definition) => {
    try { ctx.effect(() => ctx.tools.register(definition)) } catch (error) {
      log(`tool ${definition?.name} failed: ${error?.message ?? error}`)
    }
  }

  const writeZoneMemory = (zone, text) => {
    const tier = `${zone}1`
    appendText(store.files[tier], `- ${clock()} ${text}\n`)
    return tier
  }

  const formatL3 = (rows) => rows.map((row) => (
    `- [${zoneShort(row.zone)}] ${row.ts} · ${row.summary}`
    + `${row.tags?.length ? `（标签：${row.tags.join('、')}）` : ''}`
  )).join('\n')

  const formatL4 = (pages) => pages.map((page) => (
    `## [${zoneShort(page.zone)}] ${page.ts} · 第 ${page.p} 页`
    + `${page.tags?.length ? `（标签：${page.tags.join('、')}）` : ''}\n${String(page.text ?? '').slice(0, 12000)}`
  )).join('\n\n')

  const formatL5 = (people) => {
    const rows = Object.entries(people)
    if (!rows.length) return '（L5 还是空的；等 L2 或 F4 归档后会自动长出总结。）'
    return rows.map(([person, entry]) => (
      `- ${person === 'user' ? cfg.userLabel : person}：${String(entry?.summary ?? '')}`
      + `（${String(entry?.updated ?? '').slice(0, 10)}）`
    )).join('\n')
  }

  register({
    name: 'memory_note',
    description: '把一件事写进记忆。zone 不填会自动分流：游戏→E1、群聊→F1、搜索/B站→D1、像聊天→L1、其它→G1；'
      + '也可以显式给 zone="l"/"d"/"e"/"f"/"g"。只写值得下次还记得的，一句就够；满了会自动压缩归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要记住的内容' },
        zone: { type: 'string', enum: ['auto', 'l', 'd', 'e', 'f', 'g'], description: '可选；不填按内容自动分流' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.detail) },
    execute: async (args) => {
      const text = String(args.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return { ok: false, detail: '空的，没写。' }
      const explicit = resolveZone(args.zone)
      const zone = explicit || classifyContent(text)
      const tier = writeZoneMemory(zone, text.slice(0, 400))
      if (zone === 'l') await sealIfNeeded()
      return { ok: true, detail: `记进 ${zoneLabel(zone)} 的 ${tier.toUpperCase()}。` }
    },
  })

  register({
    name: 'memory_import',
    description: '成段导入记忆（群聊记录用 zone="f"，游戏记录用 zone="e"，杂项用 zone="g"，阅读用 zone="d"）。'
      + '按原样写进该区第一层，超过上限会自动逐层压缩归档；不会公开给对方看。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['zone', 'text'],
      properties: {
        zone: { type: 'string', enum: ['l', 'd', 'e', 'f', 'g'] },
        text: { type: 'string', description: '要导入的整段内容' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.detail) },
    execute: async (args) => {
      const zone = resolveZone(args.zone)
      if (!zone) return { ok: false, detail: 'zone 只能是 l/d/e/f/g。' }
      const text = String(args.text ?? '').trim().slice(0, 400000)
      if (!text) return { ok: false, detail: '空的，没导入。' }
      const tier = `${zone}1`
      appendText(store.files[tier], `\n### ${ts()} 导入（${zoneLabel(zone)}）\n${text}\n`)
      if (zone === 'l') await sealIfNeeded()
      return { ok: true, detail: `导入 ${zoneLabel(zone)} 的 ${tier.toUpperCase()}，共 ${text.length} 字；满了会自动压缩。` }
    },
  })

  register({
    name: 'memory_read',
    description: '翻记忆。scope=l1/l2 聊天，d1/d2/d3 阅读，e1~e4 游戏，f1~f4 群聊，g1~g4 备用，'
      + 'l3 长期索引（可用 zone 只看某一区），l4 长期原文（可带 query/zone），l5 对每个人的总结。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: [
            'l1', 'l2', 'd1', 'd2', 'd3',
            'e1', 'e2', 'e3', 'e4',
            'f1', 'f2', 'f3', 'f4',
            'g1', 'g2', 'g3', 'g4',
            'l3', 'l4', 'l5',
          ],
        },
        query: { type: 'string', description: '可选：只看含这个词的内容（l3/l4）' },
        zone: { type: 'string', enum: ['l', 'd', 'e', 'f', 'g'], description: '可选：只看某一区（l3/l4）' },
        limit: { type: 'integer', description: 'l3/l4 最多几条/几页，默认 5' },
      },
      required: ['scope'],
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.text) },
    execute: async (args) => {
      const scope = String(args.scope ?? 'l1')
      const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20)
      const zone = resolveZone(args.zone)
      if (scope === 'l5') return { ok: true, text: formatL5(store.l5().people) }
      if (scope === 'l3' || scope === 'l4') {
        const query = String(args.query ?? '').trim().toLowerCase()
        if (scope === 'l3') {
          let rows = store.l3()
          if (zone) rows = rows.filter((row) => row.zone === zone)
          if (query) {
            rows = rows.filter((row) => (
              String(row.summary).toLowerCase().includes(query)
              || row.tags.some((tag) => String(tag).toLowerCase().includes(query))
            ))
          }
          const picked = rows.slice(-limit).reverse()
          return { ok: true, text: picked.length ? formatL3(picked) : '（这里是空的。）' }
        }
        let pages = store.l4()
        if (zone) pages = pages.filter((page) => page.zone === zone)
        if (query) {
          pages = pages.filter((page) => (
            String(page.text).toLowerCase().includes(query)
            || page.tags.some((tag) => String(tag).toLowerCase().includes(query))
          ))
        }
        const picked = pages.slice(-limit).reverse()
        return { ok: true, text: picked.length ? formatL4(picked) : '（这里是空的。）' }
      }
      const file = store.files[scope]
      if (!file) return { ok: false, text: '没有这一层。' }
      const body = store.read(scope).trim()
      return { ok: true, text: body || '（这里是空的。）' }
    },
  })

  register({
    name: 'memory_recall',
    description: 'L1/L2 里找不到时翻长期记忆：在 L3 索引里按关键词找（分词 + 同义扩展 + 标签），'
      + '命中的把对应的 L4 原文一起调出来；可用 zone 只看 L/D/E/F/G 中的某一区。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '关键词，例如「海边」「那部片子」' },
        zone: { type: 'string', enum: ['l', 'd', 'e', 'f', 'g'], description: '可选：只看某一区' },
        limit: { type: 'integer', description: '最多几页，默认 2，上限 5' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.text) },
    execute: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, text: '给一个关键词。' }
      const limit = Math.min(Math.max(Number(args.limit ?? 2) || 2, 1), 5)
      const zone = resolveZone(args.zone)
      const pages = store.l4()
      const byP = new Map(pages.map((page) => [Number(page.p), page.text]))
      const hits = searchPages(store.l3(), (p) => byP.get(Number(p)) ?? '', query, {
        limit, groups: config.synonyms, zone,
      })
      if (!hits.length) return { ok: true, text: `L3 里没有对得上「${query}」的。` }
      const text = hits.map((hit) => (
        `【${zoneShort(hit.zone)} · ${hit.ts}】${hit.summary}`
        + `${hit.tags?.length ? `（标签：${hit.tags.join('、')}）` : ''}\n${hit.text}`
      )).join('\n\n')
      return { ok: true, text }
    },
  })

  register({
    name: 'memory_l5',
    description: 'L5 核心记忆：对每个人的总结（每人 50~150 字）。不传参数就列出来；'
      + '传 person + summary 手写一条；refresh=true 从最近的聊天/群聊原文重算。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        person: { type: 'string', description: '对象名字；一对一聊天的人写“对方”或 user' },
        summary: { type: 'string', description: '50~150 字的总结' },
        refresh: { type: 'boolean', description: '从最近的 L4 聊天/群聊原文重算' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.text ?? value.detail) },
    execute: async (args) => {
      if (args.refresh) {
        const pages = store.l4().filter((page) => page.zone === 'l' || page.zone === 'f').slice(-3)
        if (!pages.length) return { ok: false, text: '还没有可重算的聊天/群聊原文。' }
        const source = pages.map((page) => page.text).join('\n\n')
        const ok = await updateL5(store, ctx, cfg, source, { source: 'refresh' })
        writeState(store, cfg)
        return ok
          ? { ok: true, text: `重算完了，现在有 ${Object.keys(store.l5().people).length} 个人。` }
          : { ok: false, text: '这次没抽出有效的总结，原来的没动。' }
      }
      if (args.person || args.summary) {
        const personRaw = String(args.person ?? '').replace(/\s+/g, ' ').trim()
        const summary = String(args.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 150)
        if (!personRaw || !summary) return { ok: false, text: 'person 和 summary 都要给。' }
        if (summary.length < 50) return { ok: false, text: '总结至少 50 字，最多 150 字；写具体一点。' }
        const person = ['对方', '你', 'user', 'USER'].includes(personRaw) ? 'user' : personRaw.slice(0, 40)
        const fresh = store.l5()
        fresh.version = 1
        fresh.updated = new Date().toISOString()
        fresh.people[person] = {
          name: person === 'user' ? cfg.userLabel : person,
          summary,
          updated: new Date().toISOString(),
          source: 'manual',
        }
        const kept = Object.entries(fresh.people)
          .sort((a, b) => String(b[1]?.updated ?? '').localeCompare(String(a[1]?.updated ?? '')))
          .slice(0, 40)
        fresh.people = Object.fromEntries(kept)
        store.writeL5(fresh)
        writeState(store, cfg)
        return { ok: true, text: `写好了：${person === 'user' ? cfg.userLabel : person}——${summary}` }
      }
      return { ok: true, text: formatL5(store.l5().people) }
    },
  })

  // ── 日记 / 黑话 / 上网（原来在 memory.mjs，一起搬进来）──────────
  register({
    name: 'diary_write',
    description: '写一句日记，只给自己看。想记就记一句，一天最多三条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string' },
        mood: { type: 'string' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.detail) },
    execute: async (args) => {
      const content = String(args.content ?? '').trim().slice(0, 300)
      if (!content) return { ok: false, detail: '空的，没写。' }
      const day = ts().slice(0, 10)
      let count = 0
      for (const line of readText(diaryFile).split('\n')) {
        if (!line.trim()) continue
        try { if (JSON.parse(line).day === day) count += 1 } catch { /* ignore */ }
      }
      if (count >= 3) return { ok: false, detail: '今天已经写了三条，够了。' }
      const record = { day, time: `${day} ${clock()}`, mood: String(args.mood ?? '').slice(0, 20), content }
      return appendText(diaryFile, `${JSON.stringify(record)}\n`)
        ? { ok: true, detail: '写下来了。' }
        : { ok: false, detail: '写入失败。' }
    },
  })

  register({
    name: 'diary_recent',
    description: '翻最近写的日记（默认 5 条）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer' } },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.text) },
    execute: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20)
      const rows = readText(diaryFile).split('\n').filter((line) => line.trim()).slice(-limit)
      const text = rows.map((line) => {
        try { const r = JSON.parse(line); return `${r.time}${r.mood ? `（${r.mood}）` : ''}：${r.content}` } catch { return line }
      }).join('\n')
      return { ok: true, text: text || '（还没写过日记。）' }
    },
  })

  register({
    name: 'vocab_note',
    description: '记一个学到的词/说法（term + 意思，可选例句）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['term'],
      properties: {
        term: { type: 'string' },
        meaning: { type: 'string' },
        example: { type: 'string' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.detail) },
    execute: async (args) => {
      const term = String(args.term ?? '').trim()
      if (!term) return { ok: false, detail: '空的，没记。' }
      const line = `- ${term}${args.meaning ? `：${String(args.meaning).slice(0, 120)}` : ''}${args.example ? `（例：${String(args.example).slice(0, 80)}）` : ''}\n`
      return appendText(vocabFile, line) ? { ok: true, detail: '记下了。' } : { ok: false, detail: '写入失败。' }
    },
  })

  register({
    name: 'reading_fetch',
    description: '自己去网上看点什么，看完写进 D1（B站/上网通道）。给 url 读那一页，给 query 先搜再读第一条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        url: { type: 'string' },
        note: { type: 'string' },
      },
    },
    output: { schema: okSchema, render: (_args, value) => textOut(value.text) },
    execute: async (args) => {
      const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
      let url = String(args.url ?? '').trim()
      const query = String(args.query ?? '').trim()
      let title = url
      let body = ''
      if (!url && query) {
        if (!web || typeof web.search !== 'function') return { ok: false, text: '搜索服务不可用。' }
        const found = await web.search({ query, maxResults: 3 })
        const first = Array.isArray(found?.sources) ? found.sources[0] : null
        if (!first?.url) return { ok: false, text: '没搜到。' }
        url = String(first.url)
        title = String(first.title || url)
      }
      if (!url) return { ok: false, text: '给 url 或 query。' }
      if (web && typeof web.fetch === 'function') {
        try {
          const fetched = await web.fetch({ url })
          body = String(fetched?.body?.content ?? '').replace(/\s+/g, ' ').slice(0, 4000)
        } catch (error) {
          return { ok: false, text: `读不到：${error?.message ?? error}` }
        }
      }
      const note = String(args.note ?? '').trim()
      appendText(store.files.d1, `\n### ${clock()} ${title}\n${url}\n${note ? `${note}\n` : ''}${body}\n`)
      return { ok: true, text: `看完了，记进 D1。${body ? `\n${body.slice(0, 600)}` : ''}` }
    },
  })

  store.log(`loaded(tmc-preset v12-rp) base=${cfg.baseDir} l1Inject=${cfg.l1Inject} autoRecall=${cfg.autoRecall} adopt=[${cfg.adoptPresets.join(',')}] self=${cfg.selfLabel} user=${cfg.userLabel} l1=${cfg.limits.l1} l2=${cfg.limits.l2}`)
}
