import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPreamble, preambleHash, formatName } from '../src/format-cache.js'

const DOC = `\\documentclass{elsarticle}
\\usepackage{amsmath}
\\begin{document}
body text
\\end{document}
`

test('extractPreamble 只取 begin{document} 之前的内容', () => {
  const p = extractPreamble(DOC)
  assert.match(p, /documentclass/)
  assert.match(p, /amsmath/)
  assert.ok(!p.includes('body text'))
  assert.ok(!p.includes('begin{document}'))
})

test('没有 begin{document} 时返回空串', () => {
  assert.equal(extractPreamble('\\documentclass{article}\n'), '')
})

test('preambleHash 对相同输入稳定', () => {
  assert.equal(preambleHash('abc'), preambleHash('abc'))
})

test('preambleHash 对不同输入不同', () => {
  assert.notEqual(preambleHash('abc'), preambleHash('abd'))
})

test('只改正文不改 preamble 时 hash 不变', () => {
  const doc2 = DOC.replace('body text', '完全不同的正文')
  assert.equal(preambleHash(extractPreamble(DOC)), preambleHash(extractPreamble(doc2)))
})

test('改了宏包时 hash 变化', () => {
  const doc2 = DOC.replace('amsmath', 'amssymb')
  assert.notEqual(preambleHash(extractPreamble(DOC)), preambleHash(extractPreamble(doc2)))
})

test('formatName 从主文件名生成合法的 format 名', () => {
  const n1 = formatName('main.tex')
  const n2 = formatName('SI_test.tex')
  // 应以 texwatch- 开头，以 hash 后缀结尾
  assert.match(n1, /^texwatch-main-[0-9a-f]{8}$/)
  assert.match(n2, /^texwatch-SI_test-[0-9a-f]{8}$/)
})

test('formatName 把路径分隔符和点换成安全字符', () => {
  const n = formatName('sub/dir/my.paper.tex')
  assert.ok(!n.includes('/'))
  // 格式应为 texwatch-<安全字符>-<hash>
  assert.match(n, /^texwatch-.+-[0-9a-f]{8}$/)
  // 中间部分（texwatch- 和 hash 之间）不应包含点
  const middle = n.replace(/^texwatch-/, '').replace(/-[0-9a-f]{8}$/, '')
  assert.ok(!middle.includes('.'))
})

test('preamble 里有被注释掉的 \\begin{document} 出现在真实那行之前时，抽取到的内容仍包含真实 preamble 的全部宏包声明', () => {
  const docWithCommented = `\\documentclass{elsarticle}
% \\begin{document}
\\usepackage{amsmath}
\\begin{document}
body text
\\end{document}
`
  const p = extractPreamble(docWithCommented)
  assert.match(p, /documentclass/)
  assert.match(p, /amsmath/)
  assert.ok(!p.includes('body text'))
})

test('在被注释掉的 \\begin{document} 出现在真实那行之前的场景下，把某个宏包名改掉时，preambleHash 必须变化', () => {
  const docWithCommented = `\\documentclass{elsarticle}
% \\begin{document}
\\usepackage{amsmath}
\\begin{document}
body text
\\end{document}
`
  const docWithModified = docWithCommented.replace('amsmath', 'amssymb')
  const hash1 = preambleHash(extractPreamble(docWithCommented))
  const hash2 = preambleHash(extractPreamble(docWithModified))
  assert.notEqual(hash1, hash2)
})

test('只修改 preamble 里的注释文字时，preambleHash 不变', () => {
  const doc1 = `\\documentclass{elsarticle}
% old comment
\\usepackage{amsmath}
\\begin{document}
body
\\end{document}
`
  const doc2 = `\\documentclass{elsarticle}
% completely different comment text
\\usepackage{amsmath}
\\begin{document}
body
\\end{document}
`
  assert.equal(preambleHash(extractPreamble(doc1)), preambleHash(extractPreamble(doc2)))
})

test('转义的 \\% 不应被当作注释起点', () => {
  const docWithEscaped = `\\documentclass{elsarticle}
\\usepackage{amsmath} % 这是注释
100\\% sure % 这也是注释
\\begin{document}
body
\\end{document}
`
  const p = extractPreamble(docWithEscaped)
  // 应该包含 amsmath，不应包含 body
  assert.match(p, /amsmath/)
  assert.ok(!p.includes('body'))
  // 在 % sure 之前不应被截断，但之后的注释应该被去掉
  const lines = p.split('\n')
  const percentLine = lines.find(l => l.includes('100\\% sure'))
  assert.ok(percentLine)
  assert.ok(!percentLine.includes('这也是注释'))
})

test('formatName 消除点和斜杠碰撞（a.b.tex 与 a/b.tex 应不同）', () => {
  const n1 = formatName('a.b.tex')
  const n2 = formatName('a/b.tex')
  assert.notEqual(n1, n2)
})

test('formatName 消除空格和横杠碰撞（a b.tex 与 a-b.tex 应不同）', () => {
  const n1 = formatName('a b.tex')
  const n2 = formatName('a-b.tex')
  assert.notEqual(n1, n2)
})

test('formatName 结果只含 [A-Za-z0-9_-]，无 shell 元字符', () => {
  // 测试各种危险字符
  const testCases = [
    'file with spaces.tex',
    'file`whoami`.tex',
    'file$var.tex',
    'file;cmd.tex',
    'file|pipe.tex',
    'file&bg.tex',
    "file'quote.tex",
    'file"quote.tex',
    'file\nnewline.tex',
  ]
  for (const path of testCases) {
    const result = formatName(path)
    // 应该只包含 [A-Za-z0-9_-]
    assert.match(result, /^texwatch-[A-Za-z0-9_-]+-[0-9a-f]{8}$/, `formatName('${path}') should be safe`)
  }
})

test('formatName 确定性：同一输入多次调用结果相同', () => {
  const inputs = ['main.tex', 'sub/dir/file.tex', 'path with spaces.tex']
  for (const input of inputs) {
    const result1 = formatName(input)
    const result2 = formatName(input)
    const result3 = formatName(input)
    assert.equal(result1, result2, `formatName('${input}') should be deterministic`)
    assert.equal(result2, result3, `formatName('${input}') should be deterministic`)
  }
})

test('formatName 支持非 ASCII 文件名，产出合法名字', () => {
  const names = [
    '论文.tex',
    'papier français.tex',
    '日本語.tex',
    '🎉emoji🎊.tex',
  ]
  for (const name of names) {
    const result = formatName(name)
    // 应该以 texwatch- 开头，以 hash 结尾，中间只有 [A-Za-z0-9_-]
    assert.match(result, /^texwatch-[A-Za-z0-9_-]+-[0-9a-f]{8}$/, `formatName('${name}') should produce safe name`)
  }
})
