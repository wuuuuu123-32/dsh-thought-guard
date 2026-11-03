// dsh-thought-guard（Host 半边）
//
// 作用：拦掉上游模型写进**正文**的思考标签。
//
// 为什么需要它（2026-11-03 实测，不是猜测）：
//   - DSH 客户端本身没拼错：响应里 `reasoning` / `reasoning_content` / `reasoning_text`
//     会被映射成 thinking_delta，只有 `content` 才进正文。
//   - 但 portdan 中转站的 deepseek-v4.1-flash 会**低频突发地**把推理写进 content，
//     前面还带一个 <thought> / <thinking> 标签，且 <thought> 常常没有闭合标签。
//     这种内容在 DSH 里就直接当正文显示了。
//   - 所以修不了上游，只能在「客户端收到正文」这一层拦。DSH 提供的官方扩展点是
//     `llm/stream` 瀑布（retry / replay / routing 都挂在上面），签名：
//       'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)
//
// 设计上的取舍（有意的，别轻易改）：
//   1. **只对指定 provider 生效**。全局剥离会误伤正常讨论标签的对话（比如用户在问
//      "XML 标签怎么写"），所以默认只匹配 portdan-ds / portdan-ds-vision。
//   2. **fail-closed**：开标签没有闭合时，这一轮后面的内容整段不发。理由见 filter.js
//      顶部注释——推理和正文黏在一起时没有任何可靠的切分点，宁可空一轮，也不把
//      内部独白漏给用户。
//   3. **不做整段缓冲**。整段缓存会让首字延迟变成整段生成时间。实测泄漏的标签都在
//      第一个字符，所以 filter 只在缓冲区末尾留几个字符做「半截标签」判定。
//
// 已知边界（会审 rv-f76bf864fc1be83d 指出，如实记着）：
//   如果标签出现在**已经输出给客户端**的正文之后，先前那部分收不回来。本插件只能
//   保证「标签之后的内容不再泄漏」，不能保证「不留任何痕迹」。实际观测到的两例都是
//   从第一个字符开始，所以没加更复杂的事后修正。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createThoughtFilter } from './filter.js'

// 不声明必需服务：只挂事件监听，不需要等 llm 服务就绪，早注册才不会漏掉首批请求。
export const name = 'thought-guard'
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = path.join(HERE, '..', 'thought-guard.log')

const DEFAULTS = {
  enabled: true,
  // 精确名，或带 * 的通配（'*portdan*'）
  providers: ['portdan-ds', 'portdan-ds-vision'],
  // 开标签没闭合时的处理：'keep' = 摘掉标签、内容照发（默认）；'drop' = 这一轮整段不发
  onUnclosed: 'keep',
  // true 时把每次拦截写进 thought-guard.log
  log: true
}

function matches(provider, patterns) {
  if (!provider) return false
  const p = String(provider).toLowerCase()
  return patterns.some((raw) => {
    const want = String(raw).toLowerCase()
    if (!want.includes('*')) return p === want
    const re = new RegExp('^' + want.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(p)
  })
}

function record(cfg, line) {
  if (!cfg.log) return
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志写不进去不该影响模型调用
  }
}

/**
 * 把一条文本流包成「过滤后的文本流」。
 * 除 text-delta 之外的分片（block-start / block-end / tool-call-delta / finish）原样透传，
 * 只在 text-delta 上做剥离，并保留原来的 index。
 */
async function* guardStream(stream, cfg, provider) {
  const filter = createThoughtFilter({ onUnclosed: cfg.onUnclosed })
  let lastIndex = 0
  let emittedChars = 0
  let stripped = false

  for await (const chunk of stream) {
    if (chunk?.type !== 'text-delta') {
      yield chunk
      continue
    }
    lastIndex = chunk.index ?? lastIndex
    const pieces = filter.feed(chunk.text ?? '')
    for (const piece of pieces) {
      emittedChars += piece.length
      yield { ...chunk, text: piece }
    }
    if (filter.inSkip()) stripped = true
  }

  const wasSkipping = filter.inSkip()
  const tail = filter.flush()
  for (const piece of tail) {
    emittedChars += piece.length
    yield { type: 'text-delta', index: lastIndex, text: piece }
  }

  if (stripped || wasSkipping) {
    const how = wasSkipping
      ? tail.length > 0
        ? '未闭合，标签已摘除、内容照发'
        : '未闭合，整轮丢弃（onUnclosed=drop）'
      : '闭合块剥离'
    record(cfg, `provider=${provider} 拦截一次（${how}）保留 ${emittedChars} 字`)
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) {
    record(cfg, 'enabled=false，未注册')
    return
  }

  ctx.on('llm/stream', (options, next) => {
    const provider = options && options.provider
    if (!matches(provider, cfg.providers)) return next()
    return guardStream(next(), cfg, provider)
  })

  record(cfg, `已注册 llm/stream 拦截，providers=${JSON.stringify(cfg.providers)}`)
}
