// TMC 的分流规则：一条新记忆该进哪个区，以及这一轮该不该注入 E3 / F3。
//
// 顺序（用户 2026-10-24 定）：显式 zone 优先；否则
//   游戏 → E，群聊 → F，搜索/B站 → D，像聊天 → L，其它 → G。
// 「其它进 G」是兜底，所以 G 区又叫备用记忆区。
import { normalizeZone } from './store.mjs?v=5'

/** 明显是游戏记忆的词。 */
const GAME_WORDS = [
  '游戏', '打游戏', '玩游', '开黑', '上分', '排位', '副本', '抽卡', '十连', '配队',
  '原神', '星铁', '崩铁', '鸣潮', '绝区零', '王者', '荣耀', '吃鸡', '我的世界', '塞尔达',
  '宝可梦', 'switch', 'ps5', 'ps4', 'steam', '手游', '端游', '电竞', '公会', '打本',
  '刷本', '氪金', '抽到', 'boss', 'raid', '存档', '通关', '关卡', '卡池', '角色池',
  '圣遗物', '深渊', '联机', '战绩', '段位', '开服', '池子', '主线', '支线', '练度',
]

/** 群里说话的标志。 */
const GROUP_WORDS = [
  '群聊', '群里', '群友', '群主', '群消息', '群公告', '群内', '群上', '群里的',
  'QQ群', 'qq群', '微信群', '扣群', '讨论组', '频道里', '公屏',
]

/** 搜索 / B站 / 阅读通道。 */
const READ_WORDS = [
  'b站', 'bilibili', '哔哩', 'up主', '视频', '网页', '文章', '新闻', '搜到', '搜索',
  '链接', 'http', '知乎', '贴吧', '百科', '攻略', '刷到', '帖子', '博客', '专栏',
]

/** 像聊天记录/聊天记忆的标志。 */
const CHAT_WORDS = [
  '聊天', '对话', '对我说', '对他说', '对她说', '她说过', '他说过', '答应', '约好',
  '回我', '问我', '告诉我', '跟他聊', '跟她聊', '和他聊', '和她聊', '陪我', '安慰',
  '你：', '她：', '他：', '我：', '他说', '她说', '他说过', '她说过', '对我说',
]

const hasAny = (text, words) => words.some((word) => text.includes(word))

/** 显式 zone：接受 e / E / e1 / e3 之类；不合法返回 ''。 */
export function resolveZone(value) {
  return normalizeZone(value, '')
}

/**
 * 自动分流。
 * @returns {'e'|'f'|'d'|'l'|'g'}
 */
export function classifyContent(value) {
  const text = String(value ?? '').toLowerCase().trim()
  if (!text) return 'g'
  if (hasAny(text, GAME_WORDS)) return 'e'
  if (hasAny(text, GROUP_WORDS)) return 'f'
  if (hasAny(text, READ_WORDS)) return 'd'
  if (hasAny(text, CHAT_WORDS)) return 'l'
  return 'g'
}

/** 这一轮是不是在聊游戏（决定要不要注入 E3）。 */
export function isGameTalk(value) {
  const text = String(value ?? '').toLowerCase()
  return text.length > 0 && hasAny(text, GAME_WORDS)
}

/** 这一轮是不是在聊群里说了什么（决定要不要注入 F3）。 */
export function isGroupTalk(value) {
  const text = String(value ?? '').toLowerCase()
  return text.length > 0 && hasAny(text, GROUP_WORDS)
}

export { GAME_WORDS, GROUP_WORDS, READ_WORDS, CHAT_WORDS }
