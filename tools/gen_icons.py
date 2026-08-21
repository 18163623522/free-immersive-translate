# 生成插件图标：圆角湖蓝方块 + 三条白线（第二条断开 = 双语对照意象）
# 无第三方依赖，手工构造 PNG（zlib + struct）
import struct, zlib, os

BG = (52, 130, 255)    # #3482FF MIUI 蓝
FG = (255, 255, 255)

def write_png(path, w, h, pixel):
    rows = bytearray()
    for y in range(h):
        rows.append(0)  # filter: none
        for x in range(w):
            rows.extend(pixel(x, y))
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)

def make_icon(size):
    r = size * 0.24  # 圆角半径
    cx = cy = size / 2
    def in_rounded(x, y):
        dx = abs(x + 0.5 - cx) - (size / 2 - r)
        dy = abs(y + 0.5 - cy) - (size / 2 - r)
        dx = max(dx, 0); dy = max(dy, 0)
        return dx * dx + dy * dy <= r * r
    # 三条白线的纵向位置与厚度按尺寸缩放；第二条中间断开
    thick = max(1, round(size / 10))
    gap = size * 0.07
    ys = [size * 0.30, size * 0.50, size * 0.70]
    x0, x1 = size * 0.26, size * 0.74
    cut_lo, cut_hi = size * 0.44, size * 0.56  # 第二条线的断口
    def pixel(x, y):
        if not in_rounded(x, y):
            return (0, 0, 0, 0)
        for i, ly in enumerate(ys):
            if abs(y + 0.5 - ly) <= thick / 2 + 0.001:
                if x + 0.5 >= x0 and x + 0.5 <= x1:
                    if i == 1 and (x + 0.5 < cut_lo or x + 0.5 > cut_hi):
                        continue
                    return FG + (255,)
        return BG + (255,)
    return pixel

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根
out_dir = os.path.join(root, 'icons')
os.makedirs(out_dir, exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join(out_dir, f'icon{s}.png'), s, s, make_icon(s))
    print(f'icon{s}.png OK')
