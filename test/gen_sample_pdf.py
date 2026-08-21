# 手写最小英文 PDF（无需第三方库）：2 页，每页数行文本，供 viewer 实测
# 结构：objects = catalog / pages / page1 / content1 / page2 / content2 / font
import os

LINES_P1 = [
    "Real-Time Rendering: A Practical Introduction",
    "Real-time rendering generates images at interactive frame rates,",
    "typically within sixteen milliseconds per frame.",
    "Modern GPUs execute thousands of shader programs in parallel.",
    "",
    "A rendering pipeline transforms three-dimensional geometry",
    "into a two-dimensional image through a sequence of stages,",
    "including vertex processing, rasterization, and shading.",
    "",
    "Shadow mapping renders the scene from the light perspective",
    "and compares depths to decide whether a point is in shadow.",
    "2026",  # 纯数字行：应被过滤
]

LINES_P2 = [
    "Chapter 2: Core Concepts",
    "",
    "Latency matters more than raw throughput in interactive",
    "applications. Users perceive frames above twenty milliseconds",
    "as stutter, so budgets drive every design decision.",
    "",
    "Percentage-closer filtering softens the hard shadow edges",
    "by averaging multiple depth comparisons per pixel.",
]

def make_page_content(lines):
    ops = ["BT", "/F1 12 Tf", "14 TL", "72 720 Td"]
    first = True
    for ln in lines:
        if first:
            ops.append("(%s) Tj" % ln.replace("(", "\\(").replace(")", "\\)"))
            ops.append("T*")
            first = False
        else:
            ops.append("(%s) Tj" % ln.replace("(", "\\(").replace(")", "\\)") if ln else "")
            # 空行：仅换行
            ops.append("T*")
    ops.append("ET")
    return ("\n".join(ops)).encode("latin-1")

# 修正：空行不能输出空 () Tj 的问题不影响解析，() Tj 合法
c1 = make_page_content(LINES_P1)
c2 = make_page_content(LINES_P2)

objs = {}
objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
objs[2] = b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"
objs[3] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"
objs[4] = b"<< /Length %d >>\nstream\n" % len(c1) + c1 + b"\nendstream"
objs[5] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"
objs[6] = b"<< /Length %d >>\nstream\n" % len(c2) + c2 + b"\nendstream"
objs[7] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = {}
for i in sorted(objs):
    offsets[i] = len(out)
    out += b"%d 0 obj\n" % i + objs[i] + b"\nendobj\n"

xref_pos = len(out)
n = len(objs) + 1
out += b"xref\n0 %d\n" % n
out += b"0000000000 65535 f \n"
for i in sorted(objs):
    out += b"%010d 00000 n \n" % offsets[i]
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, xref_pos)

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.pdf")
with open(path, "wb") as f:
    f.write(bytes(out))
print("sample.pdf:", len(out), "bytes,", len(objs), "objects")
