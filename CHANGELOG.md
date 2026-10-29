# Änderungen

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
