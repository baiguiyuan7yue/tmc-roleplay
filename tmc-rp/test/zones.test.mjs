// TMC 的关键行为回归测试（不连真实模型，用一个假 LLM 驱动压缩）。
//
//   node --test test/
//
// 覆盖：自动分流、E/F/G 归档、L3 分区与标签、L5 人物总结、state 结构。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStore, DEFAULT_LIMITS } from '../lib/store.mjs'
import { buildState, enforce } from '../lib/tiers.mjs'
import { classifyContent, isGameTalk, isGroupTalk } from '../lib/classify.mjs'
import { searchPages } from '../lib/search.mjs'

const fakeStream = (text) => (async function* () {
  for (let i = 0; i < text.length; i += 500) yield { type: 'text-delta', text: text.slice(i, i + 500) }
})()

const fakeLlm = {
  stream(opts) {
    const prompt = opts.messages[0].content[0].text
    let out = '压缩后的记忆 ' + '内容'.repeat(2500)
    if (prompt.includes('JSON 数组') || prompt.includes('请从「她」的视角')) {
      out = JSON.stringify([
        { person: 'user', summary: '他是个嘴硬心软的人，我习惯了他每天来店里坐一会儿，也记得他怕吵、不爱被人追问；他答应过的事从不食言，所以我愿意多信他一点。' },
        { person: '八重神子', summary: '神子总爱逗我，我不接她的话，但她来的时候我会多倒一杯茶；她其实比谁都细心，只是不肯好好说，我也不拆穿她。' },
      ])
    } else if (prompt.includes('JSON 对象')) {
      const tags = prompt.includes('游戏记忆') ? ['原神', '抽卡'] : prompt.includes('群聊记忆') ? ['群聊', '聚餐'] : ['杂项']
      out = JSON.stringify({ summary: '这是'.repeat(40) + '的索引', tags })
    } else if (prompt.includes('合并')) {
      out = '合并稿 ' + '并'.repeat(4000)
    }
    return fakeStream(out)
  },
}

const cfg = { limits: { ...DEFAULT_LIMITS }, utcOffset: 8, l5Enabled: true, userLabel: '对方' }
const ctx = { get: (name) => (name === 'llm' ? fakeLlm : undefined) }

const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-test-'))
  return { dir, store: createStore(dir) }
}

test('内容分流：游戏/群聊/搜索/聊天/备用', () => {
  assert.equal(classifyContent('今晚原神抽卡十连出了'), 'e')
  assert.equal(classifyContent('群里有人说周末聚餐'), 'f')
  assert.equal(classifyContent('B站这个视频很好看'), 'd')
  assert.equal(classifyContent('你：今天吃什么'), 'l')
  assert.equal(classifyContent('今天把旧书搬去仓库'), 'g')
  assert.equal(isGameTalk('我们今晚开黑吗'), true)
  assert.equal(isGroupTalk('群里聊了什么'), true)
})

test('E 链：E1→E2→E3→E4→压到 5000 的 L4 + L3 标签', async () => {
  const { dir, store } = tempStore()
  try {
    store.write('e1', '游戏原始记忆'.repeat(10000))
    assert.ok((await enforce(store, ctx, cfg)).includes('e1'))
    assert.equal(store.size('e1'), 0)
    assert.ok(store.size('e2') > 0)
    store.append('e2', '补齐'.repeat(20000))
    assert.ok((await enforce(store, ctx, cfg)).includes('e2'))
    store.append('e3', '补齐'.repeat(12000))
    assert.ok((await enforce(store, ctx, cfg)).includes('e3'))
    store.append('e4', '补齐'.repeat(6000))
    assert.ok((await enforce(store, ctx, cfg)).includes('e4'))
    assert.equal(store.size('e4'), 0)
    const page = store.l4().find((row) => row.zone === 'e')
    assert.ok(page.text.length > 0 && page.text.length <= 5000)
    const index = store.l3().find((row) => row.zone === 'e')
    assert.ok(index.tags.length >= 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('F 链：F4 全量进 L4、带标签，并重算 L5', async () => {
  const { dir, store } = tempStore()
  try {
    store.write('f4', '群里最后几句话'.repeat(500))
    assert.ok((await enforce(store, ctx, cfg)).includes('f4'))
    const page = store.l4().find((row) => row.zone === 'f')
    assert.ok(page.text.includes('群里最后几句话'))
    assert.equal(store.l3().find((row) => row.zone === 'f').tags.length, 2)
    const l5 = store.l5()
    assert.ok(l5.people.user?.summary?.length >= 50)
    assert.ok(l5.people['八重神子']?.summary?.length >= 50)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('G 链：G4 全量进 L4', async () => {
  const { dir, store } = tempStore()
  try {
    store.write('g4', '杂项记忆'.repeat(1300))
    assert.ok((await enforce(store, ctx, cfg)).includes('g4'))
    assert.ok(store.l4().find((row) => row.zone === 'g').text.includes('杂项记忆'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('L5 兼容模型写出的「对方 / 你」别名', () => {
  const { dir, store } = tempStore()
  try {
    store.writeL5({ version: 1, updated: 'x', people: {
      '对方': { name: '对方', summary: '他是个嘴硬心软的人，我记得他怕吵、不爱被人追问，也记得他答应过周六会来，不用我催。', updated: '2026-10-24' },
    } })
    assert.ok(store.l5().people.user)
    assert.ok(!store.l5().people['对方'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('L3 分区检索：标签命中，跨区不串', () => {
  const { dir, store } = tempStore()
  try {
    store.recordPage('e', '游戏原文', '原神抽卡双黄', '2026-10-24 12:00', ['原神', '抽卡'])
    store.recordPage('f', '群聊原文', '群里约周六吃饭', '2026-10-24 12:01', ['群聊', '周六'])
    const byP = new Map(store.l4().map((row) => [Number(row.p), row.text]))
    assert.equal(searchPages(store.l3(), (p) => byP.get(Number(p)) ?? '', '抽卡', { zone: 'e' }).length, 1)
    assert.equal(searchPages(store.l3(), (p) => byP.get(Number(p)) ?? '', '抽卡', { zone: 'f' }).length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('state 结构：五区、L3/L4 分区计数、L5', async () => {
  const { dir, store } = tempStore()
  try {
    store.write('f4', '群里最后几句话'.repeat(500))
    await enforce(store, ctx, cfg)
    const state = buildState(store, cfg)
    assert.equal(state.zones.length, 5)
    assert.equal(state.counts.l3, state.counts.l4)
    assert.equal(state.counts.l3ByZone.f, 1)
    assert.equal(state.counts.l5, 2)
    assert.equal(state.limits.e1, 50000)
    assert.equal(state.limits.f1, 200000)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
