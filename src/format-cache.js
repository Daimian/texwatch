import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stripComments } from './config.js'
import { COMPILE_ENV } from './compiler.js'

export function extractPreamble(content) {
  const stripped = stripComments(content)
  const idx = stripped.indexOf('\\begin{document}')
  return idx === -1 ? '' : stripped.slice(0, idx)
}

export function preambleHash(preamble) {
  return crypto.createHash('sha256').update(preamble).digest('hex').slice(0, 16)
}

export function formatName(mainTexRelative) {
  // 移除 .tex 后缀
  const withoutExt = mainTexRelative.replace(/\.tex$/, '')

  // 清理字符：只保留 [A-Za-z0-9_-]，其余字符替换为 -
  let sanitized = withoutExt
    .replace(/[^A-Za-z0-9_\-]/g, '-')
    // 合并连续的 -
    .replace(/\-+/g, '-')
    // 移除首尾的 -
    .replace(/^\-+|\-+$/g, '')

  // 如果清理后为空（比如文件名全是非 ASCII 字符），使用 hash 作为名字
  if (!sanitized) {
    sanitized = crypto.createHash('sha256').update(mainTexRelative).digest('hex').slice(0, 12)
  }

  // 计算原始路径的 hash，用来消除碰撞
  const hash = crypto.createHash('sha256').update(mainTexRelative).digest('hex').slice(0, 8)

  return `texwatch-${sanitized}-${hash}`
}

const DUMP_TIMEOUT_MS = 60_000

function runDump({ cwd, fmtDir, name, mainTex }) {
  return new Promise((resolve) => {
    // mylatexformat 从主文件读取 preamble，dump 到 \begin{document} 为止
    const args = [
      '-ini',
      `-output-directory=${fmtDir}`,
      `-jobname=${name}`,
      '&pdflatex',
      'mylatexformat.ltx',
      mainTex,
    ]
    const child = spawn('pdflatex', args, {
      cwd,
      env: { ...process.env, ...COMPILE_ENV },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

/**
 * 把主文件的 preamble 预编译成 .fmt 二进制格式并缓存。
 *
 * 契约：任何失败都返回 null，绝不抛异常——加速机制坏了绝不能挡住编译。
 * draft 模式下直接返回 null：draft 与 fmt 是重叠的加速手段，同时用会让
 * latexmk 的调用方式变复杂（见 buildLatexmkArgs 里的对应分支）。
 */
export async function ensureFormat(config) {
  if (config.draft) return null

  try {
    const content = await fs.readFile(config.mainTex, 'utf8')
    const preamble = extractPreamble(content)
    if (!preamble) return null

    const name = formatName(config.mainTexRelative)
    const hash = preambleHash(preamble)
    const fmtFile = path.join(config.fmtDir, `${name}.fmt`)
    const hashFile = path.join(config.fmtDir, `${name}.hash`)

    const cachedHash = await fs.readFile(hashFile, 'utf8').catch(() => null)
    const fmtExists = await fs.stat(fmtFile).then(() => true).catch(() => false)
    if (cachedHash === hash && fmtExists) return name

    await fs.mkdir(config.fmtDir, { recursive: true })
    const ok = await runDump({
      cwd: config.root,
      fmtDir: config.fmtDir,
      name,
      mainTex: config.mainTex,
    })
    if (!ok) return null

    const produced = await fs.stat(fmtFile).then(() => true).catch(() => false)
    if (!produced) return null

    await fs.writeFile(hashFile, hash)
    return name
  } catch {
    // 加速机制坏了绝不能挡住编译
    return null
  }
}
