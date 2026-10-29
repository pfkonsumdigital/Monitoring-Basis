//go:build windows

// Start.exe: startet die Monitoring-Basis ohne Konsolenfenster, öffnet den Browser und
// verwaltet Autostart, Neustart und Stopp. Baut mit -ldflags "-H windowsgui".
package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow        = 0x08000000
	createNewProcessGroup = 0x00000200
	stillActive           = 259
	queryLimited          = 0x1000
	mbOK                  = 0x00000000
	mbIconError           = 0x00000010
	mbIconInfo            = 0x00000040
)

var (
	user32       = syscall.NewLazyDLL("user32.dll")
	shell32      = syscall.NewLazyDLL("shell32.dll")
	kernel32     = syscall.NewLazyDLL("kernel32.dll")
	messageBox   = user32.NewProc("MessageBoxW")
	shellExecute = shell32.NewProc("ShellExecuteW")
	isUserAdmin  = shell32.NewProc("IsUserAnAdmin")
	openProcess  = kernel32.NewProc("OpenProcess")
	exitCodeProc = kernel32.NewProc("GetExitCodeProcess")
	closeHandle  = kernel32.NewProc("CloseHandle")
	imageName    = kernel32.NewProc("QueryFullProcessImageNameW")
)

func w(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func meldung(text string, fehler bool) {
	symbol := uintptr(mbIconInfo)
	if fehler {
		symbol = mbIconError
	}
	messageBox.Call(0, uintptr(unsafe.Pointer(w(text))), uintptr(unsafe.Pointer(w("Monitoring-Basis"))), mbOK|symbol)
}

func oeffnen(ziel string) {
	shellExecute.Call(0, uintptr(unsafe.Pointer(w("open"))), uintptr(unsafe.Pointer(w(ziel))), 0, 0, 1)
}

func istAdmin() bool { r, _, _ := isUserAdmin.Call(); return r != 0 }

// alsAdminNeuStarten startet Start.exe mit derselben Option und Administratorrechten (UAC-Abfrage).
func alsAdminNeuStarten(exe, option string) bool {
	r, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(w("runas"))), uintptr(unsafe.Pointer(w(exe))), uintptr(unsafe.Pointer(w(option))), 0, 1)
	return r > 32
}

// prozessLaeuft prüft, ob unter der PID noch ein node.exe läuft. Der Programmname wird geprüft,
// damit eine nach einem Absturz liegengebliebene starter.pid nie einen fremden Prozess trifft,
// falls Windows die Nummer inzwischen neu vergeben hat.
func prozessLaeuft(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, _, _ := openProcess.Call(queryLimited, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	defer closeHandle.Call(h)
	var code uint32
	if r, _, _ := exitCodeProc.Call(h, uintptr(unsafe.Pointer(&code))); r == 0 || code != stillActive {
		return false
	}
	puffer := make([]uint16, 1024)
	laenge := uint32(len(puffer))
	if r, _, _ := imageName.Call(h, 0, uintptr(unsafe.Pointer(&puffer[0])), uintptr(unsafe.Pointer(&laenge))); r == 0 {
		return false
	}
	return strings.EqualFold(filepath.Base(syscall.UTF16ToString(puffer[:laenge])), "node.exe")
}

func versteckt(cmd *exec.Cmd, eigeneGruppe bool) {
	flags := uint32(createNoWindow)
	if eigeneGruppe {
		flags |= createNewProcessGroup
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}

func nodePfad(ordner string) (string, error) {
	eigenes := filepath.Join(ordner, "runtime", "node.exe")
	if _, err := os.Stat(eigenes); err == nil {
		return eigenes, nil
	}
	if p, err := exec.LookPath("node.exe"); err == nil {
		return p, nil
	}
	return "", errors.New("Node.js wurde nicht gefunden (runtime\\node.exe fehlt). Bitte das vollständige Windows-Paket entpacken.")
}

func basisBefehl(ordner string) (*exec.Cmd, *os.File, error) {
	node, err := nodePfad(ordner)
	if err != nil {
		return nil, nil, err
	}
	if _, err := os.Stat(filepath.Join(ordner, "start.js")); err != nil {
		return nil, nil, errors.New("start.js fehlt im Programmordner. Bitte das vollständige Paket entpacken.")
	}
	_ = os.MkdirAll(filepath.Join(ordner, "logs"), 0o755)
	ausgabe, err := os.OpenFile(filepath.Join(ordner, "logs", "starter-ausgabe.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, nil, fmt.Errorf("logs\\starter-ausgabe.log kann nicht geschrieben werden: %v", err)
	}
	cmd := exec.Command(node, "start.js")
	cmd.Dir = ordner
	cmd.Stdout, cmd.Stderr = ausgabe, ausgabe
	return cmd, ausgabe, nil
}

func portOffen(port int) bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// starten startet die Basis im Hintergrund (falls nötig) und öffnet den Browser.
func starten(ordner string) error {
	k, err := ladeKonfig(filepath.Join(ordner, "config.json"))
	if err != nil {
		return err
	}
	if portOffen(k.Port) {
		// Antwortet bereits, z. B. als Autostart unter SYSTEM (dessen Prozess ein normaler Benutzer nicht abfragen darf).
		oeffnen(k.adresse())
		return nil
	}
	if prozessLaeuft(lesePid(ordner)) {
		// Läuft bereits (oder startet gerade): kurz auf den Port warten, dann Browser öffnen.
		for i := 0; i < 30 && !portOffen(k.Port); i++ {
			time.Sleep(time.Second)
		}
		if !portOffen(k.Port) {
			return fmt.Errorf("Die Basis läuft, antwortet aber nicht auf Port %d. Mit „Start.exe --neustart“ neu starten.%s", k.Port, fehlerHinweis(ordner))
		}
		oeffnen(k.adresse())
		return nil
	}
	cmd, ausgabe, err := basisBefehl(ordner)
	if err != nil {
		return err
	}
	defer ausgabe.Close()
	versteckt(cmd, true)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Start fehlgeschlagen: %v", err)
	}
	protokolliere(ordner, "info", "Basis im Hintergrund gestartet.")
	beendet := make(chan struct{})
	go func() { cmd.Wait(); close(beendet) }()
	frist := time.Now().Add(90 * time.Second)
	for time.Now().Before(frist) {
		select {
		case <-beendet:
			return fmt.Errorf("Die Basis hat sich direkt wieder beendet.%s", fehlerHinweis(ordner))
		case <-time.After(time.Second):
		}
		if portOffen(k.Port) {
			oeffnen(k.adresse())
			return nil
		}
	}
	return fmt.Errorf("Die Basis antwortet nach 90 Sekunden nicht auf Port %d.%s", k.Port, fehlerHinweis(ordner))
}

func fehlerHinweis(ordner string) string {
	letzte := letzteFehler(ordner, 3)
	if len(letzte) == 0 {
		return "\n\nDetails in logs\\starter-ausgabe.log und logs\\basis.log."
	}
	return "\n\nLetzte Fehler:\n" + strings.Join(letzte, "\n") + "\n\nDetails in logs\\fehler.log."
}

// stoppen beendet den Starter samt Basis und allen laufenden Modulen (Prozessbaum).
func stoppen(ordner string) (bool, error) {
	pid := lesePid(ordner)
	if !prozessLaeuft(pid) {
		_ = os.Remove(filepath.Join(ordner, "starter.pid"))
		return false, nil
	}
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	versteckt(cmd, false)
	if ausgabe, err := cmd.CombinedOutput(); err != nil {
		return true, fmt.Errorf("Beenden fehlgeschlagen: %s", strings.TrimSpace(string(ausgabe)))
	}
	for i := 0; i < 20 && prozessLaeuft(pid); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	_ = os.Remove(filepath.Join(ordner, "starter.pid"))
	protokolliere(ordner, "info", "Basis und alle Module beendet.")
	return true, nil
}

func autostart(ordner, exe string, einschalten bool) error {
	if !einschalten {
		cmd := exec.Command("schtasks", "/Delete", "/TN", aufgabeName, "/F")
		versteckt(cmd, false)
		if ausgabe, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("Aufgabe konnte nicht entfernt werden: %s", strings.TrimSpace(string(ausgabe)))
		}
		protokolliere(ordner, "info", "Autostart entfernt.")
		return nil
	}
	datei := filepath.Join(os.TempDir(), "monitoring-basis-aufgabe.xml")
	if err := os.WriteFile(datei, utf16MitBOM(aufgabeXML(exe)), 0o600); err != nil {
		return err
	}
	defer os.Remove(datei)
	cmd := exec.Command("schtasks", "/Create", "/TN", aufgabeName, "/XML", datei, "/F")
	versteckt(cmd, false)
	if ausgabe, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("Aufgabe konnte nicht angelegt werden: %s", strings.TrimSpace(string(ausgabe)))
	}
	protokolliere(ordner, "info", "Autostart eingerichtet (Aufgabe „"+aufgabeName+"“ beim Systemstart).")
	return nil
}

func main() {
	exe, _ := os.Executable()
	ordner := filepath.Dir(exe)
	was, err := aktion(os.Args[1:])
	if err != nil {
		meldung(err.Error()+"\n\n"+hilfe, true)
		os.Exit(2)
	}
	fehler := func(err error) {
		protokolliere(ordner, "fehler", strings.ReplaceAll(err.Error(), "\n", " "))
		meldung(err.Error(), true)
		os.Exit(1)
	}
	brauchtAdmin := func() {
		if !istAdmin() {
			if !alsAdminNeuStarten(exe, "--"+was) {
				meldung("Dafür sind Administratorrechte nötig.", true)
			}
			os.Exit(0)
		}
	}

	switch was {
	case "hilfe":
		meldung(hilfe, false)
	case "dienst":
		// Für den Aufgabenplaner: im Vordergrund laufen, bis der Starter endet.
		cmd, ausgabe, err := basisBefehl(ordner)
		if err != nil {
			protokolliere(ordner, "fehler", err.Error())
			os.Exit(2)
		}
		defer ausgabe.Close()
		versteckt(cmd, false)
		protokolliere(ordner, "info", "Basis als Dienst gestartet.")
		if err := cmd.Run(); err != nil {
			if e, ok := err.(*exec.ExitError); ok {
				os.Exit(e.ExitCode())
			}
			protokolliere(ordner, "fehler", "Dienst-Start fehlgeschlagen: "+err.Error())
			os.Exit(2)
		}
	case "stop", "neustart":
		lief, err := stoppen(ordner)
		if err != nil {
			if !istAdmin() {
				// Die Basis läuft z. B. als Autostart unter SYSTEM: mit Administratorrechten erneut versuchen.
				brauchtAdmin()
			}
			fehler(err)
		}
		if was == "stop" {
			if lief {
				meldung("Die Monitoring-Basis und alle Module wurden beendet.", false)
			} else {
				meldung("Die Monitoring-Basis läuft nicht.", false)
			}
			return
		}
		if err := starten(ordner); err != nil {
			fehler(err)
		}
	case "autostart", "kein-autostart":
		brauchtAdmin()
		if err := autostart(ordner, exe, was == "autostart"); err != nil {
			fehler(err)
		}
		if was == "autostart" {
			meldung("Autostart ist eingerichtet: Die Monitoring-Basis startet ab jetzt beim Hochfahren automatisch (Aufgabe „"+aufgabeName+"“ im Aufgabenplaner).\n\nLäuft sie gerade nicht, mit Start.exe starten oder den Rechner neu starten.", false)
		} else {
			meldung("Der automatische Start wurde entfernt.", false)
		}
	default:
		if err := starten(ordner); err != nil {
			fehler(err)
		}
	}
}
