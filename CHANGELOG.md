# Änderungen

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
