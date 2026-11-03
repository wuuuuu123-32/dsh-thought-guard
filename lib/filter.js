// 过滤器的纯逻辑层：不依赖 DSH，可单独 node --test。
//
// 要解决的问题（2026-11-03 实测）：
//   portdan 中转站的 deepseek-v4.1-flash 绝大多数时候把推理放在 reasoning_content
//   （独立字段，DSH 会渲染成思考块），但低频突发地会把推理写进 content，并在前面
//   加一个 <thought> / <thinking> 标签；<thought> 这种还经常**没有闭合标签**，
//   推理与正文黏在同一个字符串里：
//     `<thought>那个「这是别人做的」是在回应我上一条。 改口：…… 哦 那是别人起的`
//
// 处理口径：
//   1. 闭合的 <thought>…</thought> / <thinking>…</thinking> 整块删掉，两边文字保留。
//      这种是**确定**的：标签成对出现，中间那段一定是内心独白。
//   2. 开标签始终不闭合 → 默认**放出去**（onUnclosed='keep'），只把标签本身摘掉，
//      后面的内容原样保留。理由见下。
//   3. 标签是流式切开的（"<thou" + "ght>"、或 "</thin" + "king>"），必须跨 chunk 缓冲。
//
// 为什么未闭合时默认放出来（2026-11-03 用户拍板）：
//   最初选的是 fail-closed（整轮不发），理由是「推理和正文分不干净，宁可空一轮也不
//   漏内心独白」。用户原话：「如果会出现空回复，那还不如发出来」——空回复对使用者的
//   伤害比偶尔漏一段独白更大。所以默认改成 keep：标签摘掉、内容照发，至少看得到回复。
//   想要旧的严格模式，把 onUnclosed 设成 'drop'。
//
// 为什么不缓存整段再输出：缓存整段等于把流式输出废掉，首字延迟会变成整段生成时间。
// 实测两例泄漏的标签都在**第一个字符**，所以只在开头留很短的尾巴做判定就够了。

const TAGS = ['thought', 'thinking']
const LONGEST_OPEN = Math.max(...TAGS.map((t) => t.length + 1)) // '<thinking' = 9
const LONGEST_CLOSE = Math.max(...TAGS.map((t) => t.length + 3)) // '</thinking>' = 11
// skip 期间最多憋这么多字符；超了就当成未闭合直接放出去，避免一整轮都卡在缓冲区里。
const MAX_SKIP = 512 * 1024

const OPEN_ANY = /<(thought|thinking)\b/i
const OPEN_FULL = /<(thought|thinking)\b[^>]*>/i
const CLOSE_FULL = /<\/(thought|thinking)\s*>/i
const STRAY_CLOSE = /<\/(thought|thinking)\s*>/gi

/** 判断 s 是不是某个开标签的前缀（含 '<'、'<th'、'<thinkin' 这些半截状态）。 */
function isOpenPrefix(s) {
  return TAGS.some((t) => `<${t}`.startsWith(s))
}

/**
 * 缓冲区末尾有多长一段可能是「被切断的开标签」。
 * 返回 0 表示末尾不可能是半截标签，可以放心输出。
 */
function openTailLength(buf) {
  const limit = Math.min(buf.length, LONGEST_OPEN)
  let best = 0
  for (let k = 1; k <= limit; k += 1) {
    if (isOpenPrefix(buf.slice(-k))) best = k
  }
  return best
}

export function createThoughtFilter(options = {}) {
  const onUnclosed = options.onUnclosed === 'drop' ? 'drop' : 'keep'
  let state = 'pass' // 'pass' | 'skip'
  let buf = ''
  let skipBuf = '' // skip 期间攒下的内容（keep 模式下最后可能要放出去）

  /**
   * 吃一段文字，返回这次可以立刻输出的片段（可能 0 段）。
   * final=true 表示流结束，要把残留也结算掉。
   */
  function feed(text, final = false) {
    buf += text
    const out = []

    for (;;) {
      if (state === 'skip') {
        skipBuf += buf
        buf = ''

        const m = CLOSE_FULL.exec(skipBuf)
        if (m) {
          // 成对标签：中间那段确定是内心独白，丢掉，后面的接着走
          buf = skipBuf.slice(m.index + m[0].length)
          skipBuf = ''
          state = 'pass'
          continue
        }
        if (final) {
          // 到死都没闭合：默认把攒下的内容放出去（只丢了标签本身），drop 模式才整段丢
          if (onUnclosed === 'keep' && skipBuf) out.push(skipBuf)
          skipBuf = ''
          return out
        }
        if (skipBuf.length > MAX_SKIP) {
          // 憋太久了，别赌了：当成未闭合处理
          out.push(skipBuf)
          skipBuf = ''
          state = 'pass'
          continue
        }
        return out
      }

      // ---- state === 'pass' ----
      // 顺序不能反：必须**先**找开标签，再删孤立闭合标签。
      // 否则 '<thought>独白</thought>尾巴' 会先被删成 '<thought>独白尾巴'，
      // 开标签就永远等不到闭合，整段被 fail-closed 吞掉（2026-11-03 单测抓到的 bug）。
      const openFull = OPEN_FULL.exec(buf)
      if (openFull) {
        const head = buf.slice(0, openFull.index).replace(STRAY_CLOSE, '')
        if (head) out.push(head)
        buf = buf.slice(openFull.index + openFull[0].length)
        state = 'skip'
        continue
      }

      const openAny = OPEN_ANY.exec(buf)
      if (openAny) {
        // 有 "<thought" / "<thinking" 但还没等到 ">"：只可能出现在缓冲区末尾
        const head = buf.slice(0, openAny.index).replace(STRAY_CLOSE, '')
        if (head) out.push(head)
        buf = buf.slice(openAny.index)
        return out
      }

      buf = buf.replace(STRAY_CLOSE, '') // 孤立的闭合标签直接删
      const tail = openTailLength(buf)
      if (tail > 0) {
        if (final) {
          // 流都结束了，末尾那半截就是普通文字，别再扣着
          if (buf) out.push(buf)
          buf = ''
          return out
        }
        if (buf.length > tail) out.push(buf.slice(0, buf.length - tail))
        buf = buf.slice(-tail)
        return out
      }

      if (buf) out.push(buf)
      buf = ''
      return out
    }
  }

  /** 流结束时调用：返回还欠着的输出（fail-closed 时通常为空）。 */
  function flush() {
    return feed('', true)
  }

  /** 当前是否处在「正在丢弃思考块」的状态，供 index.js 打日志用。 */
  function inSkip() {
    return state === 'skip'
  }

  return { feed, flush, inSkip }
}

/**
 * 把字符串一次性过一遍过滤器（测试与离线校验用，不走流）。
 * 未闭合的开标签默认放出来（keep）；传 { onUnclosed: 'drop' } 则整段丢弃。
 */
export function sanitizeText(text, options = {}) {
  const f = createThoughtFilter(options)
  const parts = [...f.feed(text), ...f.flush()]
  return parts.join('')
}
