"""Disposable real byte fixtures; input JSON and output files are preserved.
Independent expected values are declared in the E2E driver, never derived here.
"""
import sys, json, io, zipfile, base64
from pathlib import Path
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

spec=json.load(sys.stdin)
headers=['entityId','metricKey','value','periodStart','periodEnd','currencyCode','frequency','unit','calendar','consolidation','instrument','scale','sign']
rows=[[r.get('entityId',spec['entityId']),r['metricKey'],r['value'],r.get('periodStart','2025-01-01T00:00:00.000Z'),r.get('periodEnd','2025-12-31T00:00:00.000Z'),r.get('currencyCode','USD'),r.get('frequency','annual'),r.get('unit','currency'),r.get('calendar','OWNER_RECORDED'),r.get('consolidation','OWNER_SUBJECT_ONLY'),r.get('instrument','UNSPECIFIED'),r.get('scale','1'),r.get('sign','AS_RECORDED')] for r in spec['rows']]
folder=Path(spec['folder']);folder.mkdir(parents=True,exist_ok=True)
(folder/'fixture-input.json').write_text(json.dumps(spec,indent=2)+'\n')
wb=Workbook();ws=wb.active;ws.title='Financials';ws.append(headers)
for row in rows: ws.append(row)
if spec.get('hidden'): ws.row_dimensions[len(rows)+1].hidden=True
b=io.BytesIO();wb.save(b);xlsx=b.getvalue()
if spec.get('formula'):
    import xml.etree.ElementTree as ET
    ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    source=zipfile.ZipFile(io.BytesIO(xlsx));out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as target:
        for name in source.namelist():
            data=source.read(name)
            if name=='xl/worksheets/sheet1.xml':
                root=ET.fromstring(data);cell=next(c for c in root.iter(ns+'c') if c.attrib['r']=='C2')
                cell.attrib.pop('t',None)
                for child in list(cell):cell.remove(child)
                ET.SubElement(cell,ns+'f').text='120-70'
                ET.SubElement(cell,ns+'v').text='999'
                data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
            target.writestr(name,data)
    xlsx=out.getvalue()
(folder/'financials.xlsx').write_bytes(xlsx)
lines=['|'.join(headers)]+['|'.join(row) for row in rows]
pdf=io.BytesIO();c=canvas.Canvas(pdf,pagesize=(5000,500));c.setFont('Courier',14)
for i,line in enumerate(lines):c.drawString(24,460-i*35,line)
c.showPage();c.save();(folder/'financials.pdf').write_bytes(pdf.getvalue())
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',44)
lines=[' | '.join(h.upper() for h in headers)]+[' | '.join(row).replace('T00:00:00.000Z','') for row in rows]
width=max(int(font.getlength(line)) for line in lines)+80
image=Image.new('RGB',(width,100+90*len(lines)),'white');draw=ImageDraw.Draw(image)
for i,line in enumerate(lines):draw.text((40,40+90*i),line,font=font,fill='black')
image.save(folder/'financials.png')
print(json.dumps({'xlsx':str(folder/'financials.xlsx'),'pdf':str(folder/'financials.pdf'),'image':str(folder/'financials.png')}))
