/**
 * 转换层测试（fixture 驱动，不依赖本机任何真实会话）。
 *
 *   npm test        （= node --test tests/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWorkbuddySession, cleanUserText, peekTitle } from '../lib/workbuddy-reader.mjs'
import { buildDshEvents, deriveTitle } from '../lib/convert.mjs'
import { validateEventSequence } from './validate.mjs'

const T0 = 1700000000000

function writeSession(dir, name, events, { bom = false } = {}) {
  const file = join(dir, `${name}.jsonl`)
  const body = events.map(event => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(file, bom ? `\uFEFF${body}` : body, 'utf8')
  return file
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb2dsh-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 一条最小可用会话：user → 思考 → 正文 → 一次工具调用 */
function basicSession(id = 'test-1') {
  return [
    { type: 'session-meta', id: 'meta-1', sessionId: id, timestamp: T0, meta: {} },
    {
      type: 'message',
      role: 'user',
      timestamp: T0 + 1000,
      content: [{
        type: 'input_text',
        text: '<system-reminder data-role="user-context">\n<user_info>OS: win32</user_info>\n</system-reminder>\n<user_query>帮我看看这个文件</user_query>',
      }],
    },
    { type: 'reasoning', timestamp: T0 + 2000, providerData: { stepSeq: 1, model: 'test-model' }, rawContent: [{ type: 'reasoning_text', text: '先读文件' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 3000, providerData: { stepSeq: 1, model: 'test-model' }, content: [{ type: 'output_text', text: '我来看一下。' }] },
    { type: 'function_call', timestamp: T0 + 4000, callId: 'call-1', name: 'Read', arguments: '{"file_path":"a.txt"}', providerData: { stepSeq: 1, model: 'test-model' } },
    { type: 'function_call_result', timestamp: T0 + 5000, callId: 'call-1', name: 'Read', status: 'completed', output: { type: 'text', text: '文件内容' } },
    { type: 'ai-title', timestamp: T0 + 6000, aiTitle: '读文件' },
  ]
}

test('剥离 system-reminder，只保留 user_query', () => {
  const raw = '<system-reminder data-role="user-context">\n噪音\n</system-reminder>\n<user_query>真正的问题</user_query>'
  assert.equal(cleanUserText(raw), '真正的问题')
})

test('没有 user_query 时退化为「去掉 system-reminder」', () => {
  const raw = '<system-reminder>\n噪音\n</system-reminder>\n剩下的文字'
  assert.equal(cleanUserText(raw), '剩下的文字')
})

test('基本会话：turn/step 结构合法且工具配对', () => withTempDir((dir) => {
  const file = writeSession(dir, 'test-1', basicSession())
  const { header, timeline, results } = parseWorkbuddySession(file)

  assert.equal(header.id, 'test-1')
  assert.equal(header.title, '读文件')
  assert.equal(timeline.filter(node => node.kind === 'user').length, 1)
  assert.equal(results.get('call-1').text, '文件内容')

  const events = buildDshEvents(timeline, results, { title: header.title, cwd: 'C:\\tmp\\demo' })
    .map((event, seq) => ({ ...event, seq }))

  assert.deepEqual(validateEventSequence(events), [])

  const types = events.map(event => event.type)
  assert.equal(types[0], 'turn/start')
  assert.equal(types[1], 'step/start', 'step/start 必须早于 user/message')
  assert.equal(types[2], 'user/message')

  const assistant = events.find(event => event.type === 'assistant/message')
  assert.deepEqual(assistant.data.message.content.map(block => block.type), ['reasoning', 'text', 'tool-call'])

  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.content[0].text, '文件内容', '工具结果必须是原文，不是占位符')
  assert.equal(result.data.message.isError, false)
}))

test('用户消息只含 system-reminder 时不会产生空 turn', () => withTempDir((dir) => {
  const file = writeSession(dir, 'empty', [
    { type: 'session-meta', id: 'm', sessionId: 'empty', timestamp: T0 },
    { type: 'message', role: 'user', timestamp: T0 + 1, content: [{ type: 'input_text', text: '<system-reminder>只有噪音</system-reminder>' }] },
  ])
  const { timeline } = parseWorkbuddySession(file)
  assert.equal(timeline.length, 0)
}))

test('图片块转成可读占位，不静默丢失', () => withTempDir((dir) => {
  const file = writeSession(dir, 'img', [
    {
      type: 'message',
      role: 'user',
      timestamp: T0,
      content: [
        { type: 'input_image', image: { type: 'image_blob_ref', mime: 'image/png', size: 63717, blob_path: 'C:\\blobs\\a.png', original_filename: 'shot.png' }, original_filename: 'shot.png' },
        { type: 'input_text', text: '<user_query>看这张图</user_query>' },
      ],
    },
  ])
  const { timeline } = parseWorkbuddySession(file)
  const texts = timeline[0].blocks.map(block => block.text)
  assert.equal(texts.length, 2)
  assert.match(texts[0], /\[图片: shot\.png/)
  assert.match(texts[0], /image\/png/)
  assert.match(texts[0], /C:\\blobs\\a\.png/)
  assert.equal(texts[1], '看这张图')
}))

test('UTF-8 BOM 不会让首条事件被丢弃', () => withTempDir((dir) => {
  const file = writeSession(dir, 'bom', basicSession(), { bom: true })
  const { timeline, header } = parseWorkbuddySession(file)
  assert.equal(header.id, 'test-1')
  assert.equal(timeline.length > 0, true)
}))

test('--no-tools：只有工具调用的 step 不会破坏 step 边界', () => withTempDir((dir) => {
  const file = writeSession(dir, 'notools', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>跑一下</user_query>' }] },
    // step 1 只有工具调用，没有任何文本/思考
    { type: 'function_call', timestamp: T0 + 1000, callId: 'c1', name: 'Bash', arguments: '{}', providerData: { stepSeq: 1 } },
    { type: 'function_call_result', timestamp: T0 + 2000, callId: 'c1', name: 'Bash', status: 'completed', output: { type: 'text', text: 'ok' } },
    // step 2 才有正文
    { type: 'message', role: 'assistant', timestamp: T0 + 3000, providerData: { stepSeq: 2 }, content: [{ type: 'output_text', text: '跑完了' }] },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, { noTools: true }).map((event, seq) => ({ ...event, seq }))

  assert.deepEqual(validateEventSequence(events), [])
  assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
  const assistant = events.find(event => event.type === 'assistant/message')
  assert.equal(assistant.data.message.content[0].text, '跑完了')
}))

test('标题截断不产生孤立代理对', () => {
  const title = `${'a'.repeat(79)}😀尾`
  const derived = deriveTitle(title, [])
  assert.equal(derived.length, 79, 'emoji 被完整剔除，而不是切一半')
  assert.equal(/[\uD800-\uDBFF]$/u.test(derived), false)
})

test('工具结果超长时按 UTF-16 边界截断', () => withTempDir((dir) => {
  const longText = `${'b'.repeat(9)}😀尾巴`
  const file = writeSession(dir, 'clip', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>x</user_query>' }] },
    { type: 'function_call', timestamp: T0 + 1, callId: 'c1', name: 'Bash', arguments: '{}', providerData: { stepSeq: 1 } },
    { type: 'function_call_result', timestamp: T0 + 2, callId: 'c1', name: 'Bash', status: 'completed', output: { type: 'text', text: longText } },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, { toolTruncate: 10 })
  const text = events.find(event => event.type === 'tool/result').data.message.content[0].text
  assert.match(text, /已截断/)
  assert.equal(/[\uD800-\uDBFF]$/u.test(text.split('\n')[0]), false)
}))

test('工具失败会标记 isError', () => withTempDir((dir) => {
  const file = writeSession(dir, 'err', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>x</user_query>' }] },
    { type: 'function_call', timestamp: T0 + 1, callId: 'c1', name: 'Bash', arguments: '{}', providerData: { stepSeq: 1 } },
    { type: 'function_call_result', timestamp: T0 + 2, callId: 'c1', name: 'Bash', status: 'error', output: { type: 'text', text: 'boom' } },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {})
  assert.equal(events.find(event => event.type === 'tool/result').data.message.isError, true)
}))

test('多轮对话：每个用户消息开一个新 turn', () => withTempDir((dir) => {
  const file = writeSession(dir, 'multi', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>第一问</user_query>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 1000, providerData: { stepSeq: 1 }, content: [{ type: 'output_text', text: '第一答' }] },
    { type: 'message', role: 'user', timestamp: T0 + 2000, content: [{ type: 'input_text', text: '<user_query>第二问</user_query>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 3000, providerData: { stepSeq: 1 }, content: [{ type: 'output_text', text: '第二答' }] },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {}).map((event, seq) => ({ ...event, seq }))
  assert.deepEqual(validateEventSequence(events), [])
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
  assert.equal(events.filter(event => event.type === 'user/message').length, 2)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
}))

test('peekTitle 只读头部也能拿到标题', () => withTempDir((dir) => {
  const file = writeSession(dir, 'peek', basicSession())
  assert.equal(peekTitle(file), '读文件')
  assert.equal(peekTitle(join(dir, 'not-exist.jsonl')), undefined)
}))

test('损坏的尾行不会让整个解析失败', () => withTempDir((dir) => {
  const file = join(dir, 'torn.jsonl')
  writeFileSync(file, `${basicSession().map(event => JSON.stringify(event)).join('\n')}\n{"type":"message","role":"user"`, 'utf8')
  const { timeline } = parseWorkbuddySession(file)
  assert.equal(timeline.length > 0, true)
}))

test('会话以助手消息开头（被截断的历史）仍产出合法结构', () => withTempDir((dir) => {
  const file = writeSession(dir, 'orphan', [
    { type: 'message', role: 'assistant', timestamp: T0, providerData: { stepSeq: 1 }, content: [{ type: 'output_text', text: '续上文' }] },
    { type: 'message', role: 'user', timestamp: T0 + 1000, content: [{ type: 'input_text', text: '<user_query>接着聊</user_query>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 2000, providerData: { stepSeq: 1 }, content: [{ type: 'output_text', text: '好的' }] },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {}).map((event, seq) => ({ ...event, seq }))
  assert.deepEqual(validateEventSequence(events), [])
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
}))

test('连续两条用户消息各自成 turn，不会丢掉第一条', () => withTempDir((dir) => {
  const file = writeSession(dir, 'double', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>第一句</user_query>' }] },
    { type: 'message', role: 'user', timestamp: T0 + 1000, content: [{ type: 'input_text', text: '<user_query>第二句</user_query>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 2000, providerData: { stepSeq: 1 }, content: [{ type: 'output_text', text: '回答第二句' }] },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {}).map((event, seq) => ({ ...event, seq }))
  assert.deepEqual(validateEventSequence(events), [])
  assert.equal(events.filter(event => event.type === 'user/message').length, 2)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
}))

test('arguments 是对象时也能序列化（格式变体）', () => withTempDir((dir) => {
  const file = writeSession(dir, 'objargs', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>x</user_query>' }] },
    { type: 'function_call', timestamp: T0 + 1, callId: 'c1', name: 'Read', arguments: { file_path: 'a.txt' }, providerData: { stepSeq: 1 } },
    { type: 'function_call_result', timestamp: T0 + 2, callId: 'c1', name: 'Read', status: 'completed', output: { type: 'text', text: 'ok' } },
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {})
  const call = events.find(event => event.type === 'tool/call')
  assert.equal(typeof call.data.arguments, 'string')
  assert.deepEqual(JSON.parse(call.data.arguments), { file_path: 'a.txt' })
}))

test('工具结果缺失时写空字符串而不是 undefined', () => withTempDir((dir) => {
  const file = writeSession(dir, 'noresult', [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: '<user_query>x</user_query>' }] },
    { type: 'function_call', timestamp: T0 + 1, callId: 'c1', name: 'Bash', arguments: '{}', providerData: { stepSeq: 1 } },
    // 故意不给 function_call_result
  ])
  const { timeline, results } = parseWorkbuddySession(file)
  const events = buildDshEvents(timeline, results, {}).map((event, seq) => ({ ...event, seq }))
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.content[0].text, '')
  // 结构仍然合法：tool/call 必须有配对结果
  assert.deepEqual(validateEventSequence(events), [])
}))
