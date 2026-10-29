# Änderungen

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
