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

  // Liefert ein Sitzungstoken oder null. 'gesperrt' bei zu vielen Fehlversuchen.
  async anmelden(name, passwort, adresse) {
    if (this.gesperrt(adresse)) return 'gesperrt';
    const eintrag = Object.hasOwn(this.benutzer, name) ? this.benutzer[name] : null;
    const ok = await passwortStimmt(passwort, eintrag ? eintrag.hash : await this.platzhalter) && Boolean(eintrag);
    if (!ok) {
      const alt = this.fehlversuche.get(adresse);
      const anzahl = alt && this.jetzt() < alt.bis ? alt.anzahl + 1 : 1;
      this.fehlversuche.set(adresse, { anzahl, bis: this.jetzt() + this.sperreMs });
      return this.gesperrt(adresse) ? 'gesperrt' : null;
    }
    this.fehlversuche.delete(adresse);
    const token = randomBytes(32).toString('base64url');
    this.sitzungen.set(token, { benutzer: name, admin: eintrag.admin === true, bis: this.jetzt() + this.sitzungMs });
    return token;
  }

  sitzung(token) {
    const s = typeof token === 'string' ? this.sitzungen.get(token) : undefined;
    if (!s) return null;
    if (this.jetzt() >= s.bis) { this.sitzungen.delete(token); return null; }
    return s;
  }

  abmelden(token) { this.sitzungen.delete(token); }
}
