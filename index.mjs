/**
 * dsh-import-workbuddy
 *
 * 把 WorkBuddy / CodeBuddy 的本地会话记录导入 DeepSeek Harness，成为原生、可续聊的会话。
 *
 * 命令（在会话输入框里直接敲）：
 *   /import-workbuddy [--limit N] [--project 子串] [--since ISO|ms]
 *                     [--tool-truncate N] [--no-tools] [--dry-run]
 *   /workbuddy-list   [--project 子串]
 *
 * 与生态里其它导入插件的差异：WorkBuddy 的 function_call_result 保存了完整工具输出，
 * 因此这里写入的是真实结果，而不是 "[工具结果未记录]" 占位符。
 *
 * 注意：本模块没有 default export（namespace 插件），否则 Loader 会丢弃 inject。
 */

import { resolveWorkbuddyRoot } from './lib/workbuddy-reader.mjs'
import { describeWorkbuddySessions, importWorkbuddySessions } from './lib/import-service.mjs'

export const name = 'import-workbuddy'

/** 需要 commands（注册斜杠命令）与 sessionPersistence（写入会话）。 */
export const inject = ['commands', 'sessionPersistence']

/** 解析 `--key value` / `--key=value` 形式的命令输入。 */
function parseInput(rawInput) {
  const options = {}
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    if (token.startsWith('--') && eq >= 0) {
      options[token.slice(2, eq)] = token.slice(eq + 1)
    } else if (token.startsWith('--') && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      options[token.slice(2)] = tokens[++i]
    } else if (token.startsWith('--')) {
      options[token.slice(2)] = true
    } else if (eq >= 0) {
      options[token.slice(0, eq)] = token.slice(eq + 1)
    }
  }
  return options
}

/** 把命令输入归一成导入选项。 */
function resolveOptions(input, defaults) {
  const options = { ...defaults }

  if (input['limit'] !== undefined) {
    const limit = Number(input['limit'])
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数')
    options.limit = limit
  }
  if (typeof input['project'] === 'string') options.project = input['project']
  if (input['since'] !== undefined) {
    const raw = String(input['since'])
    const ms = Number(raw)
    options.since = Number.isFinite(ms) && ms > 1e11 ? ms : Date.parse(raw)
    if (Number.isNaN(options.since)) throw new Error('--since 无法解析（用 ISO 日期或毫秒时间戳）')
  }
  if (input['tool-truncate'] !== undefined) {
    const value = Number(input['tool-truncate'])
    if (!Number.isInteger(value) || value < 0) throw new Error('--tool-truncate 必须是非负整数（0 表示不截断）')
    options.toolTruncate = value
  }
  if (input['no-tools'] !== undefined) options.noTools = true
  if (input['dry-run'] !== undefined) options.dryRun = true
  if (input['no-attach'] !== undefined) options.attachWorkspaces = false

  return options
}

export function apply(ctx, config = {}) {
  const defaults = {
    // 未显式配置时自动探测多个候选位置（WorkBuddy 装在哪个盘都不影响：数据在用户目录）
    root: resolveWorkbuddyRoot(config?.root),
    /** 0 = 不截断，保留工具结果全文（"无损"默认值） */
    toolTruncate: 0,
    attachWorkspaces: true,
    ...(config ?? {}),
  }

  ctx.commands.register({
    name: 'import-workbuddy',
    description: '把 WorkBuddy / CodeBuddy 会话导入 dsh（含完整工具结果；重复执行自动跳过已导入）',
    input: {
      hint: '[--limit N] [--project 子串] [--since ISO|ms] [--tool-truncate N] [--no-tools] [--dry-run]',
    },
    handler: async (invocation) => {
      try {
        const options = resolveOptions(parseInput(invocation?.rawInput), defaults)
        const lines = await importWorkbuddySessions(ctx, options)
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `导入失败：${error.message}` }
      }
    },
  })

  ctx.commands.register({
    name: 'workbuddy-list',
    description: '列出本机可导入的 WorkBuddy / CodeBuddy 会话（只读，不写入）',
    input: { hint: '[--project 子串]' },
    handler: (invocation) => {
      try {
        const options = resolveOptions(parseInput(invocation?.rawInput), defaults)
        return { kind: 'success', text: describeWorkbuddySessions(options).join('\n') }
      } catch (error) {
        return { kind: 'error', text: `读取失败：${error.message}` }
      }
    },
  })
}
