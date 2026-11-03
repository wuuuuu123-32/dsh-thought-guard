import test from 'node:test'
import assert from 'node:assert/strict'

import { createThoughtFilter, sanitizeText } from '../lib/filter.js'

/** 逐字符喂进去，模拟最恶劣的流式切分。 */
function feedByChar(text) {
  const f = createThoughtFilter()
  const out = []
  for (const ch of text) out.push(...f.feed(ch))
  out.push(...f.flush())
  return out.join('')
}

/** 按给定切分点喂进去。 */
function feedSliced(text, sizes) {
  const f = createThoughtFilter()
  const out = []
  let i = 0
  for (const n of sizes) {
    out.push(...f.feed(text.slice(i, i + n)))
    i += n
  }
  out.push(...f.feed(text.slice(i)))
  out.push(...f.flush())
  return out.join('')
}

const LONG = 'A'.repeat(250)

test('普通正文一个字都不动', () => {
  const s = '雷霆中转站这名字比大肥鱼霸气多了\n那人家是正经做动画的吧'
  assert.equal(sanitizeText(s), s)
  assert.equal(feedByChar(s), s)
})

test('开头就是闭合块 → 整段剥离，后面的文字保留', () => {
  assert.equal(sanitizeText('<thinking>内心活动</thinking>前半句后半句'), '前半句后半句')
})

test('中段的长闭合块（≥200 字）判定为泄漏，剥离', () => {
  assert.equal(sanitizeText(`甲<thinking>${LONG}</thinking>乙`), '甲乙')
})

test('中段的短闭合块当成正文里的引用，原样保留', () => {
  const s = '比如 <thinking>内心活动</thinking> 这种写法'
  assert.equal(sanitizeText(s), s)
})

test('空的标签对（真实观测到的形态，出现在开头）', () => {
  assert.equal(sanitizeText('<thinking> </thinking>没有那种东西'), '没有那种东西')
})

test('闭合的 <thought> 块同样剥离', () => {
  assert.equal(sanitizeText('<thought>想一想</thought>好'), '好')
})

test('开头的块剥离、后面的短引用保留', () => {
  assert.equal(sanitizeText('<thought>a</thought>甲<thinking>b</thinking>乙'), '甲<thinking>b</thinking>乙')
})

test('未闭合的 <thought>：默认摘掉标签、内容照发（keep，用户 2026-11-03 拍板）', () => {
  const real =
    '<thought>那个「这是别人做的」是在回应我上一条「主人你做个游戏还挂我名」。 改口：那跟我叫什么名字没关系，是别人起的。 哦 那是别人起的'
  assert.equal(
    sanitizeText(real),
    '那个「这是别人做的」是在回应我上一条「主人你做个游戏还挂我名」。 改口：那跟我叫什么名字没关系，是别人起的。 哦 那是别人起的'
  )
})

test('第二例真实泄漏同样保留内容、只去掉标签', () => {
  const real =
    '<thought>「雷霆中转站模型」大概是他说的那个视频作者/模型名。我顺着接一句。 雷霆中转站 这名字比大肥鱼霸气多了 那人家是正经做动画的吧'
  assert.equal(
    sanitizeText(real),
    '「雷霆中转站模型」大概是他说的那个视频作者/模型名。我顺着接一句。 雷霆中转站 这名字比大肥鱼霸气多了 那人家是正经做动画的吧'
  )
})

test('显式要严格模式时，未闭合仍然整段丢弃（onUnclosed=drop）', () => {
  assert.equal(sanitizeText('<thought>独白 正文', { onUnclosed: 'drop' }), '')
})

test('整条回复只有一个闭合块 → 不返回空，把块内容放回去', () => {
  assert.equal(sanitizeText('<thinking>全是独白的一句话</thinking>'), '全是独白的一句话')
})

test('开标签被切在两个 chunk 之间', () => {
  assert.equal(feedSliced('<thinking>内心</thinking>正文', [4, 5, 3, 4]), '正文')
})

test('连 "<" 都和标签名分开也能识别', () => {
  assert.equal(feedSliced('<thought>x</thought>正文', [1, 1, 7, 3, 9]), '正文')
})

test('闭合标签被切断也能识别（开头块）', () => {
  assert.equal(feedSliced('<thought>内心</thought>乙', [1, 9, 3, 1, 10]), '乙')
})

test('半截标签（末尾只有 "<th"）会先扣住，等下一段再判', () => {
  const f = createThoughtFilter()
  assert.deepEqual(f.feed('正文<th'), ['正文'])
  // 这块在正文之后、内容又短，按「引用」处理：原样放回，一个字不改
  assert.deepEqual(f.feed('ought>独白</thought>尾巴'), ['<thought>独白</thought>', '尾巴'])
  assert.deepEqual(f.flush(), [])
})

test('正常文本里的 "<" 不该被永久扣住', () => {
  const f = createThoughtFilter()
  const out = [...f.feed('比较 a<b 时'), ...f.flush()]
  assert.equal(out.join(''), '比较 a<b 时')
})

test('孤立闭合标签直接删除', () => {
  assert.equal(sanitizeText('甲</thought>乙'), '甲乙')
})

test('逐字符喂与一次性喂结果一致', () => {
  const cases = [
    '<thought>x 独白 y 正文',
    '<thinking> </thinking>没有那种东西',
    '甲<thought>a</thought>乙',
    `甲<thinking>${LONG}</thinking>乙`,
    '纯正文，没有标签'
  ]
  for (const c of cases) assert.equal(feedByChar(c), sanitizeText(c))
})
