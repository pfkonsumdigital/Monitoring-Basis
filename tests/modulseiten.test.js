import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';
import { berechneAnsicht } from '../basis/modulansicht.js';
import { pruefeModul } from '../basis/module.js';
import { modulWeg, SCHLUESSEL_DATEI } from '../basis/modulseiten.js';
import { Modulupdates } from '../basis/modulupdates.js';

const SCHLUESSEL = 'a'.repeat(43);

function anfrage(port, methode, weg, { kopf = {}, koerper } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: kopf }, (res) => {
      let daten = '';
      res.on('data', (t) => { daten += t; });
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten }));
    });
    req.on('error', reject);
    if (koerper) req.write(koerper);
    req.end();
  });
}

// Testmodul mit eigenem Webserver: merkt sich jede Anfrage, antwortet je nach Pfad.
async function testModulServer() {
  const anfragen = [];
  const server = http.createServer((req, res) => {
    let koerper = '';
    req.on('data', (t) => { koerper += t; });
    req.on('end', () => {
      anfragen.push({ methode: req.method, weg: req.url, kopf: req.headers, koerper });
      if (req.url.startsWith('/weiter')) { res.writeHead(303, { location: '/ziel', 'set-cookie': 'boese=1' }); return res.end(); }
      if (req.url.startsWith('/api/')) {
        const ok = req.headers.authorization === 'Bearer richtig';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(ok ? { tickets: [] } : { fehler: 'Schlüssel ungültig' }));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'boese=1', 'content-security-policy': "frame-ancestors *" });
      res.end('<p>Modulseite</p>');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, anfragen, port: server.address().port };
}

async function aufbau({ freigabeNoetig = () => false, ohneSchluessel = false } = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-seiten-'));
  const mod = await testModulServer();
  const tickets = { id: 'tickets', name: 'Tickets', typ: 'eigenstaendig', ordner: path.join(ordner, 'tickets'), aktiv: true, seite: { titel: 'Tickets', port: mod.port }, api: true };
  const ohneApi = { id: 'notizen', name: 'Notizen', typ: 'eigenstaendig', ordner: path.join(ordner, 'notizen'), aktiv: true, seite: { titel: 'Notizen', port: mod.port }, api: false };
  for (const m of [tickets, ohneApi]) {
    await mkdir(m.ordner);
    if (!ohneSchluessel) await writeFile(path.join(m.ordner, SCHLUESSEL_DATEI), `${SCHLUESSEL}\r\n`);
  }
  const liste = [tickets, ohneApi];
  const module = {
    ansichten: () => liste.map((m) => berechneAnsicht(m, { freigabe: freigabeNoetig(m) ? { neu: true } : null })),
    finde: (id) => liste.find((m) => m.id === id) ?? null,
    freigabeNoetig,
  };
  const anmeldung = new Anmeldung({
    benutzer: {
      anna: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'sehen', module: {} } },
      bob: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'kein', module: { tickets: 'bedienen' } } },
      chris: { hash: await hashPasswort('geheim-geheim'), rechte: { grund: 'kein', module: {} } },
    },
    sitzungMs: 60_000,
  });
  const meldungen = [];
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, sitzungMs: 60_000, verschluesselt: false, log: (m) => meldungen.push(String(m)) }), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const login = async (name) => {
    const r = await anfrage(port, 'POST', '/login', { kopf: { 'content-type': 'application/x-www-form-urlencoded' }, koerper: `benutzer=${name}&passwort=geheim-geheim` });
    return { cookie: r.kopf['set-cookie'][0].split(';')[0] };
  };
  const ende = async () => {
    server.close();
    mod.server.close();
    await rm(ordner, { recursive: true, force: true });
  };
  return { port, mod, login, ende, meldungen, tickets };
}

test('module.json: seite und api nur bei eigenständigen Modulen, Werte geprüft', () => {
  const basis = { id: 'tickets', name: 'Tickets', typ: 'eigenstaendig' };
  const { modul } = pruefeModul({ ...basis, seite: { titel: ' Tickets ', port: 18520 }, api: true }, 'tickets', '/m/tickets');
  assert.deepEqual(modul.seite, { titel: 'Tickets', port: 18520 });
  assert.equal(modul.api, true);
  assert.equal(pruefeModul({ ...basis, seite: { titel: 'T', port: 18520 } }, 'tickets', '/m').modul.api, false);
  assert.equal(pruefeModul(basis, 'tickets', '/m').modul.seite, undefined);
  for (const seite of [{ titel: 'T', port: 80 }, { titel: 'T', port: 70000 }, { titel: '', port: 18520 }, { titel: 'x'.repeat(41), port: 18520 }, { titel: 'T', port: '18520' }, 'Tickets', null]) {
    assert.match(pruefeModul({ ...basis, seite }, 'tickets', '/m').fehler, /seite muss/, JSON.stringify(seite));
  }
  assert.match(pruefeModul({ ...basis, api: true }, 'tickets', '/m').fehler, /api gibt es nur zusammen mit seite/);
  assert.match(pruefeModul({ ...basis, seite: { titel: 'T', port: 18520 }, api: 'ja' }, 'tickets', '/m').fehler, /api muss/);
  assert.match(pruefeModul({ id: 'p', name: 'P', typ: 'programm', befehl: 'x.exe', seite: { titel: 'T', port: 18520 } }, 'p', '/m/p').fehler, /nur bei typ "eigenstaendig"/);
});

test('Modulseiten: Pfade zerlegen, Tricks abweisen', () => {
  assert.deepEqual(modulWeg('/m/tickets/api/tickets'), { id: 'tickets', rest: '/api/tickets' });
  assert.deepEqual(modulWeg('/m/tickets/'), { id: 'tickets', rest: '/' });
  assert.deepEqual(modulWeg('/m/tickets'), { id: 'tickets', rest: null });
  assert.equal(modulWeg('/api/status'), null);
  assert.equal(modulWeg('/m/Tickets/'), null);
  for (const weg of ['/m/tickets/%2e%2e/x', '/m/tickets/a%2Fb', '/m/tickets/a%5cb', '/m/tickets//x', '/m/tickets/a\\b']) assert.equal(modulWeg(weg).rest, false, weg);
});

test('Modulseiten: Menüpunkt, Weiterleitung mit Benutzer, Rechte, Schutzkopf', async () => {
  const u = await aufbau();
  try {
    // Ohne Anmeldung: Seite → Login, API-Pfad → 401 (JSON für die Seite im Rahmen).
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/')).kopf.location, '/login');
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/api/tickets')).status, 401);
    assert.equal(u.mod.anfragen.length, 0);

    const anna = await u.login('anna');
    const status = JSON.parse((await anfrage(u.port, 'GET', '/api/status', { kopf: anna })).text);
    assert.equal(status.module.find((m) => m.id === 'tickets').seite, 'Tickets');

    assert.equal((await anfrage(u.port, 'GET', '/m/tickets', { kopf: anna })).kopf.location, '/m/tickets/');
    // Vom Browser untergeschobene Angaben zählen nicht, das Cookie geht nicht an das Modul.
    const r = await anfrage(u.port, 'GET', '/m/tickets/seite?filter=neu', { kopf: { ...anna, 'x-monitoring-admin': '1', 'x-monitoring-benutzer': 'chef', 'x-monitoring-schluessel': 'falsch', authorization: 'Basic eA==' } });
    assert.equal(r.status, 200);
    assert.equal(r.text, '<p>Modulseite</p>');
    assert.match(r.kopf['content-security-policy'], /frame-ancestors 'self'/, 'Basis legt die Regeln fest, nicht das Modul');
    assert.equal(r.kopf['set-cookie'], undefined, 'Modul darf keine Cookies setzen');
    const a = u.mod.anfragen.at(-1);
    assert.equal(a.weg, '/seite?filter=neu');
    assert.equal(a.kopf['x-monitoring-benutzer'], 'anna');
    assert.equal(a.kopf['x-monitoring-recht'], 'sehen');
    assert.equal(a.kopf['x-monitoring-admin'], '0');
    assert.equal(a.kopf['x-monitoring-zugang'], 'sitzung');
    assert.equal(a.kopf['x-monitoring-schluessel'], SCHLUESSEL);
    assert.equal(a.kopf.cookie, undefined);
    assert.equal(a.kopf.authorization, undefined);

    // Umleitungen bleiben im Modul.
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/weiter', { kopf: anna })).kopf.location, '/m/tickets/ziel');

    // „sehen“ darf nichts ändern; das Modul bekommt die Anfrage gar nicht.
    const vorher = u.mod.anfragen.length;
    assert.equal((await anfrage(u.port, 'POST', '/m/tickets/api/tickets', { kopf: { ...anna, 'content-type': 'application/json' }, koerper: '{}' })).status, 403);
    assert.equal(u.mod.anfragen.length, vorher);

    const bob = await u.login('bob');
    assert.equal((await anfrage(u.port, 'POST', '/m/tickets/api/x', { kopf: { ...bob, origin: 'https://boese.example' }, koerper: '{}' })).status, 403, 'fremde Herkunft');
    const p = await anfrage(u.port, 'POST', '/m/tickets/api/x', { kopf: { ...bob, 'content-type': 'application/json' }, koerper: '{"betreff":"Drucker"}' });
    assert.equal(p.status, 401, 'Antwort des Moduls kommt durch');
    assert.equal(u.mod.anfragen.at(-1).koerper, '{"betreff":"Drucker"}');
    assert.equal(u.mod.anfragen.at(-1).kopf['x-monitoring-recht'], 'bedienen');
    // bob hat nur Tickets, nicht Notizen.
    assert.equal((await anfrage(u.port, 'GET', '/m/notizen/', { kopf: bob })).status, 404);

    const chris = await u.login('chris');
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/', { kopf: chris })).status, 404);
    assert.equal(JSON.parse((await anfrage(u.port, 'GET', '/api/status', { kopf: chris })).text).module.length, 0);

    const zahl = u.mod.anfragen.length;
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/a%2F..%2Fb', { kopf: anna })).status, 400);
    assert.notEqual((await anfrage(u.port, 'GET', '/m/tickets/%2e%2e/geheim', { kopf: anna })).status, 200, 'URL löst .. auf: kein Modulpfad mehr');
    assert.equal(u.mod.anfragen.length, zahl);
    assert.equal((await anfrage(u.port, 'GET', '/m/gibtsnicht/', { kopf: anna })).status, 404);
  } finally {
    await u.ende();
  }
});

test('Modulseiten: Programm-Zugang mit Schlüssel, Bremse bei Fehlversuchen', async () => {
  const u = await aufbau();
  try {
    const ok = await anfrage(u.port, 'GET', '/m/tickets/api/tickets?status=Neu', { kopf: { authorization: 'Bearer richtig', cookie: 'mb_sitzung=x' } });
    assert.equal(ok.status, 200);
    const a = u.mod.anfragen.at(-1);
    assert.equal(a.weg, '/api/tickets?status=Neu');
    assert.equal(a.kopf.authorization, 'Bearer richtig');
    assert.equal(a.kopf['x-monitoring-zugang'], 'programm');
    assert.equal(a.kopf['x-monitoring-benutzer'], undefined);
    assert.equal(a.kopf['x-monitoring-schluessel'], SCHLUESSEL);
    assert.equal(a.kopf.cookie, undefined);

    // Bearer gilt nur für /api/ und nur bei Modulen mit „api“: true.
    assert.equal((await anfrage(u.port, 'GET', '/m/tickets/', { kopf: { authorization: 'Bearer richtig' } })).kopf.location, '/login');
    assert.equal((await anfrage(u.port, 'GET', '/m/notizen/api/x', { kopf: { authorization: 'Bearer richtig' } })).status, 404);

    for (let i = 0; i < 10; i++) assert.equal((await anfrage(u.port, 'GET', '/m/tickets/api/tickets', { kopf: { authorization: 'Bearer falsch' } })).status, 401);
    const gesperrt = await anfrage(u.port, 'GET', '/m/tickets/api/tickets', { kopf: { authorization: 'Bearer richtig' } });
    assert.equal(gesperrt.status, 429, 'nach 10 Fehlversuchen gesperrt, auch mit richtigem Schlüssel');
    assert.ok(u.meldungen.some((m) => /10 abgewiesene Schlüssel/.test(m)));
  } finally {
    await u.ende();
  }
});

test('Modulseiten: Modul aus, ohne Schlüsseldatei, ohne Freigabe', async () => {
  const u = await aufbau();
  try {
    const anna = await u.login('anna');
    u.mod.server.close();
    await new Promise((r) => setTimeout(r, 50));
    const seite = await anfrage(u.port, 'GET', '/m/tickets/', { kopf: { ...anna, accept: 'text/html' } });
    assert.equal(seite.status, 502);
    assert.match(seite.text, /läuft gerade nicht/);
    assert.match(seite.kopf['content-type'], /text\/html/);
    const api = await anfrage(u.port, 'GET', '/m/tickets/api/tickets', { kopf: anna });
    assert.equal(api.status, 502);
    assert.match(JSON.parse(api.text).fehler, /läuft gerade nicht/);
    await anfrage(u.port, 'GET', '/m/tickets/api/tickets', { kopf: anna });
    assert.equal(u.meldungen.filter((m) => /nicht erreichbar/.test(m)).length, 1, 'nur einmal ins Protokoll');
  } finally {
    await u.ende();
  }

  const ohne = await aufbau({ ohneSchluessel: true });
  try {
    const anna = await ohne.login('anna');
    assert.equal((await anfrage(ohne.port, 'GET', '/m/tickets/api/x', { kopf: anna })).status, 503);
    assert.equal(ohne.mod.anfragen.length, 0);
  } finally {
    await ohne.ende();
  }

  const neu = await aufbau({ freigabeNoetig: (m) => m.id === 'tickets' });
  try {
    const anna = await neu.login('anna');
    const status = JSON.parse((await anfrage(neu.port, 'GET', '/api/status', { kopf: anna })).text);
    assert.equal(status.module.find((m) => m.id === 'tickets').seite, null, 'erst nach der Freigabe im Menü');
    assert.equal((await anfrage(neu.port, 'GET', '/m/tickets/', { kopf: anna })).status, 404);
    assert.equal((await anfrage(neu.port, 'GET', '/m/tickets/api/x', { kopf: { authorization: 'Bearer richtig' } })).status, 404);
    assert.equal(neu.mod.anfragen.length, 0);
  } finally {
    await neu.ende();
  }
});

test('Modul-Update: Ordner „daten“ wandert in die eingesetzte Version', async () => {
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-daten-'));
  try {
    const ordner = path.join(wurzel, 'modules', 'tickets');
    await mkdir(path.join(ordner, 'daten'), { recursive: true });
    await writeFile(path.join(ordner, 'daten', 'tickets.json'), '{"tickets":[1]}');
    await writeFile(path.join(ordner, 'einstellungen.json'), '{}');
    const neu = path.join(wurzel, 'neu');
    await mkdir(neu);
    await writeFile(path.join(neu, 'module.json'), '{}');
    const sicherung = path.join(wurzel, 'sicherung');
    let eingelesen = 0;
    const mu = new Modulupdates({ verwaltung: { einlesen: async () => { eingelesen++; } }, updates: {}, datenOrdner: wurzel });
    await mu.ordnerTauschen({ id: 'tickets', ordner }, neu, sicherung);
    assert.equal(await readFile(path.join(ordner, 'daten', 'tickets.json'), 'utf8'), '{"tickets":[1]}');
    assert.equal(await readFile(path.join(ordner, 'einstellungen.json'), 'utf8'), '{}');
    assert.equal(eingelesen, 1);
    // „Zurück“ nimmt die Daten ebenfalls mit.
    await mu.ordnerTauschen({ id: 'tickets', ordner }, sicherung, path.join(wurzel, 'sicherung2'));
    assert.equal(await readFile(path.join(ordner, 'daten', 'tickets.json'), 'utf8'), '{"tickets":[1]}');
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});
