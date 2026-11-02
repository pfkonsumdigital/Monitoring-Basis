import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { Benutzerverwaltung } from '../basis/benutzerverwaltung.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';
import { Sicherheitsmeldungen } from '../basis/sicherheit.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';
import { main } from '../basis/main.js';
import { base32, base32Lesen, codeHash, codePruefen, neuesGeheimnis, otpauthUri, qrBild, totp, wiederherstellungsCodes } from '../basis/zweifaktor.js';

const PW = 'Blaue-Kanne-41x';
const code = (geheimnis, ms) => totp(geheimnis, Math.floor(ms / 30_000));

test('TOTP nach RFC 6238 (Testvektoren), Base32, Wiederherstellungscodes', () => {
  const schluessel = Buffer.from('12345678901234567890');
  assert.equal(totp(schluessel, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totp(schluessel, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(totp(schluessel, Math.floor(2000000000 / 30), 8), '69279037');
  assert.equal(totp(schluessel, 1), '287082', '6 Stellen = letzte 6 der 8');
  assert.equal(base32(schluessel), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(base32(schluessel), 1), '287082', 'Base32-Geheimnis wie in der App');
  assert.deepEqual(base32Lesen('gezd gnbv-gy3tqojq'), Buffer.from('1234567890'));
  assert.throws(() => base32Lesen('A1'), /Base32/);
  const g = neuesGeheimnis();
  assert.match(g, /^[A-Z2-7]{32}$/, '160 Bit');
  assert.notEqual(g, neuesGeheimnis());
  assert.match(otpauthUri('anna', g, 'Monitoring (m.firma.de)'), new RegExp(`^otpauth://totp/Monitoring%20\\(m\\.firma\\.de\\):anna\\?secret=${g}&issuer=`));
  assert.match(qrBild(otpauthUri('anna', g)), /^data:image\/gif;base64,/);
  const { codes, hashes } = wiederherstellungsCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{2}$/);
  assert.equal(hashes[0], codeHash(codes[0].toUpperCase().replace(/-/g, ' ')), 'Groß/klein, Leer- und Bindestriche egal');
  assert.doesNotMatch(JSON.stringify(hashes), new RegExp(codes[0]));
});

test('Code prüfen: ±30 s Uhrabweichung, jeder Zeitschritt nur einmal, nur 6 Ziffern', () => {
  const g = neuesGeheimnis();
  const jetzt = Date.parse('2026-11-02T10:00:10Z');
  const z = Math.floor(jetzt / 30_000);
  assert.equal(codePruefen(g, totp(g, z), jetzt), z);
  assert.equal(codePruefen(g, ` ${totp(g, z - 1)} `, jetzt), z - 1, 'vorheriger Schritt');
  assert.equal(codePruefen(g, totp(g, z + 1), jetzt), z + 1, 'nächster Schritt');
  assert.equal(codePruefen(g, totp(g, z - 2), jetzt), null, 'zu alt');
  assert.equal(codePruefen(g, totp(g, z + 2), jetzt), null, 'zu weit voraus');
  assert.equal(codePruefen(g, totp(g, z), jetzt, z), null, 'schon benutzt');
  assert.equal(codePruefen(g, totp(g, z - 1), jetzt, z), null, 'älter als der benutzte');
  for (const falsch of ['', '12345', '1234567', 'abcdef', null, undefined]) assert.equal(codePruefen(g, falsch, jetzt), null);
});

async function aufbau({ adminNetz = () => true } = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-2fa-'));
  const configDatei = path.join(ordner, 'config.json');
  const roh = { port: 8443, tls: { modus: 'aus' }, benutzer: { anna: { hash: await hashPasswort(PW), admin: true }, bob: { hash: await hashPasswort('Rote-Leiter-52y') } } };
  await writeFile(configDatei, JSON.stringify(roh));
  let zeit = Date.parse('2026-11-02T10:00:00Z');
  const ereignisse = [];
  let bv;
  const anmeldung = new Anmeldung({
    benutzer: roh.benutzer, sitzungMs: 3_600_000, jetzt: () => zeit, zweiFaktor: true, einrichtenErlaubt: adminNetz,
    melden: (e) => ereignisse.push(e),
    zweiFaktorSpeichern: (n, g, c) => bv.zweiFaktorSpeichern(n, g, c), codeVerbraucht: (n, h) => bv.codeVerbrauchen(n, h),
  });
  const log = [];
  bv = new Benutzerverwaltung({ configDatei, anmeldung, log: (m) => log.push(m) });
  const datei = async () => JSON.parse(await readFile(configDatei, 'utf8'));
  return { ordner, configDatei, anmeldung, bv, log, datei, ereignisse, uhr: { get: () => zeit, plus: (ms) => { zeit += ms; } } };
}

test('Anmeldung mit zwei Faktoren: einrichten, Code, Wiederherstellungscode, Sperre, Zurücksetzen', async () => {
  const { ordner, anmeldung, bv, datei, ereignisse, uhr, log } = await aufbau();
  try {
    // Ohne Code gibt es keine Sitzung, nur einen vorläufigen Schritt.
    assert.equal(await anmeldung.anmelden('anna', 'falsch-falsch', 'ip1'), null);
    const s1 = await anmeldung.anmelden('anna', PW, 'ip1');
    assert.equal(s1.art, 'einrichten');
    assert.equal(anmeldung.sitzung(s1.zweiterSchritt), null, 'vorläufiges Token ist keine Sitzung');
    assert.equal(anmeldung.sitzungen.size, 0);
    const { geheimnis } = anmeldung.schritt(s1.zweiterSchritt);
    assert.match(geheimnis, /^[A-Z2-7]{32}$/);
    assert.deepEqual(await anmeldung.zweiterFaktor(s1.zweiterSchritt, '000000', 'ip1'), { fehler: 'falsch' });
    const r1 = await anmeldung.zweiterFaktor(s1.zweiterSchritt, code(geheimnis, uhr.get()), 'ip1');
    assert.ok(anmeldung.sitzung(r1.token));
    assert.equal(r1.codes.length, 10);
    let zf = (await datei()).benutzer.anna.zwei_faktor;
    assert.equal(zf.geheimnis, geheimnis);
    assert.deepEqual(zf.codes, r1.codes.map(codeHash), 'nur Hashes gespeichert');
    assert.doesNotMatch(JSON.stringify(await datei()), new RegExp(r1.codes[0]));
    assert.ok(pruefeKonfiguration(await datei(), ordner), 'config.json bleibt gültig');
    assert.equal((await anmeldung.zweiterFaktor(s1.zweiterSchritt, code(geheimnis, uhr.get()), 'ip1')).fehler, 'abgelaufen', 'Schritt nur einmal');
    assert.deepEqual(bv.ansicht().benutzer.map((b) => [b.name, b.zweiFaktor]), [['anna', true], ['bob', false]]);
    assert.equal(ereignisse.at(-1).art, 'angemeldet');
    assert.equal(ereignisse.at(-1).zweiFaktor, 'eingerichtet');

    // Nächste Anmeldung: Code aus der App. Derselbe Code gilt nicht zweimal.
    const s2 = await anmeldung.anmelden('anna', PW, 'ip1');
    assert.equal(s2.art, 'code');
    assert.equal(anmeldung.schritt(s2.zweiterSchritt).geheimnis, null, 'Geheimnis wird nicht mehr gezeigt');
    assert.deepEqual(await anmeldung.zweiterFaktor(s2.zweiterSchritt, code(geheimnis, uhr.get()), 'ip1'), { fehler: 'falsch' }, 'schon benutzt');
    uhr.plus(30_000);
    assert.ok((await anmeldung.zweiterFaktor(s2.zweiterSchritt, code(geheimnis, uhr.get()), 'ip1')).token);

    // Wiederherstellungscode: einmal gültig, in config.json gestrichen, Meldung.
    const s3 = await anmeldung.anmelden('anna', PW, 'ip1');
    const r3 = await anmeldung.zweiterFaktor(s3.zweiterSchritt, r1.codes[3].toUpperCase(), 'ip1');
    assert.ok(r3.token);
    assert.deepEqual([r3.wiederherstellung, r3.uebrig], [true, 9]);
    assert.equal(ereignisse.at(-1).zweiFaktor, 'wiederherstellungscode');
    zf = (await datei()).benutzer.anna.zwei_faktor;
    assert.equal(zf.codes.length, 9);
    assert.ok(!zf.codes.includes(codeHash(r1.codes[3])));
    assert.ok(log.some((z) => /Wiederherstellungscode.*noch 9/.test(z)));
    const s4 = await anmeldung.anmelden('anna', PW, 'ip1');
    assert.deepEqual(await anmeldung.zweiterFaktor(s4.zweiterSchritt, r1.codes[3], 'ip1'), { fehler: 'falsch' }, 'Code verbraucht');

    // Abgelaufener Schritt (nach 15 Minuten ist auch der falsche Code von eben vergessen).
    uhr.plus(15 * 60_000);
    assert.deepEqual(await anmeldung.zweiterFaktor(s4.zweiterSchritt, code(geheimnis, uhr.get()), 'ip1'), { fehler: 'abgelaufen' });

    // Falsche Codes nach richtigem Passwort: Sperre je Benutzer, die ein neues richtiges Passwort NICHT aufhebt.
    let s = await anmeldung.anmelden('anna', PW, 'ip2');
    for (let i = 0; i < 4; i++) {
      if (i === 2) s = await anmeldung.anmelden('anna', PW, 'ip3'); // neuer Anlauf von anderer Adresse zählt weiter
      assert.deepEqual(await anmeldung.zweiterFaktor(s.zweiterSchritt, '123456', i < 2 ? 'ip2' : 'ip3'), { fehler: 'falsch' });
    }
    assert.deepEqual(await anmeldung.zweiterFaktor(s.zweiterSchritt, '123456', 'ip3'), { fehler: 'gesperrt' });
    assert.deepEqual(ereignisse.filter((e) => e.art === 'gesperrt-zweifaktor').map((e) => e.benutzer), ['anna']);
    assert.equal(await anmeldung.anmelden('anna', PW, 'ip4'), 'gesperrt', 'auch mit richtigem Passwort');
    uhr.plus(15 * 60_000);
    const s5 = await anmeldung.anmelden('anna', PW, 'ip4');
    assert.ok((await anmeldung.zweiterFaktor(s5.zweiterSchritt, code(geheimnis, uhr.get()), 'ip4')).token, 'nach 15 Minuten wieder möglich');

    // Zurücksetzen durch einen anderen Admin: Sitzungen enden, nächste Anmeldung richtet neu ein.
    await bv.adminSetzen('bob', true, 'anna');
    const sb = await anmeldung.anmelden('bob', 'Rote-Leiter-52y', 'ip5');
    const gb = anmeldung.schritt(sb.zweiterSchritt).geheimnis;
    await anmeldung.zweiterFaktor(sb.zweiterSchritt, code(gb, uhr.get()), 'ip5');
    const offen = anmeldung.liste().filter((x) => x.benutzer === 'anna').length;
    assert.ok(offen > 0);
    await assert.rejects(bv.zweiFaktorZuruecksetzen('anna', 'anna'), /nur ein anderer Admin/);
    await assert.rejects(bv.zweiFaktorZuruecksetzen('niemand', 'bob'), /gibt es nicht/);
    await bv.zweiFaktorZuruecksetzen('anna', 'bob');
    assert.equal(anmeldung.liste().filter((x) => x.benutzer === 'anna').length, 0, 'Sitzungen beendet');
    assert.equal((await datei()).benutzer.anna.zwei_faktor, undefined);
    assert.equal((await datei()).benutzer.anna.admin, true, 'Rest bleibt');
    assert.equal((await anmeldung.anmelden('anna', PW, 'ip1')).art, 'einrichten');
    assert.ok(log.some((z) => /Zwei-Faktor-Anmeldung von anna zurückgesetzt durch bob \(\d+ Sitzung/.test(z)));

    // Passwort setzen lässt die Zwei-Faktor-Anmeldung bestehen.
    await bv.passwortSetzen('bob', 'Gelbe-Bruecke-63z', 'anna');
    assert.ok((await datei()).benutzer.bob.zwei_faktor);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Zwei-Faktor: Einrichtung nur aus dem Firmennetz/VPN, Anmeldung danach auch von außen', async () => {
  const intern = (a) => a.startsWith('192.168.');
  const { ordner, anmeldung, uhr } = await aufbau({ adminNetz: intern });
  try {
    assert.equal(await anmeldung.anmelden('anna', PW, '8.8.8.8'), 'einrichten-extern');
    assert.equal(anmeldung.schritte.size, 0);
    const s = await anmeldung.anmelden('anna', PW, '192.168.10.5');
    await anmeldung.zweiterFaktor(s.zweiterSchritt, code(anmeldung.schritt(s.zweiterSchritt).geheimnis, uhr.get()), '192.168.10.5');
    const e = await anmeldung.anmelden('anna', PW, '8.8.8.8');
    assert.equal(e.art, 'code');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Zwei-Faktor: gleichzeitige Anfragen mit demselben Code ergeben nur eine Sitzung', async () => {
  const { ordner, anmeldung, uhr } = await aufbau();
  try {
    const s = await anmeldung.anmelden('anna', PW, 'ip');
    const g = anmeldung.schritt(s.zweiterSchritt).geheimnis;
    const r = await anmeldung.zweiterFaktor(s.zweiterSchritt, code(g, uhr.get()), 'ip');
    uhr.plus(30_000);
    const [a, b] = [await anmeldung.anmelden('anna', PW, 'ip'), await anmeldung.anmelden('anna', PW, 'ip')];
    const c = code(g, uhr.get());
    const ergebnisse = await Promise.all([anmeldung.zweiterFaktor(a.zweiterSchritt, c, 'ip'), anmeldung.zweiterFaktor(b.zweiterSchritt, c, 'ip')]);
    assert.equal(ergebnisse.filter((x) => x.token).length, 1);
    const [d, e] = [await anmeldung.anmelden('anna', PW, 'ip'), await anmeldung.anmelden('anna', PW, 'ip')];
    const doppelt = await Promise.all([anmeldung.zweiterFaktor(d.zweiterSchritt, r.codes[0], 'ip'), anmeldung.zweiterFaktor(e.zweiterSchritt, r.codes[0], 'ip')]);
    assert.equal(doppelt.filter((x) => x.token).length, 1, 'Wiederherstellungscode nur einmal');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Sicherheitsmeldungen: falsche Codes nach richtigem Passwort und Wiederherstellungscode per Mail', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-2fa-sich-'));
  const mails = [];
  const log = [];
  const s = new Sicherheitsmeldungen({ datenOrdner: ordner, benachrichtigung: { sicherheit: async (b, t) => mails.push([b, t]) }, log: (m) => log.push(m) });
  try {
    await s.ereignis({ art: 'gesperrt-zweifaktor', benutzer: 'anna', adresse: '::ffff:8.8.8.8' });
    await s.ereignis({ art: 'angemeldet', benutzer: 'anna', admin: true, adresse: '192.168.100.20', zweiFaktor: 'wiederherstellungscode' });
    assert.equal(mails.length, 2);
    assert.match(mails[0][0], /falsche Zwei-Faktor-Codes \(anna\)/);
    assert.match(mails[0][1], /8\.8\.8\.8.*\n.*Passwort vermutlich bekannt/);
    assert.match(mails[1][0], /Wiederherstellungscode \(anna\)/);
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

test('Webserver: Anmeldung in zwei Schritten, Einrichtungsseite mit QR-Code, Codes, Zurücksetzen per API', async () => {
  const { ordner, anmeldung, bv, uhr } = await aufbau();
  const tls = await testZertifikat();
  const module = { ansichten: () => [], finde: () => null };
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, benutzerverwaltung: bv, sitzungMs: 3_600_000, hostname: 'monitoring.firma.de' }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const cookies = (r) => Object.fromEntries((r.kopf['set-cookie'] ?? []).map((c) => c.split(';')[0].split('=')));
  const login = (name, pw) => anfrage(port, ca, 'POST', '/login', { kopf: form, koerper: `benutzer=${name}&passwort=${encodeURIComponent(pw)}` });
  const schritt = (vt, wert, extra = {}) => anfrage(port, ca, 'POST', '/login/2fa', { kopf: { ...form, cookie: `mb_2fa=${vt}`, ...extra }, koerper: `code=${encodeURIComponent(wert)}` });
  try {
    // Passwort richtig → noch keine Sitzung, nur das vorläufige Cookie (nur für /login, HttpOnly, Secure, Strict).
    let r = await login('anna', PW);
    assert.deepEqual([r.status, r.kopf.location], [303, '/login/2fa']);
    assert.equal(cookies(r).mb_sitzung, undefined);
    const roh = r.kopf['set-cookie'][0];
    assert.match(roh, /^mb_2fa=[\w-]{43}; Path=\/login; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/);
    const vt = cookies(r).mb_2fa;
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie: `mb_sitzung=${vt}` } })).status, 401, 'vorläufiges Token öffnet nichts');

    // Einrichtungsseite: QR-Code als data:-Bild, Schlüssel zum Abtippen, Formular.
    r = await anfrage(port, ca, 'GET', '/login/2fa', { kopf: { cookie: `mb_2fa=${vt}` } });
    assert.equal(r.status, 200);
    assert.match(r.text, /Zwei-Faktor-Anmeldung einrichten/);
    assert.match(r.text, /<img class="zf-qr" src="data:image\/gif;base64,[A-Za-z0-9+/=]+"/);
    const geheimnis = /<code class="zf-geheimnis">([A-Z2-7 ]+)<\/code>/.exec(r.text)[1].replace(/ /g, '');
    assert.equal(geheimnis, anmeldung.schritt(vt).geheimnis);
    assert.match(r.kopf['content-security-policy'], /img-src 'self' data:/);
    assert.equal((await anfrage(port, ca, 'GET', '/login/2fa')).kopf.location, '/login?fehler=zf-abgelaufen', 'ohne Cookie zurück zur Anmeldung');

    // Falscher Code → Hinweis; fremde Herkunft → abgelehnt; richtiger Code → Sitzung und Wiederherstellungscodes.
    r = await schritt(vt, '000000');
    assert.equal(r.kopf.location, '/login/2fa?fehler=1');
    assert.match((await anfrage(port, ca, 'GET', '/login/2fa?fehler=1', { kopf: { cookie: `mb_2fa=${vt}` } })).text, /Der Code stimmt nicht/);
    assert.equal((await schritt(vt, code(geheimnis, uhr.get()), { origin: 'https://boese.example' })).status, 403);
    r = await schritt(vt, code(geheimnis, uhr.get()));
    assert.equal(r.status, 200);
    assert.match(r.text, /Wiederherstellungscodes/);
    const wcodes = [...r.text.matchAll(/<li>([a-z0-9-]{12})<\/li>/g)].map((m) => m[1]);
    assert.equal(wcodes.length, 10);
    const anna = `mb_sitzung=${cookies(r).mb_sitzung}`;
    assert.equal(cookies(r).mb_2fa, '', 'vorläufiges Cookie gelöscht');
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie: anna } })).status, 200);
    assert.equal((await schritt(vt, code(geheimnis, uhr.get()))).kopf.location, '/login?fehler=zf-abgelaufen', 'Schritt verbraucht');

    // Zweite Anmeldung: Codeseite ohne Geheimnis; Wiederherstellungscode → Hinweisseite.
    r = await login('anna', PW);
    const vt2 = cookies(r).mb_2fa;
    r = await anfrage(port, ca, 'GET', '/login/2fa', { kopf: { cookie: `mb_2fa=${vt2}` } });
    assert.match(r.text, /Bestätigungscode/);
    assert.doesNotMatch(r.text, new RegExp(geheimnis.slice(0, 8)));
    assert.doesNotMatch(r.text, /zf-qr/);
    r = await schritt(vt2, wcodes[0]);
    assert.match(r.text, /Wiederherstellungscode\. Es sind noch 9 übrig/);
    assert.ok(cookies(r).mb_sitzung);

    // Dritte Anmeldung mit App-Code → direkt zur Übersicht.
    uhr.plus(30_000);
    r = await login('anna', PW);
    r = await schritt(cookies(r).mb_2fa, code(geheimnis, uhr.get()));
    assert.deepEqual([r.status, r.kopf.location], [303, '/']);
    assert.ok(cookies(r).mb_sitzung);

    // Admin setzt bobs Zwei-Faktor-Anmeldung zurück (bob hat noch keine → Knopf fehlt, API geht trotzdem).
    r = await anfrage(port, ca, 'POST', '/api/benutzer/anna/zweifaktor-zuruecksetzen', { kopf: { cookie: anna, 'x-monitor-anfrage': '1', 'content-type': 'application/json' }, koerper: '{}' });
    assert.deepEqual([r.status, r.json().fehler], [400, 'Die eigene Zwei-Faktor-Anmeldung kann nur ein anderer Admin zurücksetzen (oder: --zwei-faktor-zuruecksetzen auf dem Server).']);
    r = await anfrage(port, ca, 'POST', '/api/benutzer/bob/zweifaktor-zuruecksetzen', { kopf: { cookie: anna, 'x-monitor-anfrage': '1', 'content-type': 'application/json' }, koerper: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().benutzer.map((b) => [b.name, b.zweiFaktor]), [['anna', true], ['bob', false]]);

    // Login-Meldungen.
    assert.match((await anfrage(port, ca, 'GET', '/login?fehler=einrichten-extern')).text, /einmalig im Firmennetz oder über VPN/);
    assert.match((await anfrage(port, ca, 'GET', '/login?fehler=zf-abgelaufen')).text, /Bestätigungscode ist abgelaufen/);
  } finally {
    server.close();
    await rm(ordner, { recursive: true, force: true });
  }
});

test('Notfall: --zwei-faktor-zuruecksetzen entfernt die Zwei-Faktor-Anmeldung in config.json', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-2fa-cli-'));
  const configDatei = path.join(ordner, 'config.json');
  const roh = { port: 8443, tls: { modus: 'aus' }, benutzer: { anna: { hash: 'scrypt$1$1$1$a$b', admin: true, zwei_faktor: { geheimnis: 'KAPUTT', codes: [] } } } };
  await writeFile(configDatei, JSON.stringify(roh));
  const ausgabe = [];
  const alt = console.log;
  console.log = (t) => ausgabe.push(t);
  try {
    assert.equal(await main(['--config', configDatei, '--zwei-faktor-zuruecksetzen', 'anna']), 0, 'geht auch bei beschädigter Angabe');
    const neu = JSON.parse(await readFile(configDatei, 'utf8'));
    assert.deepEqual(neu.benutzer.anna, { hash: 'scrypt$1$1$1$a$b', admin: true });
    assert.match(ausgabe.join('\n'), /zurückgesetzt\. Bitte die Basis neu starten/);
    assert.equal(await main(['--config', configDatei, '--zwei-faktor-zuruecksetzen', 'niemand']), 2);
    assert.throws(() => pruefeKonfiguration(roh, ordner), /zwei_faktor ist beschädigt.*--zwei-faktor-zuruecksetzen anna/);
  } finally {
    console.log = alt;
    await rm(ordner, { recursive: true, force: true });
  }
});
