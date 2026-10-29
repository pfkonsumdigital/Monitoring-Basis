import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Benachrichtigung, GraphMail, pruefeEinstellungen } from '../basis/benachrichtigung.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SCHLUESSEL = 'Sehr~Geheimer~Schluessel~123';

// Simuliertes Microsoft 365: Token-Endpunkt und sendMail.
function microsoft({ tokenStatus = 200, sendStatus = 202 } = {}) {
  const aufrufe = [];
  const fetchImpl = async (url, opt) => {
    aufrufe.push({ url, opt });
    if (url.includes('/oauth2/v2.0/token')) {
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }), { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: `tok-${aufrufe.length}`, expires_in: 3599 }), { status: 200 });
    }
    const status = typeof sendStatus === 'function' ? sendStatus() : sendStatus;
    return new Response(status === 202 ? null : JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status });
  };
  return { fetchImpl, aufrufe, mails: () => aufrufe.filter((a) => a.url.includes('/sendMail')).map((a) => ({ url: a.url, ...JSON.parse(a.opt.body), auth: a.opt.headers.authorization })) };
}

const EINSTELLUNGEN = { aktiv: true, tenant_id: TENANT, client_id: CLIENT, client_secret: SCHLUESSEL, absender: 'monitoring@firma.de', empfaenger: 'it@firma.de; chef@firma.de', erinnerung_stunden: 4, melden_nach_laeufen: 1, link: 'http://10.0.0.5:8080/' };

test('Graph: Token wird geholt und wiederverwendet, Mail korrekt aufgebaut', async () => {
  const ms = microsoft();
  let uhr = 0;
  const mail = new GraphMail({ tenantId: TENANT, clientId: CLIENT, clientSecret: SCHLUESSEL, absender: 'monitoring@firma.de', fetchImpl: ms.fetchImpl, jetzt: () => uhr });
  await mail.senden({ an: ['it@firma.de'], betreff: 'B1', text: 'T1' });
  uhr += 30 * 60_000;
  await mail.senden({ an: ['it@firma.de'], betreff: 'B2', text: 'T2' });
  assert.equal(ms.aufrufe.filter((a) => a.url.includes('token')).length, 1, 'Token wiederverwendet');
  const tokenAufruf = ms.aufrufe[0];
  assert.equal(tokenAufruf.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(new URLSearchParams(tokenAufruf.opt.body.toString()).get('grant_type'), 'client_credentials');
  const [m1] = ms.mails();
  assert.equal(m1.url, 'https://graph.microsoft.com/v1.0/users/monitoring%40firma.de/sendMail');
  assert.equal(m1.auth, 'Bearer tok-1');
  assert.deepEqual(m1.message, { subject: 'B1', body: { contentType: 'Text', content: 'T1' }, toRecipients: [{ emailAddress: { address: 'it@firma.de' } }] });
  assert.equal(m1.saveToSentItems, false);
  uhr += 60 * 60_000;
  await mail.senden({ an: ['it@firma.de'], betreff: 'B3', text: 'T3' });
  assert.equal(ms.aufrufe.filter((a) => a.url.includes('token')).length, 2, 'abgelaufenes Token wird erneuert');
});

test('Graph: verständliche Fehler für Anmeldung, Berechtigung und Netzwerk', async () => {
  const neu = (opt, fetchImpl) => new GraphMail({ tenantId: TENANT, clientId: CLIENT, clientSecret: SCHLUESSEL, absender: 'monitoring@firma.de', fetchImpl: fetchImpl ?? microsoft(opt).fetchImpl });
  await assert.rejects(neu({ tokenStatus: 401 }).senden({ an: ['a@b.de'], betreff: 'x', text: 'y' }), /Anmeldung bei Microsoft fehlgeschlagen \(AADSTS7000215\)/);
  await assert.rejects(neu({ sendStatus: 403 }).senden({ an: ['a@b.de'], betreff: 'x', text: 'y' }), /nicht als monitoring@firma\.de senden.*RBAC/);
  await assert.rejects(neu({ sendStatus: 404 }).senden({ an: ['a@b.de'], betreff: 'x', text: 'y' }), /nicht gefunden/);
  await assert.rejects(neu({}, async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }).senden({ an: ['a@b.de'], betreff: 'x', text: 'y' }), /nicht erreichbar \(ENOTFOUND\)/);
});

test('Einstellungen: Prüfung, Pflichtfelder bei aktiv, Schlüssel bleibt erhalten', () => {
  const leer = { aktiv: false, tenant_id: '', client_id: '', client_secret: '', absender: '', empfaenger: [], erinnerung_stunden: 4, melden_nach_laeufen: 1, link: '' };
  const { werte } = pruefeEinstellungen(EINSTELLUNGEN, leer);
  assert.deepEqual(werte.empfaenger, ['it@firma.de', 'chef@firma.de']);
  assert.equal(pruefeEinstellungen({ ...EINSTELLUNGEN, client_secret: '' }, werte).werte.client_secret, SCHLUESSEL, 'leer = behalten');
  const { feldfehler } = pruefeEinstellungen({ aktiv: true, client_id: 'abc', absender: 'kein-mail', empfaenger: 'x@y.de, falsch', melden_nach_laeufen: 0, erinnerung_stunden: -1, link: 'ftp://x' }, leer);
  assert.deepEqual(Object.keys(feldfehler).sort(), ['absender', 'client_id', 'client_secret', 'empfaenger', 'erinnerung_stunden', 'link', 'melden_nach_laeufen', 'tenant_id']);
  assert.match(feldfehler.empfaenger, /falsch/);
  assert.equal(pruefeEinstellungen({ tenant_id: 'firma.onmicrosoft.com' }, leer).werte.tenant_id, 'firma.onmicrosoft.com');
  assert.ok(pruefeEinstellungen({ aktiv: false }, leer).werte, 'inaktiv ohne Angaben erlaubt');
});

async function aufbau(opt = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-ben-'));
  const ms = microsoft(opt);
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', m]), fehler: (q, m) => meldungen.push(['fehler', m]) });
  let uhr = Date.parse('2026-10-29T12:00:00Z');
  const geheimnisse = [];
  const neu = () => new Benachrichtigung({ datenOrdner: ordner, log, geheimnisse, fetchImpl: ms.fetchImpl, jetzt: () => uhr });
  const b = neu();
  await b.laden();
  await b.speichern(EINSTELLUNGEN, 'patrick');
  return { ordner, ms, meldungen, b, neu, geheimnisse, vor: (min) => { uhr += min * 60_000; }, uhr: () => uhr };
}

const modul = (anzeige, extra = {}) => ({ id: 'ftp', name: 'FTP-Dateialter', anzeige, problemLaeufe: anzeige === 'ok' ? 0 : 1, letztes: { zusammenfassung: extra.text ?? anzeige, details: extra.details ?? [], ende: '2026-10-29T11:59:00Z' }, ...extra });

test('Benachrichtigung: Wechsel, kein Doppelversand, wieder ok, Erinnerung', async () => {
  const u = await aufbau();
  try {
    const betreffe = () => u.ms.mails().map((m) => m.message.subject);
    await u.b.pruefen([modul('ok')]);
    assert.deepEqual(betreffe(), [], 'ok ohne vorheriges Problem: keine Mail');
    await u.b.pruefen([modul('fehler', { text: 'Login fehlgeschlagen', details: ['530 Login incorrect'], problemSeit: '2026-10-29T11:59:00Z' })]);
    await u.b.pruefen([modul('fehler', { problemLaeufe: 2 })]);
    assert.deepEqual(betreffe(), ['[Monitoring] FEHLER: FTP-Dateialter'], 'nur beim Wechsel');
    const text = u.ms.mails()[0].message.body.content;
    assert.match(text, /Meldung: Login fehlgeschlagen/);
    assert.match(text, /- 530 Login incorrect/);
    assert.match(text, /Oberfläche: http:\/\/10\.0\.0\.5:8080\//);
    assert.deepEqual(u.ms.mails()[0].message.toRecipients.map((r) => r.emailAddress.address), ['it@firma.de', 'chef@firma.de']);

    u.vor(3 * 60);
    await u.b.pruefen([modul('fehler', { problemLaeufe: 30 })]);
    assert.equal(betreffe().length, 1, 'vor Ablauf der Erinnerung nichts');
    u.vor(61);
    await u.b.pruefen([modul('fehler', { problemLaeufe: 50 })]);
    assert.match(betreffe()[1], /^\[Monitoring\] ERINNERUNG: FTP-Dateialter – Fehler seit 4 h$/);

    // Neustart der Basis: Zustand bleibt, keine doppelte Mail.
    const b2 = u.neu();
    await b2.laden();
    await b2.pruefen([modul('fehler', { problemLaeufe: 51 })]);
    assert.equal(betreffe().length, 2);

    await b2.pruefen([modul('warnung')]);
    await b2.pruefen([modul('keine-meldung', { problemLaeufe: 0 })]);
    await b2.pruefen([modul('inaktiv')]);
    await b2.pruefen([modul('ok')]);
    assert.deepEqual(betreffe().slice(2), ['[Monitoring] WARNUNG: FTP-Dateialter', '[Monitoring] KEINE MELDUNG: FTP-Dateialter', '[Monitoring] WIEDER OK: FTP-Dateialter']);
    assert.equal(b2.ansicht().verlauf.length, 5);
    assert.equal(b2.ansicht().verlauf[0].art, 'wieder-ok');
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});

test('Benachrichtigung: erst nach eingestellter Anzahl Läufe; Modulfehler sofort', async () => {
  const u = await aufbau();
  try {
    await u.b.speichern({ melden_nach_laeufen: 3 }, 'patrick');
    await u.b.pruefen([modul('fehler', { problemLaeufe: 1 })]);
    await u.b.pruefen([modul('fehler', { problemLaeufe: 2 })]);
    assert.equal(u.ms.mails().length, 0);
    await u.b.pruefen([modul('fehler', { problemLaeufe: 3 })]);
    assert.equal(u.ms.mails().length, 1);
    await u.b.pruefen([modul('ok'), { id: 'kaputt', name: 'Kaputt', anzeige: 'modulfehler', problemLaeufe: 0, fehler: 'module.json: befehl fehlt', letztes: null }]);
    assert.deepEqual(u.ms.mails().map((m) => m.message.subject).slice(1), ['[Monitoring] WIEDER OK: FTP-Dateialter', '[Monitoring] FEHLER: Kaputt']);
    assert.match(u.ms.mails()[2].message.body.content, /Problem: module\.json: befehl fehlt/);
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});

test('Benachrichtigung: Fehlschlag wird protokolliert und nach 5 Minuten wiederholt; aus = keine Mails', async () => {
  let status = 403;
  const u = await aufbau({ sendStatus: () => status });
  try {
    await u.b.pruefen([modul('fehler')]);
    assert.equal(u.b.ansicht().verlauf[0].ok, false);
    assert.ok(u.meldungen.some(([s, m]) => s === 'fehler' && /RBAC/.test(m)));
    status = 202;
    u.vor(2);
    await u.b.pruefen([modul('fehler')]);
    assert.equal(u.ms.mails().length, 1, 'innerhalb von 5 Minuten kein neuer Versuch');
    u.vor(4);
    await u.b.pruefen([modul('fehler')]);
    assert.equal(u.ms.mails().length, 2);
    assert.equal(u.b.ansicht().verlauf[0].ok, true);

    await u.b.speichern({ aktiv: false }, 'patrick');
    await u.b.pruefen([modul('ok')]);
    assert.equal(u.ms.mails().length, 2);
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});

test('Benachrichtigung: Schlüssel nie in der Ansicht, im Geheimnisfilter, Testmail', async () => {
  const u = await aufbau();
  try {
    const sicht = u.b.ansicht();
    assert.deepEqual(sicht.werte.client_secret, { gesetzt: true });
    assert.doesNotMatch(JSON.stringify(sicht), /Sehr~Geheimer/);
    assert.ok(u.geheimnisse.includes(SCHLUESSEL));
    assert.ok(u.meldungen.some(([, m]) => /Benachrichtigung geändert durch patrick: .*geheimer Schlüssel/.test(m)));
    assert.doesNotMatch(u.meldungen.map(([, m]) => m).join('\n'), /Sehr~Geheimer/);
    const test = await u.b.testmail('patrick');
    assert.equal(test.ok, true);
    assert.equal(u.ms.mails()[0].message.subject, '[Monitoring] Testmail');
    assert.match(await readFile(path.join(u.ordner, 'benachrichtigung.json'), 'utf8'), /monitoring@firma\.de/);
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});

test('Benachrichtigung: Dienst gestoppt sofort melden, beendete Module nicht; Mail beim Beenden der Basis', async () => {
  const u = await aufbau();
  try {
    const betreffe = () => u.ms.mails().map((m) => m.message.subject);
    const dienst = { name: 'MonitoringFTP', zustand: 'gestoppt', fehler: null };
    await u.b.pruefen([modul('dienst-gestoppt', { problemLaeufe: 0, dienst })]);
    assert.deepEqual(betreffe(), ['[Monitoring] DIENST GESTOPPT: FTP-Dateialter']);
    assert.match(u.ms.mails()[0].message.body.content, /Problem: Windows-Dienst „MonitoringFTP“ ist gestoppt\./);
    await u.b.pruefen([modul('beendet', { problemLaeufe: 0 })]);
    u.vor(5 * 60);
    await u.b.pruefen([modul('beendet', { problemLaeufe: 0 })]);
    assert.equal(betreffe().length, 1, 'beendet: keine Mail, keine Erinnerung');

    await u.b.basisBeendet('patrick', true, ['Gesperrt: Keine Berechtigung.']);
    assert.equal(betreffe()[1], '[Monitoring] Basis beendet durch patrick');
    const text = u.ms.mails()[1].message.body.content;
    assert.match(text, /keine Module überwacht/);
    assert.match(text, /eigenständigen Module wurden ebenfalls beendet/);
    assert.match(text, /Nicht beendet:\n- Gesperrt: Keine Berechtigung\./);
    assert.match(text, /Start\.exe/);
    assert.equal(u.b.ansicht().verlauf[0].art, 'basis-beendet');

    await u.b.speichern({ aktiv: false }, 'patrick');
    assert.equal(await u.b.basisBeendet('patrick', false), null, 'aus = keine Mail');
    assert.equal(betreffe().length, 2);
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});
