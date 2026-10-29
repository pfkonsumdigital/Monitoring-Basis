# Projektvorgaben

- Vor Programmänderungen einen konkreten, geordneten Vorschlag mit Verhalten,
  betroffenen Dateien und vorgesehenen Prüfungen zeigen. Der Nutzer entscheidet
  über die Umsetzung.
- Änderungen nur nach ausdrücklicher Anweisung des Nutzers zu GitHub hochladen.
  Eine Freigabe gilt für den beschriebenen Umfang und erlaubt keine späteren
  Updates ohne neue Upload-Anweisung.
- Nach jedem abgeschlossenen Projektupdate einen eigenen Commit erstellen.
- Im Commit verständlich beschreiben, was neu ist, was geändert wurde und
  welche Fehler behoben wurden. Relevante Prüfungen im Committext nennen.
- `CHANGELOG.md` bei jedem Update ergänzen. Neue Funktionen, Änderungen und
  Fehlerbehebungen klar unterscheiden; die Benutzerdokumentation aktuell halten.
- Bei Programmänderungen `npm test` ausführen, bei Änderungen in `launcher/`
  zusätzlich `go test ./...` und einen Windows-Build (`GOOS=windows`).
- Eine neue Version wird erst durch einen Tag `vX.Y.Z` als Update angeboten.
  Vorher Version in `package.json`/`package-lock.json` und einen passenden
  Abschnitt `## X.Y.Z` in `CHANGELOG.md` anlegen. Tags nur nach ausdrücklicher
  Anweisung setzen.
- `start.js`, `Start.exe` (Quellcode in `launcher/`, Go) und `runtime\node.exe`
  werden durch Online-Updates nicht ersetzt. Änderungen daran müssen
  mit älteren und neueren Versionen der Basis zusammenarbeiten und erfordern
  eine manuelle Übernahme auf dem Worker (in CHANGELOG/README vermerken).
- Zugangsdaten, `config.json`, `data/`, `logs/` und eigene Module unter
  `modules/` niemals committen.
- Das Zielrepository ist `pfkonsumdigital/Monitoring-Basis`.
  Einen Upload nur als erfolgreich melden, wenn der Remote-Stand bestätigt ist.

## Architekturgrenze

- Die Basis (`basis/`, `oberflaeche/`) enthält keine Fachlogik. Fachliche
  Prüfungen gehören in eigenständige Module.
- Module kennen nur den Andockvertrag: `module.json` (vom Modul),
  `einstellungen.json` (schreibt die Basis), `status.json` (schreibt ein
  eigenständiges Modul) und das Ergebnis mit `status` (`ok`/`warnung`/`fehler`),
  `zusammenfassung`, `details`, `messwerte`. Programme melden alternativ über
  Exitcode 0/1/2. Änderungen an diesem Vertrag müssen abwärtskompatibel sein
  und in README und CHANGELOG stehen.
- Module und Basis laufen unabhängig voneinander. Eigenständige Module startet
  die Basis nie; von der Basis gestartete Module laufen immer in einem eigenen
  Prozess mit Zeitlimit. Ein fehlerhaftes Modul darf nur sich selbst betreffen.

## Arbeitsweise beim Programmieren (Karpathy-Leitlinien)

Bei Widerspruch gehen die Projektvorgaben oben vor. Bei trivialen Aufgaben mit
Augenmaß anwenden.

1. **Erst denken, dann programmieren.** Annahmen ausdrücklich nennen. Bei
   mehreren Deutungen diese vorlegen statt still eine zu wählen. Bei
   Unklarheit nachfragen.
2. **Einfachheit zuerst.** Nur den minimalen Code, der die Aufgabe löst. Keine
   nicht verlangten Funktionen, Abstraktionen oder Konfigurierbarkeit.
3. **Gezielte Änderungen.** Nur anfassen, was die Aufgabe erfordert.
   Bestehenden Stil beibehalten. Jede geänderte Zeile muss sich auf den
   Auftrag zurückführen lassen.
4. **Zielgerichtet und überprüfbar arbeiten.** Fehler zuerst mit einem Test
   nachstellen. Bei mehrstufigen Aufgaben einen kurzen Plan mit Prüfschritt je
   Schritt angeben.
