import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLog } from '../src/log-parser.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures/logs', name), 'utf8')

test('缺宏包：识别为 error，给出 tlmgr 安装建议', () => {
  const diags = parseLog(fixture('missing-sty.log'), '/proj')
  const d = diags.find((x) => /thispackagedoesnotexist/.test(x.message))
  assert.ok(d, '应该报出缺失的宏包')
  assert.equal(d.severity, 'error')
  assert.match(d.hint, /tlmgr install thispackagedoesnotexist/)
})

test('未定义控制序列：拿到文件与行号', () => {
  const diags = parseLog(fixture('undefined-cs.log'), '/proj')
  const d = diags.find((x) => /Undefined control sequence/.test(x.message))
  assert.ok(d)
  assert.equal(d.severity, 'error')
  assert.equal(d.file, 'undefined-cs.tex')
  assert.equal(d.line, 3)
})

test('图片找不到：识别为缺图而不是缺宏包，不给 tlmgr 建议', () => {
  const diags = parseLog(fixture('missing-graphic.log'), '/proj')
  const d = diags.find((x) => /nosuchimage\.png/.test(x.message))
  assert.ok(d)
  assert.equal(d.severity, 'error')
  assert.ok(!/tlmgr/.test(d.hint ?? ''), '缺图不该建议装宏包')
  assert.match(d.hint, /图片/)
})

test('每个 Diagnostic 的 raw 含其 message 的起始片段', () => {
  const diags = parseLog(fixture('undefined-cs.log'), '/proj')
  assert.ok(diags.length > 0)
  for (const d of diags) {
    assert.ok(typeof d.raw === 'string' && d.raw.length > 0)
    assert.ok(
      d.raw.includes(d.message.slice(0, 20)),
      `raw 应包含 message 的起始部分，message=${d.message}`
    )
  }
})

test('空日志返回空数组', () => {
  assert.deepEqual(parseLog('', '/proj'), [])
})

test('绝对路径被还原成相对项目根的路径', () => {
  const log = '/proj/sub/chapter.tex:12: Undefined control sequence.\n'
  const diags = parseLog(log, '/proj')
  assert.equal(diags[0].file, 'sub/chapter.tex')
  assert.equal(diags[0].line, 12)
})

test('消息正文里的 12:30: 不会被误判为文件与行号', () => {
  const diags = parseLog('Some info line at 12:30: nothing wrong here\n', '/proj')
  assert.deepEqual(diags, [])
})
