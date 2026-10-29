// Plattformunabhängige Teile von Start.exe (testbar unter Linux).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

const aufgabeName = "Monitoring-Basis"

type konfig struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
}

// ladeKonfig liest hostname und port aus config.json (port Standard 8443).
func ladeKonfig(datei string) (konfig, error) {
	var k konfig
	daten, err := os.ReadFile(datei)
	if err != nil {
		return k, fmt.Errorf("config.json nicht gefunden (%s). Bitte config.example.json kopieren, anpassen und einen Benutzer anlegen (siehe README)", datei)
	}
	daten = []byte(strings.TrimPrefix(string(daten), "\uFEFF"))
	if err := json.Unmarshal(daten, &k); err != nil {
		return k, fmt.Errorf("config.json ist kein gültiges JSON: %v", err)
	}
	if k.Port == 0 {
		k.Port = 8443
	}
	if k.Port < 1 || k.Port > 65535 {
		return k, fmt.Errorf("ungültiger Port in config.json: %d", k.Port)
	}
	if strings.TrimSpace(k.Hostname) == "" {
		return k, fmt.Errorf("hostname fehlt in config.json")
	}
	return k, nil
}

func (k konfig) adresse() string {
	if k.Port == 443 {
		return "https://" + k.Hostname + "/"
	}
	return fmt.Sprintf("https://%s:%d/", k.Hostname, k.Port)
}

// aktion bestimmt anhand der Argumente, was Start.exe tun soll.
func aktion(argumente []string) (string, error) {
	if len(argumente) == 0 {
		return "start", nil
	}
	if len(argumente) > 1 {
		return "", fmt.Errorf("nur eine Option erlaubt")
	}
	switch argumente[0] {
	case "--dienst", "--stop", "--neustart", "--autostart", "--kein-autostart":
		return strings.TrimPrefix(argumente[0], "--"), nil
	case "--help", "-h", "/?":
		return "hilfe", nil
	}
	return "", fmt.Errorf("unbekannte Option: %s", argumente[0])
}

const hilfe = `Start.exe – Monitoring-Basis

Start.exe                  Basis im Hintergrund starten und im Browser öffnen
Start.exe --neustart       Basis samt aller Module beenden und neu starten
Start.exe --stop           Basis samt aller Module beenden
Start.exe --autostart      Beim Hochfahren automatisch starten (Aufgabenplaner)
Start.exe --kein-autostart Automatischen Start wieder entfernen
Start.exe --dienst         Im Vordergrund laufen (für den Aufgabenplaner)`

func xmlText(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

// aufgabeXML beschreibt die Aufgabe „beim Systemstart, als SYSTEM, ohne Zeitlimit“.
func aufgabeXML(exe string) string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Startet die Monitoring-Basis beim Hochfahren des Rechners.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlText(exe) + `</Command>
      <Arguments>--dienst</Arguments>
      <WorkingDirectory>` + xmlText(filepath.Dir(exe)) + `</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

// utf16MitBOM kodiert Text so, wie schtasks /XML ihn zuverlässig liest.
func utf16MitBOM(s string) []byte {
	einheiten := utf16.Encode([]rune(s))
	ausgabe := []byte{0xFF, 0xFE}
	for _, e := range einheiten {
		ausgabe = append(ausgabe, byte(e), byte(e>>8))
	}
	return ausgabe
}

// protokolliere schreibt wie die Basis: alles nach basis.log, Warnungen/Fehler zusätzlich
// als JSON-Zeile nach fehler.log (erscheint dann in der Protokoll-Ansicht).
func protokolliere(ordner, stufe, text string) {
	logs := filepath.Join(ordner, "logs")
	_ = os.MkdirAll(logs, 0o755)
	zeit := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	kennung := ""
	if stufe != "info" {
		kennung = "[" + strings.ToUpper(stufe) + "] "
	}
	anhaengen(filepath.Join(logs, "basis.log"), zeit+" "+kennung+"[Start.exe] "+text+"\n")
	if stufe != "info" {
		zeile, _ := json.Marshal(map[string]string{"zeit": zeit, "stufe": stufe, "quelle": "Start.exe", "meldung": text})
		anhaengen(filepath.Join(logs, "fehler.log"), string(zeile)+"\n")
	}
}

func anhaengen(datei, text string) {
	f, err := os.OpenFile(datei, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(text)
}

// letzteFehler liefert die Meldungen der letzten Einträge aus fehler.log (für Fehlerfenster).
func letzteFehler(ordner string, anzahl int) []string {
	daten, err := os.ReadFile(filepath.Join(ordner, "logs", "fehler.log"))
	if err != nil {
		return nil
	}
	zeilen := strings.Split(strings.TrimSpace(string(daten)), "\n")
	var ergebnis []string
	for i := len(zeilen) - 1; i >= 0 && len(ergebnis) < anzahl; i-- {
		var e struct{ Quelle, Meldung string }
		if json.Unmarshal([]byte(zeilen[i]), &e) == nil && e.Meldung != "" {
			ergebnis = append([]string{"• " + e.Quelle + ": " + e.Meldung}, ergebnis...)
		}
	}
	return ergebnis
}

func lesePid(ordner string) int {
	daten, err := os.ReadFile(filepath.Join(ordner, "starter.pid"))
	if err != nil {
		return 0
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(daten)), "%d", &pid); err != nil || pid <= 0 {
		return 0
	}
	return pid
}
