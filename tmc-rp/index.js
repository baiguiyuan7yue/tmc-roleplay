// TMC 宿主半：把「她今天在 B 站/网上看过的」抽进 D1，并按各区的上限逐层压缩：
//   D1→D2→D3→L4/L3；E1→E2→E3→E4→(压到 5000)→L4/L3；F1→F2→F3→F4→L4/L3；G1→G2→G3→G4→L4/L3。
// 归档时给 L3 生成索引 + 标签；L2/F4 归档后还会重算 L5（她对每个人的总结）。
//
// 对外只读接口（给「各项数据」面板查 L3/L4/L5）：
//   GET /tmc/state.json            各区大小 / L3 L4 数量 / L5 / 最近索引
//   GET /tmc/query?q=…&zone=e      在 L3 索引里查（分词 + 同义 + 标签），命中的把 L4 原文一起返回
//   GET /tmc/l3?zone=f&limit=20    列某一区的索引
//   GET /tmc/l4?p=…                取某一页原文
//   GET /tmc/l5                    列 L5 的对人总结
import fs from 'node:fs'
import path from 'node:path'

import { createStore, DEFAULT_LIMITS, DEFAULT_UTC_OFFSET, normalizeZone, zoneLabel } from './lib/store.mjs?v=6'
import { buildState, enforce, stamp, writeState } from './lib/tiers.mjs?v=6'
import { searchPages } from './lib/search.mjs?v=6'

export const name = 'tmc'
export const inject = ['webServer']

const DEFAULTS = {
  baseDir: '/root/projects/qai-memory',
  readingDir: '/root/projects/qai-memory/reading',
  utcOffset: DEFAULT_UTC_OFFSET,
  intervalSeconds: 30,
  limits: DEFAULT_LIMITS,
  l5Enabled: true,
  userLabel: '对方',
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

const isLoopback = (req) => {
  const address = String(req.socket?.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
const isSameOrigin = (req) => {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...(config && typeof config === 'object' ? config : {}),
    limits: { ...DEFAULT_LIMITS, ...(config?.limits ?? {}) },
    l5Enabled: config?.l5Enabled !== false,
    userLabel: String(config?.userLabel ?? '对方'),
  }
  const store = createStore(String(cfg.baseDir))
  const readingDir = String(cfg.readingDir)
  const cursorFile = store.files.cursor

  // ── 归档记录 → 给预设半判断 L1 要不要注入 ──────────────────────
  // 角色扮演会话被归档以后，预设半才注入 L1。宿主半一直在跑，所以由它把
  // 「归档过的会话 id」append 到 archived-sessions.log；预设半只读这个文件。
  // 文件不存在 = 宿主半还是旧版，预设半会退回「总是注入 L1」。
  const archivedFile = path.join(path.dirname(store.files.log), 'archived-sessions.log')
  const archivedIds = new Set()
  const noteArchived = (ids) => {
    const at = Date.now()
    const lines = []
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw ?? '').trim()
      if (!id || archivedIds.has(id)) continue
      archivedIds.add(id)
      lines.push(`${id}\t${at}\n`)
    }
    if (!lines.length) return
    try {
      fs.mkdirSync(path.dirname(archivedFile), { recursive: true })
      fs.appendFileSync(archivedFile, lines.join(''), 'utf8')
      store.log(`archived +${lines.length} (total ${archivedIds.size})`)
    } catch (error) {
      store.log(`archive log failed: ${error?.message ?? error}`)
    }
  }
  try {
    for (const line of fs.readFileSync(archivedFile, 'utf8').split('\n')) {
      const id = line.trim().split('\t')[0]
      if (id) archivedIds.add(id)
    }
  } catch { /* 还没有文件 */ }
  try {
    ctx.on('domain/changed', (change) => {
      if (!change || change.domain !== 'workspace' || change.operation !== 'put') return
      if (change.table !== '' || change.key !== '') return
      noteArchived(change.value?.archivedSessionIds)
    })
  } catch { /* 没有事件接口 */ }
  // 启动时先把当前归档集播种进来；workspace 服务可能在 apply 之后才就绪，
  // 而它自己的 state 又要再晚一点才加载完，所以启动后再补一次。
  // 只有拿到 workspace 服务才建这个文件：没有 workspace 的 profile 保持
  // 「文件不存在 = 旧行为」的退回逻辑。
  try {
    ctx.inject(['workspaceRegistry'], (inner) => {
      const seed = () => {
        try {
          fs.mkdirSync(path.dirname(archivedFile), { recursive: true })
          if (!fs.existsSync(archivedFile)) fs.writeFileSync(archivedFile, '', 'utf8')
          const registry = inner.get?.('workspaceRegistry') ?? inner.workspaceRegistry
          noteArchived(registry?.archivedSessionIds ?? [])
        } catch { /* registry 还没 start */ }
      }
      seed()
      try {
        const timer = setTimeout(seed, 3000)
        if (typeof timer.unref === 'function') timer.unref()
      } catch { /* ignore */ }
    })
  } catch { /* 没有 workspace 服务 */ }

  // ── 阅读文件 → D1 ─────────────────────────────────────────────
  // qai-bili / qai-reading 都往 reading/<今天>.md 里追加；这里只搬运新字节，
  // 记 cursor（文件 + 偏移），不重复、不遗漏。
  const drainReading = () => {
    try {
      const day = stamp(cfg.utcOffset).slice(0, 10)
      const file = path.join(readingDir, `${day}.md`)
      if (!fs.existsSync(file)) return false
      const stat = fs.statSync(file)
      const cur = readJson(cursorFile, { file: '', offset: 0 }) ?? { file: '', offset: 0 }
      let offset = cur.file === file ? Number(cur.offset) || 0 : 0
      if (stat.size < offset) offset = 0
      if (stat.size <= offset) return false
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(stat.size - offset)
      try { fs.readSync(fd, buf, 0, buf.length, offset) } finally { fs.closeSync(fd) }
      const chunk = buf.toString('utf8').trim()
      if (!chunk) return false
      store.append('d1', `${chunk}\n`)
      store.write('cursor', JSON.stringify({ file, offset: stat.size }))
      store.log(`drain reading +${chunk.length} chars -> d1=${store.size('d1')}`)
      return true
    } catch (error) {
      store.log(`drain failed: ${error?.message ?? error}`)
      return false
    }
  }

  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      drainReading()
      await enforce(store, ctx, cfg)
    } catch (error) {
      store.log(`tick failed: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }

  const gate = (req, res) => {
    if (!isLoopback(req) || !isSameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '只接受本机同源请求。' }))
      return false
    }
    return true
  }
  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const route = (pathName, handler) => {
    try {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: pathName, handler }))
    } catch (error) {
      store.log(`route ${pathName} failed: ${error?.message ?? error}`)
    }
  }

  route('/tmc/state.json', (req, res) => {
    if (!gate(req, res)) return
    try { sendJson(res, 200, buildState(store, cfg)) } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('/tmc/query', (req, res) => {
    if (!gate(req, res)) return
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const q = String(url.searchParams.get('q') || '').trim()
      const zone = normalizeZone(url.searchParams.get('zone'), '')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 3) || 3, 1), 8)
      if (!q) { sendJson(res, 200, { ok: true, query: '', zone, hits: [] }); return }
      const pages = store.l4()
      const byP = new Map(pages.map((page) => [Number(page.p), page.text]))
      const hits = searchPages(store.l3(), (p) => byP.get(Number(p)) ?? '', q, {
        limit, groups: cfg.synonyms, zone,
      }).map((hit) => ({
        p: hit.p,
        ts: hit.ts,
        zone: hit.zone,
        zoneLabel: zoneLabel(hit.zone),
        ch: hit.ch,
        tags: hit.tags ?? [],
        summary: hit.summary,
        text: String(hit.text ?? '').slice(0, 6000),
        score: hit.score,
      }))
      sendJson(res, 200, { ok: true, query: q, zone, hits })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('/tmc/l3', (req, res) => {
    if (!gate(req, res)) return
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const zone = normalizeZone(url.searchParams.get('zone'), '')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100)
      let rows = store.l3()
      if (zone) rows = rows.filter((row) => row.zone === zone)
      sendJson(res, 200, { ok: true, zone, total: rows.length, rows: rows.slice(-limit).reverse() })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('/tmc/l4', (req, res) => {
    if (!gate(req, res)) return
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = Number(url.searchParams.get('p') ?? 0)
      const page = store.l4().find((item) => Number(item.p) === p)
      if (!page) { sendJson(res, 404, { ok: false, error: '没有这一页。' }); return }
      sendJson(res, 200, { ok: true, ...page, zoneLabel: zoneLabel(page.zone) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('/tmc/l5', (req, res) => {
    if (!gate(req, res)) return
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const person = String(url.searchParams.get('person') ?? '').trim()
      const data = store.l5()
      const people = Object.entries(data.people).map(([key, entry]) => ({
        person: key,
        name: String(entry?.name ?? (key === 'user' ? cfg.userLabel : key)),
        summary: String(entry?.summary ?? ''),
        updated: String(entry?.updated ?? ''),
        source: String(entry?.source ?? ''),
      }))
      if (person) {
        const hit = people.find((row) => row.person === person || row.name === person)
        sendJson(res, 200, { ok: true, updated: data.updated, person: hit ?? null })
        return
      }
      sendJson(res, 200, { ok: true, updated: data.updated, people })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 启动后先跑一次（把今天已有的阅读搬进 D1），之后每 30 秒一轮。
  ctx.effect(() => {
    const first = setTimeout(() => { void tick() }, 3000)
    const timer = setInterval(() => { void tick() }, Math.max(5, Number(cfg.intervalSeconds) || 30) * 1000)
    return () => { clearTimeout(first); clearInterval(timer) }
  })

  writeState(store, cfg)
  store.log(
    `loaded(tmc v8-rp) base=${cfg.baseDir} reading=${readingDir} archived=${archivedIds.size} `
    + `d1=${cfg.limits.d1} d2=${cfg.limits.d2} d3=${cfg.limits.d3} `
    + `e1=${cfg.limits.e1} e2=${cfg.limits.e2} e3=${cfg.limits.e3} e4=${cfg.limits.e4} `
    + `f1=${cfg.limits.f1} f2=${cfg.limits.f2} f3=${cfg.limits.f3} f4=${cfg.limits.f4} `
    + `g1=${cfg.limits.g1} g2=${cfg.limits.g2} g3=${cfg.limits.g3} g4=${cfg.limits.g4}`
  )
}
