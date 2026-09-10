import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeKind, SingleSlotQueue } from '../src/queue.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

test('mergeKind 取权重更重的那个', () => {
  assert.equal(mergeKind('tex', 'preamble'), 'preamble')
  assert.equal(mergeKind('preamble', 'tex'), 'preamble')
  assert.equal(mergeKind('asset', 'bib'), 'bib')
  assert.equal(mergeKind('tex', 'asset'), 'tex')
  assert.equal(mergeKind(null, 'tex'), 'tex')
  assert.equal(mergeKind('bib', null), 'bib')
})

test('权重顺序是 preamble > bib > tex > asset', () => {
  assert.equal(mergeKind('bib', 'preamble'), 'preamble')
  assert.equal(mergeKind('tex', 'bib'), 'bib')
  assert.equal(mergeKind('asset', 'tex'), 'tex')
})

test('空闲时 push 立刻执行', async () => {
  const ran = []
  const q = new SingleSlotQueue(async (kind) => { ran.push(kind); return kind })
  q.push('tex')
  await tick(30)
  assert.deepEqual(ran, ['tex'])
})

test('运行中的 push 进入 pending，不会并发执行', async () => {
  const ran = []
  const q = new SingleSlotQueue(async (kind) => {
    ran.push(kind)
    await tick(50)
    return kind
  })
  q.push('tex')
  await tick(10)
  q.push('asset')
  q.push('bib')
  await tick(150)
  // 第一次跑 tex；期间的 asset 和 bib 合并成 bib，跑第二次
  assert.deepEqual(ran, ['tex', 'bib'])
})

test('连续 push 只保留最后合并出的一次', async () => {
  const ran = []
  const q = new SingleSlotQueue(async (kind) => {
    ran.push(kind)
    await tick(50)
  })
  q.push('tex')
  await tick(5)
  q.push('tex'); q.push('tex'); q.push('tex')
  await tick(150)
  assert.equal(ran.length, 2, '四次 push 只应产生两次运行')
})

test('runner 抛错不会卡死队列', async () => {
  const ran = []
  const q = new SingleSlotQueue(async (kind) => {
    ran.push(kind)
    if (ran.length === 1) throw new Error('boom')
  })
  q.push('tex')
  await tick(20)
  q.push('bib')
  await tick(20)
  assert.deepEqual(ran, ['tex', 'bib'])
})

test('广播 compiling / queued / idle 状态', async () => {
  const states = []
  const q = new SingleSlotQueue(async () => { await tick(50) })
  q.on('state', (s) => states.push(s.state))
  q.push('tex')
  await tick(10)
  q.push('bib')
  await tick(150)
  assert.equal(states[0], 'compiling')
  assert.ok(states.includes('queued'))
  assert.equal(states.at(-1), 'idle')
})
