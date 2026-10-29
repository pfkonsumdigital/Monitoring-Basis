@echo off
rem Beispiel fuer ein eigenstaendiges Programm.
rem Variante 1: nur Exitcode (0 = ok, 1 = Warnung, 2 = Fehler) und eine Textzeile.
rem Variante 2: eine JSON-Zeile mit status, zusammenfassung, details, messwerte.
echo {"status":"ok","zusammenfassung":"Skript laeuft","messwerte":{"wert":42}}
exit /b 0
