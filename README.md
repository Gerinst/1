# AvisPdfAmount

Liest aus jedem Zahlungsavis-PDF den Zahlbetrag aus. Power Automate schickt dir dann eine Mail mit dem Betrag im Betreff und markiert das Original in Outlook rot. Das Skript läuft als Office Script über Excel Online (Business) → „Skript ausführen": Standard-Connector, keine AI-Builder-Credits, keine Drittanbieter.

## Diese drei Dateien brauchst du

| Datei | Wofür |
|---|---|
| [docs/ANLEITUNG.md](docs/ANLEITUNG.md) | **Hier anfangen.** Schritt für Schritt vom Skript bis zum fertigen Flow, mit allen Formeln zum Kopieren und einer Fehlertabelle. |
| [dist/AvisPdfAmount.ts](dist/AvisPdfAmount.ts) | Das Skript für Excel. Datei öffnen, oben rechts auf **Copy raw file** klicken (Symbol mit den zwei Rechtecken) und in Excel einfügen (Anleitung, Schritt 1 A). |
| [dist/avis-flow.html](dist/avis-flow.html) | Übersicht aller Flow-Aktionen und Felder auf einer Seite. GitHub zeigt die Datei nur als Code: oben rechts auf **Download raw file** klicken und die heruntergeladene Datei per Doppelklick im Browser öffnen. |

## Gut zu wissen

- Verschlüsselte PDFs und reine Scans ohne Textschicht kann das Skript nicht lesen. Solche Avise landen im Flow im Prüf-Zweig („Betrag nicht erkannt"), es geht also keine Mail verloren.
- Limits von Microsoft: PDFs bis ca. 20 MB, „Skript ausführen" höchstens 3-mal in 10 Sekunden und 1.600-mal pro Tag und Nutzer.
