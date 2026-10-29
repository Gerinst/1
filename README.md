# AvisPdfAmount – PDF-Text und Zahlbetrag per Office Script (Power Automate Cloud)

Klick-für-Klick-Anleitung für den Flow: [docs/ANLEITUNG.md](docs/ANLEITUNG.md). Übersicht aller Aktionen und Felder: `dist/avis-flow.html` (im Browser öffnen).

Datenschutz: Das Repository enthält keine PDFs. Test-PDFs und echte Zahlungsavise bleiben lokal (`*.pdf` steht in der `.gitignore`).

Ein Office Script (TypeScript, ohne Libraries, ohne Netzwerk), das in Power Automate über **Excel Online (Business) → „Skript ausführen"** läuft, den eingebetteten Text einer PDF ausliest und den **Gesamt-/Zahlbetrag** findet. Standard-Connector, keine AI-Builder-Credits, keine Drittanbieter.

**Einordnung:** Die Plattform (Office Scripts + Run script) ist offiziell unterstützt und Standard. Der PDF-Parser selbst ist eigener Code – du wartest ihn, Microsoft nicht. Gegen eine feste Menge an PDF-Erzeugern (ERP-Systeme deiner Kunden) ist das belastbar, gegen „beliebige PDFs" nicht.

## Was der Parser kann

- PDF-Objekte per Scan (robust gegen kaputte xref-Tabellen), Objektströme (ObjStm), inkrementelle Updates (neueste Definition gewinnt), Linearized PDFs
- Filter: FlateDecode (eigener Inflate), LZWDecode, ASCII85, ASCIIHex, RunLength, PNG/TIFF-Prädiktoren, Filterketten
- Seitenbaum mit vererbten Resources, Form-XObjects (verschachtelt, mit Matrix), Inline-Images werden übersprungen
- AcroForm-/Annotation-Appearance-Streams (ausgefüllte Formularfelder)
- Text-Operatoren Tj/TJ/'/", Td/TD/Tm/T*, Tc/Tw/Tz/Ts, cm/q/Q
- Fonts: Simple Fonts (Type1/TrueType/Type3) mit Standard/WinAnsi/MacRoman + `/Differences`, ToUnicode-CMaps (bfchar/bfrange), Type0/Identity-H mit ToUnicode, eingebettete CMaps, Fallback über die `cmap`-Tabelle des eingebetteten TrueType-Fonts (wenn ToUnicode fehlt), Standard-14-Breiten für Helvetica/Times/Courier
- Zeilenaufbau aus Positionen (auch gedrehter Text, Fake-Bold-Duplikate), unsichtbarer OCR-Text (Render-Modus 3) wird mitgelesen
- Betragsheuristik (layoutunabhängig, arbeitet auf den Textzeilen): deutsche Formate `3.454,00`, `3454,00`, `3.454,00-` (SAP), `-150,00`; englisch `3,454.00` bei USD/GBP; Schlüsselwörter (Gesamt, Zahlbetrag, Überweisungsbetrag, Summe, Total …), Label-in-einer-Zeile/Betrag-in-der-nächsten, Spaltensummen-Check, Größe/Position als Nachrang

## Was er nicht kann

- Verschlüsselte PDFs (Owner-/User-Passwort) → `error: "PDF is encrypted"`
- Scans ohne Textschicht → `error: "no text layer found"`
- Fonts ohne ToUnicode **und** ohne eingebettete TrueType-cmap (seltene alte Erzeuger) → Zeichen fehlen
- Nicht-lateinische Schriften, vertikaler Text
- PDFs, bei denen der Betrag als Bild/Vektorpfad gezeichnet ist

## Rückgabe (Objekt `result` der Aktion „Skript ausführen")

| Feld | Bedeutung |
|---|---|
| `ok` | Betrag gefunden |
| `amount` | wie gedruckt, z. B. `3.454,00` |
| `amountNumber` | Zahl, z. B. `3454` |
| `currency` | `EUR` (Default), `USD`, `CHF`, `GBP` |
| `line` | Textzeile, aus der der Betrag stammt |
| `method` | `keyword`, `keyword-next-line`, `column-sum`, `sum-check`, `keyword-weak`, `largest` |
| `confidence` | `high` / `medium` / `low` – bei `low` (oder `medium`) in den Prüf-Zweig routen |
| `candidates` | bis zu 8 Kandidaten `Betrag | Score | Methode | Zeile` (Debugging) |
| `pages`, `text`, `textLength` | Seitenzahl, extrahierter Text (max. 100.000 Zeichen) |
| `warnings`, `error` | Hinweise / Fehlermeldung |

Parameter: `pdfBase64` (Pflicht, Base64 der PDF), `extraKeywords` (optional, kommagetrennt, z. B. `Auszahlung, Überweisungssumme` – markiert zusätzliche Betragszeilen).

## Einrichtung (einmalig)

1. Excel im Browser öffnen → Registerkarte **Automatisieren** → **Neues Skript** → kompletten Inhalt von `AvisPdfAmount.ts` einfügen → Skript umbenennen in **AvisPdfAmount** → speichern. Das Skript liegt dann in deinem OneDrive unter `Dokumente/Office Scripts`.
2. Leere Arbeitsmappe **AvisParser.xlsx** in OneDrive anlegen (normales .xlsx, kein „strict"-Format). Sie dient nur als Laufzeitkontext.
3. Voraussetzung: Office Scripts ist im Tenant aktiviert (M365-Business-Lizenz, Admin kann Office Scripts bzw. den Excel-Online-Connector sperren – vorher prüfen).

Tipp: Für Teams-Besitz das Skript in eine SharePoint-Bibliothek legen und **„Skript aus SharePoint-Bibliothek ausführen"** nutzen, dann hängt es nicht an deinem persönlichen OneDrive.

## Flow (Ergänzung deines bestehenden Flows)

Bestehend: Trigger „Bei Eingang einer neuen E-Mail (V3)" → Prüfung automatische Mail → „Auf alle anwenden" (Anlagen) → Dateiname enthält `avis` und `.pdf` → **Anlage abrufen (V2)**.

Benenne die Aktionen ohne Umlaute/Leerzeichen um (z. B. `Get_attachment`, `Run_script`), dann bleiben die Ausdrücke unten lesbar.

**Schleife:** Im Trigger und in „Auf alle anwenden" die Parallelität auf 1 stellen (Run script erlaubt 3 Aufrufe pro 10 s, 1.600 pro Tag und Nutzer).

### 1. Excel Online (Business) → Skript ausführen (`Run_script`)

| Feld | Wert |
|---|---|
| Speicherort | OneDrive for Business |
| Dokumentbibliothek | OneDrive |
| Datei | `AvisParser.xlsx` |
| Skript | AvisPdfAmount |
| pdfBase64 | `body('Get_attachment')?['contentBytes']` (Dynamischer Inhalt „Inhaltsbytes" von Anlage abrufen) |
| extraKeywords | leer lassen oder z. B. `Auszahlung` |

### 2. Bedingung: Betrag erkannt?

Ausdruck: `and(equals(outputs('Run_script')?['body/result/ok'], true), not(equals(outputs('Run_script')?['body/result/confidence'], 'low')))`

Bei vielen verschiedenen Kundenlayouts empfiehlt sich in den ersten Wochen: Betreff um `(method/confidence)` ergänzen und alles außer `high` kurz gegenprüfen.

### 3a. Ja-Zweig → E-Mail senden (V2)

Betreff:
```
concat('WG: ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'])
```
Beispiel: `WG: Zahlungsavis vom 01.10.2026 - 3.454,00 EUR`

Text (HTML, Codeansicht):
```
<p><b>Von:</b> @{triggerOutputs()?['body/from']}<br>
<b>Empfangen:</b> @{formatDateTime(triggerOutputs()?['body/receivedDateTime'], 'dd.MM.yyyy HH:mm')}<br>
<b>Betreff:</b> @{triggerOutputs()?['body/subject']}<br>
<b>Erkannter Betrag:</b> @{outputs('Run_script')?['body/result/amount']} @{outputs('Run_script')?['body/result/currency']}
(@{outputs('Run_script')?['body/result/method']})</p>
<hr>
@{triggerOutputs()?['body/body']}
```

Anlage: Name = `items('Apply_to_each')?['name']`, Inhalt = `body('Get_attachment')?['contentBytes']`.

### 3b. Nein-Zweig → gleiche Mail mit Hinweis

Betreff: `concat('WG: ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')`, im Body zusätzlich `outputs('Run_script')?['body/result/error']` und `join(outputs('Run_script')?['body/result/candidates'], '<br>')`. So geht nie eine Mail verloren.

### 4. Rote Kategorie auf der Original-Mail

Office 365 Outlook → **HTTP-Anforderung senden** (Standard-Aktion):

| Feld | Wert |
|---|---|
| URI | `https://graph.microsoft.com/v1.0/me/messages/@{triggerOutputs()?['body/id']}` |
| Methode | PATCH |
| Text | `{ "categories": ["Rote Kategorie"] }` |
| Content-Type | application/json |

Der Kategoriename muss exakt einer vorhandenen Outlook-Kategorie entsprechen (Standard in deutschem Outlook: „Rote Kategorie"). Für ein freigegebenes Postfach `/users/<postfach@firma.de>/messages/...` statt `/me/...`. Im Nein-Zweig z. B. „Gelbe Kategorie" setzen.

### Inline-Bilder / Signaturen

In „Auf alle anwenden" zusätzlich prüfen: `equals(items('Apply_to_each')?['isInline'], false)`, damit eingebettete Bilder gar nicht erst abgerufen werden.

## Debugging & Feintuning

- `text` und `candidates` im Ausführungsverlauf ansehen; bei Problemen beide in eine SharePoint-Liste schreiben (SharePoint-Standardaktion „Element erstellen").
- Schlüsselwörter stehen oben in `pickAmount` (`STRONG_KEYWORDS`, `WEAK_KEYWORDS`, `NEGATIVE_KEYWORDS`); Scores in derselben Funktion.
- Neue Kunden-Layouts: PDF lokal testen (siehe unten), falls nötig `extraKeywords` setzen oder Schlüsselwortliste ergänzen.

## Lokal testen (Mac)

Voraussetzung: Node 18+ und TypeScript (`npm i -g typescript`), für die Fixtures Python 3 mit `reportlab`, `python-docx`, `fonttools`, optional LibreOffice und qpdf.

```
./build.sh
```
```
node test/run.js
```
```
node test/run.js meine-datei
```

`build.sh` setzt die Teile aus `src/` zu `dist/AvisPdfAmount.ts` zusammen (das ist die Datei fürs Office-Script-Fenster) und prüft sie mit `tsc --strict`. `test/run.js` führt das kompilierte Skript gegen alle PDFs in `test/fixtures/` aus und vergleicht mit `expected.json`. Eigene Avis-PDFs einfach dort ablegen und in `expected.json` eintragen. Die Test-PDFs selbst liegen nicht im Repo; fehlende PDFs überspringt `test/run.js`.

## Plattform-Limits (Microsoft)

- Parameter max. 30.000.000 Bytes (28,6 MB), d. h. PDFs bis ca. 20 MB
- 120 s Timeout pro synchronem Power-Automate-Aufruf (typisch: < 1 s für ein Avis)
- 1.600 Run-script-Aufrufe pro Nutzer und Tag, 3 pro 10 s
- Kein `fetch`/Netzwerk aus Scripts unter Power Automate
