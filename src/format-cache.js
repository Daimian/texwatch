import crypto from 'node:crypto'
import { stripComments } from './config.js'

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
