/**
 * 时间线 → DSH v4 会话事件。
 *
 * 布局要点（照着 DSH 自己产出的 v4 会话对齐，不是猜的）：
 *
 *   turn/start
 *   step/start        ← 必须早于 user/message
 *   user/message      ← 用户输入与「首次模型响应」同属 step 1
 *   assistant/message ← surfaceOp: append
 *   tool/call         ← 无 surfaceOp（只驱动轨迹视图）
 *   tool/result       ← surfaceOp: append，带 sourceEventSeqs 指向对应 tool/call
 *   step/end
 *   step/start        ← 后续工具循环逐步递增
 *   …
 *   turn/end
 *
 * 如果按「一条 assistant 消息一个新 step」写，validator 会拒：
 *   format v2 surface before first step cannot acquire a system head
 * 因为 user/message 落到了所有 step 之外。
 */

/** 内容块的序列化体积上限（防御超大工具结果撑爆单批写入）。 */
const DEFAULT_TOOL_LIMIT = 0

/**
 * @param timeline - workbuddy-reader 输出的时间线
 * @param results - Map<callId, {text, isError}>
 * @param options - { title, cwd, toolTruncate, noTools }
 * @returns 事件数组（seq 由调用方补）
 */
export function buildDshEvents(timeline, results, options = {}) {
  const events = []
  let turn = 0
  let step = 0
  let openTurn = false
  let openStep = false
  let stepHasAssistant = false
  let lastTime = 0
  let firstUserSeq
  const cwd = options.cwd

  /** 时间戳必须非递减，否则回放时顺序会错乱。 */
  const atLeast = (time) => {
    if (time > lastTime) lastTime = time
    return lastTime
  }

  const push = (type, time, data, surfaceOp) => {
    events.push({ type, time: atLeast(time), data, ...(surfaceOp ? { surfaceOp } : {}) })
    return events.length - 1
  }

  const closeStep = (time) => {
    if (!openStep) return
    push('step/end', time, { turn, step })
    openStep = false
  }

  const closeTurn = (time) => {
    if (!openTurn) return
    closeStep(time)
    push('turn/end', time, { turn, reason: { kind: 'completed' } })
    openTurn = false
  }

  const clip = (text) => {
    const max = options.toolTruncate
    if (!Number.isSafeInteger(max) || max <= 0) return text
    if (text.length <= max) return text
    return `${sliceSafe(text, max)}\n…[已截断，原长 ${text.length} 字符]`
  }

  for (const node of timeline) {
    if (node.kind === 'user') {
      closeTurn(node.time)
      turn += 1
      step = 1
      openTurn = true
      stepHasAssistant = false
      push('turn/start', node.time, { turn })
      push('step/start', node.time, { turn, step })
      openStep = true
      const seq = push('user/message', node.time, {
        role: 'user',
        source: { kind: 'user', rpcId: randomId() },
        content: node.blocks,
        id: randomId(),
      }, 'append')
      if (firstUserSeq === undefined) firstUserSeq = seq
      continue
    }

    // 助手 step 分组
    if (node.blocks.length === 0) continue

    if (!openTurn) {
      // 会话以助手消息开头（无用户输入）时的兜底
      turn += 1
      step = 1
      openTurn = true
      stepHasAssistant = false
      push('turn/start', node.time, { turn })
      push('step/start', node.time, { turn, step })
      openStep = true
    } else if (stepHasAssistant) {
      closeStep(node.time)
      step += 1
      push('step/start', node.time, { turn, step })
      openStep = true
    }

    let blocks = node.blocks
    if (options.noTools === true) {
      blocks = blocks.filter(block => block.type !== 'tool-call')
      if (blocks.length === 0) {
        // 这个 step 只有工具调用。若本 step 已有助手内容才收尾；
        // 否则保持 step 打开，让下一个有内容的组复用同一个 step ——
        // 否则会把「user/message 所在的那个 step」关掉，后续事件就落到没有 step 的位置。
        if (stepHasAssistant) closeStep(node.time)
        continue
      }
    }

    push('assistant/message', node.time, {
      turn,
      step,
      message: {
        role: 'assistant',
        content: blocks,
        source: {
          kind: 'model',
          provider: 'workbuddy',
          model: typeof node.provider === 'string' && node.provider.length > 0 ? node.provider : 'unknown',
        },
        id: randomId(),
      },
    }, 'append')
    stepHasAssistant = true

    if (options.noTools !== true) {
      for (const call of node.calls) {
        const block = node.blocks.find(item => item.type === 'tool-call' && item.id === call.callId)
        const callSeq = push('tool/call', node.time, {
          turn,
          step,
          callId: call.callId,
          name: call.name,
          arguments: block?.arguments ?? '{}',
        })
        const result = results.get(call.callId)
        push('tool/result', node.time, {
          turn,
          step,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: call.callId },
            toolCallId: call.callId,
            content: [{ type: 'text', text: clip(result?.text ?? '') }],
            isError: result?.isError === true,
            id: randomId(),
          },
          ...(cwd !== undefined ? { meta: { cwd } } : {}),
        }, 'append')
        events[events.length - 1].sourceEventSeqs = [callSeq]
      }
    }

    closeStep(node.time)
  }

  closeTurn(lastTime)

  if (typeof options.title === 'string' && options.title.length > 0) {
    push('session/title', lastTime, {
      title: options.title,
      messageSeqs: firstUserSeq !== undefined ? [firstUserSeq] : [],
      source: { kind: 'fallback' },
    })
  }

  return events
}

/**
 * 推导导入标题。优先用 WorkBuddy 的 ai-title，缺失时退回首条用户消息。
 * @param sourceTitle - ai-title 文本
 * @param timeline - 时间线
 * @returns 规范化标题，或 undefined
 */
export function deriveTitle(sourceTitle, timeline) {
  const clean = (text) => sliceSafe(text.replace(/\s+/gu, ' ').trim(), 80)
  let title
  if (typeof sourceTitle === 'string') {
    const candidate = clean(sourceTitle)
    if (candidate.length > 0) title = candidate
  }
  if (title === undefined) {
    const firstUser = timeline.find(node => node.kind === 'user')
    if (firstUser !== undefined) {
      const text = firstUser.blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ')
      const candidate = clean(text)
      if (candidate.length > 0) title = candidate
    }
  }
  return title
}

/** 事件统计，供命令输出摘要。 */
export function summarizeEvents(events) {
  const counts = { turns: 0, steps: 0, userMsgs: 0, asstMsgs: 0, calls: 0, results: 0, reasoning: 0 }
  let resultChars = 0
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': counts.turns++; break
      case 'user/message': counts.userMsgs++; break
      case 'assistant/message': {
        counts.asstMsgs++
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') counts.reasoning++
        }
        break
      }
      case 'tool/call': counts.calls++; break
      case 'tool/result': {
        counts.results++
        resultChars += event.data.message.content?.[0]?.text?.length ?? 0
        break
      }
      default: break
    }
  }
  return { ...counts, resultChars }
}

/**
 * 按 UTF-16 边界安全截断：不把代理对（emoji 等）切成孤立半个。
 * 孤立代理会让 JSON 里出现裸 \ud83d，部分读取端会拒绝或显示乱码。
 */
function sliceSafe(text, max) {
  if (text.length <= max) return text
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return text.slice(0, end)
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `wb-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export { DEFAULT_TOOL_LIMIT }
