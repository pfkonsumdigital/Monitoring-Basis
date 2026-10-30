import { randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { hashPasswort } from './anmeldung.js';

// Benutzer in der Oberfläche verwalten: anlegen, Passwort setzen, Admin-Recht ändern, löschen, eigenes Passwort ändern.
// Gespeichert wird wie bei „--benutzer-anlegen“ in config.json (nur scrypt-Hashes), vorher eine Sicherungskopie
// config.json.vor-benutzeraenderung.json. Änderungen gelten sofort, ohne Neustart.

export class Benutzerfehler extends Error {}
export class BenutzerUnbekannt extends Benutzerfehler {}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PASSWORT = 200;

async function hashFuer(passwort) {
  if (typeof passwort !== 'string' || passwort.length < 10) throw new Benutzerfehler('Das Passwort muss mindestens 10 Zeichen lang sein.');
  if (passwort.length > MAX_PASSWORT) throw new Benutzerfehler(`Das Passwort darf höchstens ${MAX_PASSWORT} Zeichen lang sein.`);
  return hashPasswort(passwort);
}

const admins = (benutzer) => Object.keys(benutzer).filter((n) => benutzer[n].admin === true);

export class Benutzerverwaltung {
  constructor({ configDatei, anmeldung, log = () => {} }) {
    this.configDatei = configDatei;
    this.anmeldung = anmeldung;
    this.log = log;
    this.kette = Promise.resolve();
  }

  // Für die Oberfläche: Benutzer (ohne Hashes) mit Anzahl Sitzungen und alle angemeldeten Sitzungen.
  ansicht(eigenesToken = null) {
    const sitzungen = this.anmeldung.liste(eigenesToken);
    const benutzer = Object.entries(this.anmeldung.benutzer).sort(([a], [b]) => a.localeCompare(b, 'de'))
      .map(([name, e]) => ({ name, admin: e.admin === true, sitzungen: sitzungen.filter((s) => s.benutzer === name).length }));
    return { benutzer, sitzungen };
  }

  // Änderungen nacheinander: config.json lesen, ändern, Sicherung, atomar schreiben, im Speicher übernehmen.
  // Grundlage ist immer die Datei (dort kann auch „--benutzer-anlegen“ etwas geändert haben).
  aendern(arbeit) {
    const lauf = this.kette.then(async () => {
      const roh = JSON.parse((await readFile(this.configDatei, 'utf8')).replace(/^﻿/, ''));
      const benutzer = { ...(roh.benutzer ?? {}) };
      const ergebnis = arbeit(benutzer);
      roh.benutzer = benutzer;
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

  async anlegen({ name, passwort, admin }, durch) {
    if (typeof name !== 'string' || !NAME.test(name) || name === '__proto__') throw new Benutzerfehler('Benutzername: nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich (1 bis 64 Zeichen).');
    const hash = await hashFuer(passwort);
    await this.aendern((benutzer) => {
      if (Object.hasOwn(benutzer, name)) throw new Benutzerfehler(`Den Benutzer „${name}“ gibt es schon.`);
      benutzer[name] = { hash, ...(admin === true ? { admin: true } : {}) };
    });
    this.log(`Benutzer ${name}${admin === true ? ' (Admin)' : ''} angelegt durch ${durch}.`);
  }

  // Passwort neu setzen (Admin). Alle Sitzungen dieses Benutzers enden – außer der eigenen, wenn es das eigene Konto ist.
  async passwortSetzen(name, passwort, durch, eigenesToken = null) {
    const hash = await hashFuer(passwort);
    await this.aendern((benutzer) => {
      if (!Object.hasOwn(benutzer, name)) throw new BenutzerUnbekannt(`Den Benutzer „${name}“ gibt es nicht.`);
      benutzer[name] = { ...benutzer[name], hash };
    });
    const beendet = this.anmeldung.sitzungenBeenden(name, name === durch ? eigenesToken : null);
    this.log(`Passwort von ${name} geändert durch ${durch}${beendet ? ` (${beendet} Sitzung(en) beendet)` : ''}.`);
  }

  // Eigenes Passwort ändern: bisheriges Passwort nötig (mit Sperre nach Fehlversuchen wie bei der Anmeldung).
  async eigenesPasswort(name, alt, neu, eigenesToken, adresse) {
    const ok = await this.anmeldung.pruefen(name, typeof alt === 'string' ? alt : '', adresse);
    if (ok === 'gesperrt') throw new Benutzerfehler('Zu viele Fehlversuche. Bitte 15 Minuten warten.');
    if (!ok) throw new Benutzerfehler('Das bisherige Passwort stimmt nicht.');
    if (neu === alt) throw new Benutzerfehler('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    await this.passwortSetzen(name, neu, name, eigenesToken);
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
