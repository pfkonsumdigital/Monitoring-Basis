import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { groesse, Speicherbelegung } from '../basis/speicherbelegung.js';
import { Modulupdates } from '../basis/modulupdates.js';
import { Protokoll } from '../basis/protokoll.js';

// Speicherbelegung (0.18.0) und Zeitraum-Filter im Fehlerprotokoll.

const datei = async (p, bytes) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, Buffer.alloc(bytes, 120)); };

async function installation() {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-sp-'));
  const w = (...t) => path.join(wurzel, ...t);
  await datei(w('Start.exe'), 1000);
  await datei(w('config.json'), 200);
  await datei(w('runtime', 'node.exe'), 5000);
  await datei(w('versionen', '0.16.0', 'basis', 'main.js'), 3000);
  await datei(w('versionen', '0.17.0', 'basis', 'main.js'), 3100);
  await datei(w('logs', 'basis.log'), 400);
  await datei(w('logs', 'basis.log.1'), 700);
  await datei(w('logs', 'fehler.log.2'), 300);
  await datei(w('logs', 'starter-ausgabe.log'), 50);
  await datei(w('data', 'benachrichtigung.json'), 100);
  await datei(w('data', 'ergebnisse', 'ftp.json'), 2000);
  await datei(w('data', 'ergebnisse', 'weg.json'), 77); // Modul gibt es nicht mehr → übrige Daten
  await datei(w('data', 'modul-versionen', 'ftp', '2.2.0-a', 'module.json'), 600);
  await datei(w('data', 'modul-versionen', 'ftp', '2.1.0-b', 'module.json'), 500);
  await datei(w('modules', 'ftp', 'module.json'), 800);
  await datei(w('modules', 'ftp', 'winscp', 'WinSCP.exe'), 9000);
  await datei(w('modules', 'speicher', 'module.json'), 150);
  return { wurzel, w };
}

const neuBelegung = (w, extra = {}) => new Speicherbelegung({
  installOrdner: w(), datenOrdner: w('data'), moduleOrdner: w('modules'), logOrdner: w('logs'),
  module: () => [{ id: 'ftp', name: 'FTP: Dateialter' }], statfsImpl: async () => ({ blocks: 1000, bsize: 4096, bavail: 250 }), ...extra,
});

test('Speicherbelegung: Aufteilung Basis/Module, Summen, Laufwerk, Sortierung', async () => {
  const { wurzel, w } = await installation();
  try {
    const b = await neuBelegung(w).bericht();
    const teil = Object.fromEntries(b.basis.map((t) => [t.teil, t]));
    assert.equal(teil.versionen.bytes, 6100);
    assert.equal(teil.versionen.anzahl, 2);
    assert.equal(teil.runtime.bytes, 5000);
    assert.equal(teil.logs.bytes, 1450);
    assert.equal(teil.logs.archiv, 1000, 'nur basis.log.N und fehler.log.N');
    assert.equal(teil.daten.bytes, 177, 'ohne Verlauf und Versionen der vorhandenen Module');
    assert.equal(teil.sonstiges.bytes, 1200, 'Start.exe und config.json');
    assert.deepEqual(b.module.map((m) => [m.id, m.name, m.ordner, m.verlauf, m.versionen, m.versionenAnzahl, m.summe]), [
      ['ftp', 'FTP: Dateialter', 9800, 2000, 1100, 2, 12900],
      ['speicher', 'speicher', 150, 0, 0, 0, 150],
    ], 'größte zuerst; unbekannter Name = Ordnername');
    assert.equal(b.gesamt, 6100 + 5000 + 1450 + 177 + 1200 + 12900 + 150);
    assert.deepEqual(b.laufwerk, { gesamt: 4096000, frei: 1024000 });
    assert.equal(b.unvollstaendig, false);
    assert.equal(b.unlesbarAnzahl, 0);
  } finally { await rm(wurzel, { recursive: true, force: true }); }
});

test('Speicherbelegung: Verknüpfungen werden nicht verfolgt, Obergrenze, Zwischenspeicher', async () => {
  const { wurzel, w } = await installation();
  const fremd = await mkdtemp(path.join(tmpdir(), 'mb-sp-fremd-'));
  try {
    await datei(path.join(fremd, 'gross.bin'), 50_000);
    await symlink(fremd, w('modules', 'ftp', 'verknuepft'));
    await symlink(path.join(fremd, 'gross.bin'), w('data', 'link.bin'));
    await symlink(fremd, w('modules', 'verknuepftes-modul'));
    await symlink(path.join(fremd, 'gross.bin'), w('gross-verknuepft.bin'));
    await datei(w('modules', 'aaa', 'module.json'), 10);
    let uhr = 1_000_000;
    const sp = neuBelegung(w, { jetzt: () => uhr });
    const b1 = await sp.bericht();
    assert.equal(b1.module[0].ordner, 9800, 'Verknüpfung nicht gezählt');
    assert.equal(b1.basis.find((t) => t.teil === 'daten').bytes, 177);
    assert.equal(b1.basis.find((t) => t.teil === 'sonstiges').bytes, 1200, 'verknüpfte Datei und verknüpfter Modulordner zählen nicht');
    assert.deepEqual(b1.module.map((m) => m.id), ['ftp', 'speicher', 'aaa'], 'nach Größe sortiert, nicht nach Namen');

    // Zwischenspeicher: neue Datei erst nach 5 Minuten oder mit „neu“ sichtbar.
    await datei(w('modules', 'speicher', 'neu.bin'), 1000);
    uhr += 4 * 60_000;
    assert.equal((await sp.bericht()).module.find((m) => m.id === 'speicher').ordner, 150);
    assert.equal((await sp.bericht({ neu: true })).module.find((m) => m.id === 'speicher').ordner, 1150);
    await datei(w('modules', 'speicher', 'noch.bin'), 1);
    uhr += 5 * 60_000 + 1;
    assert.equal((await sp.bericht()).module.find((m) => m.id === 'speicher').ordner, 1151);

    // Obergrenze Dateien: Ergebnis als unvollständig markiert.
    const klein = await neuBelegung(w, { maxDateien: 5 }).bericht();
    assert.equal(klein.unvollstaendig, true);
    assert.ok(klein.gesamt < b1.gesamt);
    // Obergrenze Zeit.
    let t = 0;
    const langsam = await neuBelegung(w, { maxZeitMs: 10, jetzt: () => (t += 3) }).bericht();
    assert.equal(langsam.unvollstaendig, true);
  } finally {
    await rm(wurzel, { recursive: true, force: true });
    await rm(fremd, { recursive: true, force: true });
  }
});

test('Speicherbelegung: fehlende Ordner, kein Laufwerk, gleichzeitige Anfragen teilen eine Berechnung', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-sp-leer-'));
  try {
    const w = (...t) => path.join(wurzel, ...t);
    const sp = neuBelegung(w, { statfsImpl: async () => { throw new Error('nicht unterstützt'); } });
    const [a, b] = await Promise.all([sp.bericht(), sp.bericht()]);
    assert.equal(a, b);
    assert.equal(a.gesamt, 0);
    assert.deepEqual(a.module, []);
    assert.equal(a.laufwerk, null);
    assert.equal((await groesse(w('gibt-es-nicht'), { dateien: 10, bis: Infinity })).bytes, 0);
  } finally { await rm(wurzel, { recursive: true, force: true }); }
});

test('Aufräumen: Protokoll-Archiv löschen (aktuelle Dateien bleiben), alte Modulversionen (neueste bleibt)', async () => {
  const { wurzel, w } = await installation();
  try {
    const meldungen = [];
    const sp = neuBelegung(w, { log: (m) => meldungen.push(m) });
    await sp.bericht();
    const r = await sp.protokollArchivLoeschen('patrick');
    assert.deepEqual(r, { geloescht: 2, bytes: 1000 });
    assert.deepEqual((await readdir(w('logs'))).sort(), ['basis.log', 'starter-ausgabe.log']);
    assert.match(meldungen.at(-1), /Protokoll-Archiv gelöscht durch patrick: 2 Datei\(en\)/);
    assert.equal((await sp.bericht()).basis.find((t) => t.teil === 'logs').archiv, 0, 'Zwischenspeicher verworfen');

    // Modulversionen: Sicherungen brauchen eine Version in module.json; die neueste (mtime) bleibt.
    const mv = w('data', 'modul-versionen', 'ftp');
    await writeFile(path.join(mv, '2.2.0-a', 'module.json'), JSON.stringify({ version: '2.2.0' }));
    await writeFile(path.join(mv, '2.1.0-b', 'module.json'), JSON.stringify({ version: '2.1.0' }));
    await datei(path.join(mv, '2.0.0-c', 'module.json'), 10);
    await writeFile(path.join(mv, '2.0.0-c', 'module.json'), JSON.stringify({ version: '2.0.0' }));
    await datei(path.join(mv, '.neu-rest', 'x'), 10);
    const alt = new Date('2026-01-01'), neu = new Date('2026-11-01');
    await utimes(path.join(mv, '2.1.0-b'), alt, alt);
    await utimes(path.join(mv, '2.0.0-c'), alt, alt);
    await utimes(path.join(mv, '2.2.0-a'), neu, neu);
    const mu = new Modulupdates({ verwaltung: { finde: () => null, module: [] }, datenOrdner: w('data'), log: (m) => meldungen.push(m) });
    mu.laufend.set('ftp', Promise.resolve());
    await assert.rejects(mu.aeltereVersionenLoeschen('ftp', 'patrick'), /läuft gerade ein Update/);
    mu.laufend.clear();
    const e = await mu.aeltereVersionenLoeschen('ftp', 'patrick');
    assert.deepEqual(e, { geloescht: 3, behalten: '2.2.0' });
    assert.deepEqual(await readdir(mv), ['2.2.0-a']);
    assert.match(meldungen.at(-1), /Alte Versionen von Modul ftp gelöscht durch patrick: 3, behalten: 2\.2\.0/);
    assert.deepEqual(await mu.aeltereVersionenLoeschen('speicher', 'patrick'), { geloescht: 0, behalten: null }, 'ohne Sicherungen nichts zu tun');
  } finally { await rm(wurzel, { recursive: true, force: true }); }
});

test('Fehlerprotokoll: Zeitraum über rotierte Dateien, Grenzen einschließlich, Zählung, ältester Eintrag', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-zr-'));
  try {
    let uhr = Date.parse('2026-11-01T00:00:00Z');
    const p = new Protokoll({ ordner, konsole: false, maxBytes: 600, maxDateien: 5, jetzt: () => new Date(uhr) });
    for (let i = 0; i < 40; i++) { (i % 2 ? p.warnung : p.fehler).call(p, i % 4 < 2 ? 'Basis' : 'Modul ftp', `Eintrag ${i}`); uhr += 3_600_000; }
    assert.ok((await readdir(ordner)).includes('fehler.log.2'), 'mehrere rotierte Dateien');
    const alle = p.suchen({ anzahl: 1000 });
    const zeiten = alle.eintraege.map((e) => e.zeit);
    assert.equal(alle.gesamt, alle.eintraege.length);
    assert.equal(alle.aeltester, zeiten.at(-1), 'ältester Eintrag = letzter (ältester) Treffer');
    // Zeitraum: Stunde 30 bis 35 (einschließlich).
    const von = Date.parse('2026-11-01T00:00:00Z') + 30 * 3_600_000;
    const bis = von + 5 * 3_600_000;
    const r = p.suchen({ anzahl: 1000, von, bis });
    assert.deepEqual(r.eintraege.map((e) => e.meldung), ['Eintrag 35', 'Eintrag 34', 'Eintrag 33', 'Eintrag 32', 'Eintrag 31', 'Eintrag 30']);
    assert.equal(r.gesamt, 6);
    assert.equal(r.aeltester, alle.aeltester, 'ältester unabhängig vom Filter');
    // Mit Stufe und Quelle; Anzahl begrenzt, Zählung vollständig.
    const f = p.suchen({ anzahl: 2, von, stufe: 'fehler' });
    assert.deepEqual(f.eintraege.map((e) => e.meldung), ['Eintrag 38', 'Eintrag 36']);
    assert.equal(f.gesamt, 5);
    assert.deepEqual(p.suchen({ von, quelle: 'Modul' }).eintraege.map((e) => e.meldung), ['Eintrag 39', 'Eintrag 38', 'Eintrag 35', 'Eintrag 34', 'Eintrag 31', 'Eintrag 30']);
    assert.equal(p.suchen({ bis: Date.parse('2026-10-01') }).gesamt, 0);
    // lesen() bleibt wie bisher (ohne Zeitraum, neueste zuerst).
    assert.deepEqual(p.lesen({ anzahl: 2 }).map((e) => e.meldung), ['Eintrag 39', 'Eintrag 38']);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Fehlerprotokoll: Zeitraum bricht innerhalb einer Datei nicht ab (Uhr zurückgestellt)', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-zr2-'));
  try {
    const zeile = (zeit, meldung) => JSON.stringify({ zeit, stufe: 'fehler', quelle: 'Basis', meldung });
    // Datei in Schreibreihenfolge: nach „B“ wurde die Uhr zurückgestellt („C“ trägt eine ältere Zeit), dann „D“.
    await writeFile(path.join(ordner, 'fehler.log'), [zeile('2026-11-10T10:00:00.000Z', 'B'), zeile('2026-11-01T10:00:00.000Z', 'C'), zeile('2026-11-10T12:00:00.000Z', 'D')].join('\n') + '\n');
    await writeFile(path.join(ordner, 'fehler.log.1'), [zeile('2026-10-01T10:00:00.000Z', 'alt')].join('\n') + '\n');
    const p = new Protokoll({ ordner, konsole: false });
    const r = p.suchen({ von: Date.parse('2026-11-05T00:00:00Z') });
    assert.deepEqual(r.eintraege.map((e) => e.meldung), ['D', 'B']);
    assert.equal(r.aeltester, '2026-10-01T10:00:00.000Z');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});
