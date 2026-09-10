import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLog } from '../src/log-parser.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures/logs', name), 'utf8')

test('未解析的引用：报 warning 并提示需要跑 bibtex', () => {
  const diags = parseLog(fixture('undefined-cite.log'), '/proj')
  const d = diags.find((x) => /Citation/.test(x.message) && /nosuchkey/.test(x.message))
  assert.ok(d, '应该报出未定义的引用')
  assert.equal(d.severity, 'warning')
  assert.match(d.hint, /bibtex/)
})

test('Overfull hbox：报 warning 并带上起始行号', () => {
  const diags = parseLog(fixture('overfull.log'), '/proj')
  const d = diags.find((x) => /Overfull/.test(x.message))
  assert.ok(d)
  assert.equal(d.severity, 'warning')
  assert.equal(d.line, 3)
})

test('带 on input line 的宏包警告能拿到行号', () => {
  const log = 'Package hyperref Warning: Token not allowed in a PDF string on input line 42.\n'
  const diags = parseLog(log, '/proj')
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'warning')
  assert.equal(diags[0].line, 42)
  assert.match(diags[0].message, /hyperref/)
})

test('错误排在警告前面', () => {
  const log = [
    'LaTeX Warning: Citation `a\' on page 1 undefined on input line 5.',
    './main.tex:9: Undefined control sequence.',
  ].join('\n')
  const diags = parseLog(log, '/proj')
  assert.equal(diags[0].severity, 'error')
  assert.equal(diags[1].severity, 'warning')
})

test('带文件行号前缀的警告仍判为 warning，并保留文件与行号', () => {
  const log = './main.tex:5: LaTeX Warning: Citation `x\' undefined on input line 5.\n'
  const diags = parseLog(log, '/proj')
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'warning')
  assert.equal(diags[0].file, 'main.tex')
  assert.equal(diags[0].line, 5)
  assert.match(diags[0].hint, /bibtex/)
})

test('带文件行号前缀的真错误仍判为 error', () => {
  const diags = parseLog('./main.tex:12: Undefined control sequence.\n', '/proj')
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'error')
  assert.equal(diags[0].line, 12)
})
