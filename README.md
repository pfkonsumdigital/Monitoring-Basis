# Monitoring-Basis

Erweiterbare Monitoring-Oberfläche für den Windows-Worker. Die Basis enthält
**keine Fachlogik**. Sie kann nur diese Dinge:

1. Module finden – auch neue, ohne Neustart
2. Meldungen eigenständiger Module einsammeln oder einfache Module selbst nach Zeitplan starten
3. Ergebnisse speichern und auswerten (Status, „keine Meldung“, Fehler seit, Verfügbarkeit)
4. Module über ein Formular einstellen und pausieren
5. Alles auf einer Webseite mit Login anzeigen

Alles Fachliche (FTP prüfen, Speicherplatz, Dienste, Dateien …) steckt in
Modulen. Module laufen unabhängig von der Basis, und die Basis läuft unabhängig
von den Modulen.

```
Monitoring-Basis/
  Start.exe      Windows-Start per Doppelklick, Autostart, Neustart, Stopp (nur im Windows-Paket)
  runtime/       mitgelieferte Node.js-Laufzeit (nur im Windows-Paket)
  start.js       fester Starter (Neustart nach Updates, automatischer Rückfall)
  launcher/      Quellcode von Start.exe (Go)
  basis/         Server, Zeitplan, Ausführung, Speicher, Zertifikat, Updates
  oberflaeche/   HTML, CSS, JavaScript der Weboberfläche
  modules/       eigene Module (nicht im Git)
  beispiele/     Beispielmodule zum Kopieren
  data/          Verlauf und Zertifikat (nicht im Git, automatisch angelegt)
  logs/          basis.log, fehler.log (nicht im Git)
  config.json    eigene Einstellungen (nicht im Git)
  versionen/     per Update installierte Versionen (nicht im Git)
  aktiv.json     welche Version läuft (nicht im Git)
```

Einzige Programm-Abhängigkeit ist `acme-client` für Let's Encrypt.

## Einrichten unter Windows

Aus dem neuesten GitHub-Release unter **Assets** das Paket
`monitoring-basis-<version>-windows-x64.zip` laden – nicht „Source code“, das
enthält nur den Quelltext ohne Start.exe. Es bringt Start.exe, alle
Abhängigkeiten und eine fest eingestellte Node.js-Laufzeit (`runtime\node.exe`)
mit. Auf dem Worker muss also nichts installiert werden.

1. ZIP nach `C:\` entpacken (ergibt `C:\monitoring-basis`) oder in einen
   anderen festen Ordner, nicht auf den Desktop oder in OneDrive. Den
   gesamten Ordner behalten.
2. In PowerShell (als Administrator) im Ordner:

   ```powershell
   copy config.example.json config.json
   .\runtime\node.exe basis\main.js --benutzer-anlegen patrick --admin
   netsh advfirewall firewall add rule name="Monitoring-Basis" dir=in action=allow protocol=TCP localport=8080 profile=domain,private
   ```

   Die mitgelieferte `config.example.json` ist für den **internen Betrieb ohne
   Zertifikat** eingestellt (HTTP, Port 8080, siehe „Interner Betrieb ohne
   Zertifikat“). Für HTTPS siehe „HTTPS-Zertifikat“.
3. **Start.exe doppelklicken.** Die Basis startet unsichtbar im Hintergrund und
   die Seite öffnet sich im Browser. Von anderen Rechnern im Firmennetz:
   `http://<IP-Adresse des Workers>:8080/`.

### Start.exe

| Aufruf | Wirkung |
| --- | --- |
| Doppelklick | Startet die Basis im Hintergrund (ohne Konsolenfenster) und öffnet die Seite im Browser. Läuft sie schon, wird nur der Browser geöffnet. Fehler erscheinen als Meldungsfenster mit den letzten Einträgen aus dem Fehlerprotokoll. |
| `Start.exe --autostart` | Richtet den automatischen Start beim Hochfahren ein: Aufgabe „Monitoring-Basis“ im Aufgabenplaner, Konto SYSTEM, auch ohne angemeldeten Benutzer, ohne Zeitlimit. Fragt nach Administratorrechten. |
| `Start.exe --kein-autostart` | Entfernt den automatischen Start wieder. |
| `Start.exe --neustart` | Beendet Starter, Basis und alle laufenden Module und startet neu. |
| `Start.exe --stop` | Beendet Starter, Basis und alle laufenden Module. |
| `Start.exe --dienst` | Läuft im Vordergrund. Wird vom Aufgabenplaner genutzt. |

Für die Optionen eine Verknüpfung anlegen und die Option im Feld „Ziel“
anhängen, zum Beispiel `"C:\monitoring-basis\Start.exe" --neustart`. Ausgaben
der Basis stehen in `logs\starter-ausgabe.log`. Läuft die Basis als Autostart
unter SYSTEM, fragen `--stop` und `--neustart` nach Administratorrechten.

Start.exe ist nicht digital signiert. Je nach Unternehmensrichtlinie muss sie
freigegeben werden.

### Ohne Windows-Paket (Entwicklung, andere Systeme)

Voraussetzung ist Node.js 22 oder neuer:

```sh
npm ci
cp config.example.json config.json
node basis/main.js --benutzer-anlegen patrick --admin
node start.js
```

Danach im Browser `http://localhost:8080/` öffnen (bei HTTPS
`https://<hostname>:<port>/`) und anmelden.

### config.json

| Feld | Bedeutung | Standard |
| --- | --- | --- |
| `hostname` | Name, unter dem die Seite erreichbar ist, z. B. `monitoring.konsum-weimar.de`. Muss zum Zertifikat passen. Bei `tls.modus` `"aus"` nicht nötig. | – |
| `port` | Port der Seite | `8443` |
| `host` | Netzwerkadresse, auf der gelauscht wird. `0.0.0.0` bedeutet alle Netzwerkkarten. | `0.0.0.0` |
| `module_ordner`, `daten_ordner` | Ordner, relativ zur config.json | `modules`, `data` |
| `verlauf_anzahl` | gespeicherte Ergebnisse je Modul | `1000` |
| `sitzung_stunden` | Dauer, bis eine erneute Anmeldung nötig ist | `12` |
| `tls` | `{"modus": "aus"}` für internen Betrieb ohne Zertifikat, sonst Zertifikat, siehe unten | – |
| `benutzer` | wird von `--benutzer-anlegen` gepflegt; `"admin": true` über `--admin` | – |
| `updates` | optional, siehe „Updates“ | aus |

`config.json` enthält Passwort-Hashes und gegebenenfalls Tokens. Die Datei
deshalb per Windows-Dateirechten auf das Dienstkonto beschränken und niemals
committen.

## Interner Betrieb ohne Zertifikat

```json
{ "port": 8080, "tls": { "modus": "aus" }, "benutzer": {} }
```

- Die Basis läuft per **HTTP** und ist über `http://<IP-Adresse>:<port>/`
  erreichbar. Kein Hostname, kein Zertifikat, kein Cloudflare-Token nötig.
- **Nur internes Netz:** Anfragen von Adressen außerhalb privater Netze
  (10.x, 172.16–31.x, 192.168.x, 127.x und lokale IPv6-Adressen) werden mit
  „Zugriff nur aus dem internen Netz“ abgewiesen und einmal je Adresse im
  Fehlerprotokoll vermerkt.
- Passwort und Sitzung gehen **unverschlüsselt** durch das Firmennetz. Das ist
  als Übergang gedacht; beim Start steht deshalb eine Warnung im Protokoll.
  Später auf HTTPS umstellen (nächster Abschnitt).
- In der Windows-Firewall den Port nur für Domänen- und private Netzwerke
  freigeben (Befehl siehe „Einrichten unter Windows“) und im Router **keine**
  Portweiterleitung einrichten.

## HTTPS-Zertifikat

### Empfohlen: Let's Encrypt über Cloudflare-DNS

Die Basis holt und erneuert das Zertifikat selbst. Sie nutzt dafür die
**DNS-Prüfung (DNS-01)**: Let's Encrypt prüft nur einen TXT-Eintrag im
öffentlichen DNS. Der Worker muss deshalb **nicht aus dem Internet erreichbar
sein** und kein Port nach außen geöffnet werden. Er braucht nur ausgehend HTTPS
zu `acme-v02.api.letsencrypt.org`, `api.cloudflare.com` und
`cloudflare-dns.com`.

Voraussetzungen:

1. Die Domain (z. B. `konsum-weimar.de`) wird in **Cloudflare** verwaltet.
2. In Cloudflare unter **Mein Profil → API-Token → Token erstellen** die
   Vorlage **„Zone-DNS bearbeiten“** wählen. Das Token auf genau diese Zone
   beschränken und in `tls.cloudflare_token` eintragen.
3. Der `hostname` muss im Firmennetz auf die IP des Workers zeigen. Dafür
   gibt es zwei Wege:
   - im internen DNS (Router/Domaincontroller) einen A-Eintrag anlegen, oder
   - in Cloudflare einen A-Eintrag mit der internen IP anlegen, Proxy-Status
     **„Nur DNS“** (graue Wolke).

```json
"tls": {
  "modus": "letsencrypt",
  "email": "it@konsum-weimar.de",
  "cloudflare_token": "…",
  "staging": true
}
```

Zuerst mit `"staging": true` testen (`node basis/main.js --zertifikat`). Das
Testzertifikat ist im Browser nicht vertrauenswürdig, zeigt aber, dass alles
funktioniert. Danach `"staging": false` setzen, den Ordner
`data\zertifikat` löschen und erneut `--zertifikat` ausführen.

Die laufende Basis prüft alle 12 Stunden und erneuert das Zertifikat 30 Tage vor
Ablauf **ohne Neustart**. Meldungen dazu stehen in `logs\basis.log`.

### Alternative: eigene Zertifikatsdateien

Wenn die IT ein Zertifikat bereitstellt (PEM-Format):

```json
"tls": { "modus": "dateien", "zertifikat": "zert\\monitoring.pem", "schluessel": "zert\\monitoring-key.pem" }
```

Die Erneuerung liegt dann bei der IT. Die Basis schreibt 30 Tage vor Ablauf
einen Hinweis ins Protokoll.

## Module andocken

Jedes Modul ist ein Unterordner in `modules/` mit einer `module.json`. Der
Ordnername muss der `id` entsprechen und darf nur Kleinbuchstaben, Ziffern
und Bindestriche enthalten. Die Basis liest den Ordner alle 15 Sekunden neu
ein: **neue, geänderte oder entfernte Module wirken ohne Neustart.** Mit
`node basis/main.js --module-pruefen` lassen sich alle Module vorab prüfen.
Ein fehlerhaftes Modul erscheint rot in der Oberfläche und stört die anderen
nicht.

Es gibt zwei Betriebsarten:

| Betriebsart | `typ` | Wer startet das Modul? |
| --- | --- | --- |
| **Eigenständig** (empfohlen) | `eigenstaendig` | Das Modul selbst – eigener Dauerprozess, Dienst oder Aufgabe im Aufgabenplaner. Es läuft auch, wenn die Basis aus ist. |
| **Von der Basis gestartet** | `programm`, `plugin` | Die Basis im Takt `intervall_minuten` oder über „Jetzt prüfen“, jeweils in einem eigenen Prozess mit Zeitlimit. |

### Austausch über drei Dateien im Modulordner

```
modules\ftp\
  module.json         vom Modul:  Name, Typ, Version, Einstellungsfelder, erwarteter Takt
  einstellungen.json  schreibt die Basis (Formular „Einstellungen“), liest das Modul
  status.json         schreibt das eigenständige Modul nach jedem Lauf, liest die Basis
```

Basis und Modul sprechen sonst nicht miteinander. Ist die Basis aus, prüft das
Modul mit den zuletzt gespeicherten Einstellungen weiter.

### Eigenständiges Modul

```json
{
  "id": "ordnerpruefung",
  "name": "Ordner auf veraltete Dateien prüfen",
  "beschreibung": "Prüft, ob die Dateien jünger als X Stunden sind.",
  "version": "1.0.0",
  "typ": "eigenstaendig",
  "intervall_minuten": 5,
  "toleranz_minuten": 10,
  "einstellungsfelder": [
    { "schluessel": "ordner", "bezeichnung": "Ordner", "typ": "text", "pflicht": true },
    { "schluessel": "max_alter_stunden", "bezeichnung": "Max. Dateialter (h)", "typ": "zahl", "min": 0.1, "standard": 2 }
  ]
}
```

Nach jedem Lauf schreibt das Modul `status.json`:

```json
{
  "status": "warnung",
  "zusammenfassung": "1 von 2 Dateien älter als 2 h.",
  "details": ["alt.csv (geändert 29.10.2026, 10:29)"],
  "messwerte": { "dateien": 2, "veraltet": 1 },
  "zeit": "2026-10-29T14:30:01Z",
  "beginn": "2026-10-29T14:30:00Z",
  "dauer_ms": 1200,
  "naechster_lauf": "2026-10-29T14:35:01Z",
  "version": "1.0.0"
}
```

- Pflicht sind `status` (`ok`, `warnung`, `fehler`) und `zeit` (Ende des
  Laufs, ISO 8601). Alles andere ist optional.
- Die Datei **erst temporär schreiben und dann umbenennen**, damit die Basis
  nie eine halbe Datei liest. Eine einmal unlesbare Datei überspringt die Basis;
  erst wenn sie etwa eine Minute lang unlesbar bleibt, zeigt sie einen Hinweis.
- **Keine Meldung:** Meldet sich das Modul nicht bis `naechster_lauf` (oder,
  ohne diese Angabe, bis letzte Meldung + `intervall_minuten`) plus
  `toleranz_minuten` (Standard 10), zeigt die Basis „Keine Meldung“.
- `beispiele/ordnerpruefung/modul.js` ist eine vollständige Vorlage: Dauerbetrieb
  mit Takt aus den Einstellungen oder einmalig mit `--einmal`.

### Einstellungsfelder

| Feld | Bedeutung |
| --- | --- |
| `schluessel` | Name in `einstellungen.json` (Kleinbuchstaben, Ziffern, `_`) |
| `bezeichnung`, `beschreibung` | Beschriftung und Hilfetext im Formular |
| `typ` | `text`, `zahl` (mit `min`, `max`, `ganzzahl`), `schalter`, `auswahl` (mit `optionen`), `passwort` |
| `pflicht` | Feld muss ausgefüllt sein |
| `standard` | Wert, solange nichts gespeichert ist (nicht bei Passwörtern) |

Nur Admins sehen und ändern Einstellungen. Passwörter zeigt die Basis nie
wieder an („gesetzt“); ein leeres Passwortfeld lässt das gespeicherte
unverändert. Jede Änderung steht mit Benutzer und Feldnamen (ohne Werte) im
Protokoll, Passwörter werden aus Protokollen und Ergebnissen herausgefiltert.
Sie liegen vorerst im Klartext in `einstellungen.json` (Verschlüsselung mit
DPAPI ist vorgemerkt) – die Datei deshalb wie `config.json` schützen.

**Pausieren:** Admins können ein Modul in den Details pausieren. Von der Basis
gestartete Module laufen dann nicht; eigenständige Module werden nicht mehr
überwacht (keine „Keine Meldung“). Die Pause übersteht Neustarts.

### Von der Basis gestartet: Programm (beliebige Sprache)

```json
{
  "id": "ftp-dateialter",
  "name": "FTP-Dateialter",
  "typ": "programm",
  "befehl": "C:\\FTPMonitor\\FTPMonitor.exe",
  "argumente": ["--run-check"],
  "arbeitsordner": "C:\\FTPMonitor",
  "intervall_minuten": 5,
  "timeout_sekunden": 120
}
```

Das Ergebnis meldet das Programm auf eine von zwei Arten:

- **Exitcode:** `0` = OK, `1` = Warnung, `2` = Fehler. Als Text dient die
  letzte Ausgabezeile.
- **JSON-Zeile** auf stdout, sie hat Vorrang vor dem Exitcode:
  `{"status":"warnung","zusammenfassung":"2 Dateien zu alt","details":["a.csv: 2,4 h"],"messwerte":{"veraltet":2}}`

`.cmd`- und `.bat`-Dateien werden über `cmd.exe` gestartet, siehe
`beispiele/skript-beispiel`. Die Basis nutzt bewusst keine Shell. Die
Einstellungen (Vorgaben aus `"einstellungen"` plus gespeicherte Werte aus
`einstellungen.json`) erhält das Programm als JSON in der Umgebungsvariable
`MONITOR_EINSTELLUNGEN`.

### Von der Basis gestartet: Node.js-Plugin

```json
{ "id": "speicherplatz", "name": "Speicherplatz", "typ": "plugin", "einstieg": "index.js", "intervall_minuten": 15, "einstellungen": { "pfad": "C:\\" } }
```

```js
export async function pruefen({ einstellungen, modulId, modulOrdner }) {
  return { status: 'ok', zusammenfassung: '…', details: [], messwerte: {} };
}
```

Für beide gilt: eigener Prozess mit Zeitlimit (`timeout_sekunden`, Standard
60), ohne `intervall_minuten` nur über **„Jetzt prüfen“**, nie doppelt, der
nächste Lauf zählt ab Ende des vorherigen. `"aktiv": false` in `module.json`
pausiert ein Modul von Anfang an.

### Für alle Module

`status` ist immer `ok`, `warnung` oder `fehler`. `details` ist eine Liste
von Texten (höchstens 100), `messwerte` enthält nur Zahlen. Die Basis behält
je Modul die letzten `verlauf_anzahl` Läufe (Standard 1000), Details nur bei
den neuesten 50.

Die Übersicht zeigt je Modul den Status (OK, Warnung, Fehler, Keine Meldung,
Pausiert, Modul fehlerhaft), die letzte Meldung, den nächsten Lauf, seit wann
ein Problem besteht, die letzten 30 Läufe als Farbleiste und in den Details
Verfügbarkeit (24 h / 7 Tage), Kennzahlen, Details und Verlauf. Module mit
Problemen stehen oben.

## Benachrichtigung per Mail

Die Basis verschickt Mails über **Microsoft 365** (Microsoft Graph) mit einer
eigenen App-Registrierung. Das funktioniert ohne angemeldeten Benutzer, also
auch, wenn die Basis per Autostart unter SYSTEM läuft. Der Worker braucht
ausgehend HTTPS zu `login.microsoftonline.com` und `graph.microsoft.com`.

### Wann kommt eine Mail?

| Ereignis | Betreff |
| --- | --- |
| Modul wechselt auf Fehler oder Warnung (auch Warnung → Fehler) | `[Monitoring] FEHLER: <Modul>` |
| Eigenständiges Modul meldet sich nicht mehr | `[Monitoring] KEINE MELDUNG: <Modul>` |
| Modul ist wieder OK | `[Monitoring] WIEDER OK: <Modul>` |
| Problem besteht weiter (Abstand einstellbar, Standard 4 h) | `[Monitoring] ERINNERUNG: <Modul> – Fehler seit 6 h` |

- Gemeldet wird nur der **Wechsel**, nicht jeder weitere fehlerhafte Lauf.
- **Melden nach … Läufen** (Standard 1 = sofort): erst melden, wenn Fehler
  oder Warnung so viele Läufe hintereinander bestehen. „Keine Meldung“ und
  fehlerhafte Module (`module.json`) werden immer sofort gemeldet.
- Pausierte Module lösen keine Mails aus. Der zuletzt gemeldete Zustand je
  Modul wird gespeichert – ein Neustart der Basis verschickt nichts doppelt.
- Schlägt der Versand fehl, steht das im Fehlerprotokoll; die Basis versucht
  es alle 5 Minuten erneut.

### Einrichten

1. **App registrieren:** Entra Admin Center → *App-Registrierungen* → *Neue
   Registrierung*, z. B. „Monitoring-Basis Mail“, nur Konten dieses
   Verzeichnisses. Mandanten-ID (Verzeichnis-ID) und Anwendungs-ID notieren.
2. **Geheimen Schlüssel anlegen:** *Zertifikate & Geheimnisse* → *Neuer
   geheimer Clientschlüssel*. Den **Wert** sofort kopieren (er wird nur einmal
   angezeigt). Ablaufdatum notieren – vor Ablauf einen neuen anlegen und in
   der Basis eintragen.
3. **Senderecht auf ein Postfach beschränken (RBAC for Applications):** In
   Exchange Online PowerShell (`Connect-ExchangeOnline`), Objekt-ID aus
   *Unternehmensanwendungen* (nicht aus App-Registrierungen):

   ```powershell
   New-ServicePrincipal -AppId <Anwendungs-ID> -ObjectId <Objekt-ID der Unternehmensanwendung> -DisplayName "Monitoring-Basis Mail"
   New-ManagementScope -Name "Monitoring-Absender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'monitoring@konsum-weimar.de'"
   New-ManagementRoleAssignment -App "Monitoring-Basis Mail" -Role "Application Mail.Send" -CustomResourceScope "Monitoring-Absender"
   Test-ServicePrincipalAuthorization -Identity "Monitoring-Basis Mail" -Resource monitoring@konsum-weimar.de
   ```

   `InScope` muss `True` sein. **Wichtig:** Der App in Entra **keine**
   Anwendungsberechtigung `Mail.Send` mit Administratorzustimmung geben – sonst
   darf sie als jedes Postfach senden und die Beschränkung wirkt nicht.
   Änderungen brauchen bis zu 2 Stunden, bis sie greifen.
4. **In der Basis eintragen:** Als Admin oben auf **„Benachrichtigung“**:
   Mandanten-ID, Anwendungs-ID, Schlüssel, Absenderpostfach, Empfänger, ggf.
   Adresse der Oberfläche (für den Link in der Mail), „aktiv“ anhaken,
   speichern und **„Testmail senden“**.

Die Einstellungen liegen in `data/benachrichtigung.json`. Der Schlüssel wird in
der Oberfläche nie angezeigt und aus Protokollen gefiltert, liegt aber vorerst
im Klartext in der Datei (Verschlüsselung mit DPAPI ist vorgemerkt).

## Updates

Admins finden oben rechts den Knopf **„Updates“**. Ein Punkt am Knopf zeigt an,
dass die tägliche Prüfung eine neue Version gefunden hat.

| Aktion | Wirkung |
| --- | --- |
| **Nach Updates suchen** | Fragt das neueste Release des GitHub-Repos ab und zeigt Version und Änderungen. |
| **Auf vX.Y.Z updaten** | Installiert erst nach einer Bestätigung: Download, SHA-256-Prüfung, Entpacken nach `versionen\X.Y.Z`, Selbsttest mit der vorhandenen Konfiguration, danach Neustart. Nach dem Neustart ist eine neue Anmeldung nötig. |
| **Zurück auf vX.Y.Z** | Schaltet auf die vorherige Version zurück und startet neu. |

Es wird nie automatisch installiert. Ein Update ändert niemals `config.json`,
`data`, `logs` oder `modules`. Kommt eine neue Version nicht innerhalb von
60 Sekunden hoch, schaltet `start.js` **automatisch auf die vorherige Version
zurück** und schreibt das in `logs\basis.log`. Aufbewahrt werden höchstens drei
Versionen.

Voraussetzungen:

1. Die Basis läuft über `node start.js`, nicht direkt über `basis/main.js`.
2. In GitHub unter **Profilbild → Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → Generate new token** einen Token anlegen:
   - Resource owner `pfkonsumdigital`
   - *Only select repositories*: `Monitoring-Basis` (später auch die Modul-Repos)
   - Recht **Contents: Read-only**
   - mit Ablaufdatum
3. Den Token in der Oberfläche eintragen: **„Updates“ → GitHub-Zugang → Token
   speichern**. Die Basis prüft ihn vorher bei GitHub (abgelehnte Tokens werden
   nicht gespeichert) und braucht keinen Neustart.

Die Oberfläche zeigt, ob ein Token gesetzt ist, woher er kommt und bis wann er
gilt. 14 Tage vor Ablauf steht täglich eine Warnung im Fehlerprotokoll. Der
Token wird nie wieder angezeigt und aus Protokollen gefiltert. Er liegt in
`data/github.json`, vorerst im Klartext (Verschlüsselung mit Windows-DPAPI ist
vorgesehen) – den Ordner deshalb über Windows-Dateirechte schützen.

Alternativ geht weiterhin der Eintrag in `config.json`; ein in der Oberfläche
gespeicherter Token hat Vorrang, „Token entfernen“ schaltet zurück:

```json
"updates": { "github_token": "github_pat_…" }
```

Optional lässt sich dort mit `"repo": "besitzer/name"` ein anderes Repo
angeben. Standard ist `pfkonsumdigital/Monitoring-Basis`. Der Worker braucht
ausgehend HTTPS zu `api.github.com` sowie zu `objects.githubusercontent.com`
bzw. `release-assets.githubusercontent.com` (Download).

### Neue Version veröffentlichen

1. Version in `package.json` und `package-lock.json` erhöhen und einen Abschnitt
   `## X.Y.Z` in `CHANGELOG.md` anlegen.
2. Committen und einen Tag `vX.Y.Z` pushen.
3. Der Workflow `.github/workflows/release.yml` testet den Stand, baut das Paket
   inklusive `node_modules` und Prüfsumme und legt das Release an. Als
   Release-Notizen dient der CHANGELOG-Abschnitt.

Lokal lassen sich die Pakete nach `dist/` bauen:

- Update-Paket: `npm ci --omit=dev && node scripts/paket-bauen.js`
- Windows-Paket: zusätzlich `node scripts/windows-paket.js`. Braucht `go`, `zip` und `unzip` und lädt die Node-Laufzeit mit festgelegter Prüfsumme von nodejs.org.

Online-Updates tauschen nur das Programm aus. `Start.exe`, `start.js` und
`runtime\node.exe` bleiben unverändert. Neue Fassungen davon kommen nur mit
dem vollständigen Windows-Paket.

## Dauerbetrieb, Neustart und Fehlerprotokoll

**Dauerbetrieb:** `Start.exe --autostart` einmal ausführen. Der Starter
startet die Basis nach einem Absturz nach 10 Sekunden neu.

**Neustart:** Admins finden oben den Knopf **„Neu starten“**. Er startet die
Basis und alle Module neu, laufende Prüfungen werden dabei abgebrochen. Danach
ist eine neue Anmeldung nötig. Alternativ `Start.exe --neustart`.

**Fehlerprotokoll:** Die Basis schreibt zwei Dateien in `logs\`:

| Datei | Inhalt |
| --- | --- |
| `basis.log` | Alles (Info, Warnung, Fehler) als lesbarer Text mit Zeit, Stufe und Quelle |
| `fehler.log` | Nur Warnungen und Fehler, mit Details (z. B. Fehlerausgabe eines Moduls oder Stacktrace) |

Erfasst werden:

- Module mit Status Fehler oder Warnung, Zeitüberschreitung, Startproblem oder fehlerhafter `module.json`
- interne Serverfehler
- Zertifikats- und Update-Fehler
- Anmeldesperren
- Abstürze der Basis und automatische Rückfälle des Starters
- Fehler von Start.exe

Jede Datei ist auf 5 MB begrenzt. Danach wird sie umbenannt (`.1` bis `.5`),
ältere Dateien werden gelöscht. Passwort-Hashes, der GitHub- und der
Cloudflare-Token sowie typische Token-Formate werden vor dem Schreiben durch
`***` ersetzt. Das gilt auch für gespeicherte Modulergebnisse.

Admins sehen das Protokoll über den Knopf **„Protokoll“**: filterbar nach
Stufe und Quelle, mit aufklappbaren Details und einem Download als Textdatei.

In der Windows-Firewall eingehend TCP auf den gewählten Port nur aus dem
Firmennetz freigeben.

## Sicherheit

- Nur HTTPS (TLS 1.2 oder neuer), HSTS, strenge Content-Security-Policy.
- Passwörter als scrypt-Hash. Sitzungscookie `HttpOnly`, `Secure`,
  `SameSite=Strict`.
- 5 Fehlversuche je Adresse führen zu 15 Minuten Sperre.
- Aktionen nur mit passender Herkunft und eigenem Anfragekopf (Schutz vor
  CSRF).
- Sitzungen liegen im Speicher. Nach einem Neustart der Basis ist eine
  erneute Anmeldung nötig.

## Entwicklung

```sh
npm ci
npm test
```

Die Tests prüfen Modulprüfung, Ausführung (Exitcodes, JSON, Zeitlimit,
Abstürze), Plugins, Zeitplan, Speicher, Login und Sperre, den HTTPS-Server und
die Zertifikatsabläufe. Cloudflare und Let's Encrypt werden dabei simuliert.
Eine echte Zertifikatsausstellung lässt sich nur auf dem Worker mit echter
Domain und Token prüfen.
