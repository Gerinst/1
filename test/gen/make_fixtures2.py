"""Hand-crafted edge-case PDFs: filters (LZW, ASCII85, AHx, RL), MacRoman, Tz/Tc/Tw, TJ-emulated spaces,
incremental update, wrong /Length, broken xref, nested form XObject with matrix."""
import json, os, zlib, base64, io, re

FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
expected = json.load(open(os.path.join(FIX, "expected.json")))


def lzw_encode(data: bytes, early=1) -> bytes:
    """PDF LZWDecode-compatible encoder (EarlyChange=1)."""
    out_bits = []
    dict_ = {bytes([i]): i for i in range(256)}
    next_code = 258
    code_len = 9
    out_bits.append((256, code_len))
    w = b""
    for ch in data:
        wc = w + bytes([ch])
        if wc in dict_:
            w = wc
        else:
            out_bits.append((dict_[w], code_len))
            dict_[wc] = next_code
            next_code += 1
            if next_code + early - 1 >= (1 << code_len) and code_len < 12:
                code_len += 1
            if next_code >= 4094:
                out_bits.append((256, code_len))
                dict_ = {bytes([i]): i for i in range(256)}
                next_code = 258
                code_len = 9
            w = bytes([ch])
    if w:
        out_bits.append((dict_[w], code_len))
    out_bits.append((257, code_len))
    # pack bits MSB first
    acc = 0
    nbits = 0
    out = bytearray()
    for code, ln in out_bits:
        acc = (acc << ln) | code
        nbits += ln
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
    if nbits:
        out.append((acc << (8 - nbits)) & 0xFF)
    return bytes(out)


def rl_encode(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        run = 1
        while i + run < len(data) and data[i + run] == data[i] and run < 128:
            run += 1
        if run >= 3:
            out.append(257 - run)
            out.append(data[i])
            i += run
        else:
            j = i
            lit = bytearray()
            while j < len(data) and len(lit) < 128 and not (j + 2 < len(data) and data[j] == data[j + 1] == data[j + 2]):
                lit.append(data[j])
                j += 1
            out.append(len(lit) - 1)
            out += lit
            i = j
    out.append(128)
    return bytes(out)


def build_pdf(content: str, filters=None, encoding="WinAnsiEncoding", extra_objs=None, resources_extra="", page_extra=""):
    data = content.encode("latin1")
    filt = ""
    if filters:
        names = []
        for f in filters:
            if f == "Fl":
                data = zlib.compress(data)
                names.append("/FlateDecode")
            elif f == "LZW":
                data = lzw_encode(data)
                names.append("/LZWDecode")
            elif f == "A85":
                data = base64.a85encode(data) + b"~>"
                names.append("/ASCII85Decode")
            elif f == "AHx":
                data = data.hex().encode() + b">"
                names.append("/ASCIIHexDecode")
            elif f == "RL":
                data = rl_encode(data)
                names.append("/RunLengthDecode")
        # filters are applied in encoding order; the /Filter array lists decode order (reverse)
        names.reverse()
        filt = " /Filter [%s]" % " ".join(names)
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> %s >> %s>>" % (resources_extra, page_extra),
        ("<< /Length %d%s >>\nstream\n" % (len(data), filt)).encode("latin1") + data + b"\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /%s >>" % encoding,
    ]
    if extra_objs:
        objs += extra_objs
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
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
    return out.getvalue()


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


BASIC = """BT
/F1 12 Tf 60 780 Td (Zahlungsavis Nr. 4711 vom 01.10.2026) Tj
0 -20 Td (RE-2026-0917   1.000,00   20,00   980,00) Tj
0 -16 Td (RE-2026-0931   2.500,00   26,00   2.474,00) Tj
0 -30 Td (Gesamtbetrag) Tj 300 0 Td (3.454,00 EUR) Tj
ET
"""

cases = {}
cases["filt_lzw.pdf"] = (build_pdf(BASIC, ["LZW"]), "3.454,00")
cases["filt_a85_flate.pdf"] = (build_pdf(BASIC, ["Fl", "A85"]), "3.454,00")
cases["filt_ahx.pdf"] = (build_pdf(BASIC, ["AHx"]), "3.454,00")
cases["filt_rl.pdf"] = (build_pdf(BASIC, ["RL"]), "3.454,00")
cases["filt_lzw_flate_chain.pdf"] = (build_pdf(BASIC, ["Fl", "LZW"]), "3.454,00")

# MacRoman: "Überweisungsbetrag" with Ü = 0x86 in MacRoman, ü = 0x9F
mac = "BT /F1 12 Tf 60 780 Td (\\206berweisungsbetrag) Tj 250 0 Td (3.454,00 EUR) Tj 0 -20 Td (Pr\\237fung 12,00) Tj ET"
cases["enc_macroman.pdf"] = (build_pdf(mac, ["Fl"], encoding="MacRomanEncoding"), "3.454,00")

# Tz / Tc / Tw and TJ-emulated spaces (no space glyphs at all)
tj = """BT /F1 10 Tf 80 Tz 0.3 Tc 2 Tw 60 760 Td
[(Gesamtbetrag) -2500 (EUR) -1800 (3.454,00)] TJ
0 -16 Td [(Skonto) -2500 (26,00)] TJ
ET"""
cases["tj_emulated_spaces.pdf"] = (build_pdf(tj, ["Fl"]), "3.454,00")

# wrong /Length (too small) and junk before %PDF (broken xref offsets)
b = build_pdf(BASIC, ["Fl"])
b_wrong = re.sub(rb"/Length (\d+)", lambda m: b"/Length " + str(max(1, int(m.group(1)) // 3)).encode(), b, count=1)  # wrong (too small) length
cases["broken_length.pdf"] = (b_wrong, "3.454,00")
cases["broken_xref_junk.pdf"] = (b"\n\n%junk header line\n" + b, "3.454,00")

# incremental update: replace the content stream (object 4) with a new amount; old one stays in the file
base = build_pdf(BASIC, ["Fl"])
new_content = zlib.compress(BASIC.replace("3.454,00", "9.999,99").encode("latin1"))
upd = io.BytesIO()
upd.write(base)
off4 = upd.tell()
upd.write(("4 0 obj\n<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(new_content)).encode("latin1") + new_content + b"\nendstream\nendobj\n")
xref = upd.tell()
prev = int(base[base.rindex(b"startxref") + 9:].split()[0])
upd.write(("xref\n4 1\n%010d 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (off4, prev, xref)).encode("latin1"))
cases["incremental_update.pdf"] = (upd.getvalue(), "9.999,99")

# nested form XObjects with Matrix (scale 0.5 + translate) and inline image inside the form
inner = "BT /F1 20 Tf 0 0 Td (Gesamtbetrag) Tj 400 0 Td (3.454,00 EUR) Tj ET BI /W 2 /H 2 /CS /RGB /BPC 8 ID \x00\x00\x00\xff\xff\xff\x00\x00\x00EI EI\n"
inner_b = zlib.compress(inner.encode("latin1"))
outer = "q 1 0 0 1 60 600 cm /Fx1 Do Q"
outer_b = zlib.compress(outer.encode("latin1"))
form_objs = [
    ("<< /Type /XObject /Subtype /Form /BBox [0 0 1000 100] /Matrix [0.5 0 0 0.5 10 10] /Resources << /Font << /F1 5 0 R >> /XObject << /Fx2 7 0 R >> >> /Length %d /Filter /FlateDecode >>\nstream\n" % len(outer_b)).encode("latin1") + outer_b + b"\nendstream",
    ("<< /Type /XObject /Subtype /Form /BBox [0 0 1000 100] /Resources << /Font << /F1 5 0 R >> >> /Length %d /Filter /FlateDecode >>\nstream\n" % len(inner_b)).encode("latin1") + inner_b + b"\nendstream",
]
page_content = "BT /F1 10 Tf 60 780 Td (Zahlungsavis) Tj ET q 1 0 0 1 0 0 cm /Fx1 Do Q"
# the outer form references Fx2 as Fx1 – fix: use distinct names
form_objs[0] = form_objs[0].replace(b"/Fx2 7 0 R", b"/Fx1 7 0 R")
cases["form_nested_matrix.pdf"] = (build_pdf(page_content, ["Fl"], extra_objs=form_objs, resources_extra="/XObject << /Fx1 6 0 R >>"), "3.454,00")

# label on one line, amount on the next, label ends with colon; plus header row with keywords
nl = """BT /F1 10 Tf 60 780 Td (Belegnummer   Rechnungsbetrag   Skonto   Zahlbetrag) Tj
0 -16 Td (RE-1   1.000,00   20,00   980,00) Tj
0 -16 Td (RE-2   2.500,00   26,00   2.474,00) Tj
0 -30 Td (Zahlbetrag gesamt:) Tj
0 -16 Td (3.454,00 EUR) Tj
ET"""
cases["label_next_line_with_header.pdf"] = (build_pdf(nl, ["Fl"]), "3.454,00")

# header contains keywords but the total row has no label at all (sum-check vs header-next-line)
nolabel = """BT /F1 10 Tf 60 780 Td (Belegnummer   Rechnungsbetrag   Skonto   Zahlbetrag) Tj
0 -16 Td (RE-1   1.000,00   20,00   980,00) Tj
0 -16 Td (RE-2   2.500,00   26,00   2.474,00) Tj
0 -30 Td (                                        3.454,00) Tj
ET"""
cases["header_keywords_nolabel_total.pdf"] = (build_pdf(nolabel, ["Fl"]), "3.454,00")

for name, (data, want) in cases.items():
    open(os.path.join(FIX, name), "wb").write(data)
    expected[name] = want
json.dump(expected, open(os.path.join(FIX, "expected.json"), "w"), indent=1, ensure_ascii=False)
print("ok", len(cases))
