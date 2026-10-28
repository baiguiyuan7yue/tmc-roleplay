// TMC 的存储层：五个记忆区 + L5 核心记忆。
//
// 全部是本地纯文本/JSONL，不依赖任何 DSH 包：
//   L 区（聊天）  l1.md / l2.md
//   D 区（阅读）  d1.md / d2.md / d3.md
//   E 区（游戏）  e1.md / e2.md / e3.md / e4.md
//   F 区（群聊）  f1.md / f2.md / f3.md / f4.md
//   G 区（备用）  g1.md / g2.md / g3.md / g4.md
//   L3 索引       l3.jsonl  {"p":1,"ts":"...","zone":"e","ch":"e","summary":"...","tags":["..."]}
//   L4 原文       l4.jsonl  {"p":1,"ts":"...","zone":"e","ch":"e","text":"..."}
//   L5 核心记忆   l5.json   {"version":1,"people":{"user":{"name":"对方","summary":"...","updated":"..."}}}
//
// L3 只放索引（永久），L4 只放原文（永久）；p 是两者的对应号。
// L3 内部按 zone（l/d/e/f/g）分区，检索时可以只看某一区。
import fs from 'node:fs'
import path from 'node:path'

/** 五个记忆区；tiers 从新到旧，archive 永远是 L4。 */
export const ZONES = {
  l: { key: 'l', label: 'L 聊天', short: 'L', tiers: ['l1', 'l2'] },
  d: { key: 'd', label: 'D 阅读', short: 'D', tiers: ['d1', 'd2', 'd3'] },
  e: { key: 'e', label: 'E 游戏', short: 'E', tiers: ['e1', 'e2', 'e3', 'e4'] },
  f: { key: 'f', label: 'F 群聊', short: 'F', tiers: ['f1', 'f2', 'f3', 'f4'] },
  g: { key: 'g', label: 'G 备用', short: 'G', tiers: ['g1', 'g2', 'g3', 'g4'] },
}

export const ZONE_ORDER = ['l', 'd', 'e', 'f', 'g']

/** 每一层的上限（字符数）。用户 2026-10-24 定的值。 */
export const DEFAULT_LIMITS = {
  l1: 2400,
  l2: 4000,
  d1: 10000,
  d2: 8000,
  d3: 5000,
  e1: 50000,
  e2: 30000,
  e3: 20000,
  e4: 10000,
  f1: 200000,
  f2: 50000,
  f3: 12000,
  f4: 3000,
  g1: 200000,
  g2: 50000,
  g3: 20000,
  g4: 5000,
}

/** 层名 → 区。 */
export const TIER_ZONE = Object.freeze(
  Object.fromEntries(ZONE_ORDER.flatMap((zone) => ZONES[zone].tiers.map((tier) => [tier, zone]))),
)

/** 区 → 归档时压到的目标长度（只有 E4 需要先压到 5000 再进 L4）。 */
export const ARCHIVE_TARGETS = { e4: 5000 }

export const DEFAULT_UTC_OFFSET = 8

/** 容错：把 e / E / e1 / 'e3' 之类都收成单字母区名。 */
export function normalizeZone(value, fallback = '') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  const first = raw[0]
  if (ZONES[first]) return first
  return fallback
}

/** L3/L4 里的通道字段，保留旧字段名，面板和旧数据都能读。 */
export function channelOf(zone) {
  if (zone === 'l') return 'chat'
  if (zone === 'd') return 'read'
  return zone
}

export function zoneLabel(zone) {
  return ZONES[normalizeZone(zone, 'l')]?.label ?? 'L 聊天'
}

export function zoneShort(zone) {
  return ZONES[normalizeZone(zone, 'l')]?.short ?? 'L'
}

const cleanTags = (tags) => {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((tag) => String(tag ?? '').trim()).filter(Boolean))].slice(0, 10)
}

export function createStore(baseDir) {
  const root = path.join(baseDir, 'tmc')
  const files = {
    l1: path.join(root, 'l1.md'),
    l2: path.join(root, 'l2.md'),
    d1: path.join(root, 'd1.md'),
    d2: path.join(root, 'd2.md'),
    d3: path.join(root, 'd3.md'),
    e1: path.join(root, 'e1.md'),
    e2: path.join(root, 'e2.md'),
    e3: path.join(root, 'e3.md'),
    e4: path.join(root, 'e4.md'),
    f1: path.join(root, 'f1.md'),
    f2: path.join(root, 'f2.md'),
    f3: path.join(root, 'f3.md'),
    f4: path.join(root, 'f4.md'),
    g1: path.join(root, 'g1.md'),
    g2: path.join(root, 'g2.md'),
    g3: path.join(root, 'g3.md'),
    g4: path.join(root, 'g4.md'),
    l3: path.join(root, 'l3.jsonl'),
    l4: path.join(root, 'l4.jsonl'),
    l5: path.join(root, 'l5.json'),
    state: path.join(root, 'state.json'),
    cursor: path.join(root, 'cursor.json'),
    log: path.join(root, 'tmc.log'),
  }

  const ensure = () => {
    try { fs.mkdirSync(root, { recursive: true }) } catch { /* ignore */ }
  }
  const read = (name) => {
    try { return fs.readFileSync(files[name], 'utf8') } catch { return '' }
  }
  const write = (name, text) => {
    try {
      ensure()
      fs.writeFileSync(files[name], text, 'utf8')
      return true
    } catch { return false }
  }
  /** 先写临时文件再 rename，避免 L5/state 被读到半截。 */
  const writeAtomic = (name, text) => {
    try {
      ensure()
      const tmp = `${files[name]}.tmp`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, files[name])
      return true
    } catch {
      return write(name, text)
    }
  }
  const append = (name, text) => {
    try {
      ensure()
      fs.appendFileSync(files[name], text, 'utf8')
      return true
    } catch { return false }
  }
  const size = (name) => read(name).length
  const trim = (name, cap) => {
    const text = read(name).trim()
    if (!cap || text.length <= cap) return false
    // 按行裁掉最旧的，保留尾部
    const lines = text.split('\n')
    const kept = []
    let used = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (used + line.length + 1 > cap) break
      kept.unshift(line)
      used += line.length + 1
    }
    write(name, (kept.join('\n') || text.slice(-cap)).trim() + '\n')
    return true
  }
  const readJsonl = (name) => {
    const out = []
    for (const line of read(name).split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip broken line */ }
    }
    return out
  }
  const appendJsonl = (name, obj) => append(name, `${JSON.stringify(obj)}\n`)

  /** 旧记录只有 ch=chat|read，补出 zone；新记录原样。 */
  const normalizePage = (raw) => {
    const ch = String(raw?.ch ?? '')
    const zone = normalizeZone(raw?.zone, ch === 'chat' ? 'l' : ch === 'read' ? 'd' : normalizeZone(ch, 'l'))
    return {
      ...raw,
      zone,
      ch: ch || channelOf(zone),
      summary: String(raw?.summary ?? ''),
      tags: cleanTags(raw?.tags),
    }
  }
  const l3 = () => readJsonl('l3').map(normalizePage)
  const l4 = () => readJsonl('l4').map(normalizePage)

  const recordPage = (zoneInput, text, summary, ts, tags = []) => {
    const zone = normalizeZone(zoneInput, 'l')
    const pages = l4()
    const p = pages.reduce((max, page) => Math.max(max, Number(page.p) || 0), 0) + 1
    const ch = channelOf(zone)
    appendJsonl('l4', { p, ts, zone, ch, text })
    appendJsonl('l3', { p, ts, zone, ch, summary, tags: cleanTags(tags) })
    return p
  }

  const l5 = () => {
    try {
      const parsed = JSON.parse(read('l5'))
      if (parsed && typeof parsed === 'object' && parsed.people && typeof parsed.people === 'object') {
        // 兼容模型可能写出的「对方 / 你」：统一归到 user，否则注入时找不到。
        const people = {}
        for (const [key, entry] of Object.entries(parsed.people)) {
          if (!entry || typeof entry !== 'object') continue
          const raw = String(key ?? '').trim()
          const person = ['user', '对方', '你'].includes(raw) ? 'user' : raw
          if (!person) continue
          const previous = people[person]
          if (!previous || String(entry.updated ?? '') >= String(previous.updated ?? '')) {
            people[person] = {
              ...entry,
              name: person === 'user' ? String(entry.name ?? '对方') : String(entry.name ?? person),
            }
          }
        }
        return { version: 1, updated: String(parsed.updated ?? ''), people }
      }
    } catch { /* ignore */ }
    return { version: 1, updated: '', people: {} }
  }
  const writeL5 = (value) => writeAtomic('l5', JSON.stringify(value, null, 2))

  const log = (msg) => {
    try {
      ensure()
      fs.appendFileSync(files.log, `${new Date().toISOString()} ${msg}\n`, 'utf8')
    } catch { /* ignore */ }
  }

  const allTiers = () => ZONE_ORDER.flatMap((zone) => ZONES[zone].tiers)
  const zoneSize = (zone) => ZONES[normalizeZone(zone, 'l')].tiers.reduce((sum, tier) => sum + size(tier), 0)

  return {
    root, files,
    read, write, writeAtomic, append, size, trim, readJsonl, appendJsonl, l3, l4, l5, writeL5,
    recordPage, log, allTiers, zoneSize,
    hasData: () => [...allTiers(), 'l3', 'l4', 'l5'].some((name) => size(name) > 0),
  }
}
