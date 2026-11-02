import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';

// Sicherheitsmeldungen per Mail (über die eingerichtete Benachrichtigung) und im Protokoll:
// - eine Anmeldung wird nach Fehlversuchen gesperrt (je Adresse oder je Benutzername),
// - ein Admin meldet sich von einer Adresse an, die für ihn neu ist,
// - falsche Zwei-Faktor-Codes nach richtigem Passwort (Passwort vermutlich bekannt),
// - Anmeldung mit einem Wiederherstellungscode.
// Höchstens eine Mail je Art und 15 Minuten; unterdrückte Ereignisse werden in der nächsten Mail mitgezählt.
// Bekannte Adressen je Benutzer (die letzten 20) liegen in data/anmeldeorte.json.

const SPERRE_MAIL_MS = 15 * 60_000;
const MAX_ORTE = 20;
const zeitText = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
const adresseText = (a) => String(a ?? '').replace(/^::ffff:/, '');

export class Sicherheitsmeldungen {
  constructor({ datenOrdner, benachrichtigung = null, log = () => {}, jetzt = () => Date.now() }) {
    Object.assign(this, { benachrichtigung, log, jetzt });
    this.datei = path.join(datenOrdner, 'anmeldeorte.json');
    this.orte = {};
    this.letzteMail = {};
    this.unterdrueckt = {};
    this.kette = Promise.resolve();
  }

  async laden() {
    try { this.orte = JSON.parse(await readFile(this.datei, 'utf8')) ?? {}; } catch { this.orte = {}; }
  }

  // Ereignisse aus der Anmeldung (siehe Anmeldung.melden). Wird nicht abgewartet; Fehler landen im Protokoll.
  ereignis(e) {
    this.kette = this.kette.then(() => this.verarbeiten(e)).catch((f) => melde(this.log, 'fehler', 'Sicherheit', `Sicherheitsmeldung fehlgeschlagen: ${f.message}`));
    return this.kette;
  }

  async verarbeiten(e) {
    const jetzt = this.jetzt();
    if (e.art === 'gesperrt-adresse' || e.art === 'gesperrt-benutzer') {
      const text = e.art === 'gesperrt-adresse'
        ? `Anmeldung von Adresse ${adresseText(e.adresse)} für 15 Minuten gesperrt (zu viele Fehlversuche, zuletzt Benutzer „${String(e.benutzer).slice(0, 64)}“).`
        : `Benutzer „${String(e.benutzer).slice(0, 64)}“ für 15 Minuten gesperrt (zu viele Fehlversuche von verschiedenen Adressen, zuletzt ${adresseText(e.adresse)}). Das kann ein gezielter Rateversuch sein.`;
      melde(this.log, 'warnung', 'Sicherheit', text);
      await this.mail('sperre', '[Monitoring] Sicherheit: Anmeldung gesperrt', text, jetzt);
      return;
    }
    if (e.art === 'gesperrt-zweifaktor') {
      // Das Passwort war richtig, nur der Code nicht: Das Passwort ist vermutlich jemandem bekannt.
      const text = `Benutzer „${String(e.benutzer).slice(0, 64)}“: mehrere falsche Zwei-Faktor-Codes nach richtigem Passwort (zuletzt von ${adresseText(e.adresse)}). Die Zwei-Faktor-Anmeldung ist für 15 Minuten gesperrt.\nWar das nicht ${e.benutzer} selbst, ist das Passwort vermutlich bekannt – bitte sofort ändern.`;
      melde(this.log, 'warnung', 'Sicherheit', text);
      await this.mail(`zweifaktor-${e.benutzer}`, `[Monitoring] Sicherheit: falsche Zwei-Faktor-Codes (${e.benutzer})`, text, jetzt);
      return;
    }
    if (e.art === 'angemeldet' && e.zweiFaktor === 'wiederherstellungscode') {
      const text = `Benutzer „${e.benutzer}“ hat sich mit einem Wiederherstellungscode angemeldet (Adresse ${adresseText(e.adresse)}, ${zeitText(jetzt)}).\nWar das nicht ${e.benutzer}, sofort die Zwei-Faktor-Anmeldung unter „Benutzer“ zurücksetzen und das Passwort ändern.`;
      melde(this.log, 'warnung', 'Sicherheit', text);
      await this.mail(`wiederherstellung-${e.benutzer}`, `[Monitoring] Sicherheit: Anmeldung mit Wiederherstellungscode (${e.benutzer})`, text, jetzt);
    }
    if (e.art === 'angemeldet') {
      const bekannt = this.orte[e.benutzer] ?? [];
      const adresse = adresseText(e.adresse);
      const neu = bekannt.length > 0 && !bekannt.includes(adresse);
      this.orte[e.benutzer] = [adresse, ...bekannt.filter((a) => a !== adresse)].slice(0, MAX_ORTE);
      await schreibeAtomar(this.datei, this.orte);
      if (neu && e.admin) {
        const text = `Admin „${e.benutzer}“ hat sich von einer neuen Adresse angemeldet: ${adresse} (${zeitText(jetzt)}).\nWar das nicht ${e.benutzer}, sofort das Passwort ändern und die Sitzungen unter „Benutzer“ prüfen.`;
        this.log(`Admin ${e.benutzer} von neuer Adresse ${adresse} angemeldet.`);
        await this.mail(`neu-${e.benutzer}`, `[Monitoring] Sicherheit: Admin-Anmeldung von neuer Adresse (${e.benutzer})`, text, jetzt);
      }
    }
  }

  async mail(art, betreff, text, jetzt) {
    if (this.letzteMail[art] && jetzt - this.letzteMail[art] < SPERRE_MAIL_MS) {
      this.unterdrueckt[art] = (this.unterdrueckt[art] ?? 0) + 1;
      return;
    }
    const weitere = this.unterdrueckt[art] ?? 0;
    this.unterdrueckt[art] = 0;
    this.letzteMail[art] = jetzt;
    await this.benachrichtigung?.sicherheit(betreff, weitere ? `${text}\n\nSeit der letzten Mail ${weitere} weitere solche Ereignisse (siehe Protokoll).` : text);
  }
}
