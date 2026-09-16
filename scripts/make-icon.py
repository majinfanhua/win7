#!/usr/bin/env python3
"""从「航科教育」logo 生成应用图标。

为什么用脚本裁切而不是手工导出：
  - 图标需要多尺寸（16 到 256），手工导出容易漏
  - 原图是**竖版**（火箭 + 中文 + 英文三行），直接缩放当图标会在
    16px 下糊成一团 —— 必须只取火箭那部分，且要留出视觉边距
  - 以后换 logo 只要替换 SOURCE 再跑一次

产物：
  build/icon.ico                     打包用（16/24/32/48/64/128/256）
  build/icon.png                     256 预览图
  resources/icon.png                 运行时窗口图标
  src/renderer/public/logo.png       界面左上角与关于页用的方形 logo
  src/renderer/public/favicon.png    浏览器预览时的页面图标

用法：python3 scripts/make-icon.py
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 原始 logo（竖版：火箭 / 中文 / 英文三行）。
# 用 LOGO_SOURCE=<路径> 换成别的图。
SOURCE = os.environ.get(
    'LOGO_SOURCE',
    os.path.join(ROOT, 'build', 'logo-source.png'),
)

# 火箭在竖版里的位置。数值是量出来的：
# 整体内容 bbox 是 (154, 201, 889, 874)，其中
#   火箭   y 204 - 640
#   中文   y 692 - 804
#   英文   y 828 - 876
# 只取火箭那一段 —— 带上文字的话，256px 下每个字只有几个像素，等于一团噪点。
ROCKET_BOX = (140, 190, 905, 655)

SIZE = 256
# 超采样倍数：在更大的画布上合成再缩，自带抗锯齿
SS = 4

# 图标底色。用 logo 自己的白底，不用界面主色 ——
# 这个 logo 是白底彩色的，套深色圆角底会让火箭的黑描边糊掉。
BG = (255, 255, 255, 255)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def load_rocket():
    """取火箭部分，等比放进正方形画布，四周留一点边距。"""
    if not os.path.exists(SOURCE):
        sys.exit(
            f'[icon] 找不到原图：{SOURCE}\n'
            '        把 logo 放到 build/logo-source.png，或用 LOGO_SOURCE=<路径> 指定。'
        )
    im = Image.open(SOURCE).convert('RGBA')
    rocket = im.crop(ROCKET_BOX)

    # 方形画布 + 留白。留白 8%：太小（贴边）在任务栏里会显得比别的图标大，
    # 太大则主体缩得太小、16px 下认不出。
    W = SIZE * SS
    pad = round(W * 0.08)
    inner = W - pad * 2

    rw, rh = rocket.size
    scale = min(inner / rw, inner / rh)
    new = (max(1, round(rw * scale)), max(1, round(rh * scale)))
    rocket = rocket.resize(new, Image.LANCZOS)

    canvas = Image.new('RGBA', (W, W), BG)
    canvas.paste(rocket, ((W - new[0]) // 2, (W - new[1]) // 2), rocket)
    return canvas


def main():
    canvas = load_rocket()
    base = canvas.resize((SIZE, SIZE), Image.LANCZOS)

    icon_png = os.path.join(ROOT, 'build', 'icon.png')
    icon_ico = os.path.join(ROOT, 'build', 'icon.ico')
    resources_png = os.path.join(ROOT, 'resources', 'icon.png')
    public_dir = os.path.join(ROOT, 'src', 'renderer', 'public')
    logo_png = os.path.join(public_dir, 'logo.png')
    favicon_png = os.path.join(public_dir, 'favicon.png')

    os.makedirs(os.path.dirname(icon_png), exist_ok=True)
    os.makedirs(os.path.dirname(resources_png), exist_ok=True)
    os.makedirs(public_dir, exist_ok=True)

    base.save(icon_png)
    base.save(resources_png)
    base.save(logo_png)
    base.save(favicon_png)

    # ICO 的每个尺寸单独缩，而不是让 PIL 从 256 往下抽 ——
    # 自动缩放对 16/24/32 这几个小尺寸质量一般，会明显发虚
    frames = [base.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    frames[-1].save(icon_ico, format='ICO', sizes=[(s, s) for s in ICO_SIZES])

    for path in (icon_png, icon_ico, resources_png, logo_png, favicon_png):
        print(f'[icon] {os.path.relpath(path, ROOT)}  {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
