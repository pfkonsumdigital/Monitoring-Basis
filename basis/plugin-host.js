// Läuft in einem eigenen Prozess: lädt ein Plugin, ruft pruefen() auf und gibt das Ergebnis
// als letzte JSON-Zeile auf stdout aus. Ausgaben des Plugins über console.log gehen nach stderr,
// damit sie das Ergebnis nicht stören.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const schreibeErgebnis = (ergebnis) => new Promise((resolve) => process.stdout.write(JSON.stringify(ergebnis) + '\n', resolve));

console.log = console.info = console.debug = console.error;
try {
  const einstieg = process.argv[2];
  const plugin = await import(pathToFileURL(path.resolve(einstieg)).href);
  if (typeof plugin.pruefen !== 'function') throw new Error('Das Plugin exportiert keine Funktion pruefen().');
  const ergebnis = await plugin.pruefen({
    modulId: process.env.MONITOR_MODUL_ID,
    modulOrdner: process.cwd(),
    einstellungen: JSON.parse(process.env.MONITOR_EINSTELLUNGEN || '{}'),
  });
  await schreibeErgebnis(ergebnis ?? {});
  process.exit(0);
} catch (fehler) {
  await schreibeErgebnis({ status: 'fehler', zusammenfassung: `Plugin-Fehler: ${String(fehler?.message || fehler).slice(0, 300)}` });
  process.exit(2);
}
