import crypto from 'node:crypto'
import path from 'node:path'
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
  const base = mainTexRelative
    .replace(/\.tex$/, '')
    .replace(/[/\\]/g, '-')
    .replace(/\./g, '-')
  return `texwatch-${base}`
}
