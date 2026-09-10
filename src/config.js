import fs from 'node:fs/promises'
import path from 'node:path'

// 去掉行内注释后再判断，避免把被注释掉的 \documentclass 当真。
// LaTeX 规则：% 前面连续反斜杠个数为奇数时，% 被转义（真百分号）；
// 为偶数（含 0）时，% 启动注释，该行从这里截断。
function stripCommentFromLine(line) {
  let backslashRun = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      backslashRun++
      continue
    }
    if (ch === '%' && backslashRun % 2 === 0) {
      return line.slice(0, i)
    }
    backslashRun = 0
  }
  return line
}

function stripComments(content) {
  return content.split('\n').map(stripCommentFromLine).join('\n')
}

export function isMainCandidate(content) {
  const src = stripComments(content)
  return /\\documentclass/.test(src) && /\\begin\{document\}/.test(src)
}

export function findPreambleEndLine(content) {
  const lines = stripComments(content).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/\\begin\{document\}/.test(lines[i])) return i + 1
  }
  return null
}

export function pickMain({ cliArg, rcMain, candidates }) {
  if (cliArg) return cliArg
  if (rcMain) return rcMain
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) {
    throw new Error('没有找到主文件：当前目录下没有同时包含 \\documentclass 和 \\begin{document} 的 .tex')
  }
  const err = new Error(
    `找到多个可能的主文件，请显式指定，例如 texwatch ${candidates[0]}\n候选：${candidates.join(', ')}`
  )
  err.candidates = candidates
  throw err
}

const DEFAULTS = {
  port: 3577,
  draft: false,
  watchExtensions: ['.tex', '.bib', '.cls', '.bst', '.sty', '.png', '.jpg', '.jpeg', '.pdf', '.eps'],
  ignoreDirs: ['.texwatch', '.git', 'node_modules'],
}

async function readRc(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, '.texwatchrc.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function scanCandidates(root, ignoreDirs) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const found = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.tex')) continue
    const content = await fs.readFile(path.join(root, e.name), 'utf8')
    if (isMainCandidate(content)) found.push(e.name)
  }
  return found.sort()
}

export async function resolveConfig({ cwd, cliArg = null, cliPort = null, cliDraft = null }) {
  const root = path.resolve(cwd)
  const rc = await readRc(root)

  const ignoreDirs = rc.ignore ?? DEFAULTS.ignoreDirs
  const watchExtensions = rc.watch ?? DEFAULTS.watchExtensions
  const candidates = await scanCandidates(root, ignoreDirs)
  const mainTexRelative = pickMain({ cliArg, rcMain: rc.main ?? null, candidates })
  const mainTex = path.join(root, mainTexRelative)

  const content = await fs.readFile(mainTex, 'utf8')
  const preambleEndLine = findPreambleEndLine(content)
  if (preambleEndLine === null) {
    throw new Error(`${mainTexRelative} 里找不到 \\begin{document}，它不像是一个主文件`)
  }

  const draft = cliDraft ?? rc.draft ?? DEFAULTS.draft
  const base = path.join(root, '.texwatch')

  return {
    root,
    mainTex,
    mainTexRelative,
    preambleEndLine,
    outDir: path.join(base, draft ? 'build-draft' : 'build'),
    fmtDir: path.join(base, 'fmt'),
    lastGoodPdf: path.join(base, draft ? 'last-good-draft.pdf' : 'last-good.pdf'),
    port: cliPort ?? rc.port ?? DEFAULTS.port,
    draft,
    watchExtensions,
    ignoreDirs,
  }
}
