import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { braucht, fingerabdruck, Freigaben, unterschiede } from '../basis/freigabe.js';
import { leseBegrenzt } from '../basis/dateien.js';
import { leseDatei } from '../basis/einstellungen.js';
import { ladeModule } from '../basis/module.js';
import { Modulverwaltung, MANUELL_ABSTAND_MS } from '../basis/modulverwaltung.js';
import { Ergebnisspeicher } from '../basis/speicher.js';
import { Planer } from '../basis/planer.js';
import { berechneAnsicht } from '../basis/modulansicht.js';

const schreiben = async (datei, inhalt) => {
  await mkdir(path.dirname(datei), { recursive: true });
  await writeFile(datei, typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt, null, 2));
};
const PROG = { id: 'prog', name: 'Programm', typ: 'programm', befehl: 'pruefe.exe', argumente: ['--schnell'], intervall_minuten: 5 };

async function modul(wurzel, json = PROG, dateien = { 'pruefe.exe': 'MZ-1', 'lib/hilfe.dll': 'DLL-1' }) {
  const ordner = path.join(wurzel, 'modules', json.id);
  await schreiben(path.join(ordner, 'module.json'), json);
  for (const [d, t] of Object.entries(dateien)) await schreiben(path.join(ordner, d), t);
  const [m] = (await ladeModule(path.join(wurzel, 'modules'))).filter((x) => x.id === json.id);
  return { ordner, m };
}

test('Fingerabdruck: stabil, erkennt jede Änderung, ignoriert Betriebsdateien, Daten- und Protokollordner', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fa-'));
  try {
    const { ordner, m } = await modul(wurzel);
    const a = await fingerabdruck(m);
    assert.match(a.wert, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(a.angaben.dateien), ['lib/hilfe.dll', 'pruefe.exe']);
    assert.equal(a.angaben.arbeitsordner, '.');
    assert.equal((await fingerabdruck(m)).wert, a.wert, 'stabil');
    // Betriebsdateien, Daten, Protokolle, temporäre Dateien und module.json zählen nicht.
    await schreiben(path.join(ordner, 'status.json'), { status: 'ok' });
    await schreiben(path.join(ordner, 'einstellungen.json'), { a: 1 });
    await schreiben(path.join(ordner, 'befehl.json'), { befehl: 'beenden' });
    await schreiben(path.join(ordner, 'einstellungen.json.123.tmp'), 'x');
    await schreiben(path.join(ordner, 'daten', 'stand.db'), 'x');
    await schreiben(path.join(ordner, 'logs', 'heute.log'), 'x');
    await schreiben(path.join(ordner, 'module.json'), { ...PROG, name: 'Anderer Name', intervall_minuten: 10 });
    assert.equal((await fingerabdruck(m)).wert, a.wert);
    // Gleiche Namen tiefer im Ordner zählen sehr wohl.
    await schreiben(path.join(ordner, 'lib', 'status.json'), 'x');
    const b = await fingerabdruck(m);
    assert.notEqual(b.wert, a.wert);
    assert.deepEqual(unterschiede(a.angaben, b.angaben), ['neu: lib/status.json']);
    await rm(path.join(ordner, 'lib', 'status.json'));
    await schreiben(path.join(ordner, 'lib', 'hilfe.dll'), 'DLL-2');
    const c = await fingerabdruck(m);
    assert.deepEqual(unterschiede(a.angaben, c.angaben), ['geändert: lib/hilfe.dll']);
    // Ausgewertete Angaben aus module.json zählen.
    assert.deepEqual(unterschiede(c.angaben, (await fingerabdruck({ ...m, argumente: ['--alles'] })).angaben), ['argumente: ["--schnell"] → ["--alles"]']);
    assert.deepEqual(unterschiede(c.angaben, (await fingerabdruck({ ...m, befehl: 'anders.exe' })).angaben), ['befehl: „pruefe.exe“ → „anders.exe“']);
    await rm(path.join(ordner, 'lib', 'hilfe.dll'));
    assert.deepEqual(unterschiede(c.angaben, (await fingerabdruck(m)).angaben), ['entfernt: lib/hilfe.dll']);
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Fingerabdruck: Verknüpfungen, Grenzen, Programmdatei und Argumente außerhalb des Modulordners', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fa-'));
  try {
    const { ordner, m } = await modul(wurzel);
    await symlink('/etc/hosts', path.join(ordner, 'lib', 'verweis'));
    const v = await fingerabdruck(m);
    assert.equal(v.wert, null);
    assert.match(v.fehler, /Verknüpfung \(lib\/verweis\)/);
    await rm(path.join(ordner, 'lib', 'verweis'));
    assert.match((await fingerabdruck(m, { grenzen: { dateien: 1, bytes: 1e9 } })).fehler, /mehr als 1 Dateien/);
    assert.match((await fingerabdruck(m, { grenzen: { dateien: 100, bytes: 5 } })).fehler, /größer als/);
    assert.match((await fingerabdruck({ ...m, ordner: path.join(wurzel, 'fehlt') })).fehler, /Verknüpfung oder fehlt/);

    // Programm außerhalb (absoluter Pfad) und Skript als Argument außerhalb: Inhalt zählt mit.
    const extern = path.join(wurzel, 'werkzeuge');
    await schreiben(path.join(extern, 'python.exe'), 'PY-1');
    await schreiben(path.join(extern, 'skript.py'), 'print(1)');
    const mitExtern = { ...m, befehl: path.join(extern, 'python.exe'), argumente: [path.join(extern, 'skript.py'), '-u', 'fehlt.py'] };
    const e1 = await fingerabdruck(mitExtern);
    assert.deepEqual(Object.keys(e1.angaben.extern).sort(), [path.join(extern, 'python.exe'), path.join(extern, 'skript.py')].sort());
    await schreiben(path.join(extern, 'skript.py'), 'print(2)');
    const e2 = await fingerabdruck(mitExtern);
    assert.deepEqual(unterschiede(e1.angaben, e2.angaben), [`Datei außerhalb des Modulordners geändert: ${path.join(extern, 'skript.py')}`]);
    // Reiner Programmname: unter Windows wird zuerst im Arbeitsordner gesucht – eine dort abgelegte Datei zählt.
    const imArbeitsordner = { ...m, befehl: 'python', argumente: [], arbeitsordner: extern };
    const p1 = await fingerabdruck(imArbeitsordner);
    assert.deepEqual(Object.keys(p1.angaben.extern), [path.join(extern, 'python.exe')]);
    assert.equal(p1.angaben.arbeitsordner, extern);
    await schreiben(path.join(extern, 'python.cmd'), 'boese');
    assert.notEqual((await fingerabdruck(imArbeitsordner)).wert, p1.wert);
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Fingerabdruck: eigenständige Module nur mit Dienst; Plugin mit Einstieg; Cache nur bei gleicher Datei', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fa-'));
  try {
    assert.equal(braucht({ typ: 'eigenstaendig', dienst: null }), false);
    assert.equal(braucht({ typ: 'eigenstaendig', dienst: 'X' }), true);
    assert.equal(braucht({ typ: 'plugin' }), true);
    assert.equal(braucht({ typ: 'programm', fehler: 'kaputt' }), false);
    const { m: ftp } = await modul(wurzel, { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', dienst: 'MonitoringFTP' }, { 'FTPModul.exe': 'x' });
    const f1 = await fingerabdruck(ftp);
    assert.deepEqual(f1.angaben, { typ: 'eigenstaendig', dienst: 'MonitoringFTP' });
    assert.deepEqual(unterschiede(f1.angaben, (await fingerabdruck({ ...ftp, dienst: 'WinDefend' })).angaben), ['dienst: „MonitoringFTP“ → „WinDefend“']);
    assert.match(unterschiede(null, f1.angaben)[0], /Neues Modul: steuert den Windows-Dienst „MonitoringFTP“/);

    const { ordner, m: plug } = await modul(wurzel, { id: 'plug', name: 'P', typ: 'plugin', einstieg: 'index.js' }, { 'index.js': 'a' });
    const cache = { alt: new Map(), neu: new Map() };
    const p1 = await fingerabdruck(plug, { cache });
    assert.equal(p1.angaben.einstieg, 'index.js');
    assert.equal(cache.neu.size, 1);
    // Gleiche Größe, gleicher Zeitstempel: der Cache würde die Änderung übersehen – deshalb ohne Cache vor jedem Start.
    const [eintrag] = cache.neu.values();
    const zweiter = { alt: new Map([[path.join(ordner, 'index.js'), eintrag]]), neu: new Map() };
    await writeFile(path.join(ordner, 'index.js'), 'b');
    assert.notEqual((await fingerabdruck(plug)).wert, p1.wert);
    assert.notEqual((await fingerabdruck(plug, { cache: zweiter })).wert, p1.wert, 'Zeitstempel geändert → neu berechnet');
    assert.match(unterschiede(null, p1.angaben)[0], /Neues Modul \(plugin, Einstieg „index\.js“, 1 Datei\)/);
    const viele = unterschiede({ dateien: {} }, { dateien: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`d${i}`, 'x'])) });
    assert.equal(viele.length, 51);
    assert.equal(viele[50], '… und 10 weitere Änderungen');
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Dateien begrenzt lesen: zu groß, keine normale Datei, fehlt; module.json, status.json und einstellungen.json', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-grenze-'));
  try {
    const datei = path.join(wurzel, 'a.json');
    await writeFile(datei, '12345');
    assert.equal(await leseBegrenzt(datei, 5), '12345');
    await assert.rejects(leseBegrenzt(datei, 4), { code: 'ZU_GROSS' });
    await assert.rejects(leseBegrenzt(path.join(wurzel, 'fehlt'), 4), { code: 'ENOENT' });
    await symlink(datei, path.join(wurzel, 'link.json'));
    await assert.rejects(leseBegrenzt(path.join(wurzel, 'link.json'), 100), { code: 'KEINE_DATEI' });
    await assert.rejects(leseBegrenzt(wurzel, 100), { code: 'KEINE_DATEI' });

    const moduleOrdner = path.join(wurzel, 'modules');
    await schreiben(path.join(moduleOrdner, 'gross', 'module.json'), `{"id":"gross","name":"G","typ":"eigenstaendig","beschreibung":"${'x'.repeat(256 * 1024)}"}`);
    await mkdir(path.join(moduleOrdner, 'verweis'));
    await symlink(datei, path.join(moduleOrdner, 'verweis', 'module.json'));
    const module = await ladeModule(moduleOrdner);
    assert.equal(module.find((x) => x.id === 'gross').fehler, 'module.json ist zu groß (höchstens 256 KB)');
    assert.match(module.find((x) => x.id === 'verweis').fehler, /keine normale Datei/);

    await schreiben(path.join(wurzel, 'e', 'einstellungen.json'), `{"a":"${'x'.repeat(1024 * 1024)}"}`);
    assert.deepEqual(await leseDatei(path.join(wurzel, 'e')), {});
    await schreiben(path.join(wurzel, 'e', 'einstellungen.json'), { a: 1 });
    assert.deepEqual(await leseDatei(path.join(wurzel, 'e')), { a: 1 });
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Freigaben-Datei: erster Start, gültig, beschädigt (nichts freigegeben), ungültige Einträge', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fg-'));
  try {
    const meldungen = [];
    const log = Object.assign((m) => meldungen.push(['info', m]), { fehler: (q, m) => meldungen.push(['fehler', m]) });
    const f = new Freigaben({ datenOrdner: wurzel, log, jetzt: () => Date.parse('2026-11-09T10:00:00Z') });
    await f.laden();
    assert.equal(f.ersterStart, true);
    await f.setzen([{ id: 'a', wert: 'a'.repeat(64), angaben: { typ: 'plugin' } }], 'patrick', 'Test');
    assert.equal(f.ersterStart, false);
    const g = new Freigaben({ datenOrdner: wurzel, log });
    await g.laden();
    assert.equal(g.ersterStart, false);
    assert.equal(g.wert('a'), 'a'.repeat(64));
    assert.deepEqual({ ...g.eintrag('a'), angaben: undefined }, { wert: 'a'.repeat(64), angaben: undefined, zeit: '2026-11-09T10:00:00.000Z', von: 'patrick', grund: 'Test' });
    assert.equal(g.wert('constructor'), null);
    const datei = path.join(wurzel, 'modulfreigaben.json');
    await writeFile(datei, JSON.stringify({ version: 1, module: { a: { wert: 'kurz' }, 'B!': { wert: 'b'.repeat(64) }, c: { wert: 'c'.repeat(64) } } }));
    await g.laden();
    assert.deepEqual(Object.keys(g.module), ['c']);
    await writeFile(datei, '{kaputt');
    await g.laden();
    assert.deepEqual(g.module, {});
    assert.equal(g.ersterStart, false, 'beschädigt ist kein erster Start');
    assert.ok(meldungen.some(([s, m]) => s === 'fehler' && /beschädigt/.test(m)));
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

async function verwaltungAufbau({ freigabeDatei = null } = {}) {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fgv-'));
  const datenOrdner = path.join(wurzel, 'data');
  await modul(wurzel);
  await modul(wurzel, { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', dienst: 'MonitoringFTP', befehlsdatei: true }, { 'FTPModul.exe': 'x' });
  await modul(wurzel, { id: 'selbst', name: 'Selbst', typ: 'eigenstaendig' }, {});
  if (freigabeDatei !== null) await schreiben(path.join(datenOrdner, 'modulfreigaben.json'), freigabeDatei);
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', `${q}: ${m}`]), fehler: (q, m) => meldungen.push(['fehler', `${q}: ${m}`]) });
  const speicher = new Ergebnisspeicher(datenOrdner, 50);
  const gestartet = [];
  let verwaltung;
  const planer = new Planer({ ausfuehren: async (m) => (await verwaltung.vorStart(m)) ?? (gestartet.push(m.id), { status: 'ok', zusammenfassung: 'lief' }), speichern: (id, e) => speicher.hinzufuegen(id, e) });
  const dienstAufrufe = [];
  const dienste = {
    async zustand(name) { dienstAufrufe.push(['zustand', name]); return { zustand: 'laeuft' }; },
    async beenden(name) { dienstAufrufe.push(['beenden', name]); },
    async starten(name) { dienstAufrufe.push(['starten', name]); },
  };
  let uhr = Date.parse('2026-11-09T10:00:00Z');
  const neu = async () => {
    const freigaben = new Freigaben({ datenOrdner, log, jetzt: () => uhr });
    await freigaben.laden();
    verwaltung = new Modulverwaltung({ moduleOrdner: path.join(wurzel, 'modules'), datenOrdner, speicher, planer, uebernehmen: (id, e) => speicher.hinzufuegen(id, e), dienste, freigaben, log, jetzt: () => uhr, intervallMs: 60_000 });
    await verwaltung.start();
    verwaltung.stop();
    return verwaltung;
  };
  return { wurzel, datenOrdner, meldungen, speicher, planer, gestartet, dienstAufrufe, neu, ordner: (id) => path.join(wurzel, 'modules', id), weiter: (ms) => { uhr += ms; } };
}

const anzeige = (v, id) => v.ansichten().find((m) => m.id === id);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

test('Modul-Freigabe: erster Start übernimmt, Änderung stoppt das Modul, Freigabe nur mit aktuellem Fingerabdruck', async () => {
  const u = await verwaltungAufbau();
  try {
    let v = await u.neu();
    assert.ok(u.meldungen.some(([, m]) => /Modul-Freigaben eingeführt: bestehende Module übernommen \(ftp, prog\)/.test(m)));
    assert.equal(anzeige(v, 'prog').anzeige, 'unbekannt');
    assert.equal(anzeige(v, 'prog').freigabe, null);
    assert.deepEqual(v.planbar().map((m) => m.id).sort(), ['ftp', 'prog', 'selbst']);
    const datei = JSON.parse(await readFile(path.join(u.datenOrdner, 'modulfreigaben.json'), 'utf8'));
    assert.deepEqual(Object.keys(datei.module).sort(), ['ftp', 'prog']);
    assert.equal(datei.module.prog.von, 'Basis');

    // Ein neuer Start liest die Freigaben und übernimmt nichts mehr automatisch.
    await schreiben(path.join(u.ordner('prog'), 'lib', 'hilfe.dll'), 'DLL-boese');
    await modul(u.wurzel, { id: 'neu', name: 'Neu', typ: 'plugin', einstieg: 'index.js' }, { 'index.js': 'x' });
    v = await u.neu();
    const prog = anzeige(v, 'prog');
    assert.equal(prog.anzeige, 'freigabe');
    assert.equal(prog.schwere, 1);
    assert.equal(prog.kannPruefen, false);
    assert.equal(prog.freigabe.neu, false);
    assert.deepEqual(prog.freigabe.aenderungen, ['geändert: lib/hilfe.dll']);
    assert.equal(anzeige(v, 'neu').freigabe.neu, true);
    assert.deepEqual(v.planbar().map((m) => m.id).sort(), ['ftp', 'selbst'], 'nicht freigegebene Module werden nicht geplant');
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'freigabe' });
    const warnungen = () => u.meldungen.filter(([s, m]) => s === 'warnung' && /Freigabe/.test(m));
    assert.equal(warnungen().length, 2);
    assert.ok(warnungen().some(([, m]) => /^Modul neu: Neues Modul – wird erst nach Freigabe/.test(m)));
    assert.match(warnungen().find(([, m]) => m.startsWith('Modul prog'))[1], /Modul prog: Modul geändert – wird erst nach Freigabe durch einen Admin ausgeführt: geändert: lib\/hilfe\.dll/);
    await v.einlesen();
    assert.equal(warnungen().length, 2, 'nur einmal je Stand gemeldet');

    // Freigeben nur mit dem Fingerabdruck, den der Admin gesehen hat.
    assert.deepEqual(await v.freigeben('prog', 'patrick', { erwartet: 'f'.repeat(64) }), { fehler: 'Das Modul hat sich inzwischen erneut geändert. Bitte die Änderungen noch einmal ansehen und dann freigeben.' });
    assert.deepEqual(await v.freigeben('prog', 'patrick', {}), { fehler: 'Fingerabdruck fehlt.' });
    assert.equal(await v.freigeben('gibtsnicht', 'patrick', { erwartet: prog.freigabe.wert }), null);
    assert.match((await v.freigeben('selbst', 'patrick', { erwartet: prog.freigabe.wert })).fehler, /braucht keine Freigabe/);
    const ok = await v.freigeben('prog', 'patrick', { erwartet: prog.freigabe.wert });
    assert.equal(ok.ok, true);
    assert.match(ok.text, /Modul prog freigegeben durch patrick \(1 Änderung, Fingerabdruck [0-9a-f]{12}\)/);
    assert.equal(anzeige(v, 'prog').freigabe, null);
    assert.ok(v.planbar().some((m) => m.id === 'prog'));
    assert.match((await v.freigeben('prog', 'patrick', { erwartet: prog.freigabe.wert })).text, /bereits freigegeben/);
    const gespeichert = JSON.parse(await readFile(path.join(u.datenOrdner, 'modulfreigaben.json'), 'utf8')).module.prog;
    assert.equal(gespeichert.von, 'patrick');
    assert.equal(gespeichert.wert, prog.freigabe.wert);
    // Bleibt nach einem Neustart freigegeben.
    v = await u.neu();
    assert.equal(anzeige(v, 'prog').freigabe, null);
    assert.equal(anzeige(v, 'neu').anzeige, 'freigabe');
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Freigabe: vor jedem Start frisch geprüft – Änderung zwischen zwei Takten verhindert den Lauf', async () => {
  const u = await verwaltungAufbau();
  try {
    const v = await u.neu();
    assert.equal(await v.vorStart(v.planbar().find((m) => m.id === 'prog')), null);
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'gestartet' });
    await warte(50);
    assert.deepEqual(u.gestartet, ['prog']);
    // Datei ändern, ohne dass die Verwaltung neu einliest; dieselbe Größe, damit nur der Inhalt verrät.
    await schreiben(path.join(u.ordner('prog'), 'pruefe.exe'), 'MZ-2');
    u.weiter(MANUELL_ABSTAND_MS);
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'gestartet' });
    await warte(50);
    assert.deepEqual(u.gestartet, ['prog'], 'nicht gestartet');
    const letztes = u.speicher.letztes('prog');
    assert.equal(letztes.status, 'fehler');
    assert.match(letztes.zusammenfassung, /Nicht gestartet: Das Modul wurde geändert/);
    assert.deepEqual(letztes.details, ['geändert: pruefe.exe']);
    assert.equal(anzeige(v, 'prog').anzeige, 'freigabe');
    assert.ok(!v.planbar().some((m) => m.id === 'prog'));
    assert.equal(u.planer.naechster('prog'), null, 'nicht neu geplant');
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Freigabe: geänderter Dienstname – Dienst wird weder abgefragt noch gestartet oder beendet', async () => {
  const u = await verwaltungAufbau();
  try {
    let v = await u.neu();
    await schreiben(path.join(u.ordner('ftp'), 'module.json'), { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', dienst: 'WinDefend', befehlsdatei: true });
    u.dienstAufrufe.length = 0;
    v = await u.neu();
    const ftp = anzeige(v, 'ftp');
    assert.equal(ftp.anzeige, 'freigabe');
    assert.equal(ftp.kannBeenden, false);
    assert.equal(ftp.kannStarten, false);
    assert.deepEqual(ftp.freigabe.aenderungen, ['dienst: „MonitoringFTP“ → „WinDefend“']);
    assert.deepEqual(await v.starten('ftp', 'patrick'), { fehler: 'Das Modul wartet auf Freigabe durch einen Admin.' });
    assert.deepEqual(await v.beenden('ftp', 'patrick'), { fehler: 'Das Modul wartet auf Freigabe durch einen Admin.' });
    assert.deepEqual(await v.alleBeenden('patrick'), ['FTP: wartet auf Freigabe durch einen Admin, nicht beendet']);
    assert.deepEqual(u.dienstAufrufe, [], 'kein Zugriff auf den fremden Dienst');
    assert.equal(v.freigabeNoetig(v.finde('selbst')), false);
    // Nach der Freigabe wieder normal.
    assert.equal((await v.freigeben('ftp', 'patrick', { erwartet: ftp.freigabe.wert })).ok, true);
    await v.dienstePruefen();
    assert.deepEqual(u.dienstAufrufe, [['zustand', 'WinDefend']]);
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Freigabe: beschädigte Freigaben-Datei – nichts läuft; Freigabe beim Einlesen (Modul-Update)', async () => {
  const u = await verwaltungAufbau({ freigabeDatei: '{kaputt' });
  try {
    const v = await u.neu();
    assert.equal(anzeige(v, 'prog').anzeige, 'freigabe');
    assert.equal(anzeige(v, 'ftp').anzeige, 'freigabe');
    assert.equal(anzeige(v, 'selbst').anzeige, 'unbekannt');
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /modulfreigaben\.json ist beschädigt/.test(m)));
    await v.einlesen({ freigeben: { id: 'prog', von: 'patrick', grund: 'Update auf 1.1.0' } });
    assert.equal(anzeige(v, 'prog').freigabe, null);
    assert.equal(anzeige(v, 'ftp').anzeige, 'freigabe', 'nur das genannte Modul');
    assert.ok(u.meldungen.some(([, m]) => m === 'Modul prog freigegeben durch patrick (Update auf 1.1.0).'));
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Jetzt prüfen: nicht bei pausierten oder beendeten Modulen, höchstens einmal pro Minute', async () => {
  const u = await verwaltungAufbau();
  try {
    const v = await u.neu();
    assert.deepEqual(v.jetztPruefen('selbst'), { code: 'eigenstaendig' });
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'gestartet' });
    await warte(30);
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'warten', sekunden: 60 });
    u.weiter(59_500);
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'warten', sekunden: 1 });
    u.weiter(500);
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'gestartet' });
    await warte(30);
    u.weiter(MANUELL_ABSTAND_MS);
    await v.setzeAktiv('prog', false, 'patrick');
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'pausiert' });
    assert.equal(anzeige(v, 'prog').kannPruefen, false);
    await v.setzeAktiv('prog', true, 'patrick');
    await v.zustandAendern('prog', { beendet: { zeit: '2026-11-09T10:00:00Z', von: 'patrick' } });
    assert.deepEqual(v.jetztPruefen('prog'), { code: 'beendet' });
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Anzeige: Freigabe vor Pause und Beendet; Prüfen/Beenden/Starten gesperrt', () => {
  const m = { id: 'x', name: 'X', typ: 'programm', aktiv: true, intervallMinuten: 5 };
  const freigabe = { neu: true, wert: 'a'.repeat(64), aenderungen: ['Neues Modul'], fehler: null };
  const a = berechneAnsicht(m, { aktiv: false, freigabe, laeuft: true });
  assert.equal(a.anzeige, 'freigabe');
  assert.equal(a.kannPruefen, false);
  assert.equal(a.kannBeenden, false);
  assert.deepEqual(a.freigabe, freigabe);
  assert.equal(berechneAnsicht(m, { aktiv: false }).kannPruefen, false);
  assert.equal(berechneAnsicht(m, { beendet: { zeit: 'x' } }).kannPruefen, false);
  assert.equal(berechneAnsicht(m).kannPruefen, true);
  assert.equal(berechneAnsicht(m).freigabe, null);
  assert.equal(berechneAnsicht({ ...m, fehler: 'kaputt' }, { freigabe }).anzeige, 'modulfehler');
  const dienst = { id: 'd', name: 'D', typ: 'eigenstaendig', dienst: 'MonitoringFTP', aktiv: true };
  assert.equal(berechneAnsicht(dienst, { dienst: { zustand: 'gestoppt' } }).kannStarten, true);
  assert.equal(berechneAnsicht(dienst, { dienst: { zustand: 'gestoppt' }, freigabe }).kannStarten, false);
  assert.equal(berechneAnsicht(dienst, { freigabe }).kannBeenden, false);
});

test('status.json über 1 MB oder als Verknüpfung: wie eine unlesbare Meldung behandelt, Inhalt nie im Protokoll', async () => {
  const u = await verwaltungAufbau();
  try {
    const v = await u.neu();
    const datei = path.join(u.ordner('selbst'), 'status.json');
    await writeFile(datei, JSON.stringify({ status: 'ok', zeit: '2026-11-09T10:00:00Z', zusammenfassung: `GEHEIM${'x'.repeat(1024 * 1024)}` }));
    for (let i = 0; i < 4; i++) await v.statusLesen();
    assert.equal(anzeige(v, 'selbst').statusFehler, 'status.json ist zu groß (höchstens 1024 KB)');
    assert.equal(u.speicher.letztes('selbst'), null, 'nichts übernommen');
    assert.doesNotMatch(JSON.stringify(u.meldungen), /GEHEIM/);
    await writeFile(datei, JSON.stringify({ status: 'warnung', zeit: '2026-11-09T09:59:00Z' }));
    await v.statusLesen();
    assert.equal(anzeige(v, 'selbst').statusFehler, null);
    await rm(datei);
    await symlink(path.join(u.ordner('prog'), 'pruefe.exe'), datei);
    for (let i = 0; i < 4; i++) await v.statusLesen();
    assert.match(anzeige(v, 'selbst').statusFehler, /keine normale Datei/);
    await rm(datei);
    assert.equal(u.speicher.letztes('selbst').status, 'warnung', 'nur die gültige Meldung übernommen');
  } finally {
    u.planer.stop();
    await rm(u.wurzel, { recursive: true, force: true });
  }
});
