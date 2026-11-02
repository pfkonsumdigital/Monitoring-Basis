import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { codeHash, codePruefen, neuesGeheimnis, wiederherstellungsCodes } from './zweifaktor.js';

const scryptAsync = promisify(scrypt);
// scrypt nach OWASP-Empfehlung (Password Storage Cheat Sheet): N=2^17, r=8, p=1 (128 MiB je Berechnung).
const PARAMETER = { N: 131072, r: 8, p: 1 };
const maxmem = (N, r) => 256 * N * r;

export async function hashPasswort(passwort) {
  if (typeof passwort !== 'string' || passwort.length < 10) throw new Error('Das Passwort muss mindestens 10 Zeichen lang sein.');
  const salz = randomBytes(16);
  const hash = await scryptAsync(passwort, salz, 32, { ...PARAMETER, maxmem: maxmem(PARAMETER.N, PARAMETER.r) });
  return `scrypt$${PARAMETER.N}$${PARAMETER.r}$${PARAMETER.p}$${salz.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwortStimmt(passwort, gespeichert) {
  const teile = typeof gespeichert === 'string' ? gespeichert.split('$') : [];
  if (teile.length !== 6 || teile[0] !== 'scrypt' || typeof passwort !== 'string') return false;
  const [N, r, p] = teile.slice(1, 4).map(Number);
  const erwartet = Buffer.from(teile[5], 'base64');
  if (!(N >= 1024 && N <= 1048576) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16) || erwartet.length !== 32) return false;
  const hash = await scryptAsync(passwort, Buffer.from(teile[4], 'base64'), 32, { N, r, p, maxmem: maxmem(N, r) });
  return timingSafeEqual(hash, erwartet);
}

// true, wenn ein gespeicherter Hash schwächer ist als die aktuelle Einstellung (wird bei der Anmeldung erneuert).
export function brauchtNeuenHash(gespeichert) {
  const [art, N, r, p] = String(gespeichert ?? '').split('$');
  return art !== 'scrypt' || Number(N) < PARAMETER.N || Number(r) < PARAMETER.r || Number(p) < PARAMETER.p;
}

// Begrenzt gleichzeitige Hash-Berechnungen (jede braucht 128 MiB und spürbar Rechenzeit).
// Ist die Warteschlange voll, wird sofort abgelehnt – viele Anmeldeversuche bremsen die Basis so nicht aus.
class Begrenzer {
  constructor(gleichzeitig, warteschlange) { this.frei = gleichzeitig; this.max = warteschlange; this.wartend = []; }
  async mit(arbeit) {
    if (this.frei === 0) {
      if (this.wartend.length >= this.max) return { ueberlastet: true };
      await new Promise((r) => this.wartend.push(r));
    } else this.frei--;
    try { return { wert: await arbeit() }; }
    finally { const naechster = this.wartend.shift(); if (naechster) naechster(); else this.frei++; }
  }
}

// Sitzungen im Speicher (nach Neustart ist eine neue Anmeldung nötig) und Sperren nach Fehlversuchen:
// je Adresse (5 Versuche) und je Benutzername (10 Versuche, gegen Raten von vielen Adressen aus), je 15 Minuten.
// Sitzungen enden nach leerlaufMs ohne Benutzeraktion und spätestens nach sitzungMs.
// melden(ereignis): { art: 'gesperrt-adresse' | 'gesperrt-benutzer', ... } beim Beginn einer Sperre, { art: 'angemeldet', ... } nach Anmeldung.
// hashErneuern(name, passwort): nach erfolgreicher Anmeldung mit veraltetem Hash.
//
// Zwei-Faktor-Anmeldung (zweiFaktor=true): Nach richtigem Passwort gibt es noch keine Sitzung, sondern einen
// vorläufigen Schritt (5 Minuten, beim Einrichten 10). Erst mit dem Code aus der Authenticator-App oder einem
// Wiederherstellungscode entsteht die Sitzung. Hat ein Benutzer noch keine Zwei-Faktor-Anmeldung, richtet er sie
// dabei ein – nur von Adressen, für die einrichtenErlaubt(adresse) gilt (Firmennetz/VPN).
// Falsche Codes zählen je Benutzer (5 in 15 Minuten, danach Sperre); diese Zählung setzt ein richtiges Passwort nicht
// zurück. Eine solche Sperre heißt: Das Passwort ist jemandem bekannt – dafür gibt es die Meldung 'gesperrt-zweifaktor'.
// zweiFaktorSpeichern(name, geheimnis, codeHashes) und codeVerbraucht(name, hash) speichern in config.json.
export class Anmeldung {
  constructor({ benutzer, sitzungMs, leerlaufMs = Infinity, jetzt = () => Date.now(), maxFehlversuche = 5, maxFehlversucheBenutzer = 10,
    sperreMs = 15 * 60_000, maxEintraege = 10_000, gleichzeitig = 2, warteschlange = 20, melden = () => {}, hashErneuern = null,
    zweiFaktor = false, einrichtenErlaubt = () => true, zweiFaktorSpeichern = async () => {}, codeVerbraucht = async () => {},
    maxCodeFehler = 5, schrittMs = 5 * 60_000, einrichtenMs = 10 * 60_000, maxSchritte = 1000 }) {
    this.benutzer = benutzer;
    this.sitzungMs = sitzungMs;
    this.leerlaufMs = leerlaufMs;
    this.jetzt = jetzt;
    this.maxFehlversuche = maxFehlversuche;
    this.maxFehlversucheBenutzer = maxFehlversucheBenutzer;
    this.sperreMs = sperreMs;
    this.maxEintraege = maxEintraege;
    this.melden = melden;
    this.hashErneuern = hashErneuern;
    Object.assign(this, { zweiFaktor, einrichtenErlaubt, zweiFaktorSpeichern, codeVerbraucht, maxCodeFehler, schrittMs, einrichtenMs, maxSchritte });
    this.schritte = new Map(); // vorläufiges Token → { benutzer, adresse, bis, geheimnis (nur beim Einrichten) }
    this.fehlerCodes = new Map(); // Name → { anzahl, bis }
    this.letzterZeitschritt = new Map(); // Name → zuletzt benutzter Zeitschritt (ein Code gilt nur einmal)
    this.verbraucht = new Set(); // benutzte Wiederherstellungscodes (bis config.json geschrieben ist)
    this.begrenzer = new Begrenzer(gleichzeitig, warteschlange);
    this.sitzungen = new Map();
    this.fehlversuche = new Map(); // Adresse → { anzahl, bis }
    this.fehlversucheBenutzer = new Map(); // Name → { anzahl, bis }
    // Für unbekannte Benutzer wird gegen einen festen Hash geprüft, damit die Antwortzeit gleich bleibt.
    this.platzhalter = hashPasswort(randomBytes(24).toString('base64'));
  }

  #gesperrtIn(liste, schluessel, max) {
    const e = liste.get(schluessel);
    return Boolean(e && e.anzahl >= max && this.jetzt() < e.bis);
  }

  gesperrt(adresse) { return this.#gesperrtIn(this.fehlversuche, adresse, this.maxFehlversuche); }
  benutzerGesperrt(name) { return this.#gesperrtIn(this.fehlversucheBenutzer, name, this.maxFehlversucheBenutzer); }
  zweiFaktorGesperrt(name) { return this.#gesperrtIn(this.fehlerCodes, name, this.maxCodeFehler); }

  // Zählt einen Fehlversuch; liefert true, wenn damit eine Sperre beginnt. Die Liste bleibt begrenzt.
  #zaehlen(liste, schluessel, max) {
    const jetzt = this.jetzt();
    const alt = liste.get(schluessel);
    const anzahl = alt && jetzt < alt.bis ? alt.anzahl + 1 : 1;
    liste.delete(schluessel);
    liste.set(schluessel, { anzahl, bis: jetzt + this.sperreMs });
    if (liste.size > this.maxEintraege) {
      for (const [k, e] of liste) if (e.bis <= jetzt) liste.delete(k);
      for (const k of liste.keys()) { if (liste.size <= this.maxEintraege) break; liste.delete(k); }
    }
    return anzahl === max;
  }

  // Prüft Benutzer und Passwort mit Sperren: true, false, 'gesperrt' oder 'ueberlastet'.
  async pruefen(name, passwort, adresse) {
    if (this.gesperrt(adresse) || this.benutzerGesperrt(name)) return 'gesperrt';
    const eintrag = Object.hasOwn(this.benutzer, name) ? this.benutzer[name] : null;
    const r = await this.begrenzer.mit(async () => await passwortStimmt(passwort, eintrag ? eintrag.hash : await this.platzhalter) && Boolean(eintrag));
    if (r.ueberlastet) return 'ueberlastet';
    if (!r.wert) {
      if (this.#zaehlen(this.fehlversuche, adresse, this.maxFehlversuche)) this.melden({ art: 'gesperrt-adresse', adresse, benutzer: name });
      if (this.#zaehlen(this.fehlversucheBenutzer, name, this.maxFehlversucheBenutzer)) this.melden({ art: 'gesperrt-benutzer', adresse, benutzer: name });
      return this.gesperrt(adresse) || this.benutzerGesperrt(name) ? 'gesperrt' : false;
    }
    this.fehlversuche.delete(adresse);
    this.fehlversucheBenutzer.delete(name);
    if (this.hashErneuern && brauchtNeuenHash(eintrag.hash)) this.hashErneuern(name, passwort);
    return true;
  }

  #sitzungAnlegen(name, adresse, extra = {}) {
    const token = randomBytes(32).toString('base64url');
    const jetzt = this.jetzt();
    const admin = this.benutzer[name].admin === true;
    this.sitzungen.set(token, { benutzer: name, admin, adresse: String(adresse ?? ''), seit: jetzt, zuletzt: jetzt, bis: jetzt + this.sitzungMs });
    this.melden({ art: 'angemeldet', benutzer: name, admin, adresse, ...extra });
    return token;
  }

  // Ohne Zwei-Faktor: Sitzungstoken oder null; 'gesperrt' bzw. 'ueberlastet' wie bei pruefen().
  // Mit Zwei-Faktor statt des Tokens: { zweiterSchritt: <vorläufiges Token>, art: 'code' | 'einrichten' },
  // oder 'einrichten-extern', wenn die Einrichtung von dieser Adresse nicht erlaubt ist.
  async anmelden(name, passwort, adresse) {
    const ok = await this.pruefen(name, passwort, adresse);
    if (ok !== true) return ok === false ? null : ok;
    if (!this.zweiFaktor) return this.#sitzungAnlegen(name, adresse);
    if (this.zweiFaktorGesperrt(name)) return 'gesperrt';
    const einrichten = !this.benutzer[name].zwei_faktor;
    if (einrichten && !this.einrichtenErlaubt(adresse)) return 'einrichten-extern';
    const jetzt = this.jetzt();
    for (const [t, v] of this.schritte) if (jetzt >= v.bis) this.schritte.delete(t);
    for (const t of this.schritte.keys()) { if (this.schritte.size < this.maxSchritte) break; this.schritte.delete(t); }
    const token = randomBytes(32).toString('base64url');
    this.schritte.set(token, { benutzer: name, adresse: String(adresse ?? ''), bis: jetzt + (einrichten ? this.einrichtenMs : this.schrittMs), geheimnis: einrichten ? neuesGeheimnis() : null });
    return { zweiterSchritt: token, art: einrichten ? 'einrichten' : 'code' };
  }

  // Vorläufiger Schritt zum Token (für die Anzeige beim Einrichten), oder null.
  schritt(token) {
    const v = typeof token === 'string' ? this.schritte.get(token) : undefined;
    if (!v) return null;
    if (this.jetzt() >= v.bis || !Object.hasOwn(this.benutzer, v.benutzer)) { this.schritte.delete(token); return null; }
    return { benutzer: v.benutzer, art: v.geheimnis ? 'einrichten' : 'code', geheimnis: v.geheimnis };
  }

  // Zweiter Schritt: Code aus der App (6 Ziffern) oder Wiederherstellungscode.
  // Ergebnis: { token, codes? (neue Wiederherstellungscodes nach dem Einrichten), wiederherstellung?, uebrig? }
  // oder { fehler: 'abgelaufen' | 'gesperrt' | 'falsch' }.
  async zweiterFaktor(vToken, code, adresse) {
    const v = this.schritt(vToken) && this.schritte.get(vToken);
    if (!v) return { fehler: 'abgelaufen' };
    const name = v.benutzer;
    if (this.gesperrt(adresse) || this.zweiFaktorGesperrt(name)) { this.schritte.delete(vToken); return { fehler: 'gesperrt' }; }
    const jetzt = this.jetzt();
    const eingabe = String(code ?? '').slice(0, 64);
    const zf = this.benutzer[name].zwei_faktor;
    let zeitschritt = null;
    let hash = null;
    if (v.geheimnis) zeitschritt = codePruefen(v.geheimnis, eingabe, jetzt);
    else if (zf) {
      zeitschritt = codePruefen(zf.geheimnis, eingabe, jetzt, this.letzterZeitschritt.get(name) ?? -1);
      const h = codeHash(eingabe);
      if (zeitschritt === null && /^[a-z0-9]{10}$/i.test(eingabe.replace(/[\s-]/g, '')) && zf.codes.includes(h) && !this.verbraucht.has(h)) hash = h;
    } else { this.schritte.delete(vToken); return { fehler: 'abgelaufen' }; } // inzwischen zurückgesetzt

    if (zeitschritt === null && hash === null) {
      this.#zaehlen(this.fehlversuche, adresse, this.maxFehlversuche);
      if (this.#zaehlen(this.fehlerCodes, name, this.maxCodeFehler)) this.melden({ art: 'gesperrt-zweifaktor', adresse, benutzer: name });
      if (this.gesperrt(adresse) || this.zweiFaktorGesperrt(name)) { this.schritte.delete(vToken); return { fehler: 'gesperrt' }; }
      return { fehler: 'falsch' };
    }
    // Alles, was einen zweiten Versuch mit demselben Code verhindert, passiert vor dem ersten await.
    this.schritte.delete(vToken);
    if (zeitschritt !== null) this.letzterZeitschritt.set(name, zeitschritt);
    if (hash) this.verbraucht.add(hash);
    this.fehlerCodes.delete(name);
    this.fehlversuche.delete(adresse);
    let codes = null;
    if (v.geheimnis) {
      const neu = wiederherstellungsCodes();
      await this.zweiFaktorSpeichern(name, v.geheimnis, neu.hashes);
      codes = neu.codes;
    }
    if (hash) await this.codeVerbraucht(name, hash);
    const token = this.#sitzungAnlegen(name, adresse, { zweiFaktor: v.geheimnis ? 'eingerichtet' : hash ? 'wiederherstellungscode' : 'app' });
    return { token, codes, wiederherstellung: Boolean(hash), uebrig: hash ? (this.benutzer[name].zwei_faktor?.codes ?? []).filter((c) => !this.verbraucht.has(c)).length : undefined };
  }

  // Nach dem Zurücksetzen der Zwei-Faktor-Anmeldung eines Benutzers.
  zweiFaktorVergessen(name) {
    this.letzterZeitschritt.delete(name);
    for (const [t, v] of this.schritte) if (v.benutzer === name) this.schritte.delete(t);
  }

  // Gültige Sitzung zum Token (oder null). aktiv=false für automatische Anfragen der Oberfläche (zählen nicht als Aktivität).
  sitzung(token, { aktiv = true } = {}) {
    const s = typeof token === 'string' ? this.sitzungen.get(token) : undefined;
    if (!s) return null;
    const jetzt = this.jetzt();
    if (jetzt >= s.bis || jetzt - s.zuletzt >= this.leerlaufMs) { this.sitzungen.delete(token); return null; }
    if (aktiv) s.zuletzt = jetzt;
    return s;
  }

  abmelden(token) { this.sitzungen.delete(token); }

  // Angemeldete Sitzungen für die Anzeige (ohne Token), neueste Aktivität zuerst; „eigene“ markiert die anfragende.
  liste(eigenesToken = null) {
    const jetzt = this.jetzt();
    const iso = (ms) => new Date(ms).toISOString();
    return [...this.sitzungen].filter(([, s]) => jetzt < s.bis && jetzt - s.zuletzt < this.leerlaufMs)
      .map(([token, s]) => ({ benutzer: s.benutzer, admin: s.admin, adresse: s.adresse, seit: iso(s.seit), zuletzt: iso(s.zuletzt), bis: iso(Math.min(s.bis, s.zuletzt + this.leerlaufMs)), eigene: token === eigenesToken }))
      .sort((a, b) => b.zuletzt.localeCompare(a.zuletzt));
  }

  // Beendet alle Sitzungen eines Benutzers, außer der mit „ausser“ (z. B. die eigene beim Passwortwechsel).
  sitzungenBeenden(name, ausser = null) {
    let anzahl = 0;
    for (const [token, s] of this.sitzungen) if (s.benutzer === name && token !== ausser) { this.sitzungen.delete(token); anzahl++; }
    return anzahl;
  }

  // Admin-Recht in laufenden Sitzungen sofort übernehmen.
  adminUebernehmen(name, admin) {
    for (const s of this.sitzungen.values()) if (s.benutzer === name) s.admin = admin;
  }
}
