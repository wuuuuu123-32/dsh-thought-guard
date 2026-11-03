import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

/** 建一个假的 cordis ctx，把注册进来的 llm/stream 监听器抓出来。 */
function mount(config) {
  const listeners = {}
  const ctx = { on: (event, fn) => { listeners[event] = fn } }
  apply(ctx, { log: false, ...config })
  assert.ok(listeners['llm/stream'], '应当注册 llm/stream 监听器')
  return listeners['llm/stream']
}

async function collect(iterable) {
  const out = []
  for await (const c of iterable) out.push(c)
  return out
}

/** 模拟一次真实流：block-start → 若干 text-delta → block-end。 */
function fakeStream(pieces) {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const text of pieces) yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') } }
    yield { type: 'finish' }
  }
}

test('非目标 provider 原样透传，一个字都不动', async () => {
  const on = mount()
  const pieces = ['<thought>这不是我们的活</thought>正文']
  const chunks = await collect(on({ provider: 'gpt-6.1-sol' }, fakeStream(pieces)))
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), pieces[0])
})

test('目标 provider：闭合块被剥离，其余分片透传', async () => {
  const on = mount()
  const chunks = await collect(
    on({ provider: 'portdan-ds' }, fakeStream(['<thinking>内心</thinking>', '答案']))
  )
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '答案')
  // 非 text 分片一个不少
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'text-delta', 'block-end', 'finish']
  )
})

test('目标 provider：未闭合默认保留内容、只摘标签（keep）', async () => {
  const on = mount()
  const chunks = await collect(
    on({ provider: 'portdan-ds-vision' }, fakeStream(['<thought>独白 还有正文']))
  )
  assert.equal(
    chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    '独白 还有正文'
  )
})

test('配了 onUnclosed=drop 才整轮丢弃', async () => {
  const on = mount({ onUnclosed: 'drop' })
  const chunks = await collect(
    on({ provider: 'portdan-ds-vision' }, fakeStream(['<thought>独白 还有正文']))
  )
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 0)
  // 结构分片仍在，客户端不会因为缺帧卡住
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'block-end', 'finish']
  )
})

test('通配配置能匹配孪生 provider', async () => {
  const on = mount({ providers: ['*portdan*'] })
  const chunks = await collect(on({ provider: 'portdan-ds-vision' }, fakeStream(['<thought>独白'])))
  assert.equal(
    chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    '独白'
  )
})

test('enabled=false 时完全不注册', () => {
  const listeners = {}
  apply({ on: (e, fn) => { listeners[e] = fn } }, { enabled: false, log: false })
  assert.equal(listeners['llm/stream'], undefined)
})
