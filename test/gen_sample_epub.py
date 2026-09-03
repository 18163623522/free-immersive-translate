# 生成测试 EPUB（标准 zip 结构：mimetype stored + container.xml + OPF + nav + 2 章）
import os, zipfile

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
<h1>The Rendering Pipeline</h1>
<p>Real-time rendering is the process of generating images at interactive frame rates, typically within sixteen milliseconds per frame.</p>
<p>A rendering pipeline transforms three-dimensional geometry into a two-dimensional image through a sequence of stages.</p>
<p>The vertex shader determines where geometry appears on screen, and fragment shaders compute the final color of each pixel.</p>
<h2>Shadow Mapping</h2>
<p>Shadow mapping renders the scene from the light perspective and compares depths to decide whether a point is in shadow.</p>
<p>Percentage-closer filtering softens the hard edges by averaging multiple depth comparisons per pixel.</p>
</body>
</html>"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
<h1>Materials and Light</h1>
<p>A material describes how a surface interacts with light, including its color, roughness and metallic properties.</p>
<p>Physically based rendering equations approximate the flow of light energy between surfaces in a scene.</p>
<p>Latency matters more than raw throughput in interactive applications, so budgets drive every design decision.</p>
</body>
</html>"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc">
<ol>
<li><a href="ch1.xhtml">The Rendering Pipeline</a></li>
<li><a href="ch2.xhtml">Materials and Light</a></li>
</ol>
</nav>
</body>
</html>"""

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
<metadata><dc:title>Real-Time Rendering Notes</dc:title><dc:language>en</dc:language>
<dc:identifier id="uid">ift-test-001</dc:identifier></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"""

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.epub")
with zipfile.ZipFile(out, "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF)
    z.writestr("OEBPS/nav.xhtml", NAV)
    z.writestr("OEBPS/ch1.xhtml", CH1)
    z.writestr("OEBPS/ch2.xhtml", CH2)
print("sample.epub OK,", os.path.getsize(out), "bytes")
