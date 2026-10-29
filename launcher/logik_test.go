package main

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestLadeKonfig(t *testing.T) {
	ordner := t.TempDir()
	datei := filepath.Join(ordner, "config.json")
	if _, err := ladeKonfig(datei); err == nil || !strings.Contains(err.Error(), "nicht gefunden") {
		t.Fatalf("fehlende Datei: %v", err)
	}
	os.WriteFile(datei, []byte("\ufeff{\"hostname\":\"m.firma.de\",\"tls\":{}}"), 0o644)
	k, err := ladeKonfig(datei)
	if err != nil || k.Port != 8443 || k.adresse() != "https://m.firma.de:8443/" {
		t.Fatalf("Standardport/BOM: %v %+v", err, k)
	}
	os.WriteFile(datei, []byte(`{"hostname":"m.firma.de","port":443}`), 0o644)
	if k, _ := ladeKonfig(datei); k.adresse() != "https://m.firma.de/" {
		t.Fatalf("Port 443: %s", k.adresse())
	}
	os.WriteFile(datei, []byte(`{"port":8443}`), 0o644)
	if _, err := ladeKonfig(datei); err == nil {
		t.Fatal("hostname fehlt muss Fehler sein")
	}
	os.WriteFile(datei, []byte(`{"port":8080,"tls":{"modus":"aus"}}`), 0o644)
	if k, err := ladeKonfig(datei); err != nil || k.adresse() != "http://localhost:8080/" {
		t.Fatalf("ohne TLS: %v %s", err, k.adresse())
	}
	os.WriteFile(datei, []byte(`{"port":80,"hostname":"m.firma.de","tls":{"modus":"aus"}}`), 0o644)
	if k, _ := ladeKonfig(datei); k.adresse() != "http://localhost/" {
		t.Fatalf("ohne TLS Port 80: %s", k.adresse())
	}
	os.WriteFile(datei, []byte(`{"tls":{"modus":"letsencrypt"}}`), 0o644)
	if _, err := ladeKonfig(datei); err == nil {
		t.Fatal("mit TLS ohne hostname muss Fehler sein")
	}
	os.WriteFile(datei, []byte(`{kaputt`), 0o644)
	if _, err := ladeKonfig(datei); err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("kaputtes JSON: %v", err)
	}
}

func TestAktion(t *testing.T) {
	faelle := map[string]string{"": "start", "--stop": "stop", "--neustart": "neustart", "--autostart": "autostart", "--kein-autostart": "kein-autostart", "--dienst": "dienst", "/?": "hilfe"}
	for arg, erwartet := range faelle {
		var args []string
		if arg != "" {
			args = []string{arg}
		}
		if a, err := aktion(args); err != nil || a != erwartet {
			t.Errorf("%q: %q %v", arg, a, err)
		}
	}
	if _, err := aktion([]string{"--quatsch"}); err == nil {
		t.Error("unbekannte Option muss Fehler sein")
	}
	if _, err := aktion([]string{"--stop", "--neustart"}); err == nil {
		t.Error("zwei Optionen müssen Fehler sein")
	}
}

func TestAufgabeXML(t *testing.T) {
	exe := `C:\Programme & Co\Monitoring "Basis"\Start.exe`
	text := aufgabeXML(exe)
	var aufgabe struct {
		Actions struct {
			Exec struct {
				Command, Arguments, WorkingDirectory string
			}
		}
		Settings   struct{ ExecutionTimeLimit string }
		Principals struct {
			Principal struct{ UserId string }
		}
	}
	// encoding="UTF-16" im Kopf: für den Test als UTF-8 deklarieren.
	if err := xml.Unmarshal([]byte(strings.Replace(text, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)), &aufgabe); err != nil {
		t.Fatal(err)
	}
	if aufgabe.Actions.Exec.Command != exe || aufgabe.Actions.Exec.Arguments != "--dienst" {
		t.Errorf("Aktion: %+v", aufgabe.Actions.Exec)
	}
	if aufgabe.Actions.Exec.WorkingDirectory != filepath.Dir(exe) && !strings.HasSuffix(aufgabe.Actions.Exec.WorkingDirectory, `Basis"`) {
		t.Errorf("Arbeitsordner: %q", aufgabe.Actions.Exec.WorkingDirectory)
	}
	if aufgabe.Settings.ExecutionTimeLimit != "PT0S" || aufgabe.Principals.Principal.UserId != "S-1-5-18" {
		t.Errorf("Einstellungen: %+v %+v", aufgabe.Settings, aufgabe.Principals)
	}
	kodiert := utf16MitBOM("Ä<")
	if kodiert[0] != 0xFF || kodiert[1] != 0xFE || len(kodiert) != 6 {
		t.Fatalf("BOM/Länge: %v", kodiert)
	}
	einheiten := []uint16{uint16(kodiert[2]) | uint16(kodiert[3])<<8, uint16(kodiert[4]) | uint16(kodiert[5])<<8}
	if string(utf16.Decode(einheiten)) != "Ä<" {
		t.Error("UTF-16 falsch")
	}
}

func TestProtokollUndFehler(t *testing.T) {
	ordner := t.TempDir()
	protokolliere(ordner, "info", "gestartet")
	protokolliere(ordner, "fehler", "Basis kam nicht hoch")
	basis, _ := os.ReadFile(filepath.Join(ordner, "logs", "basis.log"))
	if !strings.Contains(string(basis), "[Start.exe] gestartet") || !strings.Contains(string(basis), "[FEHLER] [Start.exe] Basis kam nicht hoch") {
		t.Fatalf("basis.log: %s", basis)
	}
	anhaengen(filepath.Join(ordner, "logs", "fehler.log"), "kein json\n{\"quelle\":\"Modul x\",\"meldung\":\"kaputt\"}\n")
	if got := letzteFehler(ordner, 5); len(got) != 2 || got[0] != "• Start.exe: Basis kam nicht hoch" || got[1] != "• Modul x: kaputt" {
		t.Fatalf("letzteFehler: %q", got)
	}
	if got := letzteFehler(ordner, 1); len(got) != 1 || got[0] != "• Modul x: kaputt" {
		t.Fatalf("Begrenzung: %q", got)
	}
}

func TestLesePid(t *testing.T) {
	ordner := t.TempDir()
	if lesePid(ordner) != 0 {
		t.Fatal("ohne Datei muss 0 kommen")
	}
	os.WriteFile(filepath.Join(ordner, "starter.pid"), []byte("4711\n"), 0o644)
	if lesePid(ordner) != 4711 {
		t.Fatal("PID falsch gelesen")
	}
	os.WriteFile(filepath.Join(ordner, "starter.pid"), []byte("abc"), 0o644)
	if lesePid(ordner) != 0 {
		t.Fatal("ungültige PID muss 0 ergeben")
	}
}
