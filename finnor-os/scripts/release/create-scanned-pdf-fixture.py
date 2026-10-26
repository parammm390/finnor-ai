"""Deterministic image-only PDF input for the native OCR/table proof."""
import hashlib
import json
from pathlib import Path
import sys
import zlib
from PIL import Image, ImageDraw, ImageFont

image = Image.new("RGB", (1600, 900), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=48)
for index, (name, revenue) in enumerate([("Customer", "Revenue"), ("Alpha", "40"), ("Beta", "60"), ("Total", "100")]):
    y = 160 + 140 * index
    draw.text((200, y), name, fill="black", font=font)
    draw.text((1050, y), revenue, fill="black", font=font)
    draw.line((150, y + 75, 1450, y + 75), fill="black", width=3)
compressed = zlib.compress(image.tobytes())
content = b"q 800 0 0 450 0 0 cm /Im0 Do Q"
objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 450] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /XObject /Subtype /Image /Width 1600 /Height 900 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length " + str(len(compressed)).encode() + b" >>\nstream\n" + compressed + b"\nendstream",
    b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for index, body in enumerate(objects):
    offsets.append(len(pdf))
    pdf.extend(str(index + 1).encode() + b" 0 obj\n" + body + b"\nendobj\n")
xref = len(pdf)
pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend((str(offset).zfill(10) + " 00000 n \n").encode())
pdf.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
path = Path(sys.argv[1])
path.write_bytes(pdf)
print(json.dumps({"path": str(path), "sha256": hashlib.sha256(pdf).hexdigest(), "bytes": len(pdf), "imageOnly": True,
    "expectedCells": [["Customer", "Revenue"], ["Alpha", "40"], ["Beta", "60"], ["Total", "100"]]}))
