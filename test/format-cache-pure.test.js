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
  assert.equal(formatName('main.tex'), 'texwatch-main')
  assert.equal(formatName('SI_test.tex'), 'texwatch-SI_test')
})

test('formatName 把路径分隔符和点换成安全字符', () => {
  const n = formatName('sub/dir/my.paper.tex')
  assert.ok(!n.includes('/'))
  assert.ok(!n.slice('texwatch-'.length).includes('.'))
})
