import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { hashPasswort } from './anmeldung.js';
import { konfigSchuetzen } from './geheimnis.js';
import { pruefeRechte, rechteText, STUFEN } from './rechte.js';

// Benutzer in der Oberfläche verwalten: anlegen, Passwort setzen, Admin-Recht ändern, löschen, eigenes Passwort ändern.
// Gespeichert wird wie bei „--benutzer-anlegen“ in config.json (nur scrypt-Hashes), vorher eine Sicherungskopie
// config.json.vor-benutzeraenderung.json. Änderungen gelten sofort, ohne Neustart.

export class Benutzerfehler extends Error {}
export class BenutzerUnbekannt extends Benutzerfehler {}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const gleicheAdresse = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const MIN_PASSWORT = 12;
const MAX_PASSWORT = 200;
// Häufige Passwörter und Bestandteile, die Angreifer zuerst probieren (Auszug; reicht gegen das grobe Raten).
const HAEUFIG = ['passwort', 'password', 'kennwort', 'qwertz', 'qwerty', 'asdf', '123456', 'abc123', 'admin', 'administrator', 'monitoring',
  'konsum', 'weimar', 'letmein', 'welcome', 'willkommen', 'sommer', 'winter', 'fruehling', 'herbst', 'hallo', 'geheim', 'test', 'iloveyou', 'dragon', 'master'];

// Regeln für neue Passwörter. Liefert einen Fehlertext oder null. Bestehende Passwörter gelten weiter.
export function passwortRegelFehler(name, passwort) {
  if (typeof passwort !== 'string' || passwort.length < MIN_PASSWORT) return `Das Passwort muss mindestens ${MIN_PASSWORT} Zeichen lang sein.`;
  if (passwort.length > MAX_PASSWORT) return `Das Passwort darf höchstens ${MAX_PASSWORT} Zeichen lang sein.`;
  const klein = passwort.toLowerCase();
  if (typeof name === 'string' && name.length >= 3 && klein.includes(name.toLowerCase())) return 'Das Passwort darf den Benutzernamen nicht enthalten.';
  if (new Set(klein).size < 5) return 'Das Passwort hat zu wenige verschiedene Zeichen.';
  // Ohne bekannte Wörter muss noch genug eigener Text übrig bleiben.
  let rest = klein;
  for (const w of HAEUFIG) rest = rest.split(w).join('');
  if (rest.length < 8) return 'Das Passwort besteht zu sehr aus bekannten Wörtern (z. B. „Passwort“, „Sommer“, „123456“). Bitte einen längeren Satz oder mehrere zufällige Wörter verwenden.';
  return null;
}

async function hashFuer(name, passwort) {
  const fehler = passwortRegelFehler(name, passwort);
  if (fehler) throw new Benutzerfehler(fehler);
  return hashPasswort(passwort);
}

const admins = (benutzer) => Object.keys(benutzer).filter((n) => benutzer[n].admin === true);

// Schlüssel der Authenticator-Apps stehen in config.json verschlüsselt (tresor), im Speicher als Klartext.
async function zweiFaktorUmwandeln(benutzer, umwandeln) {
  const namen = Object.keys(benutzer).filter((n) => typeof benutzer[n]?.zwei_faktor?.geheimnis === 'string');
  if (!namen.length) return benutzer;
  const werte = await umwandeln(namen.map((n) => benutzer[n].zwei_faktor.geheimnis));
  const kopie = { ...benutzer };
  namen.forEach((n, i) => { kopie[n] = { ...kopie[n], zwei_faktor: { ...kopie[n].zwei_faktor, geheimnis: werte[i] } }; });
  return kopie;
}

export class Benutzerverwaltung {
  constructor({ configDatei, anmeldung, tresor = null, log = () => {} }) {
    this.configDatei = configDatei;
    this.anmeldung = anmeldung;
    this.tresor = tresor;
    this.log = log;
    this.kette = Promise.resolve();
  }

  // Für die Oberfläche: Benutzer (ohne Hashes) mit Anzahl Sitzungen und alle angemeldeten Sitzungen.
  // modulNamen: { id: Name } für den Rechte-Text.
  ansicht(eigenesToken = null, modulNamen = {}) {
    const sitzungen = this.anmeldung.liste(eigenesToken);
    const benutzer = Object.entries(this.anmeldung.benutzer).sort(([a], [b]) => a.localeCompare(b, 'de'))
      .map(([name, e]) => ({ name, admin: e.admin === true, zweiFaktor: Boolean(e.zwei_faktor), sitzungen: sitzungen.filter((s) => s.benutzer === name).length,
        art: e.microsoft ? 'microsoft' : 'lokal', ...(e.microsoft ? { microsoft: { adresse: e.microsoft.adresse, verknuepft: Boolean(e.microsoft.oid) } } : {}),
        rechte: e.rechte ? { grund: e.rechte.grund, module: { ...(e.rechte.module ?? {}) } } : null, rechteText: rechteText(e, modulNamen) }));
    return { benutzer, sitzungen };
  }

  // Änderungen nacheinander: config.json lesen, ändern, Sicherung, atomar schreiben, im Speicher übernehmen.
  // Grundlage ist immer die Datei (dort kann auch „--benutzer-anlegen“ etwas geändert haben).
  aendern(arbeit) {
    const lauf = this.kette.then(async () => {
      const roh = JSON.parse((await readFile(this.configDatei, 'utf8')).replace(/^\uFEFF/, ''));
      const offen = (w) => (this.tresor ? this.tresor.oeffnen(w) : w);
      const benutzer = { ...(await zweiFaktorUmwandeln(roh.benutzer ?? {}, offen)) };
      const ergebnis = arbeit(benutzer);
      roh.benutzer = this.tresor?.verfuegbar ? await zweiFaktorUmwandeln(benutzer, (w) => this.tresor.schuetzen(w, 'basis')) : benutzer;
      await copyFile(this.configDatei, `${this.configDatei}.vor-benutzeraenderung.json`);
      const temp = `${this.configDatei}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(roh, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.configDatei);
      this.anmeldung.benutzer = benutzer;
      return ergebnis;
    });
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  // Andere Einstellungen in config.json ändern (z. B. HTTPS & Domain), nacheinander mit den Benutzeränderungen.
  // arbeit(roh) ändert das Objekt und darf asynchron sein; vorher eine Sicherungskopie.
  konfigAendern(arbeit) {
    const lauf = this.kette.then(async () => {
      const roh = JSON.parse((await readFile(this.configDatei, 'utf8')).replace(/^\uFEFF/, ''));
      const ergebnis = await arbeit(roh);
      await copyFile(this.configDatei, `${this.configDatei}.vor-benutzeraenderung.json`);
      const temp = `${this.configDatei}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(roh, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.configDatei);
      return ergebnis;
    });
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  // Umstellung: Klartext-Geheimnisse in config.json verschlüsseln (Tokens, Zwei-Faktor-Schlüssel). Ohne Sicherungskopie,
  // denn die Kopie enthielte den Klartext. Liefert die Anzahl.
  konfigVerschluesseln() {
    const lauf = this.kette.then(async () => {
      const roh = JSON.parse((await readFile(this.configDatei, 'utf8')).replace(/^\uFEFF/, ''));
      const { roh: neu, anzahl } = await konfigSchuetzen(roh, this.tresor);
      if (!anzahl) return 0;
      const temp = `${this.configDatei}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(neu, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.configDatei);
      return anzahl;
    });
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  // art 'lokal' (Passwort) oder 'microsoft' (Anmeldung mit Microsoft, adresse = Microsoft-Adresse). Neue Benutzer
  // bekommen das Grundrecht „grund“ (Standard: kein Zugriff), Admins sehen ohnehin alles.
  // Microsoft-Benutzer erhalten einen zufälligen Platzhalter-Hash: Ältere Versionen der Basis lesen config.json dann
  // weiter, und eine Anmeldung mit Passwort ist nicht möglich (das Passwort kennt niemand).
  async anlegen({ name, passwort, admin, art = 'lokal', adresse, grund = 'kein' }, durch) {
    if (typeof name !== 'string' || !NAME.test(name) || name === '__proto__') throw new Benutzerfehler('Benutzername: nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich (1 bis 64 Zeichen).');
    if (!['lokal', 'microsoft'].includes(art)) throw new Benutzerfehler('Anmeldeart muss „lokal“ oder „microsoft“ sein.');
    if (!STUFEN.includes(grund)) throw new Benutzerfehler('Grundrecht muss „kein“, „sehen“ oder „bedienen“ sein.');
    const ms = art === 'microsoft';
    const mail = ms && typeof adresse === 'string' ? adresse.trim() : '';
    if (ms && (!MAIL.test(mail) || mail.length > 254)) throw new Benutzerfehler('Bitte die Microsoft-Adresse angeben, z. B. anna.schmidt@konsum-weimar.de.');
    const hash = ms ? await hashPasswort(randomBytes(32).toString('base64')) : await hashFuer(name, passwort);
    await this.aendern((benutzer) => {
      if (Object.hasOwn(benutzer, name)) throw new Benutzerfehler(`Den Benutzer „${name}“ gibt es schon.`);
      if (ms) {
        const doppelt = Object.keys(benutzer).find((n) => gleicheAdresse(benutzer[n].microsoft?.adresse, mail));
        if (doppelt) throw new Benutzerfehler(`Die Microsoft-Adresse ist schon dem Benutzer „${doppelt}“ zugeordnet.`);
      }
      benutzer[name] = { hash, ...(admin === true ? { admin: true } : {}), ...(ms ? { microsoft: { adresse: mail } } : {}), rechte: { grund, module: {} } };
    });
    this.log(`Benutzer ${name}${ms ? ` (Microsoft: ${mail})` : ''}${admin === true ? ' (Admin)' : ''} angelegt durch ${durch}, Grundrecht ${grund}.`);
  }

  // Rechte je Modul setzen (Admin). Gilt sofort, auch in laufenden Sitzungen.
  async rechteSetzen(name, eingabe, durch) {
    const { werte, fehler } = pruefeRechte(eingabe);
    if (fehler) throw new Benutzerfehler(fehler);
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      benutzer[name] = { ...benutzer[name], rechte: werte };
    });
    const abw = Object.entries(werte.module).map(([id, s]) => `${id}: ${s}`);
    this.log(`Rechte von ${name} geändert durch ${durch}: Grundrecht ${werte.grund}${abw.length ? `; ${abw.join(', ')}` : ''}.`);
  }

  // Nach der ersten Anmeldung mit Microsoft: die feste Konto-ID merken. Danach zählt nur noch sie.
  async microsoftVerknuepfen(name, oid, tid) {
    await this.aendern((benutzer) => {
      if (!benutzer[name]?.microsoft || benutzer[name].microsoft.oid) return;
      benutzer[name] = { ...benutzer[name], microsoft: { ...benutzer[name].microsoft, oid, tid } };
    });
    this.log(`Microsoft-Konto von ${name} verknüpft (Konto-ID ${oid}).`);
  }

  // Admin ändert die Microsoft-Adresse; die Verknüpfung wird gelöst (beim nächsten Anmelden neu über die Adresse).
  async microsoftAdresseSetzen(name, adresse, durch) {
    const mail = typeof adresse === 'string' ? adresse.trim() : '';
    if (!MAIL.test(mail) || mail.length > 254) throw new Benutzerfehler('Bitte eine gültige Microsoft-Adresse angeben.');
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      if (!benutzer[name].microsoft) throw new Benutzerfehler(`„${name}“ ist kein Microsoft-Benutzer.`);
      const doppelt = Object.keys(benutzer).find((n) => n !== name && gleicheAdresse(benutzer[n].microsoft?.adresse, mail));
      if (doppelt) throw new Benutzerfehler(`Die Microsoft-Adresse ist schon dem Benutzer „${doppelt}“ zugeordnet.`);
      benutzer[name] = { ...benutzer[name], microsoft: { adresse: mail } };
    });
    const beendet = this.anmeldung.sitzungenBeenden(name);
    this.log(`Microsoft-Adresse von ${name} auf ${mail} gesetzt durch ${durch}, Verknüpfung gelöst${beendet ? ` (${beendet} Sitzung(en) beendet)` : ''}.`);
  }

  // Passwort neu setzen (Admin). Alle Sitzungen dieses Benutzers enden – außer der eigenen, wenn es das eigene Konto ist.
  async passwortSetzen(name, passwort, durch, eigenesToken = null) {
    if (this.anmeldung.benutzer[name]?.microsoft) throw new Benutzerfehler(`„${name}“ meldet sich mit Microsoft an und hat kein Passwort der Basis.`);
    const hash = await hashFuer(name, passwort);
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      benutzer[name] = { ...benutzer[name], hash };
    });
    const beendet = this.anmeldung.sitzungenBeenden(name, name === durch ? eigenesToken : null);
    this.log(`Passwort von ${name} geändert durch ${durch}${beendet ? ` (${beendet} Sitzung(en) beendet)` : ''}.`);
  }

  // Eigenes Passwort ändern: bisheriges Passwort nötig (mit Sperre nach Fehlversuchen wie bei der Anmeldung).
  async eigenesPasswort(name, alt, neu, eigenesToken, adresse) {
    if (this.anmeldung.benutzer[name]?.microsoft) throw new Benutzerfehler('Du meldest dich mit Microsoft an – das Passwort änderst du bei Microsoft.');
    const ok = await this.anmeldung.pruefen(name, typeof alt === 'string' ? alt : '', adresse);
    if (ok === 'gesperrt') throw new Benutzerfehler('Zu viele Fehlversuche. Bitte 15 Minuten warten.');
    if (ok === 'ueberlastet') throw new Benutzerfehler('Gerade laufen zu viele Anmeldeversuche. Bitte gleich noch einmal versuchen.');
    if (!ok) throw new Benutzerfehler('Das bisherige Passwort stimmt nicht.');
    if (neu === alt) throw new Benutzerfehler('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    await this.passwortSetzen(name, neu, name, eigenesToken);
  }

  // Nach erfolgreicher Anmeldung: veralteten Hash mit den aktuellen Einstellungen neu berechnen (gleiches Passwort).
  async hashErneuern(name, passwort) {
    try {
      const alt = this.anmeldung.benutzer[name]?.hash;
      const hash = await hashPasswort(passwort);
      const geaendert = await this.aendern((benutzer) => {
        if (!Object.hasOwn(benutzer, name) || benutzer[name].hash !== alt) return false;
        benutzer[name] = { ...benutzer[name], hash };
        return true;
      });
      if (geaendert) this.log(`Passwort-Hash von ${name} auf die aktuelle Stärke umgestellt.`);
    } catch (fehler) {
      this.log(`Passwort-Hash von ${name} konnte nicht erneuert werden: ${fehler.message}`);
    }
  }

  // Zwei-Faktor-Anmeldung eingerichtet (beim ersten Anmelden mit Code aus der App bestätigt).
  async zweiFaktorSpeichern(name, geheimnis, codes) {
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      benutzer[name] = { ...benutzer[name], zwei_faktor: { geheimnis, codes, seit: new Date().toISOString() } };
    });
    this.log(`Zwei-Faktor-Anmeldung für ${name} eingerichtet.`);
  }

  // Ein Wiederherstellungscode gilt nur einmal.
  async codeVerbrauchen(name, hash) {
    const uebrig = await this.aendern((benutzer) => {
      const zf = benutzer[name]?.zwei_faktor;
      if (!zf) return 0;
      benutzer[name] = { ...benutzer[name], zwei_faktor: { ...zf, codes: zf.codes.filter((c) => c !== hash) } };
      return benutzer[name].zwei_faktor.codes.length;
    });
    this.log(`${name} hat sich mit einem Wiederherstellungscode angemeldet (noch ${uebrig} übrig).`);
  }

  // Admin setzt die Zwei-Faktor-Anmeldung eines anderen Benutzers zurück (z. B. Handy verloren). Dessen Sitzungen enden;
  // bei der nächsten Anmeldung richtet er sie neu ein (nur aus dem Firmennetz/VPN).
  async zweiFaktorZuruecksetzen(name, durch) {
    if (name === durch) throw new Benutzerfehler('Die eigene Zwei-Faktor-Anmeldung kann nur ein anderer Admin zurücksetzen (oder: --zwei-faktor-zuruecksetzen auf dem Server).');
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      const { zwei_faktor: _alt, ...rest } = benutzer[name];
      benutzer[name] = rest;
    });
    this.anmeldung.zweiFaktorVergessen(name);
    const beendet = this.anmeldung.sitzungenBeenden(name);
    this.log(`Zwei-Faktor-Anmeldung von ${name} zurückgesetzt durch ${durch}${beendet ? ` (${beendet} Sitzung(en) beendet)` : ''}.`);
  }

  async adminSetzen(name, admin, durch) {
    if (typeof admin !== 'boolean') throw new Benutzerfehler('admin muss true oder false sein.');
    if (!admin && name === durch) throw new Benutzerfehler('Das eigene Admin-Recht kann nur ein anderer Admin entziehen.');
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      if (!admin && benutzer[name].admin === true && admins(benutzer).length === 1) throw new Benutzerfehler(`„${name}“ ist der letzte Admin und bleibt Admin.`);
      const { admin: _alt, ...rest } = benutzer[name];
      benutzer[name] = admin ? { ...rest, admin: true } : rest;
    });
    this.anmeldung.adminUebernehmen(name, admin);
    this.log(`Admin-Recht von ${name} ${admin ? 'vergeben' : 'entzogen'} durch ${durch}.`);
  }

  async loeschen(name, durch) {
    if (name === durch) throw new Benutzerfehler('Das eigene Konto kann nur ein anderer Admin löschen.');
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      if (benutzer[name].admin === true && admins(benutzer).length === 1) throw new Benutzerfehler(`„${name}“ ist der letzte Admin und kann nicht gelöscht werden.`);
      delete benutzer[name];
    });
    const beendet = this.anmeldung.sitzungenBeenden(name);
    this.log(`Benutzer ${name} gelöscht durch ${durch}${beendet ? ` (${beendet} Sitzung(en) beendet)` : ''}.`);
  }
}
