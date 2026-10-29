import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-host.js');
const MAX_AUSGABE = 64 * 1024;
const STATUS = ['ok', 'warnung', 'fehler'];
const EXITCODES = { 0: 'ok', 1: 'warnung', 2: 'fehler' };

const kuerze = (text, laenge) => (text.length > laenge ? text.slice(0, laenge - 1) + '…' : text);

// Bringt ein Modulergebnis in die feste Form. Ungültige Ergebnisse werden zu einem Fehler.
export function normalisiereErgebnis(roh) {
  if (!roh || typeof roh !== 'object' || !STATUS.includes(roh.status)) {
    return { status: 'fehler', zusammenfassung: 'Ungültiges Ergebnis: status muss ok, warnung oder fehler sein.', details: [], messwerte: {} };
  }
  const details = Array.isArray(roh.details) ? roh.details.filter((d) => typeof d === 'string').slice(0, 100).map((d) => kuerze(d, 1000)) : [];
  const messwerte = {};
  if (roh.messwerte && typeof roh.messwerte === 'object') {
    for (const [name, wert] of Object.entries(roh.messwerte).slice(0, 50)) {
      if (typeof wert === 'number' && Number.isFinite(wert)) messwerte[kuerze(name, 100)] = wert;
    }
  }
  const zusammenfassung = typeof roh.zusammenfassung === 'string' && roh.zusammenfassung.trim() ? kuerze(roh.zusammenfassung.trim(), 500) : roh.status;
  return { status: roh.status, zusammenfassung, details, messwerte };
}

// Sucht von hinten die letzte stdout-Zeile, die ein gültiges Ergebnis-JSON ist.
function ergebnisAusAusgabe(stdout) {
  const zeilen = stdout.split(/\r?\n/).map((z) => z.trim()).filter(Boolean);
  for (let i = zeilen.length - 1; i >= 0; i--) {
    if (!zeilen[i].startsWith('{')) continue;
    try {
      const roh = JSON.parse(zeilen[i]);
      if (STATUS.includes(roh?.status)) return normalisiereErgebnis(roh);
    } catch { /* keine JSON-Zeile */ }
  }
  return null;
}

function beende(kind) {
  if (process.platform === 'win32' && kind.pid) {
    // Beendet auch Unterprozesse, z. B. wenn eine EXE weitere Programme startet.
    spawn('taskkill', ['/pid', String(kind.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => kind.kill());
  } else {
    kind.kill('SIGKILL');
  }
}

// Gerade laufende Modulprozesse (Prozess → Modul-ID), damit Neustart und Beenden sie mitnehmen können.
const laufende = new Map();
const abgebrochen = new WeakSet();

export function beendeLaufendeModule(modulId = null) {
  let anzahl = 0;
  for (const [kind, id] of laufende) {
    if (modulId !== null && id !== modulId) continue;
    abgebrochen.add(kind);
    beende(kind);
    anzahl++;
  }
  return anzahl;
}

function starte(befehl, argumente, { cwd, env, timeoutMs, spawnImpl, modulId = null }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', zeitUeberschritten = false;
    let kind;
    try { kind = spawnImpl(befehl, argumente, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (fehler) { resolve({ startFehler: fehler }); return; }
    laufende.set(kind, modulId);
    const timer = setTimeout(() => { zeitUeberschritten = true; beende(kind); }, timeoutMs);
    kind.stdout.on('data', (teil) => { if (stdout.length < MAX_AUSGABE) stdout += teil; });
    kind.stderr.on('data', (teil) => { if (stderr.length < MAX_AUSGABE) stderr += teil; });
    kind.once('error', (fehler) => { laufende.delete(kind); clearTimeout(timer); resolve({ startFehler: fehler }); });
    kind.once('close', (code) => { laufende.delete(kind); clearTimeout(timer); resolve({ code, stdout, stderr, zeitUeberschritten, abgebrochen: abgebrochen.has(kind) }); });
  });
}

function letzteZeile(text) {
  const zeilen = text.split(/\r?\n/).map((z) => z.trim()).filter(Boolean);
  return zeilen.length ? kuerze(zeilen[zeilen.length - 1], 500) : '';
}

// Führt ein Modul aus und liefert immer ein Ergebnis (nie eine Ausnahme).
export async function fuehreAus(modul, { spawnImpl = spawn, jetzt = () => new Date() } = {}) {
  const beginn = jetzt();
  // Aktuelle Einstellungen (einstellungen.json, von der Basis gepflegt) bei jedem Lauf neu lesen.
  let einstellungen = modul.einstellungen ?? {};
  try { if (modul.einstellungenLaden) einstellungen = await modul.einstellungenLaden(); } catch { /* Vorgaben verwenden */ }
  const env = { ...process.env, MONITOR_MODUL_ID: modul.id, MONITOR_EINSTELLUNGEN: JSON.stringify(einstellungen), MONITOR_MODUL_ORDNER: modul.ordner };
  const lauf = modul.typ === 'plugin'
    ? await starte(process.execPath, [PLUGIN_HOST, modul.einstieg], { cwd: modul.ordner, env, timeoutMs: modul.timeoutMs, spawnImpl, modulId: modul.id })
    : await starte(modul.befehl, modul.argumente, { cwd: modul.arbeitsordner, env, timeoutMs: modul.timeoutMs, spawnImpl, modulId: modul.id });

  let ergebnis;
  if (lauf.startFehler) {
    ergebnis = { status: 'fehler', zusammenfassung: `Modul konnte nicht gestartet werden (${lauf.startFehler.code || 'unbekannt'}). Befehl und Pfad prüfen.`, details: [], messwerte: {} };
  } else if (lauf.abgebrochen) {
    ergebnis = { status: 'warnung', zusammenfassung: 'Prüfung wurde über die Basis beendet.', details: [], messwerte: {} };
  } else if (lauf.zeitUeberschritten) {
    ergebnis = { status: 'fehler', zusammenfassung: `Zeitlimit von ${modul.timeoutMs / 1000} Sekunden überschritten; Modul wurde beendet.`, details: [], messwerte: {} };
  } else {
    ergebnis = ergebnisAusAusgabe(lauf.stdout);
    if (!ergebnis) {
      const status = EXITCODES[lauf.code] ?? 'fehler';
      const text = letzteZeile(lauf.stdout) || letzteZeile(lauf.stderr) || `Exitcode ${lauf.code}`;
      ergebnis = { status, zusammenfassung: status === 'fehler' && !(lauf.code in EXITCODES) ? `Exitcode ${lauf.code}: ${text}` : text, details: [], messwerte: {} };
    }
  }
  return {
    ...ergebnis,
    beginn: beginn.toISOString(),
    dauerMs: Math.max(0, jetzt() - beginn),
    ...(lauf.stderr?.trim() ? { fehlerausgabe: kuerze(lauf.stderr.trim(), 4000) } : {}),
  };
}
