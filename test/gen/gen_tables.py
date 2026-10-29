import os
"""Generates the encoding / glyph / width tables for the Office Script from reportlab's data."""
from reportlab.pdfbase import _fontdata as fd, _glyphlist as gl

G = gl._glyphname2unicode

def enc_codepoints(names):
    out = []
    for n in names:
        if n is None:
            out.append(0)
        else:
            cp = G.get(n)
            out.append(cp if cp is not None else 0)
    return out

def ts_num_array(name, arr, per_line=32):
    lines = []
    for i in range(0, len(arr), per_line):
        lines.append("  " + ",".join(str(x) for x in arr[i:i + per_line]) + ",")
    body = "\n".join(lines)
    return f"const {name}: number[] = [\n{body}\n];\n"

encs = {
    "ENC_WINANSI": fd.WinAnsiEncoding,
    "ENC_MACROMAN": fd.MacRomanEncoding,
    "ENC_STANDARD": fd.StandardEncoding,
}
out = []
for k, v in encs.items():
    out.append(ts_num_array(k, enc_codepoints(v)))

# glyph names: union of all names in the three encodings + Symbol + extras
names = set()
for v in list(encs.values()) + [fd.SymbolEncoding, fd.PDFDocEncoding, fd.MacExpertEncoding]:
    for n in v:
        if n:
            names.add(n)
extras = """fi fl ff ffi ffl Euro euro bullet endash emdash quoteright quoteleft quotedblleft quotedblright
quotesinglbase quotedblbase ellipsis trademark registered copyright degree minus multiply divide
plusminus onehalf onequarter threequarters onesuperior twosuperior threesuperior germandbls
dotlessi fraction perthousand Lslash lslash OE oe Scaron scaron Zcaron zcaron Ydieresis ydieresis
circumflex tilde caron breve dotaccent ring ogonek hungarumlaut cedilla macron dieresis grave acute
space nbspace nonbreakingspace sfthyphen softhyphen hyphen minus periodcentered middot bulletoperator
Delta Omega mu micro pi summation product radical infinity notequal lessequal greaterequal
approxequal partialdiff integral lozenge apple checkmark arrowright arrowleft arrowup arrowdown
uni20AC uni00A0 uni2013 uni2014 zerooldstyle oneoldstyle twooldstyle threeoldstyle fouroldstyle
fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle
Abreve abreve Aogonek aogonek Cacute cacute Ccaron ccaron Dcaron dcaron Dcroat dcroat Ecaron ecaron
Eogonek eogonek Gbreve gbreve Idotaccent Lacute lacute Lcaron lcaron Nacute nacute Ncaron ncaron
Ohungarumlaut ohungarumlaut Racute racute Rcaron rcaron Sacute sacute Scedilla scedilla Tcaron tcaron
Tcommaaccent tcommaaccent Uhungarumlaut uhungarumlaut Uring uring Zacute zacute Zdotaccent zdotaccent
Scommaaccent scommaaccent Gcommaaccent gcommaaccent Kcommaaccent kcommaaccent Lcommaaccent lcommaaccent
Ncommaaccent ncommaaccent Rcommaaccent rcommaaccent Emacron emacron Amacron amacron Imacron imacron
Omacron omacron Umacron umacron Edotaccent edotaccent Iogonek iogonek Uogonek uogonek
Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau
Upsilon Phi Chi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi
omicron pi rho sigma tau upsilon phi chi psi omega""".split()
for n in extras:
    names.add(n)
pairs = []
for n in sorted(names):
    cp = G.get(n)
    if cp is None:
        continue
    pairs.append((n, cp))
lines = []
cur = "  "
for n, cp in pairs:
    item = f"{n}:{cp},"
    if len(cur) + len(item) > 110:
        lines.append(cur)
        cur = "  "
    cur += item
lines.append(cur)
out.append("const GLYPHS: {[name: string]: number} = {\n" + "\n".join(lines) + "\n};\n")

# standard-14 widths by WinAnsi code (32..255); fallback Helvetica
def widths_for(font):
    w = fd.widthsByFontGlyph[font]
    arr = []
    for code in range(32, 256):
        n = fd.WinAnsiEncoding[code]
        arr.append(w.get(n, 0) if n else 0)
    return arr
for key, font in [("W_HELV", "Helvetica"), ("W_HELVB", "Helvetica-Bold"), ("W_TIMES", "Times-Roman"), ("W_TIMESB", "Times-Bold")]:
    out.append(ts_num_array(key, widths_for(font)))

open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "_tables.ts"), "w").write(
    "// ---- generated tables (encodings as Unicode code points, 0 = undefined) ----\n" + "\n".join(out))
print("ok", len(pairs), "glyph names")
