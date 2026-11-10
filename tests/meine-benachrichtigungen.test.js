import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Benachrichtigung, pruefeAbo, pruefeEinstellungen } from '../basis/benachrichtigung.js';

// „Meine Benachrichtigungen“: eigene Adresse mit Code, Abos je Modul (Bcc), eigener Statusbericht.

function microsoft() {
  const aufrufe = [];
  let senden = 202;
  const fetchImpl = async (url, opt) => {
    aufrufe.push({ url, opt });
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), { status: 200 });
    return new Response(senden === 202 ? null : JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: senden });
  };
  const mails = () => aufrufe.filter((a) => a.url.includes('/sendMail')).map((a) => {
    const m = JSON.parse(a.opt.body).message;
    return { betreff: m.subject, text: m.body.content, an: m.toRecipients.map((r) => r.emailAddress.address), bcc: (m.bccRecipients ?? []).map((r) => r.emailAddress.address) };
  });
  return { fetchImpl, mails, fehlschlagen: (an) => { senden = an ? 403 : 202; } };
}

const EINSTELLUNGEN = { aktiv: true, tenant_id: '11111111-2222-3333-4444-555555555555', client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', client_secret: 'geheim', absender: 'monitoring@konsum-weimar.de',
  empfaenger: 'it@konsum-weimar.de', erinnerung_stunden: 4, melden_nach_laeufen: 1, link: 'https://monitoring.konsum-weimar.de:8443/' };

async function aufbau() {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-abo-'));
  const ms = microsoft();
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(m), { warnung: (q, m) => meldungen.push(m), fehler: (q, m) => meldungen.push(m) });
  let uhr = Date.parse('2026-11-10T09:00:00Z'); // 10:00 Ortszeit, Dienstag
  const neu = () => new Benachrichtigung({ datenOrdner: ordner, log, fetchImpl: ms.fetchImpl, jetzt: () => uhr });
  const b = neu();
  await b.laden();
  await b.speichern(EINSTELLUNGEN, 'patrick');
  const vor = (min) => { uhr += min * 60_000; };
  // Adresse bestätigen: Code aus der Mail lesen.
  const bestaetigen = async (bb, name, adresse) => {
    const r = await bb.codeAnfordern(name, adresse);
    assert.ok(r.ok, r.fehler);
    const code = /Bestätigungscode: (\d{6})/.exec(ms.mails().at(-1).text)[1];
    assert.ok((await bb.codeBestaetigen(name, code)).ok);
    vor(2);
  };
  return { ordner, ms, b, neu, vor, meldungen, bestaetigen, uhr: () => uhr, aufraeumen: () => rm(ordner, { recursive: true, force: true }) };
}

const modul = (anzeige, id = 'ftp', extra = {}) => ({ id, name: id === 'ftp' ? 'FTP-Dateialter' : 'Speicher', anzeige, problemLaeufe: anzeige === 'ok' ? 0 : 1, letztes: { zusammenfassung: anzeige, details: [] }, ...extra });

test('Adresse: nur erlaubte Domänen, Code per Mail, erst nach Bestätigung aktiv', async () => {
  const u = await aufbau();
  try {
    assert.deepEqual(u.b.meineAnsicht('anna').erlaubteDomains, ['konsum-weimar.de'], 'Standard-Domäne');
    assert.match((await u.b.codeAnfordern('anna', 'anna@gmail.com')).fehler, /nur Adressen mit @konsum-weimar\.de/);
    assert.match((await u.b.codeAnfordern('anna', 'anna@sub.konsum-weimar.de')).fehler, /nur Adressen/, 'Subdomäne zählt nicht');
    assert.match((await u.b.codeAnfordern('anna', 'kein-mail')).fehler, /gültige Mail-Adresse/);
    assert.equal(u.ms.mails().length, 0);

    const r = await u.b.codeAnfordern('anna', 'Anna.Schmidt@Konsum-Weimar.de');
    assert.ok(r.ok);
    const [mail] = u.ms.mails();
    assert.deepEqual(mail.an, ['Anna.Schmidt@Konsum-Weimar.de'], 'nur an die neue Adresse');
    assert.match(mail.betreff, /^\[Monitoring\] Bestätigungscode für anna$/);
    assert.doesNotMatch(mail.betreff, /\d{6}/, 'Code nicht im Betreff');
    assert.equal(r.ansicht.adresse, null, 'noch nicht bestätigt');
    assert.equal(r.ansicht.ausstehend.adresse, 'Anna.Schmidt@Konsum-Weimar.de');
    const code = /Bestätigungscode: (\d{6})/.exec(mail.text)[1];

    assert.match((await u.b.codeBestaetigen('bernd', code)).fehler, /Kein gültiger Code/, 'Code gilt nur für den eigenen Benutzer');
    const falsch = code === '000000' ? '111111' : '000000';
    assert.match((await u.b.codeBestaetigen('anna', falsch)).fehler, /noch 4 Versuche/);
    const ok = await u.b.codeBestaetigen('anna', ` ${code.slice(0, 3)} ${code.slice(3)} `);
    assert.ok(ok.ok, 'Leerzeichen im Code sind egal');
    assert.equal(ok.ansicht.adresse, 'Anna.Schmidt@Konsum-Weimar.de');
    assert.equal(ok.ansicht.ausstehend, null);
    assert.match((await u.b.codeBestaetigen('anna', code)).fehler, /Kein gültiger Code/, 'Code nur einmal');

    // Gespeichert (ohne Code), nach Neustart vorhanden.
    const datei = JSON.parse(await readFile(path.join(u.ordner, 'benachrichtigung-abos.json'), 'utf8'));
    assert.equal(datei.benutzer.anna.adresse, 'Anna.Schmidt@Konsum-Weimar.de');
    assert.doesNotMatch(JSON.stringify(datei), new RegExp(code));
    const b2 = u.neu();
    await b2.laden();
    assert.equal(b2.meineAnsicht('anna').adresse, 'Anna.Schmidt@Konsum-Weimar.de');
    assert.ok(u.meldungen.some((m) => /Adresse für Benachrichtigungen von anna bestätigt/.test(m)));
  } finally { await u.aufraeumen(); }
});

test('Code: Wartezeit, Stundenlimit, Ablauf nach 15 Minuten, 5 Fehlversuche', async () => {
  const u = await aufbau();
  try {
    assert.ok((await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de')).ok);
    const sofort = await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de');
    assert.equal(sofort.status, 429);
    assert.equal(sofort.wartenS, 60);
    assert.ok((await u.b.codeAnfordern('bernd', 'bernd@konsum-weimar.de')).ok, 'andere Benutzer unabhängig');
    for (let i = 0; i < 4; i++) { u.vor(1); assert.ok((await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de')).ok, `Code ${i + 2}`); }
    u.vor(1);
    const limit = await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de');
    assert.equal(limit.status, 429);
    assert.match(limit.fehler, /Zu viele Codes/);
    u.vor(56);
    assert.ok((await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de')).ok, 'nach einer Stunde wieder möglich');

    // Ablauf: nach 15 Minuten ist der Code ungültig.
    const code = /Bestätigungscode: (\d{6})/.exec(u.ms.mails().at(-1).text)[1];
    u.vor(15);
    assert.match((await u.b.codeBestaetigen('anna', code)).fehler, /Kein gültiger Code/);

    // 5 Fehlversuche: Code verfällt, auch der richtige gilt dann nicht mehr.
    u.vor(1);
    await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de');
    const richtig = /Bestätigungscode: (\d{6})/.exec(u.ms.mails().at(-1).text)[1];
    const falsch = richtig === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await u.b.codeBestaetigen('anna', falsch);
    assert.match((await u.b.codeBestaetigen('anna', falsch)).fehler, /neuen Code anfordern/);
    assert.match((await u.b.codeBestaetigen('anna', richtig)).fehler, /Kein gültiger Code/);
    assert.equal(u.b.meineAnsicht('anna').adresse, null);

    // Versand fehlgeschlagen: kein Code offen.
    u.vor(2);
    u.ms.fehlschlagen(true);
    const r = await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de');
    assert.equal(r.status, 502);
    assert.equal(u.b.meineAnsicht('anna').ausstehend, null);
  } finally { await u.aufraeumen(); }
});

test('Adresswechsel: alte Adresse bleibt aktiv, bis die neue bestätigt ist', async () => {
  const u = await aufbau();
  try {
    await u.bestaetigen(u.b, 'anna', 'anna@konsum-weimar.de');
    assert.match((await u.b.codeAnfordern('anna', 'ANNA@konsum-weimar.de')).fehler, /bereits bestätigt/);
    await u.b.codeAnfordern('anna', 'a.schmidt@konsum-weimar.de');
    assert.equal(u.b.meineAnsicht('anna').adresse, 'anna@konsum-weimar.de');
    const code = /Bestätigungscode: (\d{6})/.exec(u.ms.mails().at(-1).text)[1];
    await u.b.codeBestaetigen('anna', code);
    assert.equal(u.b.meineAnsicht('anna').adresse, 'a.schmidt@konsum-weimar.de');
  } finally { await u.aufraeumen(); }
});

test('Abo-Prüfung: Stufen, unbekannte Module fallen weg, Bericht-Zeitplan', () => {
  const { werte } = pruefeAbo({ module: { ftp: 'fehler', speicher: 'alle', alt: 'alle', weg: 'aus' }, entwarnung: true, bericht: 'werktags', bericht_uhrzeit: '06:45' }, {}, ['ftp', 'speicher', 'weg']);
  assert.deepEqual(werte.module, { ftp: 'fehler', speicher: 'alle' });
  assert.equal(werte.entwarnung, true);
  assert.equal(werte.bericht, 'werktags');
  const { feldfehler } = pruefeAbo({ module: { ftp: 'immer' }, bericht: 'stündlich', bericht_uhrzeit: '25:00', bericht_wochentag: 8 }, {}, ['ftp']);
  assert.deepEqual(Object.keys(feldfehler).sort(), ['bericht', 'bericht_uhrzeit', 'bericht_wochentag', 'modul:ftp']);
  assert.deepEqual(pruefeAbo({}, { module: { ftp: 'alle' }, entwarnung: true }, ['ftp']).werte.module, { ftp: 'alle' }, 'ohne Eingabe bleibt es');
});

test('Erlaubte Domänen: Prüfung in den Einstellungen', () => {
  const bisher = { aktiv: false, client_secret: '', empfaenger: [], erinnerung_stunden: 4, melden_nach_laeufen: 1, erlaubte_domains: ['konsum-weimar.de'] };
  assert.deepEqual(pruefeEinstellungen({ erlaubte_domains: '@Konsum-Weimar.de, filiale.konsum-weimar.de; konsum-weimar.de' }, bisher).werte.erlaubte_domains, ['konsum-weimar.de', 'filiale.konsum-weimar.de']);
  assert.match(pruefeEinstellungen({ erlaubte_domains: 'konsum weimar, x@y' }, bisher).feldfehler.erlaubte_domains, /ungültig/);
  assert.deepEqual(pruefeEinstellungen({ erlaubte_domains: '' }, bisher).werte.erlaubte_domains, [], 'leer = niemand darf eigene Adressen eintragen');
  assert.deepEqual(pruefeEinstellungen({}, bisher).werte.erlaubte_domains, ['konsum-weimar.de']);
});

test('Abos: Stufen, Bcc, Entwarnung nur nach gemeldetem Problem, Erinnerung, Freigabe nicht an Benutzer', async () => {
  const u = await aufbau();
  try {
    await u.bestaetigen(u.b, 'anna', 'anna@konsum-weimar.de');
    await u.bestaetigen(u.b, 'bernd', 'bernd@konsum-weimar.de');
    await u.bestaetigen(u.b, 'chef', 'IT@konsum-weimar.de'); // gleiche Adresse wie allgemeiner Empfänger
    await u.b.codeAnfordern('dora', 'dora@konsum-weimar.de'); // nicht bestätigt
    const ids = ['ftp', 'speicher'];
    await u.b.meineSpeichern('anna', { module: { ftp: 'fehler' }, entwarnung: true }, ids);
    await u.b.meineSpeichern('bernd', { module: { ftp: 'alle', speicher: 'alle' }, entwarnung: false }, ids);
    await u.b.meineSpeichern('chef', { module: { ftp: 'alle' } }, ids);
    const start = u.ms.mails().length;
    const neue = () => u.ms.mails().slice(start);

    await u.b.pruefen([modul('warnung'), modul('ok', 'speicher')]);
    assert.equal(neue()[0].betreff, '[Monitoring] WARNUNG: FTP-Dateialter');
    assert.deepEqual(neue()[0].an, ['it@konsum-weimar.de']);
    assert.deepEqual(neue()[0].bcc, ['bernd@konsum-weimar.de'], 'Warnung nur an Stufe „alle“, doppelte Adresse nicht in Bcc');
    assert.match(neue()[0].text, /unter „Meine Benachrichtigungen“ selbst abonniert/);

    await u.b.pruefen([modul('fehler'), modul('ok', 'speicher')]);
    assert.deepEqual(neue()[1].bcc, ['anna@konsum-weimar.de', 'bernd@konsum-weimar.de']);

    u.vor(4 * 60);
    await u.b.pruefen([modul('fehler'), modul('ok', 'speicher')]);
    assert.match(neue()[2].betreff, /ERINNERUNG/);
    assert.deepEqual(neue()[2].bcc, ['anna@konsum-weimar.de', 'bernd@konsum-weimar.de']);

    await u.b.pruefen([modul('ok'), modul('ok', 'speicher')]);
    assert.equal(neue()[3].betreff, '[Monitoring] WIEDER OK: FTP-Dateialter');
    assert.deepEqual(neue()[3].bcc, ['anna@konsum-weimar.de'], 'Entwarnung nur mit Haken');

    // Nur eine Warnung, die anna (Stufe „fehler“) nie bekam: keine Entwarnung an anna.
    await u.b.pruefen([modul('warnung'), modul('ok', 'speicher')]);
    await u.b.pruefen([modul('ok'), modul('ok', 'speicher')]);
    assert.deepEqual(neue()[5].bcc, [], 'keine Entwarnung ohne gemeldetes Problem');
    assert.doesNotMatch(neue()[5].text, /selbst abonniert/);

    // Keine Meldung und Dienst gestoppt zählen als Fehler; Freigabe nötig nie an Benutzer.
    await u.b.pruefen([modul('keine-meldung', 'ftp', { problemLaeufe: 0 }), modul('freigabe', 'speicher', { problemLaeufe: 0 })]);
    const [km, fr] = neue().slice(6);
    assert.deepEqual(km.bcc, ['anna@konsum-weimar.de', 'bernd@konsum-weimar.de']);
    assert.match(fr.betreff, /FREIGABE NÖTIG/);
    assert.deepEqual(fr.bcc, []);
    assert.ok(!neue().some((m) => m.bcc.includes('dora@konsum-weimar.de') || m.an.includes('dora@konsum-weimar.de')), 'unbestätigte Adresse bekommt nichts');
  } finally { await u.aufraeumen(); }
});

test('Abos ruhen, wenn die Domäne nicht mehr erlaubt ist; Löschen und Bereinigen', async () => {
  const u = await aufbau();
  try {
    await u.bestaetigen(u.b, 'anna', 'anna@konsum-weimar.de');
    await u.b.meineSpeichern('anna', { module: { ftp: 'alle' }, bericht: 'taeglich', bericht_uhrzeit: '11:00' }, ['ftp']);
    await u.b.speichern({ erlaubte_domains: 'andere.de' }, 'patrick');
    assert.equal(u.b.meineAnsicht('anna').adresseRuht, true);
    assert.deepEqual(u.b.aboUebersicht().anna, { adresse: 'anna@konsum-weimar.de', ruht: true, module: 1, bericht: 'täglich 11:00' });
    const vorher = u.ms.mails().length;
    await u.b.pruefen([modul('fehler')]);
    assert.deepEqual(u.ms.mails().at(-1).bcc, [], 'ruhendes Abo bekommt nichts');
    assert.match((await u.b.meinBerichtSenden('anna', [])).fehler, /Adresse bestätigen/);
    u.vor(60);
    await u.b.pruefen([modul('fehler', 'ftp', { problemLaeufe: 2 })]);
    assert.equal(u.ms.mails().length, vorher + 1, 'kein eigener Bericht, solange das Abo ruht');

    await u.b.speichern({ erlaubte_domains: 'konsum-weimar.de' }, 'patrick');
    assert.equal(await u.b.aboLoeschen('anna', 'patrick'), true);
    assert.equal(u.b.meineAnsicht('anna').adresse, null);
    assert.ok(u.meldungen.some((m) => m === 'Benachrichtigungen von anna gelöscht durch patrick.'));
    assert.equal(await u.b.aboLoeschen('anna', 'patrick'), false);

    await u.bestaetigen(u.b, 'bernd', 'bernd@konsum-weimar.de');
    await u.b.abosBereinigen(['anna', 'patrick']);
    assert.equal(u.b.meineAnsicht('bernd').adresse, null, 'Benutzer gibt es nicht mehr');
    assert.deepEqual(JSON.parse(await readFile(path.join(u.ordner, 'benachrichtigung-abos.json'), 'utf8')).benutzer, {});
  } finally { await u.aufraeumen(); }
});

test('Eigener Statusbericht: eigener Rhythmus, einmal je Termin, nachgeholt bis 12 h, nur an den Benutzer', async () => {
  const u = await aufbau();
  try {
    await u.bestaetigen(u.b, 'anna', 'anna@konsum-weimar.de');
    // 10:04 Ortszeit; Termin 10:00 ist heute schon vorbei → wird nicht nachgeholt.
    const r = await u.b.meineSpeichern('anna', { bericht: 'taeglich', bericht_uhrzeit: '10:00' }, []);
    assert.equal(r.ansicht.naechsterBericht, '2026-11-11T09:00:00.000Z');
    const start = u.ms.mails().length;
    await u.b.pruefen([modul('ok')]);
    assert.equal(u.ms.mails().length, start, 'kein Nachholen für den gerade gespeicherten Plan');

    u.vor(24 * 60);
    await u.b.pruefen([modul('fehler')]);
    const berichte = () => u.ms.mails().slice(start).filter((m) => /Statusbericht/.test(m.betreff));
    assert.equal(berichte().length, 1);
    assert.deepEqual(berichte()[0].an, ['anna@konsum-weimar.de']);
    assert.deepEqual(berichte()[0].bcc, []);
    assert.match(berichte()[0].betreff, /^\[Monitoring\] Statusbericht: 1 Problem$/);
    assert.match(berichte()[0].text, /Dein eigener Statusbericht \(Benutzer anna\)/);
    await u.b.pruefen([modul('fehler')]);
    assert.equal(berichte().length, 1, 'nicht doppelt');

    // Neustart und Ausfall: 3 h später wird einmal nachgeholt (verspätet).
    u.vor(24 * 60 + 3 * 60);
    const b2 = u.neu();
    await b2.laden();
    await b2.pruefen([modul('ok')]);
    await b2.pruefen([modul('ok')]);
    assert.equal(berichte().length, 2);
    assert.match(berichte()[1].betreff, /\(verspätet\)$/);

    // Mehr als 12 h verpasst: nicht nachgeholt.
    u.vor(24 * 60 + 10 * 60);
    await b2.pruefen([modul('ok')]);
    assert.equal(berichte().length, 2);

    // Jetzt senden.
    assert.ok((await b2.meinBerichtSenden('anna', [modul('ok')])).ok);
    assert.equal(berichte().length, 3);
    assert.match((await b2.meinBerichtSenden('bernd', [])).fehler, /Adresse bestätigen/);
  } finally { await u.aufraeumen(); }
});

test('Ohne eingerichtete Benachrichtigung: kein Code, Hinweis in der Ansicht', async () => {
  const u = await aufbau();
  try {
    await u.b.speichern({ aktiv: false }, 'patrick');
    assert.equal(u.b.meineAnsicht('anna').verfuegbar, false);
    const r = await u.b.codeAnfordern('anna', 'anna@konsum-weimar.de');
    assert.equal(r.status, 409);
    assert.match(r.fehler, /Admin fragen/);
  } finally { await u.aufraeumen(); }
});

test('Rechte: ohne Leserecht keine Mails und kein Eintrag im eigenen Bericht', async () => {
  const u = await aufbau();
  try {
    await u.bestaetigen(u.b, 'anna', 'anna@konsum-weimar.de');
    await u.b.meineSpeichern('anna', { module: { ftp: 'alle', speicher: 'alle' }, entwarnung: true, bericht: 'taeglich', bericht_uhrzeit: '11:00' }, ['ftp', 'speicher']);
    let erlaubt = new Set(['ftp', 'speicher']);
    u.b.darfSehen = (name, id) => name === 'anna' && erlaubt.has(id);
    await u.b.pruefen([modul('fehler'), modul('fehler', 'speicher')]);
    const start = u.ms.mails().length;
    erlaubt = new Set(['ftp']); // Recht für „speicher“ entzogen
    u.vor(4 * 60);
    await u.b.pruefen([modul('fehler'), modul('fehler', 'speicher')]);
    const neu = u.ms.mails().slice(start);
    const bcc = (betreff) => neu.find((m) => m.betreff.includes(betreff))?.bcc;
    assert.deepEqual(bcc('FTP-Dateialter'), ['anna@konsum-weimar.de']);
    assert.deepEqual(bcc('Speicher'), [], 'Erinnerung ohne Recht nicht an anna');
    await u.b.pruefen([modul('ok'), modul('ok', 'speicher')]);
    assert.deepEqual(u.ms.mails().find((m) => /WIEDER OK: Speicher/.test(m.betreff)).bcc, [], 'keine Entwarnung ohne Recht');
    // Eigener Bericht nur mit sichtbaren Modulen.
    u.vor(24 * 60);
    await u.b.pruefen([modul('ok'), modul('fehler', 'speicher')]);
    const bericht = u.ms.mails().filter((m) => /Statusbericht/.test(m.betreff)).at(-1);
    assert.match(bericht.text, /- FTP-Dateialter: OK/);
    assert.doesNotMatch(bericht.text, /Speicher/);
    assert.match(bericht.betreff, /alles OK/);
  } finally { await u.aufraeumen(); }
});
