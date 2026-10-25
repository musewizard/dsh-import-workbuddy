/**
 * 结构校验器：把生成的事件序列当状态机走一遍，检查 DSH v4 的布局约束。
 *
 * 这些约束来自 DSH 自己的 validator 行为（踩过才知道）：
 *  - user/message、assistant/message、tool/result 必须落在已打开的 step 内
 *  - step/start 必须先于该 step 的第一个 user/message
 *  - turn/end 时不能有未关闭的 step
 *  - 每个 tool/call 必须有配对的 tool/result，且 result 的 toolCallId 一致
 *  - seq 连续、time 非递减
 *
 * @param events - [{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }]
 * @returns 问题描述数组（空数组表示通过）
 */
export function validateEventSequence(events) {
  const problems = []
  let turnOpen = false
  let stepOpen = false
  let currentTurn = 0
  let currentStep = 0
  let lastTime = -Infinity
  const openCalls = new Set()

  const needStep = (event) => {
    if (!stepOpen) problems.push(`seq ${event.seq}: ${event.type} 落在没有打开的 step 里`)
  }

  for (const [index, event] of events.entries()) {
    if (event.seq !== index) problems.push(`seq 不连续：第 ${index} 个事件 seq=${event.seq}`)
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
      problems.push(`seq ${event.seq}: time 不是有限数字`)
    } else {
      if (event.time < lastTime) problems.push(`seq ${event.seq}: time 回退（${event.time} < ${lastTime}）`)
      lastTime = Math.max(lastTime, event.time)
    }

    switch (event.type) {
      case 'turn/start': {
        if (turnOpen) problems.push(`seq ${event.seq}: turn/start 时上一个 turn 还没结束`)
        turnOpen = true
        currentTurn = event.data.turn
        break
      }
      case 'step/start': {
        if (!turnOpen) problems.push(`seq ${event.seq}: step/start 在 turn 之外`)
        if (stepOpen) problems.push(`seq ${event.seq}: step/start 时上一个 step 还没结束`)
        stepOpen = true
        currentStep = event.data.step
        if (event.data.turn !== currentTurn) problems.push(`seq ${event.seq}: step 的 turn 与当前 turn 不一致`)
        break
      }
      case 'step/end': {
        if (!stepOpen) problems.push(`seq ${event.seq}: step/end 时没有打开的 step`)
        stepOpen = false
        break
      }
      case 'turn/end': {
        if (!turnOpen) problems.push(`seq ${event.seq}: turn/end 时没有打开的 turn`)
        if (stepOpen) problems.push(`seq ${event.seq}: turn/end 时还有未关闭的 step`)
        turnOpen = false
        break
      }
      case 'user/message': {
        needStep(event)
        if (event.data.role !== 'user') problems.push(`seq ${event.seq}: user/message 的 role 不是 user`)
        break
      }
      case 'assistant/message': {
        needStep(event)
        const content = event.data.message?.content
        if (!Array.isArray(content) || content.length === 0) {
          problems.push(`seq ${event.seq}: assistant/message 的 content 为空`)
        }
        if (event.data.turn !== currentTurn || event.data.step !== currentStep) {
          problems.push(`seq ${event.seq}: assistant/message 的 turn/step 与当前位置不符`)
        }
        break
      }
      case 'tool/call': {
        needStep(event)
        openCalls.add(event.data.callId)
        break
      }
      case 'tool/result': {
        needStep(event)
        const callId = event.data.message?.toolCallId
        if (!openCalls.has(callId)) problems.push(`seq ${event.seq}: tool/result 找不到配对的 tool/call (${callId})`)
        openCalls.delete(callId)
        if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
          problems.push(`seq ${event.seq}: tool/result 缺少 sourceEventSeqs`)
        }
        break
      }
      default:
        break
    }
  }

  if (turnOpen) problems.push('序列结束时还有未关闭的 turn')
  if (stepOpen) problems.push('序列结束时还有未关闭的 step')
  if (openCalls.size > 0) problems.push(`有 ${openCalls.size} 个 tool/call 没有对应的 tool/result`)

  return problems
}
