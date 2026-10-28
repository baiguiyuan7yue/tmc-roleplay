// TMC 的分层压缩：五个区各自一条压缩链，最后都汇进 L4，索引进 L3。
//
// 规则（用户 2026-10-24 定）：
//   L 聊天  L1 满 → L2；L2 满 → 整页进 L4 + 50~150 字索引进 L3（L 区）
//   D 阅读  D1 → D2 → D3 → 整页进 L4 + 索引进 L3（D 区）
//   E 游戏  E1 50000 → E2 30000 → E3 20000 → E4 10000 → 压到 5000 进 L4 + 索引/标签进 L3（E 区）
//   F 群聊  F1 200000 → F2 50000（高度压缩）→ F3 12000 → F4 3000 → 全量进 L4 + 索引/标签进 L3（F 区）
//   G 备用  G1 200000 → G2 50000 → G3 20000 → G4 5000 → 全量进 L4 + 索引/标签进 L3（G 区）
//   L5 核心记忆：L2 / F4 归档进 L4 之后，从原文重算「她对每个人的总结」（每人 50~150 字）。
//
// L3 只放索引、L4 只放原文，两者都永久本地保存。
import { ARCHIVE_TARGETS, DEFAULT_LIMITS, ZONES, ZONE_ORDER, normalizeZone } from './store.mjs?v=5'
import { extractTags } from './search.mjs?v=5'

export const TIER_LIMITS = DEFAULT_LIMITS

const pad = (n) => String(n).padStart(2, '0')

/** 用户本地时间（容器是 UTC）。 */
export function stamp(utcOffset = 8) {
  const d = new Date(Date.now() + Number(utcOffset || 0) * 3_600_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function resolveModel(ctx, config = {}) {
  let provider = String(config.provider ?? '')
  let model = String(config.model ?? '')
  if (!provider || !model) {
    const picker = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const sel = picker && typeof picker.currentSelection === 'function' ? picker.currentSelection() : undefined
    provider = provider || String(sel?.provider ?? 'deepseek-official')
    model = model || String(sel?.model ?? 'deepseek-flash')
  }
  return { provider, model }
}

/**
 * 调一次模型做压缩/概括；失败返回 ''，调用方保留原文。
 * @param {object} [options]
 * @param {number} [options.maxInputChars] 送进模型的原文上限，默认 12000
 * @param {number} [options.timeoutMs] 单次调用超时，默认 60 秒
 * @param {boolean} [options.singleLine] 是否把换行压成空格，默认 true
 */
export async function llmText(ctx, config, instruction, text, maxTokens = 1200, maxChars = 1200, options = {}) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') return ''
  const { provider, model } = resolveModel(ctx, config)
  const controller = new AbortController()
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 60000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const maxInputChars = Math.max(1000, Number(options.maxInputChars) || 12000)
  let out = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      reasoningEffort: 'off',
      messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}\n\n${String(text).slice(0, maxInputChars)}` }] }],
      maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  } catch { return '' } finally { clearTimeout(timer) }
  const trimmed = out.trim()
  if (!trimmed) return ''
  const normalized = options.singleLine === false
    ? trimmed.replace(/\n{3,}/g, '\n\n')
    : trimmed.replace(/\s*\n+\s*/g, ' ')
  return normalized.slice(0, maxChars)
}

/** 从模型输出里抠出第一个 JSON 数组/对象；失败返回 null。 */
export function parseJsonValue(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim()
  if (!text) return null
  // 先选「更靠前」的开括号：对象里的 tags 数组不能被当成整个返回值。
  const candidates = [
    { open: '{', close: '}', at: text.indexOf('{') },
    { open: '[', close: ']', at: text.indexOf('[') },
  ].filter((item) => item.at >= 0).sort((a, b) => a.at - b.at)
  for (const { open, close } of candidates) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start < 0 || end <= start) continue
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* try next */ }
  }
  return null
}

/** 按行切块，尽量不把一段话切断；单行过长时硬切。 */
export function splitChunks(text, maxChars = 40000) {
  const chunks = []
  let current = ''
  const flush = () => {
    const body = current.trim()
    if (body) chunks.push(body)
    current = ''
  }
  for (const line of String(text ?? '').split('\n')) {
    if (line.length > maxChars) {
      flush()
      for (let i = 0; i < line.length; i += maxChars) {
        const piece = line.slice(i, i + maxChars).trim()
        if (piece) chunks.push(piece)
      }
      continue
    }
    if (current.length + line.length + 1 > maxChars) flush()
    current += `${line}\n`
  }
  flush()
  return chunks
}

/**
 * 通用压缩：小段一次压完，大段先分段压再合并；保留最近的块（旧的先丢）。
 * @returns {Promise<string>} 失败返回 ''
 */
export async function compressText(ctx, cfg, text, options = {}) {
  const body = String(text ?? '').trim()
  if (!body) return ''
  const targetChars = Math.max(500, Number(options.targetChars) || 4000)
  const instruction = String(options.instruction ?? '把下面的内容压缩成一份记忆。')
  const maxTokens = Math.max(1200, Math.min(16000, Number(options.maxTokens) || 8000))
  const maxInputChars = Math.max(4000, Math.min(48000, Number(options.maxInputChars) || 40000))
  const timeoutMs = Math.max(30000, Number(options.timeoutMs) || 240000)

  if (body.length <= maxInputChars) {
    return llmText(
      ctx, cfg,
      `${instruction}\n输出不超过 ${targetChars} 字，保留事实、人物、结果和她的态度；不要写“这段内容”“上面”之类的说明。`,
      body, maxTokens, targetChars,
      { maxInputChars: maxInputChars + 2000, timeoutMs, singleLine: false },
    )
  }

  let chunks = splitChunks(body, maxInputChars)
  if (chunks.length > 12) chunks = chunks.slice(-12)
  const per = Math.max(600, Math.min(12000, Math.ceil(targetChars / chunks.length)))
  const parts = []
  for (const chunk of chunks) {
    const piece = await llmText(
      ctx, cfg,
      `${instruction}\n这是其中一段。把这一段压缩到 ${per} 字以内，保留事件、人物、结果和她的态度。`,
      chunk, Math.min(maxTokens, 12000), Math.ceil(per * 1.25),
      { maxInputChars: maxInputChars + 2000, timeoutMs, singleLine: false },
    )
    if (piece) parts.push(piece)
  }
  if (!parts.length) return ''
  const merged = parts.join('\n\n')
  if (merged.length <= Math.ceil(targetChars * 1.15)) return merged.slice(0, targetChars)
  return llmText(
    ctx, cfg,
    `下面是一份记忆的分段压缩稿。把它合并成一份不超过 ${targetChars} 字的完整记忆；保留事实、人物、结果和她的态度，删掉重复。`,
    merged, maxTokens, targetChars,
    { maxInputChars: maxInputChars + 2000, timeoutMs, singleLine: false },
  )
}

/** 给 L3 生成索引 + 标签；模型失败时退回关键词。 */
export async function summarizeAndTag(ctx, cfg, text, zone) {
  const body = String(text ?? '').trim()
  const kind = zone === 'e' ? '游戏记忆' : zone === 'f' ? '群聊记忆' : zone === 'g' ? '杂项记忆' : '记忆'
  const prompt = `下面是一段${kind}。请输出一个 JSON 对象（不要代码块、不要解释）：
{"summary":"60~200 字索引：发生了什么、涉及谁、她的态度；看完索引就能判断要不要翻原文","tags":["3~8 个便于以后搜索的关键词，人名/游戏名/事件名优先"]}`
  const raw = await llmText(ctx, cfg, prompt, body, 900, 1600, { maxInputChars: 16000, timeoutMs: 90000 })
  const parsed = parseJsonValue(raw)
  const summary = String(parsed?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const tags = Array.isArray(parsed?.tags) ? parsed.tags.map((tag) => String(tag ?? '').trim()).filter(Boolean).slice(0, 8) : []
  if (summary) return { summary, tags: tags.length ? tags : extractTags(body, 6) }
  const fallback = String(body).replace(/\s+/g, ' ').trim()
  return { summary: fallback.slice(0, 200) || '（没有概括出来。）', tags: extractTags(body, 6) }
}

// ── L5：她对每个人的总结 ────────────────────────────────────────────
const L5_MAX_PEOPLE = 40
const L5_MIN_CHARS = 50
const L5_MAX_CHARS = 150

/**
 * 从一段聊天/群聊原文重算 L5。只更新这段里出现的人，没提到的人保持原样。
 * @returns {Promise<boolean>}
 */
export async function updateL5(store, ctx, cfg, sourceText, { source = 'chat' } = {}) {
  if (cfg?.l5Enabled === false) return false
  const body = String(sourceText ?? '').trim()
  if (!body) return false
  const current = store.l5()
  const existing = Object.entries(current.people)
    .map(([person, entry]) => `- ${person === 'user' ? '对方（user）' : person}：${String(entry?.summary ?? '').slice(0, 180)}`)
    .slice(0, 30)
    .join('\n')
  const instruction = `下面是一段${source === 'group' ? '群聊' : '聊天'}记忆。请从「她」的视角，提炼她对其中每个人的态度和理解：
1. 一对一聊天的对象固定写 person="user"；群聊里出现的人用记录里的名字。
2. 每人 ${L5_MIN_CHARS}~${L5_MAX_CHARS} 字，用第一人称「我」写：这个人是谁、我怎么看他、在意或介意什么、有什么约定或边界。
3. 只写这段记忆里出现或有变化的人；没提到的人不要输出。
4. 只输出 JSON 数组，不要代码块，不要解释。例如 [{"person":"user","summary":"……"}]
${existing ? `\n已有总结（可参考、可改写）：\n${existing}\n` : ''}`
  const raw = await llmText(ctx, cfg, instruction, body, 2200, 6000, { maxInputChars: 12000, timeoutMs: 120000 })
  if (!raw) return false
  const parsed = parseJsonValue(raw)
  const rows = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.people) ? parsed.people
      : null
  if (!Array.isArray(rows) || !rows.length) {
    store.log(`updateL5 skipped: no json (${raw.slice(0, 80)})`)
    return false
  }
  const fresh = store.l5()
  let changed = 0
  for (const row of rows) {
    const rawPerson = String(row?.person ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const person = ['user', '对方', '你'].includes(rawPerson) ? 'user' : rawPerson
    const summary = String(row?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, L5_MAX_CHARS)
    if (!person || summary.length < L5_MIN_CHARS) continue
    fresh.people[person] = {
      name: person === 'user' ? String(cfg?.userLabel ?? '对方') : person,
      summary,
      updated: new Date().toISOString(),
      source,
    }
    changed += 1
  }
  if (!changed) return false
  const entries = Object.entries(fresh.people)
    .sort((a, b) => String(b[1]?.updated ?? '').localeCompare(String(a[1]?.updated ?? '')))
    .slice(0, L5_MAX_PEOPLE)
  fresh.people = Object.fromEntries(entries)
  fresh.version = 1
  fresh.updated = new Date().toISOString()
  store.writeL5(fresh)
  store.log(`updateL5 ok people=${Object.keys(fresh.people).length} changed=${changed} source=${source}`)
  return true
}

/**
 * 压缩期间这一层可能又被追加了新内容（比如导入群聊）：
 * 只清掉已经读过的那一段，把新尾巴留下，避免整层清空丢内容。
 */
function takeConsumed(store, tier, raw) {
  const after = store.read(tier)
  const tail = after.startsWith(raw) ? after.slice(raw.length) : after
  const kept = tail.replace(/^\n+/, '').trimEnd()
  store.write(tier, kept ? `${kept}\n` : '')
}

// ── state.json ────────────────────────────────────────────────────
export function buildState(store, cfg) {
  const limits = { ...TIER_LIMITS, ...(cfg?.limits ?? {}) }
  const l3 = store.l3()
  const l4 = store.l4()
  const sizes = Object.fromEntries(store.allTiers().map((tier) => [tier, store.size(tier)]))
  const l3ByZone = Object.fromEntries(ZONE_ORDER.map((zone) => [zone, l3.filter((row) => row.zone === zone).length]))
  const l4ByZone = Object.fromEntries(ZONE_ORDER.map((zone) => [zone, l4.filter((row) => row.zone === zone).length]))
  const people = Object.entries(store.l5().people)
  const zones = ZONE_ORDER.map((zone) => {
    const meta = ZONES[zone]
    const tiers = meta.tiers.map((tier) => ({ tier, size: sizes[tier] ?? 0, limit: Number(limits[tier] ?? 0) }))
    return {
      key: zone,
      label: meta.label,
      size: tiers.reduce((sum, tier) => sum + tier.size, 0),
      limit: tiers.reduce((sum, tier) => sum + tier.limit, 0),
      tiers,
      l3: l3ByZone[zone] ?? 0,
      l4: l4ByZone[zone] ?? 0,
    }
  })
  return {
    ok: true,
    updated: new Date().toISOString(),
    limits,
    sizes,
    counts: {
      l3: l3.length,
      l4: l4.length,
      l3ByZone,
      l4ByZone,
      l5: people.length,
    },
    zones,
    l5: people.map(([person, entry]) => ({
      person,
      name: String(entry?.name ?? (person === 'user' ? '对方' : person)),
      summary: String(entry?.summary ?? ''),
      updated: String(entry?.updated ?? ''),
      source: String(entry?.source ?? ''),
    })),
    recent: l3.slice(-8).reverse(),
  }
}

export function writeState(store, cfg) {
  const state = buildState(store, cfg)
  store.writeAtomic('state', JSON.stringify(state, null, 2))
  return state
}

// ── 各区压缩 ─────────────────────────────────────────────────────
/** L1 满：压缩成几句写进 L2，L1 清空。 */
export async function sealL1(store, ctx, cfg) {
  const raw = store.read('l1')
  const body = raw.trim()
  if (!body) return false
  const summary = await llmText(ctx, cfg,
    '下面是她和对方刚才的对话记录。用 3~6 句中文压缩成她自己的记忆（第一人称「我」），只留发生了什么、说定了什么、她自己的态度；不要复述、不要评价。',
    body, 800, 1200, { maxInputChars: 12000 })
  if (!summary) { store.log('sealL1 skipped: summary empty'); return false }
  const ts = stamp(cfg.utcOffset)
  store.append('l2', `\n### ${ts}\n${summary}\n`)
  takeConsumed(store, 'l1', raw)
  store.log(`sealL1 ok chars=${body.length} -> l2=${store.size('l2')}`)
  writeState(store, cfg)
  return true
}

/** L2 满：整页进 L4、抽索引进 L3；归档后重算 L5。 */
export async function sealL2(store, ctx, cfg) {
  const raw = store.read('l2')
  const body = raw.trim()
  if (!body) return false
  const summary = await llmText(ctx, cfg,
    '下面是一段按时间压缩过的聊天记忆。用 50~150 字完整概括它：发生了什么、涉及谁、她自己的态度或决定；看完这段概括就不用再翻原文。只输出这段概括。',
    body, 500, 400, { maxInputChars: 12000 })
  if (!summary) { store.log('sealL2 skipped: summary empty'); return false }
  const ts = stamp(cfg.utcOffset)
  const p = store.recordPage('l', body, summary.slice(0, 150), ts)
  takeConsumed(store, 'l2', raw)
  store.log(`sealL2 ok chars=${body.length} page=${p} summary=${summary.slice(0, 40)}`)
  try { await updateL5(store, ctx, cfg, body, { source: 'chat' }) } catch (error) {
    store.log(`sealL2 updateL5 failed: ${error?.message ?? error}`)
  }
  writeState(store, cfg)
  return true
}

/** 一条普通压缩链：from 超限 → 压成 to。 */
async function compressTier(store, ctx, cfg, from, to, instruction) {
  const raw = store.read(from)
  const body = raw.trim()
  if (!body) return false
  const limits = { ...TIER_LIMITS, ...(cfg?.limits ?? {}) }
  const ts = stamp(cfg.utcOffset)
  const header = `\n### ${ts}\n`
  // 留下标题占位，避免写进去刚好超限、被下一轮立刻又压一次。
  const targetChars = Math.max(500, (Number(limits[to]) || 4000) - header.length - 1)
  const summary = await compressText(ctx, cfg, body, {
    instruction,
    targetChars,
    maxTokens: Math.min(12000, Math.max(2000, Math.ceil(targetChars * 0.5))),
    maxInputChars: 40000,
  })
  if (!summary) { store.log(`${from}->${to} skipped: summary empty`); return false }
  store.append(to, `${header}${summary}\n`)
  takeConsumed(store, from, raw)
  store.log(`${from}->${to} ok chars=${body.length} -> ${to}=${store.size(to)}`)
  writeState(store, cfg)
  return true
}

const compressD1 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'd1', 'd2',
  '下面是她今天在 B 站和网上看过的内容（标题、简介、她自己的观感）。把它压成一份阅读摘要：保留她在意的点、结论、有趣的细节。')
const compressD2 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'd2', 'd3',
  '下面是她的阅读摘要。再压一版：只留仍然有用的结论和她真的在意的东西。')
const compressE1 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'e1', 'e2',
  '下面是她的游戏记忆原始记录（哪款游戏、打了什么、和谁、过程、结果、她的反应）。压缩成一份游戏记忆：保留剧情推进、关键选择、得失、人物关系、她的情绪和偏好；删掉重复的刷本、跑图细节。')
const compressE2 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'e2', 'e3',
  '把她的游戏记忆再压一版：只留还会影响以后打游戏的事（进度、角色/装备、约定、雷点、喜好），删掉已经过去的过程。')
const compressE3 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'e3', 'e4',
  '把游戏记忆再压一版：只留最关键的进度、关系和她的态度，条目化，便于以后接着玩。')
const compressF1 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'f1', 'f2',
  '下面是群聊记录。做高度压缩：只留谁说了什么、群里的气氛、和她的关系、约定和冲突；删掉寒暄、重复、表情和无关闲聊。')
const compressF2 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'f2', 'f3',
  '把群聊记忆再高度压缩：只留人物关系、重要约定、冲突和她自己的态度。')
const compressF3 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'f3', 'f4',
  '把群聊记忆压到最短：只留以后可能还会提起的人和事。')
const compressG1 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'g1', 'g2',
  '下面是她的杂项记忆（不属于聊天、群聊、游戏、搜索/ B 站的内容）。压缩成一份摘要：保留事实、结论、她的偏好和态度。')
const compressG2 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'g2', 'g3',
  '把杂项记忆再压一版：只留仍然有用的事实、结论和她的态度。')
const compressG3 = (store, ctx, cfg) => compressTier(store, ctx, cfg, 'g3', 'g4',
  '把杂项记忆压到最短：只留以后可能还会用到的事。')

/** D3 满：整页进 L4，抽 60~200 字索引进 L3。 */
export async function sealD3(store, ctx, cfg) {
  const raw = store.read('d3')
  const body = raw.trim()
  if (!body) return false
  const summary = await llmText(ctx, cfg,
    '下面是她的阅读压缩记录。用 60~200 字概括这些内容：她看了什么、大概讲了什么、她的态度；以后靠这段索引决定要不要翻原文。只输出这段概括。',
    body, 600, 400, { maxInputChars: 12000 })
  if (!summary) { store.log('sealD3 skipped: summary empty'); return false }
  const ts = stamp(cfg.utcOffset)
  const p = store.recordPage('d', body, summary.slice(0, 200), ts)
  takeConsumed(store, 'd3', raw)
  store.log(`sealD3 ok chars=${body.length} page=${p} summary=${summary.slice(0, 40)}`)
  writeState(store, cfg)
  return true
}

/** E4 满：先压到 5000 字，再整页进 L4，索引 + 标签进 L3。 */
export async function sealE4(store, ctx, cfg) {
  const raw = store.read('e4')
  const body = raw.trim()
  if (!body) return false
  const target = ARCHIVE_TARGETS.e4
  const compressed = await compressText(ctx, cfg, body, {
    instruction: '把这段游戏记忆压到 5000 字以内：保留她玩到哪、关键角色/装备/进度、和谁一起、她的态度与雷点；删掉重复过程。',
    targetChars: target,
    maxTokens: 6000,
    maxInputChars: 16000,
  })
  if (!compressed) { store.log('sealE4 skipped: summary empty'); return false }
  const { summary, tags } = await summarizeAndTag(ctx, cfg, compressed, 'e')
  const ts = stamp(cfg.utcOffset)
  const p = store.recordPage('e', compressed.slice(0, target), summary, ts, tags)
  takeConsumed(store, 'e4', raw)
  store.log(`sealE4 ok chars=${body.length} page=${p} tags=${tags.join(',')}`)
  writeState(store, cfg)
  return true
}

/** F4 满：全量进 L4，索引 + 标签进 L3；归档后重算 L5。 */
export async function sealF4(store, ctx, cfg) {
  const raw = store.read('f4')
  const body = raw.trim()
  if (!body) return false
  const { summary, tags } = await summarizeAndTag(ctx, cfg, body, 'f')
  const ts = stamp(cfg.utcOffset)
  const p = store.recordPage('f', body, summary, ts, tags)
  takeConsumed(store, 'f4', raw)
  store.log(`sealF4 ok chars=${body.length} page=${p} tags=${tags.join(',')}`)
  try { await updateL5(store, ctx, cfg, body, { source: 'group' }) } catch (error) {
    store.log(`sealF4 updateL5 failed: ${error?.message ?? error}`)
  }
  writeState(store, cfg)
  return true
}

/** G4 满：全量进 L4，索引 + 标签进 L3。 */
export async function sealG4(store, ctx, cfg) {
  const raw = store.read('g4')
  const body = raw.trim()
  if (!body) return false
  const { summary, tags } = await summarizeAndTag(ctx, cfg, body, 'g')
  const ts = stamp(cfg.utcOffset)
  const p = store.recordPage('g', body, summary, ts, tags)
  takeConsumed(store, 'g4', raw)
  store.log(`sealG4 ok chars=${body.length} page=${p} tags=${tags.join(',')}`)
  writeState(store, cfg)
  return true
}

/** 一条链上的所有步骤，按从新到旧排列。 */
const CHAIN = [
  ['d1', compressD1],
  ['d2', compressD2],
  ['d3', sealD3],
  ['e1', compressE1],
  ['e2', compressE2],
  ['e3', compressE3],
  ['e4', sealE4],
  ['f1', compressF1],
  ['f2', compressF2],
  ['f3', compressF3],
  ['f4', sealF4],
  ['g1', compressG1],
  ['g2', compressG2],
  ['g3', compressG3],
  ['g4', sealG4],
]

/** 按顺序把超限的层压下去；返回做了哪些动作。 */
export async function enforce(store, ctx, cfg) {
  const limits = { ...TIER_LIMITS, ...(cfg?.limits ?? {}) }
  const done = []
  const failed = new Set()
  for (let guard = 0; guard < 8; guard += 1) {
    let acted = false
    for (const [tier, run] of CHAIN) {
      if (failed.has(tier)) continue
      if (store.size(tier) <= Number(limits[tier] ?? 0)) continue
      let ok = false
      try { ok = await run(store, ctx, cfg) } catch (error) {
        store.log(`enforce ${tier} failed: ${error?.message ?? error}`)
      }
      if (ok) { done.push(tier); acted = true } else { failed.add(tier) }
    }
    if (!acted) break
  }
  if (!done.length) writeState(store, cfg)
  return done
}

/** 读取某一区用于注入：按给定层顺序找第一个非空的；都没有就取 L4 该区最新一页。 */
export function pickZoneContent(store, tiers, zone) {
  for (const tier of tiers) {
    const body = store.read(tier).trim()
    if (body) return { tier, body, from: 'tier' }
  }
  const pages = store.l4().filter((page) => page.zone === normalizeZone(zone))
  const last = pages[pages.length - 1]
  if (last) {
    return {
      tier: 'l4',
      p: last.p,
      body: String(last.text ?? '').trim(),
      from: 'archive',
      ts: last.ts,
    }
  }
  return null
}

