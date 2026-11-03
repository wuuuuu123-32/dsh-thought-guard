# dsh-thought-guard

拦掉中转站模型写进**正文**的思考标签：`<thought>` / `<thinking>`。

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 cordis 插件，注册在 `llm/stream` 瀑布上，只对指定 provider 生效。

## 它解决什么问题

2026-11-03 实测：portdan 中转站的 `deepseek-v4.1-flash` 绝大多数时候把推理放在 `reasoning_content` 这个独立字段里（DSH 会正常渲染成思考块，不进正文）。但它会**低频突发地**把推理直接写进 `content`，前面还带一个标签，而且 `<thought>` 常常**没有闭合标签**——推理和正文黏在同一个字符串里：

```
<thought>那个「这是别人做的」是在回应我上一条。 改口：那跟我叫什么名字没关系，是别人起的。 哦 那是别人起的
```

`content` 是唯一会被当正文显示的字段，所以这段内心独白就直接出现在对话里了。

DSH 客户端没有解析错误。问题在上游，改不了上游，只能在「客户端收到正文」这一层拦。

## 怎么拦

DSH 提供官方扩展点 `llm/stream` 瀑布（retry / replay / routing 都挂在上面）：

```ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

本插件包住返回的流，只动 `text-delta` 分片，其余分片（`block-start` / `block-end` / `tool-call-delta` / `finish`）原样透传：

1. **闭合的标签块**（`<thought>…</thought>`、`<thinking>…</thinking>`）整段删掉，两边文字保留——但只在两种情况下删：
   - 块出现在**整条回复的开头**（实测两例泄漏都在第 0 个字符）；
   - 或者块内容很长（默认 ≥ 200 字，`midMin` 可调）。

   其余情况（正文中段的短块）当作**引用**原样保留。因为讲这个插件、贴代码、举例子时，正常回答里就会出现这些标签，无条件删除会把用户真正想看的字吃掉。这是「偶尔漏一点」与「删错正文」之间的取舍。
2. **开标签没有闭合** → 默认只摘掉标签本身，后面的内容**照发**（`onUnclosed: 'keep'`）。
   - 为什么不整段丢弃：2026-11-03 用户拍板——「如果会出现空回复，那还不如发出来」。空回复的伤害比偶尔漏一段独白大。
   - 想要严格模式就把 `onUnclosed` 设成 `'drop'`：这一轮后面的内容整段不发。
   - 两种模式都不做「按标点切尾」：推理和正文黏在一起时没有可靠分界点，切出来的尾巴可能仍是推理。
3. **标签被流式切断**（`"<thou"` + `"ght>"`、`"</thin"` + `"king>"`）时靠尾部缓冲跨 chunk 判定。
4. **剥离后整条回复变空**时，把最后剥掉的那段内容放回去——同样是为了不让你收到空消息。

### 为什么不缓存整段再过滤

缓存整段会让首字延迟变成整段生成时间，等于把流式输出废掉。实测的泄漏标签都出现在**第一个字符**，所以只在缓冲区末尾留几个字符做「半截标签」判定就够了。

## 已知边界

- 认得出标签、但**标签之前的正文已经流出去**了：那部分收不回来，本插件只能保证标签处之后不再泄漏。
- 中段的短标签块会被当成引用保留（见上），所以那种位置的泄漏会漏过去。这是刻意的，为了不删错正文。
- 只覆盖能识别的 `<thought>` / `<thinking>`。上游换标签名、或者干脆不带标签地把推理写进正文，本插件无能为力。
- 未闭合时默认放行，所以那一轮**可能仍带着一段内心独白**（只是没有标签）。这是用户明确选的权衡：宁可看到带独白的回复，也不要空回复。
- 只处理文本分片。`tool-call-delta` 里若带标签不会被动，但工具参数不会直接显示给用户。
- 不保证「回复一定非空」之外的完整性：`drop` 模式会丢掉未闭合标签后面的内容。

## 安装

```powershell
D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:D:/dsh/config/dsh-thought-guard
```

然后**重启 DSH**（插件在启动时注册监听）。

## 配置

默认只匹配 `portdan-ds` 和 `portdan-ds-vision`（`portdan-ds-vision` 是 vision-router 生成的孪生 provider）。
要改就在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里给这一条加 `config`：

```yaml
- id: thought-guard
  config:
    providers: ['*portdan*', 'some-other-provider']
    onUnclosed: 'keep'
    log: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不挂监听 |
| `providers` | `['portdan-ds', 'portdan-ds-vision']` | 精确名或带 `*` 的通配；大小写不敏感 |
| `onUnclosed` | `'keep'` | 未闭合时的处理：`keep` 摘标签放行；`drop` 整轮不发 |
| `midMin` | `200` | 出现在回复中段的闭合块，内容至少这么长才判定为泄漏；更短的当作正文引用原样保留 |
| `log` | `true` | 每次拦截往插件目录的 `thought-guard.log` 追一行 |

## 验证

```powershell
# 1) 单测（纯逻辑，不需要 DSH）
node --test test/filter.test.mjs

# 2) 插件是否挂上（重启后看日志第十二行附近）
Get-Content C:\Users\123\.dsh\profiles\desktop\node_modules\dsh-thought-guard\thought-guard.log -Tail 5

# 3) 真打一次带标签的合成流
node -e "import('./lib/filter.js').then(m=>console.log(JSON.stringify(m.sanitizeText('<thought>独白 正文'))))"
```

## 卸载

```powershell
D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop remove dsh-thought-guard
```

## 许可

MIT
