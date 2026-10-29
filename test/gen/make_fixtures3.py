import json, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
expected = json.load(open(os.path.join(FIX, "expected.json")))
TOTAL = "3.454,00"
# 1) all text rotated 90° (portrait page used in landscape orientation via rotate)
c = canvas.Canvas(os.path.join(FIX, "rl_rotated_text.pdf"), pagesize=A4)
c.translate(190*mm, 20*mm); c.rotate(90)
c.setFont("Helvetica", 10)
c.drawString(0, 0, "Zahlungsavis Nr. 4711")
c.drawString(0, -14, "RE-1   1.000,00   20,00   980,00")
c.drawString(0, -28, "RE-2   2.500,00   26,00   2.474,00")
c.setFont("Helvetica-Bold", 11)
c.drawString(0, -50, "Gesamtbetrag"); c.drawString(300, -50, TOTAL + " EUR")
c.save(); expected["rl_rotated_text.pdf"] = TOTAL
# 2) AcroForm text field carrying the amount (appearance stream), label in content
c = canvas.Canvas(os.path.join(FIX, "rl_acroform_field.pdf"), pagesize=A4)
w, h = A4
c.setFont("Helvetica", 10)
c.drawString(20*mm, h-40*mm, "Zahlungsavis – Überweisungsbetrag:")
c.acroForm.textfield(name="betrag", value=TOTAL + " EUR", x=90*mm, y=h-43*mm, width=50*mm, height=8*mm, borderWidth=0, fontSize=10)
c.drawString(20*mm, h-60*mm, "Skonto 26,00")
c.save(); expected["rl_acroform_field.pdf"] = TOTAL
# 3) scan with invisible OCR text layer (text render mode 3) over an image
from PIL import Image
img = Image.new("RGB", (600, 300), (240, 240, 240))
p = os.path.join(FIX, "..", "gen", "scan.png"); img.save(p)
c = canvas.Canvas(os.path.join(FIX, "scan_with_ocr_layer.pdf"), pagesize=A4)
c.drawImage(p, 20*mm, 150*mm, 160*mm, 80*mm)
t = c.beginText(25*mm, 220*mm); t.setTextRenderMode(3); t.setFont("Helvetica", 10)
t.textLine("Zahlungsavis 4711"); t.textLine("Rechnung 1 980,00"); t.textLine("Rechnung 2 2.474,00"); t.textLine("Gesamtbetrag 3.454,00 EUR")
c.drawText(t); c.save(); os.remove(p)
expected["scan_with_ocr_layer.pdf"] = TOTAL
json.dump(expected, open(os.path.join(FIX, "expected.json"), "w"), indent=1, ensure_ascii=False)
print("ok")
