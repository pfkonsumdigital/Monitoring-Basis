import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bereinige, melde, Protokoll } from '../basis/protokoll.js';
import { beendeLaufendeModule, fuehreAus } from '../basis/ausfuehrung.js';

const temp = () => mkdtemp(path.join(tmpdir(), 'mb-prot-'));

test('Protokoll: Stufen, Quelle, Details und Dateien', async () => {
  const ordner = await temp();
  try {
    const p = new Protokoll({ ordner, konsole: false });
    p.info('Basis', 'läuft');
    p.warnung('Modul ftp', '2 Dateien zu alt', 'a.csv\nb.csv');
    p.fehler('Webserver', 'Interner Fehler', new Error('kaputt'));
    const basis = await readFile(path.join(ordner, 'basis.log'), 'utf8');
    assert.match(basis, /Z \[Basis\] läuft\n/);
    assert.match(basis, /\[WARNUNG\] \[Modul ftp\] 2 Dateien zu alt\n    a\.csv\n    b\.csv/);
    assert.match(basis, /\[FEHLER\] \[Webserver\] Interner Fehler\n    Error: kaputt/);
    const eintraege = p.lesen();
    assert.deepEqual(eintraege.map((e) => [e.stufe, e.quelle]), [['fehler', 'Webserver'], ['warnung', 'Modul ftp']], 'neueste zuerst, ohne Infos');
    assert.match(eintraege[0].details, /Error: kaputt\n\s+at /);
    assert.deepEqual(p.lesen({ stufe: 'warnung' }).map((e) => e.meldung), ['2 Dateien zu alt']);
    assert.deepEqual(p.lesen({ quelle: 'Modul' }).map((e) => e.quelle), ['Modul ftp']);
    assert.equal(p.lesen({ anzahl: 1 }).length, 1);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Protokoll: Größenbegrenzung mit Rotation, ältere Dateien werden mitgelesen', async () => {
  const ordner = await temp();
  try {
    const p = new Protokoll({ ordner, konsole: false, maxBytes: 400, maxDateien: 2 });
    for (let i = 1; i <= 30; i++) p.fehler('Test', `Fehler Nummer ${i}`);
    const dateien = (await readdir(ordner)).sort();
    assert.deepEqual(dateien, ['basis.log', 'basis.log.1', 'basis.log.2', 'fehler.log', 'fehler.log.1', 'fehler.log.2']);
    for (const d of dateien) assert.ok((await readFile(path.join(ordner, d))).length <= 400, d);
    const gelesen = p.lesen({ anzahl: 100 });
    assert.equal(gelesen[0].meldung, 'Fehler Nummer 30');
    assert.ok(gelesen.length > 3 && gelesen.length < 30, 'ältere Einträge über das Limit hinaus sind entfernt');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Protokoll: Geheimnisse werden herausgefiltert', async () => {
  const ordner = await temp();
  try {
    const p = new Protokoll({ ordner, konsole: false, geheimnisse: ['CF-GEHEIM-12345', 'kurz'] });
    p.fehler('Zertifikat', 'Cloudflare lehnte CF-GEHEIM-12345 ab', 'Authorization: Bearer abcdefghijkl123 und github_pat_11AAAAAAAA0123456789abcdef');
    const text = await readFile(path.join(ordner, 'basis.log'), 'utf8') + await readFile(path.join(ordner, 'fehler.log'), 'utf8');
    assert.doesNotMatch(text, /CF-GEHEIM|abcdefghijkl123|github_pat_11/);
    assert.match(text, /lehnte \*\*\* ab/);
    assert.equal(bereinige('{"passwort":"geheim123","x":1}'), '{"passwort":"***","x":1}');
    assert.equal(bereinige('hash scrypt$16384$8$1$abc$def'), 'hash scrypt$***');
    assert.equal(bereinige('kurz bleibt', ['kurz']), 'kurz bleibt', 'sehr kurze Werte werden nicht ersetzt');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Protokoll: Schreibfehler bringen die Basis nicht zum Absturz', async () => {
  const ordner = await temp();
  try {
    const p = new Protokoll({ ordner, konsole: false });
    p.fehlerDatei = path.join(ordner, 'gibt', 'es', 'nicht', 'fehler.log');
    assert.doesNotThrow(() => p.fehler('Test', 'geht ins Leere'));
    assert.deepEqual(p.lesen(), []);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('melde: nutzt Stufen-Methoden oder fällt auf einfache Funktion zurück', () => {
  const aufrufe = [];
  const log = (t) => aufrufe.push(['text', t]);
  melde(log, 'fehler', 'Update', 'kaputt');
  log.fehler = (q, m) => aufrufe.push(['fehler', q, m]);
  melde(log, 'fehler', 'Update', 'kaputt');
  melde(undefined, 'fehler', 'x', 'y');
  assert.deepEqual(aufrufe, [['text', 'FEHLER: Update: kaputt'], ['fehler', 'Update', 'kaputt']]);
});

test('Neustart: laufende Modulprozesse werden beendet', async () => {
  const modul = { id: 'lang', typ: 'programm', befehl: process.execPath, argumente: ['-e', 'setInterval(() => {}, 1000)'], arbeitsordner: tmpdir(), ordner: tmpdir(), timeoutMs: 30_000, einstellungen: {} };
  const lauf = fuehreAus(modul);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(beendeLaufendeModule(), 1);
  const ergebnis = await lauf;
  assert.equal(ergebnis.status, 'warnung');
  assert.equal(ergebnis.zusammenfassung, 'Prüfung wurde über die Basis beendet.');
  assert.ok(ergebnis.dauerMs < 10_000);
  assert.equal(beendeLaufendeModule(), 0);
});

test('Beenden eines Moduls bricht nur dessen Prüfung ab', async () => {
  const basis = { typ: 'programm', befehl: process.execPath, argumente: ['-e', 'setInterval(() => {}, 1000)'], arbeitsordner: tmpdir(), ordner: tmpdir(), timeoutMs: 30_000, einstellungen: {} };
  const a = fuehreAus({ ...basis, id: 'a' });
  const b = fuehreAus({ ...basis, id: 'b' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(beendeLaufendeModule('a'), 1);
  assert.equal((await a).status, 'warnung');
  assert.equal(beendeLaufendeModule('a'), 0);
  assert.equal(beendeLaufendeModule(), 1);
  await b;
});
