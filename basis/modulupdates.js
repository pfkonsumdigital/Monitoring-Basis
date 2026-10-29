import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BasisFehler } from './fehler.js';
import { melde } from './protokoll.js';
import { pruefeModul } from './module.js';
import { schreibeAtomar } from './einstellungen.js';
import { BEFEHL_DATEI } from './modulverwaltung.js';
import { prozess, tarProgramm, vergleicheVersionen, zerlegeVersion } from './updates.js';

// Updates für Module, so wie für die Basis: Das Modul nennt in module.json sein GitHub-Repo ("repo").
// Ein Release mit Tag vX.Y.Z enthält <id>-X.Y.Z.tar.gz und <id>-X.Y.Z.tar.gz.sha256; im Paket liegt der
// Modulordner (module.json oben). Installiert wird nur auf Knopfdruck eines Admins: Modul beenden,
// alte Version nach data/modul-versionen/<id>/ sichern, neue einsetzen (einstellungen.json und status.json
// bleiben), Modul wieder starten. „Zurück“ tauscht mit der zuletzt gesicherten Version.

const MAX_PAKET = 300 * 1024 * 1024;
const BEHALTEN = 2;
const BLEIBT = ['einstellungen.json', 'status.json'];
const TAG = 86_400_000;
export const modulPaketName = (id, version) => `${id}-${version}.tar.gz`;

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

export class Modulupdates {
  constructor({ verwaltung, updates, datenOrdner, log = () => {}, spawnImpl = spawn, jetzt = () => Date.now(), warteMs = 1000, maxWartenMs = 60_000 }) {
    Object.assign(this, { verwaltung, updates, log, spawn: spawnImpl, jetzt, warteMs, maxWartenMs });
    this.ordner = path.join(datenOrdner, 'modul-versionen');
    this.zustaende = new Map();
    this.laufend = new Map();
  }

  zustandVon(id) {
    if (!this.zustaende.has(id)) this.zustaende.set(id, { phase: 'bereit', fehler: null, hinweis: null, verfuegbar: null, letztePruefung: null });
    return this.zustaende.get(id);
  }

  modul(id) {
    const m = this.verwaltung.finde(id);
    if (!m) throw new BasisFehler('Modul unbekannt.');
    if (m.fehler) throw new BasisFehler('Das Modul ist fehlerhaft konfiguriert.');
    if (!m.repo) throw new BasisFehler('Dieses Modul nennt in module.json kein GitHub-Repo („repo“) und kann deshalb nicht über die Basis aktualisiert werden.');
    if (!zerlegeVersion(m.version)) throw new BasisFehler('Dieses Modul hat in module.json keine Version der Form X.Y.Z.');
    return m;
  }

  zugang(m) {
    const token = this.updates?.updates?.githubToken;
    if (!token) throw new BasisFehler('Kein GitHub-Token eingetragen: Bitte im Dialog „Updates“ einen Token speichern (mit „Contents: Read-only“ auch für das Modul-Repo).');
    return { repo: m.repo, githubToken: token };
  }

  async sicherungen(id) {
    let eintraege;
    try { eintraege = await readdir(path.join(this.ordner, id), { withFileTypes: true }); } catch { return []; }
    const liste = [];
    for (const e of eintraege) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const ordner = path.join(this.ordner, id, e.name);
      const roh = await readFile(path.join(ordner, 'module.json'), 'utf8').then(JSON.parse, () => null);
      if (zerlegeVersion(roh?.version)) liste.push({ ordner, name: e.name, version: roh.version, zeit: (await stat(ordner)).mtimeMs });
    }
    return liste.sort((a, b) => b.zeit - a.zeit);
  }

  async status(id) {
    const m = this.verwaltung.finde(id);
    const z = this.zustandVon(id);
    const vorherige = m && !m.fehler ? (await this.sicherungen(id))[0] ?? null : null;
    return {
      id, repo: m?.repo ?? null, installiert: m?.version ?? null, phase: z.phase, fehler: z.fehler, hinweis: z.hinweis,
      verfuegbar: z.verfuegbar, letztePruefung: z.letztePruefung, vorherige: vorherige?.version ?? null,
      tokenGesetzt: Boolean(this.updates?.updates?.githubToken),
      updateMoeglich: this.verfuegbar(id),
    };
  }

  // Für die Übersicht: gibt es eine neuere Version als die installierte?
  verfuegbar(id) {
    const m = this.verwaltung.finde(id);
    const v = this.zustaende.get(id)?.verfuegbar;
    if (!m?.version || !v?.version || !zerlegeVersion(m.version)) return false;
    return vergleicheVersionen(v.version, m.version) > 0;
  }

  // Führt einen Vorgang je Modul exklusiv aus; Fehler landen im Zustand und im Protokoll.
  async exklusiv(id, phase, arbeit) {
    const z = this.zustandVon(id);
    if (!['bereit', 'fehler'].includes(z.phase)) throw new BasisFehler('Für dieses Modul läuft bereits ein Update-Vorgang.');
    Object.assign(z, { phase, fehler: null, hinweis: null });
    try {
      const ergebnis = await arbeit(z);
      z.phase = 'bereit';
      return ergebnis;
    } catch (fehler) {
      z.phase = 'fehler';
      z.fehler = fehler instanceof BasisFehler ? fehler.message : `Unerwarteter Fehler: ${fehler?.message || fehler}`;
      melde(this.log, 'fehler', `Modul ${id}`, `Update: ${z.fehler}`, fehler instanceof BasisFehler ? undefined : fehler);
      throw fehler instanceof BasisFehler ? fehler : new BasisFehler(z.fehler);
    }
  }

  async suchen(id) {
    const m = this.modul(id);
    const zugang = this.zugang(m);
    await this.exklusiv(id, 'suche', async (z) => {
      const release = await (await this.updates.github('/releases/latest', { zugang })).json();
      const version = zerlegeVersion(release.tag_name) ? release.tag_name.replace(/^v/, '') : null;
      if (!version) throw new BasisFehler(`Das neueste Release hat keinen gültigen Versions-Tag (${release.tag_name}).`);
      const paket = release.assets?.find((a) => a.name === modulPaketName(id, version));
      const pruefsumme = release.assets?.find((a) => a.name === `${modulPaketName(id, version)}.sha256`);
      z.letztePruefung = new Date(this.jetzt()).toISOString();
      z.verfuegbar = {
        version, notizen: String(release.body ?? '').slice(0, 20_000), veroeffentlicht: release.published_at ?? null,
        paket: paket ? { url: paket.url, groesse: paket.size } : null, pruefsumme: pruefsumme ? { url: pruefsumme.url } : null,
      };
      if (vergleicheVersionen(version, m.version) > 0) this.log(`Modul ${id}: Update verfügbar: ${version} (installiert: ${m.version}).`);
    });
    return this.status(id);
  }

  // Startet die Installation im Hintergrund; der Fortschritt steht im Status (phase).
  async installieren(id, version, benutzer) {
    const m = this.modul(id);
    const zugang = this.zugang(m);
    const ziel = this.zustandVon(id).verfuegbar;
    if (!ziel || ziel.version !== version) throw new BasisFehler('Bitte zuerst nach Updates suchen.');
    if (vergleicheVersionen(version, m.version) <= 0) throw new BasisFehler(`Version ${version} ist nicht neuer als die installierte Version ${m.version}.`);
    if (!ziel.paket || !ziel.pruefsumme) throw new BasisFehler(`Das Release enthält kein vollständiges Paket (${modulPaketName(id, version)} mit .sha256).`);
    if (ziel.paket.groesse > MAX_PAKET) throw new BasisFehler('Das Paket ist unerwartet groß; Installation abgebrochen.');
    const z = this.zustandVon(id);
    if (!['bereit', 'fehler'].includes(z.phase)) throw new BasisFehler('Für dieses Modul läuft bereits ein Update-Vorgang.');
    this.log(`Modul ${id}: Update auf ${version} gestartet durch ${benutzer}.`);
    const lauf = this.exklusiv(id, 'herunterladen', async (zustand) => {
      const neu = await this.herunterladen(m, ziel, zugang, zustand);
      try {
        await this.austauschen(m, neu, benutzer, zustand, `Update auf ${version}`);
      } finally {
        await rm(neu, { recursive: true, force: true }).catch(() => {});
      }
      this.log(`Modul ${id}: Version ${version} installiert (vorher ${m.version}).`);
    }).catch(() => {});
    this.laufend.set(id, lauf);
    return this.status(id);
  }

  async zurueck(id, benutzer) {
    const m = this.verwaltung.finde(id);
    if (!m || m.fehler) throw new BasisFehler('Modul unbekannt oder fehlerhaft.');
    const [vorherige] = await this.sicherungen(id);
    if (!vorherige) throw new BasisFehler('Es gibt keine gesicherte vorherige Version.');
    const z = this.zustandVon(id);
    if (!['bereit', 'fehler'].includes(z.phase)) throw new BasisFehler('Für dieses Modul läuft bereits ein Update-Vorgang.');
    this.log(`Modul ${id}: Zurück auf Version ${vorherige.version} durch ${benutzer}.`);
    const lauf = this.exklusiv(id, 'beenden', (zustand) => this.austauschen(m, vorherige.ordner, benutzer, zustand, `Zurück auf ${vorherige.version}`))
      .then(() => this.log(`Modul ${id}: Version ${vorherige.version} wiederhergestellt.`)).catch(() => {});
    this.laufend.set(id, lauf);
    return this.status(id);
  }

  // Lädt das Paket, prüft die Prüfsumme, entpackt es und prüft den Inhalt. Liefert den entpackten Ordner.
  async herunterladen(m, ziel, zugang, z) {
    await mkdir(path.join(this.ordner, m.id), { recursive: true });
    const daten = Buffer.from(await (await this.updates.github(ziel.paket.url, { binaer: true, zugang })).arrayBuffer());
    if (daten.length > MAX_PAKET) throw new BasisFehler('Das Paket ist unerwartet groß; Installation abgebrochen.');
    z.phase = 'pruefen';
    const erwartet = (await (await this.updates.github(ziel.pruefsumme.url, { binaer: true, zugang })).text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(erwartet) || erwartet !== createHash('sha256').update(daten).digest('hex')) {
      throw new BasisFehler('Die Prüfsumme des heruntergeladenen Pakets stimmt nicht. Nichts wurde geändert.');
    }
    z.phase = 'entpacken';
    const neu = path.join(this.ordner, m.id, `.neu-${randomUUID()}`);
    const paketDatei = `${neu}.tar.gz`;
    try {
      await mkdir(neu);
      await writeFile(paketDatei, daten);
      const entpackt = await prozess(this.spawn, tarProgramm(), ['-xzf', paketDatei, '-C', neu], 180_000);
      if (entpackt.code !== 0) throw new BasisFehler(`Das Paket konnte nicht entpackt werden: ${entpackt.ausgabe}`);
      await this.inhaltPruefen(neu, m, ziel.version);
      // Daten des Moduls kommen nie aus dem Paket.
      for (const datei of [...BLEIBT, BEFEHL_DATEI]) await rm(path.join(neu, datei), { force: true });
      return neu;
    } catch (fehler) {
      await rm(neu, { recursive: true, force: true }).catch(() => {});
      throw fehler;
    } finally {
      await rm(paketDatei, { force: true }).catch(() => {});
    }
  }

  // Keine Verknüpfungen im Paket, gültige module.json mit derselben id und der erwarteten Version.
  async inhaltPruefen(ordner, m, version) {
    const pruefe = async (verzeichnis) => {
      for (const e of await readdir(verzeichnis)) {
        const voll = path.join(verzeichnis, e);
        const info = await lstat(voll);
        if (info.isSymbolicLink()) throw new BasisFehler(`Das Paket enthält eine Verknüpfung (${path.relative(ordner, voll)}); Installation abgebrochen.`);
        if (info.isDirectory()) await pruefe(voll);
      }
    };
    await pruefe(ordner);
    let roh;
    try { roh = JSON.parse((await readFile(path.join(ordner, 'module.json'), 'utf8')).replace(/^﻿/, '')); }
    catch { throw new BasisFehler('Das Paket enthält keine gültige module.json.'); }
    const { fehler } = pruefeModul(roh, m.id, m.ordner);
    if (fehler) throw new BasisFehler(`Die module.json im Paket ist ungültig: ${fehler}`);
    if (roh.version !== version) throw new BasisFehler(`Das Paket enthält Version ${roh.version ?? '–'} statt ${version}.`);
  }

  // Beendet das Modul, tauscht den Modulordner gegen „neu“ und startet es wieder.
  async austauschen(m, neu, benutzer, z, grund) {
    z.phase = 'beenden';
    const weiter = await this.anhalten(m, grund);
    z.phase = 'austauschen';
    const sicherung = path.join(this.ordner, m.id, `${m.version ?? 'ohne-version'}-${new Date(this.jetzt()).toISOString().replace(/[:.]/g, '-')}`);
    try {
      await this.verwaltung.gesperrt(() => this.ordnerTauschen(m, neu, sicherung));
    } catch (fehler) {
      // Austausch gescheitert: die bisherige Version läuft weiter.
      await weiter().catch(() => {});
      throw fehler;
    }
    z.phase = 'starten';
    const hinweis = await weiter();
    if (hinweis) z.hinweis = hinweis;
    await this.aufraeumen(m.id);
  }

  async ordnerTauschen(m, neu, sicherung) {
    try { await rename(m.ordner, sicherung); }
    catch (fehler) {
      throw new BasisFehler(`Der Modulordner konnte nicht gesichert werden (${fehler.code ?? fehler.message}). Läuft das Modul noch oder ist eine Datei geöffnet?`);
    }
    try { await rename(neu, m.ordner); }
    catch (fehler) {
      await rename(sicherung, m.ordner).catch(() => {});
      throw new BasisFehler(`Die neue Version konnte nicht eingesetzt werden (${fehler.code ?? fehler.message}). Die bisherige Version wurde wiederhergestellt.`);
    }
    for (const datei of BLEIBT) await copyFile(path.join(sicherung, datei), path.join(m.ordner, datei)).catch(() => {});
    await this.verwaltung.einlesen();
  }

  // Hält das Modul an und liefert eine Funktion, die es danach wieder startet (Rückgabe: Hinweis oder null).
  async anhalten(m, grund) {
    const v = this.verwaltung;
    if (m.typ !== 'eigenstaendig') {
      const vorher = v.zustand[m.id]?.aktiv ?? null;
      await v.zustandAendern(m.id, { aktiv: false });
      v.planer?.setzeModule(v.planbar());
      v.abbrechen(m.id);
      await this.warten(() => !v.planer?.laeuft(m.id), 'Die laufende Prüfung des Moduls endet nicht.');
      return async () => {
        await v.zustandAendern(m.id, { aktiv: vorher });
        v.planer?.setzeModule(v.planbar());
        return null;
      };
    }
    if (!m.dienst && !m.befehlsdatei) throw new BasisFehler('Das Modul kann nicht automatisch beendet werden: In module.json fehlt „dienst“ oder „befehlsdatei“. Modul auf dem Worker beenden und Ordner von Hand austauschen.');
    // „Beendet“ verhindert Alarme (Keine Meldung, Dienst gestoppt), solange das Modul für das Update steht.
    await v.zustandAendern(m.id, { beendet: { zeit: new Date(this.jetzt()).toISOString(), von: grund } });
    if (m.dienst) {
      try {
        await v.dienste.beenden(m.dienst);
        await this.warten(async () => ['gestoppt', 'fehlt'].includes((await v.dienste.zustand(m.dienst)).zustand), `Der Windows-Dienst ${m.dienst} hält nicht an.`);
      } catch (fehler) {
        await v.zustandAendern(m.id, { beendet: null });
        throw fehler instanceof BasisFehler ? fehler : new BasisFehler(`Der Windows-Dienst ${m.dienst} konnte nicht beendet werden: ${fehler.message}`);
      }
      return async () => {
        try { await v.dienste.starten(m.dienst); }
        catch (fehler) { throw new BasisFehler(`${grund}: Die Dateien sind ausgetauscht, aber der Dienst ${m.dienst} startet nicht: ${fehler.message}`); }
        finally { await v.zustandAendern(m.id, { beendet: null }); await v.dienstePruefen(); }
        return null;
      };
    }
    const befehl = path.join(m.ordner, BEFEHL_DATEI);
    await schreibeAtomar(befehl, { befehl: 'beenden', zeit: new Date(this.jetzt()).toISOString(), von: grund });
    // Ein laufendes Modul löscht befehl.json und beendet sich. Läuft es nicht, bleibt die Datei liegen.
    await this.warten(async () => !(await stat(befehl).then(() => true, () => false)), null);
    return async () => `${grund}: erledigt. Das Modul läuft nicht als Dienst – bitte auf dem Worker wieder starten. Bis es sich meldet, steht es auf „Beendet“.`;
  }

  async warten(bedingung, fehlertext) {
    const bis = this.jetzt() + this.maxWartenMs;
    for (;;) {
      if (await bedingung()) return true;
      if (this.jetzt() >= bis) {
        if (fehlertext) throw new BasisFehler(fehlertext);
        return false;
      }
      await warte(this.warteMs);
    }
  }

  async aufraeumen(id) {
    const alle = await this.sicherungen(id);
    for (const alt of alle.slice(BEHALTEN)) await rm(alt.ordner, { recursive: true, force: true }).catch(() => {});
    let eintraege = [];
    try { eintraege = await readdir(path.join(this.ordner, id)); } catch { /* nichts da */ }
    for (const e of eintraege) if (e.startsWith('.neu-') && !this.zustaende.get(id)?.phase?.match(/herunterladen|pruefen|entpacken/)) await rm(path.join(this.ordner, id, e), { recursive: true, force: true }).catch(() => {});
  }

  // Einmal täglich für alle Module mit Repo nach Updates suchen (installiert wird nie automatisch).
  taeglichPruefen() {
    const pruefen = async () => {
      if (!this.updates?.updates?.githubToken) return;
      for (const m of this.verwaltung.module) {
        if (!m.fehler && m.repo && zerlegeVersion(m.version)) await this.suchen(m.id).catch(() => {});
      }
    };
    setTimeout(pruefen, 120_000).unref?.();
    setInterval(pruefen, TAG).unref?.();
  }
}
