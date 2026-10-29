# Monitoring-Basis

Erweiterbare Monitoring-Oberfläche für den Windows-Worker. Die Basis enthält
**keine Fachlogik**. Sie kann nur vier Dinge:

1. Module finden
2. Module nach Zeitplan oder auf Knopfdruck ausführen
3. Ergebnisse speichern
4. Ergebnisse auf einer HTTPS-Seite mit Login anzeigen

Alles Fachliche (FTP prüfen, Speicherplatz, Dienste, Dateien …) steckt in
eigenständigen Modulen, die nur an die Basis andocken.

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
| `verlauf_anzahl` | gespeicherte Ergebnisse je Modul | `200` |
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
und Bindestriche enthalten. Nach dem Hinzufügen oder Ändern die Basis neu
starten. Mit `node basis/main.js --module-pruefen` lassen sich alle Module
vorab prüfen. Fehlerhafte Module erscheinen auch rot in der Oberfläche.

### Variante 1: eigenständiges Programm (beliebige Sprache)

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
`beispiele/skript-beispiel`. Die Basis nutzt bewusst keine Shell.
Einstellungen aus `"einstellungen"` erhält das Programm als JSON in der
Umgebungsvariable `MONITOR_EINSTELLUNGEN`.

### Variante 2: Node.js-Plugin

```json
{ "id": "speicherplatz", "name": "Speicherplatz", "typ": "plugin", "einstieg": "index.js", "intervall_minuten": 15, "einstellungen": { "pfad": "C:\\" } }
```

```js
export async function pruefen({ einstellungen, modulId, modulOrdner }) {
  return { status: 'ok', zusammenfassung: '…', details: [], messwerte: {} };
}
```

### Für beide Varianten

- Jedes Modul läuft in einem **eigenen Prozess** mit Zeitlimit
  (`timeout_sekunden`, Standard 60). Ein hängendes oder abstürzendes Modul
  wird beendet, als Fehler angezeigt und beeinträchtigt die Basis nicht.
- Ohne `intervall_minuten` läuft ein Modul nur über **„Jetzt prüfen“**.
- `"aktiv": false` deaktiviert ein Modul.
- Ein Modul läuft nie doppelt. Der nächste Lauf wird ab Ende des vorherigen
  gezählt.

`status` ist immer `ok`, `warnung` oder `fehler`. `details` ist eine Liste
von Texten, `messwerte` enthält nur Zahlen.

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
2. In GitHub unter **Settings → Developer settings → Fine-grained tokens** einen
   Token anlegen:
   - nur für das Repo `Monitoring-Basis`
   - Recht **Contents: Read-only**
   - mit Ablaufdatum
3. Den Token in `config.json` eintragen:

```json
"updates": { "github_token": "github_pat_…" }
```

Optional lässt sich mit `"repo": "besitzer/name"` ein anderes Repo angeben.
Standard ist `pfkonsumdigital/Monitoring-Basis`. Der Token steht vorerst im
Klartext in `config.json`, die Datei deshalb über Windows-Dateirechte schützen.
Eine Verschlüsselung mit Windows-DPAPI ist vorgesehen. Der Worker braucht
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
