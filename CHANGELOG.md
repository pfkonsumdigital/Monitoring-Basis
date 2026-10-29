# Änderungen

## 0.8.0

### Neu

- **Einstellungsfeld „Liste“:** Module können eine Tabelle anbieten, in der Admins Zeilen hinzufügen und entfernen (z. B. Ordner mit eigener Altersgrenze, Datumsgrenze und Zeitstempel). Spalten wie normale Felder; Prüfung je Zeile mit verständlicher Meldung („Zeile 2, Max. Alter (h): höchstens 720“); `max_zeilen`, `pflicht` = mindestens eine Zeile.
- Neuer Feldtyp **„datum“** (Datumsauswahl, gespeichert als `JJJJ-MM-TT`), auch als Listenspalte.
- **Updates für Module** wie bei der Basis: Bereich „Updates“ in den Details (Admins), Suche nach dem neuesten Release im Modul-Repo (`repo` in `module.json`), Änderungsnotizen, Installation auf Knopfdruck, „Zurück zur vorherigen Version“, tägliche Suche mit Hinweis an der Kachel. Bei der Installation wird das Modul beendet (Dienst, `befehl.json` oder Pause), gesichert, ausgetauscht und wieder gestartet; Einstellungen und Status bleiben.
- Andockvertrag (abwärtskompatibel erweitert): Release-Dateien `<id>-X.Y.Z.tar.gz` + `.sha256`, Feldtypen `liste` und `datum`.

### Geändert

- Beispielmodul `ordnerpruefung` 1.1.1: prüft `befehl.json` auch vor jedem Lauf und direkt vor dem Schreiben von `status.json`. README: Liegt `befehl.json` vor, keine `status.json` mehr schreiben.

### Behoben

- Ein eigenständiges Modul, das kurz nach dem Befehl zum Beenden noch eine `status.json` schrieb, galt in der Basis wieder als laufend (Beispielmodul angepasst, Regel im Andockvertrag ergänzt).

### Prüfung

- `npm test`: 92 Tests, neu u. a. Listenfeld (Spalten, Datum, leere Zeilen, Grenzen, Pflicht, Speichern, keine Änderung bei gleichen Werten), Modul-Updates mit simuliertem GitHub und echten Paketen (Suche, Installation mit Dienst, Einstellungen bleiben, Zurück, falsche Prüfsumme/Version/id, Verknüpfung im Paket, kein Repo/Token, Dienst nicht beendbar, Modul mit `befehl.json`, von der Basis gestartetes Modul), Admin-Endpunkte mit Schutzkopf.
- Gegenprobe: Tests schlagen fehl, wenn Einstellungen nicht erhalten bleiben oder Verknüpfungen durchgelassen werden.
- Browsertest mit echter Basis und laufendem Beispielmodul, simuliertes GitHub: Liste bearbeiten (Fehler je Zeile, Speichern), Update suchen und installieren (Modul beendet sich, „Beendet“ bis zum Neustart, danach OK mit v1.2.0), Zurück auf v1.1.1.
- Noch auf dem Worker zu prüfen: Update eines Moduls mit Windows-Dienst (`sc.exe`), sobald das FTP-Modul da ist.

## 0.7.1

### Behoben

- „Token prüfen“ und „Token speichern“ meldeten einen Token ohne das Recht „Contents: Read-only“ als in Ordnung; erst „Nach Updates suchen“ scheiterte dann mit einer unklaren Meldung. Die Prüfung liest jetzt zusätzlich die Releases – ein solcher Token wird nicht gespeichert, und die Meldung sagt genau, welches Recht in GitHub fehlt.

### Geändert

- Verweigert GitHub den Zugriff, unterscheidet die Meldung jetzt: Abruflimit (mit Uhrzeit, ab der es wieder geht), zu viele Anfragen (mit Wartezeit) oder fehlendes Recht des Tokens (mit GitHubs Begründung und dem nötigen Recht).
- README: Hinweis, wie ein fehlendes Recht beim bestehenden Token ergänzt wird.

### Prüfung

- `npm test`: 85 Tests, neu bzw. erweitert: Token nur mit „Metadata“ wird abgelehnt und nicht gespeichert, Prüfung fragt Repo und Releases ab, Abruflimit mit Uhrzeit (Zeitzone Berlin), Wartezeit, fehlendes Recht mit GitHub-Begründung, Meldung kommt beim Suchen im Status an.

## 0.7.0

### Neu

- **Basis beenden über die Oberfläche:** Admin-Knopf „Beenden“ mit Rückfrage. Optional („Auch alle eigenständigen Module und ihre Windows-Dienste beenden“) werden vorher alle eigenständigen Module beendet, die das unterstützen. Danach zeigt die Seite, wie die Basis wieder gestartet wird. Die Basis endet regulär (Code 0), Starter und Aufgabenplaner starten sie nicht von selbst neu.
- Mail „[Monitoring] Basis beendet durch <Benutzer>“, wenn die Benachrichtigung eingerichtet ist (mit Liste der Module, die sich nicht beenden ließen).
- **Module einzeln beenden** (Details, nur Admins, mit Rückfrage):
  - eigenständige Module mit `"dienst"` in `module.json`: Die Basis stoppt den eingetragenen Windows-Dienst; Knopf „Dienst starten“ startet ihn wieder.
  - eigenständige Module mit `"befehlsdatei": true`: Die Basis legt `befehl.json` in den Modulordner, das Modul beendet sich selbst.
  - von der Basis gestartete Module: „Prüfung abbrechen“ bricht die laufende Prüfung ab und pausiert das Modul.
- Neuer Zustand **„Beendet“**: keine „Keine Meldung“ und keine Mails, bleibt nach Neustart der Basis erhalten und endet automatisch, sobald sich das Modul wieder meldet.
- **Dienstzustand:** Bei Modulen mit `"dienst"` fragt die Basis alle 15 Sekunden den Windows-Dienst ab (Details: „Windows-Dienst … läuft/gestoppt“). Gestoppt oder nicht installiert, ohne dass jemand ihn über die Basis beendet hat → Zustand „Dienst gestoppt“ (zählt als Fehler) und Mail „[Monitoring] DIENST GESTOPPT: <Modul>“.
- Beispielmodul `ordnerpruefung` 1.1.0 versteht `befehl.json` (Vorlage für eigene Module).

### Geändert

- Andockvertrag (abwärtskompatibel erweitert): optionale Angaben `dienst` und `befehlsdatei` in `module.json` (nur `typ: "eigenstaendig"`), Datei `befehl.json`.
- Abgebrochene Prüfungen (Beenden, Neustart) erscheinen als Warnung „Prüfung wurde über die Basis beendet.“ statt als Fehler mit Exitcode.
- `AGENTS.md`: Architekturgrenze ergänzt – die Basis startet eigenständige Module weiterhin nie von sich aus, nur einen in `module.json` eingetragenen Windows-Dienst auf Knopfdruck eines Admins.

### Prüfung

- `npm test`: 84 Tests, neu u. a. sc.exe-Ausgabe (englisch/deutsch) lesen, Dienst stoppen/starten ohne Shell, verständliche Fehler (keine Berechtigung, nicht installiert), ungültige Dienstnamen und andere Systeme rufen sc.exe nie auf, „Beendet“ ohne Alarm und nach Neustart, Rückkehr bei neuer Meldung, „Dienst gestoppt“, `befehl.json`, alle beenden mit Fehlerliste, Prüfung eines Moduls gezielt abbrechen, Mails „Dienst gestoppt“ und „Basis beendet“, Admin-Endpunkte mit Schutzkopf und Herkunftsprüfung, Beispielmodul beendet sich über `befehl.json` und ignoriert einen alten Befehl beim Start.
- Browsertest mit echter Basis über `start.js`: Prüfung abbrechen, Dienstmodul (Linux: verständliche Meldung), Beispielmodul über `befehl.json` beendet (Prozess endet), Basis mit allen Modulen beendet (Basis und Starter enden mit Code 0), Neustart: „Beendet“ bleibt, verschwindet bei neuer Meldung. Ansicht auf dem Handy geprüft.
- Noch auf dem Worker zu prüfen: echtes Stoppen und Starten eines Windows-Dienstes (`sc.exe`) unter SYSTEM.

## 0.6.0

### Neu

- **Benachrichtigung per Mail** über Microsoft 365 (Graph, App-Registrierung mit Clientschlüssel; läuft ohne Anmeldung, auch unter SYSTEM). Keine zusätzliche Abhängigkeit.
- Mails beim Wechsel auf Fehler, Warnung oder „Keine Meldung“, bei „Wieder OK“ und als Erinnerung, solange ein Problem besteht (Abstand einstellbar, Standard 4 h, 0 = aus).
- **Melden nach … Läufen** einstellbar (Standard 1 = sofort). „Keine Meldung“ und fehlerhafte Module werden immer sofort gemeldet.
- Admin-Dialog „Benachrichtigung“: Zugangsdaten, Absender, eine Empfängerliste für alles, Link zur Oberfläche, Testmail, Liste der letzten 20 Benachrichtigungen mit Ergebnis.
- Gemeldeter Zustand je Modul wird gespeichert – kein Doppelversand nach Neustart. Fehlgeschlagener Versand wird protokolliert und alle 5 Minuten wiederholt.
- README: Einrichtung mit Entra und RBAC for Applications (Senderecht nur für ein Postfach).
- **GitHub-Token in der Oberfläche eintragen:** Dialog „Updates“ → GitHub-Zugang mit „Token speichern“, „Token prüfen“ und „Token entfernen“. Der Token wird vor dem Speichern bei GitHub geprüft, gilt ohne Neustart, wird nie wieder angezeigt und liegt in `data/github.json`. Ablaufdatum wird angezeigt; 14 Tage vorher täglich eine Warnung im Fehlerprotokoll.

### Geändert

- `AGENTS.md`: Versionsschema 0.Y.Z (neue Funktionen → Y, Fehlerbehebungen → Z).
- Ein in der Oberfläche gespeicherter Token hat Vorrang vor `updates.github_token` in `config.json`; der Eintrag in `config.json` funktioniert weiter.
- Die tägliche Update-Prüfung läuft auch, wenn beim Start noch kein Token eingetragen war, und prüft dabei den Token.

### Prüfung

- `npm test`: 72 Tests, neu u. a. GitHub-Token (Ablaufdatum lesen, Speichern bei noch fehlendem Ordner `data`, abgelehnte Tokens nicht speichern, Vorrang vor config.json, Ablaufwarnung, entfernen, Admin-Endpunkte), Graph (Token holen und wiederverwenden, Aufbau der Mail, verständliche Fehler für Anmeldung, Berechtigung, Netzwerk), Einstellungen prüfen und Schlüssel behalten, Wechsel, kein Doppelversand, Erinnerung, Neustart, „Melden nach … Läufen“, Modulfehler sofort, Wiederholung nach Fehlschlag, aus = keine Mails, Schlüssel nie in Ansicht/Protokoll, Admin-Endpunkte.
- Browsertests der Dialoge „Updates“ (Token) und „Benachrichtigung“ mit Pflichtfeldprüfung und Testmail (Versand ohne Verbindung zu Microsoft → verständliche Fehlermeldung).
- Noch auf dem Worker zu prüfen: echter Versand über die App-Registrierung.

## 0.5.0

### Neu

- **Eigenständige Module** (`"typ": "eigenstaendig"`): Das Modul läuft selbst (eigener Prozess, Dienst oder Aufgabe) und schreibt nach jedem Lauf `status.json` in seinen Ordner; die Basis liest sie alle 15 Sekunden. Module laufen weiter, wenn die Basis aus ist.
- **Keine Meldung:** Meldet sich ein eigenständiges Modul nicht bis zum erwarteten nächsten Lauf plus Toleranz (`toleranz_minuten`, Standard 10), zeigt die Basis „Keine Meldung“.
- **Einstellungen aus der Basis:** Module beschreiben ihre Felder in `module.json` (`einstellungsfelder`: Text, Zahl, Schalter, Auswahl, Passwort). Admins bearbeiten sie in einem Formular; die Basis prüft die Eingaben und schreibt `einstellungen.json`. Passwörter werden nie wieder angezeigt und aus Protokollen gefiltert; Änderungen stehen mit Benutzer im Protokoll.
- **Pausieren/Fortsetzen** eines Moduls durch Admins; die Pause übersteht Neustarts (`data/modulzustand.json`).
- **Neue, geänderte und entfernte Module ohne Neustart** der Basis.
- Übersicht: Zähler „Keine Meldung“, Anzahl Module, Farbleiste der letzten 30 Läufe, „Problem seit … (n Läufe)“, Module mit Problemen zuerst.
- Details: Beschreibung, Version, Betriebsart, letzte Meldung mit Dauer, nächster Lauf, überfällig seit, Problem seit, Verfügbarkeit 24 h / 7 Tage.
- `module.json` kennt zusätzlich `version`, `beschreibung`, `repo` (für spätere Modul-Updates) und `toleranz_minuten`.
- Beispiel und Vorlage `beispiele/ordnerpruefung`: eigenständiges Modul mit Einstellungen, Dauerbetrieb oder `--einmal`.

### Geändert

- Von der Basis gestartete Module erhalten bei jedem Lauf die aktuellen Einstellungen (Vorgaben aus `module.json` plus `einstellungen.json`).
- `verlauf_anzahl` Standard 1000 statt 200; Details und Fehlerausgabe nur bei den neuesten 50 Einträgen.
- „Jetzt prüfen“ nur noch bei Modulen, die die Basis startet.

### Prüfung

- `npm test`: 59 Tests, neu u. a. Einstellungsfelder und -werte, Speichern mit Pflichtfeldern und verborgenen Passwörtern, nur echte Änderungen, `status.json` (gültig, ungültig, halb geschrieben, nicht doppelt, nach Neustart), „Keine Meldung“, Problem seit, Verfügbarkeit, Pause, Module kommen und gehen, kaputtes Modul stört andere nicht, Planer zur Laufzeit, Admin-Endpunkte, Beispielmodul ohne Basis.
- Gesamttest mit Browser: Übersicht mit fehlerhaftem, stummem, Plugin- und eigenständigem Modul; Einstellungen mit Pflichtfeld; Meldung des Moduls erscheint; Pause; neues Modul ohne Neustart; Handy-Ansicht.

## 0.4.0

### Neu

- **Interner Betrieb ohne Zertifikat:** `"tls": { "modus": "aus" }` startet die Basis per HTTP, erreichbar über `http://<IP>:<Port>/`. Kein Hostname, kein Zertifikat, kein Cloudflare-Token nötig.
- In diesem Modus werden nur Anfragen aus privaten Netzen (10.x, 172.16–31.x, 192.168.x, 127.x, lokale IPv6) angenommen; andere Adressen erhalten 403 und werden einmal je Adresse im Fehlerprotokoll vermerkt.
- Beim Start ohne Verschlüsselung steht eine Warnung im Fehlerprotokoll.

### Geändert

- `hostname` ist bei `tls.modus` `"aus"` optional.
- Ohne Verschlüsselung erhält das Anmelde-Cookie kein `Secure` und es wird kein HSTS-Kopf gesendet; die Herkunftsprüfung erwartet dann `http://`.
- Start.exe öffnet bei `tls.modus` `"aus"` `http://localhost:<Port>/` und braucht keinen `hostname`. **Start.exe ändert sich – für diese Version das Windows-ZIP neu entpacken** (ein Online-Update ersetzt Start.exe nicht).
- `config.example.json` ist jetzt für den internen Betrieb (HTTP, Port 8080) eingestellt; die HTTPS-Varianten stehen in der README.
- README: Hinweis, unter „Assets“ das Windows-ZIP und nicht „Source code“ zu laden; Firewall-Befehl für den Port.

### Prüfung

- `npm test`: 45 Tests, neu: Konfiguration mit `tls.modus` `"aus"`, HTTP-Login mit Cookie ohne `Secure` und ohne HSTS, Herkunftsprüfung mit `http://`, Erkennung interner Adressen, Abweisung externer Adressen mit einmaliger Meldung.
- `go test` für Start.exe (Adresse und Konfiguration ohne TLS) und Windows-Build.
- Noch auf dem Worker zu prüfen: Aufruf über `http://<IP>:8080/` von einem anderen Rechner im Netz.

## 0.3.0

### Neu

- **Start.exe** für Windows: Doppelklick startet die Basis unsichtbar im Hintergrund und öffnet die Seite im Browser; läuft sie schon, öffnet sich nur der Browser. Fehler erscheinen als Meldungsfenster mit den letzten Protokolleinträgen.
- `Start.exe --autostart` / `--kein-autostart`: automatischer Start beim Hochfahren über den Aufgabenplaner (SYSTEM, ohne Zeitlimit, mit Wiederholung bei Fehlern).
- `Start.exe --neustart` und `--stop`: beenden Starter, Basis und alle laufenden Module (Prozessbaum) und starten bei Bedarf neu.
- **Windows-Paket** `monitoring-basis-<version>-windows-x64.zip` im Release: Start.exe, fest eingestellte Node.js-Laufzeit 22.23.4 (Prüfsumme kontrolliert) und Programm mit allen Abhängigkeiten. Auf dem Worker ist keine Installation nötig.
- **Fehlerprotokoll**: Stufen Info/Warnung/Fehler mit Quelle; `logs\fehler.log` mit Details; Erfassung von Modulfehlern, Serverfehlern, Zertifikats- und Update-Fehlern, Anmeldesperren, Abstürzen der Basis, Rückfällen des Starters und Fehlern von Start.exe. Je Datei höchstens 5 MB, fünf ältere Dateien werden aufbewahrt.
- Ansicht **„Protokoll“** für Admins mit Filter nach Stufe und Quelle, aufklappbaren Details und Download.
- Knopf **„Neu starten“** für Admins: startet Basis und alle Module neu; laufende Prüfungen werden sauber abgebrochen.

### Geändert

- Geheimnisse (Passwort-Hashes, GitHub- und Cloudflare-Token, typische Token-Formate) werden aus Protokollen und gespeicherten Modulergebnissen entfernt.
- `start.js` schreibt `starter.pid` und meldet Rückfälle und Abstürze ins Fehlerprotokoll. Wie in AGENTS.md beschrieben, kommt diese Fassung nur mit dem vollständigen Windows-Paket, nicht per Online-Update.
- Kopfzeile bricht auf schmalen Bildschirmen um.

### Behoben

- Nach einem Update wurde auf `/login?update=1` umgeleitet; der Hinweis „Bitte erneut anmelden“ erschien dadurch nicht. Jetzt `/login?fehler=update`.

### Prüfung

- `npm test`: 42 Tests, neu u. a. Protokoll-Stufen, Rotation, Geheimnisfilter, robuste Schreibfehler, Abbruch laufender Module, Protokoll- und Neustart-API nur für Admins, 500er im Protokoll.
- `go test` für Start.exe (Konfiguration, Optionen, Aufgabenplaner-XML, UTF-16, Protokoll, PID) und Windows-Build (GUI-Programm, x64).
- Paketbau lokal mit Platzhalter-Laufzeit; Ablehnung einer Laufzeit mit falscher Prüfsumme.
- Gesamttest im Browser: Protokollansicht mit Filter, Details und Download, Neustart über den Knopf, Handy-Ansicht; Absturz der Basis wird vom Starter protokolliert und behoben.
- Noch auf dem Worker zu prüfen: Start.exe (Start, Browser, Meldungsfenster), Autostart im Aufgabenplaner, `--stop`/`--neustart` unter SYSTEM.

## 0.2.0

### Neu

- Update-Funktion für Admins: Im Bereich „Updates“ nach neuen Versionen suchen und per Klick auf „Updaten“ installieren. Die Basis lädt das Paket aus dem neuesten GitHub-Release, prüft die SHA-256-Prüfsumme, entpackt es in einen eigenen Versionsordner, führt einen Selbsttest aus und startet dann neu.
- Fester Starter `start.js`: startet die aktive Version, startet nach einem Update neu und schaltet automatisch auf die vorherige Version zurück, wenn eine neue Version nicht innerhalb von 60 Sekunden hochkommt. Nach einem Absturz startet er die Basis nach 10 Sekunden neu.
- Knopf „Zurück auf die vorherige Version“. Es werden höchstens drei Versionen aufbewahrt.
- Tägliche Update-Prüfung mit Hinweis-Punkt am Knopf „Updates“; es wird nie automatisch installiert.
- Admin-Rolle: `--benutzer-anlegen <Name> --admin`. Nur Admins sehen und nutzen die Updates.
- Release-Workflow: Ein Tag `vX.Y.Z` testet den Stand und legt ein Release mit Paket, Prüfsumme und Notizen aus diesem CHANGELOG an.
- Befehl `--selbsttest` und Anzeige der installierten Version im Kopf der Seite.

### Geändert

- Empfohlener Start ist jetzt `node start.js` statt `node basis/main.js`. Nur so sind Updates möglich.
- `config.json` kennt den optionalen Abschnitt `updates` (`github_token`, optional `repo`) und das Feld `admin` je Benutzer.

### Prüfung

- `npm test`: 35 Tests, darunter Update-Ablauf mit echtem Entpacken und Selbsttest, falsche Prüfsumme, fehlgeschlagener Selbsttest, Starter mit Neustart, Absturz, Hängen und fehlender Version, sowie Admin-Rechte der API.
- Gesamttest im Browser: Update von 0.2.0 auf ein Test-Release 0.3.0 und zurück, mit simuliertem GitHub.
- Bekannte Einschränkung: Der GitHub-Token steht vorerst im Klartext in `config.json` (durch Dateirechte schützen). Eine Verschlüsselung mit Windows-DPAPI ist vorgesehen.

## 0.1.0

### Neu

- Monitoring-Basis mit HTTPS-Weboberfläche: Kachel je Modul mit Ampelstatus, Zusammenfassung, Zeitpunkt der letzten und der nächsten Prüfung, „Jetzt prüfen“, Detailansicht mit Messwerten und Verlauf. Die Seite aktualisiert sich alle 10 Sekunden, unterstützt helles und dunkles Design und funktioniert auf dem Handy.
- Andockvertrag für Module über `module.json`: eigenständige Programme in beliebiger Sprache (Exitcode 0/1/2 oder JSON-Zeile) und Node.js-Plugins (`pruefen()`). Jedes Modul läuft isoliert in einem eigenen Prozess mit Zeitlimit.
- Zeitplan je Modul, ohne Doppelläufe. Fehlerhafte `module.json` werden in der Oberfläche angezeigt.
- Verlauf je Modul in `data/ergebnisse` mit einstellbarer Länge.
- Login mit scrypt-Passwort-Hashes, sicheren Sitzungscookies, Sperre nach Fehlversuchen und CSRF-Schutz.
- HTTPS-Zertifikat automatisch über Let's Encrypt mit DNS-Prüfung über Cloudflare, inklusive Erneuerung im laufenden Betrieb. Alternativ eigene Zertifikatsdateien.
- Befehle `--benutzer-anlegen`, `--zertifikat` und `--module-pruefen`.
- Beispielmodule: Speicherplatz (Plugin) und Skript (Programm über `cmd.exe`).

### Prüfung

- `npm test`: 21 Tests (Modulprüfung, Ausführung, Plugins, Zeitplan, Speicher, Login, HTTPS-Server, Zertifikat und Cloudflare simuliert).
- Gesamttest mit echtem Browser: Login, Fehlermeldung, Übersicht, Details, Handy-Ansicht im dunklen Design.
- Noch auf dem Worker zu prüfen: echte Zertifikatsausstellung mit Domain und Cloudflare-Token, Windows-Autostart, Firewall.
