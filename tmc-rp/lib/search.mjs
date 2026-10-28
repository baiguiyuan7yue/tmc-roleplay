// TMC 的检索层：中文分词（二元组 + 整段）+ 同义扩展 + 标签加权 + 分区过滤。
//
// 没有依赖、没有词典，原则是“宁可多匹配，也别漏”：
//   · 中文按 2-gram 切，再保留整段（长词权重更高）；
//   · 同义组是手写的小表，覆盖日常会聊到的主题，可用 config.synonyms 覆盖/追加；
//   · L3 先按 zone（l/d/e/f/g）分区，再按 summary + tags 打分；
//   · 一条索引都没命中时，退回该区的 L4 原文里找。
const DEFAULT_GROUPS = [
  ['海边', '海滩', '看海', '度假', '旅行', '旅游', '出行'],
  ['吃饭', '美食', '餐厅', '做饭', '好吃', '零食'],
  ['电影', '影片', '片子', '看片', '剧'],
  ['游戏', '打游戏', '开黑', '抽卡', '配队', '副本', '原神', '星铁', '崩铁', '鸣潮', '绝区零', '王者', '上分'],
  ['音乐', '歌', '歌曲', '听歌', '演唱会'],
  ['猫', '猫咪', '小猫', '喵'],
  ['狗', '狗狗', '小狗', '汪'],
  ['工作', '上班', '加班', '打工', '同事'],
  ['学习', '读书', '看书', '课程', '考试'],
  ['睡', '睡觉', '失眠', '熬夜', '困'],
  ['生日', '纪念日', '礼物', '惊喜'],
  ['吵架', '生气', '闹别扭', '冷战', '不开心'],
  ['喜欢', '表白', '爱', '心动'],
  ['天气', '下雨', '降温', '热', '冷'],
  ['B站', 'bilibili', '哔哩哔哩', '视频', 'up主'],
  ['AI', '模型', '大模型', '人工智能'],
  ['甜点', '蛋糕', '甜品', '奶茶'],
  ['小说', '轻小说', '看书', '阅读'],
  ['群聊', '群里', '群友', '群主', 'QQ群', '微信群'],
]

const STOPWORDS = new Set([
  '一个', '一些', '什么', '这个', '那个', '这些', '那些', '我们', '你们', '他们', '她们',
  '自己', '时候', '现在', '今天', '昨天', '明天', '因为', '所以', '但是', '然后', '就是',
  '还是', '可以', '没有', '不是', '这里', '那里', '这样', '那样', '觉得', '知道', '已经',
  '出来', '起来', '一下', '有点', '真的', '应该', '可能', '如果', '虽然', '不过', '而且',
  '以及', '还有', '的话', '一样', '一直', '一起', '东西', '事情', '感觉', '看着', '说的',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'from',
])

function buildSynonymMap(groups = DEFAULT_GROUPS) {
  const map = new Map()
  for (const group of groups) {
    const keys = group.map((w) => String(w).toLowerCase())
    for (const key of keys) {
      const set = map.get(key) ?? new Set()
      for (const other of keys) set.add(other)
      map.set(key, set)
    }
  }
  return map
}

/** 中文 2-gram + 整段 + 英文/数字词。 */
export function tokenize(text) {
  const out = new Set()
  const raw = String(text ?? '').toLowerCase()
  for (const m of raw.matchAll(/[a-z0-9][a-z0-9._-]*/g)) out.add(m[0])
  const han = raw.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const seg of han.split(/\s+/)) {
    if (!seg) continue
    if (seg.length === 1) out.add(seg)
    else {
      out.add(seg)
      for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2))
    }
  }
  return [...out]
}

/** 查询词 → 同义扩展后的全部词。 */
export function expand(tokens, groups) {
  const map = buildSynonymMap(groups)
  const out = new Set(tokens)
  for (const token of tokens) {
    for (const syn of map.get(token) ?? []) out.add(syn)
  }
  return [...out]
}

const weightOf = (token) => Math.min(4, Math.max(1, token.length))

/** 从一段正文里抽关键词，做 L3 标签的兜底。 */
export function extractTags(text, limit = 6) {
  const counts = new Map()
  for (const token of tokenize(text)) {
    if (token.length < 2 || token.length > 12) continue
    if (STOPWORDS.has(token)) continue
    if (/^[\d._-]+$/.test(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const scored = [...counts.entries()]
    .map(([token, count]) => ({ token, score: count * (1 + Math.min(4, token.length) / 2) }))
    .sort((a, b) => b.score - a.score)
  const picked = []
  for (const { token } of scored) {
    if (picked.some((tag) => tag.includes(token) || token.includes(tag))) continue
    picked.push(token)
    if (picked.length >= Math.max(1, limit)) break
  }
  return picked
}

/** 一条 L3 索引 + 它的 L4 原文，对查询的得分。 */
export function scorePage(page, query, groups) {
  const tokens = tokenize(query)
  if (!tokens.length) return 0
  const expanded = expand(tokens, groups)
  const summary = String(page.summary ?? '').toLowerCase()
  const text = String(page.text ?? '').toLowerCase()
  const tags = Array.isArray(page.tags) ? page.tags.map((tag) => String(tag).toLowerCase()) : []
  let score = 0
  for (const token of tokens) {
    if (summary.includes(token)) score += 3 * weightOf(token)
  }
  for (const token of expanded) {
    if (summary.includes(token)) score += 2 * weightOf(token)
    if (text && text.includes(token)) score += weightOf(token)
    for (const tag of tags) {
      if (tag.includes(token) || token.includes(tag)) score += 2 * weightOf(token)
    }
  }
  return score
}

const inZone = (entry, zone) => !zone || String(entry?.zone ?? '') === zone

/**
 * @param {Array} entries  L3 索引条目（带 p / summary / zone / tags）
 * @param {(p:number)=>string} loadText  p → L4 原文
 * @param {string} [options.zone]  只看某个区（l/d/e/f/g）
 */
export function searchPages(entries, loadText, query, { limit = 3, groups, zone } = {}) {
  const pool = entries.filter((entry) => inZone(entry, zone))
  const scored = pool
    .map((entry) => ({ ...entry, text: loadText(entry.p) || '', score: 0 }))
    .map((entry) => ({ ...entry, score: scorePage(entry, query, groups) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  // 索引一条都没命中：退回该区 L4 原文里找（多花一点，但比“什么都没有”强）
  if (!scored.length) {
    const tokens = tokenize(query)
    const expanded = expand(tokens, groups)
    for (const entry of pool) {
      const text = String(loadText(entry.p) ?? '').toLowerCase()
      let score = 0
      for (const token of expanded) if (token.length >= 2 && text.includes(token)) score += weightOf(token)
      if (score > 0) scored.push({ ...entry, text: loadText(entry.p) || '', score })
    }
    scored.sort((a, b) => b.score - a.score)
  }
  return scored.slice(0, Math.max(1, Math.min(5, limit)))
}

export { DEFAULT_GROUPS }
