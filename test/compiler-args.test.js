import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLatexmkArgs, COMPILE_ENV } from '../src/compiler.js'

const cfg = {
  mainTex: '/proj/main.tex',
  outDir: '/proj/.texwatch/build',
  draft: false,
}

test('基础参数：pdf 引擎、非交互、file-line-error、输出目录', () => {
  const args = buildLatexmkArgs({ config: cfg, kind: 'tex', fmtName: null })
  assert.ok(args.includes('-pdf'))
  assert.ok(args.includes('-interaction=nonstopmode'))
  assert.ok(args.includes('-file-line-error'))
  assert.ok(args.includes('-outdir=/proj/.texwatch/build'))
  assert.equal(args.at(-1), '/proj/main.tex', '主文件必须是最后一个参数')
})

test('普通改动用 -bibtex-cond，让 latexmk 自己判断要不要跑 bibtex', () => {
  const args = buildLatexmkArgs({ config: cfg, kind: 'tex', fmtName: null })
  assert.ok(args.includes('-bibtex-cond'))
  assert.ok(!args.includes('-g'))
})

test('bib 改动强制跑 bibtex 并强制全量', () => {
  const args = buildLatexmkArgs({ config: cfg, kind: 'bib', fmtName: null })
  assert.ok(args.includes('-bibtex'))
  assert.ok(args.includes('-g'))
})

test('preamble 改动强制全量', () => {
  const args = buildLatexmkArgs({ config: cfg, kind: 'preamble', fmtName: null })
  assert.ok(args.includes('-g'))
})

test('draft 模式注入 graphicx draft，且不注入 fmt', () => {
  const draftCfg = { ...cfg, draft: true, outDir: '/proj/.texwatch/build-draft' }
  const args = buildLatexmkArgs({ config: draftCfg, kind: 'tex', fmtName: 'texwatch-main' })
  assert.ok(args.some((a) => a.includes('-usepretex=') && a.includes('\\PassOptionsToPackage{draft}{graphicx}')))
  assert.ok(!args.some((a) => a.includes('texwatch-main')), 'draft 模式下不使用 fmt')
})

test('非 draft 且有 fmt 时，通过 -pdflatex 注入 &format', () => {
  const args = buildLatexmkArgs({ config: cfg, kind: 'tex', fmtName: 'texwatch-main' })
  const pdflatexArg = args.find((a) => a.startsWith('-pdflatex='))
  assert.ok(pdflatexArg, '应该有 -pdflatex= 参数')
  assert.match(pdflatexArg, /&texwatch-main/)
})

test('COMPILE_ENV 关掉 TeX 的折行，日志才可解析', () => {
  assert.equal(COMPILE_ENV.max_print_line, '10000')
  assert.equal(COMPILE_ENV.error_line, '254')
  assert.equal(COMPILE_ENV.half_error_line, '238')
})

test('始终带 -f：出错也跑完，以便产出可用的 PDF', () => {
  for (const kind of ['tex', 'bib', 'preamble', 'asset', 'full']) {
    const args = buildLatexmkArgs({ config: cfg, kind, fmtName: null })
    assert.ok(args.includes('-f'), `kind=${kind} 时应包含 -f`)
  }
})
