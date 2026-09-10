import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { classify, shouldWatch } from '../src/watcher.js'

const config = {
  root: '/proj',
  mainTex: '/proj/main.tex',
  preambleEndLine: 58,
  watchExtensions: ['.tex', '.bib', '.cls', '.bst', '.png', '.jpg', '.pdf'],
  ignoreDirs: ['.texwatch', '.git'],
}

const configWithSty = {
  root: '/proj',
  mainTex: '/proj/main.tex',
  preambleEndLine: 58,
  watchExtensions: ['.tex', '.bib', '.cls', '.bst', '.sty', '.png', '.jpg', '.pdf'],
  ignoreDirs: ['.texwatch', '.git'],
}

test('主文件、改动行在 preamble 内 → preamble', () => {
  assert.equal(classify('/proj/main.tex', { config, changedLine: 20 }), 'preamble')
})

test('主文件、改动行在正文 → tex', () => {
  assert.equal(classify('/proj/main.tex', { config, changedLine: 200 }), 'tex')
})

test('主文件、不知道改哪行 → 保守当作 preamble', () => {
  assert.equal(classify('/proj/main.tex', { config }), 'preamble')
})

test('.bib → bib', () => {
  assert.equal(classify('/proj/main.bib', { config }), 'bib')
})

test('非主文件的 .tex → tex', () => {
  assert.equal(classify('/proj/SI.tex', { config }), 'tex')
})

test('.cls 和 .bst → tex', () => {
  assert.equal(classify('/proj/elsarticle.cls', { config }), 'tex')
  assert.equal(classify('/proj/MSP.bst', { config }), 'tex')
})

test('图片 → asset', () => {
  assert.equal(classify('/proj/Figure1.png', { config }), 'asset')
  assert.equal(classify('/proj/bio.jpg', { config }), 'asset')
})

test('不认识的扩展名 → null', () => {
  assert.equal(classify('/proj/notes.md', { config }), null)
})

test('.texwatch 下的文件 → null（否则编译产物会触发自己）', () => {
  assert.equal(classify('/proj/.texwatch/build/main.pdf', { config }), null)
  assert.equal(classify('/proj/.texwatch/build/main.tex', { config }), null)
})

test('shouldWatch 与 classify 的判定一致', () => {
  assert.equal(shouldWatch('/proj/main.tex', config), true)
  assert.equal(shouldWatch('/proj/notes.md', config), false)
  assert.equal(shouldWatch('/proj/.texwatch/build/main.pdf', config), false)
})

test('.sty 宏包 → tex', () => {
  assert.equal(classify('/proj/mymacro.sty', { config: configWithSty }), 'tex')
})

test('主文件、改动行恰好在 preambleEndLine → preamble', () => {
  assert.equal(classify('/proj/main.tex', { config, changedLine: 58 }), 'preamble')
})

test('ignoreDirs 的反例：my.git-notes 或 not-node_modules 不应被忽略', () => {
  const cfgWithPaths = {
    ...config,
    ignoreDirs: ['node_modules', '.git'],
  }
  assert.equal(classify('/proj/my.git-notes/file.tex', { config: cfgWithPaths }), 'tex')
  assert.equal(classify('/proj/not-node_modules/file.tex', { config: cfgWithPaths }), 'tex')
})

test('传入相对路径时按 config.root 解析', () => {
  const cfgForRelative = {
    root: '/proj',
    mainTex: '/proj/main.tex',
    preambleEndLine: 58,
    watchExtensions: ['.tex', '.bib'],
    ignoreDirs: ['.texwatch'],
  }
  // 相对路径应该按 config.root 解析为绝对路径后再判断
  assert.equal(classify('main.tex', { config: cfgForRelative }), 'preamble')
  assert.equal(classify('SI.tex', { config: cfgForRelative }), 'tex')
  assert.equal(classify('.texwatch/build/main.pdf', { config: cfgForRelative }), null)
})
