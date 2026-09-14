#!/usr/bin/env python3
"""生成应用图标。

为什么用脚本画而不是丢一个 png 进仓库：
  - 图标需要多尺寸（16 到 256），手工导出容易漏
  - 以后想调颜色 / 改符号，改几行重跑一次即可

产物：
  build/icon.ico                     打包用（16/24/32/48/64/128/256）
  build/icon.png                     256 预览图
  resources/icon.png                 运行时窗口图标
  src/renderer/public/favicon.png    浏览器预览时的页面图标

用法：python3 scripts/make-icon.py
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SIZE = 256
SS = 4  # 超采样倍数：在 4 倍画布上画完再缩，自带抗锯齿
W = SIZE * SS

# 和界面主色一致（--accent / --accent-2）
C1 = (91, 157, 255)  # #5B9DFF
C2 = (124, 108, 255)  # #7C6CFF

RADIUS = round(W * 0.22)
STROKE = round(W * 0.065)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def gradient(w, h, c1, c2):
    """对角渐变。用 2x2 底图放大，比逐像素循环快得多。"""
    mid = tuple((a + b) // 2 for a, b in zip(c1, c2))
    small = Image.new('RGB', (2, 2))
    small.putpixel((0, 0), c1)
    small.putpixel((1, 0), mid)
    small.putpixel((0, 1), mid)
    small.putpixel((1, 1), c2)
    return small.resize((w, h), Image.BILINEAR)


def rounded_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_symbol(img):
    """画 </> —— 用线段而不是字体，免得受系统字体影响。

    坐标基于超采样后的画布 W（即 1024），不是最终尺寸 256。
    """
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    half = STROKE / 2

    def stroke(x1, y1, x2, y2):
        d.line([(x1, y1), (x2, y2)], fill=white, width=STROKE)
        # 两端补圆，做出圆头效果（PIL 的线默认是平头）
        for cx, cy in ((x1, y1), (x2, y2)):
            d.ellipse([cx - half, cy - half, cx + half, cy + half], fill=white)

    # <
    stroke(375, 296, 200, 512)
    stroke(200, 512, 375, 728)
    # /
    stroke(450, 752, 574, 272)
    # >
    stroke(649, 296, 824, 512)
    stroke(824, 512, 649, 728)


def main():
    base = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    base.paste(gradient(W, W, C1, C2).convert('RGBA'), (0, 0), rounded_mask(W, RADIUS))
    draw_symbol(base)

    icon = base.resize((SIZE, SIZE), Image.LANCZOS)

    build_dir = os.path.join(ROOT, 'build')
    res_dir = os.path.join(ROOT, 'resources')
    pub_dir = os.path.join(ROOT, 'src', 'renderer', 'public')
    for d in (build_dir, res_dir, pub_dir):
        os.makedirs(d, exist_ok=True)

    icon.save(os.path.join(build_dir, 'icon.png'))
    icon.save(os.path.join(build_dir, 'icon.ico'), sizes=[(s, s) for s in ICO_SIZES])
    icon.save(os.path.join(res_dir, 'icon.png'))
    icon.resize((64, 64), Image.LANCZOS).save(os.path.join(pub_dir, 'favicon.png'))

    print('icon.png  ', os.path.join(build_dir, 'icon.png'))
    print('icon.ico  ', os.path.join(build_dir, 'icon.ico'), f'({len(ICO_SIZES)} 个尺寸)')
    print('resources ', os.path.join(res_dir, 'icon.png'))
    print('favicon   ', os.path.join(pub_dir, 'favicon.png'))


if __name__ == '__main__':
    main()
