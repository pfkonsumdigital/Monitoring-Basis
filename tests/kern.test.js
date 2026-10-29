import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruefeModul, ladeModule } from '../basis/module.js';
import { fuehreAus, normalisiereErgebnis } from '../basis/ausfuehrung.js';
import { Ergebnisspeicher } from '../basis/speicher.js';
import { Planer } from '../basis/planer.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tempOrdner = () => mkdtemp(path.join(tmpdir(), 'mb-test-'));
const programm = (code, extra = {}) => ({ id: 't', typ: 'programm', befehl: process.execPath, argumente: ['-e', code], arbeitsordner: fixtures, ordner: fixtures, timeoutMs: 5000, einstellungen: {}, ...extra });
const plugin = (datei, extra = {}) => ({ id: 't', typ: 'plugin', einstieg: path.join(fixtures, datei), ordner: fixtures, timeoutMs: 5000, einstellungen: { name: 'Welt' }, ...extra });

test('module.json: gültiges Programm und Plugin', () => {
  const p = pruefeModul({ id: 'ftp', name: 'FTP', typ: 'programm', befehl: 'C:\\x.exe', argumente: ['--a'], intervall_minuten: 5 }, 'ftp', '/m/ftp');
  assert.equal(p.modul.befehl, 'C:\\x.exe');
  assert.equal(p.modul.intervallMinuten, 5);
  assert.equal(p.modul.timeoutMs, 60000);
  const q = pruefeModul({ id: 'ping', name: 'Ping', typ: 'plugin', einstieg: 'index.js' }, 'ping', '/m/ping');
  assert.equal(q.modul.einstieg, path.resolve('/m/ping/index.js'));
  assert.equal(q.modul.intervallMinuten, null);
});

test('module.json: ungültige Angaben werden mit Meldung abgelehnt', () => {
  const basis = { id: 'a', name: 'A', typ: 'plugin', einstieg: 'i.js' };
  assert.match(pruefeModul({ ...basis, id: 'b' }, 'a', '/m/a').fehler, /Ordnernamen/);
  assert.match(pruefeModul(basis, 'A B', '/m/A B').fehler, /Ordnername/);
  assert.match(pruefeModul({ ...basis, typ: 'x' }, 'a', '/m/a').fehler, /typ/);
  assert.match(pruefeModul({ ...basis, einstieg: '../boese.js' }, 'a', '/m/a').fehler, /Modulordner/);
  assert.match(pruefeModul({ ...basis, intervall_minuten: 0 }, 'a', '/m/a').fehler, /intervall/);
  assert.match(pruefeModul({ ...basis, timeout_sekunden: 1.5 }, 'a', '/m/a').fehler, /timeout/);
  assert.match(pruefeModul({ id: 'a', name: 'A', typ: 'programm' }, 'a', '/m/a').fehler, /befehl/);
});

test('ladeModule zeigt fehlerhafte Module an und überspringt Ordner ohne module.json', async () => {
  const ordner = await tempOrdner();
  try {
    await mkdir(path.join(ordner, 'gut'));
    await writeFile(path.join(ordner, 'gut', 'module.json'), JSON.stringify({ id: 'gut', name: 'Gut', typ: 'plugin', einstieg: 'i.js' }));
    await mkdir(path.join(ordner, 'kaputt'));
    await writeFile(path.join(ordner, 'kaputt', 'module.json'), '{nicht json');
    await mkdir(path.join(ordner, 'leer'));
    const module = await ladeModule(ordner);
    assert.deepEqual(module.map((m) => [m.id, Boolean(m.fehler)]), [['gut', false], ['kaputt', true]]);
    assert.deepEqual(await ladeModule(path.join(ordner, 'fehlt')), []);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Programm: JSON-Ergebnis auf stdout hat Vorrang vor dem Exitcode', async () => {
  const e = await fuehreAus(programm('console.log("vorher"); console.log(JSON.stringify({status:"warnung",zusammenfassung:"3 alt",messwerte:{alt:3}})); process.exit(0)'));
  assert.equal(e.status, 'warnung');
  assert.equal(e.zusammenfassung, '3 alt');
  assert.deepEqual(e.messwerte, { alt: 3 });
  assert.ok(e.beginn && e.dauerMs >= 0);
});

test('Programm: Exitcodes 0/1/2 und unbekannte Codes', async () => {
  assert.equal((await fuehreAus(programm('console.log("alles gut")'))).zusammenfassung, 'alles gut');
  assert.equal((await fuehreAus(programm('process.exit(0)'))).status, 'ok');
  assert.equal((await fuehreAus(programm('process.exit(1)'))).status, 'warnung');
  assert.equal((await fuehreAus(programm('console.error("kaputt"); process.exit(2)'))).zusammenfassung, 'kaputt');
  const e = await fuehreAus(programm('process.exit(7)'));
  assert.equal(e.status, 'fehler');
  assert.match(e.zusammenfassung, /Exitcode 7/);
});

test('Programm: Einstellungen kommen als Umgebungsvariable an', async () => {
  const e = await fuehreAus(programm('const s=JSON.parse(process.env.MONITOR_EINSTELLUNGEN); console.log(JSON.stringify({status:"ok",zusammenfassung:s.x+process.env.MONITOR_MODUL_ID}))', { einstellungen: { x: 'wert-' } }));
  assert.equal(e.zusammenfassung, 'wert-t');
});

test('Programm: Zeitlimit und Startfehler werden zu Fehlern', async () => {
  const lang = await fuehreAus(programm('setInterval(()=>{},1000)', { timeoutMs: 300 }));
  assert.equal(lang.status, 'fehler');
  assert.match(lang.zusammenfassung, /Zeitlimit/);
  const fehlt = await fuehreAus(programm('', { befehl: path.join(fixtures, 'gibt-es-nicht.exe') }));
  assert.equal(fehlt.status, 'fehler');
  assert.match(fehlt.zusammenfassung, /nicht gestartet/);
});

test('Plugin: Ergebnis, Einstellungen und console.log stören nicht', async () => {
  const e = await fuehreAus(plugin('plugin-ok.js'));
  assert.equal(e.status, 'warnung');
  assert.equal(e.zusammenfassung, 'Hallo Welt');
  assert.deepEqual(e.messwerte, { anzahl: 3 });
  assert.match(e.fehlerausgabe, /nicht stören/);
});

test('Plugin: Ausnahme, fehlende Funktion und Endlosschleife', async () => {
  assert.match((await fuehreAus(plugin('plugin-wirft.js'))).zusammenfassung, /Plugin-Fehler: kaputt/);
  assert.match((await fuehreAus(plugin('plugin-ohne.js'))).zusammenfassung, /pruefen/);
  const endlos = await fuehreAus(plugin('plugin-endlos.js', { timeoutMs: 500 }));
  assert.match(endlos.zusammenfassung, /Zeitlimit/);
});

test('normalisiereErgebnis lehnt ungültigen Status ab und begrenzt Felder', () => {
  assert.equal(normalisiereErgebnis({ status: 'super' }).status, 'fehler');
  const e = normalisiereErgebnis({ status: 'ok', details: ['x'.repeat(2000), 5], messwerte: { a: Infinity, b: 2 } });
  assert.equal(e.details.length, 1);
  assert.equal(e.details[0].length, 1000);
  assert.deepEqual(e.messwerte, { b: 2 });
  assert.equal(e.zusammenfassung, 'ok');
});

test('Ergebnisspeicher: Verlauf begrenzt, neueste zuerst, übersteht Neustart', async () => {
  const ordner = await tempOrdner();
  try {
    const s = new Ergebnisspeicher(ordner, 3);
    await s.laden(['a']);
    for (let i = 1; i <= 5; i++) await s.hinzufuegen('a', { status: 'ok', nr: i });
    assert.deepEqual(s.verlauf('a').map((e) => e.nr), [5, 4, 3]);
    const neu = new Ergebnisspeicher(ordner, 3);
    await neu.laden(['a', 'b']);
    assert.equal(neu.letztes('a').nr, 5);
    assert.equal(neu.letztes('b'), null);
    assert.equal(JSON.parse(await readFile(path.join(ordner, 'ergebnisse', 'a.json'), 'utf8')).length, 3);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Planer: kein Doppellauf und neuer Termin nach dem Lauf', async () => {
  let freigeben;
  const gespeichert = [];
  const planer = new Planer({
    module: [{ id: 'a', aktiv: true, intervallMinuten: 10 }, { id: 'kaputt', fehler: 'x' }],
    ausfuehren: () => new Promise((r) => { freigeben = r; }),
    speichern: async (id, e) => { gespeichert.push([id, e.status]); },
  });
  assert.equal(planer.jetztPruefen('a'), true);
  assert.equal(planer.laeuft('a'), true);
  assert.equal(planer.jetztPruefen('a'), false);
  assert.equal(planer.jetztPruefen('kaputt'), false);
  freigeben({ status: 'ok', zusammenfassung: 'x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(gespeichert, [['a', 'ok']]);
  assert.equal(planer.laeuft('a'), false);
  assert.ok(Date.parse(planer.naechster('a')) > Date.now() + 9 * 60_000);
  planer.stop();
});

test('Konfiguration: Pflichtangaben und Pfade', () => {
  const tls = { modus: 'dateien', zertifikat: 'c.pem', schluessel: 'k.pem' };
  const k = pruefeKonfiguration({ hostname: 'm.firma.de', tls }, '/app');
  assert.equal(k.port, 8443);
  assert.equal(k.moduleOrdner, path.resolve('/app/modules'));
  assert.equal(k.tls.zertifikat, path.resolve('/app/c.pem'));
  assert.throws(() => pruefeKonfiguration({ tls }, '/app'), /hostname/);
  assert.throws(() => pruefeKonfiguration({ hostname: 'm', tls: { modus: 'letsencrypt', email: 'a@b.de' } }, '/app'), /cloudflare_token/);
  assert.throws(() => pruefeKonfiguration({ hostname: 'm', tls, benutzer: { 'a b': { hash: 'x' } } }, '/app'), /Benutzereintrag/);
});

test('Konfiguration: Admin-Flag und Update-Abschnitt', () => {
  const tls = { modus: 'dateien', zertifikat: 'c.pem', schluessel: 'k.pem' };
  const k = pruefeKonfiguration({ hostname: 'm', tls, updates: { github_token: 'T' }, benutzer: { patrick: { hash: 'x', admin: true } } }, '/app');
  assert.deepEqual(k.updates, { repo: 'pfkonsumdigital/Monitoring-Basis', githubToken: 'T' });
  assert.equal(pruefeKonfiguration({ hostname: 'm', tls }, '/app').updates, null);
  assert.throws(() => pruefeKonfiguration({ hostname: 'm', tls, updates: {} }, '/app'), /github_token/);
  assert.throws(() => pruefeKonfiguration({ hostname: 'm', tls, updates: { github_token: 'T', repo: 'kaputt' } }, '/app'), /besitzer\/repo/);
  assert.throws(() => pruefeKonfiguration({ hostname: 'm', tls, benutzer: { a: { hash: 'x', admin: 'ja' } } }, '/app'), /admin/);
});
