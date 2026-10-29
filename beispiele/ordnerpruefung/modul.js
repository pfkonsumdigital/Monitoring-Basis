// Beispiel für ein eigenständiges Modul der Monitoring-Basis.
//
//   node modul.js            läuft dauerhaft und prüft im eingestellten Takt
//   node modul.js --einmal   prüft einmal und beendet sich (z. B. für den Aufgabenplaner)
//
// Das Modul braucht die Basis nicht: Es liest einstellungen.json (von der Basis gepflegt) und
// schreibt nach jedem Lauf status.json in seinen Ordner. Die Basis liest diese Datei.
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORDNER = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const STANDARD = { max_alter_stunden: 2, leer_ist_fehler: false, takt_minuten: 5 };

async function einstellungen() {
  try { return { ...STANDARD, ...JSON.parse(await readFile(path.join(ORDNER, 'einstellungen.json'), 'utf8')) }; }
  catch { return { ...STANDARD }; }
}

// Schreibt erst eine temporäre Datei und benennt sie dann um – die Basis sieht nie eine halbe Datei.
async function statusSchreiben(status) {
  const ziel = path.join(ORDNER, 'status.json');
  await writeFile(`${ziel}.tmp`, JSON.stringify(status, null, 2));
  await rename(`${ziel}.tmp`, ziel);
}

async function pruefen(e) {
  if (!e.ordner) return { status: 'fehler', zusammenfassung: 'Kein Ordner eingestellt (Einstellungen in der Basis).' };
  let namen;
  try { namen = await readdir(e.ordner); }
  catch (f) { return { status: 'fehler', zusammenfassung: `Ordner nicht lesbar: ${f.code ?? f.message}` }; }
  const grenze = Date.now() - e.max_alter_stunden * 3_600_000;
  const veraltet = [];
  let dateien = 0;
  for (const name of namen) {
    const info = await stat(path.join(e.ordner, name)).catch(() => null);
    if (!info?.isFile()) continue;
    dateien++;
    if (info.mtimeMs < grenze) veraltet.push(`${name} (geändert ${new Date(info.mtimeMs).toLocaleString('de-DE')})`);
  }
  const messwerte = { dateien, veraltet: veraltet.length };
  if (!dateien) return { status: e.leer_ist_fehler ? 'fehler' : 'ok', zusammenfassung: 'Ordner ist leer.', messwerte };
  if (veraltet.length) return { status: 'warnung', zusammenfassung: `${veraltet.length} von ${dateien} Dateien älter als ${e.max_alter_stunden} h.`, details: veraltet.slice(0, 100), messwerte };
  return { status: 'ok', zusammenfassung: `${dateien} Dateien, alle aktuell.`, messwerte };
}

async function lauf() {
  const e = await einstellungen();
  const beginn = new Date();
  let ergebnis;
  try { ergebnis = await pruefen(e); }
  catch (f) { ergebnis = { status: 'fehler', zusammenfassung: `Unerwarteter Fehler: ${f.message}` }; }
  const ende = new Date();
  const taktMs = Math.max(1, Number(e.takt_minuten) || 5) * 60_000;
  await statusSchreiben({
    ...ergebnis,
    zeit: ende.toISOString(),
    beginn: beginn.toISOString(),
    dauer_ms: ende - beginn,
    naechster_lauf: new Date(ende.getTime() + taktMs).toISOString(),
    version: VERSION,
  });
  return taktMs;
}

if (process.argv.includes('--einmal')) {
  await lauf();
} else {
  // Dauerbetrieb: Takt wird bei jedem Lauf neu aus den Einstellungen gelesen.
  for (;;) {
    const taktMs = await lauf().catch(() => 60_000);
    await new Promise((r) => setTimeout(r, taktMs));
  }
}
