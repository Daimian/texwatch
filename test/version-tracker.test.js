import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVersionTracker } from '../client/version-tracker.js'

test('新版本会触发渲染', () => {
  const t = createVersionTracker()
  assert.equal(t.shouldRender(3), true)
})

test('pdfVersion 为 0（还没编译成功过）不触发渲染', () => {
  const t = createVersionTracker()
  assert.equal(t.shouldRender(0), false)
})

test('claim 之后同一版本不再重复触发', () => {
  const t = createVersionTracker()
  t.claim(3)
  assert.equal(t.shouldRender(3), false)
})

test('渲染失败后回滚，允许同一版本的消息再次触发渲染（重连场景的核心修复）', () => {
  const t = createVersionTracker()
  const claim = t.claim(3)
  claim.fail()
  assert.equal(t.shouldRender(3), true)
  assert.equal(t.current, -1)
})

test('渲染被仲裁放弃（没有调用 fail）不应回滚——已声明的新版本要保留', () => {
  const t = createVersionTracker()
  t.claim(3)
  // renderPdf 正常 resolve（被 token 仲裁放弃也是正常 resolve，不抛异常），
  // 不会走到 catch，也就不会调用 fail()。renderedVersion 应维持在 3。
  assert.equal(t.current, 3)
  assert.equal(t.shouldRender(3), false)
})

test('旧 claim 在被更新的 claim 超越之后才失败，不能回滚更新的版本', () => {
  const t = createVersionTracker()
  const claimV3 = t.claim(3)
  t.claim(4) // 更新的消息先到达，推进到 4
  claimV3.fail() // v3 的渲染这时才发现自己失败了——不该覆盖已经声明的 v4
  assert.equal(t.current, 4)
  assert.equal(t.shouldRender(4), false)
})

test('reset 后即使版本号没变也会强制重新触发一次渲染（断线重连的保险）', () => {
  const t = createVersionTracker()
  t.claim(3)
  t.reset()
  assert.equal(t.shouldRender(3), true)
})
