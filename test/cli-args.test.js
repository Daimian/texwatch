import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgv, formatDiagnostics } from '../src/cli-args.js'

test('无参数时全是默认值', () => {
  const a = parseArgv([])
  assert.equal(a.mainTex, null)
  assert.equal(a.port, null)
  assert.equal(a.draft, false)
  assert.equal(a.once, false)
  assert.equal(a.clean, false)
  assert.equal(a.open, true)
})

test('位置参数是主文件', () => {
  assert.equal(parseArgv(['main.tex']).mainTex, 'main.tex')
})

test('--port 解析成数字', () => {
  assert.equal(parseArgv(['--port', '4000']).port, 4000)
})

test('--draft / --once / --clean 是布尔开关', () => {
  const a = parseArgv(['--draft', '--once', '--clean'])
  assert.equal(a.draft, true)
  assert.equal(a.once, true)
  assert.equal(a.clean, true)
})

test('--no-open 关掉自动打开浏览器', () => {
  assert.equal(parseArgv(['--no-open']).open, false)
})

test('位置参数与开关可以混着写', () => {
  const a = parseArgv(['--draft', 'SI.tex', '--port', '9000'])
  assert.equal(a.mainTex, 'SI.tex')
  assert.equal(a.draft, true)
  assert.equal(a.port, 9000)
})

test('未知开关抛错', () => {
  assert.throws(() => parseArgv(['--nonsense']), /未知参数/)
})

test('formatDiagnostics: 无诊断时说明没问题', () => {
  assert.match(formatDiagnostics([]), /没有错误/)
})

test('formatDiagnostics: 输出文件与行号，并带上建议', () => {
  const out = formatDiagnostics([
    { severity: 'error', file: 'main.tex', line: 12, message: 'Undefined control sequence.', hint: '检查拼写', raw: '' },
  ])
  assert.match(out, /main\.tex:12/)
  assert.match(out, /Undefined control sequence/)
  assert.match(out, /检查拼写/)
})

test('formatDiagnostics: 没有文件信息时不输出裸冒号', () => {
  const out = formatDiagnostics([
    { severity: 'warning', file: null, line: null, message: 'LaTeX: 引用未解析', hint: null, raw: '' },
  ])
  assert.ok(!out.includes('null'))
})
