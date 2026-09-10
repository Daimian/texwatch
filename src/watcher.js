import path from 'node:path'

const TEX_LIKE = new Set(['.tex', '.cls', '.bst', '.sty'])
const ASSET = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.ps'])

function isIgnored(absPath, config) {
  const rel = path.relative(config.root, absPath)
  if (rel.startsWith('..')) return true
  return rel.split(path.sep).some((seg) => config.ignoreDirs.includes(seg))
}

export function classify(absPath, { config, changedLine }) {
  const fullPath = path.resolve(config.root, absPath)
  if (isIgnored(fullPath, config)) return null

  const ext = path.extname(fullPath).toLowerCase()
  if (!config.watchExtensions.includes(ext)) return null

  if (ext === '.bib') return 'bib'

  if (fullPath === path.resolve(config.mainTex)) {
    // 拿不到具体行号时保守当作 preamble：宁可多 dump 一次 fmt，
    // 也不能用过期的 fmt 编出错误结果
    if (changedLine === undefined) return 'preamble'
    return changedLine <= config.preambleEndLine ? 'preamble' : 'tex'
  }

  if (TEX_LIKE.has(ext)) return 'tex'
  if (ASSET.has(ext)) return 'asset'
  return null
}

export function shouldWatch(absPath, config) {
  // shouldWatch 是否需要处理相对路径取决于 classify 的处理
  // classify 已经处理了相对路径的情况
  return classify(absPath, { config }) !== null
}
