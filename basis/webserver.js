import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasisFehler } from './fehler.js';
import { melde } from './protokoll.js';
import { Benutzerfehler, BenutzerUnbekannt } from './benutzerverwaltung.js';
import { otpauthUri, qrBild } from './zweifaktor.js';

const OEFFENTLICH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'oberflaeche');
const DATEIEN = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SICHERHEIT = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  // same-origin statt no-referrer: sonst senden Browser bei Formularen "Origin: null"
  // und die Herkunftsprüfung würde jede Anmeldung ablehnen.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const COOKIE = 'mb_sitzung';
const COOKIE_2FA = 'mb_2fa';
const html = (t) => String(t).replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[z]);
const LOGIN_MELDUNGEN = {
  '1': 'Benutzername oder Passwort falsch.',
  gesperrt: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.',
  ueberlastet: 'Gerade laufen zu viele Anmeldeversuche. Bitte gleich noch einmal versuchen.',
  update: 'Die Basis wurde neu gestartet. Bitte erneut anmelden.',
  abgelaufen: 'Die Sitzung ist abgelaufen. Bitte erneut anmelden.',
  'zf-abgelaufen': 'Die Zeit für den Bestätigungscode ist abgelaufen. Bitte erneut anmelden.',
  'einrichten-extern': 'Die Zwei-Faktor-Anmeldung muss einmalig im Firmennetz oder über VPN eingerichtet werden. Danach geht die Anmeldung auch von außen.',
};

function senden(res, status, inhalt, typ = 'text/plain; charset=utf-8', kopf = {}) {
  res.writeHead(status, { ...SICHERHEIT, 'Content-Type': typ, ...kopf });
  res.end(inhalt);
}
const json = (res, status, wert) => senden(res, status, JSON.stringify(wert), 'application/json; charset=utf-8');
const weiter = (res, ziel, kopf = {}) => { res.writeHead(303, { ...SICHERHEIT, Location: ziel, ...kopf }); res.end(); };

function cookieLesen(req, gesucht = COOKIE) {
  for (const teil of (req.headers.cookie || '').split(';')) {
    const [name, ...wert] = teil.trim().split('=');
    if (name === gesucht) return wert.join('=');
  }
  return null;
}

function koerperLesen(req, max = 10_000) {
  return new Promise((resolve, reject) => {
    let daten = '';
    req.setEncoding('utf8');
    req.on('data', (teil) => {
      daten += teil;
      if (daten.length > max) { reject(new Error('zu groß')); req.destroy(); }
    });
    req.on('end', () => resolve(daten));
    req.on('error', reject);
  });
}

// Private und lokale Adressen (IPv4 und IPv6, auch als ::ffff:a.b.c.d).
export function istInterneAdresse(adresse) {
  const a = String(adresse ?? '').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return a === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}

// verschluesselt=false: Betrieb per HTTP im internen Netz (tls.modus "aus"). Dann kein Secure-Cookie und kein HSTS,
// und mit nurIntern werden Anfragen von außerhalb privater Netze abgewiesen.
// adminNetz(adresse): true, wenn Admin-Funktionen von dieser Adresse erlaubt sind (Firmennetz/VPN, siehe admin_netze).
export function erstelleAnwendung({ module, modulupdates = null, benachrichtigung = null, benutzerverwaltung = null, domain = null, anmeldung, updates, protokoll, neustart, beenden = null, sitzungMs, verschluesselt = true, nurIntern = false, adminNetz = () => true, hostname = null, log = () => {} }) {
  const schema = verschluesselt ? 'https' : 'http';
  const sicher = verschluesselt ? ' Secure;' : '';
  // Fremde Seiten dürfen keine Aktionen auslösen: Origin muss passen, falls der Browser ihn sendet.
  const herkunftOk = (req) => !req.headers.origin || req.headers.origin === `${schema}://${req.headers.host}`;
  const abgewiesen = new Set();
  const seiteCache = new Map();
  const seite = async (name) => {
    if (!seiteCache.has(name)) seiteCache.set(name, await readFile(path.join(OEFFENTLICH, name), 'utf8'));
    return seiteCache.get(name);
  };

  return async function verarbeiten(req, res) {
    try {
      if (verschluesselt) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (nurIntern && !istInterneAdresse(req.socket.remoteAddress)) {
        // Jede fremde Adresse nur einmal melden, damit Scans das Protokoll nicht fluten.
        if (abgewiesen.size < 1000 && !abgewiesen.has(req.socket.remoteAddress)) {
          abgewiesen.add(req.socket.remoteAddress);
          melde(log, 'warnung', 'Webserver', `Zugriff von externer Adresse ${req.socket.remoteAddress} abgewiesen (nur internes Netz erlaubt).`);
        }
        return senden(res, 403, 'Zugriff nur aus dem internen Netz.');
      }
      const url = new URL(req.url, 'https://basis.invalid');
      const weg = url.pathname;

      if (req.method === 'GET' && DATEIEN[weg]) {
        const [datei, typ] = DATEIEN[weg];
        return senden(res, 200, await readFile(path.join(OEFFENTLICH, datei)), typ);
      }

      if (weg === '/login' && req.method === 'GET') {
        const meldung = LOGIN_MELDUNGEN[url.searchParams.get('fehler')] ?? '';
        const seiteHtml = (await seite('login.html')).replace('{{meldung}}', meldung);
        return senden(res, 200, seiteHtml, 'text/html; charset=utf-8');
      }
      const sitzungCookie = (wert) => `${COOKIE}=${wert}; Path=/; HttpOnly;${sicher} SameSite=Strict; Max-Age=${Math.floor(sitzungMs / 1000)}`;
      const schrittCookie = (wert, sekunden) => `${COOKIE_2FA}=${wert}; Path=/login; HttpOnly;${sicher} SameSite=Strict; Max-Age=${sekunden}`;
      if (weg === '/login' && req.method === 'POST') {
        if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
        const felder = new URLSearchParams(await koerperLesen(req));
        const name = String(felder.get('benutzer') ?? '').slice(0, 64);
        const ergebnis = await anmeldung.anmelden(felder.get('benutzer') ?? '', felder.get('passwort') ?? '', req.socket.remoteAddress);
        if (ergebnis === 'ueberlastet') { melde(log, 'warnung', 'Anmeldung', `Anmeldung abgewiesen: zu viele gleichzeitige Anmeldeversuche (Adresse ${req.socket.remoteAddress}).`); return weiter(res, '/login?fehler=ueberlastet'); }
        if (ergebnis === 'gesperrt') { melde(log, 'warnung', 'Anmeldung', `Anmeldung nach zu vielen Fehlversuchen gesperrt (Adresse ${req.socket.remoteAddress}, Benutzer ${JSON.stringify(name)}).`); return weiter(res, '/login?fehler=gesperrt'); }
        if (ergebnis === 'einrichten-extern') { melde(log, 'warnung', 'Anmeldung', `${name}: Zwei-Faktor-Einrichtung von außerhalb (${req.socket.remoteAddress}) abgewiesen.`); return weiter(res, '/login?fehler=einrichten-extern'); }
        if (!ergebnis) { log(`Fehlgeschlagene Anmeldung von ${req.socket.remoteAddress}.`); return weiter(res, '/login?fehler=1'); }
        if (typeof ergebnis === 'object') {
          return weiter(res, '/login/2fa', { 'Set-Cookie': schrittCookie(ergebnis.zweiterSchritt, ergebnis.art === 'einrichten' ? 600 : 300) });
        }
        log(`Anmeldung: ${name} von ${req.socket.remoteAddress}.`);
        return weiter(res, '/', { 'Set-Cookie': sitzungCookie(ergebnis) });
      }

      // Zweiter Schritt der Anmeldung: Code aus der App eingeben bzw. die App einrichten.
      if (weg === '/login/2fa' && (req.method === 'GET' || req.method === 'POST')) {
        const vToken = cookieLesen(req, COOKIE_2FA);
        const schritt = anmeldung.schritt?.(vToken);
        const loeschen = { 'Set-Cookie': schrittCookie('', 0) };
        if (!schritt) return weiter(res, '/login?fehler=zf-abgelaufen', loeschen);
        const zeigen = async (titel, inhalt, kopf = {}) => senden(res, 200, (await seite('zweifaktor.html')).replace(/\{\{titel\}\}/g, () => html(titel)).replace('{{inhalt}}', () => inhalt), 'text/html; charset=utf-8', kopf);
        const weiterKnopf = '<a class="knopf-link" href="/">Weiter zur Übersicht</a>';
        if (req.method === 'POST') {
          if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
          const felder = new URLSearchParams(await koerperLesen(req));
          const r = await anmeldung.zweiterFaktor(vToken, felder.get('code') ?? '', req.socket.remoteAddress);
          if (r.fehler === 'falsch') return weiter(res, '/login/2fa?fehler=1');
          if (r.fehler === 'gesperrt') { melde(log, 'warnung', 'Anmeldung', `Zwei-Faktor-Anmeldung von ${schritt.benutzer} gesperrt (Adresse ${req.socket.remoteAddress}).`); return weiter(res, '/login?fehler=gesperrt', loeschen); }
          if (r.fehler) return weiter(res, '/login?fehler=zf-abgelaufen', loeschen);
          log(`Anmeldung: ${schritt.benutzer} von ${req.socket.remoteAddress} (zwei Faktoren${r.codes ? ', gerade eingerichtet' : r.wiederherstellung ? ', mit Wiederherstellungscode' : ''}).`);
          const kopf = { 'Set-Cookie': [sitzungCookie(r.token), schrittCookie('', 0)] };
          if (r.codes) {
            return zeigen('Wiederherstellungscodes', `<p>Die Zwei-Faktor-Anmeldung ist eingerichtet.</p>
  <p>Falls das Handy einmal fehlt, kann man sich mit einem dieser Codes anmelden. <strong>Jeder Code gilt nur einmal.</strong> Bitte jetzt notieren oder ausdrucken und sicher aufbewahren – nicht auf demselben Handy. Die Codes werden nur dieses eine Mal angezeigt.</p>
  <ul class="zf-codes">${r.codes.map((c) => `<li>${html(c)}</li>`).join('')}</ul>
  ${weiterKnopf}`, kopf);
          }
          if (r.wiederherstellung) {
            return zeigen('Angemeldet', `<p class="zf-warnung">Angemeldet mit einem Wiederherstellungscode. Es sind noch ${r.uebrig} übrig.</p>
  <p>Ist das Handy verloren oder die App gelöscht, bitte einen Admin bitten, die Zwei-Faktor-Anmeldung unter „Benutzer“ zurückzusetzen. Beim nächsten Anmelden wird sie dann neu eingerichtet.</p>
  ${weiterKnopf}`, kopf);
          }
          return weiter(res, '/', kopf);
        }
        const fehler = url.searchParams.get('fehler') === '1' ? 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.' : '';
        const formular = (hinweis) => `<p class="meldung" role="alert">${fehler}</p>
  <form method="post" action="/login/2fa">
    <label>${hinweis}<input name="code" autocomplete="one-time-code" required autofocus maxlength="20" spellcheck="false" autocapitalize="off"></label>
    <button type="submit">Bestätigen</button>
  </form>
  <a class="zf-abbrechen" href="/login">Abbrechen</a>`;
        if (schritt.art === 'einrichten') {
          const uri = otpauthUri(schritt.benutzer, schritt.geheimnis, hostname ? `Monitoring (${hostname})` : 'Monitoring');
          const gruppen = schritt.geheimnis.match(/.{1,4}/g).join(' ');
          return zeigen('Zwei-Faktor-Anmeldung einrichten', `<p class="unterzeile">Für ${html(schritt.benutzer)} – einmalig, dauert eine Minute.</p>
  <ol>
    <li>Auf dem Handy eine Authenticator-App öffnen (z. B. Microsoft Authenticator, Google Authenticator) und ein Konto hinzufügen.</li>
    <li>Diesen QR-Code scannen:<img class="zf-qr" src="${qrBild(uri)}" alt="QR-Code für die Authenticator-App">
      <span class="zf-hinweis">Geht das Scannen nicht, den Schlüssel von Hand eingeben (zeitbasiert):</span>
      <code class="zf-geheimnis">${html(gruppen)}</code></li>
    <li>Den 6-stelligen Code aus der App hier eingeben.</li>
  </ol>
  ${formular('Code aus der App')}`);
        }
        return zeigen('Bestätigungscode', `<p class="unterzeile">Benutzer: ${html(schritt.benutzer)}</p>
  ${formular('6-stelliger Code aus der Authenticator-App (oder ein Wiederherstellungscode)')}`);
      }

      const token = cookieLesen(req);
      // Automatische Anfragen der Oberfläche (Kopf X-Monitor-Hintergrund) zählen nicht als Aktivität – sonst liefe
      // die Leerlauf-Abmeldung bei offener Seite nie ab.
      const sitzung = anmeldung.sitzung(token, { aktiv: req.headers['x-monitor-hintergrund'] !== '1' });
      if (!sitzung) {
        if (weg.startsWith('/api/')) return json(res, 401, { fehler: 'Nicht angemeldet.' });
        return weiter(res, '/login');
      }

      // Admin-Rechte gelten nur aus dem Firmennetz/VPN (admin_netze); von außen ist ein Admin wie ein normaler Benutzer.
      const istAdmin = sitzung.admin === true && adminNetz(req.socket.remoteAddress);
      const adminNurIntern = sitzung.admin === true && !istAdmin;

      if (weg === '/logout' && req.method === 'POST') {
        if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
        anmeldung.abmelden(token);
        return weiter(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly;${sicher} SameSite=Strict; Max-Age=0` });
      }
      if (weg === '/' && req.method === 'GET') return senden(res, 200, await seite('index.html'), 'text/html; charset=utf-8');

      if (weg === '/api/status' && req.method === 'GET') {
        return json(res, 200, { benutzer: sitzung.benutzer, admin: istAdmin, adminNurIntern, neustartMoeglich: Boolean(istAdmin && neustart), beendenMoeglich: Boolean(istAdmin && beenden), version: updates?.installiert ?? null, updateVerfuegbar: Boolean(istAdmin && updates?.status().updateMoeglich), serverZeit: new Date().toISOString(),
          module: module.ansichten().map((m) => (istAdmin && modulupdates && m.repo ? { ...m, updateVerfuegbar: modulupdates.verfuegbar(m.id) } : m)) });
      }
      // Eigenes Passwort ändern (jeder angemeldete Benutzer, bisheriges Passwort nötig).
      if (weg === '/api/passwort') {
        if (!benutzerverwaltung || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        try { await benutzerverwaltung.eigenesPasswort(sitzung.benutzer, eingabe?.alt, eingabe?.neu, token, req.socket.remoteAddress); }
        catch (fehler) { if (fehler instanceof Benutzerfehler) return json(res, 400, { fehler: fehler.message }); throw fehler; }
        return json(res, 200, { geaendert: true });
      }
      // Benutzerverwaltung (nur Admins): Liste und Sitzungen, anlegen, Passwort setzen, Admin-Recht, löschen.
      const ben = /^\/api\/benutzer(?:\/([A-Za-z0-9._-]{1,64})\/(passwort|admin|loeschen|zweifaktor-zuruecksetzen))?$/.exec(weg);
      if (ben) {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!benutzerverwaltung) return json(res, 404, { fehler: 'Nicht verfügbar.' });
        if (!ben[1] && req.method === 'GET') return json(res, 200, benutzerverwaltung.ansicht(token));
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse((await koerperLesen(req)) || '{}'); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const name = ben[1];
        try {
          if (!ben[2]) await benutzerverwaltung.anlegen({ name: eingabe?.name, passwort: eingabe?.passwort, admin: eingabe?.admin === true }, sitzung.benutzer);
          else if (ben[2] === 'passwort') await benutzerverwaltung.passwortSetzen(name, eingabe?.passwort, sitzung.benutzer, token);
          else if (ben[2] === 'admin') await benutzerverwaltung.adminSetzen(name, eingabe?.admin, sitzung.benutzer);
          else if (ben[2] === 'zweifaktor-zuruecksetzen') await benutzerverwaltung.zweiFaktorZuruecksetzen(name, sitzung.benutzer);
          else await benutzerverwaltung.loeschen(name, sitzung.benutzer);
        } catch (fehler) {
          if (fehler instanceof Benutzerfehler) return json(res, fehler instanceof BenutzerUnbekannt ? 404 : 400, { fehler: fehler.message, ...benutzerverwaltung.ansicht(token) });
          throw fehler;
        }
        return json(res, 200, benutzerverwaltung.ansicht(token));
      }
      // HTTPS & Domain (nur Admins aus dem Firmennetz/VPN).
      const tlsWeg = /^\/api\/tls(?:\/(einstellungen|pruefen|anfragen|umschalten|http))?$/.exec(weg);
      if (tlsWeg) {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!domain) return json(res, 404, { fehler: 'Nicht verfügbar.' });
        if (!tlsWeg[1] && req.method === 'GET') return json(res, 200, await domain.status());
        if (!tlsWeg[1] || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse((await koerperLesen(req)) || '{}'); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        try {
          if (tlsWeg[1] === 'einstellungen') {
            const r = await domain.speichern(eingabe, sitzung.benutzer);
            return r.feldfehler ? json(res, 400, { feldfehler: r.feldfehler }) : json(res, 200, r);
          }
          if (tlsWeg[1] === 'pruefen') return json(res, 200, { pruefung: await domain.pruefen(), status: await domain.status() });
          if (tlsWeg[1] === 'anfragen') return json(res, 202, await domain.anfragen(eingabe?.test !== false, sitzung.benutzer));
          if (tlsWeg[1] === 'umschalten') return json(res, 202, await domain.umschalten(sitzung.benutzer));
          return json(res, 202, await domain.aufHttp(sitzung.benutzer));
        } catch (fehler) {
          if (fehler instanceof BasisFehler) return json(res, 400, { fehler: fehler.message, status: await domain.status().catch(() => null) });
          throw fehler;
        }
      }
      if (weg === '/api/beenden') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (!beenden) return json(res, 409, { fehler: 'Beenden ist hier nicht möglich.' });
        let eingabe;
        try { eingabe = JSON.parse((await koerperLesen(req)) || '{}'); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const mitModulen = eingabe?.module === true;
        log(`Beenden angefordert durch ${sitzung.benutzer}${mitModulen ? ' (mit allen Modulen)' : ''}.`);
        setTimeout(() => beenden({ benutzer: sitzung.benutzer, mitModulen }), 200);
        return json(res, 202, { beendet: true });
      }
      if (weg === '/api/protokoll' || weg === '/api/protokoll/download' || weg === '/api/neustart') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (weg === '/api/neustart') {
          if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
          if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
          if (!neustart) return json(res, 409, { fehler: 'Die Basis wurde nicht über den Starter gestartet und kann sich nicht selbst neu starten.' });
          log(`Neustart angefordert durch ${sitzung.benutzer}.`);
          setTimeout(neustart, 200);
          return json(res, 202, { neustart: true });
        }
        if (req.method !== 'GET' || !protokoll) return json(res, 404, { fehler: 'Nicht gefunden.' });
        const stufe = ['warnung', 'fehler'].includes(url.searchParams.get('stufe')) ? url.searchParams.get('stufe') : undefined;
        const quelle = url.searchParams.get('quelle')?.slice(0, 100) || undefined;
        if (weg === '/api/protokoll/download') {
          const text = protokoll.lesen({ anzahl: 10_000, stufe, quelle }).reverse()
            .map((e) => `${e.zeit} [${e.stufe.toUpperCase()}] [${e.quelle}] ${e.meldung}${e.details ? `\n    ${e.details.replace(/\n/g, '\n    ')}` : ''}`).join('\n');
          return senden(res, 200, text + '\n', 'text/plain; charset=utf-8', { 'Content-Disposition': 'attachment; filename="fehlerprotokoll.txt"' });
        }
        const anzahl = Math.min(Math.max(Number.parseInt(url.searchParams.get('anzahl') ?? '200', 10) || 200, 1), 1000);
        const eintraege = protokoll.lesen({ anzahl, stufe, quelle });
        const quellen = [...new Set(protokoll.lesen({ anzahl: 2000 }).map((e) => String(e.quelle).replace(/^Modul .*/, 'Modul')))].sort();
        return json(res, 200, { eintraege, quellen });
      }

      if (weg === '/api/benachrichtigung' || weg === '/api/benachrichtigung/test' || weg === '/api/benachrichtigung/bericht') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!benachrichtigung) return json(res, 404, { fehler: 'Nicht verfügbar.' });
        if (weg === '/api/benachrichtigung' && req.method === 'GET') return json(res, 200, benachrichtigung.ansicht());
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (weg === '/api/benachrichtigung/test') {
          const ergebnis = await benachrichtigung.testmail(sitzung.benutzer);
          return json(res, ergebnis.ok ? 200 : 409, { ...ergebnis, ...benachrichtigung.ansicht() });
        }
        if (weg === '/api/benachrichtigung/bericht') {
          const ergebnis = await benachrichtigung.berichtSenden(module.ansichten(), sitzung.benutzer);
          return json(res, ergebnis.ok ? 200 : 409, { ...ergebnis, ...benachrichtigung.ansicht() });
        }
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req, 20_000)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const ergebnis = await benachrichtigung.speichern(eingabe?.werte, sitzung.benutzer);
        if (ergebnis.feldfehler) return json(res, 400, { fehler: 'Bitte die markierten Felder prüfen.', feldfehler: ergebnis.feldfehler });
        return json(res, 200, { geaendert: ergebnis.geaendert, ...benachrichtigung.ansicht() });
      }

      if (weg.startsWith('/api/updates')) {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!updates) return json(res, 404, { fehler: 'Updates nicht verfügbar.' });
        if (weg === '/api/updates' && req.method === 'GET') return json(res, 200, updates.status());
        if (weg === '/api/updates/token' || weg === '/api/updates/token/pruefen') {
          if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
          if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
          if (weg === '/api/updates/token/pruefen') return json(res, 200, await updates.tokenTesten());
          let eingabe;
          try { eingabe = JSON.parse(await koerperLesen(req)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
          try {
            return json(res, 200, eingabe?.entfernen === true ? await updates.tokenEntfernen(sitzung.benutzer) : await updates.tokenSpeichern(eingabe?.token, sitzung.benutzer));
          } catch (fehler) {
            return json(res, 400, { fehler: fehler.message, status: updates.status() });
          }
        }
        const aktion = { '/api/updates/suchen': 'suchen', '/api/updates/installieren': 'installieren', '/api/updates/zurueck': 'zurueck' }[weg];
        if (!aktion || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let version;
        if (aktion === 'installieren') {
          try { ({ version } = JSON.parse(await koerperLesen(req))); } catch { return json(res, 400, { fehler: 'Version fehlt.' }); }
        }
        log(`Update-Aktion „${aktion}“ durch ${sitzung.benutzer}.`);
        try {
          return json(res, aktion === 'suchen' ? 200 : 202, await (aktion === 'installieren' ? updates.installieren(String(version)) : updates[aktion]()));
        } catch (fehler) {
          return json(res, 409, { fehler: fehler.message, status: updates.status() });
        }
      }

      const upd = /^\/api\/module\/([a-z0-9-]+)\/update(?:\/(suchen|installieren|zurueck))?$/.exec(weg);
      if (upd) {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!modulupdates || !module.finde(upd[1])) return json(res, 404, { fehler: 'Modul unbekannt.' });
        if (!upd[2] && req.method === 'GET') return json(res, 200, await modulupdates.status(upd[1]));
        if (!upd[2] || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let version;
        if (upd[2] === 'installieren') {
          try { ({ version } = JSON.parse(await koerperLesen(req))); } catch { return json(res, 400, { fehler: 'Version fehlt.' }); }
        }
        try {
          const st = upd[2] === 'suchen' ? await modulupdates.suchen(upd[1])
            : upd[2] === 'installieren' ? await modulupdates.installieren(upd[1], String(version), sitzung.benutzer)
              : await modulupdates.zurueck(upd[1], sitzung.benutzer);
          return json(res, upd[2] === 'suchen' ? 200 : 202, st);
        } catch (fehler) {
          return json(res, 409, { fehler: fehler.message, status: await modulupdates.status(upd[1]) });
        }
      }

      const treffer = /^\/api\/module\/([a-z0-9-]+)\/(verlauf|pruefen|einstellungen|aktiv|beenden|starten|empfaenger)$/.exec(weg);
      const modul = treffer && module.finde(treffer[1]);
      if (treffer && !modul) return json(res, 404, { fehler: 'Modul unbekannt.' });
      if (treffer?.[2] === 'verlauf' && req.method === 'GET') {
        const anzahl = Math.min(Math.max(Number.parseInt(url.searchParams.get('anzahl') ?? '50', 10) || 50, 1), 1000);
        return json(res, 200, { id: modul.id, verlauf: module.verlauf(modul.id, anzahl) });
      }
      if (treffer?.[2] === 'pruefen' && req.method === 'POST') {
        // Eigener Kopf erzwingt eine Same-Origin-Anfrage per fetch; einfache Formulare fremder Seiten scheitern.
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        const ergebnis = module.jetztPruefen(modul.id);
        if (ergebnis !== 'gestartet') return json(res, 409, { fehler: { fehlerhaft: 'Das Modul ist fehlerhaft konfiguriert.', eigenstaendig: 'Dieses Modul läuft eigenständig und meldet sich selbst.', laeuft: 'Die Prüfung läuft bereits.' }[ergebnis] ?? 'Nicht möglich.' });
        log(`Prüfung von ${modul.id} manuell gestartet durch ${sitzung.benutzer}.`);
        return json(res, 202, { gestartet: true });
      }
      if (treffer?.[2] === 'beenden' || treffer?.[2] === 'starten') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (modul.fehler) return json(res, 409, { fehler: 'Das Modul ist fehlerhaft konfiguriert.' });
        const ergebnis = await (treffer[2] === 'beenden' ? module.beenden(modul.id, sitzung.benutzer) : module.starten(modul.id, sitzung.benutzer));
        if (!ergebnis) return json(res, 404, { fehler: 'Modul unbekannt.' });
        return json(res, ergebnis.fehler ? 409 : 200, ergebnis);
      }
      // Zusätzliche Mail-Empfänger dieses Moduls (zu den allgemeinen Empfängern der Benachrichtigung).
      if (treffer?.[2] === 'empfaenger') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (!benachrichtigung) return json(res, 404, { fehler: 'Nicht verfügbar.' });
        if (req.method === 'GET') return json(res, 200, { empfaenger: benachrichtigung.modulEmpfaenger(modul.id), allgemein: benachrichtigung.werte.empfaenger, aktiv: benachrichtigung.werte.aktiv === true && benachrichtigung.eingerichtet() });
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const ergebnis = await benachrichtigung.modulEmpfaengerSpeichern(modul.id, eingabe?.empfaenger ?? '', sitzung.benutzer);
        return json(res, ergebnis.fehler ? 400 : 200, ergebnis);
      }
      if (treffer?.[2] === 'einstellungen' || treffer?.[2] === 'aktiv') {
        if (!istAdmin) return json(res, 403, { fehler: adminNurIntern ? 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.' : 'Nur für Admins.' });
        if (modul.fehler) return json(res, 409, { fehler: 'Das Modul ist fehlerhaft konfiguriert.' });
        if (treffer[2] === 'einstellungen' && req.method === 'GET') return json(res, 200, await module.einstellungen(modul.id));
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req, 100_000)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        if (treffer[2] === 'aktiv') {
          if (typeof eingabe?.aktiv !== 'boolean') return json(res, 400, { fehler: 'aktiv muss true oder false sein.' });
          await module.setzeAktiv(modul.id, eingabe.aktiv, sitzung.benutzer);
          return json(res, 200, { aktiv: eingabe.aktiv });
        }
        const ergebnis = await module.einstellungenAendern(modul.id, eingabe?.werte, sitzung.benutzer);
        if (ergebnis.feldfehler) return json(res, 400, { fehler: 'Bitte die markierten Felder prüfen.', feldfehler: ergebnis.feldfehler });
        return json(res, 200, { geaendert: ergebnis.geaendert, ...(await module.einstellungen(modul.id)) });
      }
      return senden(res, 404, 'Nicht gefunden.');
    } catch (fehler) {
      melde(log, 'fehler', 'Webserver', `Interner Fehler bei ${req.method} ${new URL(req.url, 'https://x').pathname}: ${fehler?.message || fehler}`, fehler);
      if (!res.headersSent) senden(res, 500, 'Interner Fehler.');
      else res.destroy();
    }
  };
}

// Ohne tls (null) läuft der Server per HTTP.
export function starteServer({ anwendung, tls, host, port }) {
  return new Promise((resolve, reject) => {
    const server = tls ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, anwendung) : http.createServer(anwendung);
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
