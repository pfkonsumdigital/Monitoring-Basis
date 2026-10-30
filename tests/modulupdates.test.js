import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Modulupdates, modulPaketName } from '../basis/modulupdates.js';
import { Modulverwaltung } from '../basis/modulverwaltung.js';
import { Ergebnisspeicher } from '../basis/speicher.js';
import { Planer } from '../basis/planer.js';
import { DienstFehler } from '../basis/dienste.js';

const json = (wert) => JSON.stringify(wert, null, 2);
const lies = async (datei) => JSON.parse(await readFile(datei, 'utf8'));

// Baut ein Modulpaket (tar.gz) wie es das Modul-Repo veröffentlicht.
async function paketBauen(wurzel, inhalt, { verknuepfung = false } = {}) {
  const quelle = await mkdtemp(path.join(wurzel, 'paket-'));
  for (const [datei, text] of Object.entries(inhalt)) {
    await mkdir(path.dirname(path.join(quelle, datei)), { recursive: true });
    await writeFile(path.join(quelle, datei), text);
  }
  if (verknuepfung) await symlink('/etc/passwd', path.join(quelle, 'boese'));
  const datei = path.join(wurzel, `paket-${Math.random().toString(36).slice(2)}.tar.gz`);
  execFileSync('tar', ['-czf', datei, '-C', quelle, '.']);
  return readFile(datei);
}

// Simulierte Updateverwaltung: nur github() und der Token werden gebraucht.
function githubSimuliert({ id, version, paket, pruefsumme, assets = true }) {
  const aufrufe = [];
  return {
    aufrufe,
    updates: { githubToken: 'TOKEN' },
    async github(weg, { binaer = false, zugang } = {}) {
      aufrufe.push([weg, zugang.repo, zugang.githubToken, binaer]);
      if (weg === '/releases/latest') {
        return Response.json({ tag_name: `v${version}`, body: '### Neu\n- Ordnerliste', published_at: '2026-10-30T10:00:00Z',
          assets: assets ? [{ name: modulPaketName(id, version), url: 'https://api.github.com/asset/1', size: paket.length }, { name: `${modulPaketName(id, version)}.sha256`, url: 'https://api.github.com/asset/2', size: 90 }] : [] });
      }
      if (weg.endsWith('/asset/1')) return new Response(paket);
      if (weg.endsWith('/asset/2')) return new Response(`${pruefsumme ?? createHash('sha256').update(paket).digest('hex')}  ${modulPaketName(id, version)}\n`);
      throw new Error(`unerwartet: ${weg}`);
    },
  };
}

function dienste(start = {}) {
  const stand = { ...start };
  const aufrufe = [];
  return {
    aufrufe, stand,
    async zustand(name) { return { zustand: stand[name] ?? 'fehlt' }; },
    async beenden(name) { aufrufe.push(['beenden', name]); if (name === 'Gesperrt') throw new DienstFehler('Keine Berechtigung.', 5); stand[name] = 'gestoppt'; },
    async starten(name) { aufrufe.push(['starten', name]); stand[name] = 'laeuft'; },
  };
}

async function aufbau(modulJson, { dienstStand = {} } = {}) {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-modupd-'));
  const moduleOrdner = path.join(wurzel, 'modules');
  const datenOrdner = path.join(wurzel, 'data');
  const ordner = path.join(moduleOrdner, modulJson.id);
  await mkdir(ordner, { recursive: true });
  await writeFile(path.join(ordner, 'module.json'), json(modulJson));
  await writeFile(path.join(ordner, 'modul.js'), 'alt');
  await writeFile(path.join(ordner, 'einstellungen.json'), json({ server: 'ftp.firma.de' }));
  await writeFile(path.join(ordner, 'status.json'), json({ status: 'ok', zeit: '2026-10-30T09:00:00Z' }));
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', m]), fehler: (q, m) => meldungen.push(['fehler', m]) });
  const speicher = new Ergebnisspeicher(datenOrdner, 50);
  const planer = new Planer({ ausfuehren: async () => ({ status: 'ok', zusammenfassung: 'x' }), speichern: async () => {} });
  const d = dienste(dienstStand);
  const verwaltung = new Modulverwaltung({ moduleOrdner, datenOrdner, speicher, planer, uebernehmen: (i, e) => speicher.hinzufuegen(i, e), dienste: d, abbrechen: () => 0, log });
  await verwaltung.start();
  verwaltung.stop();
  const neu = (gh) => new Modulupdates({ verwaltung, updates: gh, datenOrdner, log, warteMs: 5, maxWartenMs: 200 });
  return { wurzel, ordner, datenOrdner, verwaltung, meldungen, dienste: d, neu };
}

const FTP = { id: 'ftp', name: 'FTP', typ: 'eigenstaendig', version: '1.0.0', repo: 'pfkonsumdigital/Monitoring-Modul-FTP', dienst: 'MonitoringFTP' };

test('Modul-Update: suchen, installieren mit Dienst, Einstellungen bleiben, zurück', async () => {
  const u = await aufbau(FTP, { dienstStand: { MonitoringFTP: 'laeuft' } });
  try {
    const paket = await paketBauen(u.wurzel, {
      'module.json': json({ ...FTP, version: '1.1.0' }), 'modul.js': 'neu', 'lib/hilfe.js': 'x',
      'einstellungen.json': json({ server: 'aus-dem-paket' }), 'status.json': '{}',
    });
    const gh = githubSimuliert({ id: 'ftp', version: '1.1.0', paket });
    const mu = u.neu(gh);
    const st = await mu.suchen('ftp');
    assert.deepEqual([st.installiert, st.verfuegbar.version, st.updateMoeglich, st.vorherige], ['1.0.0', '1.1.0', true, null]);
    assert.deepEqual(gh.aufrufe[0], ['/releases/latest', 'pfkonsumdigital/Monitoring-Modul-FTP', 'TOKEN', false]);
    assert.equal(mu.verfuegbar('ftp'), true);

    await assert.rejects(mu.installieren('ftp', '1.2.0', 'patrick'), /zuerst nach Updates suchen/);
    await mu.installieren('ftp', '1.1.0', 'patrick');
    await mu.laufend.get('ftp');
    const nachher = await mu.status('ftp');
    assert.deepEqual([nachher.phase, nachher.fehler, nachher.installiert, nachher.updateMoeglich, nachher.vorherige], ['bereit', null, '1.1.0', false, '1.0.0']);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'neu');
    assert.equal(await readFile(path.join(u.ordner, 'lib', 'hilfe.js'), 'utf8'), 'x');
    assert.deepEqual(await lies(path.join(u.ordner, 'einstellungen.json')), { server: 'ftp.firma.de' }, 'Einstellungen bleiben, nie aus dem Paket');
    assert.equal((await lies(path.join(u.ordner, 'status.json'))).status, 'ok');
    assert.deepEqual(u.dienste.aufrufe, [['beenden', 'MonitoringFTP'], ['starten', 'MonitoringFTP']]);
    assert.equal(u.verwaltung.ansichten()[0].anzeige, 'ok', 'nach dem Start nicht mehr „beendet“');
    assert.equal(u.verwaltung.finde('ftp').version, '1.1.0', 'Modul neu eingelesen');
    assert.ok(u.meldungen.some(([, m]) => m === 'Modul ftp: Version 1.1.0 installiert (vorher 1.0.0).'));
    assert.deepEqual((await readdir(path.join(u.datenOrdner, 'modul-versionen', 'ftp'))).filter((n) => !n.startsWith('.')).length, 1, 'alte Version gesichert, keine Reste');

    // Einstellungen ändern, dann zurück: alte Programmdateien, aber die neuesten Einstellungen.
    await writeFile(path.join(u.ordner, 'einstellungen.json'), json({ server: 'neu.firma.de' }));
    await mu.zurueck('ftp', 'patrick');
    await mu.laufend.get('ftp');
    assert.equal((await mu.status('ftp')).fehler, null);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'alt');
    assert.equal(u.verwaltung.finde('ftp').version, '1.0.0');
    assert.deepEqual(await lies(path.join(u.ordner, 'einstellungen.json')), { server: 'neu.firma.de' });
    assert.equal((await mu.status('ftp')).vorherige, '1.1.0', 'die ersetzte Version ist jetzt die vorherige');
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: falsche Prüfsumme, falsche Version, Verknüpfung, kein Repo, kein Token – nichts wird geändert', async () => {
  const u = await aufbau(FTP, { dienstStand: { MonitoringFTP: 'laeuft' } });
  try {
    const gut = await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, version: '1.1.0' }), 'modul.js': 'neu' });
    const pruefen = async (gh, muster) => {
      const mu = u.neu(gh);
      await mu.suchen('ftp');
      await mu.installieren('ftp', '1.1.0', 'patrick');
      await mu.laufend.get('ftp');
      const st = await mu.status('ftp');
      assert.equal(st.phase, 'fehler');
      assert.match(st.fehler, muster);
      assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'alt');
      assert.equal(u.verwaltung.finde('ftp').version, '1.0.0');
    };
    await pruefen(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: gut, pruefsumme: 'a'.repeat(64) }), /Prüfsumme/);
    await pruefen(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, version: '1.0.5' }) }) }), /Version 1\.0\.5 statt 1\.1\.0/);
    await pruefen(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, id: 'anders', version: '1.1.0' }) }) }), /module\.json im Paket ist ungültig/);
    await pruefen(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, version: '1.1.0' }) }, { verknuepfung: true }) }), /Verknüpfung/);
    assert.deepEqual(u.dienste.aufrufe, [], 'Dienst nie angefasst');

    const ohneAssets = u.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: gut, assets: false }));
    await ohneAssets.suchen('ftp');
    await assert.rejects(ohneAssets.installieren('ftp', '1.1.0', 'patrick'), /kein vollständiges Paket \(ftp-1\.1\.0\.tar\.gz/);
    await assert.rejects(u.neu({ updates: {}, github: async () => {} }).suchen('ftp'), /Kein GitHub-Token/);
    const ohneRepo = await aufbau({ ...FTP, repo: undefined });
    try { await assert.rejects(ohneRepo.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket: gut })).suchen('ftp'), /kein GitHub-Repo/); }
    finally { await rm(ohneRepo.wurzel, { recursive: true, force: true }); }
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: Dienst lässt sich nicht beenden – Fehler, kein „Beendet“, nichts geändert', async () => {
  const u = await aufbau({ ...FTP, dienst: 'Gesperrt' }, { dienstStand: { Gesperrt: 'laeuft' } });
  try {
    const paket = await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, dienst: 'Gesperrt', version: '1.1.0' }) });
    const mu = u.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket }));
    await mu.suchen('ftp');
    await mu.installieren('ftp', '1.1.0', 'patrick');
    await mu.laufend.get('ftp');
    assert.match((await mu.status('ftp')).fehler, /Gesperrt konnte nicht beendet werden: Keine Berechtigung/);
    assert.equal(u.verwaltung.ansichten()[0].beendet, null);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'alt');
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /^Update: .*Gesperrt/.test(m)));
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: Modul mit befehl.json und von der Basis gestartetes Modul', async () => {
  const eig = await aufbau({ id: 'ordner', name: 'Ordner', typ: 'eigenstaendig', version: '1.0.0', repo: 'a/b', befehlsdatei: true });
  try {
    const paket = await paketBauen(eig.wurzel, { 'module.json': json({ id: 'ordner', name: 'Ordner', typ: 'eigenstaendig', version: '1.1.0', repo: 'a/b', befehlsdatei: true }), 'modul.js': 'neu' });
    const mu = eig.neu(githubSimuliert({ id: 'ordner', version: '1.1.0', paket }));
    await mu.suchen('ordner');
    await mu.installieren('ordner', '1.1.0', 'patrick');
    await mu.laufend.get('ordner');
    const st = await mu.status('ordner');
    assert.equal(st.fehler, null);
    assert.match(st.hinweis, /bitte auf dem Worker wieder starten/);
    assert.equal(eig.verwaltung.ansichten()[0].anzeige, 'beendet', 'bleibt „Beendet“, bis es sich meldet');
    await assert.rejects(readFile(path.join(eig.ordner, 'befehl.json')), /ENOENT/, 'kein alter Befehl in der neuen Version');
  } finally {
    await rm(eig.wurzel, { recursive: true, force: true });
  }

  const prog = await aufbau({ id: 'skript', name: 'Skript', typ: 'programm', befehl: 'x.exe', version: '2.0.0', repo: 'a/c', intervall_minuten: 5 });
  try {
    const paket = await paketBauen(prog.wurzel, { 'module.json': json({ id: 'skript', name: 'Skript', typ: 'programm', befehl: 'y.exe', version: '2.1.0', repo: 'a/c', intervall_minuten: 5 }) });
    const mu = prog.neu(githubSimuliert({ id: 'skript', version: '2.1.0', paket }));
    await mu.suchen('skript');
    await mu.installieren('skript', '2.1.0', 'patrick');
    await mu.laufend.get('skript');
    assert.equal((await mu.status('skript')).fehler, null);
    assert.equal(prog.verwaltung.finde('skript').befehl, 'y.exe');
    assert.equal(prog.verwaltung.ansichten()[0].aktiv, true, 'Pause nach dem Update wieder aufgehoben');
    assert.equal(prog.verwaltung.zustand.skript?.aktiv, undefined, 'kein fest gespeicherter Zustand übrig');
  } finally {
    await rm(prog.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: Einstellungen lassen sich nicht übernehmen – Austausch rückgängig, alte Version läuft weiter', async () => {
  const u = await aufbau(FTP, { dienstStand: { MonitoringFTP: 'laeuft' } });
  try {
    // status.json als Ordner: copyFile scheitert mit einem anderen Fehler als „Datei fehlt“.
    await rm(path.join(u.ordner, 'status.json'));
    await mkdir(path.join(u.ordner, 'status.json'));
    const paket = await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, version: '1.1.0' }), 'modul.js': 'neu' });
    const mu = u.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket }));
    await mu.suchen('ftp');
    await mu.installieren('ftp', '1.1.0', 'patrick');
    await mu.laufend.get('ftp');
    assert.match((await mu.status('ftp')).fehler, /^status\.json konnte nicht in die neue Version übernommen werden \(E[A-Z]+\)\. Der Austausch wurde rückgängig gemacht/);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'alt');
    assert.deepEqual(await lies(path.join(u.ordner, 'einstellungen.json')), { server: 'ftp.firma.de' });
    assert.deepEqual(u.dienste.aufrufe, [['beenden', 'MonitoringFTP'], ['starten', 'MonitoringFTP']], 'alte Version wieder gestartet');
    assert.equal(u.verwaltung.finde('ftp').version, '1.0.0');
    assert.deepEqual((await readdir(path.join(u.datenOrdner, 'modul-versionen', 'ftp'))).filter((n) => !n.startsWith('.')), [], 'keine halbe Sicherung');
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }

  // Fehlt einstellungen.json (Modul nie eingestellt), läuft das Update normal.
  const o = await aufbau(FTP, { dienstStand: { MonitoringFTP: 'laeuft' } });
  try {
    await rm(path.join(o.ordner, 'einstellungen.json'));
    const paket = await paketBauen(o.wurzel, { 'module.json': json({ ...FTP, version: '1.1.0' }), 'modul.js': 'neu' });
    const mu = o.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket }));
    await mu.suchen('ftp');
    await mu.installieren('ftp', '1.1.0', 'patrick');
    await mu.laufend.get('ftp');
    assert.equal((await mu.status('ftp')).fehler, null);
    assert.equal(await readFile(path.join(o.ordner, 'modul.js'), 'utf8'), 'neu');
  } finally {
    await rm(o.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: laufendes Modul bestätigt das Beenden nicht – Update abgebrochen, nichts ausgetauscht', async () => {
  const modul = { id: 'ordner', name: 'Ordner', typ: 'eigenstaendig', version: '1.0.0', repo: 'a/b', befehlsdatei: true, intervall_minuten: 5 };
  const u = await aufbau(modul);
  try {
    // Das Modul hat sich gerade gemeldet, reagiert aber nicht auf befehl.json.
    await u.verwaltung.speicher.hinzufuegen('ordner', { status: 'ok', zusammenfassung: 'x', ende: new Date().toISOString(), beginn: new Date().toISOString() });
    const paket = await paketBauen(u.wurzel, { 'module.json': json({ ...modul, version: '1.1.0' }), 'modul.js': 'neu' });
    const mu = u.neu(githubSimuliert({ id: 'ordner', version: '1.1.0', paket }));
    await mu.suchen('ordner');
    await mu.installieren('ordner', '1.1.0', 'patrick');
    await mu.laufend.get('ordner');
    assert.match((await mu.status('ordner')).fehler, /^Das Modul hat das Beenden nicht innerhalb von 0 Sekunden bestätigt\. Update abgebrochen/);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'alt');
    await assert.rejects(readFile(path.join(u.ordner, 'befehl.json')), /ENOENT/, 'Befehl zurückgenommen');
    assert.equal(u.verwaltung.zustand.ordner?.beendet ?? null, null, 'nicht als „Beendet“ markiert');
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});

test('Modul-Update: vorher gestoppter Dienst bleibt gestoppt, „Beendet“ bleibt erhalten', async () => {
  const u = await aufbau(FTP, { dienstStand: { MonitoringFTP: 'gestoppt' } });
  try {
    const beendet = { zeit: '2026-10-30T08:00:00.000Z', von: 'patrick' };
    await u.verwaltung.zustandAendern('ftp', { beendet });
    const paket = await paketBauen(u.wurzel, { 'module.json': json({ ...FTP, version: '1.1.0' }), 'modul.js': 'neu' });
    const mu = u.neu(githubSimuliert({ id: 'ftp', version: '1.1.0', paket }));
    await mu.suchen('ftp');
    await mu.installieren('ftp', '1.1.0', 'patrick');
    await mu.laufend.get('ftp');
    const st = await mu.status('ftp');
    assert.equal(st.fehler, null);
    assert.match(st.hinweis, /war vorher nicht gestartet und bleibt es/);
    assert.equal(await readFile(path.join(u.ordner, 'modul.js'), 'utf8'), 'neu');
    assert.equal(u.dienste.aufrufe.some(([a]) => a === 'starten'), false, 'kein Start');
    assert.deepEqual(u.verwaltung.zustand.ftp.beendet, beendet);
  } finally {
    await rm(u.wurzel, { recursive: true, force: true });
  }
});
