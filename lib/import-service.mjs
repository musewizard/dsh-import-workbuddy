/**
 * 导入服务：解析 WorkBuddy 会话 → DSH 事件 → 经 ctx.sessionPersistence 写入。
 *
 * 为什么走 persistence 而不是自己写 .zstd 文件：
 *  - create/append 由 DSH 自己编码落盘，格式（多帧 zstd、目录编码、header 版本）永远与宿主一致；
 *  - flush 之后会话立刻对 GUI 可见，不需要重启进程；
 *  - 投影缓存（标题、统计）由宿主自己 fold 生成，不用手写版本敏感的 projcache。
 */

import { existsSync } from 'node:fs'

import { listWorkbuddySessions, parseWorkbuddySession, peekTitle, homeDir } from './workbuddy-reader.mjs'
import { buildDshEvents, deriveTitle, summarizeEvents } from './convert.mjs'

/**
 * 首选的 Session 格式版本。
 *
 * 不 import @deepseek-ai/dsh-session 的常量：插件目录解析到的可能是旧 pre-release 副本，
 * 版本号会与宿主不符。这里只当"首选值"，真实版本由 createWithFormatFallback 在运行时问出来。
 */
export const SESSION_FORMAT_VERSION = 4

/** 运行时学到的真实版本；一旦被宿主纠正过，后续直接用它，避免每次都撞一次错。 */
let learnedFormatVersion

/** 单次 append 的估算体积上限，避免后端单批序列化撞上 V8 字符串上限。 */
const APPEND_BATCH_BYTES = 32 << 20

/**
 * 创建会话，并自动适配宿主的格式版本。
 *
 * 宿主在版本不符时抛 `requires Session format vN`，N 就是它真正在用的版本。
 * 把这个 N 捡出来重试一次，插件就不用跟着 dsh 升级改代码了。
 *
 * @param persistence - ctx.sessionPersistence
 * @param header - 除 version 外的会话 header
 * @returns create 返回的写句柄
 */
export async function createWithFormatFallback(persistence, header) {
  const queue = []
  if (Number.isSafeInteger(learnedFormatVersion)) queue.push(learnedFormatVersion)
  if (!queue.includes(SESSION_FORMAT_VERSION)) queue.push(SESSION_FORMAT_VERSION)

  const tried = new Set()
  let lastError

  while (queue.length > 0) {
    const version = queue.shift()
    if (tried.has(version)) continue
    tried.add(version)

    try {
      const handle = await persistence.create({ ...header, version })
      learnedFormatVersion = version
      return handle
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? error)

      // 会话已存在不是版本问题，交给调用方按「跳过」处理
      if (message.includes('already exists')) throw error

      const matched = /requires Session format v(\d+)/iu.exec(message)
      if (matched !== null) {
        const actual = Number(matched[1])
        if (Number.isSafeInteger(actual) && !tried.has(actual)) queue.push(actual)
      }
    }
  }

  throw lastError
}

/** 仅供测试：清空运行时学到的格式版本。 */
export function resetLearnedFormatVersion() {
  learnedFormatVersion = undefined
}

/** 把事件按体积切成连续批次写入句柄。 */
async function appendInBatches(handle, events) {
  let batch = []
  let bytes = 0
  for (const event of events) {
    batch.push(event)
    bytes += JSON.stringify(event).length + 1
    if (bytes >= APPEND_BATCH_BYTES) {
      await handle.append(batch)
      batch = []
      bytes = 0
    }
  }
  if (batch.length > 0) await handle.append(batch)
}

/**
 * 导入会话。
 * @param ctx - 插件上下文（用 ctx.sessionPersistence 与 ctx.get('workspaceRegistry')）
 * @param options - { root, limit, project, since, toolTruncate, noTools, dryRun, attachWorkspaces }
 * @returns 摘要行数组
 */
export async function importWorkbuddySessions(ctx, options) {
  const persistence = ctx.sessionPersistence
  const lines = []

  const all = listWorkbuddySessions(options.root)
  if (all.length === 0) {
    return [`未在 ${options.root} 找到 WorkBuddy 会话`]
  }

  let selected = all
  if (typeof options.project === 'string' && options.project.length > 0) {
    const needle = options.project.toLowerCase()
    selected = selected.filter(item => item.project.toLowerCase().includes(needle))
  }
  if (typeof options.since === 'number') {
    selected = selected.filter(item => item.mtimeMs >= options.since)
  }
  if (Number.isSafeInteger(options.limit) && options.limit > 0) {
    selected = selected.slice(0, options.limit)
  }

  const existing = new Set()
  try {
    for (const snapshot of await persistence.list()) existing.add(snapshot.header.id)
  } catch {
    // 冷启动阶段 list 不可用时，退化为「靠 create 的 already exists 兜底」
  }

  let imported = 0
  let skipped = 0
  let empty = 0
  let failed = 0
  const importedRefs = []

  for (const item of selected) {
    const id = `wb-${item.id}`

    if (existing.has(id)) {
      skipped += 1
      continue
    }

    let parsed
    try {
      parsed = parseWorkbuddySession(item.file)
    } catch (error) {
      failed += 1
      lines.push(`  [failed] ${id}: ${error.message}`)
      continue
    }

    const timeline = parsed.timeline
    if (timeline.length === 0) {
      empty += 1
      continue
    }

    const title = deriveTitle(parsed.header.title, timeline)
    const events = buildDshEvents(timeline, parsed.results, {
      title,
      cwd: parsed.header.cwd,
      toolTruncate: options.toolTruncate,
      noTools: options.noTools,
    }).map((event, seq) => ({ ...event, seq }))

    const stat = summarizeEvents(events)
    const summary = `turns=${stat.turns} events=${events.length} tools=${stat.calls} 结果=${stat.resultChars}字符`

    if (options.dryRun === true) {
      lines.push(`  [dry-run] ${id}  ${summary}  title=${JSON.stringify(title ?? '')}`)
      imported += 1
      continue
    }

    let handle
    try {
      handle = await createWithFormatFallback(persistence, {
        id,
        createdAt: parsed.header.createdAt ?? timeline[0].time,
        isSeeded: false,
        ...(parsed.header.cwd !== undefined ? { cwd: parsed.header.cwd } : {}),
      })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (message.includes('already exists')) {
        skipped += 1
        existing.add(id)
        continue
      }
      failed += 1
      lines.push(`  [failed] ${id}: ${message}`)
      continue
    }

    try {
      await appendInBatches(handle, events)
      await handle.flush()
    } catch (error) {
      failed += 1
      lines.push(`  [failed] ${id}: 事件写入失败 —— ${error.message}`)
      // header 已经落盘、事件没写全 → 下次会因 id 已存在而跳过，用户重跑也修不好。
      // 明确告诉他怎么清掉这个半成品。
      lines.push(`        该会话 header 已创建但事件不完整，重跑会跳过它。`)
      lines.push(`        修复：删除 dsh 会话库里 id 为 ${id} 的目录后重试。`)
      continue
    } finally {
      // 无论成功失败都释放写句柄（重复 close 已被内层 catch 吞掉）
      try {
        await handle.close()
      } catch {
        // 已关闭
      }
    }

    imported += 1
    existing.add(id)
    importedRefs.push({ id, cwd: parsed.header.cwd })
    lines.push(`  [imported] ${id}  ${summary}  title=${JSON.stringify(title ?? '')}`)
  }

  const scope = options.dryRun === true ? 'dry-run' : 'result'
  lines.push(`[workbuddy] ${scope}: 新增 ${imported}, 跳过 ${skipped}, 空会话 ${empty}, 失败 ${failed}`)

  if (options.dryRun !== true && importedRefs.length > 0 && options.attachWorkspaces !== false) {
    lines.push(...await attachSessionsToWorkspaces(ctx, importedRefs))
  }

  return lines
}

/**
 * 把 cwd 规范化成与 DSH 自己存储一致的形式。
 *
 * 关键：Windows 的 `fs.realpath` **不会**统一盘符大小写 —— 实测
 *   realpath('c:\\Users\\…') → 'c:\\Users\\…'
 *   realpath('C:\\Users\\…') → 'C:\\Users\\…'
 * 而 workspace 的唯一性是「规范化后字符串相等」。WorkBuddy 记录的 cwd 是小写盘符
 * （`c:\Users\Admin\…`），DSH 自己建的工作区是大写（`C:\Users\Admin\…`），
 * 直接拿去 resolveByPath 会匹配失败，于是同一个目录会分裂成两个工作区。
 * 所以这里统一盘符大写 + 反斜杠，与 DSH 的书写习惯对齐。
 */
export function canonicalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return cwd
  if (process.platform !== 'win32') return cwd
  let out = cwd.replace(/\//g, '\\')
  out = out.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
  const trimmed = out.replace(/\\+$/, '')
  return trimmed.length === 2 && trimmed[1] === ':' ? `${trimmed}\\` : trimmed
}

/** 路径显示：home 前缀折叠成 ~，超过 3 级只留最后 3 级。 */
function displayPath(cwd) {
  const home = homeDir()
  const normalized = cwd.replace(/\\/g, '/')
  const normalizedHome = home.replace(/\\/g, '/')
  if (normalizedHome.length > 0 && normalized === normalizedHome) return '~'
  if (normalizedHome.length > 0 && normalized.startsWith(`${normalizedHome}/`)) {
    const rel = normalized.slice(normalizedHome.length + 1)
    const parts = rel.split('/')
    return parts.length > 3 ? `~/${parts.slice(-3).join('/')}` : `~/${rel}`
  }
  const parts = normalized.split('/').filter(Boolean)
  return parts.length > 3 ? parts.slice(-3).join('/') : normalized
}

/** workspace 标题：`名称 (~/最后几级)`，同名项目可区分。 */
function workspaceTitle(cwd) {
  const base = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? cwd
  return `${base} (${displayPath(cwd)})`
}

/**
 * 按 cwd 精确匹配把会话挂到工作区；不存在则创建。
 * workspace 服务未加载（headless 等组合）时静默跳过。
 */
export async function attachSessionsToWorkspaces(ctx, sessions) {
  let registry
  try {
    registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null) return []

  const byCwd = new Map()
  for (const session of sessions) {
    if (typeof session.cwd !== 'string' || session.cwd.length === 0) continue
    let list = byCwd.get(session.cwd)
    if (list === undefined) {
      list = []
      byCwd.set(session.cwd, list)
    }
    list.push(session.id)
  }

  const lines = []
  for (const [cwd, ids] of byCwd) {
    if (!existsSync(cwd)) {
      lines.push(`  [skipped] ${cwd}: 目录不存在，会话保留在未分组`)
      continue
    }
    const canonical = canonicalizeCwd(cwd)
    try {
      // 先按规范化路径找；找不到再按原始写法找一次，兼容历史（早期脚本直接写入小写盘符）
      const lookups = canonical === cwd ? [canonical] : [canonical, cwd]
      let workspace
      for (const candidate of lookups) {
        try {
          workspace = await registry.resolveByPath(candidate)
        } catch {
          workspace = undefined
        }
        if (workspace !== undefined) break
      }
      const existed = workspace !== undefined
      if (workspace === undefined) {
        workspace = await registry.create(canonical, workspaceTitle(canonical))
      }
      for (const id of ids) {
        try {
          await workspace.attachSession(id)
        } catch (error) {
          lines.push(`  [skipped] ${id} 挂载到 ${cwd} 失败: ${error.message}`)
        }
      }
      lines.push(`  [${existed ? 'reused' : 'created'}] ${workspaceTitle(canonical)}: ${ids.length} 个会话`)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        lines.push(`  [skipped] ${cwd}: 目录不存在，会话保留在未分组`)
      } else {
        lines.push(`  [failed] ${cwd}: ${error.message}`)
      }
    }
  }
  return lines
}

/** 列出可导入会话（不写入），供 /workbuddy-list 使用。 */
export function describeWorkbuddySessions(options) {
  const all = listWorkbuddySessions(options.root)
  if (all.length === 0) return [`未在 ${options.root} 找到 WorkBuddy 会话`]

  let selected = all
  if (typeof options.project === 'string' && options.project.length > 0) {
    const needle = options.project.toLowerCase()
    selected = selected.filter(item => item.project.toLowerCase().includes(needle))
  }

  const lines = [`共 ${selected.length} 个会话（${options.root}）：`]
  for (const item of selected) {
    // 只读头部取标题：列表命令不该把几十 MB 的会话整个读进内存
    const title = peekTitle(item.file) ?? '(无标题)'
    const sizeKb = Math.round(item.size / 1024)
    const when = new Date(item.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(`  wb-${item.id}  ${when}  ${sizeKb}KB  ${title}`)
  }
  return lines
}
