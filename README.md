# AvisPdfAmount

Liest aus jedem Zahlungsavis-PDF den Zahlbetrag aus. Power Automate schickt dir dann eine Mail mit dem Betrag im Betreff und markiert das Original in Outlook rot. Das Skript läuft als Office Script über Excel Online (Business) → „Skript ausführen": Standard-Connector, keine AI-Builder-Credits, keine Drittanbieter.

## Diese drei Dateien brauchst du

| Datei | Wofür |
|---|---|
| [docs/ANLEITUNG.md](docs/ANLEITUNG.md) | **Hier anfangen.** Schritt für Schritt vom Skript bis zum fertigen Flow, mit allen Formeln zum Kopieren, einer Fehlertabelle und den Gründen der Prüf-Mail auf Deutsch. Hast du den Flow schon gebaut: Abschnitt „Bestehenden Flow auf diese Fassung bringen". |
| [dist/AvisPdfAmount.ts](dist/AvisPdfAmount.ts) | Das Skript für Excel. Datei öffnen, oben rechts auf **Copy raw file** klicken (Symbol mit den zwei Rechtecken) und in Excel einfügen (Anleitung, Schritt 1 A). |
| [dist/avis-flow.html](dist/avis-flow.html) | Übersicht aller Flow-Aktionen und Felder auf einer Seite. GitHub zeigt die Datei nur als Code: oben rechts auf **Download raw file** klicken und die heruntergeladene Datei per Doppelklick im Browser öffnen. |

## Gut zu wissen

- **Rote Mail:** Der Betrag steht im Betreff, im Text steht die Zeile aus der PDF, aus der er stammt („Gelesen aus"). Endet der Betreff auf „(prüfen)", ist sich das Skript nur mittelmäßig sicher. In den ersten 2 bis 4 Wochen jede rote Mail kurz gegen die PDF prüfen.
- **Gelbe Mail („Betrag nicht erkannt"):** Hier landet alles, was das Skript nicht sicher lesen kann, mit dem Grund. Die Anleitung übersetzt jeden Grund ins Deutsche (Anhang B). Für jede Anlage, die der Flow an das Skript gibt (Dateiname mit „avis", Anleitung Schritt 3), kommt eine Mail, auch wenn das Skript selbst nicht laufen kann. Avise mit anderem Dateinamen meldet nur der Tagescheck.
- **Gehen in die gelbe Mail:** PDFs mit Kennwort zum Öffnen oder mit Zertifikat-Verschlüsselung, reine Scans ohne Text, Scans mit nachträglicher Texterkennung (OCR), Dokumente, die kein Zahlungsavis sind (z. B. Mahnung, Lieferschein, Lastschriftankündigung, Angebot, Rechnung ohne Zahlungsangabe), verschlüsselte oder mit Microsoft Purview geschützte Mails und unklare Fälle wie zwei ähnlich gute Beträge oder ein Abzug neben der Summe. Beträge ohne Nachkommastellen („3.454 EUR") werden nicht gelesen.
- **Werden normal gelesen:** PDFs, die nur gegen Kopieren oder Drucken geschützt sind, und signierte Avis-Mails (S/MIME). Bei signierten Mails sieht Power Automate nur die Anlage `smime.p7m`; das Skript packt sie selbst aus. Der Flow gibt sie an das Skript, wenn „avis" im Betreff oder im Dateinamen steht (Anleitung, Schritt 3).
- **Tagescheck (optional):** Ein zweiter kleiner Flow meldet jeden Morgen um 07:00 in einer Mail, welche Avis-Mails der letzten 24 Stunden weder rot noch gelb markiert sind (Anleitung, Schritt 11).
- Limits von Microsoft: PDFs bis ca. 20 MB, „Skript ausführen" höchstens 3-mal in 10 Sekunden und 1.600-mal pro Tag und Nutzer.
