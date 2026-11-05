import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Benachrichtigung, berichtTermine, berichtText, GraphMail, pruefeEinstellungen } from '../basis/benachrichtigung.js';

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

test('Statusbericht: Termine täglich, werktags, wöchentlich, Zeitumstellung, Prüfung der Eingaben', () => {
  const t = (w, iso) => { const r = berichtTermine({ bericht_uhrzeit: '07:30', bericht_wochentag: 1, ...w }, Date.parse(iso)); return [r.letzter && new Date(r.letzter).toISOString(), r.naechster && new Date(r.naechster).toISOString()]; };
  // 05.11.2026 ist ein Donnerstag; Winterzeit: 07:30 Uhr = 06:30 UTC.
  assert.deepEqual(t({ bericht: 'taeglich' }, '2026-11-05T06:29:00Z'), ['2026-11-04T06:30:00.000Z', '2026-11-05T06:30:00.000Z']);
  assert.deepEqual(t({ bericht: 'taeglich' }, '2026-11-05T06:30:00Z'), ['2026-11-05T06:30:00.000Z', '2026-11-06T06:30:00.000Z']);
  assert.deepEqual(t({ bericht: 'werktags' }, '2026-11-08T10:00:00Z'), ['2026-11-06T06:30:00.000Z', '2026-11-09T06:30:00.000Z'], 'Sonntag: letzter am Freitag, nächster am Montag');
  assert.deepEqual(t({ bericht: 'woechentlich', bericht_wochentag: 1 }, '2026-11-05T10:00:00Z'), ['2026-11-02T06:30:00.000Z', '2026-11-09T06:30:00.000Z']);
  assert.deepEqual(t({ bericht: 'woechentlich', bericht_wochentag: 7 }, '2026-11-08T07:00:00Z'), ['2026-11-08T06:30:00.000Z', '2026-11-15T06:30:00.000Z']);
  assert.deepEqual(t({ bericht: 'taeglich' }, '2027-03-28T06:00:00Z'), ['2027-03-28T05:30:00.000Z', '2027-03-29T05:30:00.000Z'], 'Sommerzeit ab dem Umstellungstag');
  assert.deepEqual(t({ bericht: 'taeglich' }, '2026-12-31T23:00:00Z'), ['2026-12-31T06:30:00.000Z', '2027-01-01T06:30:00.000Z'], 'Jahreswechsel');
  assert.deepEqual(t({ bericht: 'aus' }, '2026-11-05T10:00:00Z'), [null, null]);
  assert.equal(berichtText({ bericht: 'woechentlich', bericht_uhrzeit: '08:00', bericht_wochentag: 5 }), 'wöchentlich Freitag 08:00');
  assert.equal(berichtText({ bericht: 'werktags', bericht_uhrzeit: '07:30', bericht_wochentag: 1 }), 'werktags 07:30');
  assert.equal(berichtText({ bericht: 'aus' }), null);

  const { werte } = pruefeEinstellungen({}, { aktiv: false, tenant_id: '', client_id: '', client_secret: '', absender: '', empfaenger: [], erinnerung_stunden: 4, melden_nach_laeufen: 1, link: '' });
  assert.deepEqual([werte.bericht, werte.bericht_uhrzeit, werte.bericht_wochentag], ['aus', '07:30', 1], 'Standard: aus');
  assert.deepEqual(pruefeEinstellungen({ bericht: 'woechentlich', bericht_uhrzeit: ' 18:05 ', bericht_wochentag: '5' }, werte).werte.bericht_wochentag, 5);
  const { feldfehler } = pruefeEinstellungen({ bericht: 'stündlich', bericht_uhrzeit: '24:00', bericht_wochentag: 8 }, werte);
  assert.deepEqual(Object.keys(feldfehler).sort(), ['bericht', 'bericht_uhrzeit', 'bericht_wochentag']);
});

test('Statusbericht: einmal je Termin, nicht doppelt nach Neustart, nachholen bis 12 h, Fehlschlag wiederholt', async () => {
  let senden = 202;
  const u = await aufbau({ sendStatus: () => senden });
  try {
    // Uhr: Do 29.10.2026, 13:00 Ortszeit. Bericht täglich 13:30, ab jetzt (der gestrige Termin wird nicht nachgeholt).
    await u.b.speichern({ bericht: 'taeglich', bericht_uhrzeit: '13:30' }, 'patrick');
    await u.b.modulEmpfaengerSpeichern('ftp', 'lager@firma.de', 'patrick');
    u.b.basisInfo = () => ({ version: '0.14.0', seit: Date.parse('2026-10-28T12:00:00Z'), update: '0.15.0' });
    assert.equal(u.b.ansicht().bericht.text, 'täglich 13:30');
    assert.equal(u.b.ansicht().bericht.naechster, '2026-10-29T12:30:00.000Z');
    const module = [
      { id: 'a-ok', name: 'Zentrale OK', anzeige: 'ok' },
      { id: 'pause', name: 'Pausiertes Modul', anzeige: 'inaktiv' },
      { id: 'ftp', name: 'FTP-Dateialter', anzeige: 'fehler', problemLaeufe: 0 },
      { id: 'b', name: 'Backup', anzeige: 'keine-meldung', problemLaeufe: 0 },
    ];
    const berichte = () => u.ms.mails().filter((m) => m.message.subject.includes('Statusbericht'));
    await u.b.pruefen(module);
    assert.equal(berichte().length, 0, 'vor 13:30 kein Bericht');

    u.vor(31);
    await u.b.pruefen(module);
    assert.equal(berichte().length, 1);
    const m = berichte()[0].message;
    assert.equal(m.subject, '[Monitoring] Statusbericht: 2 Probleme');
    assert.deepEqual(m.toRecipients.map((r) => r.emailAddress.address), ['it@firma.de', 'chef@firma.de'], 'nur allgemeine Empfänger');
    const zeilen = m.body.content.split('\n');
    assert.match(m.body.content, /Gesamt: 2 Probleme \(1 Fehler, 1 Keine Meldung\)/);
    assert.match(m.body.content, /Basis: läuft seit 28\.10\.26, 13:00 \(25 h\) · v0\.14\.0 · Update auf v0\.15\.0 verfügbar/);
    assert.deepEqual(zeilen.filter((z) => z.startsWith('- ')), ['- FTP-Dateialter: Fehler', '- Backup: Keine Meldung', '- Pausiertes Modul: Pausiert', '- Zentrale OK: OK']);
    assert.match(m.body.content, /Oberfläche: http:\/\/10\.0\.0\.5:8080\//);
    assert.doesNotMatch(m.body.content, /verspätet/i);

    await u.b.pruefen(module);
    u.vor(60);
    await u.b.pruefen(module);
    const b2 = u.neu();
    await b2.laden();
    await b2.pruefen(module);
    assert.equal(berichte().length, 1, 'kein zweiter Bericht für denselben Termin, auch nicht nach Neustart');

    // Basis war zur Berichtszeit aus: am nächsten Tag um 16:30 nachgeholt.
    u.vor(24 * 60 + 120);
    const b3 = u.neu();
    await b3.laden();
    await b3.pruefen([{ id: 'a-ok', name: 'Zentrale OK', anzeige: 'ok' }]);
    assert.equal(berichte().length, 2);
    assert.equal(berichte()[1].message.subject, '[Monitoring] Statusbericht: alles OK (verspätet)');
    assert.match(berichte()[1].message.body.content, /Verspätet: geplant für 30\.10\.26, 13:30/);
    assert.match(berichte()[1].message.body.content, /Gesamt: alles OK/);

    // Mehr als 12 Stunden zu spät: nicht mehr nachholen.
    u.vor(24 * 60 + 11 * 60);
    const b4 = u.neu();
    await b4.laden();
    await b4.pruefen(module);
    assert.equal(berichte().length, 2);
    assert.ok(u.meldungen.some(([, t]) => /Statusbericht für 31\.10\.26, 13:30 nicht nachgeholt/.test(t)));

    // Versand schlägt fehl: nach 5 Minuten erneut, dann ok.
    u.vor(24 * 60 - 14 * 60 + 2);
    senden = 503;
    await b4.pruefen(module);
    assert.equal(b4.ansicht().verlauf[0].ok, false);
    u.vor(2);
    await b4.pruefen(module);
    assert.equal(u.ms.mails().length, 5 + 1, 'innerhalb von 5 Minuten kein neuer Versuch');
    senden = 202;
    u.vor(4);
    await b4.pruefen(module);
    assert.equal(b4.ansicht().verlauf[0].ok, true);
    assert.equal(b4.ansicht().verlauf[0].art, 'bericht');
    await b4.pruefen(module);
    assert.equal(berichte().length, 4, 'zwei Versuche für den 01.11., danach nichts mehr');
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});

test('Statusbericht: aus, Benachrichtigung inaktiv, „jetzt senden“ und neuer Zeitplan ohne Nachholen', async () => {
  const u = await aufbau();
  try {
    const berichte = () => u.ms.mails().filter((m) => m.message.subject.includes('Statusbericht'));
    u.vor(24 * 60);
    await u.b.pruefen([]);
    assert.equal(berichte().length, 0, 'Standard aus');
    // Zeitplan für 08:00 einschalten, obwohl es schon 13:00 ist: heute kein Bericht mehr.
    await u.b.speichern({ bericht: 'taeglich', bericht_uhrzeit: '08:00' }, 'patrick');
    await u.b.pruefen([]);
    assert.equal(berichte().length, 0, 'vergangener Termin wird nach dem Einschalten nicht nachgeholt');
    assert.ok(u.meldungen.some(([, t]) => /Benachrichtigung geändert durch patrick: bericht, bericht_uhrzeit/.test(t)));

    // Benachrichtigung aus: kein geplanter Bericht.
    await u.b.speichern({ aktiv: false }, 'patrick');
    u.vor(24 * 60);
    await u.b.pruefen([]);
    assert.equal(berichte().length, 0);

    // „Jetzt senden“ geht auch dann (wie die Testmail), solange alles eingetragen ist.
    const e = await u.b.berichtSenden([], 'patrick');
    assert.equal(e.ok, true);
    assert.equal(berichte()[0].message.subject, '[Monitoring] Statusbericht: alles OK');
    assert.match(berichte()[0].message.body.content, /Keine Module eingerichtet\./);
    assert.ok(u.meldungen.some(([, t]) => /Statusbericht ausgelöst durch patrick/.test(t)));
  } finally {
    await rm(u.ordner, { recursive: true, force: true });
  }
});
