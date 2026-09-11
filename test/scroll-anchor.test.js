import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureAnchor, anchorToScrollTop } from '../client/scroll-anchor.js'

// pages 是 [{offsetTop, offsetHeight}]，模拟 DOM 里的 canvas 列表
const pages = [
  { offsetTop: 0, offsetHeight: 1000 },
  { offsetTop: 1016, offsetHeight: 1000 },
  { offsetTop: 2032, offsetHeight: 1000 },
]

test('滚到第 1 页顶部', () => {
  assert.deepEqual(captureAnchor(pages, 0), { page: 0, ratio: 0 })
})

test('滚到第 2 页中间', () => {
  const a = captureAnchor(pages, 1516) // 1016 + 500
  assert.equal(a.page, 1)
  assert.ok(Math.abs(a.ratio - 0.5) < 0.01)
})

test('往回换算能还原滚动位置', () => {
  const top = 1516
  const restored = anchorToScrollTop(pages, captureAnchor(pages, top))
  assert.ok(Math.abs(restored - top) < 2)
})

test('重新分页后页数变多，锚点仍落在同一页的同一相对位置', () => {
  const after = [
    { offsetTop: 0, offsetHeight: 900 },
    { offsetTop: 916, offsetHeight: 900 },
    { offsetTop: 1832, offsetHeight: 900 },
    { offsetTop: 2748, offsetHeight: 900 },
  ]
  const restored = anchorToScrollTop(after, { page: 1, ratio: 0.5 })
  assert.ok(Math.abs(restored - (916 + 450)) < 2)
})

test('页数变少时锚点被夹到最后一页，不会算出越界值', () => {
  const after = [{ offsetTop: 0, offsetHeight: 900 }]
  const restored = anchorToScrollTop(after, { page: 5, ratio: 0.5 })
  assert.ok(restored >= 0 && restored <= 900)
})

test('没有页面时返回 0 而不是 NaN', () => {
  assert.equal(anchorToScrollTop([], { page: 2, ratio: 0.3 }), 0)
  assert.deepEqual(captureAnchor([], 500), { page: 0, ratio: 0 })
})
