import { normalisiereErgebnis } from './ausfuehrung.js';

// Reine Berechnungen für die Anzeige der Module (ohne Dateizugriff, gut testbar).

const MINUTE = 60_000;
const istZeit = (w) => typeof w === 'string' && w.length <= 40 && Number.isFinite(Date.parse(w));

// Liest den Inhalt einer status.json eines eigenständigen Moduls.
// Pflicht: status und zeit (Ende des Laufs). Liefert { eintrag } oder { fehler }.
export function leseStatus(text) {
  let roh;
  try { roh = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return { fehler: 'status.json ist kein gültiges JSON' }; }
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return { fehler: 'status.json muss ein JSON-Objekt sein' };
  if (!['ok', 'warnung', 'fehler'].includes(roh.status)) return { fehler: 'status muss ok, warnung oder fehler sein' };
  if (!istZeit(roh.zeit)) return { fehler: 'zeit fehlt oder ist kein gültiger Zeitpunkt (ISO 8601)' };
  const ende = new Date(roh.zeit).toISOString();
  const eintrag = {
    ...normalisiereErgebnis(roh),
    beginn: istZeit(roh.beginn) ? new Date(roh.beginn).toISOString() : ende,
    ende,
    dauerMs: Number.isFinite(roh.dauer_ms) && roh.dauer_ms >= 0 ? Math.round(roh.dauer_ms) : null,
  };
  if (istZeit(roh.naechster_lauf)) eintrag.naechsterLauf = new Date(roh.naechster_lauf).toISOString();
  if (typeof roh.version === 'string' && roh.version.trim() && roh.version.length <= 40) eintrag.version = roh.version.trim();
  return { eintrag };
}

// Rangfolge für die Sortierung: Probleme zuerst.
export const SCHWERE = { modulfehler: 0, fehler: 1, 'keine-meldung': 2, warnung: 3, unbekannt: 4, laeuft: 5, ok: 6, inaktiv: 7 };

const zeitpunkt = (e) => Date.parse(e.beginn ?? e.ende);

function verfuegbarkeit(verlauf, jetzt, fensterMs) {
  const ab = jetzt - fensterMs;
  const im = verlauf.filter((e) => zeitpunkt(e) >= ab);
  if (!im.length) return null;
  const ok = im.filter((e) => e.status === 'ok').length;
  const aeltester = zeitpunkt(verlauf[verlauf.length - 1]);
  return {
    prozent: Math.round((ok / im.length) * 1000) / 10,
    laeufe: im.length,
    // Verlauf reicht nicht über das ganze Fenster zurück (neues Modul oder Verlauf gekürzt).
    unvollstaendig: aeltester > ab && verlauf.length === im.length,
  };
}

// Berechnet alles, was die Oberfläche zu einem Modul zeigt.
// verlauf: neueste zuerst. erkanntSeit: seit wann die Basis das Modul kennt (für „keine Meldung“ ohne jede Meldung).
export function berechneAnsicht(modul, { verlauf = [], aktiv = modul.aktiv, laeuft = false, geplant = null, erkanntSeit = null, statusFehler = null, jetzt = Date.now() } = {}) {
  const eigenstaendig = modul.typ === 'eigenstaendig';
  const letztes = verlauf[0] ?? null;
  const intervallMs = modul.intervallMinuten ? modul.intervallMinuten * MINUTE : null;

  let naechsterLauf = null;
  if (eigenstaendig) {
    if (letztes?.naechsterLauf) naechsterLauf = letztes.naechsterLauf;
    else if (letztes && intervallMs) naechsterLauf = new Date(Date.parse(letztes.ende ?? letztes.beginn) + intervallMs).toISOString();
  } else {
    naechsterLauf = geplant;
  }

  // „Keine Meldung“: Ein eigenständiges Modul hätte sich längst melden müssen.
  let ueberfaelligSeit = null;
  if (eigenstaendig && aktiv && !modul.fehler) {
    const toleranz = (modul.toleranzMinuten ?? 10) * MINUTE;
    const frist = naechsterLauf ? Date.parse(naechsterLauf) + toleranz
      : !letztes && intervallMs && erkanntSeit ? Date.parse(erkanntSeit) + intervallMs + toleranz
        : null;
    if (frist !== null && jetzt > frist) ueberfaelligSeit = new Date(frist).toISOString();
  }

  let anzeige;
  if (modul.fehler) anzeige = 'modulfehler';
  else if (!aktiv) anzeige = 'inaktiv';
  else if (laeuft) anzeige = 'laeuft';
  else if (ueberfaelligSeit) anzeige = 'keine-meldung';
  else anzeige = letztes?.status ?? 'unbekannt';

  // Seit wann besteht das aktuelle Problem? (zusammenhängende Läufe ohne „ok“)
  let problemSeit = null;
  let problemLaeufe = 0;
  if (letztes && letztes.status !== 'ok') {
    for (const e of verlauf) {
      if (e.status === 'ok') break;
      problemLaeufe++;
      problemSeit = e.beginn ?? e.ende;
    }
  }

  return {
    id: modul.id,
    name: modul.name,
    beschreibung: modul.beschreibung ?? '',
    betriebsart: eigenstaendig ? 'eigenstaendig' : 'basis',
    typ: modul.typ ?? null,
    version: modul.version ?? letztes?.version ?? null,
    aktiv,
    intervallMinuten: modul.intervallMinuten ?? null,
    fehler: modul.fehler ?? null,
    statusFehler,
    anzeige,
    schwere: SCHWERE[anzeige] ?? 4,
    laeuft,
    letztes,
    naechsterLauf,
    ueberfaelligSeit,
    problemSeit,
    problemLaeufe,
    verfuegbarkeit: { h24: verfuegbarkeit(verlauf, jetzt, 24 * 60 * MINUTE), d7: verfuegbarkeit(verlauf, jetzt, 7 * 24 * 60 * MINUTE) },
    verlaufKurz: verlauf.slice(0, 30).reverse().map((e) => ({ status: e.status, zeit: e.beginn ?? e.ende })),
    hatEinstellungen: (modul.felder?.length ?? 0) > 0,
    kannPruefen: !modul.fehler && !eigenstaendig,
  };
}
