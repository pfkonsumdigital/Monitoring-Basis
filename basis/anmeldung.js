import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const PARAMETER = { N: 16384, r: 8, p: 1 };

export async function hashPasswort(passwort) {
  if (typeof passwort !== 'string' || passwort.length < 10) throw new Error('Das Passwort muss mindestens 10 Zeichen lang sein.');
  const salz = randomBytes(16);
  const hash = await scryptAsync(passwort, salz, 32, PARAMETER);
  return `scrypt$${PARAMETER.N}$${PARAMETER.r}$${PARAMETER.p}$${salz.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwortStimmt(passwort, gespeichert) {
  const teile = typeof gespeichert === 'string' ? gespeichert.split('$') : [];
  if (teile.length !== 6 || teile[0] !== 'scrypt' || typeof passwort !== 'string') return false;
  const [N, r, p] = teile.slice(1, 4).map(Number);
  const erwartet = Buffer.from(teile[5], 'base64');
  if (!(N >= 1024 && N <= 1048576) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16) || erwartet.length !== 32) return false;
  const hash = await scryptAsync(passwort, Buffer.from(teile[4], 'base64'), 32, { N, r, p, maxmem: 256 * N * r });
  return timingSafeEqual(hash, erwartet);
}

// Sitzungen im Speicher (nach Neustart ist eine neue Anmeldung nötig) und Sperre nach Fehlversuchen.
export class Anmeldung {
  constructor({ benutzer, sitzungMs, jetzt = () => Date.now(), maxFehlversuche = 5, sperreMs = 15 * 60_000 }) {
    this.benutzer = benutzer;
    this.sitzungMs = sitzungMs;
    this.jetzt = jetzt;
    this.maxFehlversuche = maxFehlversuche;
    this.sperreMs = sperreMs;
    this.sitzungen = new Map();
    this.fehlversuche = new Map();
    // Für unbekannte Benutzer wird gegen einen festen Hash geprüft, damit die Antwortzeit gleich bleibt.
    this.platzhalter = hashPasswort(randomBytes(24).toString('base64'));
  }

  gesperrt(adresse) {
    const eintrag = this.fehlversuche.get(adresse);
    return Boolean(eintrag && eintrag.anzahl >= this.maxFehlversuche && this.jetzt() < eintrag.bis);
  }

  // Prüft Benutzer und Passwort mit Sperre nach Fehlversuchen: true, false oder 'gesperrt'.
  async pruefen(name, passwort, adresse) {
    if (this.gesperrt(adresse)) return 'gesperrt';
    const eintrag = Object.hasOwn(this.benutzer, name) ? this.benutzer[name] : null;
    const ok = await passwortStimmt(passwort, eintrag ? eintrag.hash : await this.platzhalter) && Boolean(eintrag);
    if (!ok) {
      const alt = this.fehlversuche.get(adresse);
      const anzahl = alt && this.jetzt() < alt.bis ? alt.anzahl + 1 : 1;
      this.fehlversuche.set(adresse, { anzahl, bis: this.jetzt() + this.sperreMs });
      return this.gesperrt(adresse) ? 'gesperrt' : false;
    }
    this.fehlversuche.delete(adresse);
    return true;
  }

  // Liefert ein Sitzungstoken oder null. 'gesperrt' bei zu vielen Fehlversuchen.
  async anmelden(name, passwort, adresse) {
    const ok = await this.pruefen(name, passwort, adresse);
    if (ok !== true) return ok === 'gesperrt' ? 'gesperrt' : null;
    const token = randomBytes(32).toString('base64url');
    const jetzt = this.jetzt();
    this.sitzungen.set(token, { benutzer: name, admin: this.benutzer[name].admin === true, adresse: String(adresse ?? ''), seit: jetzt, zuletzt: jetzt, bis: jetzt + this.sitzungMs });
    return token;
  }

  // Gültige Sitzung zum Token (oder null); merkt sich die letzte Aktivität.
  sitzung(token) {
    const s = typeof token === 'string' ? this.sitzungen.get(token) : undefined;
    if (!s) return null;
    if (this.jetzt() >= s.bis) { this.sitzungen.delete(token); return null; }
    s.zuletzt = this.jetzt();
    return s;
  }

  abmelden(token) { this.sitzungen.delete(token); }

  // Angemeldete Sitzungen für die Anzeige (ohne Token), neueste Aktivität zuerst; „eigene“ markiert die anfragende.
  liste(eigenesToken = null) {
    const jetzt = this.jetzt();
    const iso = (ms) => new Date(ms).toISOString();
    return [...this.sitzungen].filter(([, s]) => jetzt < s.bis)
      .map(([token, s]) => ({ benutzer: s.benutzer, admin: s.admin, adresse: s.adresse, seit: iso(s.seit), zuletzt: iso(s.zuletzt), bis: iso(s.bis), eigene: token === eigenesToken }))
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
