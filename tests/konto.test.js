import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { kontoErmitteln, kontoPruefen, schreibrechtePruefen } from '../basis/konto.js';

// Ausgaben von „whoami /user /fo csv /nh“ und „whoami /groups /fo csv /nh“ (deutsches Windows).
function whoami(benutzer, gruppen, { code = 0, gruppenCode = 0 } = {}) {
  const aufrufe = [];
  return {
    aufrufe,
    ausfuehren: async (programm, args) => {
      aufrufe.push([programm, ...args]);
      if (args[0] === '/user') return { code, ausgabe: `"${benutzer[0]}","${benutzer[1]}"\r\n` };
      return { code: gruppenCode, ausgabe: gruppen.map(([n, s, a = 'Verbindliche Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe']) => `"${n}","Bekannte Gruppe","${s}","${a}"`).join('\r\n') };
    },
  };
}
const DOMAENE = 'S-1-5-21-111-222-333';
const NUTZER = ['Jeder', 'S-1-1-0'];

test('Konto ermitteln: Dienstkonto, SYSTEM, Admin (auch nur zum Verweigern), Domänen-Admins, Fehler', async () => {
  const svc = whoami(['konsum-weimar\\svc-monitoring', `${DOMAENE}-1450`], [NUTZER, ['KONSUM-WEIMAR\\Domänen-Benutzer', `${DOMAENE}-513`], ['VORDEFINIERT\\Benutzer', 'S-1-5-32-545']]);
  assert.deepEqual(await kontoErmitteln({ ausfuehren: svc.ausfuehren, plattform: 'win32' }), { name: 'konsum-weimar\\svc-monitoring', sid: `${DOMAENE}-1450`, system: false, admin: false });
  assert.deepEqual(svc.aufrufe, [['whoami', '/user', '/fo', 'csv', '/nh'], ['whoami', '/groups', '/fo', 'csv', '/nh']]);

  const system = whoami(['nt-autorität\\system', 'S-1-5-18'], [NUTZER]);
  assert.deepEqual(await kontoErmitteln({ ausfuehren: system.ausfuehren, plattform: 'win32' }), { name: 'nt-autorität\\system', sid: 'S-1-5-18', system: true, admin: true });

  // Admin mit Benutzerkontensteuerung: Gruppe „nur zum Verweigern“ – trotzdem ein Admin-Konto.
  const uac = whoami(['we-vm\\patrick', `${DOMAENE}-1001`], [NUTZER, ['VORDEFINIERT\\Administratoren', 'S-1-5-32-544', 'Nur für Verweigern verwendete Gruppe']]);
  assert.equal((await kontoErmitteln({ ausfuehren: uac.ausfuehren, plattform: 'win32' })).admin, true);
  for (const rid of [512, 518, 519]) {
    const d = whoami(['konsum-weimar\\x', `${DOMAENE}-2000`], [NUTZER, ['KONSUM-WEIMAR\\Admins', `${DOMAENE}-${rid}`]]);
    assert.equal((await kontoErmitteln({ ausfuehren: d.ausfuehren, plattform: 'win32' })).admin, true, String(rid));
  }
  // Eine Gruppe, deren RID nur zufällig mit 512 beginnt, ist keine Admin-Gruppe.
  const aehnlich = whoami(['konsum-weimar\\x', `${DOMAENE}-2000`], [NUTZER, ['KONSUM-WEIMAR\\Andere', `${DOMAENE}-5120`]]);
  assert.equal((await kontoErmitteln({ ausfuehren: aehnlich.ausfuehren, plattform: 'win32' })).admin, false);
  assert.equal(await kontoErmitteln({ ausfuehren: whoami(['x', 'kaputt'], []).ausfuehren, plattform: 'win32' }), null);
  assert.equal(await kontoErmitteln({ ausfuehren: whoami(['x', 'S-1-5-18'], [], { code: 1 }).ausfuehren, plattform: 'win32' }), null);
  // Gruppen nicht lesbar: lieber „unbekannt“ als fälschlich „kein Admin“.
  assert.equal(await kontoErmitteln({ ausfuehren: whoami(['x', `${DOMAENE}-2000`], [], { gruppenCode: 1 }).ausfuehren, plattform: 'win32' }), null);
  const linux = await kontoErmitteln({ plattform: 'linux' });
  assert.equal(typeof linux.name, 'string');
  assert.equal(linux.system, false);
});

test('Schreibrechte prüfen: fehlende Ordner übersprungen, kein Schreibzugriff gemeldet, keine Reste', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-konto-'));
  try {
    const daten = path.join(wurzel, 'data');
    await mkdir(daten);
    const config = path.join(wurzel, 'config.json');
    await writeFile(config, '{"a":1}');
    // Eine Datei statt eines Ordners: dort lässt sich nichts anlegen (wie ohne Schreibrecht).
    const keinOrdner = path.join(wurzel, 'logs');
    await writeFile(keinOrdner, 'x');
    assert.deepEqual(await schreibrechtePruefen({ ordner: [wurzel, daten, path.join(wurzel, 'versionen'), keinOrdner], datei: config }), [keinOrdner]);
    assert.deepEqual((await readdir(daten)), [], 'Probedatei wieder gelöscht');
    assert.deepEqual(await schreibrechtePruefen({ ordner: [], datei: wurzel }), [wurzel], 'Ordner statt config.json');
    assert.deepEqual(await schreibrechtePruefen({ ordner: [], datei: path.join(wurzel, 'fehlt.json') }), []);
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Konto prüfen: Meldungen für SYSTEM, Admin, Dienstkonto, unbekannt und fehlende Rechte', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-konto-'));
  try {
    const lauf = async (konto, ordner = [wurzel]) => {
      const meldungen = [];
      const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', m]), fehler: (q, m) => meldungen.push(['fehler', m]) });
      const ergebnis = await kontoPruefen({ ordner, datei: null, log, ermitteln: async () => konto });
      return { ergebnis, meldungen };
    };
    const system = await lauf({ name: 'nt-autorität\\system', system: true, admin: true });
    assert.deepEqual(system.ergebnis, { name: 'nt-autorität\\system', system: true, admin: true, fehlt: [] });
    assert.match(system.meldungen[0][1], /läuft als SYSTEM\. Empfohlen ist ein eigenes Dienstkonto ohne Admin-Rechte\. Auf dem Worker als Admin werkzeuge\\konto-einrichten\.ps1 ausführen/);
    assert.equal(system.meldungen[0][0], 'warnung');
    const admin = await lauf({ name: 'we-vm\\patrick', system: false, admin: true });
    assert.deepEqual(admin.meldungen.map(([s]) => s), ['warnung']);
    assert.match(admin.meldungen[0][1], /we-vm\\patrick mit Administratorrechten/);
    const svc = await lauf({ name: 'konsum-weimar\\svc-monitoring', system: false, admin: false });
    assert.deepEqual(svc.meldungen, [['info', 'Die Basis läuft unter dem Konto konsum-weimar\\svc-monitoring (kein Admin).']]);
    const datei = path.join(wurzel, 'datei');
    await writeFile(datei, 'x');
    const ohneRecht = await lauf({ name: 'konsum-weimar\\svc-monitoring', system: false, admin: false }, [wurzel, datei]);
    assert.deepEqual(ohneRecht.ergebnis.fehlt, [datei]);
    assert.equal(ohneRecht.meldungen[1][0], 'fehler');
    assert.match(ohneRecht.meldungen[1][1], /darf nicht schreiben in: .*datei\. Auf dem Worker als Admin/);
    const unbekannt = await lauf(null);
    assert.equal(unbekannt.ergebnis, null);
    assert.match(unbekannt.meldungen[0][1], /ließ sich nicht ermitteln/);
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});
