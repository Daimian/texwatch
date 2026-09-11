// 滚动位置恢复：纯函数，不碰 DOM，只接收 [{offsetTop, offsetHeight}] 数组和
// 滚动位置做计算，这样可以在 node --test 里直接跑，不需要浏览器/jsdom。
//
// 用「视口顶部所在页号 + 页内相对偏移比例」而不是绝对 scrollTop：改一段文字
// 可能导致后面全部内容重新分页，绝对偏移会飘；「第 5 页的 30% 处」这种锚点，
// 重新分页后仍能落在语义上接近的位置。

export function captureAnchor(pages, scrollTop) {
  if (pages.length === 0) return { page: 0, ratio: 0 }

  let index = 0
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].offsetTop <= scrollTop) index = i
    else break
  }
  const page = pages[index]
  const ratio = page.offsetHeight > 0
    ? (scrollTop - page.offsetTop) / page.offsetHeight
    : 0
  return { page: index, ratio: Math.max(0, Math.min(1, ratio)) }
}

export function anchorToScrollTop(pages, anchor) {
  if (pages.length === 0) return 0
  const index = Math.max(0, Math.min(anchor.page, pages.length - 1))
  const page = pages[index]
  return page.offsetTop + page.offsetHeight * anchor.ratio
}
