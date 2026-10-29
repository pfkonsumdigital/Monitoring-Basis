import test from 'node:test';
import assert from 'node:assert/strict';
import { DienstFehler, Dienststeuerung, zustandLesen } from '../basis/dienste.js';

// Simuliertes sc.exe: antwortet je Befehl mit Exitcode und Ausgabe.
function scSimuliert(antworten) {
  const aufrufe = [];
  const execImpl = (datei, argumente, optionen, fertig) => {
    aufrufe.push({ datei, argumente, optionen });
    const [code, ausgabe = ''] = antworten[argumente[0]] ?? [0, ''];
    setImmediate(() => fertig(code === 0 ? null : Object.assign(new Error('Command failed'), { code }), ausgabe, ''));
  };
  return { execImpl, aufrufe };
}

const LAEUFT = 'SERVICE_NAME: MonitoringFTP\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n';
const GESTOPPT_DE = 'SERVICE_NAME: MonitoringFTP\r\n        TYP                : 10  WIN32_OWN_PROCESS\r\n        STATUS             : 1  STOPPED\r\n';

test('sc.exe-Ausgabe lesen: englisch, deutsch, Zwischenzustände, unbekannt', () => {
  assert.equal(zustandLesen(LAEUFT), 'laeuft');
  assert.equal(zustandLesen(GESTOPPT_DE), 'gestoppt');
  assert.equal(zustandLesen('STATE : 3  STOP_PENDING'), 'stoppt');
  assert.equal(zustandLesen('STATE : 2  START_PENDING'), 'startet');
  assert.equal(zustandLesen('TYPE : 10  WIN32_OWN_PROCESS'), 'unbekannt', 'TYPE ist kein Zustand');
  assert.equal(zustandLesen(''), 'unbekannt');
});

test('Dienststeuerung: Zustand, Beenden, Starten über sc.exe ohne Shell', async () => {
  const sc = scSimuliert({ query: [0, LAEUFT] });
  const d = new Dienststeuerung({ execImpl: sc.execImpl, plattform: 'win32' });
  assert.deepEqual(await d.zustand('MonitoringFTP'), { zustand: 'laeuft' });
  await d.beenden('MonitoringFTP');
  await d.starten('MonitoringFTP');
  assert.deepEqual(sc.aufrufe.map((a) => [a.datei, ...a.argumente]), [['sc.exe', 'query', 'MonitoringFTP'], ['sc.exe', 'stop', 'MonitoringFTP'], ['sc.exe', 'start', 'MonitoringFTP']]);
  assert.equal(sc.aufrufe[0].optionen.shell, undefined);
  assert.equal(sc.aufrufe[0].optionen.windowsHide, true);
});

test('Dienststeuerung: bereits gestoppt/läuft ist kein Fehler; sonst verständliche Meldungen', async () => {
  const ok = new Dienststeuerung({ execImpl: scSimuliert({ stop: [1062], start: [1056] }).execImpl, plattform: 'win32' });
  await ok.beenden('Dienst');
  await ok.starten('Dienst');

  const verweigert = new Dienststeuerung({ execImpl: scSimuliert({ stop: [5, '[SC] OpenService FAILED 5:\r\n\r\nAccess is denied.'] }).execImpl, plattform: 'win32' });
  await assert.rejects(verweigert.beenden('Dienst'), (f) => f instanceof DienstFehler && /Keine Berechtigung.*SYSTEM/.test(f.message));

  const fehlt = new Dienststeuerung({ execImpl: scSimuliert({ query: [1060], start: [1060] }).execImpl, plattform: 'win32' });
  assert.deepEqual(await fehlt.zustand('Dienst'), { zustand: 'fehlt', fehler: 'Der Dienst „Dienst“ ist auf diesem Rechner nicht installiert.' });
  await assert.rejects(fehlt.starten('Dienst'), /nicht installiert/);

  const anders = new Dienststeuerung({ execImpl: scSimuliert({ start: [1234, 'Etwas anderes.'] }).execImpl, plattform: 'win32' });
  await assert.rejects(anders.starten('Dienst'), /Fehler 1234 .*Etwas anderes\./);
});

test('Dienststeuerung: ungültige Namen und andere Systeme rufen sc.exe nie auf', async () => {
  const sc = scSimuliert({});
  const d = new Dienststeuerung({ execImpl: sc.execImpl, plattform: 'win32' });
  for (const name of ['', 'a b', 'x&calc', '"x"', '-x', 'a'.repeat(81)]) await assert.rejects(d.beenden(name), /Ungültiger Dienstname/);
  const linux = new Dienststeuerung({ execImpl: sc.execImpl, plattform: 'linux' });
  assert.deepEqual(await linux.zustand('Dienst'), { zustand: 'nicht-verfuegbar' });
  await assert.rejects(linux.starten('Dienst'), /nur unter Windows/);
  assert.equal(sc.aufrufe.length, 0);
});
