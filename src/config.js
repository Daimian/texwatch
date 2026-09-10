// 去掉行内注释后再判断，避免把被注释掉的 \documentclass 当真
function stripComments(content) {
  return content
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n')
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
