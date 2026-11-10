# Monitoring-Basis

Erweiterbare Monitoring-Oberfläche für den Windows-Worker. Die Basis enthält
**keine Fachlogik**. Sie kann nur diese Dinge:

1. Module finden – auch neue, ohne Neustart
2. Meldungen eigenständiger Module einsammeln oder einfache Module selbst nach Zeitplan starten
3. Ergebnisse speichern und auswerten (Status, „keine Meldung“, Fehler seit, Verfügbarkeit)
4. Module über ein Formular einstellen, pausieren, beenden und aktualisieren
5. Alles auf einer Webseite mit Anmeldung (Passwort und Zwei-Faktor) anzeigen
6. Bei Problemen per Mail benachrichtigen (Microsoft 365)

Dieser Stand beschreibt **Version 0.14.0**. Was sich je Version geändert hat,
steht in `CHANGELOG.md`.

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
  data/          Ergebnisse, Zustände, Zertifikate, Schlüsseldatei (nicht im Git, automatisch angelegt)
  logs/          basis.log, fehler.log, starter-ausgabe.log (nicht im Git)
  config.json    eigene Einstellungen, Benutzer, Tokens (nicht im Git)
  versionen/     per Online-Update installierte Versionen (nicht im Git)
  aktiv.json     welche Version läuft (nicht im Git, fehlt bis zum ersten Update)
```

Was in `data\` liegt:

| Datei/Ordner | Inhalt |
| --- | --- |
| `ergebnisse\<Modul>.json` | Verlauf der Läufe je Modul |
| `modulzustand.json` | Pause und „Beendet“ je Modul |
| `modulfreigaben.json` | freigegebener Stand (Fingerabdruck) je ausführbarem Modul, mit Zeit und Admin – siehe „Freigabe neuer und geänderter Module“ |
| `benachrichtigung.json`, `benachrichtigung-zustand.json` | Mail-Einstellungen (Schlüssel verschlüsselt) und zuletzt gemeldeter Zustand je Modul |
| `github.json` | GitHub-Token aus der Oberfläche (verschlüsselt) |
| `anmeldeorte.json` | bekannte Adressen der Admins (für die Sicherheitsmail) |
| `geheimnis.schluessel` | Schlüsseldatei für die Verschlüsselung – **nicht löschen, mitsichern** |
| `zertifikat\`, `zertifikat-test\` | Zertifikat von Let's Encrypt bzw. Testzertifikat |
| `modul-versionen\<Modul>\` | Sicherungen der Module vor einem Modul-Update |

Programm-Abhängigkeiten sind nur `acme-client` (Let's Encrypt) und
`qrcode-generator` (QR-Code beim Einrichten der Zwei-Faktor-Anmeldung).

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
   Zertifikat“). Für HTTPS siehe „HTTPS & Domain“.
3. **Start.exe doppelklicken.** Die Basis startet unsichtbar im Hintergrund und
   die Seite öffnet sich im Browser. Von anderen Rechnern im Firmennetz:
   `http://<IP-Adresse des Workers>:8080/`.
4. **Anmelden und Zwei-Faktor einrichten:** Nach dem Passwort zeigt die Basis
   einen QR-Code für die Authenticator-App und danach 10
   Wiederherstellungscodes (siehe „Zwei-Faktor-Anmeldung“). Das geht nur aus dem
   Firmennetz oder über VPN.
5. **Dauerbetrieb einrichten:** `Start.exe --autostart` (siehe unten).
6. Optional unter **Einstellungen**: GitHub-Token für Updates, Mail-Benachrichtigung,
   weitere Benutzer, HTTPS & Domain.

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
unter SYSTEM oder dem Dienstkonto, fragen `--stop` und `--neustart` nach
Administratorrechten.

Den Browser öffnet Start.exe mit `http://localhost:<port>/` bzw. bei HTTPS mit
`https://<hostname>:<port>/` aus `config.json`.

Start.exe ist nicht digital signiert. Je nach Unternehmensrichtlinie muss sie
freigegeben werden.

### Eigenes Dienstkonto (empfohlen)

`Start.exe --autostart` richtet die Basis unter SYSTEM ein – mit allen Rechten
auf dem Worker. Sicherer ist ein eigenes Domänenkonto **ohne Admin-Rechte**,
z. B. `KONSUM-WEIMAR\svc-monitoring`. Dann laufen auch die Module, die die
Basis startet, unter diesem Konto.

1. **Im AD:** Benutzer anlegen, nur in „Domänen-Benutzer“, Kennwort „läuft nie
   ab“. Empfohlen per Gruppenrichtlinie: lokale Anmeldung und Anmeldung über
   Remotedesktop für das Konto verweigern.
2. **Auf dem Worker** (einmal `Start.exe --autostart`, falls noch nicht
   geschehen), dann PowerShell **als Administrator**:
   ```powershell
   cd C:\monitoring-basis
   $v = (Get-Content .\aktiv.json | ConvertFrom-Json).aktiv
   powershell -ExecutionPolicy Bypass -File "$v\werkzeuge\konto-einrichten.ps1" -Konto 'KONSUM-WEIMAR\svc-monitoring'
   ```
   Ohne `aktiv.json` (noch kein Online-Update) liegt das Skript unter
   `.\werkzeuge\`. Es fragt das Kennwort ab (wird nur im Aufgabenplaner
   gespeichert) und:
   - **bricht ab, wenn das Konto Admin-Rechte hat** (lokale Administratoren,
     Domänen-, Schema- oder Organisations-Admins) – dann ändert es nichts;
   - setzt die Dateirechte: Hauptordner nur für SYSTEM, Administratoren und das
     Konto (Benutzer haben keinen Zugriff mehr auf `config.json`); das Konto
     darf dort lesen und eigene Dateien anlegen (`config.json`, `aktiv.json`,
     Sicherungen), **`Start.exe` und `runtime\` aber nicht ändern**;
     `data\` und `modules\` nur SYSTEM, Administratoren und das Konto;
     `logs\` und `versionen\` Ändern;
   - gibt dem Konto „Als Stapelverarbeitungsauftrag anmelden“ (lokale
     Richtlinie; legt eine Gruppenrichtlinie dieses Recht fest, das Konto dort
     eintragen);
   - erlaubt dem Konto Starten, Beenden und Abfragen der Windows-Dienste
     **freigegebener** Module (z. B. `MonitoringFTP`) – nur dieser Dienste;
   - stellt die Aufgabe „Monitoring-Basis“ auf das Konto um, startet die Basis
     neu und zeigt, unter welchem Konto sie läuft.
3. **Prüfen:** Einstellungen → System zeigt „Die Basis läuft unter
   KONSUM-WEIMAR\svc-monitoring – ohne Administratorrechte“. Beim Start
   protokolliert die Basis ihr Konto, warnt bei SYSTEM oder Admin-Rechten und
   meldet, wo ihr Schreibrechte fehlen.

Später erneut ausführen: nach `Start.exe --autostart` (stellt wieder auf
SYSTEM), nach einer Kennwortänderung und wenn ein Modul mit `dienst`
dazukommt (erst in der Oberfläche freigeben). Zurück auf SYSTEM:
`… konto-einrichten.ps1 -Konto 'KONSUM-WEIMAR\svc-monitoring' -Zurueck`.

Gut zu wissen:
- Die verschlüsselten Geheimnisse bleiben lesbar (an den Rechner und
  `data\geheimnis.schluessel` gebunden, nicht an das Konto).
- Module, die Netzwerkfreigaben lesen, brauchen dort Rechte für das Konto.
- Eigenständige Module mit eigenem Windows-Dienst laufen unter dem Konto ihres
  Dienstes, nicht unter dem der Basis. Das FTP-Modul stellt man mit
  `FTPModul.exe --installieren --konto` (als Administrator im Modulordner) auf
  dasselbe Konto um. Die Anzeige „Basis laeuft unter“ des Skripts zählt nur
  die Basis selbst (`start.js`, `basis\main.js`).
- Notfallbefehle (z. B. `--benutzer-anlegen`) laufen aus `versionen\`, das
  das Konto ändern darf. Auf einem Worker, dem man misstraut, sie deshalb
  nicht als Administrator ausführen, sondern erst prüfen.

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

### Befehle auf dem Worker (Wartung und Notfall)

Nach dem ersten Online-Update läuft nicht mehr das Programm im Hauptordner,
sondern die Version unter `versionen\X.Y.Z` (eingetragen in `aktiv.json`).
Befehle deshalb **immer über die aktive Version** und mit
`--config .\config.json` aufrufen. PowerShell **als Administrator** öffnen
(die Ordner `data` und `modules` sind nur für Administratoren zugänglich):

```powershell
cd C:\monitoring-basis
$v = (Get-Content .\aktiv.json -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json).aktiv
if (-not $v) { $v = '.' }
"Aktive Version: $v"
.\runtime\node.exe "$v\basis\main.js" --config .\config.json <Befehl>
```

| `<Befehl>` | Wirkung |
| --- | --- |
| `--benutzer-anlegen <Name> [--admin]` | Benutzer anlegen **oder sein Passwort neu setzen** (fragt verdeckt zweimal). Admin-Recht und Zwei-Faktor-Anmeldung bleiben erhalten. |
| `--zwei-faktor-zuruecksetzen <Name>` | Zwei-Faktor-Anmeldung entfernen; bei der nächsten Anmeldung (Firmennetz/VPN) wird sie neu eingerichtet. |
| `--zertifikat` | Let's-Encrypt-Zertifikat jetzt holen bzw. erneuern (Einstellungen aus `config.json`). |
| `--module-pruefen` | Alle Module auflisten und `module.json` prüfen. |
| `--selbsttest` | Konfiguration, Module und Programmdateien prüfen. |
| `--help` | Kurzhilfe. |

Danach `.\Start.exe --neustart`: Die laufende Basis übernimmt Änderungen an
Benutzern und Zwei-Faktor sicher erst nach einem Neustart. Ein Neustart hebt
auch eine Anmeldesperre auf; danach ist eine neue Anmeldung nötig.

Ohne `--config` sucht eine Version unter `versionen\` die `config.json` in
ihrem eigenen Ordner und findet sie nicht. Der Aufruf über `basis\main.js` im
Hauptordner startet dagegen die **ursprünglich installierte** Version – nach
Updates kann die älter sein und neuere Einträge in `config.json` (z. B.
Zwei-Faktor) nicht kennen.

### config.json

| Feld | Bedeutung | Standard |
| --- | --- | --- |
| `hostname` | Name, unter dem die Seite erreichbar ist, z. B. `monitoring.konsum-weimar.de`. Muss zum Zertifikat passen. Bei `tls.modus` `"aus"` nicht nötig. | – |
| `port` | Port der Seite | `8443` |
| `host` | Netzwerkadresse, auf der gelauscht wird. `0.0.0.0` bedeutet alle Netzwerkkarten. | `0.0.0.0` |
| `module_ordner`, `daten_ordner` | Ordner, relativ zur config.json | `modules`, `data` |
| `verlauf_anzahl` | gespeicherte Ergebnisse je Modul | `1000` |
| `sitzung_stunden` | Höchstdauer einer Sitzung, danach ist eine neue Anmeldung nötig | `8` |
| `sitzung_leerlauf_minuten` | Abmeldung nach so vielen Minuten ohne Aktion (das automatische Nachladen zählt nicht) | `30` |
| `weitere_hostnamen` | weitere Namen oder IP-Adressen, unter denen die Oberfläche aufgerufen wird, z. B. `["we-vmworker-22.konsum-weimar.local"]` (höchstens 20). Ohne Eintrag erlaubt: `hostname`, der Rechnername, `localhost` und die IP-Adressen des Workers. Anfragen an andere Namen beantwortet die Basis mit „Unbekannter Host-Name“ (Schutz vor DNS-Rebinding). | `[]` |
| `admin_netze` | Netze, aus denen Admin-Funktionen und das Einrichten der Zwei-Faktor-Anmeldung erlaubt sind (Firmennetz und VPN), z. B. `["192.168.100.0/24", "192.168.10.0/24", "127.0.0.0/8", "::1/128"]`; `["*"]` = überall | alle privaten Adressen |
| `tls` | `{"modus": "aus"}` für internen Betrieb ohne Zertifikat, `"letsencrypt"` oder `"dateien"`, siehe „HTTPS & Domain“. Wird am einfachsten in der Oberfläche eingerichtet. | – |
| `benutzer` | wird unter **Einstellungen → Benutzer** oder mit `--benutzer-anlegen` gepflegt; `"admin": true` = Admin; `zwei_faktor` legt die Basis beim Einrichten selbst an | – |
| `updates` | optional, nur nötig für einen Token oder ein anderes Repo direkt in `config.json` (siehe „Updates“); sonst den Token in der Oberfläche eintragen | – |

`config.json` enthält Passwort-Hashes und Tokens. Tokens und Zwei-Faktor-Schlüssel
verschlüsselt die Basis beim Start selbst (siehe „Verschlüsselung der
Geheimnisse“) – ein neuer Token darf also im Klartext eingetragen werden. Die
Datei trotzdem niemals committen.

## Interner Betrieb ohne Zertifikat

```json
{ "port": 8080, "tls": { "modus": "aus" }, "benutzer": {} }
```

- Die Basis läuft per **HTTP** und ist über `http://<IP-Adresse>:<port>/`
  erreichbar. Kein Hostname, kein Zertifikat, kein DNS-Token nötig.
- **Nur internes Netz:** Anfragen von Adressen außerhalb privater Netze
  (10.x, 172.16–31.x, 192.168.x, 127.x und lokale IPv6-Adressen) werden mit
  „Zugriff nur aus dem internen Netz“ abgewiesen und einmal je Adresse im
  Fehlerprotokoll vermerkt.
- Passwort und Sitzung gehen **unverschlüsselt** durch das Firmennetz. Das ist
  als Übergang gedacht; beim Start steht deshalb eine Warnung im Protokoll.
  Später auf HTTPS umstellen (nächster Abschnitt, geht in der Oberfläche).
- In der Windows-Firewall den Port nur für Domänen- und private Netzwerke
  freigeben (Befehl siehe „Einrichten unter Windows“) und im Router **keine**
  Portweiterleitung einrichten.

## HTTPS & Domain

Mit einer eigenen (Sub-)Domain, z. B. `monitoring.konsum-weimar.de`, und einem
Zertifikat von Let's Encrypt ist die Oberfläche verschlüsselt erreichbar.

### Empfohlen: Let's Encrypt über Hetzner- oder Cloudflare-DNS

Die Basis holt und erneuert das Zertifikat selbst. Sie nutzt dafür die
**DNS-Prüfung (DNS-01)**: Let's Encrypt prüft nur einen TXT-Eintrag im
öffentlichen DNS, den die Basis über die API des DNS-Anbieters kurz anlegt. Für
das Zertifikat muss der Worker deshalb **nicht aus dem Internet erreichbar
sein**. Er braucht nur ausgehend HTTPS zu `acme-v02.api.letsencrypt.org`
(Test: `acme-staging-v02.api.letsencrypt.org`), `cloudflare-dns.com` und je
nach Anbieter `api.hetzner.cloud` bzw. `api.cloudflare.com`.

#### Token bei Hetzner (DNS in der Hetzner Console)

In der **Hetzner Console** das Projekt öffnen, in dem die Zone (z. B.
`konsum-weimar.de`) liegt → **Sicherheit → API-Tokens → API-Token erstellen**,
Rechte **„Lesen & Schreiben“**. Tokens aus der alten DNS Console
(dns.hetzner.com) funktionieren nicht. Tipp: Liegt die Zone allein in einem
eigenen Projekt, kann das Token nur diese Zone ändern.

#### Token bei Cloudflare

In Cloudflare unter **Mein Profil → API-Token → Token erstellen** die Vorlage
**„Zone-DNS bearbeiten“** wählen und das Token auf genau diese Zone beschränken.

#### Einrichten in der Oberfläche

Als Admin (nur aus dem Firmennetz oder über VPN) **Einstellungen → HTTPS &
Domain** aufklappen:

1. **Domain, E-Mail, DNS-Anbieter und API-Token** eintragen und speichern. Der
   Token wird verschlüsselt in `config.json` gespeichert (siehe „Verschlüsselung
   der Geheimnisse“) und nie wieder angezeigt; leer lassen behält den
   gespeicherten. An die E-Mail-Adresse schreibt Let's Encrypt, falls ein
   Zertifikat abläuft.
2. **Verbindung prüfen:** Zeigt, ob der Token die Zone der Domain findet und
   wohin die Domain zeigt. Für das Zertifikat reicht der Token; für den Aufruf
   der Oberfläche muss die Domain auf den Worker zeigen (siehe „Name im DNS“).
3. **Testzertifikat anfragen:** holt ein Zertifikat aus der Testumgebung von
   Let's Encrypt nach `data\zertifikat-test`. Der Betrieb ändert sich nicht.
   Dauert meist 1–3 Minuten; der Fortschritt steht im Bereich.
4. **Zertifikat anfragen:** holt das echte Zertifikat nach `data\zertifikat`.
   Echte Zertifikate gibt es nur wenige pro Woche für dieselbe Domain – deshalb
   zuerst das Testzertifikat.
5. In der Windows-Firewall des Workers Port **8443** freigeben (Eingabeaufforderung
   als Administrator):

   ```
   netsh advfirewall firewall add rule name="Monitoring HTTPS" dir=in action=allow protocol=TCP localport=8443 profile=domain,private
   ```

6. **Auf HTTPS umschalten** (zweimal klicken): geht nur mit einem gültigen,
   echten Zertifikat für die eingetragene Domain. Die Basis prüft, dass Port
   8443 frei ist, setzt in `config.json` `tls.modus` auf `"letsencrypt"` und
   `port` auf `8443` und startet neu. Danach ist die Oberfläche **nur noch**
   unter `https://<domain>:8443/` erreichbar, alle melden sich neu an. Die Seite
   leitet nach einigen Sekunden selbst dorthin weiter.

Läuft HTTPS, erneuert die Basis das Zertifikat 30 Tage vor Ablauf **ohne
Neustart** (Prüfung alle 12 Stunden, Meldungen in `logs\basis.log`). Über
**„Zertifikat erneuern“** geht das auch sofort; das neue Zertifikat gilt dann
ebenfalls ohne Neustart.

**Zurück auf HTTP (intern)** (zweimal klicken) stellt wieder auf HTTP mit Port
8080 um und startet neu. Domain, Token und Zertifikate bleiben gespeichert.

#### Notfall: nach dem Umschalten nicht erreichbar

Auf dem Worker in `config.json` `"modus": "aus"` (im Abschnitt `"tls"`) und
`"port": 8080` setzen, die übrigen Einträge unter `"tls"` dürfen stehen
bleiben. Dann `Start.exe --neustart` ausführen. Die Oberfläche ist wieder unter
`http://<IP-Adresse>:8080/` erreichbar.

#### Alternativ: von Hand in config.json

```json
"hostname": "monitoring.konsum-weimar.de",
"port": 8443,
"tls": {
  "modus": "letsencrypt",
  "dns_anbieter": "hetzner",
  "hetzner_token": "…",
  "email": "it@konsum-weimar.de",
  "staging": true
}
```

Ohne `dns_anbieter` gilt in `config.json` Cloudflare (in der Oberfläche ist
Hetzner vorausgewählt); für Cloudflare `"cloudflare_token": "…"` statt
`"hetzner_token"`. Mit `"staging": true` testen: `--zertifikat` über die aktive
Version ausführen (siehe „Befehle auf dem Worker“). Das Testzertifikat ist im
Browser nicht vertrauenswürdig. Danach `"staging": false` setzen, den Ordner
`data\zertifikat` löschen, erneut `--zertifikat` ausführen und die Basis neu
starten.

#### Name im DNS

- **Nur intern:** Der `hostname` zeigt auf die **interne** IP des Workers,
  entweder im internen DNS (Router oder Domaincontroller) oder als A-Eintrag
  beim DNS-Anbieter (bei Cloudflare mit Proxy-Status „Nur DNS“).
- **Auch von außen:** Der `hostname` zeigt im öffentlichen DNS auf die
  **öffentliche** IP der Firma. In der Firewall bzw. im Router wird TCP 443
  (extern) an den Worker auf den eingestellten `port` (z. B. 8443) weitergeleitet.
  Im Firmennetz zeigt der Name am besten per internem DNS direkt auf den Worker,
  falls der Router keine Weiterleitung „von innen nach außen und zurück“ kann.
  In der Windows-Firewall den Port dann auch für das Profil „Öffentlich“ bzw.
  aus dem Internet freigeben.
- **Erst öffnen, wenn die Anmeldung abgesichert ist:** Bis die
  Zwei-Faktor-Anmeldung bzw. „Mit Microsoft anmelden“ eingerichtet ist,
  die Portweiterleitung noch nicht einrichten.

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
`--module-pruefen` lassen sich alle Module vorab prüfen (siehe „Befehle auf dem
Worker“).
Ein fehlerhaftes Modul erscheint rot in der Oberfläche und stört die anderen
nicht. Neue und geänderte Module, die die Basis ausführt, laufen erst nach der
Freigabe durch einen Admin (siehe „Freigabe neuer und geänderter Module“).

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
  befehl.json         nur bei "befehlsdatei": true – legt die Basis zum Beenden ab, liest das Modul
```

Basis und Modul sprechen sonst nicht miteinander. Ist die Basis aus, prüft das
Modul mit den zuletzt gespeicherten Einstellungen weiter.

Größengrenzen: `module.json` höchstens 256 KB, `status.json` und
`einstellungen.json` höchstens 1 MB. Verknüpfungen (Symlinks, Junctions) statt
echter Dateien werden nicht gelesen. Eine zu große oder verknüpfte
`status.json` gilt wie eine unlesbare Meldung („Meldung nicht lesbar“); ihr
Inhalt landet nie im Protokoll.

### Freigabe neuer und geänderter Module

Die Basis führt Module vom Typ `programm` und `plugin` unter ihrem eigenen
Konto aus (SYSTEM oder das Dienstkonto, siehe „Eigenes Dienstkonto“) und kann
die Windows-Dienste eigenständiger Module (`dienst`) starten und beenden. Damit
eine unbemerkt geänderte oder neu abgelegte Datei nicht automatisch mit diesen
Rechten läuft, gilt: **Ein solches Modul läuft nur in dem Stand, den ein Admin
freigegeben hat.**

- **Was zählt:** bei `programm` und `plugin` `typ`, `befehl`, `argumente`,
  `arbeitsordner` bzw. `einstieg` und die Prüfsumme (SHA-256) **jeder Datei im
  Modulordner**, auch in Unterordnern; dazu die Programmdatei aus `befehl` und
  als Argument genannte Dateien, wenn sie außerhalb des Modulordners liegen.
  Bei eigenständigen Modulen mit `dienst` zählt nur der Dienstname – ihre
  Dateien startet Windows, nicht die Basis. Eigenständige Module ohne `dienst`
  brauchen keine Freigabe.
- **Was nicht zählt:** die übrigen Angaben in `module.json` (Name, Version,
  Intervall, Beschreibung, Einstellungsfelder …), `einstellungen.json`,
  `status.json`, `befehl.json`, Dateien mit der Endung `.tmp` und die Ordner
  `daten\` und `logs\` direkt im Modulordner.
- **Regeln für Module:** Daten und Protokolle nur nach `daten\` bzw. `logs\`
  schreiben – jede andere neue oder geänderte Datei hält das Modul bis zur
  nächsten Freigabe an. Dort keinen Code ablegen, der ausgeführt wird. Keine
  Verknüpfungen (Symlinks, Junctions) im Modulordner; höchstens 5000 Dateien
  und 500 MB. Python legt keinen Bytecode (`__pycache__`) an – die Basis setzt
  `PYTHONDONTWRITEBYTECODE=1`.
- **Ablauf:** Die Basis prüft den Modulordner alle 15 Sekunden und vor jedem
  Start noch einmal vollständig. Weicht der Stand ab, steht das Modul auf
  **„Freigabe nötig“** (gelb), wird nicht gestartet, das Fehlerprotokoll und –
  falls eingerichtet – eine Mail nennen die Änderungen. Hat sich eine Datei erst
  kurz vor dem Start geändert, erscheint statt des Laufs ein Fehler „Nicht
  gestartet: …“.
- **Freigeben:** Details des Moduls → Kasten „Freigabe nötig“ mit der Liste
  der Änderungen (z. B. „geändert: lib\hilfe.dll“, „befehl: … → …“) →
  **„Freigeben“** und zur Bestätigung noch einmal klicken. Nur Admins aus dem
  Firmennetz/VPN. Freigegeben wird genau der angezeigte Stand: Hat sich das
  Modul inzwischen erneut geändert, lehnt die Basis ab und zeigt die neuen
  Änderungen. Nicht-Admins sehen nur, dass eine Freigabe nötig ist.
- **Modul-Updates** über die Basis (geprüftes Paket, von einem Admin
  gestartet) werden automatisch freigegeben. „Zurück zu vX.Y.Z“ nicht – die
  Sicherung muss erneut freigegeben werden, wenn sie vom aktuellen Stand
  abweicht. Module mit `dienst`, die auf Freigabe warten, lassen sich erst nach
  der Freigabe aktualisieren.
- **Beim ersten Start von 0.15.0** übernimmt die Basis alle vorhandenen Module
  einmalig als freigegeben (Protokoll: „Modul-Freigaben eingeführt …“).
  Fehlt `data\modulfreigaben.json` später, passiert das erneut; ist die Datei
  beschädigt, gilt nichts als freigegeben.
- Windows-Dienste und Dateirechte für Dienstkonten setzt die Basis nur für
  freigegebene Module.

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
- Liegt `zeit` nach dem Zeitpunkt, zu dem die Basis die Datei liest (falsche
  Uhr, Zeitzonenfehler), verschiebt die Basis die Zeiten der Meldung auf die
  Empfangszeit und warnt ab 5 Minuten Abweichung. `naechster_lauf` zählt
  höchstens 7 Tage nach der Meldung.
- Die Datei **erst temporär schreiben und dann umbenennen**, damit die Basis
  nie eine halbe Datei liest. Eine einmal unlesbare Datei überspringt die Basis;
  erst wenn sie etwa eine Minute lang unlesbar bleibt, zeigt sie einen Hinweis.
- **Keine Meldung:** Meldet sich das Modul nicht bis `naechster_lauf` (oder,
  ohne diese Angabe, bis letzte Meldung + `intervall_minuten`) plus
  `toleranz_minuten` (Standard 10), zeigt die Basis „Keine Meldung“.
- `beispiele/ordnerpruefung/modul.js` ist eine vollständige Vorlage: Dauerbetrieb
  mit Takt aus den Einstellungen oder einmalig mit `--einmal`, beendbar über
  `befehl.json`.

### Eigenständige Module über die Basis beenden und starten

Ein eigenständiges Modul gibt in `module.json` an, wie die Basis es beenden
kann. Nur dann zeigen die Details für Admins den Knopf **„Beenden“** (mit
Rückfrage):

| Angabe in `module.json` | Beenden | Starten |
| --- | --- | --- |
| `"dienst": "MonitoringFTP"` (Name des Windows-Dienstes) | Die Basis stoppt den Dienst (`sc.exe stop`). | Knopf **„Dienst starten“** (`sc.exe start`). |
| `"befehlsdatei": true` | Die Basis legt `befehl.json` in den Modulordner, das Modul beendet sich selbst. | Nur auf dem Worker. |

- Die Basis fasst nur den Dienst an, der in `module.json` steht. Unter SYSTEM
  darf sie jeden Dienst steuern; unter dem Dienstkonto nur die Dienste, für die
  `konto-einrichten.ps1` die Rechte gesetzt hat (freigegebene Module). Sonst
  zeigt die Oberfläche „Keine Berechtigung … konto-einrichten.ps1 ausführen“.
- **Dienstzustand:** Bei Modulen mit `dienst` fragt die Basis alle 15 Sekunden
  den Zustand ab und zeigt ihn in den Details. Ist der Dienst gestoppt (oder
  nicht installiert), ohne dass ihn jemand über die Basis beendet hat, zeigt
  die Basis **„Dienst gestoppt“** als Fehler und verschickt eine Mail.
- **Beendet:** Über die Basis beendete Module zeigen „Beendet“ (mit Zeit und
  Benutzer). Sie lösen keine „Keine Meldung“ und keine Mails aus – auch nicht
  nach einem Neustart der Basis. Sobald das Modul wieder eine neue
  `status.json` schreibt (oder über „Dienst starten“), gilt es wieder als
  laufend.
- **`befehl.json`** sieht so aus: `{"befehl": "beenden", "zeit": "2026-10-29T15:00:00Z", "von": "patrick"}`.
  Das Modul prüft regelmäßig (die Vorlage alle 2 Sekunden), ob die Datei da
  ist, löscht sie und beendet sich. **Beim Start eine vorhandene `befehl.json`
  löschen** – ein alter Befehl gilt nicht. **Liegt `befehl.json` vor, keine
  `status.json` mehr schreiben** (direkt vor dem Schreiben nachsehen), sonst
  gilt das Modul in der Basis wieder als laufend.

### Einstellungsfelder

| Feld | Bedeutung |
| --- | --- |
| `schluessel` | Name in `einstellungen.json` (Kleinbuchstaben, Ziffern, `_`) |
| `bezeichnung`, `beschreibung` | Beschriftung und Hilfetext im Formular |
| `typ` | `text`, `zahl` (mit `min`, `max`, `ganzzahl`), `schalter`, `auswahl` (mit `optionen`), `passwort`, `datum` (Wert `JJJJ-MM-TT`), `liste` (mit `spalten`, siehe unten) |
| `pflicht` | Feld muss ausgefüllt sein |
| `standard` | Wert, solange nichts gespeichert ist (nicht bei Passwörtern) |

Nur Admins sehen und ändern Einstellungen. Passwörter zeigt die Basis nie
wieder an („gesetzt“); ein leeres Passwortfeld lässt das gespeicherte
unverändert. Jede Änderung steht mit Benutzer und Feldnamen (ohne Werte) im
Protokoll, Passwörter werden aus Protokollen und Ergebnissen herausgefiltert.
In `einstellungen.json` liegen sie verschlüsselt (`dpapi:m1:…`), wenn das Modul
das kann (siehe unten, `"geheimnisse": "dpapi"`); sonst im Klartext, geschützt
nur über die Dateirechte des Ordners `modules`.

**Verschlüsselte Passwörter im eigenen Modul:** In `module.json`
`"geheimnisse": "dpapi"` eintragen. Dann speichert die Basis Passwortfelder als
`dpapi:m1:<Base64>`: Windows-DPAPI, Bereich LocalMachine, Zusatzentropie die
UTF-8-Bytes von `Monitoring-Modul/v1`. Entschlüsseln (Beispiel PowerShell):

```powershell
Add-Type -AssemblyName System.Security
$roh = [Convert]::FromBase64String($wert.Substring(9))
$e = [Text.Encoding]::UTF8.GetBytes('Monitoring-Modul/v1')
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($roh, $e, 'LocalMachine'))
```

Werte ohne Präfix sind Klartext (z. B. vor der Umstellung). Module, die die Basis
selbst startet (Programm, Plugin), bekommen die Werte immer entschlüsselt.

**Pausieren:** Admins können ein Modul in den Details pausieren. Von der Basis
gestartete Module laufen dann nicht; eigenständige Module werden nicht mehr
überwacht (keine „Keine Meldung“). Die Pause übersteht Neustarts.

**Prüfung abbrechen:** Läuft bei einem von der Basis gestarteten Modul gerade
eine Prüfung, bricht „Prüfung abbrechen“ in den Details sie ab und pausiert
das Modul. Der Lauf erscheint als Warnung „Prüfung wurde über die Basis
beendet.“

**Listen:** Ein Feld mit `"typ": "liste"` erscheint als Tabelle, in der
Admins Zeilen hinzufügen und entfernen. `spalten` beschreibt die Spalten wie
normale Felder (`text`, `zahl`, `schalter`, `auswahl`, `datum`; keine
Passwörter, keine Listen in Listen), `max_zeilen` begrenzt die Anzahl
(Standard 50, höchstens 200), `pflicht: true` verlangt mindestens eine Zeile.
`standard` ist eine Liste von Zeilen. Ganz leere Zeilen fallen beim Speichern
weg. In `einstellungen.json` steht eine Liste von Objekten:

```json
{
  "schluessel": "ordner", "bezeichnung": "Ordner", "typ": "liste", "pflicht": true,
  "spalten": [
    { "schluessel": "pfad", "bezeichnung": "Ordner", "typ": "text", "pflicht": true },
    { "schluessel": "max_alter", "bezeichnung": "Max. Alter (h)", "typ": "zahl", "min": 0.1, "standard": 2 },
    { "schluessel": "ab", "bezeichnung": "Nur Dateien ab", "typ": "datum" }
  ],
  "standard": [{ "pfad": "files", "max_alter": 2 }]
}
```

ergibt zum Beispiel `"ordner": [{ "pfad": "files", "max_alter": 2, "ab": "2026-10-27" }]`.

### Module über die Basis aktualisieren

Module mit `"repo": "besitzer/name"` und `"version": "X.Y.Z"` in
`module.json` lassen sich wie die Basis aktualisieren: Details des Moduls →
**Updates** → „Nach Updates suchen“ → „Version … installieren“. Die Basis sucht
zusätzlich einmal täglich und zeigt einen Punkt an der Kachel; installiert wird
nur auf Knopfdruck eines Admins. Es gilt derselbe GitHub-Token wie für die
Basis – er braucht **Contents: Read-only** auch für das Modul-Repo.

Das Release im Modul-Repo hat den Tag `vX.Y.Z` und die Dateien
`<id>-X.Y.Z.tar.gz` und `<id>-X.Y.Z.tar.gz.sha256`. Im Paket liegt der Inhalt
des Modulordners (`module.json` oben, mit derselben `id` und der Version
`X.Y.Z`, keine Verknüpfungen).

Ablauf der Installation:

1. Paket herunterladen, Prüfsumme und Inhalt prüfen.
2. Modul beenden: Windows-Dienst stoppen (`dienst`), `befehl.json` ablegen
   (`befehlsdatei`) oder – bei von der Basis gestarteten Modulen – pausieren.
   Eigenständige Module ohne `dienst`/`befehlsdatei` lassen sich nicht über die
   Basis aktualisieren. Hält der Dienst nicht an oder bestätigt ein laufendes
   Modul das Beenden nicht innerhalb von 60 Sekunden (es löscht `befehl.json`
   nicht), bricht das Update ab und es wird nichts ausgetauscht. Ein Modul, das
   sich zuletzt nicht mehr gemeldet hat, gilt als nicht laufend.
3. Den Modulordner nach `data\modul-versionen\<id>\` sichern und die neue
   Version einsetzen. `einstellungen.json` und `status.json` bleiben erhalten,
   aus dem Paket werden sie nie übernommen. Lassen sie sich nicht übernehmen,
   wird der Austausch rückgängig gemacht und die bisherige Version läuft weiter.
4. Modul wieder starten (Dienst starten bzw. Pause aufheben) – ein Dienst, der
   vor dem Update gestoppt war, bleibt gestoppt. Module ohne Dienst startest du
   auf dem Worker; bis sie sich melden, stehen sie auf „Beendet“.

Die neue Version gilt danach als freigegeben (siehe „Freigabe neuer und
geänderter Module“).

„Zurück zu vX.Y.Z“ tauscht genauso mit der zuletzt gesicherten Version (die
aktuellen Einstellungen bleiben); sie muss danach ggf. neu freigegeben werden. Aufbewahrt werden die zwei neuesten
Sicherungen je Modul. `data\` muss auf demselben Laufwerk liegen wie `modules\`.

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
nächste Lauf zählt ab Ende des vorherigen. „Jetzt prüfen“ dürfen alle
angemeldeten Benutzer, aber nur bei aktiven, freigegebenen Modulen und je
Modul höchstens einmal pro Minute. `"aktiv": false` in `module.json`
pausiert ein Modul von Anfang an.

### Für alle Module

`status` ist immer `ok`, `warnung` oder `fehler`. `details` ist eine Liste
von Texten (höchstens 100), `messwerte` enthält nur Zahlen (höchstens 50). Die Basis behält
je Modul die letzten `verlauf_anzahl` Läufe (Standard 1000), Details nur bei
den neuesten 50.

Die Übersicht zeigt je Modul den Status (OK, Warnung, Fehler, Keine Meldung,
Pausiert, Modul fehlerhaft, Freigabe nötig), die letzte Meldung, den nächsten Lauf, seit wann
ein Problem besteht, die letzten 30 Läufe als Farbleiste und in den Details
Verfügbarkeit (24 h / 7 Tage), Kennzahlen, Details und Verlauf. Module mit
Problemen stehen oben. Die Fehlerausgabe eines Moduls (stderr) sehen nur
Admins – sie kann interne Pfade oder Server nennen.

### Oberfläche

Die Kopfzeile zeigt die Version, den Knopf **„Einstellungen“** (nur Admins), den
eigenen Benutzernamen, **„Passwort ändern“** und **„Abmelden“**. Ist ein Admin
von außerhalb des Firmennetzes angemeldet, steht dort „Admin nur intern/VPN“
und die Admin-Funktionen fehlen. Die Seite lädt alle 10 Sekunden neu; der
Fenstertitel zeigt die Zahl der Probleme.

In den Details stehen Status und Knöpfe (Pausieren, Beenden, Dienst starten)
oben. Darunter folgen aufklappbare Bereiche, jeweils mit einer Statuszeile, die
auch zugeklappt sichtbar ist: **Einstellungen** (Formular des Moduls; zeigt
leere Pflichtfelder), **Benachrichtigung** (zusätzliche Empfänger), **Updates**,
**Kennzahlen** (beim Öffnen aufgeklappt) und **Verlauf**. Die ersten drei sehen
nur Admins.

Alle Einstellungen der Basis liegen für Admins hinter dem Knopf
**„Einstellungen“** oben rechts: HTTPS & Domain, Benachrichtigung, Benutzer,
Updates, Fehlerprotokoll und System (Neu starten, Beenden). Jeder Bereich zeigt
zugeklappt eine Statuszeile (z. B. „Aktiv · 2 Empfänger“ oder „Update auf v…
verfügbar“); es ist immer nur ein Bereich aufgeklappt.

## Benachrichtigung per Mail

Die Basis verschickt Mails über **Microsoft 365** (Microsoft Graph) mit einer
eigenen App-Registrierung. Das funktioniert ohne angemeldeten Benutzer, also
auch, wenn die Basis per Autostart unter SYSTEM oder dem Dienstkonto läuft. Der Worker braucht
ausgehend HTTPS zu `login.microsoftonline.com` und `graph.microsoft.com`.

### Wann kommt eine Mail?

| Ereignis | Betreff |
| --- | --- |
| Modul wechselt auf Fehler oder Warnung (auch Warnung → Fehler) | `[Monitoring] FEHLER: <Modul>` |
| Eigenständiges Modul meldet sich nicht mehr | `[Monitoring] KEINE MELDUNG: <Modul>` |
| Windows-Dienst eines Moduls ist gestoppt, ohne dass er über die Basis beendet wurde | `[Monitoring] DIENST GESTOPPT: <Modul>` |
| Modul ist wieder OK | `[Monitoring] WIEDER OK: <Modul>` |
| Problem besteht weiter (Abstand einstellbar, Standard 4 h) | `[Monitoring] ERINNERUNG: <Modul> – Fehler seit 6 h` |
| Ein Admin beendet die Basis über die Oberfläche | `[Monitoring] Basis beendet durch <Benutzer>` |
| Anmeldung nach Fehlversuchen gesperrt (je Adresse oder je Benutzer) | `[Monitoring] Sicherheit: Anmeldung gesperrt` |
| Ein Admin meldet sich von einer für ihn neuen Adresse an | `[Monitoring] Sicherheit: Admin-Anmeldung von neuer Adresse (<Benutzer>)` |
| Mehrere falsche Zwei-Faktor-Codes nach richtigem Passwort (Passwort vermutlich bekannt) | `[Monitoring] Sicherheit: falsche Zwei-Faktor-Codes (<Benutzer>)` |
| Anmeldung mit einem Wiederherstellungscode | `[Monitoring] Sicherheit: Anmeldung mit Wiederherstellungscode (<Benutzer>)` |
| Regelmäßiger Statusbericht, falls eingeschaltet (siehe unten) | `[Monitoring] Statusbericht: alles OK` bzw. `… : 2 Probleme` |

- Gemeldet wird nur der **Wechsel**, nicht jeder weitere fehlerhafte Lauf.
- **Melden nach … Läufen** (Standard 1 = sofort): erst melden, wenn Fehler
  oder Warnung so viele Läufe hintereinander bestehen. „Keine Meldung“ und
  fehlerhafte Module (`module.json`) werden immer sofort gemeldet.
- Pausierte und über die Basis beendete Module lösen keine Mails aus. Der zuletzt gemeldete Zustand je
  Modul wird gespeichert – ein Neustart der Basis verschickt nichts doppelt.
- Schlägt der Versand fehl, steht das im Fehlerprotokoll; die Basis versucht
  es alle 5 Minuten erneut.
- **Empfänger je Modul:** In den Details eines Moduls unter „Benachrichtigung“
  zusätzliche Empfänger eintragen. Sie bekommen die Mails
  dieses Moduls **zusätzlich** zu den allgemeinen Empfängern (doppelte Adressen
  nur einmal).
- Sicherheitsmails gehen an die allgemeinen Empfänger, höchstens eine je Art
  und 15 Minuten; weitere Ereignisse stehen gezählt in der nächsten Mail und
  einzeln im Protokoll.

### Statusbericht

Unter **Einstellungen → Benachrichtigung → Statusbericht** lässt sich eine
regelmäßige Mail einschalten, die auch kommt, wenn alles in Ordnung ist:

- **Rhythmus:** aus (Standard), täglich, werktags (Montag bis Freitag) oder
  wöchentlich an einem Wochentag, jeweils zu einer Uhrzeit (Ortszeit
  Deutschland, auch über die Zeitumstellung). Das Formular zeigt den nächsten
  Termin; die Statuszeile des Bereichs z. B. „Bericht werktags 07:30“.
- **Inhalt:** Gesamtstatus („alles OK“ oder „2 Probleme (1 Fehler, 1 Keine
  Meldung)“), eine Zeile zur Basis (läuft seit, Version, ggf. „Update
  verfügbar“) und je Modul eine Zeile mit Name und Status – Probleme zuerst,
  dazu der Link zur Oberfläche. Als Problem zählen Fehler, Modul fehlerhaft,
  Dienst gestoppt, Keine Meldung und Warnung; Pausiert und Beendet nicht.
- **Empfänger:** nur die allgemeinen Empfänger.
- **Nachholen:** War die Basis zur Berichtszeit aus, kommt der Bericht nach dem
  Start, bis 12 Stunden nach dem Termin, mit „(verspätet)“ im Betreff. Je
  Termin höchstens ein Bericht, auch nach Neustarts. Wird der Zeitplan geändert,
  gilt er ab dann – ein heute schon vergangener Termin wird nicht nachgeholt.
- **Schlägt der Versand fehl**, versucht die Basis es alle 5 Minuten erneut.
- **„Statusbericht jetzt senden“** verschickt sofort einen Bericht, zum
  Ausprobieren auch bei ausgeschalteter Benachrichtigung.
- Bleibt der Bericht aus, läuft die Basis (oder der Worker) nicht.
- Jeder Benutzer kann sich zusätzlich einen **eigenen Statusbericht** mit
  eigenem Rhythmus einstellen (siehe nächster Abschnitt).

### Meine Benachrichtigungen (für alle Benutzer)

Jeder angemeldete Benutzer – auch ohne Admin-Recht und auch von außen – kann
über den Knopf **„Meine Benachrichtigungen“** oben rechts selbst festlegen,
welche Mails er bekommt. Voraussetzung: Ein Admin hat die Benachrichtigung
eingerichtet und eingeschaltet.

1. **Adresse bestätigen:** Adresse eintragen, „Code senden“, den 6-stelligen
   Code aus der Mail eingeben. Der Code gilt 15 Minuten, höchstens 5
   Fehlversuche; ein neuer Code frühestens nach 1 Minute, höchstens 5 je
   Stunde. Erst nach der Bestätigung kommen Mails. Bei einem Wechsel bleibt
   die alte Adresse aktiv, bis die neue bestätigt ist.
   Erlaubt sind nur Adressen der Domänen, die ein Admin unter **Einstellungen →
   Benachrichtigung → Erlaubte Domänen für Benutzer-Adressen** einträgt
   (Standard `konsum-weimar.de`, genau diese Domäne, keine Subdomänen). Streicht
   der Admin eine Domäne, ruhen die Abos mit solchen Adressen.
2. **Je Modul:** *nichts*, *nur Fehler* (Fehler, Modul fehlerhaft, Keine
   Meldung, Dienst gestoppt) oder *Fehler und Warnungen*. Erinnerungen kommen im
   Abstand der allgemeinen Einstellung.
3. **Entwarnung** („Wieder OK“), falls angehakt – nur, wenn der Benutzer das
   Problem vorher auch gemeldet bekommen hat.
4. **Eigener Statusbericht:** aus, täglich, werktags oder wöchentlich zu einer
   Uhrzeit; Inhalt wie beim allgemeinen Bericht, als eigene Mail nur an den
   Benutzer. Nachholen wie oben (einmal, bis 12 Stunden). „Bericht jetzt an
   mich senden“ zum Ausprobieren.
5. **„Alle abbestellen“** löscht Abos und Adresse.

- Abonnenten stehen in **Bcc** derselben Mail; die allgemeinen und die
  Modul-Empfänger stehen wie bisher in „An“. Doppelte Adressen gehen nur einmal
  raus. Die Mail nennt am Ende, dass einige Empfänger das Modul selbst
  abonniert haben.
- **Nur an die allgemeinen Empfänger:** Sicherheitsmeldungen, „Freigabe nötig“
  und „Basis beendet“.
- **Admins** sehen unter **Einstellungen → Benutzer** je Benutzer Adresse, Zahl
  der Modul-Abos und Bericht und können die Benachrichtigungen eines Benutzers
  löschen. Wird ein Benutzer gelöscht, sind seine Abos weg (auch bei Löschung
  per Kommandozeile – beim nächsten Start). Jede Änderung steht im Protokoll.
- Heute sieht jeder Benutzer alle Module und kann deshalb alle abonnieren.
- Gespeichert in `data/benachrichtigung-abos.json`; Codes nur als Hash im
  Speicher (nach einem Neustart einfach einen neuen anfordern). Kein Neustart
  nötig.

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
4. **In der Basis eintragen:** Als Admin **Einstellungen → Benachrichtigung**:
   Mandanten-ID, Anwendungs-ID, Schlüssel, Absenderpostfach, Empfänger, ggf.
   Adresse der Oberfläche (für den Link in der Mail), erlaubte Domänen für
   Benutzer-Adressen, „aktiv“ anhaken, speichern und **„Testmail senden“**.

Die Einstellungen liegen in `data/benachrichtigung.json`. Der Schlüssel wird in
der Oberfläche nie angezeigt, aus Protokollen gefiltert und in der Datei
verschlüsselt gespeichert.

## Updates

Admins finden die Updates unter **Einstellungen → Updates**. Ein Punkt am Knopf
„Einstellungen“ zeigt an, dass die tägliche Prüfung eine neue Version gefunden
hat; die Statuszeile des Bereichs nennt die Version.

| Aktion | Wirkung |
| --- | --- |
| **Nach Updates suchen** | Fragt das neueste Release des GitHub-Repos ab und zeigt Version und Änderungen. |
| **Auf vX.Y.Z updaten** | Installiert erst nach einer Bestätigung: Download, SHA-256-Prüfung, Entpacken nach `versionen\X.Y.Z`, Selbsttest mit der vorhandenen Konfiguration, danach Neustart. Nach dem Neustart ist eine neue Anmeldung nötig. |
| **Zurück auf vX.Y.Z** | Schaltet auf die vorherige Version zurück und startet neu. Nicht auf Versionen vor 0.12.0 (siehe „Verschlüsselung der Geheimnisse“). |

Es wird nie automatisch installiert. Ein Update ändert niemals `config.json`,
`data`, `logs` oder `modules`. Kommt eine neue Version nicht innerhalb von
60 Sekunden hoch, schaltet `start.js` **automatisch auf die vorherige Version
zurück** und schreibt das in `logs\basis.log`. Aufbewahrt werden höchstens drei
Versionen.

Voraussetzungen:

1. Die Basis läuft über den Starter: `Start.exe` (Windows-Paket) bzw.
   `node start.js`, nicht direkt über `basis/main.js`. Sonst lässt sich nach
   Updates nur suchen.
2. In GitHub unter **Profilbild → Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → Generate new token** einen Token anlegen:
   - Resource owner `pfkonsumdigital`
   - *Only select repositories*: `Monitoring-Basis` (später auch die Modul-Repos)
   - Recht **Contents: Read-only** (unter „Repository permissions“; „Metadata“
     kommt automatisch dazu, weitere Rechte sind nicht nötig)
   - mit Ablaufdatum
3. Den Token in der Oberfläche eintragen: **Einstellungen → Updates → GitHub-Zugang → Token
   speichern**. Die Basis prüft vorher bei GitHub, ob der Token das Repo **und
   dessen Releases** lesen darf (abgelehnte Tokens werden nicht gespeichert),
   und braucht keinen Neustart.

Meldet die Basis „Dem Token fehlt ein Recht“, beim Token in GitHub auf
**Edit** klicken und bei „Repository permissions“ **Contents: Read-only**
ergänzen – der Token bleibt dabei gleich und muss nicht neu eingetragen
werden. „GitHub-Abruflimit erreicht“ nennt die Uhrzeit, ab der es wieder geht.

Die Oberfläche zeigt, ob ein Token gesetzt ist, woher er kommt und bis wann er
gilt. 14 Tage vor Ablauf steht täglich eine Warnung im Fehlerprotokoll. Der
Token wird nie wieder angezeigt und aus Protokollen gefiltert. Er liegt
verschlüsselt in `data/github.json`.

Alternativ geht weiterhin der Eintrag in `config.json` (dann ist
`github_token` Pflicht); ein in der Oberfläche gespeicherter Token hat Vorrang,
„Token entfernen“ schaltet zurück:

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

**Neustart:** Admins finden unter **Einstellungen → System** den Knopf
**„Neu starten“** (zweimal klicken). Er startet die
Basis und alle Module neu, laufende Prüfungen werden dabei abgebrochen. Danach
ist eine neue Anmeldung nötig. Alternativ `Start.exe --neustart`.

**Beenden:** Admins finden unter **Einstellungen → System** den Knopf
**„Basis beenden“**. Nach einer Rückfrage (zweiter Klick)
beendet sich die Basis; laufende Prüfungen werden abgebrochen. Mit dem Haken
„Auch alle eigenständigen Module und ihre Windows-Dienste beenden“ beendet sie
vorher alle eigenständigen Module, die das unterstützen (siehe „Eigenständige
Module über die Basis beenden und starten“); ohne Haken laufen sie weiter. Ist
die Benachrichtigung eingerichtet, geht eine Mail „Basis beendet“ an die
Empfänger. Weder Starter noch Aufgabenplaner starten die Basis danach von
selbst neu. Wieder starten: auf dem Worker `Start.exe` doppelklicken, im
Aufgabenplaner die Aufgabe „Monitoring-Basis“ starten (dann wieder unter
dem Konto der Aufgabe) oder den Rechner neu starten. Alternativ zum Knopf: `Start.exe --stop`.

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
ältere Dateien werden gelöscht. Passwort-Hashes, die Tokens (GitHub,
Hetzner, Cloudflare), der Mail-Schlüssel, die Schlüssel der
Authenticator-Apps, Passwörter der Module sowie typische Token-Formate werden
vor dem Schreiben durch `***` ersetzt. Das gilt auch für gespeicherte
Modulergebnisse.

Admins sehen das Protokoll unter **Einstellungen → Fehlerprotokoll** (die
Statuszeile zeigt Fehler und Warnungen der letzten 24 Stunden): filterbar nach
Stufe und Quelle, mit aufklappbaren Details und einem Download als Textdatei.

In der Windows-Firewall eingehend TCP auf den gewählten Port nur aus dem
Firmennetz freigeben.

## Benutzer und Anmeldung

Den ersten Admin legt `--benutzer-anlegen <Name> --admin` an (siehe „Einrichten
unter Windows“). Danach geht alles in der Oberfläche:

- **Einstellungen → Benutzer** (nur Admins):
  - Benutzer mit Passwort anlegen, optional als Admin.
  - Passwort eines Benutzers neu setzen. Alle Sitzungen dieses Benutzers enden
    dabei sofort; beim eigenen Konto bleibt die aktuelle Sitzung bestehen.
  - Admin-Recht vergeben oder entziehen.
  - Benutzer löschen (zweimal klicken). Seine Sitzungen enden sofort.
  - Liste **Angemeldet**: wer mit welcher Adresse seit wann angemeldet ist,
    wann zuletzt aktiv (eine offene Seite fragt alle 10 Sekunden nach) und wann
    die Sitzung endet.
  - Das eigene Konto kann man weder löschen noch sich selbst das Admin-Recht
    entziehen; der letzte Admin bleibt immer Admin.
- **Passwort ändern** (Knopf oben, alle Benutzer): eigenes Passwort ändern, mit
  dem bisherigen Passwort als Bestätigung. Falsche Eingaben zählen wie
  Fehlversuche bei der Anmeldung. Andere Sitzungen mit diesem Konto enden.

Passwörter für neue Konten und Passwortwechsel: mindestens 12, höchstens 200
Zeichen, ohne den Benutzernamen und nicht überwiegend aus Allerweltswörtern
(„Passwort“, „Sommer“, „123456“, „Monitoring“ …). Am besten ein Satz oder
mehrere zufällige Wörter. Bestehende Passwörter gelten weiter. Gespeichert wird in
`config.json` (nur scrypt-Hashes), ohne Neustart. Vorher legt die Basis eine
Sicherung `config.json.vor-benutzeraenderung.json` an. Jede Änderung steht im
Protokoll („Benutzer bob angelegt durch anna.“), Passwörter nie.

### Zwei-Faktor-Anmeldung (Pflicht für alle)

Nach dem Passwort fragt die Basis einen 6-stelligen Code aus einer
Authenticator-App ab (Microsoft Authenticator, Google Authenticator, 1Password …;
Verfahren TOTP nach RFC 6238, 30 Sekunden).

- **Einrichten:** Bei der ersten Anmeldung jedes Benutzers zeigt die Basis einen
  QR-Code. Mit der App scannen (oder den
  Schlüssel abtippen), den Code eingeben, fertig. Danach zeigt sie **10
  Wiederherstellungscodes** einmalig an: notieren oder ausdrucken und sicher
  aufbewahren, nicht auf dem Handy. Jeder Code gilt nur einmal.
- Einrichten geht **nur aus dem Firmennetz oder über VPN** (`admin_netze`). Wer
  das Passwort eines noch nicht eingerichteten Kontos von außen kennt, kann so
  keine eigene App hinterlegen. Ist die App eingerichtet, geht die Anmeldung
  auch von außen.
- Für Code und Einrichtung bleiben 5 bzw. 10 Minuten. Jeder Code aus der App
  gilt nur einmal (auch nicht zweimal innerhalb seiner 30 Sekunden); die Uhr des
  Handys darf etwa 30 Sekunden abweichen.
- **5 falsche Codes in 15 Minuten** sperren die Zwei-Faktor-Anmeldung dieses
  Benutzers für 15 Minuten – auch ein erneut richtig eingegebenes Passwort hebt
  das nicht auf. Da das Passwort dabei richtig war, kommt eine Sicherheitsmail:
  Passwort sofort ändern, wenn man es nicht selbst war.
- **Handy verloren:** mit einem Wiederherstellungscode anmelden (es kommt eine
  Sicherheitsmail) und einen anderen Admin bitten, unter **Einstellungen →
  Benutzer** auf **2FA zurücksetzen** zu klicken (zweimal). Die Sitzungen des Benutzers enden;
  bei der nächsten Anmeldung im Firmennetz/VPN richtet er die App neu ein. Die
  eigene Zwei-Faktor-Anmeldung kann man nicht selbst zurücksetzen.
- **Notfall** (z. B. Handy des einzigen Admins weg, keine Codes mehr): auf dem
  Worker `--zwei-faktor-zuruecksetzen <Name>` über die aktive Version ausführen
  und `.\Start.exe --neustart` (siehe „Befehle auf dem Worker“). Bei der
  nächsten Anmeldung richtet der Benutzer die App neu ein.
- Ein Passwortwechsel lässt die Zwei-Faktor-Anmeldung bestehen.
- Gespeichert wird in `config.json` beim Benutzer unter `zwei_faktor`: der
  Schlüssel der App verschlüsselt (siehe unten), die Wiederherstellungscodes nur
  als SHA-256-Hash.

### Probleme bei der Anmeldung

| Meldung auf der Anmeldeseite | Ursache | Abhilfe |
| --- | --- | --- |
| „Benutzername oder Passwort falsch.“ | Passwort oder Name stimmt nicht (Groß-/Kleinschreibung zählt). Häufig füllt der Browser einen falschen gespeicherten Wert ein – etwa wenn er beim Einrichten der Zwei-Faktor-Anmeldung einen Code als „neues Passwort“ gespeichert hat. | Name und Passwort von Hand eintippen. Sonst das Passwort mit `--benutzer-anlegen <Name>` neu setzen und neu starten (siehe „Befehle auf dem Worker“), danach den Eintrag im Passwort-Manager des Browsers korrigieren. |
| „Zu viele Fehlversuche. Bitte 15 Minuten warten.“ | Sperre nach 5 Fehlversuchen je Adresse, 10 je Benutzer oder 5 falschen Codes | 15 Minuten warten oder `Start.exe --neustart` (Sperren liegen nur im Speicher) |
| „Der Code stimmt nicht …“ | falscher oder schon benutzter Code, Uhr von Handy oder Worker weicht ab | Uhrzeit prüfen, nächsten Code abwarten, sonst Wiederherstellungscode |
| „Die Zeit für den Bestätigungscode ist abgelaufen …“ | mehr als 5 Minuten (Einrichten: 10) zwischen Passwort und Code | neu anmelden |
| „… muss einmalig im Firmennetz oder über VPN eingerichtet werden …“ | Zwei-Faktor noch nicht eingerichtet und Anmeldung von außen | im Firmennetz oder über VPN anmelden |
| „Die Sitzung ist abgelaufen …“ / „Die Basis wurde neu gestartet …“ | Leerlauf, Höchstdauer oder Neustart | neu anmelden |
| „Zugriff nur aus dem internen Netz.“ | HTTP-Betrieb, Zugriff von einer öffentlichen Adresse | nur intern oder über VPN aufrufen |
| „Unbekannter Host-Name …“ (statt der Anmeldeseite) | Die Seite wurde über einen Namen aufgerufen, den die Basis nicht kennt, z. B. den vollständigen Rechnernamen | über `hostname` bzw. die IP-Adresse aufrufen oder den Namen in `config.json` unter `weitere_hostnamen` eintragen und neu starten; der abgewiesene Name steht im Fehlerprotokoll |

Jeder Fehlversuch steht in `logs\basis.log` („Fehlgeschlagene Anmeldung von …“),
Sperren zusätzlich im Fehlerprotokoll.

### Verschlüsselung der Geheimnisse

Ab 0.12.0 speichert die Basis alle Geheimnisse mit der Windows-Datenschutz-API
(DPAPI) verschlüsselt, gebunden an diesen Rechner:

| Wo | Was | Gespeichert als |
| --- | --- | --- |
| `config.json` | `tls.hetzner_token`, `tls.cloudflare_token`, `updates.github_token`, Schlüssel der Authenticator-Apps | `dpapi:v1:…` |
| `data\github.json` | GitHub-Token aus der Oberfläche | `dpapi:v1:…` |
| `data\benachrichtigung.json` | geheimer Schlüssel für den Mailversand | `dpapi:v1:…` |
| `modules\<Modul>\einstellungen.json` | Passwortfelder, wenn das Modul es kann (z. B. FTP-Modul ab 2.2.0) | `dpapi:m1:…` |

- **Umstellung automatisch:** Nach dem ersten Start von 0.12.0 – erst wenn die
  Basis vollständig läuft – verschlüsselt sie alle Klartext-Werte. Ebenso jeden
  Token, der später von Hand im Klartext in `config.json` eingetragen wird (beim
  nächsten Start). Das Protokoll nennt, was umgestellt wurde (ohne Werte).
- **Alte Sicherungskopien** (`config.json.backup-….json`,
  `config.json.vor-benutzeraenderung.json`) enthalten den Klartext. Die Basis
  löscht sie, sobald sie in `config.json` etwas verschlüsselt hat.
- **Schlüsseldatei `data\geheimnis.schluessel`:** Die Werte der Basis sind
  zusätzlich an diese Datei gebunden. `config.json` bleibt so für Start.exe
  lesbar, ohne dass die Werte darin jemandem nützen. **Die Datei nicht löschen
  und bei einer Sicherung mitsichern.** Fehlt sie, startet die Basis nicht und
  nennt die Abhilfe: Tokens neu im Klartext in `config.json` eintragen und die
  Zwei-Faktor-Anmeldungen mit `--zwei-faktor-zuruecksetzen <Name>` zurücksetzen.
- **Dateirechte:** Beim Start setzt die Basis die Rechte der Ordner `data` und
  `modules`: nur SYSTEM, Administratoren und das Konto, unter dem die Basis
  läuft (Vererbung aus, Unterordner übernehmen die Rechte). Läuft der
  Windows-Dienst eines Moduls (`"dienst"` in `module.json`) unter einem eigenen
  Konto, bekommt dieses Konto Ändern-Rechte auf seinen eigenen Modulordner – nach
  einem Kontowechsel beim nächsten Start der Basis. Eine Eingabeaufforderung für
  Modulbefehle (z. B. `FTPModul.exe --einmal`) deshalb **als Administrator**
  öffnen.
- **Was das schützt:** Verlässt eine Datei oder eine Sicherung den Rechner,
  lassen sich die Werte nicht entschlüsseln; normale Windows-Benutzer auf dem
  Worker kommen nicht an `data` und `modules`. **Was nicht:** Ein Administrator
  (oder Schadsoftware mit Admin-Rechten) auf dem Worker selbst kann die Werte
  lesen – das verhindert keine Verschlüsselung auf demselben Rechner.
- **Kein Zurück vor 0.12.0:** Ältere Versionen können die verschlüsselten Werte
  nicht lesen. Der Knopf „Zurück“ unter Updates erscheint dafür nicht mehr.
  Schlägt das Update auf 0.12.0 beim Start fehl, schaltet der Starter wie bisher
  zurück – verschlüsselt wird erst nach erfolgreichem Start.
- **Rechnerwechsel:** Beim Umzug auf einen anderen Rechner alle Geheimnisse dort
  neu eintragen (Tokens in `config.json`, Mail-Schlüssel und Modul-Passwörter in
  der Oberfläche) und die Zwei-Faktor-Anmeldungen zurücksetzen.
- Unter Linux/macOS (Entwicklung) bleibt alles im Klartext; die Basis meldet das
  beim Start.

## Sicherheit

- **Zwei-Faktor-Anmeldung für alle** (siehe oben).
- **Geheimnisse verschlüsselt** (DPAPI, an den Rechner gebunden) und Ordner
  `data`/`modules` nur für SYSTEM, Administratoren und das Konto der Basis
  (siehe oben).
- **Eigenes Dienstkonto ohne Admin-Rechte** statt SYSTEM (siehe „Eigenes
  Dienstkonto“); die Basis warnt beim Start, wenn sie als SYSTEM oder mit
  Admin-Rechten läuft.
- Mit Zertifikat nur HTTPS (TLS 1.2 oder neuer) mit HSTS; im HTTP-Betrieb
  (`tls.modus` `"aus"`) nur Zugriffe aus privaten Netzen. Immer strenge
  Content-Security-Policy, Schutz vor Einbetten in fremde Seiten.
- Passwörter als scrypt-Hash nach OWASP-Empfehlung (N=2^17, r=8, p=1). Ältere,
  schwächere Hashes werden bei der nächsten Anmeldung automatisch erneuert.
  Sitzungscookie `HttpOnly`, `SameSite=Strict`, bei HTTPS zusätzlich `Secure`.
- Sperren nach Fehlversuchen, je 15 Minuten: **5 je Adresse** und **10 je
  Benutzername** (gegen Raten von vielen Adressen aus). Die Listen sind begrenzt.
  Höchstens 2 Passwortprüfungen laufen gleichzeitig; bei mehr als 20 wartenden
  Anmeldungen wird sofort abgewiesen – viele Anmeldeversuche bremsen die Basis
  so nicht aus. Sperren melden sich per Mail (siehe „Benachrichtigung“).
- Admin-Anmeldung von einer für den Admin neuen Adresse: Mail an die
  Empfänger. Bekannte Adressen stehen in `data\anmeldeorte.json`.
- **Admin-Funktionen nur aus dem Firmennetz/VPN** (`admin_netze`, Standard:
  private Adressen). Von außen sieht ein Admin nur, was ein normaler Benutzer
  sieht, oben steht „Admin nur intern/VPN“. Achtung: Steht ein Reverse Proxy
  vor der Basis, sieht sie dessen (interne) Adresse – dann `admin_netze` auf das
  echte Firmen- und VPN-Netz beschränken, ohne die Adresse des Proxys. Eine
  Portweiterleitung (DNAT) der Securepoint behält die echte Adresse.
- Sitzungen enden nach 30 Minuten ohne Aktion und spätestens nach 8 Stunden
  (einstellbar). Sie liegen im Speicher; nach einem Neustart der Basis ist eine
  erneute Anmeldung nötig.
- Aktionen nur mit passender Herkunft und eigenem Anfragekopf (Schutz vor
  CSRF).
- **Nur bekannte Host-Namen** (`hostname`, `weitere_hostnamen`, Rechnername,
  `localhost`, eigene IP-Adressen); alles andere bekommt „421 Unbekannter
  Host-Name“ und wird einmal je Name protokolliert. Schutz vor DNS-Rebinding:
  Eine fremde Webseite kann ihren Namen sonst auf die interne Adresse umbiegen
  und die Oberfläche im Browser eines Mitarbeiters ansprechen.
- **Ausführbare Module nur nach Freigabe** durch einen Admin, jede Änderung
  erneut (siehe „Freigabe neuer und geänderter Module“).
- **Größengrenzen** für Dateien der Module (`module.json` 256 KB, `status.json`
  und `einstellungen.json` 1 MB), keine Verknüpfungen.
- Fehlerausgabe (stderr) der Module nur für Admins; „Jetzt prüfen“ nur bei
  aktiven Modulen und höchstens einmal pro Minute je Modul.

## Entwicklung

```sh
npm ci
npm test
```

Die Tests prüfen u. a. Modulprüfung, Ausführung (Exitcodes, JSON, Zeitlimit,
Abstürze), Plugins, Zeitplan, Speicher, Anmeldung mit Zwei-Faktor und Sperren,
Benutzerverwaltung, Benachrichtigung, Updates von Basis und Modulen, Starter,
Verschlüsselung, HTTPS & Domain, Modul-Freigaben (Fingerabdruck,
Verknüpfungen, Grenzen, Prüfung vor jedem Start), Host-Prüfung und die
Oberfläche (alle IDs vorhanden).
Hetzner, Cloudflare, Let's Encrypt, GitHub und Microsoft 365 werden dabei
simuliert; eine echte Zertifikatsausstellung lässt sich nur auf dem Worker mit
echter Domain und Token prüfen. Start.exe: `cd launcher && go test ./...`.

GitHub Actions: „Tests“ läuft bei jedem Push auf `main` (Linux: `npm test` und
`go test`; Windows: echte DPAPI, Dateirechte und Junctions im Modulordner in `tests/windows.test.js`).
„Release bauen“ läuft bei einem Tag `vX.Y.Z` (siehe „Neue Version
veröffentlichen“).
