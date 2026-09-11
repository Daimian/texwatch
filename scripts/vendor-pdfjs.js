// 把 pdfjs-dist（devDependency）里预览页需要的文件拷贝进 client/vendor/pdfjs/，
// 并作为 git 跟踪文件提交进仓库——离线是硬需求，不能依赖「先 npm install 再用」。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkgPath = path.dirname(require.resolve('pdfjs-dist/package.json'))
const dest = path.join(process.cwd(), 'client', 'vendor', 'pdfjs')

const COPY = [
  ['build/pdf.mjs', 'pdf.mjs'],
  ['build/pdf.worker.mjs', 'pdf.worker.mjs'],
]

await fs.rm(dest, { recursive: true, force: true })
await fs.mkdir(dest, { recursive: true })

for (const [from, to] of COPY) {
  await fs.copyFile(path.join(pkgPath, from), path.join(dest, to))
  console.log(`copied ${from} -> client/vendor/pdfjs/${to}`)
}

// standard_fonts 供部分 PDF（缺内嵌字体时）回退字体使用，一并内置以保证离线可用。
const fontsSrc = path.join(pkgPath, 'standard_fonts')
await fs.cp(fontsSrc, path.join(dest, 'standard_fonts'), { recursive: true })
console.log('copied standard_fonts/')
