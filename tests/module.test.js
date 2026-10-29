import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ansicht, pruefeFelder, pruefeWert, speichern, wirksameWerte } from '../basis/einstellungen.js';
import { berechneAnsicht, leseStatus } from '../basis/modulansicht.js';
import { Modulverwaltung } from '../basis/modulverwaltung.js';
import { Ergebnisspeicher } from '../basis/speicher.js';
import { Planer } from '../basis/planer.js';
import { pruefeModul } from '../basis/module.js';
import { fuehreAus } from '../basis/ausfuehrung.js';
import { DienstFehler } from '../basis/dienste.js';

const FELDER = [
  { schluessel: 'server', bezeichnung: 'FTP-Server', typ: 'text', pflicht: true },
  { schluessel: 'passwort', bezeichnung: 'Passwort', typ: 'passwort' },
  { schluessel: 'max_alter', bezeichnung: 'Max. Alter (h)', typ: 'zahl', min: 1, max: 48, standard: 2 },
  { schluessel: 'tls', bezeichnung: 'TLS', typ: 'auswahl', optionen: ['required', { wert: 'disabled', text: 'Aus' }], standard: 'required' },
  { schluessel: 'aktiv', bezeichnung: 'Prüfung aktiv', typ: 'schalter', standard: true },
];

const temp = () => mkdtemp(path.join(tmpdir(), 'mb-mod-'));
const schreibeJson = (datei, wert) => writeFile(datei, typeof wert === 'string' ? wert : JSON.stringify(wert));

test('Einstellungsfelder: gültige Beschreibung und verständliche Fehler', () => {
  const { felder } = pruefeFelder(FELDER);
  assert.equal(felder.length, 5);
  assert.deepEqual(felder[3].optionen, [{ wert: 'required', text: 'required' }, { wert: 'disabled', text: 'Aus' }]);
  assert.match(pruefeFelder([{ schluessel: 'A', bezeichnung: 'x', typ: 'text' }]).fehler, /schluessel/);
  assert.match(pruefeFelder([{ schluessel: 'a', bezeichnung: 'x', typ: 'farbe' }]).fehler, /typ/);
  assert.match(pruefeFelder([{ schluessel: 'a', bezeichnung: 'x', typ: 'text' }, { schluessel: 'a', bezeichnung: 'y', typ: 'text' }]).fehler, /doppelt/);
  assert.match(pruefeFelder([{ schluessel: 'a', bezeichnung: 'x', typ: 'zahl', max: 5, standard: 9 }]).fehler, /standard: höchstens 5/);
  assert.match(pruefeFelder([{ schluessel: 'a', bezeichnung: 'x', typ: 'passwort', standard: 'geheim' }]).fehler, /Standardwert/);
  assert.match(pruefeFelder({}).fehler, /Liste/);
});

test('Einstellungswerte: Zahl, Auswahl, Schalter, Text', () => {
  const zahl = { typ: 'zahl', min: 1, max: 10, ganzzahl: true };
  assert.deepEqual(pruefeWert(zahl, '7'), { wert: 7 });
  assert.deepEqual(pruefeWert(zahl, ''), { wert: null });
  assert.match(pruefeWert(zahl, '2,5').fehler, /ganze Zahl/);
  assert.match(pruefeWert(zahl, 11).fehler, /höchstens 10/);
  assert.match(pruefeWert(zahl, 'abc').fehler, /Zahl/);
  assert.match(pruefeWert({ typ: 'auswahl', optionen: [{ wert: 'a' }] }, 'b').fehler, /Auswahl/);
  assert.match(pruefeWert({ typ: 'schalter' }, 'ja').fehler, /ja oder nein/);
  assert.deepEqual(pruefeWert({ typ: 'text' }, '  ftp.firma.de '), { wert: 'ftp.firma.de' });
});

test('Einstellungen speichern: Pflichtfelder, Passwort bleibt verborgen und unverändert, unbekannte Felder', async () => {
  const ordner = await temp();
  try {
    const modul = { ordner, felder: pruefeFelder(FELDER).felder, einstellungen: { ordner_ftp: 'files' } };
    assert.deepEqual((await speichern(modul, { max_alter: 3 })).feldfehler, { server: 'Pflichtfeld' });
    assert.deepEqual((await speichern(modul, { server: 'ftp.firma.de', max_alter: 99 })).feldfehler, { max_alter: 'höchstens 48' });
    assert.match((await speichern(modul, { quatsch: 1 })).feldfehler._, /Unbekannte Felder: quatsch/);

    assert.deepEqual(await speichern(modul, { server: 'ftp.firma.de', passwort: 'Sehr-Geheim-1', max_alter: 4 }), { geaendert: ['server', 'passwort', 'max_alter'] });
    const sicht = await ansicht(modul);
    assert.deepEqual(sicht.werte, { server: 'ftp.firma.de', passwort: { gesetzt: true }, max_alter: 4, tls: 'required', aktiv: true });
    assert.doesNotMatch(JSON.stringify(sicht), /Sehr-Geheim-1/);

    // Leeres Passwortfeld = unverändert; gleiche Werte = keine Änderung.
    assert.deepEqual(await speichern(modul, { server: 'ftp.firma.de', passwort: '', max_alter: 4 }), { geaendert: [] });
    assert.deepEqual(await speichern(modul, { max_alter: '' }), { geaendert: ['max_alter'] }, 'zurück auf Standard');
    const werte = await wirksameWerte(modul);
    assert.deepEqual(werte, { ordner_ftp: 'files', server: 'ftp.firma.de', passwort: 'Sehr-Geheim-1', max_alter: 2, tls: 'required', aktiv: true });
    assert.deepEqual(JSON.parse(await readFile(path.join(ordner, 'einstellungen.json'), 'utf8')), { server: 'ftp.firma.de', passwort: 'Sehr-Geheim-1' });
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});

test('module.json: eigenständiges Modul mit Feldern, Version und Repo', () => {
  const { modul } = pruefeModul({ id: 'ftp', name: 'FTP', typ: 'eigenstaendig', intervall_minuten: 5, version: '1.0.0', repo: 'pfkonsumdigital/Monitoring-Modul-FTP', einstellungsfelder: FELDER }, 'ftp', '/m/ftp');
  assert.equal(modul.typ, 'eigenstaendig');
  assert.equal(modul.felder.length, 5);
  assert.equal(modul.toleranzMinuten, 10);
  assert.match(pruefeModul({ id: 'ftp', name: 'FTP', typ: 'eigenstaendig', repo: 'kaputt' }, 'ftp', '/m').fehler, /repo/);
  assert.match(pruefeModul({ id: 'ftp', name: 'FTP', typ: 'eigenstaendig', einstellungsfelder: [{}] }, 'ftp', '/m').fehler, /einstellungsfelder\[0\]/);
  assert.match(pruefeModul({ id: 'ftp', name: 'FTP', typ: 'dienst' }, 'ftp', '/m').fehler, /eigenstaendig/);
});

test('status.json: gültig, ungültig, halb geschrieben', () => {
  const { eintrag } = leseStatus(JSON.stringify({ status: 'warnung', zusammenfassung: '2 Dateien veraltet', details: ['a.csv'], messwerte: { veraltet: 2, x: 'nein' }, zeit: '2026-10-29T10:05:00Z', beginn: '2026-10-29T10:04:58Z', dauer_ms: 2000, naechster_lauf: '2026-10-29T10:10:00Z', version: '1.0.0' }));
  assert.deepEqual(eintrag, { status: 'warnung', zusammenfassung: '2 Dateien veraltet', details: ['a.csv'], messwerte: { veraltet: 2 }, beginn: '2026-10-29T10:04:58.000Z', ende: '2026-10-29T10:05:00.000Z', dauerMs: 2000, naechsterLauf: '2026-10-29T10:10:00.000Z', version: '1.0.0' });
  assert.match(leseStatus('{"status":"ok","zei').fehler, /kein gültiges JSON/);
  assert.match(leseStatus('{"status":"gut","zeit":"2026-10-29T10:00:00Z"}').fehler, /status/);
  assert.match(leseStatus('{"status":"ok"}').fehler, /zeit/);
  assert.equal(leseStatus('﻿{"status":"ok","zeit":"2026-10-29T10:00:00Z"}').eintrag.dauerMs, null);
});

test('Anzeige: keine Meldung, Problem seit, Verfügbarkeit, Pause', () => {
  const jetzt = Date.parse('2026-10-29T12:00:00Z');
  const modul = { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', aktiv: true, intervallMinuten: 5, toleranzMinuten: 10, felder: [{}] };
  const e = (min, status) => ({ status, zusammenfassung: status, beginn: new Date(jetzt - min * 60_000).toISOString(), ende: new Date(jetzt - min * 60_000).toISOString() });

  // Letzte Meldung vor 3 min → ok, nächster Lauf aus Intervall.
  let a = berechneAnsicht(modul, { verlauf: [e(3, 'ok')], jetzt });
  assert.equal(a.anzeige, 'ok');
  assert.equal(a.naechsterLauf, new Date(jetzt + 2 * 60_000).toISOString());
  assert.equal(a.kannPruefen, false);
  assert.equal(a.hatEinstellungen, true);

  // Letzte Meldung vor 16 min (5 + 10 Toleranz überschritten) → keine Meldung.
  a = berechneAnsicht(modul, { verlauf: [e(16, 'ok')], jetzt });
  assert.equal(a.anzeige, 'keine-meldung');
  assert.equal(a.ueberfaelligSeit, new Date(jetzt - 60_000).toISOString());
  // Pausiert → keine Überwachung.
  assert.equal(berechneAnsicht(modul, { verlauf: [e(16, 'ok')], aktiv: false, jetzt }).anzeige, 'inaktiv');
  // Modul meldet selbst den nächsten Lauf (z. B. stündlich) → keine falsche Warnung.
  assert.equal(berechneAnsicht(modul, { verlauf: [{ ...e(16, 'ok'), naechsterLauf: new Date(jetzt + 30 * 60_000).toISOString() }], jetzt }).anzeige, 'ok');
  // Noch nie gemeldet: ab Erkennung + Intervall + Toleranz.
  assert.equal(berechneAnsicht(modul, { erkanntSeit: new Date(jetzt - 10 * 60_000).toISOString(), jetzt }).anzeige, 'unbekannt');
  assert.equal(berechneAnsicht(modul, { erkanntSeit: new Date(jetzt - 20 * 60_000).toISOString(), jetzt }).anzeige, 'keine-meldung');

  // Problem seit: zusammenhängende Läufe ohne ok.
  a = berechneAnsicht(modul, { verlauf: [e(1, 'fehler'), e(6, 'warnung'), e(11, 'fehler'), e(16, 'ok'), e(21, 'ok')], jetzt });
  assert.equal(a.anzeige, 'fehler');
  assert.equal(a.problemLaeufe, 3);
  assert.equal(a.problemSeit, e(11, 'x').beginn);
  assert.equal(a.verfuegbarkeit.h24.prozent, 40);
  assert.equal(a.verfuegbarkeit.h24.laeufe, 5);
  assert.equal(a.verfuegbarkeit.h24.unvollstaendig, true);
  assert.deepEqual(a.verlaufKurz.map((v) => v.status), ['ok', 'ok', 'fehler', 'warnung', 'fehler']);

  // Von der Basis gestartete Module: nächster Lauf aus dem Planer, nie „keine Meldung“.
  a = berechneAnsicht({ ...modul, typ: 'plugin' }, { verlauf: [e(600, 'ok')], geplant: 'x', jetzt });
  assert.equal(a.anzeige, 'ok');
  assert.equal(a.naechsterLauf, 'x');
  assert.equal(a.kannPruefen, true);
  assert.equal(berechneAnsicht({ id: 'k', name: 'k', fehler: 'kaputt' }, { jetzt }).anzeige, 'modulfehler');
});

async function aufbau(dateien = {}) {
  const wurzel = await temp();
  const moduleOrdner = path.join(wurzel, 'modules');
  for (const [datei, inhalt] of Object.entries(dateien)) {
    await mkdir(path.dirname(path.join(moduleOrdner, datei)), { recursive: true });
    await schreibeJson(path.join(moduleOrdner, datei), inhalt);
  }
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', `${q}: ${m}`]), fehler: (q, m) => meldungen.push(['fehler', `${q}: ${m}`]) });
  const speicher = new Ergebnisspeicher(path.join(wurzel, 'data'), 100);
  const uebernommen = [];
  const uebernehmen = async (id, e) => { uebernommen.push([id, e.status]); await speicher.hinzufuegen(id, e); };
  const planer = new Planer({ ausfuehren: async () => ({ status: 'ok', zusammenfassung: 'x' }), speichern: uebernehmen });
  const geheimnisse = [];
  let uhr = Date.parse('2026-10-29T12:00:00Z');
  const neu = (extra = {}) => new Modulverwaltung({ moduleOrdner, datenOrdner: path.join(wurzel, 'data'), speicher, planer, uebernehmen, geheimnisse, log, jetzt: () => uhr, intervallMs: 60_000, ...extra });
  return { wurzel, moduleOrdner, meldungen, speicher, planer, uebernommen, geheimnisse, neu, uhr: (t) => { uhr = Date.parse(t); } };
}

test('Modulverwaltung: status.json übernehmen, nicht doppelt, ungültige Datei erst nach Fehlversuchen melden', async () => {
  const u = await aufbau({ 'ftp/module.json': { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', intervall_minuten: 5 } });
  try {
    const v = u.neu();
    await v.start();
    v.stop();
    assert.equal(v.ansichten()[0].anzeige, 'unbekannt');
    const status = path.join(u.moduleOrdner, 'ftp', 'status.json');
    await schreibeJson(status, { status: 'fehler', zusammenfassung: 'Login fehlgeschlagen', zeit: '2026-10-29T11:59:00Z' });
    await v.statusLesen();
    await v.statusLesen();
    assert.deepEqual(u.uebernommen, [['ftp', 'fehler']], 'gleiche Meldung nur einmal');
    assert.equal(v.ansichten()[0].anzeige, 'fehler');

    await schreibeJson(status, '{"status":"ok","ze');
    for (let i = 0; i < 3; i++) await v.statusLesen();
    assert.equal(v.ansichten()[0].statusFehler, null, 'halb geschrieben: noch nicht melden');
    await v.statusLesen();
    await v.statusLesen();
    assert.match(v.ansichten()[0].statusFehler, /kein gültiges JSON/);
    assert.equal(u.meldungen.filter(([s]) => s === 'warnung').length, 1, 'nur einmal gemeldet');

    await schreibeJson(status, { status: 'ok', zusammenfassung: 'alles aktuell', zeit: '2026-10-29T12:04:00Z' });
    await v.statusLesen();
    assert.equal(v.ansichten()[0].statusFehler, null);
    assert.deepEqual(u.uebernommen.at(-1), ['ftp', 'ok']);

    // Nach einem Neustart der Basis wird dieselbe Meldung nicht erneut übernommen.
    const v2 = u.neu();
    await v2.start();
    v2.stop();
    assert.equal(u.uebernommen.length, 2);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modulverwaltung: Module kommen und gehen ohne Neustart; ein kaputtes Modul stört die anderen nicht', async () => {
  const u = await aufbau({ 'a/module.json': { id: 'a', name: 'A', typ: 'eigenstaendig' } });
  try {
    const v = u.neu();
    await v.start();
    v.stop();
    assert.deepEqual(v.ansichten().map((m) => m.id), ['a']);
    await mkdir(path.join(u.moduleOrdner, 'b'));
    await schreibeJson(path.join(u.moduleOrdner, 'b', 'module.json'), { id: 'b', name: 'B', typ: 'plugin', einstieg: 'x.js', intervall_minuten: 5 });
    await schreibeJson(path.join(u.moduleOrdner, 'a', 'module.json'), '{ kaputt');
    await v.einlesen();
    const ansichten = v.ansichten();
    assert.deepEqual(ansichten.map((m) => [m.id, m.anzeige]), [['a', 'modulfehler'], ['b', 'unbekannt']]);
    assert.deepEqual(u.planer.module.map((m) => m.id), ['b'], 'nur von der Basis gestartete Module werden geplant');
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /Modul a/.test(m)));
    await rm(path.join(u.moduleOrdner, 'b'), { recursive: true });
    await v.einlesen();
    assert.deepEqual(v.ansichten().map((m) => m.id), ['a']);
    assert.deepEqual(u.planer.module, []);
    assert.ok(u.meldungen.some(([, m]) => m === 'Modul b wurde entfernt.'));
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modulverwaltung: Pause bleibt nach Neustart erhalten; Einstellungen werden protokolliert und Passwörter gefiltert', async () => {
  const u = await aufbau({ 'ftp/module.json': { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', intervall_minuten: 5, einstellungsfelder: FELDER } });
  try {
    const v = u.neu();
    await v.start();
    v.stop();
    assert.equal(await v.setzeAktiv('ftp', false, 'patrick'), true);
    assert.equal(v.ansichten()[0].anzeige, 'inaktiv');
    const v2 = u.neu();
    await v2.start();
    v2.stop();
    assert.equal(v2.ansichten()[0].aktiv, false);

    assert.deepEqual((await v2.einstellungenAendern('ftp', { server: '' }, 'patrick')).feldfehler, { server: 'Pflichtfeld' });
    assert.deepEqual((await v2.einstellungenAendern('ftp', { server: 'ftp.firma.de', passwort: 'Sehr-Geheim-1' }, 'patrick')).geaendert, ['server', 'passwort']);
    assert.ok(u.meldungen.some(([, m]) => m === 'Einstellungen von Modul ftp geändert durch patrick: FTP-Server, Passwort.'));
    assert.ok(u.geheimnisse.includes('Sehr-Geheim-1'));
    assert.equal((await v2.einstellungen('ftp')).werte.passwort.gesetzt, true);
    assert.equal(await v2.einstellungen('gibtsnicht'), null);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Von der Basis gestartete Module bekommen die gespeicherten Einstellungen', async () => {
  const u = await aufbau({
    'p/module.json': { id: 'p', name: 'P', typ: 'plugin', einstieg: 'index.js', einstellungen: { vorgabe: 1 }, einstellungsfelder: [{ schluessel: 'grenze', bezeichnung: 'Grenze', typ: 'zahl', standard: 5 }] },
    'p/index.js': 'export async function pruefen({ einstellungen }) { return { status: "ok", zusammenfassung: JSON.stringify(einstellungen) }; }',
    'p/einstellungen.json': { grenze: 7 },
  });
  try {
    const v = u.neu();
    await v.start();
    v.stop();
    const [modul] = v.planbar();
    const ergebnis = await fuehreAus(modul);
    assert.deepEqual(JSON.parse(ergebnis.zusammenfassung), { vorgabe: 1, grenze: 7 });
    assert.equal(v.jetztPruefen('p'), 'gestartet');
    assert.equal(v.jetztPruefen('p'), 'laeuft');
    assert.equal(v.jetztPruefen('x'), 'unbekannt');
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Planer: neue, geänderte und entfernte Module zur Laufzeit', async () => {
  const geplant = [];
  const planer = new Planer({ ausfuehren: async () => ({ status: 'ok', zusammenfassung: '' }), speichern: async () => {} });
  planer.planen = (m, ms) => geplant.push([m.id, ms]);
  planer.setzeModule([{ id: 'a', typ: 'plugin', aktiv: true, intervallMinuten: 5 }]);
  assert.deepEqual(geplant, [], 'vor start() wird nichts geplant');
  planer.start(0);
  assert.deepEqual(geplant, [['a', 0]]);
  planer.setzeModule([{ id: 'a', typ: 'plugin', aktiv: true, intervallMinuten: 5 }, { id: 'b', typ: 'programm', aktiv: true, intervallMinuten: 1 }, { id: 'c', typ: 'eigenstaendig', intervallMinuten: 1 }]);
  assert.deepEqual(geplant.slice(1), [['b', 0]], 'nur das neue Modul, eigenständige nie');
  planer.setzeModule([{ id: 'a', typ: 'plugin', aktiv: true, intervallMinuten: 10 }]);
  assert.deepEqual(geplant.slice(2), [['a', 0]], 'geändertes Intervall wird neu geplant');
  assert.equal(planer.naechster('b'), null, 'entferntes Modul abgemeldet');
  planer.stop();
});

test('Einstellungen: Formular mit allen Feldern meldet nur echte Änderungen', async () => {
  const ordner = await temp();
  try {
    const modul = { ordner, felder: pruefeFelder(FELDER).felder };
    // Das Formular schickt immer alle Felder, auch unveränderte Standardwerte.
    assert.deepEqual(await speichern(modul, { server: 'a', passwort: '', max_alter: 2, tls: 'required', aktiv: true }), { geaendert: ['server'] });
    assert.deepEqual(await speichern(modul, { server: 'a', passwort: '', max_alter: '3', tls: 'required', aktiv: true }), { geaendert: ['max_alter'] });
    assert.deepEqual(await speichern(modul, { server: 'a', passwort: 'Neu-Geheim-12', max_alter: 3, tls: 'disabled', aktiv: false }), { geaendert: ['passwort', 'tls', 'aktiv'] });
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});

test('Modulverwaltung: nach jedem Takt werden die Ansichten weitergereicht (Benachrichtigung)', async () => {
  const u = await aufbau({ 'ftp/module.json': { id: 'ftp', name: 'FTP', typ: 'eigenstaendig' } });
  try {
    const erhalten = [];
    const v = u.neu();
    v.nachTakt = async (ansichten) => { erhalten.push(ansichten.map((m) => m.id)); };
    await v.takt();
    assert.deepEqual(erhalten, [['ftp']]);
    v.nachTakt = async () => { throw new Error('Mail kaputt'); };
    await v.takt();
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /Mail kaputt/.test(m)), 'Fehler stoppt die Basis nicht');
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('module.json: dienst und befehlsdatei nur bei eigenständigen Modulen, Dienstname geprüft', () => {
  const basis = { id: 'ftp', name: 'FTP', typ: 'eigenstaendig' };
  const { modul } = pruefeModul({ ...basis, dienst: 'MonitoringFTP', befehlsdatei: true }, 'ftp', '/m/ftp');
  assert.equal(modul.dienst, 'MonitoringFTP');
  assert.equal(modul.befehlsdatei, true);
  assert.equal(pruefeModul(basis, 'ftp', '/m/ftp').modul.dienst, null);
  assert.match(pruefeModul({ ...basis, dienst: 'net stop x & calc' }, 'ftp', '/m/ftp').fehler, /dienst muss/);
  assert.match(pruefeModul({ ...basis, befehlsdatei: 'ja' }, 'ftp', '/m/ftp').fehler, /befehlsdatei muss/);
  assert.match(pruefeModul({ id: 'p', name: 'P', typ: 'programm', befehl: 'x.exe', dienst: 'X' }, 'p', '/m/p').fehler, /nur bei typ "eigenstaendig"/);
});

// Simulierte Windows-Dienste für die Modulverwaltung.
function dienste(start = {}) {
  const stand = { ...start };
  const aufrufe = [];
  return {
    aufrufe, stand,
    async zustand(name) { return stand[name] ? { zustand: stand[name] } : { zustand: 'fehlt', fehler: `Der Dienst „${name}“ ist auf diesem Rechner nicht installiert.` }; },
    async beenden(name) { aufrufe.push(['beenden', name]); if (name === 'Gesperrt') throw new DienstFehler('Keine Berechtigung.', 5); stand[name] = 'gestoppt'; },
    async starten(name) { aufrufe.push(['starten', name]); stand[name] = 'laeuft'; },
  };
}

test('Module beenden: Windows-Dienst stoppen, kein Alarm bis zur nächsten Meldung, Starten', async () => {
  const u = await aufbau({ 'ftp/module.json': { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', intervall_minuten: 5, dienst: 'MonitoringFTP' } });
  try {
    const d = dienste({ MonitoringFTP: 'laeuft' });
    const v = u.neu({ dienste: d });
    await v.start();
    v.stop();
    const status = path.join(u.moduleOrdner, 'ftp', 'status.json');
    await schreibeJson(status, { status: 'ok', zeit: '2026-10-29T11:58:00Z' });
    await v.statusLesen();
    let a = v.ansichten()[0];
    assert.deepEqual([a.anzeige, a.dienst, a.kannBeenden, a.kannStarten], ['ok', { name: 'MonitoringFTP', zustand: 'laeuft', fehler: null }, true, false]);

    // Dienst fällt aus, ohne dass jemand ihn über die Basis beendet hat → Problem.
    d.stand.MonitoringFTP = 'gestoppt';
    await v.dienstePruefen();
    a = v.ansichten()[0];
    assert.equal(a.anzeige, 'dienst-gestoppt');
    assert.equal(a.kannStarten, true);
    assert.ok(u.meldungen.some(([, m]) => /Windows-Dienst MonitoringFTP \(Modul ftp\): gestoppt/.test(m)));

    await v.starten('ftp', 'patrick');
    d.stand.MonitoringFTP = 'laeuft';
    assert.equal((await v.beenden('ftp', 'patrick')).ok, true);
    assert.deepEqual(d.aufrufe, [['starten', 'MonitoringFTP'], ['beenden', 'MonitoringFTP']]);
    u.uhr('2026-10-29T14:00:00Z'); // weit über der Frist – trotzdem keine „Keine Meldung“
    a = v.ansichten()[0];
    assert.deepEqual([a.anzeige, a.beendetVon, a.ueberfaelligSeit, a.kannBeenden, a.kannStarten], ['beendet', 'patrick', null, false, true]);
    assert.ok(u.meldungen.some(([, m]) => m === 'Modul ftp beendet durch patrick (Windows-Dienst „MonitoringFTP“ gestoppt).'));

    // „Beendet“ bleibt nach Neustart der Basis erhalten …
    const v2 = u.neu({ dienste: d });
    await v2.start();
    v2.stop();
    assert.equal(v2.ansichten()[0].anzeige, 'beendet');
    // … bis sich das Modul wieder meldet.
    await schreibeJson(status, { status: 'ok', zeit: '2026-10-29T14:01:00Z' });
    d.stand.MonitoringFTP = 'laeuft';
    await v2.statusLesen();
    await v2.dienstePruefen();
    assert.equal(v2.ansichten()[0].anzeige, 'ok');
    assert.equal(v2.ansichten()[0].beendet, null);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Module beenden: befehl.json, Fehler beim Dienst, nicht beendbar, alle beenden', async () => {
  const u = await aufbau({
    'datei/module.json': { id: 'datei', name: 'Datei', typ: 'eigenstaendig', befehlsdatei: true },
    'gesperrt/module.json': { id: 'gesperrt', name: 'Gesperrt', typ: 'eigenstaendig', dienst: 'Gesperrt' },
    'ohne/module.json': { id: 'ohne', name: 'Ohne', typ: 'eigenstaendig' },
    'dienst/module.json': { id: 'dienst', name: 'Dienst', typ: 'eigenstaendig', dienst: 'Dienst' },
    'fehlt/module.json': { id: 'fehlt', name: 'Fehlt', typ: 'eigenstaendig', dienst: 'GibtsNicht' },
  });
  try {
    const d = dienste({ Gesperrt: 'laeuft', Dienst: 'laeuft' });
    const v = u.neu({ dienste: d });
    await v.start();
    v.stop();
    const nach = (id) => v.ansichten().find((m) => m.id === id);
    assert.equal(nach('fehlt').anzeige, 'dienst-gestoppt');
    assert.match(nach('fehlt').dienst.fehler, /nicht installiert/);
    assert.equal(nach('ohne').kannBeenden, false);
    assert.match((await v.beenden('ohne', 'patrick')).fehler, /nicht an, wie es beendet werden kann/);

    const fehler = await v.alleBeenden('patrick');
    assert.deepEqual(fehler, ['Gesperrt: Keine Berechtigung.']);
    const befehl = JSON.parse(await readFile(path.join(u.moduleOrdner, 'datei', 'befehl.json'), 'utf8'));
    assert.deepEqual(befehl, { befehl: 'beenden', zeit: '2026-10-29T12:00:00.000Z', von: 'patrick' });
    assert.equal(nach('datei').anzeige, 'beendet');
    assert.equal(nach('dienst').anzeige, 'beendet');
    assert.equal(nach('gesperrt').anzeige, 'unbekannt', 'nicht beendet bleibt wie es war');
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /Windows-Dienst Gesperrt konnte nicht beendet werden/.test(m)));
    assert.deepEqual(await v.alleBeenden('patrick'), ['Gesperrt: Keine Berechtigung.'], 'bereits beendete werden übersprungen');
    assert.match((await v.starten('datei', 'patrick')).fehler, /Windows-Dienst/);
    assert.equal(await v.beenden('unbekannt', 'patrick'), null);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Module beenden: von der Basis gestartetes Modul wird abgebrochen und pausiert', async () => {
  const u = await aufbau({ 'skript/module.json': { id: 'skript', name: 'Skript', typ: 'programm', befehl: 'x.exe', intervall_minuten: 5 } });
  try {
    const abgebrochen = [];
    const v = u.neu({ abbrechen: (id) => { abgebrochen.push(id); return 1; } });
    await v.start();
    v.stop();
    const ergebnis = await v.beenden('skript', 'patrick');
    assert.equal(ergebnis.text, 'Modul skript beendet durch patrick (laufende Prüfung abgebrochen), pausiert.');
    assert.deepEqual(abgebrochen, ['skript']);
    assert.equal(v.ansichten()[0].anzeige, 'inaktiv');
    assert.equal(u.planer.module.find((m) => m.id === 'skript').aktiv, false);
    assert.match((await v.starten('skript', 'patrick')).fehler, /Windows-Dienst/);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

const ORDNER_LISTE = {
  schluessel: 'ordner', bezeichnung: 'Ordner', typ: 'liste', pflicht: true, max_zeilen: 3,
  spalten: [
    { schluessel: 'pfad', bezeichnung: 'Ordner', typ: 'text', pflicht: true },
    { schluessel: 'max_alter', bezeichnung: 'Max. Alter (h)', typ: 'zahl', min: 0.1, max: 720, standard: 2 },
    { schluessel: 'ab', bezeichnung: 'Nur Dateien ab', typ: 'datum' },
    { schluessel: 'zeitstempel', bezeichnung: 'Zeitstempel', typ: 'auswahl', optionen: ['create', 'modify'] },
    { schluessel: 'leer_ok', bezeichnung: 'Leer ist ok', typ: 'schalter' },
  ],
  standard: [{ pfad: 'files', max_alter: 2 }],
};

test('Einstellungsfeld Liste: Spalten, Datum, Zeilenprüfung, leere Zeilen, Grenzen', () => {
  const { felder, fehler } = pruefeFelder([ORDNER_LISTE]);
  assert.equal(fehler, undefined);
  const [f] = felder;
  assert.equal(f.maxZeilen, 3);
  assert.deepEqual(f.standard, [{ pfad: 'files', max_alter: 2 }]);
  assert.match(pruefeFelder([{ ...ORDNER_LISTE, spalten: [{ schluessel: 'pw', bezeichnung: 'PW', typ: 'passwort' }] }]).fehler, /spalten\[0\]\.typ muss text, zahl, schalter, auswahl, datum sein/);
  assert.match(pruefeFelder([{ ...ORDNER_LISTE, spalten: [{ schluessel: 'x', bezeichnung: 'X', typ: 'liste', spalten: [] }] }]).fehler, /spalten\[0\]\.typ/);
  assert.match(pruefeFelder([{ ...ORDNER_LISTE, spalten: [] }]).fehler, /spalten fehlt/);
  assert.match(pruefeFelder([{ ...ORDNER_LISTE, max_zeilen: 0 }]).fehler, /max_zeilen/);
  assert.match(pruefeFelder([{ ...ORDNER_LISTE, standard: [{ max_alter: 3 }] }]).fehler, /standard: Zeile 1: Ordner fehlt/);

  // Werte aus dem Formular kommen als Text; leere Zeilen fallen weg.
  assert.deepEqual(pruefeWert(f, [{ pfad: ' export ', max_alter: '24', ab: '2026-11-01', zeitstempel: 'modify', leer_ok: true }, { pfad: '', max_alter: '', ab: '', leer_ok: false }]),
    { wert: [{ pfad: 'export', max_alter: 24, ab: '2026-11-01', zeitstempel: 'modify', leer_ok: true }] });
  assert.deepEqual(pruefeWert(f, []), { wert: [] });
  assert.equal(pruefeWert(f, [{ pfad: 'a', max_alter: '9999' }]).fehler, 'Zeile 1, Max. Alter (h): höchstens 720');
  assert.equal(pruefeWert(f, [{ pfad: 'a' }, { max_alter: 3 }]).fehler, 'Zeile 2: Ordner fehlt');
  assert.equal(pruefeWert(f, [{ pfad: 'a', ab: '2026-02-30' }]).fehler, 'Zeile 1, Nur Dateien ab: kein gültiges Datum (JJJJ-MM-TT)');
  assert.equal(pruefeWert(f, [{ pfad: 'a', zeitstempel: 'atime' }]).fehler, 'Zeile 1, Zeitstempel: keine erlaubte Auswahl');
  assert.equal(pruefeWert(f, [{ pfad: 'a' }, { pfad: 'b' }, { pfad: 'c' }, { pfad: 'd' }]).fehler, 'höchstens 3 Zeilen');
  assert.equal(pruefeWert(f, 'files').fehler, 'muss eine Liste sein');
  assert.equal(pruefeWert(f, ['files']).fehler, 'Zeile 1 ist ungültig');
  assert.deepEqual(pruefeWert(f, [{ pfad: 'a', unbekannt: 'x' }]), { wert: [{ pfad: 'a' }] }, 'unbekannte Spalten fallen weg');
  assert.deepEqual(pruefeWert({ typ: 'datum' }, '2026-10-27'), { wert: '2026-10-27' });
  assert.equal(pruefeWert({ typ: 'datum' }, '27.10.2026').fehler, 'kein gültiges Datum (JJJJ-MM-TT)');
});

test('Einstellungsfeld Liste: speichern, Standard, Pflicht, Ansicht', async () => {
  const ordner = await temp();
  try {
    const { felder } = pruefeFelder([ORDNER_LISTE, { schluessel: 'server', bezeichnung: 'Server', typ: 'text' }]);
    const modul = { id: 'ftp', ordner, felder, einstellungen: {} };
    assert.deepEqual((await ansicht(modul)).werte.ordner, [{ pfad: 'files', max_alter: 2 }], 'ohne Speicherung gilt der Standard');
    assert.deepEqual((await speichern(modul, { ordner: [] })).feldfehler, { ordner: 'mindestens eine Zeile' });
    const ok = await speichern(modul, { ordner: [{ pfad: 'files', max_alter: '2' }, { pfad: 'export', max_alter: '24', ab: '2026-11-01' }] });
    assert.deepEqual(ok, { geaendert: ['ordner'] });
    assert.deepEqual(JSON.parse(await readFile(path.join(ordner, 'einstellungen.json'), 'utf8')).ordner[1], { pfad: 'export', max_alter: 24, ab: '2026-11-01' });
    assert.deepEqual(await speichern(modul, { ordner: [{ pfad: 'files', max_alter: 2 }, { pfad: 'export', max_alter: 24, ab: '2026-11-01' }] }), { geaendert: [] }, 'gleiche Werte: keine Änderung');
    assert.deepEqual((await speichern(modul, { ordner: [{ pfad: 'a', max_alter: 'x' }] })).feldfehler, { ordner: 'Zeile 1, Max. Alter (h): keine gültige Zahl' });
    assert.equal((await wirksameWerte(modul)).ordner.length, 2, 'Fehler ändert nichts');
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});
