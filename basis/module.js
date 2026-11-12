import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pruefeFelder } from './einstellungen.js';
import { DIENST_MUSTER } from './dienste.js';
import { leseBegrenzt, MODUL_JSON_MAX } from './dateien.js';

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
  // „geheimnisse“: „dpapi“ = das Modul kann verschlüsselte Passwörter (dpapi:m1:…) lesen; dann speichert die Basis sie so.
  if (roh.geheimnisse !== undefined && roh.geheimnisse !== 'dpapi') return fehler('geheimnisse muss "dpapi" sein (oder fehlen)');
  const toleranz = roh.toleranz_minuten ?? 10;
  if (typeof toleranz !== 'number' || !(toleranz >= 1) || toleranz > 10080) return fehler('toleranz_minuten muss zwischen 1 und 10080 liegen');

  const modul = {
    id: roh.id, name: roh.name, typ: roh.typ, ordner: modulOrdner,
    aktiv: roh.aktiv !== false, intervallMinuten: intervall ?? null,
    timeoutMs: timeout * 1000, einstellungen, felder,
    version: roh.version ?? null, beschreibung: roh.beschreibung ?? '', repo: roh.repo ?? null,
    toleranzMinuten: toleranz, geheimnisse: roh.geheimnisse ?? null,
  };
  if (roh.typ === 'eigenstaendig') {
    // Läuft selbst (eigener Dienst/Aufgabe) und schreibt status.json. Die Basis startet es nie von sich aus,
    // nur einen eingetragenen Windows-Dienst auf Knopfdruck eines Admins.
    // intervall_minuten = erwarteter Abstand der Meldungen (für „keine Meldung“).
    // Beenden über die Basis: „dienst“ = Name des Windows-Dienstes, „befehlsdatei“ = Modul liest befehl.json.
    if (roh.dienst !== undefined && (typeof roh.dienst !== 'string' || !DIENST_MUSTER.test(roh.dienst))) return fehler('dienst muss der Name eines Windows-Dienstes sein (Buchstaben, Ziffern, _ . -)');
    if (roh.befehlsdatei !== undefined && typeof roh.befehlsdatei !== 'boolean') return fehler('befehlsdatei muss true oder false sein');
    modul.dienst = roh.dienst ?? null;
    modul.befehlsdatei = roh.befehlsdatei === true;
    // Eigene Seite (seit 0.21.0): Das Modul betreibt einen Webserver auf 127.0.0.1:<port>. Die Basis zeigt ihn als
    // Menüpunkt und leitet /m/<id>/… nach Anmeldung und Rechteprüfung dorthin weiter. „api“: Programme dürfen
    // /m/<id>/api/… mit einem Schlüssel des Moduls (Authorization: Bearer …) ohne Anmeldung aufrufen.
    if (roh.seite !== undefined) {
      const s = roh.seite;
      const ok = s && typeof s === 'object' && !Array.isArray(s) && istText(s.titel) && s.titel.trim().length <= 40
        && Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535;
      if (!ok) return fehler('seite muss die Form { "titel": "…" (bis 40 Zeichen), "port": 1024–65535 } haben');
      modul.seite = { titel: s.titel.trim(), port: s.port };
    }
    if (roh.api !== undefined && typeof roh.api !== 'boolean') return fehler('api muss true oder false sein');
    if (roh.api === true && !modul.seite) return fehler('api gibt es nur zusammen mit seite');
    if (modul.seite) modul.api = roh.api === true;
  } else if (['programm', 'plugin'].includes(roh.typ) && ['dienst', 'befehlsdatei', 'seite', 'api'].some((k) => roh[k] !== undefined)) {
    return fehler('dienst, befehlsdatei, seite und api gibt es nur bei typ "eigenstaendig"');
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
    try { roh = JSON.parse((await leseBegrenzt(path.join(ordner, 'module.json'), MODUL_JSON_MAX)).replace(/^﻿/, '')); }
    catch (fehler) {
      if (fehler.code === 'ENOENT') continue;
      const text = fehler.code === 'ZU_GROSS' ? `module.json ist zu groß (höchstens ${MODUL_JSON_MAX / 1024} KB)`
        : fehler.code === 'KEINE_DATEI' ? 'module.json ist keine normale Datei (Verknüpfungen sind nicht erlaubt)'
          : 'module.json ist kein gültiges JSON';
      ergebnis.push({ id: ID_MUSTER.test(eintrag.name) ? eintrag.name : `ungueltig-${ergebnis.length}`, name: eintrag.name, ordner, fehler: text });
      continue;
    }
    const geprueft = pruefeModul(roh, eintrag.name, ordner);
    ergebnis.push(geprueft.modul ?? { id: ID_MUSTER.test(eintrag.name) ? eintrag.name : `ungueltig-${ergebnis.length}`, name: eintrag.name, ordner, fehler: geprueft.fehler });
  }
  return ergebnis;
}
