const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts } = require("/opt/npm-tools/node_modules/pdf-lib");
let fontkit = null;
try { fontkit = require("/opt/npm-tools/node_modules/@pdf-lib/fontkit"); } catch (e) { console.log("no fontkit:", e.message); }
(async () => {
  const fix = path.join(__dirname, "..", "fixtures");
  const doc = await PDFDocument.create();
  if (fontkit) doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  let font, bold;
  if (fontkit) {
    font = await doc.embedFont(fs.readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), { subset: true });
    bold = await doc.embedFont(fs.readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), { subset: true });
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const draw = (t, x, y, f, s) => page.drawText(t, { x, y, size: s || 10, font: f || font });
  draw("Zahlungsavis", 60, 780, bold, 14);
  draw("Müller & Söhne GmbH · Hauptstraße 12 · 80331 München", 60, 760);
  draw("Belegnummer        Datum          Rechnungsbetrag     Skonto     Zahlbetrag", 60, 720, bold);
  draw("RE-2026-0917       01.09.2026     1.000,00            20,00      980,00", 60, 705);
  draw("RE-2026-0931       05.09.2026     2.500,00            26,00      2.474,00", 60, 690);
  draw("Gesamtbetrag", 60, 660, bold, 11);
  draw("3.454,00 EUR", 400, 660, bold, 11);
  draw("Die Überweisung erfolgt mit Wertstellung 03.10.2026.", 60, 630);
  const bytes = await doc.save({ useObjectStreams: true });
  fs.writeFileSync(path.join(fix, "pdflib_type0_objstm.pdf"), bytes);
  const bytes2 = await doc.save({ useObjectStreams: false });
  fs.writeFileSync(path.join(fix, "pdflib_type0_plain.pdf"), bytes2);
  console.log("pdf-lib fixtures written, fontkit:", !!fontkit);
})();
