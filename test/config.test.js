import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMainCandidate, findPreambleEndLine, pickMain } from '../src/config.js'

test('isMainCandidate: 同时有 documentclass 和 begin{document} 才算', () => {
  assert.equal(isMainCandidate('\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}'), true)
  assert.equal(isMainCandidate('\\documentclass{article}\n% 没有 begin document'), false)
  assert.equal(isMainCandidate('\\section{被 input 的片段}'), false)
})

test('isMainCandidate: 注释掉的 documentclass 不算', () => {
  assert.equal(isMainCandidate('% \\documentclass{article}\n\\begin{document}\n\\end{document}'), false)
})

test('findPreambleEndLine: 返回 begin{document} 的 1-based 行号', () => {
  const content = '\\documentclass{elsarticle}\n\\usepackage{amsmath}\n\\begin{document}\nbody\n'
  assert.equal(findPreambleEndLine(content), 3)
})

test('findPreambleEndLine: 没有 begin{document} 返回 null', () => {
  assert.equal(findPreambleEndLine('\\documentclass{article}\n'), null)
})

test('pickMain: CLI 参数优先级最高', () => {
  const got = pickMain({ cliArg: 'SI.tex', rcMain: 'main.tex', candidates: ['main.tex', 'SI.tex'] })
  assert.equal(got, 'SI.tex')
})

test('pickMain: 没有 CLI 参数时用 rc 里的 main', () => {
  const got = pickMain({ cliArg: null, rcMain: 'main.tex', candidates: ['main.tex', 'SI.tex'] })
  assert.equal(got, 'main.tex')
})

test('pickMain: 只有一个候选时直接用它', () => {
  const got = pickMain({ cliArg: null, rcMain: null, candidates: ['paper.tex'] })
  assert.equal(got, 'paper.tex')
})

test('pickMain: 多个候选且没有指定时抛错并带上候选列表', () => {
  assert.throws(
    () => pickMain({ cliArg: null, rcMain: null, candidates: ['main.tex', 'SI.tex', 'template.tex'] }),
    (err) => {
      assert.match(err.message, /多个/)
      assert.deepEqual(err.candidates, ['main.tex', 'SI.tex', 'template.tex'])
      return true
    }
  )
})

test('pickMain: 一个候选都没有时抛错', () => {
  assert.throws(() => pickMain({ cliArg: null, rcMain: null, candidates: [] }), /没有找到/)
})

test('isMainCandidate: \\% 是转义百分号，不启注释', () => {
  const doc = '\\documentclass{article}\n100\\% 完成 \\begin{document}\n\\end{document}'
  assert.equal(isMainCandidate(doc), true)
})

test('findPreambleEndLine: \\\\ 后紧跟 % 是真注释，其后的 begin{document} 不算', () => {
  const doc = '\\documentclass{article}\nline\\\\%\\begin{document}\n\\begin{document}\nbody'
  assert.equal(findPreambleEndLine(doc), 3)
})

test('findPreambleEndLine: 三个反斜杠后的 % 仍是转义，该行的 begin{document} 生效', () => {
  const doc = '\\documentclass{article}\nx\\\\\\%y \\begin{document}\nbody'
  assert.equal(findPreambleEndLine(doc), 2)
})
