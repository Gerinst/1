# Avis-Flow Schritt für Schritt

Stand: 30.10.2026

## Überblick

Am Ende bekommst du für jedes Zahlungsavis eine Mail mit dem Betrag im Betreff (z. B. „[Avis-Bot] Zahlungsavis vom 01.10.2026 - 3.454,00 EUR"), und die Original-Mail hat in Outlook eine rote Kategorie. Konnte der Betrag nicht erkannt werden, kommt stattdessen eine Mail „Betrag nicht erkannt" mit gelber Kategorie.

## Wichtig: Schleifenschutz

Der Flow schickt seine Ergebnis-Mails an deine eigene Adresse, mit dem Avis-PDF im Anhang. Diese Mails landen im selben Posteingang, den der Flow überwacht. Ohne Schutz startet jede Ergebnis-Mail den Flow erneut, der schickt wieder eine Mail und so weiter: eine Endlosschleife („WG: WG: WG: …"), bis das Tageslimit von Microsoft aufgebraucht ist und echte Avise still liegen bleiben. Deshalb beginnen alle Mails des Flows mit `[Avis-Bot]`, und die äußere Bedingung lässt Mails mit `[Avis-Bot]` im Betreff nicht durch (Schritte 1c, 7 und 9).

**Schleifenschutz in einem bestehenden Flow nachrüsten (ca. 10 Minuten)**

Hast du den Flow nach einer früheren Fassung dieser Anleitung gebaut (Betreff der Ergebnis-Mails beginnt mit `WG: `), dann mach diese Schritte, **bevor** das nächste Avis durchläuft:

1. Falls sich schon Mails stapeln: make.powerautomate.com, **Meine Flows**, beim Flow auf **⋮** und **Ausschalten**. Danach die Schritte 2 bis 6, am Ende wieder einschalten.
2. Flow öffnen, oben **Bearbeiten**.
3. Die äußere **Bedingung** (direkt unter dem Trigger) anklicken. Die Zeile **Von | enthält nicht | noreply** umbauen: Links den Baustein „Von" mit dem **x** löschen, **Blitz**, unter dem Trigger **Betreff** wählen. Operator bleibt **enthält nicht**. Rechts `noreply` löschen und `[Avis-Bot]` eintippen, mit den eckigen Klammern. Hat deine Bedingung keine noreply-Zeile: **+ Zeile hinzufügen** und die Zeile so neu anlegen.
4. Aktion **Mail_mit_Betrag** (Wahr-Zweig von Betrag_erkannt) anklicken. Im Feld **Betreff** den vorhandenen fx-Baustein mit dem **x** löschen, dann **fx**, diese Formel einfügen, **Hinzufügen**:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'])`
5. Aktion **Mail_nicht_erkannt** (Falsch-Zweig von Betrag_erkannt) genauso, mit dieser Formel:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')`
6. **Speichern**. Falls du in Punkt 1 ausgeschaltet hast: zurück zu **Meine Flows**, **⋮**, **Einschalten**.
7. Prüfen wie in Schritt 10: Dir eine Test-Mail mit Avis-PDF schicken. Richtig ist: genau **eine** Mail „[Avis-Bot] …". Im Ausführungsverlauf stehen zwei Läufe, der echte und ein zweiter, den die [Avis-Bot]-Mail ausgelöst hat. Der zweite bleibt an der äußeren Bedingung stehen (Falsch-Zweig, keine Aktion). Das ist so gewollt.
8. Aufräumen: In Outlook nach `WG: WG:` suchen und die Mails aus der Schleife löschen.

Warum die noreply-Zeile wegfällt: Viele Buchhaltungssysteme (SAP und andere) verschicken echte Avise von noreply-Adressen. Mit der alten Zeile wären genau diese Avise still verloren gegangen.

Die Anleitung ist für den neuen Power-Automate-Designer auf Deutsch geschrieben: Aktion anklicken, dann öffnet sich links das Fenster mit den Reitern Parameter / Einstellungen / Codeansicht / Info. Eine Aktion hinzufügen heißt immer: auf das Plus unter der vorherigen Aktion klicken, im Fenster „Aktion hinzufügen" oben in die Suche tippen, Treffer anklicken.

Drei Begriffe, die unten immer wieder vorkommen:

- **Dynamischer Inhalt** = das Blitz-Symbol links neben einem Feld. Darüber holst du Werte aus vorherigen Aktionen (z. B. „Betreff" aus dem Trigger).
- **Ausdruck** = das fx-Symbol direkt unter dem Blitz. Dort fügst du Formeln ein, die du aus diesem Dokument kopierst. Formel einfügen, dann auf „Hinzufügen" klicken.
- **Umbenennen** = oben im Aktionsfenster auf den Namen der Aktion klicken (oder die drei Punkte ⋮ und „Umbenennen"). Die Formeln unten funktionieren nur, wenn drei Aktionen genau diese Namen tragen: `Apply_to_each`, `Get_attachment`, `Run_script`.

Was du brauchst, bevor es losgeht: die Datei `AvisPdfAmount.ts` (aus `dist/`), Zugriff auf Excel im Browser (office.com) und auf Power Automate (make.powerautomate.com), und einen bestehenden Flow mit dem Trigger „Bei Eingang einer neuen E-Mail (V3)".

## Schritt 1: Vorbereitung (einmalig, ca. 15 Minuten)

Diese vier Dinge müssen vor dem Flow-Umbau existieren.

**A. Das Office Script in Excel anlegen**

1. Im Browser office.com öffnen, mit dem Firmen-Account anmelden, Excel starten, „Neue leere Arbeitsmappe".
2. Oben im Menüband auf den Reiter **Automatisieren** klicken. (Fehlt der Reiter: Office Scripts ist im Tenant gesperrt, dann muss die IT es freischalten.)
3. Auf **Neues Skript** klicken. Rechts öffnet sich der Code-Editor mit einem Beispielskript.
4. Im Editor alles markieren (Strg+A) und löschen.
5. Den kompletten Inhalt der Datei `AvisPdfAmount.ts` kopieren: Auf GitHub die Datei öffnen und oben rechts auf **Copy raw file** klicken (Symbol mit den zwei Rechtecken). Liegt die Datei bei dir auf dem Rechner, sie mit einem Texteditor öffnen, alles markieren (Strg+A) und kopieren (Strg+C). Dann im Excel-Editor einfügen (Strg+V).
6. Oben im Editor auf den Skriptnamen („Skript 1") klicken und in **AvisPdfAmount** umbenennen.
7. **Skript speichern** klicken. Das Skript liegt jetzt in deinem OneDrive unter Dokumente/Office Scripts.
8. Kontrolle: Unter dem Editor darf keine rote Fehlermeldung stehen. Ein Klick auf „Ausführen" ist nicht nötig.

**B. Die Arbeitsmappe speichern**

1. Dieselbe leere Arbeitsmappe oben links über den Dateinamen in **AvisParser** umbenennen. Sie liegt automatisch in OneDrive.
2. Die Mappe bleibt leer. Sie wird nur gebraucht, weil „Skript ausführen" immer eine Excel-Datei verlangt.

**C. Kategorien in Outlook prüfen**

1. In Outlook eine beliebige Mail markieren, oben **Kategorisieren**, dann **Alle Kategorien**.
2. Es müssen **Rote Kategorie** und **Gelbe Kategorie** in der Liste stehen (Standard im deutschen Outlook). Falls sie umbenannt wurden: Die Namen notieren, sie werden in Schritt 8 und 9 exakt so eingetragen.

**D. Drei Aktionen im Flow umbenennen**

1. Power Automate öffnen, links **Meine Flows**, den Avis-Flow öffnen, oben **Bearbeiten**.
2. Auf die Aktion **Auf alle anwenden** klicken, im Fenster links oben auf den Namen klicken, ändern in `Apply_to_each`, Enter.
3. Auf **Anlage abrufen (V2)** klicken, Name ändern in `Get_attachment`, Enter.
4. Oben rechts **Speichern**. (Die dritte Umbenennung `Run_script` kommt in Schritt 4, wenn die Aktion existiert.)

Warum: Power Automate baut aus dem Aktionsnamen den internen Bezeichner. Mit Umlauten oder Leerzeichen würden alle Formeln in diesem Dokument anders heißen.

## Schritt 1b: Der bestehende Flow, geprüft

Typischer Ausgangsflow und was daran richtig bzw. zu korrigieren ist:

| Aktion | Inhalt | Ergebnis |
| --- | --- | --- |
| Trigger „Bei Eingang einer neuen E-Mail (V3)" | Ordner Inbox, Nur mit Anlagen Ja, Anlagen einschließen Ja, Wichtigkeit Beliebig | Richtig, nichts ändern |
| Äußere „Bedingung" | Betreff enthält nicht „enthält nicht", zweite Zeile leer | **Fehler, in Schritt 1c neu ausfüllen** |
| „Auf alle anwenden" | Anlagen | Richtig |
| „Aktuelle Anlage prüfen" (Verfassen) | Current item | Richtig, reine Anzeige |
| Innere „Bedingung 2" | name enthält avis, name endet mit .PDF, dritte Zeile leer | **Fast, in Schritt 3 nachbessern** |
| „Anlage abrufen (V2)" | Nachrichten-ID, id | Richtig |
| „Verfassen" (unten, leer) | leer | Wird in Schritt 4 durch „Skript ausführen" ersetzt |

Zur Benennung: Die innere Bedingung heißt im Ausgangsflow **„Bedingung 2"** (die mit name enthält avis). In dieser Anleitung ist mit „innere Bedingung" immer diese gemeint. Die neue Bedingung, die wir später anlegen, nennen wir **„Betrag_erkannt"**, damit nichts verwechselt wird.

**Was in der äußeren Bedingung schiefgelaufen ist:** Im rechten Feld steht der Text „enthält nicht", vermutlich versehentlich dort hineingetippt statt den Operator in der Mitte zu wählen. Die Bedingung prüft deshalb, ob der Betreff die Wörter „enthält nicht" nicht enthält. Das ist praktisch immer wahr, der Flow läuft also bei jeder Mail durch, auch bei Abwesenheitsnotizen. Die halbleere zweite Zeile kann außerdem beim Speichern einen Fehler auslösen.

## Schritt 1c: Äußere Bedingung korrigieren

Ziel: Automatische Antworten, Zustellfehler, Abwesenheitsnotizen und die eigenen Mails des Flows (`[Avis-Bot]`) sollen nicht durch den Flow laufen. Alles andere soll durch.

1. Auf die äußere **Bedingung** (direkt unter dem Trigger) klicken.
2. In der ersten Zeile im rechten Feld den Text „enthält nicht" komplett löschen und stattdessen eintippen: `Automatische Antwort`
3. Linkes Feld bleibt **Betreff**, Operator in der Mitte bleibt **enthält nicht**.
4. Zweite Zeile ausfüllen: Links in „Wert auswählen" klicken, **Blitz**, unter dem Trigger **Betreff** wählen. Operator: **enthält nicht**. Rechts eintippen: `Unzustellbar`
5. Auf **+ Zeile hinzufügen**. Dritte Zeile, der Schleifenschutz: Links Blitz, wieder **Betreff** aus dem Trigger. Operator: **enthält nicht**. Rechts: `[Avis-Bot]` (mit den eckigen Klammern). Ohne diese Zeile starten die Mails, die der Flow an dich schickt, den Flow immer wieder (siehe „Wichtig: Schleifenschutz" oben).
6. Der Kasten oben links bleibt auf **Und**.
7. Keine Zeile darf leer bleiben. Überschüssige Zeilen: rechts auf **⋯** klicken, **Löschen**.
8. **Speichern**.

| Links | Operator | Rechts |
| --- | --- | --- |
| Blitz: Betreff | enthält nicht | Automatische Antwort |
| Blitz: Betreff | enthält nicht | Unzustellbar |
| Blitz: Betreff | enthält nicht | [Avis-Bot] |

Der Falsch-Zweig bleibt leer (0 Aktionen). Wenn später weitere Automatik-Mails auffallen (z. B. „Out of Office"), einfach eine weitere Zeile nach demselben Muster anhängen.

## Schritt 2: Trigger und Schleife einstellen

Beides existiert schon, es fehlen nur zwei Einstellungen.

**Trigger „Bei Eingang einer neuen E-Mail (V3)"**

1. Oben im Flow auf den Trigger klicken.
2. Reiter **Parameter**: Falls die Felder „Nur mit Anlagen" und „Anlagen einschließen" nicht sichtbar sind, unten auf **Erweiterte Parameter** klicken und beide ankreuzen. Beide auf **Ja** stellen.
3. Reiter **Einstellungen**: Bei **Parallelitätssteuerung** den Schalter auf Ein, den Regler auf **1**.

**Schleife „Apply_to_each" (ehemals Auf alle anwenden)**

1. Auf die Schleife klicken.
2. Reiter **Parameter**: Im Feld „Ausgabe aus vorherigen Schritten auswählen" muss „Anlagen" aus dem Trigger stehen.
3. Reiter **Einstellungen**: **Parallelitätssteuerung** auf Ein, Regler auf **1**.
4. Oben rechts **Speichern**.

Warum die 1: Das Skript darf nur 3-mal in 10 Sekunden laufen. Kommen mehrere Avise gleichzeitig, würden parallele Läufe sonst mit einem Fehler abbrechen.

## Schritt 3: Innere „Bedingung 2" nachbessern

Die innere Bedingung 2 hat im Ausgangsflow schon die richtigen zwei Zeilen (name enthält avis, name endet mit .PDF). Zwei Dinge fehlen: Groß-/Kleinschreibung (Power Automate vergleicht exakt, „Zahlungsavis.pdf" endet nicht mit „.PDF" und „AVIS_4711.pdf" enthält nicht „avis") und der Ausschluss eingebetteter Bilder. Außerdem muss die leere dritte Zeile weg.

1. Auf **Bedingung 2** klicken (die innere, mit name enthält avis).
2. **Zeile 1:** Im linken Feld den Baustein **name** über sein **×** entfernen. Dann in das leere Feld klicken, auf das **fx**-Symbol, diese Formel einfügen, auf **Hinzufügen** klicken:
    `toLower(items('Apply_to_each')?['name'])`
    Operator bleibt **enthält**, rechts bleibt `avis`.
3. **Zeile 2:** Genauso den Baustein **name** entfernen und über fx dieselbe Formel einfügen. Operator bleibt **endet mit**. Rechts das `.PDF` löschen und klein eintippen: `.pdf`
4. **Zeile 3** (noch leer): Links in „Wert auswählen" klicken, fx, Formel einfügen, Hinzufügen:
    `items('Apply_to_each')?['isInline']`
    Operator: **ist gleich**. Rechts in „Wert auswählen" klicken, fx, `false` einfügen, Hinzufügen. (Über fx, nicht als Text, sonst vergleicht Power Automate mit dem Wort „false".)
5. Der Kasten oben links bleibt auf **Und**. Es darf keine weitere leere Zeile geben.
6. **Speichern**.

Falls der Name der Aktion im Fenster oben als „Bedingung 2" steht: so lassen. Nur die drei Aktionen aus Schritt 1 D werden umbenannt.

So sieht das Ergebnis aus:

| Links | Operator | Rechts |
| --- | --- | --- |
| fx `toLower(items('Apply_to_each')?['name'])` | enthält | avis |
| fx `toLower(items('Apply_to_each')?['name'])` | endet mit | .pdf |
| fx `items('Apply_to_each')?['isInline']` | ist gleich | fx `false` |

Optional, falls Avise auch mal anders heißen (z. B. „Zahlung_4711.pdf"), aber das Wort Avis im Betreff steht: Zeile 1 durch diese Formel mit Operator **ist gleich** und rechts fx `true` ersetzen:
`or(contains(toLower(items('Apply_to_each')?['name']), 'avis'), contains(toLower(triggerOutputs()?['body/subject']), 'avis'))`

Der Falsch-Zweig von Bedingung 2 bleibt leer (0 Aktionen): Signaturbilder und andere Anhänge werden einfach übersprungen.

## Schritt 4: „Skript ausführen" einfügen

Die neue Aktion kommt in den Wahr-Zweig der inneren Bedingung 2, direkt unter „Get_attachment" (Anlage abrufen). Ein bisheriges leeres „Verfassen" kannst du vorher löschen (drei Punkte ⋮ auf der Aktion, Löschen) oder stehen lassen, es stört nicht.

1. Auf das **Plus** direkt unter **Get_attachment** klicken, dann **Aktion hinzufügen**.
2. Im Suchfeld oben `Skript ausführen` tippen. In der Trefferliste den Eintrag **Skript ausführen** unter **Excel Online (Business)** anklicken (nicht „Skript aus SharePoint-Bibliothek ausführen").
3. Falls ein Anmeldefenster kommt: mit dem Firmen-Account anmelden. Das legt die Excel-Verbindung an.
4. Die Felder nacheinander ausfüllen. Jedes Feld lädt seine Auswahl erst, wenn das Feld darüber gefüllt ist:

| Feld | Was eintragen |
| --- | --- |
| Speicherort | OneDrive for Business |
| Dokumentbibliothek | OneDrive |
| Datei | Ordnersymbol rechts anklicken, zu **AvisParser.xlsx** navigieren, anklicken |
| Skript | Aus der Liste **AvisPdfAmount** wählen |
| pdfBase64 | In das Feld klicken, **Blitz** (Dynamischer Inhalt) anklicken, bei „Get_attachment" den Eintrag **Inhaltsbytes** wählen |
| extraKeywords | leer lassen |

5. Die Felder pdfBase64 und extraKeywords erscheinen erst, nachdem das Skript gewählt wurde (Power Automate liest sie aus dem Skript). Erscheinen sie nicht: Skript in Excel noch einmal speichern, dann hier das Skript neu auswählen.
6. Oben im Fenster auf den Aktionsnamen klicken und umbenennen in `Run_script`, Enter.
7. **Speichern**.

Tipp: Im Feld „Inhaltsbytes" steht die PDF als langer Text (Base64). Das ist richtig so, das Skript wandelt es selbst zurück.

## Schritt 5: Verfassen als Kontrollanzeige (optional, empfohlen für den Anfang)

Damit siehst du im Ausführungsverlauf auf einen Blick, was das Skript aus der PDF gelesen hat.

1. Auf das **Plus** unter **Run_script** klicken, **Aktion hinzufügen**.
2. `Verfassen` suchen, unter **Datenvorgang** den Eintrag **Verfassen** anklicken.
3. In das Feld **Eingaben** klicken, **fx** anklicken, einfügen, Hinzufügen:
    `outputs('Run_script')?['body/result']`
4. Aktion umbenennen in `Skriptergebnis`.
5. **Speichern**.

Nach einem Testlauf (Schritt 10) zeigt diese Aktion `amount`, `method`, `confidence`, die Kandidatenliste und den kompletten gelesenen Text. Läuft alles stabil, kannst du die Aktion später löschen.

## Schritt 6: Bedingung „Betrag_erkannt" anlegen

1. Auf das **Plus** unter der letzten Aktion im Wahr-Zweig (Skriptergebnis bzw. Run_script) klicken, **Aktion hinzufügen**.
2. `Bedingung` suchen, unter **Steuerung** den Eintrag **Bedingung** anklicken. Es erscheint eine neue Bedingung mit Wahr- und Falsch-Zweig.
3. Aktion umbenennen in `Betrag_erkannt`.
4. Im Fenster links: In das linke Feld „Wert auswählen" klicken, **fx**, diese Formel einfügen, Hinzufügen:
    `and(equals(outputs('Run_script')?['body/result/ok'], true), not(equals(outputs('Run_script')?['body/result/confidence'], 'low')))`
5. Operator: **ist gleich**. Rechtes Feld: **fx**, `true` einfügen, Hinzufügen.
6. **Speichern**.

Die Formel bedeutet: Das Skript hat einen Betrag gefunden (`ok`) und ist sich nicht unsicher (`confidence` ist nicht `low`). Alles andere geht in den Falsch-Zweig und wird dir zur Prüfung zugeschickt.

## Schritt 7: Wahr-Zweig, E-Mail mit Betrag im Betreff

Die Original-Mail kann Power Automate nicht umbenennen (Microsoft erlaubt das nur bei Entwürfen). Deshalb schickst du dir eine neue Mail, die wie eine Weiterleitung aussieht, aber den Betrag im Betreff trägt.

1. Im Zweig **Wahr** von Betrag_erkannt auf das **Plus** klicken, **Aktion hinzufügen**.
2. `E-Mail senden` suchen, unter **Office 365 Outlook** den Eintrag **E-Mail senden (V2)** anklicken.
3. Aktion umbenennen in `Mail_mit_Betrag`.
4. **An:** deine E-Mail-Adresse eintippen.
5. **Betreff:** In das Feld klicken, **fx**, Formel einfügen, Hinzufügen. Das `[Avis-Bot]` am Anfang ist der Schleifenschutz, nicht weglassen:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'])`
6. **Text:** Rechts über dem Textfeld auf das Symbol **</>** (Codeansicht) klicken, damit du HTML eingeben kannst. Dann diesen Block komplett einfügen. Die Teile mit `@{...}` wandelt Power Automate beim Einfügen automatisch in bunte Bausteine um:

```
<p><b>Von:</b> @{triggerOutputs()?['body/from']}<br>
<b>Empfangen:</b> @{formatDateTime(triggerOutputs()?['body/receivedDateTime'], 'dd.MM.yyyy HH:mm')}<br>
<b>Betreff:</b> @{triggerOutputs()?['body/subject']}<br>
<b>Betrag:</b> @{outputs('Run_script')?['body/result/amount']} @{outputs('Run_script')?['body/result/currency']} (@{outputs('Run_script')?['body/result/method']}, @{outputs('Run_script')?['body/result/confidence']})</p>
<hr>
@{triggerOutputs()?['body/body']}
```

7. Werden die `@{...}`-Teile nicht umgewandelt (sie stehen als normaler Text da): Jeden einzeln löschen und über **fx** einfügen, dabei das `@{` am Anfang und das `}` am Ende weglassen.
8. **Anlagen:** Unten auf **Erweiterte Parameter** klicken, **Anlagen** ankreuzen. Dann:
    - **Anlagen Name:** fx, `items('Apply_to_each')?['name']`, Hinzufügen
    - **Anlagen Inhalt:** fx, `body('Get_attachment')?['contentBytes']`, Hinzufügen
9. **Speichern**.

Ergebnis: Eine Mail an dich mit Betreff „[Avis-Bot] Zahlungsavis vom 01.10.2026 - 3.454,00 EUR", oben Absender, Empfangszeit, Originalbetreff und Betrag, darunter der Originaltext, die PDF hängt an.

## Schritt 8: Wahr-Zweig, rote Kategorie auf die Original-Mail

Der Outlook-Connector hat keine Aktion „Kategorie setzen". Dafür gibt es die Standard-Aktion „HTTP-Anforderung senden" im Office-365-Outlook-Connector. Sie schickt Outlook den Befehl „setz auf dieser Mail die Kategorie Rot". Keine Premium-Lizenz, läuft über dieselbe Outlook-Verbindung.

1. Im Zweig **Wahr** auf das **Plus** unter **Mail_mit_Betrag** klicken, **Aktion hinzufügen**.
2. `HTTP-Anforderung senden` suchen. Achtung, es gibt mehrere Treffer mit diesem Namen: den unter **Office 365 Outlook** nehmen (Outlook-Symbol davor), nicht den unter „Office 365-Benutzer" und nicht den Premium-Connector „HTTP".
3. Aktion umbenennen in `Kategorie_rot`.
4. Felder ausfüllen:

| Feld | Was eintragen |
| --- | --- |
| URI | `https://graph.microsoft.com/v1.0/me/messages/` eintippen und direkt dahinter, ohne Leerzeichen, über den **Blitz** den Wert **Nachrichten-ID** aus dem Trigger einfügen |
| Methode | **PATCH** aus der Liste wählen |
| Text | `{ "categories": ["Rote Kategorie"] }` |
| Content-Type | `application/json` (steht meist schon drin) |

5. **Speichern**.

Hinweise:

- Der Kategoriename muss exakt so heißen wie in Outlook (Schritt 1 C). Groß-/Kleinschreibung zählt.
- Soll die Kategorie zusätzlich zu schon vorhandenen Kategorien gesetzt werden statt sie zu ersetzen, ist das für Avis-Mails normalerweise egal, da sie keine haben.
- Freigegebenes Postfach statt deinem eigenen: In der URI `/me/messages/` durch `/users/postfach@firma.de/messages/` ersetzen.

## Schritt 9: Falsch-Zweig, Prüf-Mail und gelbe Kategorie

Hier landet alles, was das Skript nicht sicher lesen konnte (kein Betrag gefunden, PDF verschlüsselt, reiner Scan, zwei ähnlich gute Beträge). Du bekommst trotzdem eine Mail, damit nichts verloren geht.

**A. E-Mail senden (V2)**

1. Im Zweig **Falsch** von Betrag_erkannt auf das **Plus** klicken, **Aktion hinzufügen**, `E-Mail senden` suchen, **E-Mail senden (V2)** unter Office 365 Outlook wählen.
2. Umbenennen in `Mail_nicht_erkannt`.
3. **An:** deine Adresse.
4. **Betreff:** fx, Formel einfügen, Hinzufügen (auch hier `[Avis-Bot]` am Anfang nicht weglassen):
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')`
5. **Text:** Codeansicht **</>** anklicken, einfügen:

```
<p><b>Grund:</b> @{outputs('Run_script')?['body/result/error']}<br>
<b>Methode / Sicherheit:</b> @{outputs('Run_script')?['body/result/method']} / @{outputs('Run_script')?['body/result/confidence']}</p>
<p><b>Gefundene Beträge (Betrag | Punkte | Methode | Textzeile):</b><br>
@{join(outputs('Run_script')?['body/result/candidates'], '<br>')}</p>
<hr>
<p><b>Von:</b> @{triggerOutputs()?['body/from']} · <b>Betreff:</b> @{triggerOutputs()?['body/subject']}</p>
@{triggerOutputs()?['body/body']}
```

6. **Anlagen** wie in Schritt 7: Name `items('Apply_to_each')?['name']`, Inhalt `body('Get_attachment')?['contentBytes']`.
7. **Speichern**.

**B. Gelbe Kategorie**

1. Unter **Mail_nicht_erkannt** auf das **Plus**, `HTTP-Anforderung senden` unter **Office 365 Outlook** wählen.
2. Umbenennen in `Kategorie_gelb`.
3. Genau wie in Schritt 8 ausfüllen, nur im Text: `{ "categories": ["Gelbe Kategorie"] }`
4. **Speichern**.

Was du mit der Prüf-Mail machst: Die Liste „Gefundene Beträge" zeigt dir, welche Zahlen das Skript gesehen hat und warum es unsicher war. Taucht ein Kundenlayout wiederholt hier auf, siehst du an der Textzeile das fehlende Schlüsselwort und trägst es bei Run_script im Feld **extraKeywords** ein (z. B. `Auszahlung`).

## Schritt 10: Testen und Fehler finden

**Testlauf**

1. Oben rechts **Speichern**, dann **Testen**, **Manuell**, **Testen**. Der Flow wartet jetzt auf eine Mail.
2. Dir selbst eine Mail mit einem echten Avis-PDF im Anhang schicken (Dateiname muss „avis" enthalten).
3. Nach 1 bis 2 Minuten zeigt Power Automate den Lauf. Grüne Haken = Aktion gelaufen, rotes X = Fehler, grauer Pfeil = übersprungen (z. B. der nicht genommene Zweig, das ist normal).
4. Auf **Skriptergebnis** (oder Run_script) klicken: Unter **Ausgaben** siehst du `amount`, `method`, `confidence` und den gelesenen Text.
5. In Outlook prüfen: Genau eine neue Mail „[Avis-Bot] …" mit Betrag im Betreff da? Original-Mail rot markiert?
6. Schleifenschutz prüfen: Unter **Ausführungsverlauf** steht ein zweiter Lauf, ausgelöst durch die [Avis-Bot]-Mail. Er muss an der äußeren Bedingung stehen bleiben (Falsch-Zweig). Läuft er weiter bis Run_script: Flow sofort ausschalten und Schritt 1c prüfen.

**Typische Fehler und was dahintersteckt**

| Was du siehst | Ursache | Lösung |
| --- | --- | --- |
| Mails „WG: WG: WG: …" oder „[Avis-Bot] [Avis-Bot] …" stapeln sich | Schleifenschutz fehlt: die eigenen Mails des Flows starten ihn erneut | Flow sofort ausschalten (Meine Flows, ⋮, Ausschalten), dann „Schleifenschutz nachrüsten" ganz oben |
| Run_script: „BadGateway" oder „We couldn't find the script" | Skript nicht gespeichert oder falscher Name | In Excel prüfen, dass das Skript **AvisPdfAmount** heißt und gespeichert ist, dann in Run_script neu auswählen |
| Run_script: Felder pdfBase64 / extraKeywords fehlen | Skript wurde vor dem Speichern ausgewählt | Skript in Run_script einmal abwählen und neu wählen |
| Run_script: „The request content size exceeds the limit" | PDF größer als ca. 20 MB | Kommt bei Avisen praktisch nie vor; sonst Mail in den Falsch-Zweig lassen |
| Run_script: Timeout nach 120 s | Riesige PDF oder Skript hängt | Skript hat ein 90-s-Limit und meldet dann „time budget exhausted", Mail landet im Falsch-Zweig |
| Run_script: 429 „Rate limit" | Mehrere Avise gleichzeitig | Parallelität bei Trigger und Schleife auf 1 prüfen (Schritt 2) |
| Betrag_erkannt geht immer nach Falsch | Skriptausgabe nicht gelesen | In Skriptergebnis nachsehen: steht `ok: false` mit `error`, ist die PDF ein Scan oder verschlüsselt; steht `ok: true`, prüfe die Formel in Betrag_erkannt |
| Falscher Betrag gewählt | Layout mit ungewöhnlichem Label | In der Kandidatenliste das richtige Wort finden und in **extraKeywords** eintragen |
| Kategorie_rot: 404 Not Found | Nachrichten-ID falsch oder freigegebenes Postfach | URI prüfen: `/me/messages/` + Nachrichten-ID direkt dahinter, ohne Leerzeichen; bei Shared Mailbox `/users/…/messages/` |
| Kategorie_rot: 403 Forbidden | Keine Berechtigung auf das Postfach | Verbindung im Flow mit dem Konto anlegen, dem das Postfach gehört |
| Kategorie wird nicht angezeigt | Name weicht ab | Exakten Namen aus Outlook (Kategorisieren, Alle Kategorien) übernehmen |
| Mail_mit_Betrag: Betreff zeigt `@{…}` als Text | Ausdruck nicht als Baustein übernommen | Feld leeren und über fx einfügen |
| Mail kommt doppelt | Avis-PDF ist zweimal angehängt oder zwei Avise in einer Mail | Normal, pro PDF eine Mail |

**Flow einschalten**

Nach erfolgreichem Test: Zurück zur Flow-Übersicht, der Flow muss auf **Ein** stehen. Ab dann läuft er bei jeder neuen Mail automatisch.

## Anhang: Alle Formeln zum Kopieren

Jede Formel wird über das **fx**-Symbol eingefügt, dann **Hinzufügen**. Voraussetzung sind die Aktionsnamen `Apply_to_each`, `Get_attachment`, `Run_script`.

| Wo | Formel |
| --- | --- |
| Bedingung 2 (innere), Zeile 1 und 2, links | `toLower(items('Apply_to_each')?['name'])` |
| Bedingung 2 (innere), Zeile 3, links | `items('Apply_to_each')?['isInline']` |
| Bedingung 2 (innere), Zeile 3, rechts | `false` |
| Bedingung 2 (innere), Variante mit Betreff | `or(contains(toLower(items('Apply_to_each')?['name']), 'avis'), contains(toLower(triggerOutputs()?['body/subject']), 'avis'))` |
| Run_script, pdfBase64 (Alternative zum Blitz) | `body('Get_attachment')?['contentBytes']` |
| Skriptergebnis, Eingaben | `outputs('Run_script')?['body/result']` |
| Betrag_erkannt, links | `and(equals(outputs('Run_script')?['body/result/ok'], true), not(equals(outputs('Run_script')?['body/result/confidence'], 'low')))` |
| Betrag_erkannt, rechts | `true` |
| Äußere Bedingung, Zeile 3 (Schleifenschutz) | links Blitz **Betreff**, Operator **enthält nicht**, rechts `[Avis-Bot]` |
| Mail_mit_Betrag, Betreff | `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'])` |
| Mail_nicht_erkannt, Betreff | `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')` |
| Beide Mails, Anlagen Name | `items('Apply_to_each')?['name']` |
| Beide Mails, Anlagen Inhalt | `body('Get_attachment')?['contentBytes']` |
| Beide Mails, Absender | `triggerOutputs()?['body/from']` |
| Beide Mails, Empfangsdatum | `formatDateTime(triggerOutputs()?['body/receivedDateTime'], 'dd.MM.yyyy HH:mm')` |
| Beide Mails, Originaltext | `triggerOutputs()?['body/body']` |
| Mail_nicht_erkannt, Kandidaten | `join(outputs('Run_script')?['body/result/candidates'], '<br>')` |
| Kategorie_rot / Kategorie_gelb, URI | `https://graph.microsoft.com/v1.0/me/messages/` + Nachrichten-ID (Blitz) |
| Kategorie_rot, Text | `{ "categories": ["Rote Kategorie"] }` |
| Kategorie_gelb, Text | `{ "categories": ["Gelbe Kategorie"] }` |

Was das Skript zurückgibt (alles unter `outputs('Run_script')?['body/result/…']`): `ok` (true/false), `amount` (z. B. 3.454,00), `amountNumber` (3454), `currency` (EUR), `line` (die Textzeile), `method` (keyword, keyword-next-line, column-sum, largest), `confidence` (high, medium, low), `candidates` (Liste), `pages`, `text`, `error`, `warnings`.
