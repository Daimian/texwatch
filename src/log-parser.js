import path from 'node:path'

// -file-line-error 的错误行形态： ./main.tex:123: 消息
const FILE_LINE_ERROR = /^(.+?):(\d+):\s*(.*)$/
// 没有文件信息的裸错误行
const BARE_ERROR = /^!\s*(.*)$/
const MISSING_FILE = /File\s+[`'"]([^'"`]+)['"`]\s+not found/
const GRAPHIC_EXTS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.ps'])

function toRelative(file, root) {
  if (!file) return null
  const cleaned = file.replace(/^\.\//, '')
  if (path.isAbsolute(cleaned)) {
    const rel = path.relative(root, cleaned)
    return rel.startsWith('..') ? cleaned : rel
  }
  return cleaned
}

function hintFor(message) {
  const m = message.match(MISSING_FILE)
  if (!m) return null
  const missing = m[1]
  const ext = path.extname(missing).toLowerCase()

  if (GRAPHIC_EXTS.has(ext)) {
    return `找不到图片 ${missing}：确认文件存在且路径相对主文件正确`
  }
  if (ext === '.sty' || ext === '.cls' || ext === '') {
    const base = path.basename(missing, ext)
    return `sudo tlmgr install ${base}\n（若提示找不到该包，用 tlmgr search --global --file "/${base}${ext || '.sty'}" 查真实包名）`
  }
  return `找不到文件 ${missing}`
}

export function parseLog(rawLog, root) {
  const diagnostics = []
  const lines = rawLog.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fle = line.match(FILE_LINE_ERROR)
    if (fle && !line.startsWith('!')) {
      // 形如 ./main.tex:3: Undefined control sequence.
      const message = fle[3].trim()
      if (message) {
        diagnostics.push({
          severity: 'error',
          file: toRelative(fle[1], root),
          line: Number(fle[2]),
          message,
          hint: hintFor(message),
          raw: lines.slice(i, i + 3).join('\n'),
        })
        continue
      }
    }

    const bare = line.match(BARE_ERROR)
    if (bare && bare[1].trim()) {
      const message = bare[1].trim()
      diagnostics.push({
        severity: 'error',
        file: null,
        line: null,
        message,
        hint: hintFor(message),
        raw: lines.slice(i, i + 3).join('\n'),
      })
    }
  }

  return dedupe(diagnostics)
}

function dedupe(diags) {
  const seen = new Set()
  return diags.filter((d) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
