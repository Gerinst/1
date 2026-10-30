# Avis-Flow Schritt für Schritt

Stand: 30.10.2026

## Überblick

Am Ende bekommst du für jedes Zahlungsavis eine Mail mit dem Betrag im Betreff (z. B. „[Avis-Bot] Zahlungsavis vom 01.10.2026 - 3.454,00 EUR"), und die Original-Mail hat in Outlook eine rote Kategorie. In der Mail steht auch die Textzeile, aus der der Betrag gelesen wurde („Gelesen aus"). Konnte der Betrag nicht sicher erkannt werden, kommt stattdessen eine Mail „Betrag nicht erkannt" mit gelber Kategorie und dem Grund. Das gilt auch, wenn das Skript selbst nicht laufen konnte.

Signierte Avis-Mails (S/MIME) liest das Skript selbst aus. Verschlüsselte Mails kann es nicht öffnen, sie kommen als gelbe Prüf-Mail. Ein zweiter, kleiner Flow (Schritt 11, optional) prüft jeden Morgen, ob ein Avis liegen geblieben ist.

## Wichtig: Schleifenschutz

Der Flow schickt seine Ergebnis-Mails an deine eigene Adresse, mit dem Avis-PDF im Anhang. Diese Mails landen im selben Posteingang, den der Flow überwacht. Ohne Schutz startet jede Ergebnis-Mail den Flow erneut, der schickt wieder eine Mail und so weiter: eine Endlosschleife („WG: WG: WG: …"), bis das Tageslimit von Microsoft aufgebraucht ist und echte Avise still liegen bleiben. Deshalb beginnen alle Mails des Flows mit `[Avis-Bot]`, und die äußere Bedingung lässt Mails mit `[Avis-Bot]` im Betreff nicht durch (Schritte 1c, 7 und 9). Auch die Mail des Tageschecks (Schritt 11) beginnt mit `[Avis-Bot]`.

**Schleifenschutz in einem bestehenden Flow nachrüsten (ca. 10 Minuten)**

Hast du den Flow nach einer früheren Fassung dieser Anleitung gebaut (Betreff der Ergebnis-Mails beginnt mit `WG: `), dann mach diese Schritte, **bevor** das nächste Avis durchläuft:

1. Falls sich schon Mails stapeln: make.powerautomate.com, **Meine Flows**, beim Flow auf **⋮** und **Ausschalten**. Danach die Schritte 2 bis 6, am Ende wieder einschalten.
2. Flow öffnen, oben **Bearbeiten**.
3. Die äußere **Bedingung** (direkt unter dem Trigger) anklicken. Die Zeile **Von | enthält nicht | noreply** umbauen: Links den Baustein „Von" mit dem **x** löschen, **Blitz**, unter dem Trigger **Betreff** wählen. Operator bleibt **enthält nicht**. Rechts `noreply` löschen und `[Avis-Bot]` eintippen, mit den eckigen Klammern. Hat deine Bedingung keine noreply-Zeile: **+ Zeile hinzufügen** und die Zeile so neu anlegen.
4. Aktion **Mail_mit_Betrag** (Wahr-Zweig von Betrag_erkannt) anklicken. Im Feld **Betreff** den vorhandenen fx-Baustein mit dem **x** löschen, dann **fx**, diese Formel einfügen, **Hinzufügen**:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'], if(equals(outputs('Run_script')?['body/result/confidence'], 'medium'), ' (prüfen)', ''))`
5. Aktion **Mail_nicht_erkannt** (Falsch-Zweig von Betrag_erkannt) genauso, mit dieser Formel:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')`
6. **Speichern**. Falls du in Punkt 1 ausgeschaltet hast: zurück zu **Meine Flows**, **⋮**, **Einschalten**.
7. Prüfen wie in Schritt 10: Dir eine Test-Mail mit Avis-PDF schicken. Richtig ist: genau **eine** Mail „[Avis-Bot] …". Im Ausführungsverlauf stehen zwei Läufe, der echte und ein zweiter, den die [Avis-Bot]-Mail ausgelöst hat. Der zweite bleibt an der äußeren Bedingung stehen (Falsch-Zweig, keine Aktion). Das ist so gewollt.
8. Aufräumen: In Outlook nach `WG: WG:` suchen und die Mails aus der Schleife löschen.

Warum die noreply-Zeile wegfällt: Viele Buchhaltungssysteme (SAP und andere) verschicken echte Avise von noreply-Adressen. Mit der alten Zeile wären genau diese Avise still verloren gegangen.

## Bestehenden Flow auf diese Fassung bringen (ca. 30 Minuten)

Hast du den Flow schon nach einer früheren Fassung gebaut, reichen diese Punkte. Beginnen deine Ergebnis-Mails noch mit `WG: `, mach vorher den Abschnitt „Schleifenschutz nachrüsten" oben. Jeder Punkt verweist auf den Schritt weiter unten, in dem die Klicks genau beschrieben sind.

In jedem Feld, das du neu befüllst, zuerst den alten Inhalt entfernen: fx- oder Blitz-Bausteine über ihr **×**, im Feld **Text** in der Codeansicht **</>** mit Strg+A und Entf. Sonst hängt Power Automate alten und neuen Inhalt aneinander, und bei den Anlagen kommt eine unlesbare Datei an.

1. **Neues Skript einfügen:** Excel im Browser, Reiter **Automatisieren**, **Alle Skripts** (bzw. **Skripts anzeigen**), **AvisPdfAmount** anklicken, **Bearbeiten**. Im Editor Strg+A, Entf, dann den Inhalt der neuen `AvisPdfAmount.ts` einfügen (wie Schritt 1 A, Punkt 5) und **Skript speichern**. Die Felder bleiben gleich.
2. **Run_script, Feld pdfBase64** umstellen: den Blitz-Baustein „Inhaltsbytes" über sein **×** entfernen, dann **fx** und `base64(body('Get_attachment')?['contentBytes'])` eingeben, **Hinzufügen** (Schritt 4, Punkt 4). Ohne diese Änderung übergibt Power Automate die PDF oft als Text statt als Base64. Die meisten PDFs sind dann nicht mehr lesbar, und es kommt die gelbe Mail mit „not a PDF (header missing, …)" oder „PDF arrived as text instead of Base64".
3. **Bedingung 2** neu fassen, damit signierte Avis-Mails durchkommen: Schritt 3. Hattest du die optionale Betreff-Variante (rechts fx `true`): vorher den Hinweis „Früher mit Betreff-Variante" am Ende von Schritt 3 lesen.
4. **Run_script** bekommt eine Wiederholungsrichtlinie: Schritt 4, Punkte 8 und 9.
5. **Betrag_erkannt** (und Skriptergebnis, falls vorhanden) läuft auch, wenn Run_script fehlschlägt: Schritt 6, Punkte 7 bis 10.
6. **Mail_mit_Betrag:** neuer Betreff und neuer Text (Schritt 7, Punkte 5 und 6).
7. **Mail_nicht_erkannt:** neuer Text und neue Anlagen-Formeln (Schritt 9 A, Punkte 5 und 6).
8. **Speichern**, dann die Tests aus Schritt 10.
9. Optional: den Tagescheck anlegen (Schritt 11).

## Begriffe

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
2. Es müssen **Rote Kategorie** und **Gelbe Kategorie** in der Liste stehen (Standard im deutschen Outlook). Falls sie umbenannt wurden: Die Namen notieren, sie werden in Schritt 8, 9 und 11 exakt so eingetragen.

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
| Innere „Bedingung 2" | name enthält avis, name endet mit .PDF, dritte Zeile leer | **Fast, in Schritt 3 neu fassen** |
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

## Schritt 3: Innere „Bedingung 2" neu fassen

Bedingung 2 entscheidet, welche Anlage an das Skript geht. Sie lässt zwei Fälle durch:

- **Normales Avis:** Der Dateiname enthält „avis" und endet auf „.pdf". Groß-/Kleinschreibung ist egal („AVIS_4711.PDF" zählt auch).
- **Signierte oder geschützte Avis-Mail:** Bei einer signierten Mail (S/MIME) sieht Power Automate statt der PDF nur eine einzige Anlage `smime.p7m`. Bei einer mit Microsoft Purview geschützten Mail heißt sie `message.rpmsg`. Diese Anlagen gehen an das Skript, wenn der **Betreff** oder der Dateiname „avis" enthält (auch eine einzeln signierte PDF wie `Zahlungsavis.pdf.p7m`). Das Skript packt signierte Mails selbst aus und liest die PDF darin. Ob die Signatur gültig ist, prüft es nicht; das zeigt dir Outlook beim Öffnen der Original-Mail. Verschlüsselte oder geschützte Mails kann es nicht öffnen: Dann kommt eine gelbe Prüf-Mail mit dem Grund.

Beide Fälle stehen zusammen in der Formel von Zeile 1. Zeile 2 schließt eingebettete Bilder aus (z. B. Logos in der Signatur).

1. Auf **Bedingung 2** klicken (die innere, mit name enthält avis).
2. **Zeile 1:** Im linken Feld den vorhandenen Baustein (**name** oder den fx-Baustein `toLower(…)`) über sein **×** entfernen. Dann in das leere Feld klicken, auf das **fx**-Symbol, diese Formel einfügen, auf **Hinzufügen** klicken:
    `or(and(contains(toLower(items('Apply_to_each')?['name']), 'avis'), endsWith(toLower(items('Apply_to_each')?['name']), '.pdf')), and(or(endsWith(toLower(items('Apply_to_each')?['name']), '.p7m'), endsWith(toLower(items('Apply_to_each')?['name']), '.rpmsg')), contains(toLower(concat(items('Apply_to_each')?['name'], ' ', coalesce(triggerOutputs()?['body/subject'], ''))), 'avis')))`
3. Operator in der Mitte auf **ist gleich** stellen. Im rechten Feld den Text `avis` löschen, dann **fx**, `true` einfügen, **Hinzufügen**. (Über fx, nicht als Text, sonst vergleicht Power Automate mit dem Wort „true". Steht rechts schon ein fx-Baustein `true`, weil du früher die optionale Betreff-Variante genommen hast: so lassen, aber den Hinweis „Früher mit Betreff-Variante" am Ende dieses Schritts lesen.)
4. **Zeile mit „endet mit .PDF / .pdf":** Diese Prüfung steckt jetzt in der Formel von Zeile 1. Rechts in der Zeile auf **⋯** klicken, **Löschen**.
5. **Zeile mit isInline:** Hast du sie schon (links fx `items('Apply_to_each')?['isInline']`, ist gleich, rechts fx `false`), bleibt sie, wie sie ist. Sonst die leere Zeile nehmen oder **+ Zeile hinzufügen**: Links in „Wert auswählen" klicken, fx, Formel einfügen, Hinzufügen:
    `items('Apply_to_each')?['isInline']`
    Operator: **ist gleich**. Rechts in „Wert auswählen" klicken, fx, `false` einfügen, Hinzufügen.
6. Der Kasten oben links bleibt auf **Und**. Es darf keine weitere Zeile geben, auch keine leere.
7. **Speichern**.

Falls der Name der Aktion im Fenster oben als „Bedingung 2" steht: so lassen. Nur die drei Aktionen aus Schritt 1 D werden umbenannt.

So sieht das Ergebnis aus:

| Links | Operator | Rechts |
| --- | --- | --- |
| fx `or(and(contains(toLower(items('Apply_to_each')?['name']), 'avis'), …` (die lange Formel aus Punkt 2) | ist gleich | fx `true` |
| fx `items('Apply_to_each')?['isInline']` | ist gleich | fx `false` |

Der Falsch-Zweig von Bedingung 2 bleibt leer (0 Aktionen): Signaturbilder und andere Anhänge werden einfach übersprungen.

Avise, deren Dateiname kein „avis" enthält (z. B. „Zahlung_4711.pdf"), lässt diese Bedingung bewusst noch nicht durch. Sie bekommen **keine** Mail und keine Kategorie. Ob das nötig ist, siehst du nach ein paar Wochen am Tagescheck (Schritt 11): Er listet Mails mit „avis" im Betreff, die der Flow nicht bearbeitet hat.

**Früher mit Betreff-Variante:** Hattest du in Zeile 1 die optionale Formel mit dem Betreff, hat dein Flow solche Avise bisher gelesen. Mit der neuen Formel kommen sie ohne Meldung nicht mehr an. Kommen sie bei dir vor, nimm in Zeile 1 stattdessen diese Formel (jede PDF, .p7m- oder .rpmsg-Anlage, wenn Dateiname oder Betreff „avis" enthält; wie früher kommt dann bei mehreren PDFs in einer Mail für jede PDF eine eigene Mail):
    `and(or(endsWith(toLower(items('Apply_to_each')?['name']), '.pdf'), endsWith(toLower(items('Apply_to_each')?['name']), '.p7m'), endsWith(toLower(items('Apply_to_each')?['name']), '.rpmsg')), contains(toLower(concat(items('Apply_to_each')?['name'], ' ', coalesce(triggerOutputs()?['body/subject'], ''))), 'avis'))`
    Sonst den Tagescheck (Schritt 11) auf jeden Fall einrichten.

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
| pdfBase64 | In das Feld klicken, **fx** (Ausdruck) anklicken, `base64(body('Get_attachment')?['contentBytes'])` eingeben, **Hinzufügen**. Nicht den Blitz-Eintrag „Inhaltsbytes" nehmen (siehe Tipp unten) |
| extraKeywords | leer lassen |

5. Die Felder pdfBase64 und extraKeywords erscheinen erst, nachdem das Skript gewählt wurde (Power Automate liest sie aus dem Skript). Erscheinen sie nicht: Skript in Excel noch einmal speichern, dann hier das Skript neu auswählen.
6. Oben im Fenster auf den Aktionsnamen klicken und umbenennen in `Run_script`, Enter.
7. **Speichern**.
8. **Wiederholungsrichtlinie:** Bei Run_script den Reiter **Einstellungen** öffnen. Unter **Wiederholungsrichtlinie** den Typ **Festes Intervall** wählen, **Anzahl** `3`, **Intervall** `PT1M` (eine Minute).
9. **Speichern**.

Tipp: Warum `base64(…)` um die Inhaltsbytes? Wählt man „Inhaltsbytes" direkt über den Blitz, gibt Power Automate die Anlage an das Skript oft als Text weiter statt als Base64. Dabei gehen bei den meisten PDFs Teile verloren. Mit `base64(…)` kommt die Anlage sicher als Text aus Base64-Zeichen an, das Skript wandelt sie selbst zurück (auch wenn Power Automate unterwegs einmal umwandelt). Bei signierten Mails steht dort die ganze signierte Nachricht, auch das liest das Skript.

Warum die Wiederholung: Schlägt Run_script wegen einer kurzen Störung fehl (z. B. „BadGateway" oder 429 „Rate limit", weil gerade mehrere Avise kamen), versucht Power Automate es nach einer Minute noch einmal, höchstens dreimal. Klappt es dann immer noch nicht, kommt die gelbe Prüf-Mail mit dem Grund (Schritt 6 und 9).

## Schritt 5: Verfassen als Kontrollanzeige (optional, empfohlen für den Anfang)

Damit siehst du im Ausführungsverlauf auf einen Blick, was das Skript aus der PDF gelesen hat.

1. Auf das **Plus** unter **Run_script** klicken, **Aktion hinzufügen**.
2. `Verfassen` suchen, unter **Datenvorgang** den Eintrag **Verfassen** anklicken.
3. In das Feld **Eingaben** klicken, **fx** anklicken, einfügen, Hinzufügen:
    `outputs('Run_script')?['body/result']`
4. Aktion umbenennen in `Skriptergebnis`.
5. **Speichern**.

Nach einem Testlauf (Schritt 10) zeigt diese Aktion `amount`, `method`, `confidence`, die Kandidatenliste und den kompletten gelesenen Text. Läuft alles stabil, kannst du die Aktion später löschen. Wichtig: Solange es Skriptergebnis gibt, braucht auch diese Aktion die Einstellung „Ausführen nach" aus Schritt 6, Punkt 9.

## Schritt 6: Bedingung „Betrag_erkannt" anlegen

1. Auf das **Plus** unter der letzten Aktion im Wahr-Zweig (Skriptergebnis bzw. Run_script) klicken, **Aktion hinzufügen**.
2. `Bedingung` suchen, unter **Steuerung** den Eintrag **Bedingung** anklicken. Es erscheint eine neue Bedingung mit Wahr- und Falsch-Zweig.
3. Aktion umbenennen in `Betrag_erkannt`.
4. Im Fenster links: In das linke Feld „Wert auswählen" klicken, **fx**, diese Formel einfügen, Hinzufügen:
    `and(equals(outputs('Run_script')?['body/result/ok'], true), not(equals(outputs('Run_script')?['body/result/confidence'], 'low')))`
5. Operator: **ist gleich**. Rechtes Feld: **fx**, `true` einfügen, Hinzufügen.
6. **Speichern**.

Die Formel bedeutet: Das Skript hat einen Betrag gefunden (`ok`) und ist sich nicht unsicher (`confidence` ist nicht `low`). Alles andere geht in den Falsch-Zweig und wird dir zur Prüfung zugeschickt.

**Auch bei Skriptfehlern eine Prüf-Mail bekommen („Ausführen nach")**

Normalerweise überspringt Power Automate alle folgenden Aktionen, wenn Run_script fehlschlägt, zu lange braucht oder übersprungen wird. Dann käme gar keine Mail. Mit dieser Einstellung läuft Betrag_erkannt trotzdem, landet im Falsch-Zweig, und die gelbe Mail nennt den Grund.

7. Auf **Betrag_erkannt** klicken, Reiter **Einstellungen**, Abschnitt **Ausführen nach**.
8. Dort steht die Aktion direkt darüber (Run_script oder Skriptergebnis). Eintrag aufklappen und **alle vier** Häkchen setzen: ist erfolgreich, Timeout, wurde übersprungen, ist fehlgeschlagen.
9. Gibt es **Skriptergebnis** (Schritt 5): dort genauso, Reiter **Einstellungen**, **Ausführen nach**, beim Eintrag Run_script alle vier Häkchen.
10. **Speichern**. Der Pfeil zwischen den Aktionen ist danach anders gezeichnet (gestrichelt oder mit Symbol). Das ist richtig.

## Schritt 7: Wahr-Zweig, E-Mail mit Betrag im Betreff

Die Original-Mail kann Power Automate nicht umbenennen (Microsoft erlaubt das nur bei Entwürfen). Deshalb schickst du dir eine neue Mail, die wie eine Weiterleitung aussieht, aber den Betrag im Betreff trägt.

1. Im Zweig **Wahr** von Betrag_erkannt auf das **Plus** klicken, **Aktion hinzufügen**.
2. `E-Mail senden` suchen, unter **Office 365 Outlook** den Eintrag **E-Mail senden (V2)** anklicken.
3. Aktion umbenennen in `Mail_mit_Betrag`.
4. **An:** deine E-Mail-Adresse eintippen.
5. **Betreff:** In das Feld klicken, **fx**, Formel einfügen, Hinzufügen. Das `[Avis-Bot]` am Anfang ist der Schleifenschutz, nicht weglassen:
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'], if(equals(outputs('Run_script')?['body/result/confidence'], 'medium'), ' (prüfen)', ''))`
6. **Text:** Rechts über dem Textfeld auf das Symbol **</>** (Codeansicht) klicken, damit du HTML eingeben kannst. Dann diesen Block komplett einfügen. Die Teile mit `@{...}` wandelt Power Automate beim Einfügen automatisch in bunte Bausteine um:

```
<p><b>Von:</b> @{triggerOutputs()?['body/from']}<br>
<b>Empfangen:</b> @{convertFromUtc(triggerOutputs()?['body/receivedDateTime'], 'W. Europe Standard Time', 'dd.MM.yyyy HH:mm')}<br>
<b>Betreff:</b> @{triggerOutputs()?['body/subject']}<br>
<b>Betrag:</b> @{outputs('Run_script')?['body/result/amount']} @{outputs('Run_script')?['body/result/currency']} (@{outputs('Run_script')?['body/result/method']}, @{outputs('Run_script')?['body/result/confidence']})<br>
<b>Gelesen aus:</b> @{outputs('Run_script')?['body/result/line']}<br>
<b>Hinweise:</b> @{outputs('Run_script')?['body/result/warnings']}</p>
<hr>
@{triggerOutputs()?['body/body']}
```

7. Werden die `@{...}`-Teile nicht umgewandelt (sie stehen als normaler Text da): Jeden einzeln löschen und über **fx** einfügen, dabei das `@{` am Anfang und das `}` am Ende weglassen.
8. **Anlagen:** Unten auf **Erweiterte Parameter** klicken, **Anlagen** ankreuzen. Dann:
    - **Anlagen Name:** fx, `items('Apply_to_each')?['name']`, Hinzufügen
    - **Anlagen Inhalt:** fx, `body('Get_attachment')?['contentBytes']`, Hinzufügen
9. **Speichern**.

Ergebnis: Eine Mail an dich mit Betreff „[Avis-Bot] Zahlungsavis vom 01.10.2026 - 3.454,00 EUR", oben Absender, Empfangszeit, Originalbetreff, Betrag und die Zeile „Gelesen aus", darunter der Originaltext, die PDF hängt an.

Was die neuen Zeilen bedeuten:

- **„(prüfen)" am Ende des Betreffs:** Das Skript hat den Betrag gefunden, ist sich aber nur mittelmäßig sicher (`confidence` = `medium`). Der Betrag ist meistens richtig, aber kurz gegen die PDF schauen.
- **Gelesen aus:** die Textzeile aus der PDF, in der der Betrag stand, z. B. „Zahlbetrag 3.454,00 EUR". Steht dort etwas anderes als eine Summen- oder Zahlbetragszeile (z. B. eine einzelne Rechnung oder „Skonto"), stimmt der Betrag wahrscheinlich nicht.
- **Hinweise:** technische Hinweise des Skripts, meistens leer. „decrypted (permissions-only encryption)" heißt: Die PDF hatte nur einen Kopier- oder Druckschutz und wurde normal gelesen. Mehr dazu im Anhang B.
- **Signierte Mails:** Hier hängt an der [Avis-Bot]-Mail die Datei `smime.p7m` statt der PDF. Die PDF siehst du, wenn du die Original-Mail (rot markiert) in Outlook öffnest.

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
- Die Aktion ersetzt vorhandene Kategorien der Mail. Avis-Mails haben normalerweise keine, das ist also egal.
- Freigegebenes Postfach statt deinem eigenen: In der URI `/me/messages/` durch `/users/postfach@firma.de/messages/` ersetzen.
- Wird die Original-Mail verschoben (durch dich oder eine Outlook-Regel), bevor der Flow fertig ist, bekommt sie in Outlook eine neue Nachrichten-ID. Kategorie_rot meldet dann **404 Not Found**. Die [Avis-Bot]-Mail ist trotzdem schon da, nur die Farbe fehlt. Siehe Fehlertabelle in Schritt 10.

## Schritt 9: Falsch-Zweig, Prüf-Mail und gelbe Kategorie

Hier landet alles, was das Skript nicht sicher lesen konnte: kein Betrag gefunden, PDF verschlüsselt, reiner Scan, zwei ähnlich gute Beträge, verschlüsselte Mail. Auch wenn das Skript einen Betrag gefunden hat, aber unsicher ist, kommt die Mail hierher. Dann beginnt der Grund mit `uncertain:`. Und wenn Run_script gar nicht laufen konnte, steht im Grund „Skript nicht gelaufen". Du bekommst also immer eine Mail, damit nichts verloren geht.

**A. E-Mail senden (V2)**

1. Im Zweig **Falsch** von Betrag_erkannt auf das **Plus** klicken, **Aktion hinzufügen**, `E-Mail senden` suchen, **E-Mail senden (V2)** unter Office 365 Outlook wählen.
2. Umbenennen in `Mail_nicht_erkannt`.
3. **An:** deine Adresse.
4. **Betreff:** fx, Formel einfügen, Hinzufügen (auch hier `[Avis-Bot]` am Anfang nicht weglassen):
    `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')`
5. **Text:** Codeansicht **</>** anklicken, einfügen:

```
<p><b>Grund:</b> @{coalesce(outputs('Run_script')?['body/result/error'], concat('Skript nicht gelaufen (', actions('Run_script')?['status'], '): ', coalesce(outputs('Run_script')?['body/message'], actions('Run_script')?['error']?['message'], '')))}<br>
<b>Methode / Sicherheit:</b> @{outputs('Run_script')?['body/result/method']} / @{outputs('Run_script')?['body/result/confidence']}</p>
<p><b>Gefundene Beträge (Betrag | Punkte | Methode | Textzeile):</b><br>
@{join(coalesce(outputs('Run_script')?['body/result/candidates'], createArray()), '<br>')}</p>
<hr>
<p><b>Von:</b> @{triggerOutputs()?['body/from']} · <b>Betreff:</b> @{triggerOutputs()?['body/subject']}</p>
@{triggerOutputs()?['body/body']}
```

6. **Anlagen:** Unten auf **Erweiterte Parameter** klicken, **Anlagen** ankreuzen. Hier sind die Formeln etwas länger als in Schritt 7, weil sie auch den seltenen Fall abfangen, dass schon die Anlage nicht abgerufen werden konnte:
    - **Anlagen Name:** fx, `if(empty(body('Get_attachment')?['contentBytes']), 'Anlage_fehlt.txt', items('Apply_to_each')?['name'])`, Hinzufügen
    - **Anlagen Inhalt:** fx, `coalesce(body('Get_attachment')?['contentBytes'], base64('Die Anlage konnte nicht abgerufen werden. Bitte die Original-Mail in Outlook ansehen.'))`, Hinzufügen
7. **Speichern**.

**B. Gelbe Kategorie**

1. Unter **Mail_nicht_erkannt** auf das **Plus**, `HTTP-Anforderung senden` unter **Office 365 Outlook** wählen.
2. Umbenennen in `Kategorie_gelb`.
3. Genau wie in Schritt 8 ausfüllen, nur im Text: `{ "categories": ["Gelbe Kategorie"] }`
4. **Speichern**.

**C. Was du mit der Prüf-Mail machst**

1. Den **Grund** lesen. Das Skript schreibt ihn auf Englisch. Was er auf Deutsch bedeutet und was zu tun ist, steht im **Anhang B** ganz unten. Steht dort `uncertain:`, hat das Skript einen Betrag gefunden, traut ihm aber nicht. Nach dem Doppelpunkt folgen ein oder mehrere Gründe, getrennt durch `;`.
2. Den Betrag in der PDF (Anhang oder Original-Mail) selbst ablesen.
3. Die Liste „Gefundene Beträge" zeigt, welche Zahlen das Skript gesehen hat. Die erste Zeile ist sein bester Kandidat. Taucht ein Kundenlayout wiederholt hier auf, siehst du an der Textzeile das fehlende Schlüsselwort und trägst es bei Run_script im Feld **extraKeywords** ein (z. B. `Auszahlung`).

## Schritt 10: Testen und Fehler finden

**Testlauf**

1. Oben rechts **Speichern**, dann **Testen**, **Manuell**, **Testen**. Der Flow wartet jetzt auf eine Mail.
2. Dir selbst eine Mail mit einem echten Avis-PDF im Anhang schicken (Dateiname muss „avis" enthalten).
3. Nach 1 bis 2 Minuten zeigt Power Automate den Lauf. Grüne Haken = Aktion gelaufen, rotes X = Fehler, grauer Pfeil = übersprungen (z. B. der nicht genommene Zweig, das ist normal).
4. Auf **Skriptergebnis** (oder Run_script) klicken: Unter **Ausgaben** siehst du `amount`, `method`, `confidence` und den gelesenen Text.
5. In Outlook prüfen: Genau eine neue Mail „[Avis-Bot] …" mit Betrag im Betreff da? Original-Mail rot markiert?
6. Schleifenschutz prüfen: Unter **Ausführungsverlauf** steht ein zweiter Lauf, ausgelöst durch die [Avis-Bot]-Mail. Er muss an der äußeren Bedingung stehen bleiben (Falsch-Zweig). Läuft er weiter bis Run_script: Flow sofort ausschalten und Schritt 1c prüfen.

**Drei Testmails und was du jeweils sehen solltest**

Für jede Testmail vorher wieder **Testen**, **Manuell**, **Testen** klicken, oder den Flow eingeschaltet lassen und im **Ausführungsverlauf** nachsehen.

| Test | So verschickst du ihn | Das solltest du sehen |
| --- | --- | --- |
| 1. Normales Avis | Mail an dich, Avis-PDF anhängen, Dateiname z. B. `Zahlungsavis_Test.pdf` | Eine Mail „[Avis-Bot] … - 3.454,00 EUR" (dein Betrag). Im Text bei **Gelesen aus** die Zahlbetrag- oder Summenzeile der PDF. Original rot. |
| 2. Dateiname in Großbuchstaben | Dieselbe PDF vorher umbenennen in `TEST_AVIS.PDF`, wieder an dich schicken | Genau wie Test 1. Kommt keine [Avis-Bot]-Mail und steht Bedingung 2 im Verlauf auf Falsch: Zeile 1 in Schritt 3 prüfen. |
| 3. Signierte Mail | Mail mit Betreff `Test Avis signiert`, Avis-PDF anhängen, **digital signiert** senden (siehe unten) | Im Verlauf hat Apply_to_each genau eine Anlage `smime.p7m`, Bedingung 2 ist Wahr. Eine Mail „[Avis-Bot] Test Avis signiert - 3.454,00 EUR" mit **Gelesen aus**, bei **Hinweise** steht `from signed mail:` und der Name deiner PDF. Anhang dieser Mail ist `smime.p7m`. Original rot. |

So schickst du eine signierte Mail, falls du ein S/MIME-Zertifikat hast (sonst fragst du deine IT, oder du wartest auf das erste echte signierte Avis und schaust dir dann den Lauf im Verlauf an):

- **Outlook (klassisch, Windows):** Neue E-Mail, Reiter **Optionen**, **Signieren** anklicken (fehlt der Knopf: Datei, Optionen, Trust Center, Einstellungen für das Trust Center, E-Mail-Sicherheit, „Ausgehenden Nachrichten digitale Signatur hinzufügen").
- **Thunderbird:** Das Zertifikat unter Konten-Einstellungen, **Ende-zu-Ende-Verschlüsselung**, S/MIME einrichten. Beim Schreiben oben **Sicherheit** (bzw. **OpenPGP/S/MIME**), **Digital unterschreiben**.
- Nur signieren, **nicht verschlüsseln**. Eine verschlüsselte Mail kann das Skript nicht öffnen: Sie kommt als gelbe Mail mit dem Grund „S/MIME encrypted mail". Auch das kannst du testen, wenn du willst.

**Pilotphase: die ersten 2 bis 4 Wochen**

Am Anfang jede rote Mail kurz prüfen, bevor du den Betrag weiterverwendest:

1. Stimmt der Betrag im Betreff mit dem Zahlbetrag in der PDF überein?
2. Steht bei **Gelesen aus** die Zeile mit dem Gesamt- bzw. Zahlbetrag (z. B. „Zahlbetrag", „Überweisungsbetrag", „Summe")? Wenn dort eine einzelne Rechnung, ein Skonto oder ein Kontostand steht, ist der Betrag verdächtig.
3. Mails mit „(prüfen)" im Betreff immer gegen die PDF prüfen.
4. Findest du einen falschen Betrag in einer roten Mail: Betrag von Hand korrigieren, die Mail aufheben und das Layout (ohne echte Namen) an die Person geben, die das Skript pflegt. Willst du bis dahin vorsichtiger sein, mach Betrag_erkannt strenger: Dann wird nur noch `high` rot, `medium` geht in die gelbe Prüf-Mail. Dafür in Betrag_erkannt (Schritt 6, Punkt 4) die Formel ersetzen durch:
    `and(equals(outputs('Run_script')?['body/result/ok'], true), equals(outputs('Run_script')?['body/result/confidence'], 'high'))`
    In diesen gelben Mails ist das Feld **Grund** leer und bei **Methode / Sicherheit** steht `medium`: Das Skript hält den Betrag in der ersten Zeile von „Gefundene Beträge" für wahrscheinlich richtig.

Stimmen in der Pilotphase alle roten Mails, reicht danach ein Blick auf die Mails mit „(prüfen)" und auf die gelben.

**Typische Fehler und was dahintersteckt**

| Was du siehst | Ursache | Lösung |
| --- | --- | --- |
| Mails „WG: WG: WG: …" oder „[Avis-Bot] [Avis-Bot] …" stapeln sich | Schleifenschutz fehlt: die eigenen Mails des Flows starten ihn erneut | Flow sofort ausschalten (Meine Flows, ⋮, Ausschalten), dann „Schleifenschutz nachrüsten" ganz oben |
| Gelbe Mail, Grund „Skript nicht gelaufen (Failed): …" | Run_script ist auch nach drei Wiederholungen fehlgeschlagen. Hinter dem Doppelpunkt steht die Meldung von Microsoft | Betrag von Hand aus der PDF nehmen. Kommt das bei jedem Avis: die nächsten Zeilen dieser Tabelle prüfen |
| Gelbe Mail, Grund „Skript nicht gelaufen (TimedOut): …" | Run_script hat länger als 120 s gebraucht | Betrag von Hand. Kommt fast nie vor, weil das Skript nach 90 s selbst aufhört. Dann kommt die gelbe Mail mit „PDF read incompletely (time budget exhausted)" |
| Gelbe Mail, Grund „Skript nicht gelaufen (Skipped): …", Anhang `Anlage_fehlt.txt` | Schon Get_attachment ist fehlgeschlagen, die Anlage konnte nicht geholt werden | Original-Mail in Outlook öffnen, Betrag von Hand |
| Lauf bricht bei Run_script ab (rotes X), keine gelbe Mail | „Ausführen nach" fehlt bei Betrag_erkannt oder Skriptergebnis | Schritt 6, Punkte 7 bis 10 |
| Run_script: „BadGateway" oder „We couldn't find the script" | Skript nicht gespeichert oder falscher Name | In Excel prüfen, dass das Skript **AvisPdfAmount** heißt und gespeichert ist, dann in Run_script neu auswählen |
| Gelbe Mail bei jedem Avis, Grund „not a PDF (header missing, …; input … starts '%PDF…')" oder „PDF arrived as text instead of Base64" | Power Automate gibt die PDF als Text weiter, weil im Feld pdfBase64 der Blitz-Eintrag „Inhaltsbytes" steht | In Run_script das Feld pdfBase64 auf fx `base64(body('Get_attachment')?['contentBytes'])` umstellen (Schritt 4, Punkt 4) |
| Run_script: Felder pdfBase64 / extraKeywords fehlen | Skript wurde vor dem Speichern ausgewählt | Skript in Run_script einmal abwählen und neu wählen |
| Run_script: „The request content size exceeds the limit" | PDF größer als ca. 15 MB | Kommt bei Avisen praktisch nie vor; die gelbe Mail kommt trotzdem (Grund „Skript nicht gelaufen") |
| Run_script: 429 „Rate limit" | Mehrere Avise gleichzeitig | Parallelität bei Trigger und Schleife auf 1 prüfen (Schritt 2), Wiederholungsrichtlinie prüfen (Schritt 4) |
| Betrag_erkannt geht immer nach Falsch | Skriptausgabe nicht gelesen | Grund in der gelben Mail mit Anhang B vergleichen. Steht dort nichts Passendes und in Skriptergebnis `ok: true` mit `confidence` high oder medium: Formel in Betrag_erkannt prüfen |
| Signierte Avis-Mail: keine [Avis-Bot]-Mail, Bedingung 2 im Verlauf Falsch | Die einzige Anlage heißt `smime.p7m`, und im Betreff steht kein „avis" | So gewollt (Schritt 3): Ohne „avis" im Betreff ist nicht zu erkennen, dass die Mail ein Avis ist. Auch der Tagescheck sieht sie deshalb nicht. Betrag von Hand; kommt das bei einem Absender öfter vor, Schritt 3 erweitern lassen |
| Gelbe Mail, Grund „S/MIME encrypted mail" oder „protected mail (Microsoft Purview)" | Die Mail ist verschlüsselt bzw. geschützt, nur Outlook kann sie öffnen | Original-Mail in Outlook öffnen, Betrag von Hand. Auf Dauer: Absender bitten, Avise nur zu signieren, nicht zu verschlüsseln |
| Falscher Betrag gewählt | Layout mit ungewöhnlichem Label | **Gelesen aus** zeigt die falsche Zeile. In der Kandidatenliste das richtige Wort finden und in **extraKeywords** eintragen; siehe auch „Pilotphase" oben |
| Kategorie_rot/Kategorie_gelb: 404 Not Found, bei jedem Avis | Nachrichten-ID falsch oder freigegebenes Postfach | URI prüfen: `/me/messages/` + Nachrichten-ID direkt dahinter, ohne Leerzeichen; bei Shared Mailbox `/users/…/messages/` |
| Kategorie_rot/Kategorie_gelb: 404 Not Found, nur ab und zu | Die Original-Mail wurde verschoben oder gelöscht, bevor der Flow fertig war (beim Verschieben ändert Outlook die Nachrichten-ID) | Die [Avis-Bot]-Mail ist trotzdem da. Kategorie in Outlook von Hand setzen. Verschiebt eine Outlook-Regel Avise sofort in einen anderen Ordner: Regel abschalten. Wählst du stattdessen im Trigger diesen Ordner, sieht der Tagescheck (Schritt 11) diese Mails nicht |
| Kategorie_rot: 403 Forbidden | Keine Berechtigung auf das Postfach | Verbindung im Flow mit dem Konto anlegen, dem das Postfach gehört |
| Kategorie wird nicht angezeigt | Name weicht ab | Exakten Namen aus Outlook (Kategorisieren, Alle Kategorien) übernehmen |
| Mail_mit_Betrag: Betreff zeigt `@{…}` als Text | Ausdruck nicht als Baustein übernommen | Feld leeren und über fx einfügen |
| Mail kommt doppelt | Avis-PDF ist zweimal angehängt oder zwei Avise in einer Mail | Normal, pro PDF eine Mail. Die Original-Mail trägt danach nur die Farbe der zuletzt geprüften PDF: Ist eine der [Avis-Bot]-Mails gelb, sie trotzdem prüfen, auch wenn das Original rot ist |
| „[Avis-Bot] Tagescheck: N Avis-Mails nicht bearbeitet" | Siehe Schritt 11, Teil G | Siehe Schritt 11, Teil G |

**Flow einschalten**

Nach erfolgreichem Test: Zurück zur Flow-Übersicht, der Flow muss auf **Ein** stehen. Ab dann läuft er bei jeder neuen Mail automatisch.

## Schritt 11 (optional): Tagescheck um 07:00 Uhr

Ein zweiter, eigener Flow schaut jeden Morgen in deinen Posteingang. Findet er Mails aus den letzten 24 Stunden, in deren Betreff oder Anlagennamen „avis" steht, die aber weder rot noch gelb markiert sind, schickt er dir **eine** Mail mit der Liste. So fällt auf, wenn ein Avis liegen geblieben ist: Der Flow war aus, ein Lauf ist abgebrochen, die Anlage hieß anders, oder die Kategorie konnte nicht gesetzt werden. Er prüft nur den Posteingang: Mails, die schon in einen anderen Ordner verschoben wurden, sieht er nicht. Sind alle Avise bearbeitet, kommt keine Mail.

Er braucht nur Standard-Aktionen (ca. 20 Minuten). Die Mails holt er mit derselben Aktion „HTTP-Anforderung senden" wie die Kategorien in Schritt 8. Die Aktion „E-Mails abrufen (V3)" passt hier nicht, weil sie die Outlook-Kategorien nicht mitliefert.

**A. Neuen Flow anlegen**

1. make.powerautomate.com, links **Erstellen**, **Geplanter Cloud-Flow**.
2. Flowname: `Avis-Tagescheck`. **Startdatum:** morgen, Uhrzeit **07:00**. **Wiederholen alle:** `1` **Tag**. **Erstellen**.
3. Den Trigger **Wiederholung** anklicken. Unter **Erweiterte Parameter** (bzw. „Optionen anzeigen"): **Zeitzone** „(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien", **Zu diesen Stunden** `7`, **Zu diesen Minuten** `0`.
4. **Speichern**.

**B. Mails der letzten 24 Stunden holen**

1. **Plus** unter dem Trigger, **Aktion hinzufügen**, `HTTP-Anforderung senden` unter **Office 365 Outlook** wählen (wie in Schritt 8, nicht „Office 365-Benutzer", nicht den Premium-Connector „HTTP").
2. Umbenennen in `Mails_holen`.
3. **Methode:** **GET**.
4. **URI:** In das Feld klicken, **fx**, diese Formel einfügen, **Hinzufügen**:
    `concat('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ', formatDateTime(addMinutes(utcNow(), -1560), 'yyyy-MM-ddTHH:mm:ssZ'), ' and receivedDateTime lt ', formatDateTime(addMinutes(utcNow(), -30), 'yyyy-MM-ddTHH:mm:ssZ'), ' and hasAttachments eq true&$select=subject,from,receivedDateTime,categories&$expand=attachments($select=name)&$top=250')`
5. **Text** leer lassen. **Speichern**.

Was die Formel tut: Sie holt aus dem Posteingang alle Mails mit Anlage, die zwischen 26 Stunden und 30 Minuten vor dem Lauf angekommen sind, mit Betreff, Absender, Eingangszeit, Kategorien und Anlagennamen. Die letzten 30 Minuten fehlen absichtlich, weil der Avis-Flow diese Mails eventuell gerade noch bearbeitet. Sie kommen am nächsten Morgen dran. Die 1½ Stunden, die sich mit dem Vortag überschneiden, sind Absicht: So fällt bei der Umstellung auf Winterzeit und bei einem verspäteten Start keine Mail durch. Eine unbearbeitete Mail von 05:00 bis 06:30 Uhr kann deshalb an zwei Morgen in der Liste stehen. Freigegebenes Postfach: `/me/` durch `/users/postfach@firma.de/` ersetzen.

**C. Nur die nicht bearbeiteten Avis-Mails behalten**

1. **Plus** unter **Mails_holen**, `Array filtern` suchen, unter **Datenvorgang** **Array filtern** wählen.
2. Umbenennen in `Avis_offen`.
3. **Von:** fx, `body('Mails_holen')?['value']`, Hinzufügen.
4. Bedingungszeile: Links fx, diese Formel, Hinzufügen:
    `and(or(contains(toLower(coalesce(item()?['subject'], '')), 'avis'), contains(toLower(string(coalesce(item()?['attachments'], createArray()))), 'avis')), not(contains(coalesce(item()?['subject'], ''), '[Avis-Bot]')), not(contains(coalesce(item()?['categories'], createArray()), 'Rote Kategorie')), not(contains(coalesce(item()?['categories'], createArray()), 'Gelbe Kategorie')))`
5. Operator **ist gleich**, rechts fx `true`, Hinzufügen.
6. **Speichern**.

Die Formel behält eine Mail, wenn „avis" im Betreff oder in einem Anlagennamen steht, der Betreff **nicht** `[Avis-Bot]` enthält (Schleifenschutz: die eigenen Mails des Flows und frühere Tagescheck-Mails zählen nicht) und sie weder die rote noch die gelbe Kategorie hat. Hast du die Kategorien umbenannt (Schritt 1 C), hier die Namen genauso ändern.

**D. Nur weitermachen, wenn etwas offen ist**

1. **Plus** unter **Avis_offen**, `Bedingung` unter **Steuerung**.
2. Umbenennen in `Etwas_offen`.
3. Links fx, `length(body('Avis_offen'))`, Hinzufügen. Operator **ist größer als**. Rechts fx, `0`, Hinzufügen.
4. **Speichern**. Der Falsch-Zweig bleibt leer.

**E. Liste als Tabelle (im Wahr-Zweig)**

1. Im Zweig **Wahr** auf das **Plus**, `HTML-Tabelle erstellen` unter **Datenvorgang**.
2. Umbenennen in `Tabelle`.
3. **Von:** fx, `body('Avis_offen')`, Hinzufügen.
4. **Spalten:** auf **Benutzerdefiniert** stellen. Drei Zeilen anlegen, jeweils links die Überschrift eintippen und rechts den Wert über fx einfügen:

| Kopfzeile | Wert (fx) |
| --- | --- |
| `Eingang` | `convertFromUtc(item()?['receivedDateTime'], 'W. Europe Standard Time', 'dd.MM.yyyy HH:mm')` |
| `Von` | `item()?['from']?['emailAddress']?['address']` |
| `Betreff` | `item()?['subject']` |

5. **Speichern**.

**F. Eine Mail an dich (im Wahr-Zweig)**

1. **Plus** unter **Tabelle**, **E-Mail senden (V2)** unter Office 365 Outlook.
2. Umbenennen in `Mail_Tagescheck`.
3. **An:** deine Adresse.
4. **Betreff:** fx, Formel einfügen, Hinzufügen. Das `[Avis-Bot]` am Anfang nicht weglassen, es hält diese Mail aus dem Avis-Flow und aus dem nächsten Tagescheck heraus:
    `concat('[Avis-Bot] Tagescheck: ', string(length(body('Avis_offen'))), ' Avis-Mails nicht bearbeitet')`
5. **Text:** Codeansicht **</>**, einfügen:

```
<p>Diese Mails im Posteingang sehen nach einem Zahlungsavis aus (Betreff oder Anlage enthält „avis"), haben aber weder die rote noch die gelbe Kategorie. Der Avis-Flow hat sie also nicht fertig bearbeitet.</p>
@{body('Tabelle')}
<p>Bitte jede Mail in Outlook öffnen und den Betrag von Hand erfassen. Was passiert ist, steht im Ausführungsverlauf des Avis-Flows (Anleitung, Schritt 11 G).</p>
```

6. **Keine Anlagen** hinzufügen.
7. **Speichern**.

**G. Testen und was die Tagescheck-Mail bedeutet**

1. Oben **Testen**, **Manuell**, **Testen**. Der Flow läuft sofort einmal. Sind alle Avise der letzten 24 Stunden bearbeitet, endet er im Falsch-Zweig von Etwas_offen, und es kommt keine Mail. Das ist richtig.
2. Zum Ausprobieren: Dir eine Mail mit Betreff `Test Avis Tagescheck` schicken und über die **Büroklammer** eine beliebige Datei anhängen, die keine PDF ist (z. B. ein Word-Dokument; ein in den Text eingefügtes Bild zählt nicht als Anlage). Der Avis-Flow überspringt sie (kein PDF). Nach mehr als 30 Minuten den Tagescheck noch einmal manuell testen. Jetzt kommt „[Avis-Bot] Tagescheck: 1 Avis-Mails nicht bearbeitet" mit dieser Mail in der Tabelle. Danach die Testmail löschen.
3. Der Flow steht nach dem Speichern auf **Ein** und läuft ab morgen jeden Tag um 07:00.

Steht eine Mail in der Liste, im Avis-Flow unter **Ausführungsverlauf** den Lauf zu dieser Uhrzeit suchen:

| Im Verlauf | Bedeutung | Was tun |
| --- | --- | --- |
| Kein Lauf zu dieser Zeit | Der Avis-Flow war aus | Flow einschalten, Betrag von Hand |
| Lauf endet an Bedingung 2 (Falsch) | „avis" stand nur im Betreff, die Anlage hieß anders (z. B. „Zahlung_4711.pdf") oder war keine PDF (z. B. eine Excel-Datei) | Betrag von Hand. Kommt das öfter mit demselben Absender, Schritt 3 erweitern lassen |
| Rotes X bei Kategorie_rot oder Kategorie_gelb | Die Kategorie konnte nicht gesetzt werden (z. B. 403 oder eine kurze Störung; eine verschobene Mail steht nicht in dieser Liste) | Die [Avis-Bot]-Mail ist da, nur die Farbe fehlt. Kategorie von Hand setzen |
| Rotes X bei einer anderen Aktion | Der Lauf ist abgebrochen | Fehlertabelle in Schritt 10 |

Wichtig: Ändere die rote oder gelbe Kategorie nach dem Bearbeiten nicht, nimm höchstens eine weitere Kategorie dazu. Sonst steht die Mail am nächsten Morgen in der Liste.

Fehler im Tagescheck selbst:

| Was du siehst | Ursache | Lösung |
| --- | --- | --- |
| Mails_holen: 400 Bad Request | Ein Teil der Abfrage wird nicht angenommen | URI-Formel noch einmal kopieren. Hilft das nicht, in der Formel `&$expand=attachments($select=name)` löschen. Dann prüft der Tagescheck nur noch den Betreff |
| Mails_holen: 404 oder 403 | Postfach-Adresse falsch oder keine Berechtigung | Wie Kategorie_rot in Schritt 10 |
| Es kommt jeden Morgen eine Tagescheck-Mail mit [Avis-Bot]-Mails darin | `[Avis-Bot]`-Teil der Filterformel fehlt | Formel in Avis_offen neu einfügen |
| Mehr als 250 Mails mit Anlage pro Tag | Die Abfrage liefert höchstens 250 | In der URI-Formel `$top=250` auf `$top=1000` erhöhen |

## Anhang A: Alle Formeln zum Kopieren

Jede Formel wird über das **fx**-Symbol eingefügt, dann **Hinzufügen**. Voraussetzung sind die Aktionsnamen `Apply_to_each`, `Get_attachment`, `Run_script`.

**Avis-Flow**

| Wo | Formel |
| --- | --- |
| Bedingung 2 (innere), Zeile 1, links (Operator ist gleich, rechts fx `true`) | `or(and(contains(toLower(items('Apply_to_each')?['name']), 'avis'), endsWith(toLower(items('Apply_to_each')?['name']), '.pdf')), and(or(endsWith(toLower(items('Apply_to_each')?['name']), '.p7m'), endsWith(toLower(items('Apply_to_each')?['name']), '.rpmsg')), contains(toLower(concat(items('Apply_to_each')?['name'], ' ', coalesce(triggerOutputs()?['body/subject'], ''))), 'avis')))` |
| Alternative für Bedingung 2, Zeile 1, mit Betreff (Schritt 3, „Früher mit Betreff-Variante") | `and(or(endsWith(toLower(items('Apply_to_each')?['name']), '.pdf'), endsWith(toLower(items('Apply_to_each')?['name']), '.p7m'), endsWith(toLower(items('Apply_to_each')?['name']), '.rpmsg')), contains(toLower(concat(items('Apply_to_each')?['name'], ' ', coalesce(triggerOutputs()?['body/subject'], ''))), 'avis'))` |
| Bedingung 2 (innere), Zeile 2, links | `items('Apply_to_each')?['isInline']` |
| Bedingung 2 (innere), Zeile 2, rechts | `false` |
| Run_script, pdfBase64 | `base64(body('Get_attachment')?['contentBytes'])` |
| Run_script, Einstellungen, Wiederholungsrichtlinie | Festes Intervall, Anzahl `3`, Intervall `PT1M` |
| Skriptergebnis, Eingaben | `outputs('Run_script')?['body/result']` |
| Skriptergebnis und Betrag_erkannt, Einstellungen, Ausführen nach | alle vier Häkchen: ist erfolgreich, Timeout, wurde übersprungen, ist fehlgeschlagen |
| Betrag_erkannt, links | `and(equals(outputs('Run_script')?['body/result/ok'], true), not(equals(outputs('Run_script')?['body/result/confidence'], 'low')))` |
| Betrag_erkannt, links, strenger Modus (nur high wird rot) | `and(equals(outputs('Run_script')?['body/result/ok'], true), equals(outputs('Run_script')?['body/result/confidence'], 'high'))` |
| Betrag_erkannt, rechts | `true` |
| Äußere Bedingung, Zeile 3 (Schleifenschutz) | links Blitz **Betreff**, Operator **enthält nicht**, rechts `[Avis-Bot]` |
| Mail_mit_Betrag, Betreff | `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - ', outputs('Run_script')?['body/result/amount'], ' ', outputs('Run_script')?['body/result/currency'], if(equals(outputs('Run_script')?['body/result/confidence'], 'medium'), ' (prüfen)', ''))` |
| Mail_mit_Betrag, Gelesen aus | `outputs('Run_script')?['body/result/line']` |
| Mail_mit_Betrag, Hinweise | `outputs('Run_script')?['body/result/warnings']` |
| Mail_mit_Betrag, Anlagen Name | `items('Apply_to_each')?['name']` |
| Mail_mit_Betrag, Anlagen Inhalt | `body('Get_attachment')?['contentBytes']` |
| Mail_nicht_erkannt, Betreff | `concat('[Avis-Bot] ', triggerOutputs()?['body/subject'], ' - Betrag nicht erkannt')` |
| Mail_nicht_erkannt, Grund | `coalesce(outputs('Run_script')?['body/result/error'], concat('Skript nicht gelaufen (', actions('Run_script')?['status'], '): ', coalesce(outputs('Run_script')?['body/message'], actions('Run_script')?['error']?['message'], '')))` |
| Mail_nicht_erkannt, Kandidaten | `join(coalesce(outputs('Run_script')?['body/result/candidates'], createArray()), '<br>')` |
| Mail_nicht_erkannt, Anlagen Name | `if(empty(body('Get_attachment')?['contentBytes']), 'Anlage_fehlt.txt', items('Apply_to_each')?['name'])` |
| Mail_nicht_erkannt, Anlagen Inhalt | `coalesce(body('Get_attachment')?['contentBytes'], base64('Die Anlage konnte nicht abgerufen werden. Bitte die Original-Mail in Outlook ansehen.'))` |
| Beide Mails, Absender | `triggerOutputs()?['body/from']` |
| Beide Mails, Empfangsdatum | `convertFromUtc(triggerOutputs()?['body/receivedDateTime'], 'W. Europe Standard Time', 'dd.MM.yyyy HH:mm')` |
| Beide Mails, Originaltext | `triggerOutputs()?['body/body']` |
| Kategorie_rot / Kategorie_gelb, URI | `https://graph.microsoft.com/v1.0/me/messages/` + Nachrichten-ID (Blitz) |
| Kategorie_rot, Text | `{ "categories": ["Rote Kategorie"] }` |
| Kategorie_gelb, Text | `{ "categories": ["Gelbe Kategorie"] }` |

**Tagescheck (Schritt 11)**

| Wo | Formel |
| --- | --- |
| Mails_holen, URI | `concat('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ', formatDateTime(addMinutes(utcNow(), -1560), 'yyyy-MM-ddTHH:mm:ssZ'), ' and receivedDateTime lt ', formatDateTime(addMinutes(utcNow(), -30), 'yyyy-MM-ddTHH:mm:ssZ'), ' and hasAttachments eq true&$select=subject,from,receivedDateTime,categories&$expand=attachments($select=name)&$top=250')` |
| Avis_offen, Von | `body('Mails_holen')?['value']` |
| Avis_offen, links (ist gleich, rechts fx `true`) | `and(or(contains(toLower(coalesce(item()?['subject'], '')), 'avis'), contains(toLower(string(coalesce(item()?['attachments'], createArray()))), 'avis')), not(contains(coalesce(item()?['subject'], ''), '[Avis-Bot]')), not(contains(coalesce(item()?['categories'], createArray()), 'Rote Kategorie')), not(contains(coalesce(item()?['categories'], createArray()), 'Gelbe Kategorie')))` |
| Etwas_offen, links (ist größer als, rechts fx `0`) | `length(body('Avis_offen'))` |
| Tabelle, Von | `body('Avis_offen')` |
| Tabelle, Spalte Eingang | `convertFromUtc(item()?['receivedDateTime'], 'W. Europe Standard Time', 'dd.MM.yyyy HH:mm')` |
| Tabelle, Spalte Von | `item()?['from']?['emailAddress']?['address']` |
| Tabelle, Spalte Betreff | `item()?['subject']` |
| Mail_Tagescheck, Betreff | `concat('[Avis-Bot] Tagescheck: ', string(length(body('Avis_offen'))), ' Avis-Mails nicht bearbeitet')` |

Was das Skript zurückgibt (alles unter `outputs('Run_script')?['body/result/…']`): `ok` (true/false), `amount` (z. B. 3.454,00), `amountNumber` (3454), `currency` (EUR), `line` (die Textzeile, aus der der Betrag stammt), `method` (wie er gefunden wurde: keyword, keyword-next-line, keyword-weak, column-sum, column-header, deduction, sum-check, largest; none = kein Betrag), `confidence` (high, medium, low), `candidates` (Liste), `pages`, `text`, `textLength`, `warnings` (Hinweise), `error` (Grund, englisch, siehe Anhang B).

## Anhang B: Gründe und Hinweise auf Deutsch

Das Skript schreibt den Grund auf Englisch, damit er überall gleich lesbar ist. In der Tabelle steht der Anfang des englischen Textes, so wie er im Feld **Grund** der gelben Mail erscheint. Wo `…` steht, folgen Zahlen oder Details aus der PDF.

**Kein Betrag gefunden (ok = false)**

| Grund (englisch) | Bedeutung | Was tun |
| --- | --- | --- |
| `no PDF content passed` | Das Skript hat keine Datei bekommen | In Run_script das Feld pdfBase64 prüfen: fx `base64(body('Get_attachment')?['contentBytes'])` (Schritt 4, Punkt 4) |
| `not a PDF (header missing, …)` | Die Anlage ist keine PDF oder beschädigt, auch wenn sie so heißt. In der Klammer stehen die Größe und die ersten Zeichen dessen, was beim Skript ankam: `starts 'JVBER…'` ist eine Base64-PDF, `starts '%PDF…'` eine PDF als Text | Anlage von Hand öffnen; Betrag von Hand. Kommt das bei jeder PDF: Feld pdfBase64 in Run_script prüfen (Schritt 4, Punkt 4) |
| `PDF arrived as text instead of Base64 - content damaged (…)` | Power Automate hat die PDF als Text statt als Base64 übergeben, dabei sind Teile verloren gegangen. In der Klammer steht, woran das Lesen gescheitert ist | Betrag von Hand. In Run_script das Feld pdfBase64 auf fx `base64(body('Get_attachment')?['contentBytes'])` umstellen (Schritt 4, Punkt 4) |
| `PDF is password protected - cannot be read` | Die PDF hat ein Kennwort zum Öffnen | Betrag von Hand (Kennwort beim Absender erfragen). PDFs, die nur gegen Kopieren oder Drucken geschützt sind, liest das Skript dagegen normal |
| `PDF is encrypted with a certificate - cannot be read` | Die PDF ist mit einem Zertifikat verschlüsselt | Betrag von Hand |
| `PDF is encrypted with an unsupported method (…) - cannot be read` | Die PDF ist mit einem Verfahren verschlüsselt, das das Skript nicht kennt | Betrag von Hand |
| `no pages found` | In der Datei wurden keine Seiten gefunden (Datei kaputt oder abgeschnitten) | PDF von Hand öffnen; ggf. beim Absender neu anfordern |
| `no text layer found (scanned PDF?)` | Reiner Scan: Die PDF ist nur ein Bild, ohne Text | Betrag von Hand |
| `PDF read incompletely (time budget exhausted)` | Die PDF war so groß oder aufwendig, dass das Zeitlimit von 90 Sekunden erreicht wurde, bevor Text gelesen war | Betrag von Hand |
| `no amount pattern found` | Text gelesen, aber kein Betrag erkannt (z. B. Beträge ohne Nachkommastellen wie „3.454 EUR") | Betrag von Hand |
| `exception: …` | Interner Fehler im Skript | Betrag von Hand; PDF aufheben und an die Person geben, die das Skript pflegt |

**Signierte, verschlüsselte und geschützte Mails und PDFs**

| Grund (englisch) | Bedeutung | Was tun |
| --- | --- | --- |
| `S/MIME encrypted mail - cannot be read` | Die Mail ist mit S/MIME verschlüsselt. Nur dein Outlook mit deinem Zertifikat kann sie öffnen | Original-Mail in Outlook öffnen, Betrag von Hand |
| `protected mail (Microsoft Purview) - cannot be read` | Die Mail ist mit Microsoft Purview geschützt (Anlage `message.rpmsg`, z. B. „Verschlüsseln" oder „Nicht weiterleiten" in Outlook) | Original-Mail in Outlook öffnen, Betrag von Hand |
| `signed mail contains no PDF` | Die signierte Mail enthält keine PDF (das Avis steht vielleicht im Mailtext oder ist eine andere Datei) | Original-Mail öffnen, Betrag von Hand |
| `protected PDF - cannot be read` | Geschützte PDF (z. B. mit Microsoft Purview / Vertraulichkeitsbezeichnung), nur mit Berechtigung zu öffnen | In Outlook oder Acrobat öffnen, Betrag von Hand |

**Unsicher (ok = true, Grund beginnt mit `uncertain:`)**

Nach `uncertain:` folgen ein oder mehrere dieser Gründe, getrennt durch `;`. Den Vorschlag des Skripts siehst du in der ersten Zeile von „Gefundene Beträge".

| Grund (englisch) | Bedeutung |
| --- | --- |
| `OCR text layer` | Der Text stammt aus einer Texterkennung (OCR) über einem Scan. Ziffern können falsch erkannt sein |
| `PDF arrived as text instead of Base64 - parts may be damaged` | Power Automate hat die PDF als Text statt als Base64 übergeben. Ein Teil ließ sich lesen, andere Teile sind verloren. Den Vorschlag mit der PDF vergleichen und das Feld pdfBase64 in Run_script auf fx `base64(body('Get_attachment')?['contentBytes'])` umstellen (Schritt 4, Punkt 4) |
| `PDF read incompletely (…)` | Die PDF konnte nur teilweise gelesen werden (beschädigt, abgeschnitten, Zeichen ohne Zuordnung). Der richtige Betrag kann fehlen |
| `PDF read incompletely (time budget exhausted)` | Die PDF war so groß oder aufwendig, dass das Zeitlimit von 90 Sekunden erreicht wurde |
| `PDF changed after signing` | Die PDF selbst ist digital signiert und wurde nach der letzten Signatur noch verändert. Der gelesene Betrag ist vielleicht nicht der signierte. Im Zweifel beim Absender nachfragen |
| `several PDFs in the mail with different amounts (…)` | Die signierte Mail enthält mehrere PDFs mit verschiedenen Beträgen (in der Klammer: Dateiname und Betrag der anderen PDF) |
| `'…' - not a payment advice?` | Im Dokument steht ein Wort wie „Mahnung", „Lieferschein", „Lastschrift", „Angebot", „Auftragsbestätigung" oder „Abschlagsrechnung" (oder ein fremdsprachiger Titel wie „Estratto conto", „Bulletin de paie"), aber keine Überschrift wie „Zahlungsavis". Auch eine Zahlungsbitte („Wir bitten Sie, den Restbetrag … zu überweisen") oder ein Bankeinzug („… wird von Ihrem Konto abgebucht") steht hier. Wahrscheinlich kein Zahlungsavis. Wörter in Bezugsfeldern („Ihr Zeichen: Mahnung vom …"), in der Empfängeradresse („Personalabteilung / Entgeltabrechnung") und in einer reinen Abteilungszeile („z. Hd. Lohn- und Gehaltsabrechnung") zählen nicht als Titel. „Ihre Mahnung" oder „bezugnehmend auf Ihre Zahlungserinnerung" im Text zählt nur dann nicht, wenn das Schreiben eine erfolgte Zahlung nennt („haben wir heute überwiesen"); ein Schreiben, das die Zahlung verweigert oder erst ankündigt, geht in die Prüfung |
| `asks for a payment advice - not an advice itself` | Das Schreiben bittet um ein Zahlungsavis (z. B. eine Mahnung mit „senden Sie uns ein Zahlungsavis" oder ein Schreiben mit dem Titel „Bitte um Zahlungsavis", „Anforderung Zahlungsavis", „Zahlungsavis fehlt", „Zahlungsavis angefordert", „Request for remittance advice", „… but no remittance advice"). Es ist selbst kein Avis. Antwortet der Zahler auf so eine Bitte („Ihrer Bitte um Zusendung des Zahlungsavis kommen wir nach", Betreff „AW:", „Antwort:" oder „WG: Zahlungsavis fehlt"), bleibt es ein Avis |
| `payee's letter about a received payment - not a payment advice?` | Der Absender hat das Geld selbst bekommen (z. B. „auf unserem Konto ist ein Betrag von … eingegangen", „können wir keiner Rechnung zuordnen", „we are unable to match it"). Das ist ein Schreiben des Zahlungsempfängers, kein Avis. Nennt der Zahler etwas, das bei ihm eingegangen ist (die Rechnung, eine Rückzahlung), oder schreibt er „If you cannot allocate this payment, please contact us", bleibt es ein Avis |
| `credit note title - not a payment advice?` | Das Dokument ist als Gutschrift überschrieben (z. B. Gutschrift eines Lieferanten), nicht als Zahlungsavis |
| `amount due with VAT - invoice?` | Ein fälliger Betrag zusammen mit einer Mehrwertsteuerzeile. Sieht nach einer Rechnung aus |
| `payroll words - not a payment advice?` | Wörter einer Lohn- oder Gehaltsabrechnung. Wahrscheinlich kein Zahlungsavis |
| `travel expense words - not a payment advice?` | Wörter einer Reisekostenabrechnung. Wahrscheinlich kein Zahlungsavis |
| `shipping words - not a payment advice?` | Wörter einer Versand- oder Lieferbestätigung. Wahrscheinlich kein Zahlungsavis |
| `no payment wording - not a payment advice?` | Im Dokument kommt kein Wort wie Zahlung, überwiesen oder Gutschrift vor. Bei fremdsprachigen Dokumenten fehlt ein Satz wie „nous avons payé" / „wij hebben betaald", oder es steht ein offener Betrag oder eine Lastschrift darin. Wahrscheinlich kein Zahlungsavis |
| `amount from the quoted e-mail` | Der Betrag steht nur im zitierten Teil einer beantworteten oder weitergeleiteten Mail, nicht im eigenen Text |
| `credit note not netted in the total` | Eine Gutschrift steht in einem eigenen Block und ist in der Summe nicht verrechnet |
| `total … below includes the payment` | Weiter unten steht eine Summe, die den gewählten Betrag und weitere Beträge enthält |
| `payment amount without decimals` | In einem Satz zur Zahlung steht ein Betrag ohne Nachkommastellen (z. B. „3.454 EUR"), den das Skript nicht liest |
| `deduction near the total` | Neben der Summe steht ein Abzug (Skonto, Gebühr, Gutschrift). Unklar, ob vor oder nach Abzug gezahlt wurde |
| `deduction below the total` | Unter der Summe steht noch ein Abzug oder eine Gutschrift, die nicht verrechnet ist |
| `amount looks like a deduction` | Der gewählte Betrag sieht selbst wie ein Abzug aus |
| `close runner-up …` | Ein zweiter Betrag ist fast genauso wahrscheinlich (steht dahinter) |
| `second payment amount …` | Es gibt zwei Zahlbeträge (der zweite steht dahinter) |
| `transfer amount … differs from …` | Ein ausdrücklich genannter Überweisungsbetrag (z. B. „Überweisungsbetrag", „Auszahlungsbetrag", „Gutschriftsbetrag", oft im Kopf oder auf der letzten Seite) weicht vom gewählten Betrag ab, meist von der Tabellensumme. Die Differenz ergibt sich nicht aus den Abzugszeilen im Dokument (Gebühr, USt auf die Gebühr, Delkredere, Bonus, Skonto). Welcher Betrag überwiesen wurde, ist unklar. Steht der genannte Betrag als Zwischenschritt über weiteren Abzügen („Zahlbetrag lt. Ihrer Rechnung", darunter „abzüglich Skonto" und „Überweisung"), erklären die Abzüge dazwischen die Differenz, und dieser Grund kommt nicht |
| `payment sentences with different amounts` | Im Text stehen mehrere Sätze wie „wir haben … überwiesen" mit verschiedenen Beträgen. Keiner ist als frühere Zahlung („bereits", „schon", „zuvor") oder als heutige Zahlung („heute", „Restbetrag") erkennbar, und keiner ist die Summe der anderen. Eine erst angekündigte Zahlung („überweisen wir nach Klärung", „nächste Woche") zählt dabei nicht mit |
| `payment line says …, total says …` / `payment line says …` | Die Zahlbetragszeile und die Summe (oder der gewählte Betrag) widersprechen sich |
| `several unlabelled sums` | Mehrere Summen ohne Beschriftung, z. B. „bezahlt" und „offen" |
| `no label, amount chosen by size` | Kein Wort wie „Zahlbetrag" gefunden, nur der größte Betrag |
| `amount only backed by a sum check` | Nur über eine Rechenprobe gefunden (Netto + Steuer = Brutto) |
| `only a weak label (Betrag/Zahlung)` | Nur ein schwaches Wort wie „Betrag" vor dem Betrag |
| `amount from an attached invoice copy` | Der Betrag stammt aus einer angehängten Rechnungskopie, nicht aus dem Avis |
| `total follows a VAT line - invoice?` | Die Summe steht direkt nach einer Mehrwertsteuerzeile. Das sieht eher nach einer Rechnung aus |
| `Skonto/Rest column on the right of the table` | Die Tabelle hat ganz rechts eine Skonto- oder Restbetragsspalte |
| `payment label without readable amount` | „Zahlbetrag" o. ä. steht da, aber der Betrag daneben ist nicht lesbar |
| `gross column chosen, payment column empty` | Betrag aus der Bruttospalte, die Zahlbetragsspalte ist leer oder unlesbar |
| `amount is zero` | Der gefundene Betrag ist 0,00 |
| `several currencies (…)` | Im Dokument kommen mehrere Währungen vor |
| `weak signals` | Allgemein zu wenige Hinweise für einen sicheren Betrag |

**Aus dem Flow selbst (nicht vom Skript)**

| Grund | Bedeutung |
| --- | --- |
| `Skript nicht gelaufen (Failed): …` | Run_script ist auch nach den Wiederholungen fehlgeschlagen; dahinter die Meldung von Microsoft |
| `Skript nicht gelaufen (TimedOut): …` | Run_script hat länger als 120 Sekunden gebraucht |
| `Skript nicht gelaufen (Skipped): …` | Run_script wurde übersprungen, weil schon die Anlage nicht abgerufen werden konnte |
| leer, bei Sicherheit `medium` | Nur im strengen Modus (Schritt 10, Pilotphase, Punkt 4): Betrag gefunden, aber nur mittelmäßig sicher. Vorschlag in der ersten Zeile von „Gefundene Beträge" |

**Hinweise in der roten Mail (Feld „Hinweise")**

| Hinweis (englisch) | Bedeutung |
| --- | --- |
| leer | Alles normal |
| `from signed mail: …` | Der Betrag stammt aus dieser PDF in der signierten Mail (`from mail: …` bei einer weitergeleiteten Mail-Datei) |
| `… PDFs checked (…)` / `only … of … PDFs checked` | Die Mail enthielt mehrere PDFs, das Skript hat die genannten geprüft und die beste genommen. Hat eine PDF „Zahlungsavis" oder „Avis" als eigenes Wort im Namen (nicht „Lieferavis"), prüft es nur diese |
| `only the first 50 of … PDFs read` | Die Mail enthielt mehr als 50 PDFs. Das Skript hat nur die ersten 50 angesehen |
| `PDF arrived as text instead of Base64` | Power Automate hat die PDF als Text übergeben, sie ließ sich aber vollständig zurückwandeln. Der Betrag stimmt; trotzdem das Feld pdfBase64 in Run_script auf fx `base64(body('Get_attachment')?['contentBytes'])` umstellen (Schritt 4, Punkt 4), sonst gehen bei anderen PDFs Teile verloren |
| `decrypted (permissions-only encryption)` | Die PDF war nur gegen Kopieren oder Drucken geschützt und wurde normal gelesen |
| `OCR text layer (… % of the text)` | Text aus Texterkennung. In einer roten Mail kommt das nicht vor, solche Avise gehen immer in die Prüfung |
| `incomplete: …` | PDF teilweise gelesen. Kommt in roten Mails ebenfalls nicht vor |
| andere Texte (z. B. `page 2: …`) | Technische Details zum Lesen der PDF, für die Person, die das Skript pflegt |
