import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, brauchtNeuenHash, hashPasswort, passwortStimmt } from '../basis/anmeldung.js';
import { Benutzerverwaltung, passwortRegelFehler } from '../basis/benutzerverwaltung.js';
import { Benachrichtigung } from '../basis/benachrichtigung.js';
import { adminNetzePruefen, adminNetzPruefer, pruefeKonfiguration } from '../basis/konfiguration.js';
import { Sicherheitsmeldungen } from '../basis/sicherheit.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';

// Hash im alten Format (N=2^14), wie ihn Versionen bis 0.10.0 gespeichert haben.
const alterHash = (pw) => {
  const salz = randomBytes(16);
  return `scrypt$16384$8$1$${salz.toString('base64')}$${scryptSync(pw, salz, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
};

test('Passwort-Regeln: Länge, Benutzername, wenige Zeichen, bekannte Wörter', () => {
  assert.match(passwortRegelFehler('anna', 'kurz-1'), /mindestens 12 Zeichen/);
  assert.match(passwortRegelFehler('anna', 'x'.repeat(201)), /höchstens 200/);
  assert.match(passwortRegelFehler('anna', 'Anna-hat-Geburtstag'), /Benutzernamen/);
  assert.match(passwortRegelFehler('bob', 'aaaaabbbbbaaaa'), /zu wenige verschiedene/);
  for (const pw of ['Passwort12345!', 'Sommer2026Sommer', 'Monitoring2026!', 'qwertz123456', 'Willkommen123']) assert.match(passwortRegelFehler('anna', pw), /bekannten Wörtern/, pw);
  for (const pw of ['Blaue-Kanne-41x', 'Mein Hund frisst gern Kekse', 'tR7#kq9!Lm2$']) assert.equal(passwortRegelFehler('anna', pw), null, pw);
});

test('Hashes nach OWASP; alte Hashes werden bei der Anmeldung erneuert', async () => {
  const neu = await hashPasswort('Blaue-Kanne-41x');
  assert.match(neu, /^scrypt\$131072\$8\$1\$/);
  assert.equal(brauchtNeuenHash(neu), false);
  const alt = alterHash('Rote-Leiter-52y');
  assert.equal(brauchtNeuenHash(alt), true);
  assert.equal(await passwortStimmt('Rote-Leiter-52y', alt), true, 'alte Hashes gelten weiter');

  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-sich-'));
  try {
    const configDatei = path.join(ordner, 'config.json');
    await writeFile(configDatei, JSON.stringify({ tls: { modus: 'aus' }, benutzer: { bob: { hash: alt } } }));
    let bv;
    const erneuert = [];
    const a = new Anmeldung({ benutzer: { bob: { hash: alt } }, sitzungMs: 60_000, hashErneuern: (n, p) => erneuert.push(bv.hashErneuern(n, p)) });
    const log = [];
    bv = new Benutzerverwaltung({ configDatei, anmeldung: a, log: (m) => log.push(m) });
    assert.equal(typeof await a.anmelden('bob', 'Rote-Leiter-52y', 'ip'), 'string');
    await Promise.all(erneuert);
    const gespeichert = JSON.parse(await readFile(configDatei, 'utf8')).benutzer.bob.hash;
    assert.match(gespeichert, /^scrypt\$131072\$/);
    assert.equal(await passwortStimmt('Rote-Leiter-52y', gespeichert), true);
    assert.equal(a.benutzer.bob.hash, gespeichert, 'sofort im Speicher');
    assert.deepEqual(log, ['Passwort-Hash von bob auf die aktuelle Stärke umgestellt.']);
    // Mit neuem Hash keine weitere Erneuerung.
    await a.anmelden('bob', 'Rote-Leiter-52y', 'ip');
    assert.equal(erneuert.length, 1);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Sperren: je Adresse und je Benutzer (verteiltes Raten), Meldung nur beim Beginn, begrenzte Listen', async () => {
  let zeit = 0;
  const ereignisse = [];
  const hash = alterHash('Blaue-Kanne-41x');
  const a = new Anmeldung({ benutzer: { anna: { hash, admin: true } }, sitzungMs: 60_000, jetzt: () => zeit, maxFehlversuche: 3, maxFehlversucheBenutzer: 4, maxEintraege: 5, melden: (e) => ereignisse.push(e) });
  // Vier Fehlversuche von vier Adressen: keine Adresse ist gesperrt, aber der Benutzer.
  for (let i = 1; i <= 4; i++) assert.equal(await a.anmelden('anna', 'falsch', `10.0.0.${i}`), i < 4 ? null : 'gesperrt');
  assert.equal(await a.anmelden('anna', 'Blaue-Kanne-41x', '10.0.0.99'), 'gesperrt', 'auch mit richtigem Passwort von neuer Adresse');
  assert.deepEqual(ereignisse.map((e) => e.art), ['gesperrt-benutzer']);
  zeit += 15 * 60_000;
  assert.equal(typeof await a.anmelden('anna', 'Blaue-Kanne-41x', '10.0.0.99'), 'string', 'nach 15 Minuten wieder frei');
  assert.equal(ereignisse.at(-1).art, 'angemeldet');
  assert.equal(ereignisse.at(-1).admin, true);
  // Adresse: 3 Fehlversuche → gesperrt, eine Meldung.
  for (let i = 0; i < 3; i++) await a.anmelden(`x${i}`, 'falsch', '10.9.9.9');
  assert.equal(ereignisse.filter((e) => e.art === 'gesperrt-adresse').length, 1);
  assert.equal(a.gesperrt('10.9.9.9'), true);
  // Viele Adressen und Namen: die Listen bleiben begrenzt.
  for (let i = 0; i < 50; i++) await a.anmelden(`name${i}`, 'falsch', `172.16.0.${i}`);
  assert.ok(a.fehlversuche.size <= 5 && a.fehlversucheBenutzer.size <= 5, `${a.fehlversuche.size}/${a.fehlversucheBenutzer.size}`);
});

test('Überlast: höchstens N gleichzeitige Prüfungen, volle Warteschlange wird abgewiesen', async () => {
  const hash = alterHash('Blaue-Kanne-41x');
  const a = new Anmeldung({ benutzer: { anna: { hash } }, sitzungMs: 60_000, gleichzeitig: 1, warteschlange: 2 });
  await a.platzhalter;
  const ergebnisse = await Promise.all(Array.from({ length: 6 }, (_, i) => a.pruefen('anna', 'falsch', `10.1.0.${i}`)));
  assert.deepEqual(ergebnisse.filter((e) => e === 'ueberlastet').length, 3, JSON.stringify(ergebnisse));
  assert.equal(await a.pruefen('anna', 'Blaue-Kanne-41x', '10.1.1.1'), true, 'danach wieder frei');
});

test('Leerlauf: automatische Abfragen verlängern nicht, Aktionen schon; Höchstdauer gilt immer', async () => {
  let zeit = 0;
  const a = new Anmeldung({ benutzer: { anna: { hash: alterHash('Blaue-Kanne-41x') } }, sitzungMs: 8 * 3_600_000, leerlaufMs: 30 * 60_000, jetzt: () => zeit });
  const t = await a.anmelden('anna', 'Blaue-Kanne-41x', 'ip');
  zeit += 20 * 60_000;
  assert.ok(a.sitzung(t, { aktiv: false }), 'Nachladen nach 20 min');
  zeit += 15 * 60_000;
  assert.equal(a.sitzung(t, { aktiv: false }), null, '35 min ohne Aktion: abgemeldet');
  const t2 = await a.anmelden('anna', 'Blaue-Kanne-41x', 'ip');
  for (let i = 0; i < 20; i++) { zeit += 25 * 60_000; if (i < 19) assert.ok(a.sitzung(t2), `Aktion ${i}`); }
  assert.equal(a.sitzung(t2), null, 'nach 8 Stunden trotz Aktivität abgemeldet');
  // Anzeige: Ende ist der frühere Zeitpunkt von Leerlauf und Höchstdauer.
  const t3 = await a.anmelden('anna', 'Blaue-Kanne-41x', 'ip');
  assert.equal(a.liste(t3)[0].bis, new Date(zeit + 30 * 60_000).toISOString());
});

test('Konfiguration: Standard 8 h / 30 min, Admin-Netze prüfen', () => {
  const k = pruefeKonfiguration({ tls: { modus: 'aus' } }, '/app');
  assert.deepEqual([k.sitzungMs, k.leerlaufMs], [8 * 3_600_000, 30 * 60_000]);
  const pruefer = adminNetzPruefer(k.adminNetze);
  for (const [a, ok] of [['192.168.1.5', true], ['::ffff:10.1.2.3', true], ['172.31.255.1', true], ['172.32.0.1', false], ['8.8.8.8', false], ['::1', true], ['2001:db8::1', false], ['', false], ['kaputt', false]]) assert.equal(pruefer(a), ok, a);
  assert.equal(adminNetzPruefer(adminNetzePruefen(['10.8.0.0/24']))('10.8.1.1'), false);
  assert.equal(adminNetzPruefer(adminNetzePruefen(['*']))('8.8.8.8'), true);
  assert.throws(() => pruefeKonfiguration({ tls: { modus: 'aus' }, admin_netze: ['10.0.0.0/33'] }, '/app'), /kein gültiges Netz/);
  assert.throws(() => pruefeKonfiguration({ tls: { modus: 'aus' }, admin_netze: [] }, '/app'), /muss eine Liste/);
  assert.throws(() => pruefeKonfiguration({ tls: { modus: 'aus' }, sitzung_leerlauf_minuten: 1 }, '/app'), /zwischen 5 und 1440/);
});

test('Sicherheitsmeldungen: Sperre und Admin von neuer Adresse per Mail, gedrosselt; bekannte Adressen gespeichert', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-sich-'));
  try {
    let zeit = Date.parse('2026-11-02T10:00:00Z');
    const mails = [];
    const benachrichtigung = { sicherheit: async (betreff, text) => mails.push({ betreff, text }) };
    const log = [];
    const s = new Sicherheitsmeldungen({ datenOrdner: ordner, benachrichtigung, log: (m) => log.push(m), jetzt: () => zeit });
    await s.laden();
    await s.ereignis({ art: 'angemeldet', benutzer: 'anna', admin: true, adresse: '::ffff:10.0.0.5' });
    assert.equal(mails.length, 0, 'erste Anmeldung überhaupt: keine Mail');
    await s.ereignis({ art: 'angemeldet', benutzer: 'anna', admin: true, adresse: '10.0.0.5' });
    assert.equal(mails.length, 0, 'bekannte Adresse');
    await s.ereignis({ art: 'angemeldet', benutzer: 'anna', admin: true, adresse: '80.1.2.3' });
    assert.equal(mails.length, 1);
    assert.match(mails[0].betreff, /Admin-Anmeldung von neuer Adresse \(anna\)/);
    assert.match(mails[0].text, /80\.1\.2\.3/);
    await s.ereignis({ art: 'angemeldet', benutzer: 'bob', admin: false, adresse: '10.0.0.6' });
    await s.ereignis({ art: 'angemeldet', benutzer: 'bob', admin: false, adresse: '80.9.9.9' });
    assert.equal(mails.length, 1, 'keine Mail für normale Benutzer');
    assert.deepEqual(JSON.parse(await readFile(path.join(ordner, 'anmeldeorte.json'), 'utf8')), { anna: ['80.1.2.3', '10.0.0.5'], bob: ['80.9.9.9', '10.0.0.6'] });

    for (let i = 0; i < 3; i++) await s.ereignis({ art: 'gesperrt-adresse', adresse: `203.0.113.${i}`, benutzer: 'admin' });
    assert.equal(mails.filter((m) => /gesperrt/.test(m.betreff)).length, 1, 'gedrosselt');
    assert.equal(log.filter((l) => /gesperrt/.test(l)).length, 3, 'jede Sperre im Protokoll');
    zeit += 16 * 60_000;
    await s.ereignis({ art: 'gesperrt-benutzer', adresse: '203.0.113.9', benutzer: 'anna' });
    const letzte = mails.at(-1);
    assert.match(letzte.text, /Benutzer „anna“ für 15 Minuten gesperrt/);
    assert.match(letzte.text, /2 weitere solche Ereignisse/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Empfänger je Modul: zusätzlich zu den allgemeinen, ohne doppelte Adressen, gespeichert', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-sich-'));
  try {
    const gesendet = [];
    const b = new Benachrichtigung({ datenOrdner: ordner, log: () => {} });
    await b.laden();
    await b.speichern({ aktiv: true, tenant_id: '11111111-2222-3333-4444-555555555555', client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', client_secret: 'geheim-geheim', absender: 'monitoring@firma.de', empfaenger: 'it@firma.de', link: '' }, 'anna');
    b.mail = { senden: async (m) => gesendet.push(m) };
    assert.deepEqual(await b.modulEmpfaengerSpeichern('ftp', 'lager@firma.de; IT@firma.de, Lager@firma.de', 'anna'), { empfaenger: ['lager@firma.de', 'IT@firma.de'] });
    assert.deepEqual(await b.modulEmpfaengerSpeichern('ftp', 'kaputt', 'anna'), { fehler: 'Empfänger: ungültig: kaputt' });
    await b.versenden('fehler', 'B', 'T', 'ftp');
    await b.versenden('fehler', 'B', 'T', 'anderes');
    assert.deepEqual(gesendet.map((m) => m.an), [['it@firma.de', 'lager@firma.de'], ['it@firma.de']]);
    // Allgemeine Einstellungen speichern verliert die Modul-Empfänger nicht; nach Neustart noch da.
    await b.speichern({ link: 'http://10.0.0.5:8080/' }, 'anna');
    const neu = new Benachrichtigung({ datenOrdner: ordner });
    await neu.laden();
    assert.deepEqual(neu.modulEmpfaenger('ftp'), ['lager@firma.de', 'IT@firma.de']);
    assert.deepEqual(await neu.modulEmpfaengerSpeichern('ftp', '', 'anna'), { empfaenger: [] });
    assert.deepEqual(neu.werte.modul_empfaenger, {});
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

async function testZertifikat() {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-zert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(ordner, 'k.pem'), '-out', path.join(ordner, 'c.pem')], { stdio: 'ignore' });
  const tls = { key: await readFile(path.join(ordner, 'k.pem'), 'utf8'), cert: await readFile(path.join(ordner, 'c.pem'), 'utf8') };
  await rm(ordner, { recursive: true, force: true });
  return tls;
}

function anfrage(port, ca, methode, weg, { kopf = {}, koerper } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, method: methode, path: weg, ca, headers: { host: `localhost:${port}`, ...kopf } }, (res) => {
      let daten = '';
      res.on('data', (t) => { daten += t; });
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject);
    if (koerper) req.write(koerper);
    req.end();
  });
}

test('Webserver: Admin-Funktionen nur aus Admin-Netzen, Leerlauf über Hintergrund-Kopf, Empfänger-API', async () => {
  const tls = await testZertifikat();
  let zeit = Date.now();
  const anmeldung = new Anmeldung({ benutzer: { anna: { hash: alterHash('Blaue-Kanne-41x'), admin: true } }, sitzungMs: 3_600_000, leerlaufMs: 30 * 60_000, jetzt: () => zeit });
  let intern = false;
  const empfaenger = {};
  const benachrichtigung = {
    werte: { empfaenger: ['it@firma.de'], aktiv: true }, eingerichtet: () => true,
    modulEmpfaenger: (id) => empfaenger[id] ?? [],
    modulEmpfaengerSpeichern: async (id, wert) => { empfaenger[id] = wert.split(',').map((x) => x.trim()).filter(Boolean); return { empfaenger: empfaenger[id] }; },
  };
  const module = { ansichten: () => [], finde: (id) => (id === 'ftp' ? { id: 'ftp' } : null) };
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, benachrichtigung, sitzungMs: 3_600_000, adminNetz: () => intern }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  try {
    const login = await anfrage(port, ca, 'POST', '/login', { kopf: { 'content-type': 'application/x-www-form-urlencoded' }, koerper: 'benutzer=anna&passwort=Blaue-Kanne-41x' });
    const cookie = login.kopf['set-cookie'][0].split(';')[0];
    // Von außen: Admin wird wie ein normaler Benutzer behandelt.
    let st = (await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie } })).json();
    assert.deepEqual([st.admin, st.adminNurIntern], [false, true]);
    const r = await anfrage(port, ca, 'GET', '/api/module/ftp/empfaenger', { kopf: { cookie } });
    assert.deepEqual([r.status, r.json().fehler], [403, 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.']);
    // Intern: Admin-Funktionen gehen.
    intern = true;
    st = (await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie } })).json();
    assert.deepEqual([st.admin, st.adminNurIntern], [true, false]);
    const g = await anfrage(port, ca, 'POST', '/api/module/ftp/empfaenger', { kopf: { cookie, 'x-monitor-anfrage': '1', 'content-type': 'application/json' }, koerper: JSON.stringify({ empfaenger: 'lager@firma.de' }) });
    assert.deepEqual([g.status, g.json().empfaenger], [200, ['lager@firma.de']]);
    assert.deepEqual((await anfrage(port, ca, 'GET', '/api/module/ftp/empfaenger', { kopf: { cookie } })).json(), { empfaenger: ['lager@firma.de'], allgemein: ['it@firma.de'], aktiv: true });
    // Leerlauf: Nachladen mit Hintergrund-Kopf hält die Sitzung nicht offen.
    zeit += 20 * 60_000;
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie, 'x-monitor-hintergrund': '1' } })).status, 200);
    zeit += 15 * 60_000;
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie, 'x-monitor-hintergrund': '1' } })).status, 401);
    const abgelaufen = await anfrage(port, ca, 'GET', '/login?fehler=abgelaufen');
    assert.match(abgelaufen.text, /Die Sitzung ist abgelaufen/);
  } finally { server.close(); }
});
