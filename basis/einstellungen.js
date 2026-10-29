import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Einstellungen eines Moduls: Das Modul beschreibt die Felder in module.json („einstellungsfelder“),
// die Basis baut daraus ein Formular und schreibt die Werte nach <Modulordner>/einstellungen.json.
// Das Modul liest diese Datei bei jedem Lauf. Die Basis braucht das Modul dafür nicht.

export const DATEI = 'einstellungen.json';
const TYPEN = ['text', 'zahl', 'schalter', 'auswahl', 'passwort'];
const SCHLUESSEL = /^[a-z][a-z0-9_]{0,63}$/;
const istText = (w) => typeof w === 'string' && w.trim() !== '';
const MAX_TEXT = 2000;

// Prüft die Feldliste aus module.json. Liefert { felder } oder { fehler }.
export function pruefeFelder(roh) {
  if (roh === undefined) return { felder: [] };
  if (!Array.isArray(roh) || roh.length > 50) return { fehler: 'einstellungsfelder muss eine Liste (höchstens 50 Felder) sein' };
  const felder = [];
  const gesehen = new Set();
  for (const [i, f] of roh.entries()) {
    const wo = `einstellungsfelder[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { fehler: `${wo} muss ein Objekt sein` };
    if (!SCHLUESSEL.test(f.schluessel ?? '')) return { fehler: `${wo}.schluessel: nur Kleinbuchstaben, Ziffern und _ (beginnt mit Buchstabe)` };
    if (gesehen.has(f.schluessel)) return { fehler: `${wo}.schluessel „${f.schluessel}“ kommt doppelt vor` };
    gesehen.add(f.schluessel);
    if (!TYPEN.includes(f.typ)) return { fehler: `${wo}.typ muss ${TYPEN.join(', ')} sein` };
    if (!istText(f.bezeichnung) || f.bezeichnung.length > 100) return { fehler: `${wo}.bezeichnung fehlt oder ist zu lang` };
    if (f.beschreibung !== undefined && (typeof f.beschreibung !== 'string' || f.beschreibung.length > 500)) return { fehler: `${wo}.beschreibung ist ungültig` };
    if (f.pflicht !== undefined && typeof f.pflicht !== 'boolean') return { fehler: `${wo}.pflicht muss true oder false sein` };
    const feld = { schluessel: f.schluessel, typ: f.typ, bezeichnung: f.bezeichnung, beschreibung: f.beschreibung ?? '', pflicht: f.pflicht === true };
    if (f.typ === 'zahl') {
      for (const g of ['min', 'max']) if (f[g] !== undefined && (typeof f[g] !== 'number' || !Number.isFinite(f[g]))) return { fehler: `${wo}.${g} muss eine Zahl sein` };
      if (f.ganzzahl !== undefined && typeof f.ganzzahl !== 'boolean') return { fehler: `${wo}.ganzzahl muss true oder false sein` };
      Object.assign(feld, { min: f.min ?? null, max: f.max ?? null, ganzzahl: f.ganzzahl === true });
    }
    if (f.typ === 'auswahl') {
      if (!Array.isArray(f.optionen) || !f.optionen.length) return { fehler: `${wo}.optionen fehlt` };
      const optionen = f.optionen.map((o) => (typeof o === 'string' ? { wert: o, text: o } : o));
      if (optionen.some((o) => !o || !istText(o.wert) || !istText(o.text ?? o.wert))) return { fehler: `${wo}.optionen ist ungültig` };
      feld.optionen = optionen.map((o) => ({ wert: o.wert, text: o.text ?? o.wert }));
    }
    if (f.standard !== undefined) {
      if (f.typ === 'passwort') return { fehler: `${wo}: Passwortfelder haben keinen Standardwert` };
      const geprueft = pruefeWert(feld, f.standard);
      if (geprueft.fehler) return { fehler: `${wo}.standard: ${geprueft.fehler}` };
      feld.standard = geprueft.wert;
    }
    felder.push(feld);
  }
  return { felder };
}

// Prüft einen einzelnen Wert gegen sein Feld. null/'' bedeutet „leer“.
export function pruefeWert(feld, wert) {
  if (wert === null || wert === undefined || wert === '') return { wert: null };
  switch (feld.typ) {
    case 'text':
    case 'passwort':
      if (typeof wert !== 'string' || wert.length > MAX_TEXT || /[\0]/.test(wert)) return { fehler: 'ungültiger Text' };
      return { wert: feld.typ === 'text' ? wert.trim() : wert };
    case 'zahl': {
      const z = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() !== '' ? Number(wert.replace(',', '.')) : NaN;
      if (!Number.isFinite(z)) return { fehler: 'keine gültige Zahl' };
      if (feld.ganzzahl && !Number.isInteger(z)) return { fehler: 'muss eine ganze Zahl sein' };
      if (feld.min !== null && feld.min !== undefined && z < feld.min) return { fehler: `mindestens ${feld.min}` };
      if (feld.max !== null && feld.max !== undefined && z > feld.max) return { fehler: `höchstens ${feld.max}` };
      return { wert: z };
    }
    case 'schalter':
      if (typeof wert !== 'boolean') return { fehler: 'muss ja oder nein sein' };
      return { wert };
    case 'auswahl':
      if (!feld.optionen.some((o) => o.wert === wert)) return { fehler: 'keine erlaubte Auswahl' };
      return { wert };
    default:
      return { fehler: 'unbekannter Typ' };
  }
}

export async function leseDatei(modulOrdner) {
  try {
    const roh = JSON.parse((await readFile(path.join(modulOrdner, DATEI), 'utf8')).replace(/^﻿/, ''));
    return roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  } catch {
    return {};
  }
}

// Wirksame Werte: Vorgaben aus module.json („einstellungen“), Standardwerte der Felder, gespeicherte Werte.
export async function wirksameWerte(modul) {
  const werte = { ...(modul.einstellungen ?? {}) };
  for (const f of modul.felder ?? []) if (f.standard !== undefined) werte[f.schluessel] = f.standard;
  return { ...werte, ...(await leseDatei(modul.ordner)) };
}

// Werte für die Oberfläche: Passwörter werden nie herausgegeben, nur ob sie gesetzt sind.
export async function ansicht(modul) {
  const werte = await wirksameWerte(modul);
  return {
    felder: modul.felder ?? [],
    werte: Object.fromEntries((modul.felder ?? []).map((f) => [f.schluessel,
      f.typ === 'passwort' ? { gesetzt: istText(werte[f.schluessel]) } : (werte[f.schluessel] ?? null)])),
  };
}

// Prüft eine Eingabe aus dem Formular und speichert sie. Leere Passwortfelder bleiben unverändert.
// Liefert { geaendert: [Schlüssel] } oder { feldfehler: { schluessel: Meldung } }.
export async function speichern(modul, eingabe) {
  if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) return { feldfehler: { _: 'Ungültige Eingabe.' } };
  const felder = modul.felder ?? [];
  const unbekannt = Object.keys(eingabe).filter((k) => !felder.some((f) => f.schluessel === k));
  if (unbekannt.length) return { feldfehler: { _: `Unbekannte Felder: ${unbekannt.join(', ')}` } };
  const bisher = await leseDatei(modul.ordner);
  const vorher = await wirksameWerte(modul);
  const neu = { ...bisher };
  const feldfehler = {};
  for (const f of felder) {
    if (!(f.schluessel in eingabe)) continue;
    if (f.typ === 'passwort' && (eingabe[f.schluessel] === '' || eingabe[f.schluessel] === null)) continue;
    const { wert, fehler } = pruefeWert(f, eingabe[f.schluessel]);
    if (fehler) { feldfehler[f.schluessel] = fehler; continue; }
    if (wert === null) delete neu[f.schluessel]; else neu[f.schluessel] = wert;
  }
  for (const f of felder) {
    const wert = f.schluessel in neu ? neu[f.schluessel] : f.standard ?? modul.einstellungen?.[f.schluessel];
    if (f.pflicht && !feldfehler[f.schluessel] && (wert === undefined || wert === null || wert === '')) feldfehler[f.schluessel] = 'Pflichtfeld';
  }
  if (Object.keys(feldfehler).length) return { feldfehler };
  if (JSON.stringify(neu) !== JSON.stringify(bisher)) await schreibeAtomar(path.join(modul.ordner, DATEI), neu);
  // Als geändert gilt, was nach dem Speichern tatsächlich anders wirkt als vorher.
  const nachher = await wirksameWerte(modul);
  return { geaendert: felder.map((f) => f.schluessel).filter((k) => JSON.stringify(nachher[k]) !== JSON.stringify(vorher[k])) };
}

export async function schreibeAtomar(datei, wert) {
  const temp = `${datei}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(wert, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, datei);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

// Alle gesetzten Passwörter eines Moduls (für den Geheimnisfilter des Protokolls).
export async function passwoerter(modul) {
  const werte = await leseDatei(modul.ordner);
  return (modul.felder ?? []).filter((f) => f.typ === 'passwort').map((f) => werte[f.schluessel]).filter(istText);
}
