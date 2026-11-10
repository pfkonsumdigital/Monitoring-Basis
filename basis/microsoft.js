import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { istKlartext, istVerschluesselt } from './geheimnis.js';
import { melde } from './protokoll.js';

// Anmeldung mit Microsoft (Entra ID) per OpenID Connect: Autorisierungscode mit PKCE, vertraulicher Client
// (eigene App-Registrierung mit geheimem Schlüssel). Das ID-Token wird vollständig geprüft: Signatur (Schlüssel von
// Microsoft, zwischengespeichert), Aussteller, Empfänger-App, Mandant, Gültigkeit und Einmalwert (nonce).
// Wer sich anmelden darf, entscheidet die Basis (nur vom Admin angelegte Microsoft-Benutzer, siehe webserver.js).
// Einstellungen in data/microsoft.json; der Schlüssel wird unter Windows verschlüsselt gespeichert.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VORGANG_MS = 10 * 60_000;
const MAX_VORGAENGE = 1000;
const SCHLUESSEL_MS = 24 * 3_600_000;
const SPIELRAUM_S = 300;
const STANDARD = { aktiv: false, tenant_id: '', client_id: '', client_secret: '' };
const b64url = (puffer) => Buffer.from(puffer).toString('base64url');

export class MicrosoftFehler extends Error {}

export function pruefeMicrosoft(eingabe, bisher) {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const text = (k) => (typeof e[k] === 'string' ? e[k].trim() : e[k] === undefined ? bisher[k] : '');
  const werte = {
    aktiv: e.aktiv === undefined ? bisher.aktiv : e.aktiv === true,
    tenant_id: text('tenant_id').toLowerCase(),
    client_id: text('client_id').toLowerCase(),
    // Leer = bisherigen Schlüssel behalten (er wird nie angezeigt).
    client_secret: typeof e.client_secret === 'string' && e.client_secret !== '' ? e.client_secret : bisher.client_secret,
  };
  const feldfehler = {};
  if (werte.tenant_id && !GUID.test(werte.tenant_id)) feldfehler.tenant_id = 'Mandanten-ID (Verzeichnis-ID) als GUID';
  if (werte.client_id && !GUID.test(werte.client_id)) feldfehler.client_id = 'Anwendungs-ID als GUID';
  if (typeof werte.client_secret !== 'string' || werte.client_secret.length > 500) feldfehler.client_secret = 'ungültig';
  if (werte.aktiv) for (const k of ['tenant_id', 'client_id', 'client_secret']) if (!werte[k] && !feldfehler[k]) feldfehler[k] = 'Pflichtfeld, wenn die Anmeldung aktiv ist';
  return Object.keys(feldfehler).length ? { feldfehler } : { werte };
}

// Teile eines JWT ohne Prüfung.
function zerlegen(token) {
  const teile = typeof token === 'string' ? token.split('.') : [];
  if (teile.length !== 3) throw new MicrosoftFehler('ID-Token hat kein gültiges Format.');
  try {
    return { kopf: JSON.parse(Buffer.from(teile[0], 'base64url')), inhalt: JSON.parse(Buffer.from(teile[1], 'base64url')), signiert: `${teile[0]}.${teile[1]}`, signatur: Buffer.from(teile[2], 'base64url') };
  } catch { throw new MicrosoftFehler('ID-Token lässt sich nicht lesen.'); }
}

export class MicrosoftAnmeldung {
  // anbieter: nur für Tests änderbar.
  constructor({ datenOrdner, tresor = null, geheimnisse = [], log = () => {}, fetchImpl = fetch, jetzt = () => Date.now(), anbieter = 'https://login.microsoftonline.com' }) {
    Object.assign(this, { tresor, geheimnisse, log, fetchImpl, jetzt, anbieter });
    this.datei = path.join(datenOrdner, 'microsoft.json');
    this.werte = { ...STANDARD };
    this.vorgaenge = new Map(); // Vorgangs-Token (Cookie) → { state, nonce, verifier, rueckAdresse, bis }
    this.schluessel = null; // { bis, keys }
  }

  async laden() {
    try { this.werte = { ...STANDARD, ...JSON.parse(await readFile(this.datei, 'utf8')) }; } catch { /* noch nicht eingerichtet */ }
    if (istVerschluesselt(this.werte.client_secret)) {
      try { this.werte.client_secret = await this.tresor.einzeln(this.werte.client_secret); }
      catch (fehler) {
        this.werte.client_secret = '';
        melde(this.log, 'fehler', 'Microsoft-Anmeldung', `Der geheime Schlüssel lässt sich nicht entschlüsseln (${fehler.message}). Bitte unter „Microsoft-Anmeldung“ neu eintragen.`);
      }
    }
    this.geheimnisMerken();
  }

  geheimnisMerken() {
    if (this.werte.client_secret && !this.geheimnisse.includes(this.werte.client_secret)) this.geheimnisse.push(this.werte.client_secret);
  }

  eingerichtet() { const w = this.werte; return Boolean(w.aktiv && w.tenant_id && w.client_id && w.client_secret); }

  ansicht() {
    const { client_secret: s, ...rest } = this.werte;
    return { werte: { ...rest, client_secret: { gesetzt: Boolean(s) } }, eingerichtet: this.eingerichtet() };
  }

  async speichern(eingabe, benutzer) {
    const { werte, feldfehler } = pruefeMicrosoft(eingabe, this.werte);
    if (feldfehler) return { feldfehler };
    const vorher = this.werte;
    this.werte = werte;
    this.schluessel = null;
    const datei = this.tresor?.verfuegbar && istKlartext(werte.client_secret) ? { ...werte, client_secret: (await this.tresor.schuetzen([werte.client_secret], 'basis'))[0] } : werte;
    await schreibeAtomar(this.datei, datei);
    this.geheimnisMerken();
    const geaendert = Object.keys(werte).filter((k) => werte[k] !== vorher[k]);
    if (geaendert.length) this.log(`Microsoft-Anmeldung geändert durch ${benutzer}: ${geaendert.map((k) => (k === 'client_secret' ? 'geheimer Schlüssel' : k)).join(', ')}.`);
    return { geaendert };
  }

  // Beginn: Adresse bei Microsoft und Vorgangs-Token (als Cookie zu setzen). rueckAdresse muss in Entra eingetragen sein.
  starten(rueckAdresse) {
    if (!this.eingerichtet()) throw new MicrosoftFehler('Die Anmeldung mit Microsoft ist nicht eingerichtet.');
    const jetzt = this.jetzt();
    for (const [t, v] of this.vorgaenge) if (v.bis <= jetzt) this.vorgaenge.delete(t);
    for (const t of this.vorgaenge.keys()) { if (this.vorgaenge.size < MAX_VORGAENGE) break; this.vorgaenge.delete(t); }
    const vorgang = b64url(randomBytes(32));
    const v = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), rueckAdresse, bis: jetzt + VORGANG_MS };
    this.vorgaenge.set(vorgang, v);
    const p = new URLSearchParams({
      client_id: this.werte.client_id, response_type: 'code', redirect_uri: rueckAdresse, response_mode: 'query', scope: 'openid profile email',
      state: v.state, nonce: v.nonce, code_challenge: b64url(createHash('sha256').update(v.verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
    });
    return { url: `${this.anbieter}/${encodeURIComponent(this.werte.tenant_id)}/oauth2/v2.0/authorize?${p}`, vorgang };
  }

  async anfrage(url, optionen) {
    try { return await this.fetchImpl(url, { ...optionen, signal: AbortSignal.timeout(20_000) }); }
    catch (fehler) { throw new MicrosoftFehler(`Microsoft nicht erreichbar (${fehler.cause?.code ?? fehler.name ?? fehler.message}).`); }
  }

  // Öffentliche Schlüssel des Mandanten (zwischengespeichert; bei unbekannter Schlüssel-ID einmal neu geladen).
  async oeffentlicherSchluessel(kid) {
    for (let versuch = 0; versuch < 2; versuch++) {
      if (versuch || !this.schluessel || this.schluessel.bis <= this.jetzt()) {
        const antwort = await this.anfrage(`${this.anbieter}/${encodeURIComponent(this.werte.tenant_id)}/discovery/v2.0/keys`, {});
        const daten = await antwort.json().catch(() => ({}));
        if (!antwort.ok || !Array.isArray(daten.keys)) throw new MicrosoftFehler(`Schlüssel von Microsoft nicht abrufbar (HTTP ${antwort.status}).`);
        this.schluessel = { bis: this.jetzt() + SCHLUESSEL_MS, keys: daten.keys };
      }
      const jwk = this.schluessel.keys.find((k) => k.kid === kid && k.kty === 'RSA');
      if (jwk) return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      if (versuch) break;
    }
    throw new MicrosoftFehler('Unbekannter Signaturschlüssel im ID-Token.');
  }

  // Prüft das ID-Token. Liefert { oid, tid, adresse, anzeigename }.
  async tokenPruefen(idToken, nonce) {
    const { kopf, inhalt, signiert, signatur } = zerlegen(idToken);
    if (kopf.alg !== 'RS256' || typeof kopf.kid !== 'string') throw new MicrosoftFehler('ID-Token: falsches Verfahren.');
    const schluessel = await this.oeffentlicherSchluessel(kopf.kid);
    if (!verify('RSA-SHA256', Buffer.from(signiert), schluessel, signatur)) throw new MicrosoftFehler('ID-Token: Signatur ungültig.');
    const t = this.werte.tenant_id;
    const jetztS = Math.floor(this.jetzt() / 1000);
    if (inhalt.iss !== `${this.anbieter}/${t}/v2.0`) throw new MicrosoftFehler('ID-Token: falscher Aussteller.');
    if (inhalt.aud !== this.werte.client_id) throw new MicrosoftFehler('ID-Token: für eine andere Anwendung ausgestellt.');
    if (inhalt.tid !== t) throw new MicrosoftFehler('ID-Token: anderer Mandant.');
    if (!(inhalt.exp > jetztS - SPIELRAUM_S)) throw new MicrosoftFehler('ID-Token: abgelaufen.');
    if (inhalt.nbf !== undefined && inhalt.nbf > jetztS + SPIELRAUM_S) throw new MicrosoftFehler('ID-Token: noch nicht gültig.');
    if (inhalt.iat !== undefined && inhalt.iat > jetztS + SPIELRAUM_S) throw new MicrosoftFehler('ID-Token: Ausstellungszeit in der Zukunft.');
    if (typeof nonce !== 'string' || inhalt.nonce !== nonce) throw new MicrosoftFehler('ID-Token: Einmalwert passt nicht.');
    if (!GUID.test(inhalt.oid ?? '')) throw new MicrosoftFehler('ID-Token: keine Konto-ID.');
    const adresse = [inhalt.preferred_username, inhalt.email, inhalt.upn].find((x) => typeof x === 'string' && x.includes('@')) ?? null;
    return { oid: inhalt.oid.toLowerCase(), tid: inhalt.tid.toLowerCase(), adresse, anzeigename: typeof inhalt.name === 'string' ? inhalt.name.slice(0, 200) : null };
  }

  // Rückkehr von Microsoft. Jeder Vorgang gilt nur einmal. Liefert { oid, tid, adresse, anzeigename } oder wirft MicrosoftFehler.
  async abschliessen({ vorgang, state, code, fehler, fehlerText }) {
    const v = typeof vorgang === 'string' ? this.vorgaenge.get(vorgang) : undefined;
    if (v) this.vorgaenge.delete(vorgang);
    if (!v || v.bis <= this.jetzt()) throw new MicrosoftFehler('Der Anmeldevorgang ist abgelaufen oder unbekannt. Bitte erneut anmelden.');
    if (typeof state !== 'string' || state !== v.state) throw new MicrosoftFehler('Der Anmeldevorgang passt nicht (state).');
    if (fehler) throw new MicrosoftFehler(`Microsoft meldet: ${String(fehler).slice(0, 100)}${fehlerText ? ` – ${String(fehlerText).split(/\r?\n/)[0].slice(0, 300)}` : ''}`);
    if (typeof code !== 'string' || !code || code.length > 4000) throw new MicrosoftFehler('Kein Code von Microsoft erhalten.');
    if (!this.eingerichtet()) throw new MicrosoftFehler('Die Anmeldung mit Microsoft ist nicht eingerichtet.');
    const antwort = await this.anfrage(`${this.anbieter}/${encodeURIComponent(this.werte.tenant_id)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.werte.client_id, client_secret: this.werte.client_secret, grant_type: 'authorization_code', code, redirect_uri: v.rueckAdresse, code_verifier: v.verifier, scope: 'openid profile email' }),
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok || typeof daten.id_token !== 'string') {
      const c = String(daten.error_description ?? '').match(/AADSTS\d+/)?.[0];
      throw new MicrosoftFehler(`Code-Einlösung bei Microsoft fehlgeschlagen (${c ?? daten.error ?? `HTTP ${antwort.status}`}). Anwendungs-ID, geheimen Schlüssel und Rückkehr-Adresse in Entra prüfen.`);
    }
    return this.tokenPruefen(daten.id_token, v.nonce);
  }
}
