import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pruefeFelder } from './einstellungen.js';

const ID_MUSTER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const istText = (wert) => typeof wert === 'string' && wert.trim() !== '' && !/[\r\n\0]/.test(wert);

// Prüft eine module.json. Liefert entweder { modul } oder { fehler } mit lesbarer Meldung.
export function pruefeModul(roh, ordnerName, modulOrdner) {
  const fehler = (text) => ({ fehler: `module.json: ${text}` });
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return fehler('muss ein JSON-Objekt sein');
  if (!ID_MUSTER.test(ordnerName)) return fehler('Ordnername darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten');
  if (roh.id !== ordnerName) return fehler(`id muss dem Ordnernamen „${ordnerName}“ entsprechen`);
  if (!istText(roh.name) || roh.name.length > 100) return fehler('name fehlt oder ist länger als 100 Zeichen');
  if (roh.aktiv !== undefined && typeof roh.aktiv !== 'boolean') return fehler('aktiv muss true oder false sein');
  const intervall = roh.intervall_minuten;
  if (intervall !== undefined && (typeof intervall !== 'number' || !(intervall >= 1) || intervall > 10080)) return fehler('intervall_minuten muss zwischen 1 und 10080 liegen');
  const timeout = roh.timeout_sekunden ?? 60;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) return fehler('timeout_sekunden muss eine ganze Zahl zwischen 1 und 3600 sein');
  const einstellungen = roh.einstellungen ?? {};
  if (typeof einstellungen !== 'object' || Array.isArray(einstellungen) || einstellungen === null) return fehler('einstellungen muss ein Objekt sein');
  const { felder, fehler: feldFehler } = pruefeFelder(roh.einstellungsfelder);
  if (feldFehler) return fehler(feldFehler);
  if (roh.version !== undefined && (!istText(roh.version) || roh.version.length > 40)) return fehler('version ist ungültig');
  if (roh.beschreibung !== undefined && (typeof roh.beschreibung !== 'string' || roh.beschreibung.length > 1000)) return fehler('beschreibung ist ungültig');
  if (roh.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(roh.repo)) return fehler('repo muss die Form "besitzer/repo" haben');
  const toleranz = roh.toleranz_minuten ?? 10;
  if (typeof toleranz !== 'number' || !(toleranz >= 1) || toleranz > 10080) return fehler('toleranz_minuten muss zwischen 1 und 10080 liegen');

  const modul = {
    id: roh.id, name: roh.name, typ: roh.typ, ordner: modulOrdner,
    aktiv: roh.aktiv !== false, intervallMinuten: intervall ?? null,
    timeoutMs: timeout * 1000, einstellungen, felder,
    version: roh.version ?? null, beschreibung: roh.beschreibung ?? '', repo: roh.repo ?? null,
    toleranzMinuten: toleranz,
  };
  if (roh.typ === 'eigenstaendig') {
    // Läuft selbst (eigener Dienst/Aufgabe) und schreibt status.json; die Basis startet es nie.
    // intervall_minuten = erwarteter Abstand der Meldungen (für „keine Meldung“).
  } else if (roh.typ === 'programm') {
    if (!istText(roh.befehl)) return fehler('befehl fehlt');
    const argumente = roh.argumente ?? [];
    if (!Array.isArray(argumente) || argumente.some((a) => typeof a !== 'string' || /[\0]/.test(a))) return fehler('argumente muss eine Liste von Texten sein');
    if (roh.arbeitsordner !== undefined && !istText(roh.arbeitsordner)) return fehler('arbeitsordner ist ungültig');
    modul.befehl = roh.befehl;
    modul.argumente = argumente;
    modul.arbeitsordner = roh.arbeitsordner ? path.resolve(modulOrdner, roh.arbeitsordner) : modulOrdner;
  } else if (roh.typ === 'plugin') {
    if (!istText(roh.einstieg)) return fehler('einstieg fehlt (z. B. "index.js")');
    const einstieg = path.resolve(modulOrdner, roh.einstieg);
    if (path.relative(modulOrdner, einstieg).startsWith('..') || path.isAbsolute(path.relative(modulOrdner, einstieg))) return fehler('einstieg muss im Modulordner liegen');
    modul.einstieg = einstieg;
  } else {
    return fehler('typ muss "eigenstaendig", "programm" oder "plugin" sein');
  }
  return { modul };
}

// Liest alle Unterordner mit module.json. Fehlerhafte Module werden mit Meldung zurückgegeben,
// damit sie in der Oberfläche sichtbar sind, statt still zu fehlen.
export async function ladeModule(moduleOrdner) {
  let eintraege;
  try { eintraege = await readdir(moduleOrdner, { withFileTypes: true }); }
  catch (fehler) { if (fehler.code === 'ENOENT') return []; throw fehler; }
  const ergebnis = [];
  for (const eintrag of eintraege.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const ordner = path.join(moduleOrdner, eintrag.name);
    let roh;
    try { roh = JSON.parse((await readFile(path.join(ordner, 'module.json'), 'utf8')).replace(/^﻿/, '')); }
    catch (fehler) {
      if (fehler.code === 'ENOENT') continue;
      ergebnis.push({ id: eintrag.name, name: eintrag.name, ordner, fehler: 'module.json ist kein gültiges JSON' });
      continue;
    }
    const geprueft = pruefeModul(roh, eintrag.name, ordner);
    ergebnis.push(geprueft.modul ?? { id: ID_MUSTER.test(eintrag.name) ? eintrag.name : `ungueltig-${ergebnis.length}`, name: eintrag.name, ordner, fehler: geprueft.fehler });
  }
  return ergebnis;
}
