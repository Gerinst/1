"""Builds test PDFs (payment advices) from different producers. Writes expected.json."""
import json, os, subprocess, zlib, io, shutil
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm

FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
os.makedirs(FIX, exist_ok=True)
expected = {}

ROWS = [
    ("RE-2026-0917", "01.09.2026", "1.000,00", "20,00", "980,00"),
    ("RE-2026-0931", "05.09.2026", "2.500,00", "26,00", "2.474,00"),
]
TOTAL = "3.454,00"


def draw_avis(c, font="Helvetica", bold="Helvetica-Bold", total_label="Gesamtbetrag", amount_on_next_line=False,
              trailing_minus=False, currency="EUR"):
    w, h = A4
    c.setFont(bold, 14)
    c.drawString(20 * mm, h - 30 * mm, "Zahlungsavis")
    c.setFont(font, 10)
    c.drawString(20 * mm, h - 40 * mm, "Müller & Söhne GmbH · Hauptstraße 12 · 80331 München")
    c.drawString(20 * mm, h - 46 * mm, "Avis-Nr. 4711 vom 01.10.2026    Kundennr. 123456    IBAN DE12 3456 7890 1234 5678 90")
    y = h - 60 * mm
    c.setFont(bold, 10)
    for x, t in [(20, "Belegnummer"), (60, "Datum"), (100, "Rechnungsbetrag"), (140, "Skonto"), (170, "Zahlbetrag")]:
        c.drawString(x * mm, y, t)
    c.setFont(font, 10)
    for r in ROWS:
        y -= 7 * mm
        c.drawString(20 * mm, y, r[0])
        c.drawString(60 * mm, y, r[1])
        c.drawRightString(130 * mm, y, r[2])
        c.drawRightString(155 * mm, y, r[3])
        c.drawRightString(195 * mm, y, r[4])
    y -= 12 * mm
    c.setFont(bold, 11)
    amt = TOTAL + ("-" if trailing_minus else "")
    if amount_on_next_line:
        c.drawString(20 * mm, y, total_label + " in " + currency + ":")
        y -= 6 * mm
        c.drawRightString(195 * mm, y, amt)
    else:
        c.drawString(20 * mm, y, total_label)
        c.drawRightString(195 * mm, y, amt + " " + currency)
    y -= 15 * mm
    c.setFont(font, 9)
    c.drawString(20 * mm, y, "Die Überweisung erfolgt mit Wertstellung 03.10.2026 auf das uns bekannte Konto. Skonto: 2 % bei Zahlung in 14 Tagen.")
    c.drawString(20 * mm, y - 5 * mm, "Telefon 089 123456-0 · Fax 089 123456-99 · USt-IdNr. DE123456789 · Seite 1/1")


def save(name, c):
    c.save()
    expected[name] = TOTAL


# 1) reportlab, standard fonts (no /Widths, WinAnsi), compressed
c = canvas.Canvas(os.path.join(FIX, "rl_std_helvetica.pdf"), pagesize=A4, pageCompression=1)
draw_avis(c)
save("rl_std_helvetica.pdf", c)

# 2) reportlab, standard fonts, uncompressed streams
c = canvas.Canvas(os.path.join(FIX, "rl_std_uncompressed.pdf"), pagesize=A4, pageCompression=0)
draw_avis(c, total_label="Überweisungsbetrag", amount_on_next_line=True)
save("rl_std_uncompressed.pdf", c)

# 3) reportlab, embedded TrueType (subset simple TrueType + ToUnicode), Times-like label variants
pdfmetrics.registerFont(TTFont("Liberation", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"))
pdfmetrics.registerFont(TTFont("LiberationB", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"))
c = canvas.Canvas(os.path.join(FIX, "rl_ttf_liberation.pdf"), pagesize=A4, pageCompression=1)
draw_avis(c, font="Liberation", bold="LiberationB", total_label="Summe Zahlung", trailing_minus=False)
save("rl_ttf_liberation.pdf", c)

# 4) reportlab, SAP-style trailing minus + Times standard font + multi page (total on page 2)
c = canvas.Canvas(os.path.join(FIX, "rl_times_multipage.pdf"), pagesize=A4, pageCompression=1)
w, h = A4
c.setFont("Times-Roman", 10)
c.drawString(20 * mm, h - 30 * mm, "Zahlungsavis – Seite 1: Positionen")
y = h - 45 * mm
for i in range(25):
    c.drawString(20 * mm, y, "RE-2026-%04d" % (100 + i))
    c.drawRightString(120 * mm, y, "%d,%02d" % (10 + i, i))
    y -= 6 * mm
c.showPage()
draw_avis(c, font="Times-Roman", bold="Times-Bold", total_label="Gesamt", trailing_minus=True)
c.save()
expected["rl_times_multipage.pdf"] = "3.454,00-"

# 5) reportlab, text inside Form XObject + inline image + Tz + rotated header
c = canvas.Canvas(os.path.join(FIX, "rl_form_xobject.pdf"), pagesize=A4, pageCompression=1)
c.beginForm("body")
draw_avis(c, total_label="Zahlbetrag")
c.endForm()
c.saveState()
c.translate(100 * mm, 20 * mm)
c.rotate(90)
c.setFont("Helvetica", 8)
c.drawString(0, 0, "Rotierter Randtext 99,99")
c.restoreState()
c.doForm("body")
# inline image (tiny)
from reportlab.lib.utils import ImageReader
from PIL import Image
img = Image.new("RGB", (4, 4), (200, 30, 30))
c.drawInlineImage(img, 150 * mm, 250 * mm, 10 * mm, 10 * mm)
save("rl_form_xobject.pdf", c)

# 6) DOCX -> LibreOffice PDF (TrueType subsets, Differences, kerning TJ arrays)
try:
    import docx
    from docx.shared import Pt
    d = docx.Document()
    d.add_heading("Zahlungsavis", 1)
    d.add_paragraph("Müller & Söhne GmbH · Hauptstraße 12 · 80331 München")
    d.add_paragraph("Avis-Nr. 4711 vom 01.10.2026, Kundennr. 123456")
    t = d.add_table(rows=1, cols=5)
    t.style = "Table Grid"
    for i, hname in enumerate(["Belegnummer", "Datum", "Rechnungsbetrag", "Skonto", "Zahlbetrag"]):
        t.rows[0].cells[i].text = hname
    for r in ROWS:
        cells = t.add_row().cells
        for i, v in enumerate(r):
            cells[i].text = v
    cells = t.add_row().cells
    cells[0].text = "Gesamtbetrag"
    cells[4].text = TOTAL + " EUR"
    d.add_paragraph("Die Überweisung erfolgt mit Wertstellung 03.10.2026. Skonto 2 % wurde abgezogen.")
    docx_path = os.path.join(FIX, "avis.docx")
    d.save(docx_path)
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", FIX, docx_path], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    os.rename(os.path.join(FIX, "avis.pdf"), os.path.join(FIX, "lo_docx.pdf"))
    os.remove(docx_path)
    expected["lo_docx.pdf"] = TOTAL
except Exception as e:
    print("LibreOffice fixture failed:", e)

# 7) qpdf variants of the reportlab file
base = os.path.join(FIX, "rl_std_helvetica.pdf")
variants = {
    "qpdf_objstm.pdf": ["--object-streams=generate"],
    "qpdf_linearized.pdf": ["--linearize"],
    "qpdf_uncompressed.pdf": ["--stream-data=uncompress"],
    "qpdf_encrypted.pdf": ["--encrypt", "", "owner", "128", "--"],
}
for name, args in variants.items():
    cmd = ["qpdf"] + args + [base, os.path.join(FIX, name)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode in (0, 3):
        expected[name] = "" if "encrypt" in name else TOTAL
    else:
        print("qpdf failed", name, r.stderr.decode()[:200])
# object streams on the LibreOffice file too
if os.path.exists(os.path.join(FIX, "lo_docx.pdf")):
    r = subprocess.run(["qpdf", "--object-streams=generate", "--recompress-flate", os.path.join(FIX, "lo_docx.pdf"),
                        os.path.join(FIX, "qpdf_lo_objstm.pdf")], capture_output=True)
    if r.returncode in (0, 3):
        expected["qpdf_lo_objstm.pdf"] = TOTAL

# 8) hand-made PDF: Type0 / Identity-H WITHOUT ToUnicode (TrueType cmap fallback) and with ToUnicode
from fontTools import subset
from fontTools.ttLib import TTFont as FTFont

def make_subset(text, path_out):
    font = FTFont("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf")
    opts = subset.Options()
    opts.retain_gids = False
    opts.notdef_outline = True
    s = subset.Subsetter(opts)
    s.populate(text=text)
    s.subset(font)
    font.save(path_out)
    font = FTFont(path_out)
    cmap = font.getBestCmap()
    gset = font.getGlyphOrder()
    gid_of = {name: i for i, name in enumerate(gset)}
    uni_to_gid = {u: gid_of[n] for u, n in cmap.items()}
    hmtx = font["hmtx"]
    upem = font["head"].unitsPerEm
    widths = {gid_of[n]: int(round(hmtx[n][0] * 1000 / upem)) for n in gset}
    return uni_to_gid, widths

def write_pdf(path, text_lines, with_tounicode, total):
    all_text = "".join(t for _, _, t in text_lines)
    ttf_path = path + ".subset.ttf"
    uni_to_gid, widths = make_subset(all_text, ttf_path)
    ttf = open(ttf_path, "rb").read()
    os.remove(ttf_path)
    # content stream with TJ kerning arrays
    content = "BT\n"
    for x, y, t in text_lines:
        content += "/F1 11 Tf 1 0 0 1 %d %d Tm [" % (x, y)
        parts = []
        for ch in t:
            gid = uni_to_gid.get(ord(ch), 0)
            parts.append("<%04X>" % gid)
            parts.append("-15") if ch == "," else None
        content += " ".join(p for p in parts if p) + "] TJ\n"
    content += "ET\n"
    cs = zlib.compress(content.encode("latin1"))
    W = " ".join("%d [%d]" % (g, w) for g, w in sorted(widths.items()))
    objs = []
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>")
    objs.append(("<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(cs)).encode("latin1") + cs + b"\nendstream")
    f0 = "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+LiberationSans /Encoding /Identity-H /DescendantFonts [6 0 R]"
    if with_tounicode:
        f0 += " /ToUnicode 9 0 R"
    f0 += " >>"
    objs.append(f0)
    objs.append("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+LiberationSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /W [%s] /CIDToGIDMap /Identity >>" % W)
    objs.append("<< /Type /FontDescriptor /FontName /AAAAAA+LiberationSans /Flags 32 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>")
    objs.append(("<< /Length %d /Length1 %d >>\nstream\n" % (len(ttf), len(ttf))).encode("latin1") + ttf + b"\nendstream")
    if with_tounicode:
        bf = "".join("<%04X> <%04X>\n" % (g, u) for u, g in sorted(uni_to_gid.items(), key=lambda kv: kv[1]))
        tu = ("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n"
              "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n%d beginbfchar\n%s endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend" % (len(uni_to_gid), bf))
        tub = zlib.compress(tu.encode("latin1"))
        objs.append(("<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(tub)).encode("latin1") + tub + b"\nendstream")
    out = io.BytesIO()
    out.write(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(("%d 0 obj\n" % i).encode("latin1"))
        out.write(o if isinstance(o, bytes) else o.encode("latin1"))
        out.write(b"\nendobj\n")
    xref = out.tell()
    out.write(("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode("latin1"))
    for off in offsets:
        out.write(("%010d 00000 n \n" % off).encode("latin1"))
    out.write(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode("latin1"))
    open(path, "wb").write(out.getvalue())
    expected[os.path.basename(path)] = total

lines = [
    (60, 780, "Zahlungsavis Nr. 4711 vom 01.10.2026"),
    (60, 750, "Belegnummer   Rechnungsbetrag   Skonto   Zahlbetrag"),
    (60, 735, "RE-2026-0917   1.000,00   20,00   980,00"),
    (60, 720, "RE-2026-0931   2.500,00   26,00   2.474,00"),
    (60, 690, "Überweisungsbetrag EUR"),
    (420, 690, "3.454,00"),
    (60, 660, "Zahlung erfolgt am 03.10.2026, Skonto berücksichtigt."),
]
write_pdf(os.path.join(FIX, "hand_type0_tounicode.pdf"), lines, True, TOTAL)
write_pdf(os.path.join(FIX, "hand_type0_no_tounicode.pdf"), lines, False, TOTAL)

json.dump(expected, open(os.path.join(FIX, "expected.json"), "w"), indent=1, ensure_ascii=False)
print("fixtures:", sorted(expected.keys()))
