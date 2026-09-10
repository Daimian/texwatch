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

test('--port 缺值时抛错', () => {
  assert.throws(() => parseArgv(['--port']), /port/i)
})

test('--port 值非数字时抛错', () => {
  assert.throws(() => parseArgv(['--port', 'abc']), /port/i)
})

test('--port 后面跟开关时抛错，不把开关当成端口值', () => {
  assert.throws(() => parseArgv(['--port', '--draft']), /port/i)
})

test('--port 合法值正常解析', () => {
  assert.equal(parseArgv(['--port', '4000']).port, 4000)
})

test('多个位置参数抛错', () => {
  assert.throws(() => parseArgv(['a.tex', 'b.tex']), /只能指定一个主文件/)
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

test('formatDiagnostics: 多行 hint 的续行保持缩进，不与下一条诊断混在一起', () => {
  // hint 本身不带任何前导空格——续行的缩进必须完全由 formatDiagnostics 加上，
  // 而不是碰巧借了 hint 文本自带的空格。
  const out = formatDiagnostics([
    {
      severity: 'error',
      file: 'main.tex',
      line: 3,
      message: '找不到宏包 foo.sty',
      hint: 'sudo tlmgr install foo\n（若提示找不到该包，用 tlmgr search 查真实包名）',
      raw: '',
    },
    { severity: 'warning', file: 'main.tex', line: 9, message: 'Overfull hbox', hint: null, raw: '' },
  ])
  const lines = out.split('\n')
  const continuationIndex = lines.findIndex((l) => l.includes('若提示找不到该包'))
  assert.ok(continuationIndex > 0)
  // 续行要跟带箭头的第一行对齐缩进，不能顶格输出
  assert.ok(/^\s/.test(lines[continuationIndex]))
  assert.equal(lines[continuationIndex].match(/^\s*/)[0].length, '       → '.length)
})
