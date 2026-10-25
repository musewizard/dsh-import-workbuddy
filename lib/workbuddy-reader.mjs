/**
 * WorkBuddy / CodeBuddy 会话读取器。
 *
 * 数据源：<workbuddyRoot>/<project-slug>/<sessionId>.jsonl
 * 每行一个事件，type 为：
 *   session-meta | message | reasoning | function_call | function_call_result
 *   | ai-title | file-history-snapshot
 *
 * 归一化成一条「时间线」：用户消息节点 + 助手 step 节点（按 providerData.stepSeq 分组），
 * 工具结果按 callId 单独索引。转换层（convert.mjs）再把时间线折叠成 DSH 事件。
 *
 * 与 claude-code / codex 等来源的关键差异：WorkBuddy 的 function_call_result
 * 保存了**完整工具输出**，因此这里不做占位符降级。
 */

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const SYSTEM_REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/gu
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/u

/**
 * 用户主目录。
 * 优先环境变量，最后回退 os.homedir()（Windows 上它还会查注册表，
 * 即使 USERPROFILE 被清空也能拿到，避免退化成相对路径）。
 */
export function homeDir() {
  const fromEnv = process.env.USERPROFILE || process.env.HOME
  if (fromEnv) return fromEnv
  try {
    return homedir() || ''
  } catch {
    return ''
  }
}

/**
 * WorkBuddy 会话根目录的候选位置（按优先级）。
 * WorkBuddy 的数据目录固定在用户级，与它装在哪块盘无关；
 * 但不同版本/便携包可能落在不同子目录，所以这里探测多个候选。
 */
export function workbuddyRootCandidates() {
  const home = homeDir()
  const candidates = []
  if (process.env.WORKBUDDY_HOME) candidates.push(join(process.env.WORKBUDDY_HOME, 'projects'))
  if (home) candidates.push(join(home, '.workbuddy-ai', 'projects'))
  if (home) candidates.push(join(home, '.workbuddy', 'projects'))
  // macOS / Linux 上的常见落点（不存在会被 existsSync 过滤掉，代价为零）
  if (home) candidates.push(join(home, 'Library', 'Application Support', 'WorkBuddy', 'projects'))
  if (home) candidates.push(join(home, '.config', 'workbuddy', 'projects'))
  if (home) candidates.push(join(home, '.local', 'share', 'workbuddy', 'projects'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'WorkBuddy', 'projects'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'workbuddy-ai', 'projects'))
  return candidates
}

/**
 * 解析实际要用的会话根目录：显式配置 > 第一个存在的候选 > 标准路径（便于报错时显示）。
 */
export function resolveWorkbuddyRoot(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const candidates = workbuddyRootCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? join(homeDir(), '.workbuddy-ai', 'projects')
}

/** WorkBuddy 默认会话根目录（标准位置，不做存在性探测）。 */
export function defaultWorkbuddyRoot() {
  return join(homeDir(), '.workbuddy-ai', 'projects')
}

/**
 * 剥离 WorkBuddy 注入的 system-reminder 与包装标签，只留用户真实输入。
 * 原始输入通常长这样：
 *   <system-reminder data-role="user-context">…</system-reminder>
 *   <user_query>真正的问题</user_query>
 */
export function cleanUserText(text) {
  if (typeof text !== 'string') return ''
  const matched = USER_QUERY.exec(text)
  if (matched !== null) return matched[1].trim()
  return text.replace(SYSTEM_REMINDER, '').trim()
}

/**
 * 枚举会话文件。
 * @param root - WorkBuddy projects 根目录
 * @returns [{ file, project, id, size, mtimeMs }]，按 mtime 倒序
 */
export function listWorkbuddySessions(root) {
  const out = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = join(dir, entry.name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      out.push({
        file,
        project: project.name,
        id: basename(entry.name, '.jsonl'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 解析一条 WorkBuddy 会话。
 * @param file - .jsonl 绝对路径
 * @returns { header, timeline, results, stats }
 *   header   { id, cwd, title, createdAt, updatedAt }
 *   timeline [{ kind:'user', time, blocks } | { kind:'step', stepSeq, time, blocks, calls, provider }]
 *   results  Map<callId, { text, isError }>
 *   stats    { rawEvents, skippedMeta, skippedSnapshot, skippedEmpty }
 */
export function parseWorkbuddySession(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 ${file}: ${error.message}`)
  }
  // 去掉 UTF-8 BOM：否则第一行 JSON.parse 失败，静默丢掉首条事件
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)

  const timeline = []
  const results = new Map()
  const stats = { rawEvents: 0, skippedMeta: 0, skippedSnapshot: 0, skippedEmpty: 0 }
  let sessionId
  let cwd
  let title
  let createdAt
  let updatedAt
  let lastStep = null

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // 尾行可能被截断，跳过即可
      continue
    }
    stats.rawEvents++

    if (typeof event.sessionId === 'string' && sessionId === undefined) sessionId = event.sessionId
    if (typeof event.cwd === 'string' && cwd === undefined) cwd = event.cwd
    if (typeof event.timestamp === 'number') {
      if (createdAt === undefined || event.timestamp < createdAt) createdAt = event.timestamp
      if (updatedAt === undefined || event.timestamp > updatedAt) updatedAt = event.timestamp
    }

    switch (event.type) {
      case 'ai-title':
        if (typeof event.aiTitle === 'string' && event.aiTitle.length > 0) title = event.aiTitle
        break

      case 'session-meta':
        stats.skippedMeta++
        break

      case 'file-history-snapshot':
        stats.skippedSnapshot++
        break

      case 'message': {
        const time = timeOf(event, createdAt)
        if (event.role === 'user') {
          const blocks = []
          for (const block of event.content ?? []) {
            if (block?.type === 'input_text') {
              const text = cleanUserText(block.text)
              if (text.length > 0) blocks.push({ type: 'text', text })
            } else if (block?.type === 'input_image') {
              // DSH 的持久化 content 块没有 image 类型，图片无法原样迁移。
              // 这里留一条可读占位（含原文件名/大小/blob 路径），避免静默丢失。
              blocks.push({ type: 'text', text: imagePlaceholder(block) })
            }
          }
          if (blocks.length === 0) {
            stats.skippedEmpty++
            break
          }
          timeline.push({ kind: 'user', time, blocks })
          lastStep = null
        } else {
          const pd = event.providerData ?? {}
          const group = stepGroup(pd.stepSeq, time, pd)
          for (const block of event.content ?? []) {
            if (block?.type === 'output_text' && typeof block.text === 'string' && block.text.length > 0) {
              group.blocks.push({ type: 'text', text: block.text })
            }
          }
        }
        break
      }

      case 'reasoning': {
        const pd = event.providerData ?? {}
        const group = stepGroup(pd.stepSeq, timeOf(event, createdAt), pd)
        const source = Array.isArray(event.rawContent) ? event.rawContent : (event.content ?? [])
        for (const block of source) {
          if (block?.type !== 'reasoning_text') continue
          if (typeof block.text === 'string' && block.text.length > 0) {
            group.blocks.push({ type: 'reasoning', text: block.text })
          }
        }
        break
      }

      case 'function_call': {
        const pd = event.providerData ?? {}
        const group = stepGroup(pd.stepSeq, timeOf(event, createdAt), pd)
        const callId = typeof event.callId === 'string' && event.callId.length > 0
          ? event.callId
          : `wb-call-${randomId()}`
        const args = typeof event.arguments === 'string'
          ? event.arguments
          : JSON.stringify(event.arguments ?? {})
        group.blocks.push({
          type: 'tool-call',
          id: callId,
          name: String(event.name ?? 'tool'),
          arguments: args,
        })
        group.calls.push({ callId, name: String(event.name ?? 'tool') })
        break
      }

      case 'function_call_result': {
        if (typeof event.callId !== 'string') break
        results.set(event.callId, {
          text: outputText(event.output),
          isError: event.status !== undefined && event.status !== 'completed',
        })
        break
      }

      default:
        break
    }
  }

  /**
   * 复用或新建一个 step 分组。stepSeq 单调递增，因此只需和上一个比较；
   * 缺少 stepSeq 的事件归入当前分组（或新建 0 号分组）。
   */
  function stepGroup(rawStepSeq, time, pd) {
    const stepSeq = Number.isSafeInteger(rawStepSeq) ? rawStepSeq : 0
    if (lastStep !== null && lastStep.stepSeq === stepSeq) {
      if (time < lastStep.time) lastStep.time = time
      return lastStep
    }
    const group = {
      kind: 'step',
      stepSeq,
      time,
      blocks: [],
      calls: [],
      provider: pd.model ?? pd.requestModelId,
    }
    timeline.push(group)
    lastStep = group
    return group
  }

  return {
    header: {
      id: sessionId ?? basename(file, '.jsonl'),
      cwd,
      title,
      createdAt,
      updatedAt,
    },
    timeline,
    results,
    stats,
  }
}

/**
 * 只读文件头部，快速取标题（用于 /workbuddy-list 预览，避免把几十 MB 的会话整个读进内存）。
 * @param file - .jsonl 路径
 * @param maxBytes - 扫描上限，默认 1 MiB
 * @returns 标题，未找到时 undefined
 */
export function peekTitle(file, maxBytes = 1 << 20) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(maxBytes)
    const read = readSync(fd, buf, 0, maxBytes, 0)
    let text = buf.subarray(0, read).toString('utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    let title
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"')) continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.length > 0) {
          title = event.aiTitle
        }
      } catch {
        // 头部截断处的残行，忽略
      }
    }
    return title
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function timeOf(event, createdAt) {
  if (typeof event.timestamp === 'number') return event.timestamp
  return createdAt ?? Date.now()
}

/** 图片块 → 可读占位文本（DSH 侧无法承载原始图片字节）。 */
function imagePlaceholder(block) {
  const image = block?.image ?? {}
  const name = image.original_filename ?? block?.original_filename ?? '未命名图片'
  const mime = typeof image.mime === 'string' ? image.mime : 'image'
  const size = Number.isFinite(image.size) ? `, ${Math.round(image.size / 1024)}KB` : ''
  const path = typeof image.blob_path === 'string' ? `\n本地原图: ${image.blob_path}` : ''
  return `[图片: ${name} (${mime}${size})]${path}`
}

/** 工具输出可能是 string、{type,text} 或任意 JSON。 */
function outputText(output) {
  if (typeof output === 'string') return output
  if (typeof output?.text === 'string') return output.text
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `wb-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
