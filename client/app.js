// 预览页渲染逻辑：pdf.js 渲染 + WebSocket 状态处理。
//
// pdf.js API 说明（针对内置的 pdfjs-dist v6.3.289，实测查证 node_modules/pdfjs-dist/
// build/pdf.mjs 里 PDFPageProxy#render 的参数处理，而非照抄旧版文档/教程）：
//   render({ canvas, viewport })
// v6.3.289 的 render() 仍然接受 `canvasContext` 参数（并未移除), 但推荐、更直接的
// 写法是直接传 `canvas`——pdf.js 内部会自己用 canvas.getContext('2d', {...}) 取上下文
// （见 pdf.mjs 里 InternalRenderTask#initializeGraphics）。这里用 `canvas` 形式。
import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'

const pagesEl = document.getElementById('pages')
const statusEl = document.getElementById('status')
const summaryEl = document.getElementById('summary')
const staleEl = document.getElementById('stale')
const diagEl = document.getElementById('diagnostics')
const draftEl = document.getElementById('draft')

let renderedVersion = -1
const scale = 1.4
let ws = null

async function renderPdf() {
  const doc = await pdfjsLib.getDocument({
    url: `/pdf?v=${Date.now()}`,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise

  const dpr = window.devicePixelRatio || 1
  const frag = document.createDocumentFragment()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    canvas.style.width = `${viewport.width / dpr}px`
    canvas.dataset.page = String(n)
    await page.render({ canvas, viewport }).promise
    frag.appendChild(canvas)
  }

  pagesEl.replaceChildren(frag)
}

function renderStatus(msg) {
  statusEl.className = msg.state === 'compiling' || msg.state === 'queued' ? 'compiling' : msg.state
  const secs = msg.durationMs ? `${(msg.durationMs / 1000).toFixed(1)}s` : ''
  const label = {
    idle: '空闲',
    compiling: '编译中…',
    queued: '编译中（有新改动排队）…',
    ok: `编译成功 ${secs}`,
    error: `编译失败 ${secs}`,
  }[msg.state] ?? msg.state
  summaryEl.textContent = label
  staleEl.textContent = msg.pdfStale ? '⚠︎ 当前 PDF 不是最新源码' : ''
  draftEl.checked = !!msg.draft

  diagEl.replaceChildren(
    ...(msg.diagnostics ?? []).map((d) => {
      const div = document.createElement('div')
      div.className = `diag ${d.severity}`
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}  ` : ''
      const locSpan = document.createElement('span')
      locSpan.className = 'loc'
      locSpan.textContent = loc
      const msgSpan = document.createElement('span')
      msgSpan.className = 'msg'
      msgSpan.textContent = d.message
      div.append(locSpan, msgSpan)
      if (d.hint) {
        const hint = document.createElement('div')
        hint.className = 'hint'
        hint.textContent = `→ ${d.hint}`
        div.appendChild(hint)
      }
      return div
    })
  )
}

async function onMessage(msg) {
  renderStatus(msg)
  // 只有 pdfVersion 真正变化才重新拉取/渲染 PDF——否则每条状态消息（哪怕只是
  // "编译中"）都会触发一次 getDocument + 全页重绘，白白闪烁。pdfVersion 为 0
  // 表示还没有编译成功过一次，此时 /pdf 还不存在，不必请求。
  if (msg.pdfVersion !== renderedVersion && msg.pdfVersion > 0) {
    renderedVersion = msg.pdfVersion
    try {
      await renderPdf()
    } catch (err) {
      console.error('渲染 PDF 失败', err)
    }
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`)
  // 必须在 `new WebSocket(...)` 之后同步挂上 onmessage，不能先 await 连接建立
  // （比如等 onopen 或者一个 "open" Promise）再挂监听器。服务端在
  // wss.on('connection') 里同步发送第一条完整状态，如果客户端挂监听器慢了一拍，
  // 这条消息会永久丢失，刷新页面就会白屏，要等下一次编译才有内容。
  ws.onmessage = (e) => onMessage(JSON.parse(e.data))
  ws.onerror = (err) => console.error('WebSocket 错误', err)
}

draftEl.addEventListener('change', () => {
  ws?.send(JSON.stringify({ type: 'setDraft', value: draftEl.checked }))
})

connect()
