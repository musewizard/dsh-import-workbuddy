/**
 * 格式版本自适应测试。
 *
 * 宿主在版本不符时抛 `requires Session format vN`。插件应该捡出 N 重试，
 * 这样 dsh 升级格式版本后不用改插件代码。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  createWithFormatFallback,
  resetLearnedFormatVersion,
  SESSION_FORMAT_VERSION,
} from '../lib/import-service.mjs'

beforeEach(() => {
  resetLearnedFormatVersion()
})

/** 造一个只认某个版本的 persistence，版本不符时按宿主的真实措辞报错。 */
function fakePersistence(accepts, { onCall } = {}) {
  const calls = []
  return {
    calls,
    async create(header) {
      calls.push(header.version)
      onCall?.(header, calls.length)
      if (header.version !== accepts) {
        throw new Error(`encodeCurrent requires Session format v${accepts}`)
      }
      return { id: header.id, version: header.version }
    },
  }
}

test('版本不符时自动改用宿主要求的版本', async () => {
  const persistence = fakePersistence(5)
  const handle = await createWithFormatFallback(persistence, { id: 'wb-x', createdAt: 1 })

  assert.equal(handle.version, 5)
  assert.deepEqual(persistence.calls, [SESSION_FORMAT_VERSION, 5], '先试首选版本，再按宿主说的重试')
})

test('学到的版本会被后续调用复用，不再撞错', async () => {
  const first = fakePersistence(5)
  await createWithFormatFallback(first, { id: 'wb-a', createdAt: 1 })

  const second = fakePersistence(5)
  await createWithFormatFallback(second, { id: 'wb-b', createdAt: 2 })

  assert.deepEqual(second.calls, [5], '第二次直接用学到的版本')
})

test('宿主版本恰好等于首选值时只调一次', async () => {
  const persistence = fakePersistence(SESSION_FORMAT_VERSION)
  await createWithFormatFallback(persistence, { id: 'wb-x', createdAt: 1 })
  assert.equal(persistence.calls.length, 1)
})

test('already exists 直接抛出，不做版本重试', async () => {
  const persistence = {
    calls: 0,
    async create() {
      this.calls++
      throw new Error('session "wb-x" already exists')
    },
  }
  await assert.rejects(
    () => createWithFormatFallback(persistence, { id: 'wb-x', createdAt: 1 }),
    /already exists/u,
  )
  assert.equal(persistence.calls, 1, '不能因为已存在而重试')
})

test('无法识别的错误原样抛出，不无限重试', async () => {
  const persistence = {
    calls: 0,
    async create() {
      this.calls++
      throw new Error('disk is full')
    },
  }
  await assert.rejects(
    () => createWithFormatFallback(persistence, { id: 'wb-x', createdAt: 1 }),
    /disk is full/u,
  )
  // 没有学到过版本时只有一个候选；失败原因与版本无关，不该反复试
  assert.equal(persistence.calls, 1)
})
