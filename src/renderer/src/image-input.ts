import type { ChatContentBlock } from '@shared/types'

/**
 * 图片压缩：把用户选的 / 粘的图缩到模型能接受的尺寸再发出去。
 *
 * ## 为什么必须压缩
 *
 * 手机截图动辄 3000×2000、两三 MB。多模态模型的输入按**图像块**计费，
 * 原图直接发有两个后果：token 消耗是压缩后的十几倍，而且上传慢 ——
 * 校园网下等十几秒才发出去，学生会以为卡死了。
 *
 * 压缩后同样一张图通常能到 100~200 KB，而屏幕截图的内容（文字、报错信息）
 * 在这个尺寸下仍然清晰可读。
 *
 * ## 参数怎么定的
 *
 * - **长边 1568px**：这是 Anthropic 官方文档给出的推荐上限
 *   （超过后模型会自己缩小，等于白传）；OpenAI 的 2048 更宽松，
 *   取两者较小的更稳妥
 * - **JPEG 质量 0.8**：再高体积涨得比清晰度快，再低文字边缘会出现
 *   明显的振铃，截图里的报错信息会糊
 * - **PNG 转 JPEG**：截图存 PNG 是常见格式，但照片类内容 PNG 体积巨大。
 *   统一转 JPEG 能省一个数量级。代价是透明背景会变成黑底 ——
 *   所以先用白底铺一层（见下）
 *
 * ## 为什么用 canvas 而不是主进程的 nativeImage
 *
 * 渲染进程本来就有 canvas，不需要往主进程传几 MB 的 base64 再传回来。
 * 整个压缩在渲染层完成，发出去的就已经是小图。
 */

/** 长边上限。见文件头注释 */
const MAX_EDGE = 1568
/** JPEG 质量 */
const QUALITY = 0.8
/** 压缩后超过这个字节数就再压一轮（降质量），避免个别图仍然过大 */
const TARGET_BYTES = 900 * 1024

export interface CompressedImage {
  /** data:image/jpeg;base64,... —— 可直接放进 image_url.url */
  dataUrl: string
  /** 压缩前的字节数 */
  originalBytes: number
  /** 压缩后的字节数 */
  bytes: number
  width: number
  height: number
}

/** 估算一个 dataURL 的字节数（base64 是 4/3 膨胀） */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((body.length * 3) / 4)
}

/** 读一个 File / Blob 成 dataURL */
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 解码成 HTMLImageElement */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这张图片无法解码，可能已损坏或格式不支持'))
    img.src = dataUrl
  })
}

/**
 * 按长边上限算缩放后的尺寸。
 *
 * 不放大：小图（比如 200×200 的图标）保持原样 —— 放大只会变糊且更占体积。
 */
export function fitSize(width: number, height: number, maxEdge = MAX_EDGE): { w: number; h: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { w: width, h: height }
  const ratio = maxEdge / longest
  return { w: Math.max(1, Math.round(width * ratio)), h: Math.max(1, Math.round(height * ratio)) }
}

/**
 * 压缩一张图。
 *
 * 两轮：先按 0.8 质量压一次；如果结果仍然超过 TARGET_BYTES，
 * 再降到 0.6 压一轮。个别细节极多的截图（整屏代码）第一轮可能压不下来。
 */
export async function compressImage(file: Blob): Promise<CompressedImage> {
  const original = await readAsDataUrl(file)
  const img = await loadImage(original)

  const { w, h } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布，图片压缩失败')

  /*
   * 先铺白底。
   *
   * JPEG 没有透明通道，把带透明背景的 PNG（图标、截图工具截的圆角图）
   * 直接转 JPEG 会让透明区域变成**黑色**，看起来像图坏了。
   * 铺一层白底是最符合直觉的处理（截图工具里透明一般就是白色）。
   */
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  // 缩小用 high 质量：低质量插值会让截图里的文字出现锯齿，反而不如不缩
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)

  let dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
  if (dataUrlBytes(dataUrl) > TARGET_BYTES) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.6)
  }

  return {
    dataUrl,
    originalBytes: dataUrlBytes(original),
    bytes: dataUrlBytes(dataUrl),
    width: w,
    height: h
  }
}

/**
 * 把若干张压缩后的图拼成消息内容块。
 *
 * 顺序：文本在前、图片在后。模型读到的是「用户说了什么 → 附带这些图」，
 * 反过来的话它可能把图片当成上一轮的上下文。
 */
export function withImages(
  text: string,
  images: Array<{ dataUrl: string }>
): ChatContentBlock[] {
  const blocks: ChatContentBlock[] = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const image of images) {
    blocks.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  return blocks
}

/** 人类可读的体积，用于界面提示 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
