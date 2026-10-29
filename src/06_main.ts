// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------
const MAX_TEXT_CHARS = 100000;

function extractPdf(bytes: Uint8Array): { lines: string[]; pages: number; warnings: string[]; encrypted: boolean } {
  const s = bytesToLatin1(bytes, 0, bytes.length);
  const doc = new PdfDoc(s);
  if (doc.encrypted) return { lines: [], pages: 0, warnings: doc.warnings, encrypted: true };
  const pages = doc.pages();
  const interp = new ContentInterpreter(doc);
  for (let i = 0; i < pages.length; i++) {
    try {
      const content = doc.pageContent(pages[i].dict);
      interp.runPage(content, pages[i].resources, i);
      interp.runAnnotations(pages[i].dict, pages[i].resources, i);
    } catch (e) {
      doc.warnings.push("page " + (i + 1) + ": " + String(e));
    }
  }
  const lines = assembleLines(interp.items);
  return { lines: lines, pages: pages.length, warnings: doc.warnings, encrypted: false };
}

function emptyResult(): AvisResult {
  return { ok: false, amount: "", amountNumber: 0, currency: "", line: "", method: "none", confidence: "low", candidates: [], pages: 0, text: "", textLength: 0, warnings: "", error: "" };
}

/**
 * Office Script entry point.
 * @param pdfBase64  Base64 content of the PDF (e.g. contentBytes of "Get attachment (V2)")
 * @param extraKeywords  optional, comma separated extra keywords that mark the total line ("Auszahlung, Überweisungssumme"); may be ""
 */
function main(workbook: ExcelScript.Workbook, pdfBase64: string, extraKeywords?: string): AvisResult {
  const res = emptyResult();
  totalDecoded = 0;
  try {
    if (!pdfBase64 || pdfBase64.length < 16) { res.error = "no PDF content passed"; return res; }
    const bytes = base64ToBytes(pdfBase64);
    if (bytes.length < 8 || bytesToLatin1(bytes, 0, 4) !== "%PDF") {
      // some mail systems prefix junk before %PDF – look for the header anyway
      const probe = bytesToLatin1(bytes, 0, Math.min(bytes.length, 2048));
      if (probe.indexOf("%PDF") < 0) { res.error = "not a PDF (header missing, " + bytes.length + " bytes)"; return res; }
    }
    const ex = extractPdf(bytes);
    res.pages = ex.pages;
    res.warnings = ex.warnings.slice(0, 20).join(" | ");
    if (ex.encrypted) { res.error = "PDF is encrypted – not supported"; return res; }
    const text = ex.lines.join("\n");
    res.textLength = text.length;
    res.text = text.length > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    if (text.replace(/\s/g, "").length === 0) { res.error = ex.pages === 0 ? "no pages found" : "no text layer found (scanned PDF?)"; return res; }
    const pick = pickAmount(ex.lines, extraKeywords || "");
    res.currency = pick.currency;
    res.candidates = pick.candidates.map((c) => c.amount + " | " + c.score.toFixed(2) + " | " + c.method + " | " + c.line.substring(0, 120));
    if (pick.best) {
      res.ok = true;
      res.amount = pick.best.amount;
      res.amountNumber = Math.round(pick.best.value * 100) / 100;
      res.line = pick.best.line;
      res.method = pick.best.method;
      // confidence: rule quality + distance to the next different amount
      let margin = 99;
      for (const c of pick.candidates) if (c.value !== pick.best.value) { margin = pick.best.score - c.score; break; }
      const strongRule = res.method === "keyword" || res.method === "keyword-next-line" || res.method === "column-sum";
      res.confidence = strongRule && margin >= 1.5 ? "high" : (margin >= 0.75 && res.method !== "largest") ? "medium" : "low";
    } else {
      res.error = "no amount pattern found";
    }
    return res;
  } catch (e) {
    res.error = "exception: " + String(e);
    return res;
  }
}
