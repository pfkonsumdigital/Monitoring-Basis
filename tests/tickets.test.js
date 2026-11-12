import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { pruefeRechte, rechteText, ticketStufe, TICKETS } from '../basis/rechte.js';
import { pruefeModul } from '../basis/module.js';
import { importDateiUebernehmen, nummerAusBetreff, Tickets } from '../basis/tickets.js';
import { pruefePostfach, TicketPostfach } from '../basis/ticketpostfach.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';

// Tickets (0.20.0): Speicher, Verlauf, Zuordnung von E-Mails, Rechte, Webserver und Postfach-Abruf (Graph simuliert).

const ordnerAnlegen = () => mkdtemp(path.join(tmpdir(), 'mb-tickets-'));
function uhr(start = Date.parse('2026-11-12T08:00:00Z')) {
  let t = start;
  return { jetzt: () => t, weiter: (ms) => { t += ms; } };
}

test('Tickets: Nummern, Verlauf mit vorher/nachher, Versionskonflikt, Speichern und Laden', async () => {
  const ordner = await ordnerAnlegen();
  try {
    const u = uhr();
    const t = new Tickets({ datenOrdner: ordner, jetzt: u.jetzt });
    await t.laden();
    const a = await t.anlegen({ betreff: '  Drucker   druckt nicht ', beschreibung: 'Filiale 84\r\nseit heute' }, 'patrick');
    assert.equal(a.nummer, 'IT-2026-001');
    assert.equal(a.betreff, 'Drucker druckt nicht');
    assert.equal(a.beschreibung, 'Filiale 84\nseit heute');
    assert.equal(a.status, 'Offen');
    assert.deepEqual(a.verlauf, [{ zeit: '2026-11-12T08:00:00.000Z', art: 'erstellt', von: 'patrick', werte: { betreff: 'Drucker druckt nicht', status: 'Offen' } }]);
    await assert.rejects(t.anlegen({ betreff: ' ' }, 'x'), (f) => f.status === 400 && f.feldfehler.betreff === 'Pflichtfeld');
    await assert.rejects(t.anlegen({ betreff: 'x', status: 'Neu' }, 'x'), (f) => f.feldfehler.status !== undefined);

    u.weiter(60_000);
    const b = await t.aendern('IT-2026-001', { version: 1, status: 'In Bearbeitung', beschreibung: 'Filiale 84\nseit heute\nToner getauscht', betreff: 'Drucker druckt nicht' }, 'anna');
    assert.equal(b.version, 2);
    assert.equal(b.geaendert, '2026-11-12T08:01:00.000Z');
    assert.deepEqual(b.verlauf[1], { zeit: '2026-11-12T08:01:00.000Z', art: 'geaendert', von: 'anna', aenderungen: [
      { feld: 'beschreibung', vorher: 'Filiale 84\nseit heute', nachher: 'Filiale 84\nseit heute\nToner getauscht' },
      { feld: 'status', vorher: 'Offen', nachher: 'In Bearbeitung' }] }, 'nur geänderte Felder, mit vorher/nachher');
    // Unveränderte Werte: kein Eintrag, keine neue Version, Stand bleibt.
    const stand = t.stand;
    assert.equal((await t.aendern('IT-2026-001', { version: 2, status: 'In Bearbeitung' }, 'anna')).version, 2);
    assert.equal(t.stand, stand);
    // Zweite Sitzung mit altem Stand: abgelehnt, aktueller Stand kommt mit.
    await assert.rejects(t.aendern('IT-2026-001', { version: 1, status: 'Erledigt' }, 'bernd'), (f) => f.status === 409 && f.ticket.version === 2);
    await assert.rejects(t.aendern('IT-2026-009', { version: 1 }, 'x'), (f) => f.status === 404);

    const neu = new Tickets({ datenOrdner: ordner, jetzt: u.jetzt });
    await neu.laden();
    assert.deepEqual(neu.ansicht('IT-2026-001'), t.ansicht('IT-2026-001'), 'Verlauf bleibt nach dem Neuladen erhalten');
    assert.equal((await neu.anlegen({ betreff: 'Zweites' }, 'x')).nummer, 'IT-2026-002');
    // Kaputte Datei: Fehler statt leerer Liste (sonst würde der nächste Speichervorgang alles löschen).
    await writeFile(path.join(ordner, 'tickets.json'), '{kaputt');
    await assert.rejects(new Tickets({ datenOrdner: ordner }).laden(), /nicht lesbar/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Tickets: gleichzeitige Änderungen werden nacheinander gespeichert', async () => {
  const ordner = await ordnerAnlegen();
  try {
    const t = new Tickets({ datenOrdner: ordner });
    const angelegt = await Promise.all(Array.from({ length: 8 }, (_, i) => t.anlegen({ betreff: `T${i}` }, 'x')));
    assert.deepEqual(angelegt.map((a) => a.nummer).sort(), Array.from({ length: 8 }, (_, i) => `IT-${new Date().getFullYear()}-00${i + 1}`));
    const r = await Promise.allSettled([t.aendern(angelegt[0].nummer, { version: 1, status: 'Erledigt' }, 'a'), t.aendern(angelegt[0].nummer, { version: 1, status: 'In Bearbeitung' }, 'b')]);
    assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected'], 'zweite Änderung mit altem Stand scheitert');
    const neu = new Tickets({ datenOrdner: ordner });
    await neu.laden();
    assert.equal(neu.tickets.length, 8);
    assert.equal(neu.ansicht(angelegt[0].nummer).status, 'Erledigt');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Tickets: E-Mails über die Nummer im Betreff, jede nur einmal, Sortierung nach Aktivität', async () => {
  const ordner = await ordnerAnlegen();
  try {
    assert.equal(nummerAusBetreff('AW: Kein WLAN (IT-2026-055)'), 'IT-2026-055');
    assert.equal(nummerAusBetreff('re: it-2026-007 Drucker'), 'IT-2026-007');
    assert.equal(nummerAusBetreff('IT-2026-55'), null, 'mindestens dreistellig');
    assert.equal(nummerAusBetreff('XIT-2026-055'), null);
    const u = uhr();
    const t = new Tickets({ datenOrdner: ordner, jetzt: u.jetzt });
    await t.importieren([
      { nummer: 'IT-2026-055', betreff: 'Kein WLAN', status: 'Offen', geaendert: '2026-11-10T09:00:00Z' },
      { nummer: 'it-2026-054', betreff: 'Scanner', status: 'Offen', geaendert: '2026-11-09T09:00:00Z' },
    ], 'Übersicht');
    assert.deepEqual(t.liste().map((z) => z.nummer), ['IT-2026-055', 'IT-2026-054']);
    const mail = { nachrichtId: '<m1@konsum>', von: 'filiale84@konsum-weimar.de', name: 'Filiale 84', betreff: 'AW: Scanner (IT-2026-054)', zeit: '2026-11-11T07:30:00Z', text: 'Geht wieder nicht.\r\nGruß' };
    assert.deepEqual(await t.mailZuordnen(mail), { ergebnis: 'zugeordnet', nummer: 'IT-2026-054' });
    assert.deepEqual(await t.mailZuordnen({ ...mail, betreff: 'nochmal IT-2026-055' }), { ergebnis: 'doppelt' }, 'gleiche Message-ID');
    assert.deepEqual(await t.mailZuordnen({ ...mail, nachrichtId: '<m2>', betreff: 'Hallo' }), { ergebnis: 'ohne-nummer' });
    assert.deepEqual(await t.mailZuordnen({ ...mail, nachrichtId: '<m3>', betreff: 'IT-2026-099' }), { ergebnis: 'unbekannt', nummer: 'IT-2026-099' });
    const z = t.liste();
    assert.deepEqual(z.map((x) => x.nummer), ['IT-2026-054', 'IT-2026-055'], 'Mail zählt als jüngste Aktivität');
    assert.deepEqual(z[0].mails, { anzahl: 1, letzte: '2026-11-11T07:30:00.000Z' });
    assert.equal(z[0].geaendert, '2026-11-09T09:00:00.000Z', 'Mail ändert „letzte Änderung“ nicht');
    assert.equal(z[0].aktivitaet, '2026-11-11T07:30:00.000Z');
    const v = t.ansicht('IT-2026-054').verlauf;
    assert.equal(v[0].art, 'mail', 'chronologisch: Mail vom 11.11. vor dem Import vom 12.11.');
    assert.deepEqual(v[0].mail, { nachrichtId: '<m1@konsum>', name: 'Filiale 84', betreff: 'AW: Scanner (IT-2026-054)', text: 'Geht wieder nicht.\nGruß' });
    // Nach dem Neuladen gilt die Mail weiter als bekannt.
    const neu = new Tickets({ datenOrdner: ordner });
    await neu.laden();
    assert.deepEqual(await neu.mailZuordnen(mail), { ergebnis: 'doppelt' });
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Tickets: Import mit bisherigen Nummern, doppelt ohne Wirkung, Importdatei beim Start', async () => {
  const ordner = await ordnerAnlegen();
  try {
    const t = new Tickets({ datenOrdner: ordner, jetzt: () => Date.parse('2026-11-12T08:00:00Z') });
    const liste = [{ nummer: 'IT-2026-068', betreff: 'fibu@ im Outlook', status: 'Erledigt', hinweis: 'Status in der bisherigen Übersicht: erledigt.' },
      { nummer: 'IT-2026-001', betreff: 'SNS', status: 'Offen', beschreibung: 'Priorität: Hoch', geaendert: '2026-11-10T00:00:00+01:00' },
      { nummer: 'X-1', betreff: 'falsch' }, { nummer: 'IT-2026-002', betreff: '', status: 'Offen' }];
    await writeFile(path.join(ordner, 'tickets-import.json'), JSON.stringify({ quelle: 'Ticketübersicht 11.11.', tickets: liste }));
    const meldungen = [];
    const r = await importDateiUebernehmen(t, ordner, (m) => meldungen.push(m), rename);
    assert.deepEqual(r, { neu: 2, vorhanden: 0, fehler: ['Eintrag 3: Nummer „X-1“ ungültig', 'IT-2026-002: Betreff Pflichtfeld'] });
    assert.match(meldungen[0], /2 übernommen, 0 schon vorhanden, 2 fehlerhaft/);
    await assert.rejects(readFile(path.join(ordner, 'tickets-import.json')), { code: 'ENOENT' }, 'Datei umbenannt');
    const a = t.ansicht('IT-2026-001');
    assert.equal(a.geaendert, '2026-11-09T23:00:00.000Z');
    assert.deepEqual(a.verlauf, [{ zeit: '2026-11-12T08:00:00.000Z', art: 'import', von: 'Ticketübersicht 11.11.', werte: { betreff: 'SNS', status: 'Offen' } }]);
    assert.equal(t.ansicht('IT-2026-068').verlauf[0].hinweis, 'Status in der bisherigen Übersicht: erledigt.');
    assert.equal(a.nurDatum, undefined);
    await t.importieren([{ nummer: 'IT-2026-010', betreff: 'Nur Datum', status: 'Offen', geaendert: '2026-11-05' }], 'x');
    const d = t.ansicht('IT-2026-010');
    assert.equal(d.nurDatum, true, 'nur Datum bekannt');
    assert.equal(new Date(d.geaendert).getHours(), 0, 'Mitternacht Ortszeit');
    assert.equal((await t.aendern('IT-2026-010', { version: 1, status: 'Erledigt' }, 'x')).nurDatum, undefined, 'nach einer Änderung mit Uhrzeit');
    assert.deepEqual(await t.importieren(liste.slice(0, 2), 'nochmal'), { neu: 0, vorhanden: 2, fehler: [] });
    // Neue Tickets zählen nach dem höchsten übernommenen Stand weiter.
    assert.equal((await t.anlegen({ betreff: 'Neu' }, 'x')).nummer, 'IT-2026-069');
    assert.equal(await importDateiUebernehmen(t, ordner, () => {}, rename), null, 'ohne Datei nichts zu tun');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Tickets: Rechte unabhängig vom Grundrecht, reservierte Modul-ID', () => {
  assert.equal(ticketStufe({ admin: true }), 'bedienen');
  assert.equal(ticketStufe({}), 'kein', 'Benutzer vor 0.19.0 sehen Tickets nicht automatisch');
  assert.equal(ticketStufe({ rechte: { grund: 'bedienen', module: {} } }), 'kein', 'Grundrecht gilt nicht für Tickets');
  assert.equal(ticketStufe({ rechte: { grund: 'kein', module: { [TICKETS]: 'sehen' } } }), 'sehen');
  assert.equal(ticketStufe(undefined), 'kein');
  // Gleich dem Grundrecht bleibt das Ticket-Recht trotzdem gespeichert; „kein“ entfällt.
  assert.deepEqual(pruefeRechte({ grund: 'sehen', module: { [TICKETS]: 'sehen', ftp: 'sehen' } }).werte, { grund: 'sehen', module: { [TICKETS]: 'sehen' } });
  assert.deepEqual(pruefeRechte({ grund: 'kein', module: { [TICKETS]: 'kein' } }).werte, { grund: 'kein', module: {} });
  assert.equal(rechteText({ rechte: { grund: 'kein', module: { [TICKETS]: 'bedienen' } } }), 'Grundrecht kein; Tickets: bedienen');
  assert.match(pruefeModul({ id: TICKETS, name: 'x', typ: 'plugin', einstieg: 'a.js' }, TICKETS, '/m').fehler, /reserviert/);
});

// ---- Webserver ----
async function webAufbau() {
  const ordner = await ordnerAnlegen();
  const benutzer = {
    chef: { hash: await hashPasswort('geheim-geheim'), admin: true },
    leser: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'bedienen', module: { [TICKETS]: 'sehen' } } },
    bearbeiter: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'kein', module: { [TICKETS]: 'bedienen' } } },
    ohne: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'bedienen', module: {} } },
  };
  const anmeldung = new Anmeldung({ benutzer, sitzungMs: 60_000 });
  const tickets = new Tickets({ datenOrdner: ordner });
  const module = { ansichten: () => [], finde: () => null };
  const app = { anwendung: null };
  const server = await starteServer({ anwendung: (req, res) => app.anwendung(req, res), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const adresse = `http://127.0.0.1:${port}`;
  app.anwendung = erstelleAnwendung({ tickets, module, anmeldung, sitzungMs: 60_000, verschluesselt: false, hostname: '127.0.0.1', log: () => {} });
  const hole = (methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const anmelden = async (name) => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/login', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', origin: adresse } }, resolve);
      req.on('error', reject); req.end(`benutzer=${name}&passwort=geheim-geheim`);
    });
    r.resume();
    return { cookie: r.headers['set-cookie'][0].split(';')[0] };
  };
  const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
  return { tickets, hole, anmelden, schutz, aufraeumen: async () => { server.close(); await rm(ordner, { recursive: true, force: true }); } };
}

test('Webserver: Tickets lesen, anlegen, bearbeiten – je nach Recht; Stand für die Aktualisierung', async () => {
  const w = await webAufbau();
  try {
    const [chef, leser, bearbeiter, ohne] = await Promise.all(['chef', 'leser', 'bearbeiter', 'ohne'].map((n) => w.anmelden(n)));
    assert.deepEqual(await Promise.all([chef, leser, bearbeiter, ohne].map(async (c) => (await w.hole('GET', '/api/status', c)).json().tickets)), ['bedienen', 'sehen', 'bedienen', 'kein']);
    assert.equal((await w.hole('GET', '/api/tickets', ohne)).status, 404, 'ohne Recht unsichtbar');

    const neu = await w.hole('POST', '/api/tickets', { ...bearbeiter, ...w.schutz }, JSON.stringify({ betreff: 'Kasse 2 startet nicht', beschreibung: 'Filiale 99' }));
    assert.equal(neu.status, 201);
    const nummer = neu.json().ticket.nummer;
    assert.equal((await w.hole('POST', '/api/tickets', { ...leser, ...w.schutz }, JSON.stringify({ betreff: 'x' }))).status, 403, 'lesen reicht nicht zum Anlegen');
    assert.equal((await w.hole('POST', '/api/tickets', { ...bearbeiter, 'content-type': 'application/json' }, JSON.stringify({ betreff: 'x' }))).status, 403, 'ohne Schutzkopf');
    const fehlt = await w.hole('POST', '/api/tickets', { ...bearbeiter, ...w.schutz }, JSON.stringify({ betreff: '' }));
    assert.deepEqual([fehlt.status, fehlt.json().feldfehler], [400, { betreff: 'Pflichtfeld' }]);

    // Leser sieht die Liste; mit aktuellem Stand nur „unverändert“.
    const liste = (await w.hole('GET', '/api/tickets', leser)).json();
    assert.equal(liste.recht, 'sehen');
    assert.deepEqual(liste.tickets.map((t) => [t.nummer, t.betreff, t.status, t.mails.anzahl]), [[nummer, 'Kasse 2 startet nicht', 'Offen', 0]]);
    assert.deepEqual((await w.hole('GET', `/api/tickets?stand=${liste.stand}`, leser)).json(), { stand: liste.stand, unveraendert: true });

    // Änderung durch den Chef (andere Sitzung) → der Leser bekommt beim nächsten Abfragen den neuen Stand.
    assert.equal((await w.hole('POST', `/api/tickets/${nummer}`, { ...chef, ...w.schutz }, JSON.stringify({ version: 1, status: 'In Bearbeitung' }))).status, 200);
    const danach = (await w.hole('GET', `/api/tickets?stand=${liste.stand}`, leser)).json();
    assert.equal(danach.tickets[0].status, 'In Bearbeitung');
    // Bearbeiter mit veraltetem Stand: 409 mit dem aktuellen Ticket.
    const konflikt = await w.hole('POST', `/api/tickets/${nummer}`, { ...bearbeiter, ...w.schutz }, JSON.stringify({ version: 1, status: 'Erledigt' }));
    assert.equal(konflikt.status, 409);
    assert.equal(konflikt.json().ticket.version, 2);
    // Neue Mail → neuer Stand, im Ticket sichtbar.
    await w.tickets.mailZuordnen({ nachrichtId: '<x@y>', von: 'f99@konsum-weimar.de', betreff: `AW: ${nummer}`, zeit: new Date().toISOString(), text: 'Danke' });
    const mitMail = (await w.hole('GET', `/api/tickets?stand=${danach.stand}`, leser)).json();
    assert.equal(mitMail.tickets[0].mails.anzahl, 1);
    const ticket = (await w.hole('GET', `/api/tickets/${nummer}`, leser)).json().ticket;
    assert.deepEqual(ticket.verlauf.map((v) => [v.art, v.von]), [['erstellt', 'bearbeiter'], ['geaendert', 'chef'], ['mail', 'f99@konsum-weimar.de']]);
    assert.equal((await w.hole('GET', '/api/tickets/IT-2026-999', leser)).status, 404);
    assert.equal((await w.hole('GET', '/api/tickets/..%2Fx', leser)).status, 404);
    assert.equal((await w.hole('GET', '/api/tickets-postfach', chef)).status, 404, 'ohne Postfach-Abruf: nicht verfügbar');
  } finally { await w.aufraeumen(); }
});

// ---- Postfach (Graph simuliert, eigene App) ----
const TENANT = '610db0a4-4e13-4b5e-abbc-309fc810e135';
const APP = 'aaaaaaaa-1111-2222-3333-444444444444';
function graphSimuliert(seiten) {
  const s = { aufrufe: [], token: [], status: 200, tokenFehler: false };
  s.fetchImpl = async (url, opt = {}) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      s.token.push({ url: String(url), body: new URLSearchParams(String(opt.body)) });
      if (s.tokenFehler) return Response.json({ error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' }, { status: 401 });
      return Response.json({ access_token: `tok${s.token.length}`, expires_in: 3600 });
    }
    s.aufrufe.push({ url: String(url), kopf: opt.headers });
    if (s.status !== 200) return Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: s.status });
    const nr = Number(new URL(url).searchParams.get('seite') ?? 0);
    const naechste = nr + 1 < seiten.length ? `https://graph.microsoft.com/v1.0/naechste?seite=${nr + 1}` : undefined;
    return Response.json({ value: seiten[nr], ...(naechste ? { '@odata.nextLink': naechste } : {}) });
  };
  return s;
}
const graphMail = (id, betreff, zeit, von = 'filiale@konsum-weimar.de') => ({ internetMessageId: id, subject: betreff, receivedDateTime: zeit, from: { emailAddress: { address: von, name: 'Filiale' } }, uniqueBody: { content: `Text ${id}` } });
// Simulierte DPAPI wie in den anderen Tests: „verschlüsselt“ = Base64 mit Kennung.
const fakeDpapi = () => async (aktion, eintraege) => eintraege.map(({ d, e }) => (aktion === 'schuetzen' ? Buffer.from(JSON.stringify({ d, e })).toString('base64') : JSON.parse(Buffer.from(d, 'base64').toString()).d));

test('Postfach: eigene App, Schlüssel verschlüsselt und nie angezeigt, Pflichtfelder', async () => {
  const ordner = await ordnerAnlegen();
  try {
    const { Tresor } = await import('../basis/geheimnis.js');
    const tresor = new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi() });
    const geheimnisse = [];
    const meldungen = [];
    const tickets = new Tickets({ datenOrdner: ordner });
    const p = new TicketPostfach({ datenOrdner: ordner, tickets, tresor, geheimnisse, log: (m) => meldungen.push(m) });
    await p.laden();
    assert.deepEqual(pruefePostfach({ aktiv: true }, p.werte).feldfehler,
      { tenant_id: 'Pflichtfeld, wenn der Abruf aktiv ist', client_id: 'Pflichtfeld, wenn der Abruf aktiv ist', client_secret: 'Pflichtfeld, wenn der Abruf aktiv ist', postfach: 'Pflichtfeld, wenn der Abruf aktiv ist' });
    assert.deepEqual(pruefePostfach({ client_id: 'abc', tenant_id: 'kein mandant', rueckblick_tage: 1.5 }, p.werte).feldfehler,
      { tenant_id: 'GUID oder Domain (z. B. firma.onmicrosoft.com)', client_id: 'muss eine GUID sein', rueckblick_tage: 'ganze Zahl von 0 bis 365' });
    const r = await p.speichern({ aktiv: true, tenant_id: TENANT, client_id: APP, client_secret: 'Ticket~Geheim~1', postfach: 'it@konsum-weimar.de', rueckblick_tage: 7 }, 'chef');
    assert.deepEqual(r.ansicht.werte.client_secret, { gesetzt: true }, 'Schlüssel nie an die Oberfläche');
    assert.ok(!JSON.stringify(r.ansicht).includes('Ticket~Geheim~1'));
    const datei = await readFile(path.join(ordner, 'tickets-postfach.json'), 'utf8');
    assert.ok(!datei.includes('Ticket~Geheim~1'), 'Schlüssel nicht im Klartext in der Datei');
    assert.match(JSON.parse(datei).werte.client_secret, /^dpapi:v1:/);
    assert.ok(geheimnisse.includes('Ticket~Geheim~1'), 'Protokoll filtert den Schlüssel');
    assert.match(meldungen.at(-1), /geändert durch chef: .*geheimer Schlüssel/);
    assert.ok(!meldungen.some((m) => m.includes('Ticket~Geheim~1')));
    // Leeres Feld behält den Schlüssel; nach dem Neuladen wieder entschlüsselt.
    assert.equal((await p.speichern({ client_secret: '', postfach: 'it@konsum-weimar.de' }, 'chef')).feldfehler, undefined, 'leeres Feld ist kein fehlender Schlüssel');
    const neu = new TicketPostfach({ datenOrdner: ordner, tickets, tresor: new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi() }) });
    await neu.laden();
    assert.equal(neu.werte.client_secret, 'Ticket~Geheim~1');
    assert.equal(neu.eingerichtet(), true);
    // Nicht entschlüsselbar (z. B. anderer Rechner): Schlüssel leer, Hinweis im Protokoll.
    const fremd = [];
    const kaputt = new TicketPostfach({ datenOrdner: ordner, tickets, tresor: { einzeln: async () => { throw new Error('falscher Rechner'); } }, log: (m) => fremd.push(m) });
    await kaputt.laden();
    assert.equal(kaputt.eingerichtet(), false);
    assert.match(fremd[0], /lässt sich nicht entschlüsseln \(falscher Rechner\)/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Postfach: Abruf mit eigener App, Folgeseiten, Zuordnung, eigene Mails übersprungen, Fehler verständlich', async () => {
  const ordner = await ordnerAnlegen();
  try {
    const u = uhr(Date.parse('2026-11-12T10:00:00Z'));
    const tickets = new Tickets({ datenOrdner: ordner, jetzt: u.jetzt });
    await tickets.importieren([{ nummer: 'IT-2026-055', betreff: 'WLAN', status: 'Offen' }], 'Test');
    const sim = graphSimuliert([
      [graphMail('<a>', 'AW: WLAN (IT-2026-055)', '2026-11-11T08:00:00Z'), graphMail('<b>', 'Newsletter', '2026-11-11T09:00:00Z')],
      [graphMail('<c>', 'IT-2026-055 erledigt?', '2026-11-12T09:00:00Z', 'IT@konsum-weimar.de'), graphMail('<d>', 'Re: IT-2026-055', '2026-11-12T09:30:00Z')],
    ]);
    const meldungen = [];
    const p = new TicketPostfach({ datenOrdner: ordner, tickets, fetchImpl: sim.fetchImpl, log: (m) => meldungen.push(m), jetzt: u.jetzt });
    await p.laden();
    assert.ok((await p.speichern({ aktiv: true, postfach: 'it@konsum-weimar.de' }, 'chef')).feldfehler, 'aktiv nur mit Zugangsdaten');
    await p.speichern({ postfach: 'it@konsum-weimar.de', rueckblick_tage: 7 }, 'chef');
    await assert.rejects(p.abrufen(), /Zugangsdaten fehlen/);
    await p.speichern({ aktiv: true, tenant_id: TENANT, client_id: APP, client_secret: 'Ticket~Geheim~1' }, 'chef');
    assert.equal(p.zustand.letzterFehler, null, 'neue Zugangsdaten: alter Fehler weg');
    assert.deepEqual(await p.abrufen(), { abgerufen: 4, zugeordnet: 2 });
    assert.equal(sim.token[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, 'eigener Mandant');
    assert.deepEqual([sim.token[0].body.get('client_id'), sim.token[0].body.get('client_secret'), sim.token[0].body.get('grant_type')], [APP, 'Ticket~Geheim~1', 'client_credentials']);
    const erste = new URL(sim.aufrufe[0].url);
    assert.equal(erste.pathname, '/v1.0/users/it%40konsum-weimar.de/mailFolders/inbox/messages');
    assert.equal(erste.searchParams.get('$filter'), 'receivedDateTime ge 2026-11-05T10:00:00Z', 'Rückblick 7 Tage');
    assert.equal(sim.aufrufe[0].kopf.authorization, 'Bearer tok1');
    assert.equal(sim.aufrufe[0].kopf.prefer, 'outlook.body-content-type="text"');
    assert.deepEqual(tickets.ansicht('IT-2026-055').verlauf.filter((v) => v.art === 'mail').map((v) => [v.mail.nachrichtId, v.mail.text]), [['<a>', 'Text <a>'], ['<d>', 'Text <d>']]);
    assert.equal(p.zustand.seit, '2026-11-12T09:30:00Z');
    // Nächster Abruf ab der jüngsten Mail (eine Minute Überlappung), dieselben Mails nicht doppelt, Token wiederverwendet.
    assert.deepEqual(await p.abrufen(), { abgerufen: 4, zugeordnet: 0 });
    assert.equal(new URL(sim.aufrufe[2].url).searchParams.get('$filter'), 'receivedDateTime ge 2026-11-12T09:29:00Z');
    assert.equal(sim.token.length, 1);
    // Neuer Schlüssel: nächstes Token mit den neuen Daten.
    await p.speichern({ client_secret: 'Ticket~Geheim~2' }, 'chef');
    await p.abrufen();
    assert.deepEqual([sim.token.length, sim.token[1].body.get('client_secret')], [2, 'Ticket~Geheim~2']);
    // Fehlende Berechtigung: verständliche Meldung, nur einmal im Protokoll.
    sim.status = 403;
    await assert.rejects(p.abrufen(), /Mail\.Read/);
    await assert.rejects(p.abrufen(), /Mail\.Read/);
    assert.equal(meldungen.filter((m) => /Mail\.Read/.test(m)).length, 1);
    // Token abgelehnt: beim nächsten Abruf neues Token holen.
    sim.status = 401;
    await assert.rejects(p.abrufen(), /Token ungültig/);
    sim.status = 200;
    await p.abrufen();
    assert.equal(sim.token.length, 3, 'nach 401 neues Token');
    // Abgelaufener Schlüssel: Hinweis aus der Anmeldung.
    p.zugang = null;
    sim.tokenFehler = true;
    await assert.rejects(p.abrufen(), /AADSTS7000222.*Schlüssel prüfen/);
    const neu = new TicketPostfach({ datenOrdner: ordner, tickets });
    await neu.laden();
    assert.equal(neu.zustand.zugeordnet, 2);
    assert.match(neu.zustand.letzterFehler, /AADSTS7000222/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});
