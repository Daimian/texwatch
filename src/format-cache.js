import crypto from 'node:crypto'
import path from 'node:path'

export function extractPreamble(content) {
  const idx = content.indexOf('\\begin{document}')
  return idx === -1 ? '' : content.slice(0, idx)
}

export function preambleHash(preamble) {
  return crypto.createHash('sha256').update(preamble).digest('hex').slice(0, 16)
}

export function formatName(mainTexRelative) {
  const base = mainTexRelative
    .replace(/\.tex$/, '')
    .replace(/[/\\]/g, '-')
    .replace(/\./g, '-')
  return `texwatch-${base}`
}
