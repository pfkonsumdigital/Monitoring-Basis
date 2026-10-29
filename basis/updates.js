import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BasisFehler } from './fehler.js';
import { melde } from './protokoll.js';

const MAX_PAKET = 200 * 1024 * 1024;
const BEHALTEN = 3;
export const NEUSTART_CODE = 3;

export function zerlegeVersion(text) {
  const treffer = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return treffer ? treffer.slice(1, 4).map(Number) : null;
}

// < 0: a ist älter, 0: gleich, > 0: a ist neuer.
export function vergleicheVersionen(a, b) {
  const x = zerlegeVersion(a), y = zerlegeVersion(b);
  if (!x || !y) throw new BasisFehler(`Ungültige Versionsangabe: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const paketName = (version) => `monitoring-basis-${version}.tar.gz`;

async function jsonLesen(datei) {
  try { return JSON.parse(await readFile(datei, 'utf8')); }
  catch (fehler) { if (fehler.code === 'ENOENT') return null; throw fehler; }
}
async function atomarSchreiben(datei, wert) {
  const temp = `${datei}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(wert, null, 2) + '\n');
  await rename(temp, datei);
}
const existiert = (p) => access(p).then(() => true, () => false);

function prozess(spawnImpl, befehl, argumente, timeoutMs) {
  return new Promise((resolve) => {
    let ausgabe = '';
    let kind;
    try { kind = spawnImpl(befehl, argumente, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (fehler) { resolve({ code: null, ausgabe: String(fehler.message) }); return; }
    const timer = setTimeout(() => kind.kill('SIGKILL'), timeoutMs);
    kind.stdout.on('data', (t) => { ausgabe += t; });
    kind.stderr.on('data', (t) => { ausgabe += t; });
    kind.once('error', (fehler) => { clearTimeout(timer); resolve({ code: null, ausgabe: String(fehler.message) }); });
    kind.once('close', (code) => { clearTimeout(timer); resolve({ code, ausgabe: ausgabe.trim().slice(-500) }); });
  });
}

// Liest aktiv.json im Installationsordner. "." bedeutet: die ursprünglich entpackte Version.
export async function leseAktiv(installOrdner) {
  const wert = await jsonLesen(path.join(installOrdner, 'aktiv.json'));
  return { aktiv: wert?.aktiv ?? '.', vorher: wert?.vorher ?? null, probe: wert?.probe === true };
}
export const schreibeAktiv = (installOrdner, wert) => atomarSchreiben(path.join(installOrdner, 'aktiv.json'), wert);

export class Updateverwaltung {
  constructor({ installOrdner, programmOrdner, configDatei, updates, installiert, viaStarter, neustart, log = () => {}, fetchImpl = fetch, spawnImpl = spawn }) {
    this.installOrdner = installOrdner;
    this.programmOrdner = programmOrdner;
    this.configDatei = configDatei;
    this.updates = updates;
    this.installiert = installiert;
    this.viaStarter = viaStarter;
    this.neustart = neustart;
    this.log = log;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.versionenOrdner = path.join(installOrdner, 'versionen');
    this.zustand = { phase: 'bereit', fehler: null, verfuegbar: null, letztePruefung: null, vorherige: null };
  }

  status() {
    return {
      eingerichtet: Boolean(this.updates), viaStarter: this.viaStarter, installiert: this.installiert,
      ...this.zustand,
      updateMoeglich: Boolean(this.zustand.verfuegbar && vergleicheVersionen(this.zustand.verfuegbar.version, this.installiert) > 0),
    };
  }

  async github(weg, { binaer = false } = {}) {
    let antwort;
    try {
      antwort = await this.fetch(weg.startsWith('https://') ? weg : `https://api.github.com/repos/${this.updates.repo}${weg}`, {
        headers: {
          Authorization: `Bearer ${this.updates.githubToken}`,
          Accept: binaer ? 'application/octet-stream' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Monitoring-Basis',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(binaer ? 300_000 : 30_000),
      });
    } catch {
      throw new BasisFehler('GitHub ist nicht erreichbar. Internetzugang, Proxy und Firewall des Workers prüfen.');
    }
    if (antwort.status === 401) throw new BasisFehler('GitHub hat den Token abgelehnt. updates.github_token prüfen (abgelaufen oder falsch).');
    if (antwort.status === 403 || antwort.status === 429) throw new BasisFehler('GitHub verweigert den Zugriff (Rechte des Tokens oder Abruflimit). Später erneut versuchen.');
    if (antwort.status === 404) throw new BasisFehler('Kein Release gefunden – oder der Token hat keinen Lesezugriff auf das Repo.');
    if (!antwort.ok) throw new BasisFehler(`GitHub antwortet mit HTTP ${antwort.status}.`);
    return antwort;
  }

  async exklusiv(phase, arbeit) {
    if (!['bereit', 'fehler'].includes(this.zustand.phase)) throw new BasisFehler('Es läuft bereits ein Update-Vorgang.');
    this.zustand.phase = phase;
    this.zustand.fehler = null;
    try {
      const ergebnis = await arbeit();
      if (this.zustand.phase !== 'neustart') this.zustand.phase = 'bereit';
      return ergebnis;
    } catch (fehler) {
      this.zustand.phase = 'fehler';
      this.zustand.fehler = fehler instanceof BasisFehler ? fehler.message : `Unerwarteter Fehler: ${fehler?.message || fehler}`;
      melde(this.log, 'fehler', 'Update', this.zustand.fehler, fehler instanceof BasisFehler ? undefined : fehler);
      throw fehler instanceof BasisFehler ? fehler : new BasisFehler(this.zustand.fehler);
    }
  }

  async suchen() {
    if (!this.updates) throw new BasisFehler('Updates sind nicht eingerichtet (Abschnitt "updates" in config.json fehlt).');
    await this.exklusiv('suche', async () => {
      const release = await (await this.github('/releases/latest')).json();
      const version = zerlegeVersion(release.tag_name) ? release.tag_name.replace(/^v/, '') : null;
      if (!version) throw new BasisFehler(`Das neueste Release hat keinen gültigen Versions-Tag (${release.tag_name}).`);
      const paket = release.assets?.find((a) => a.name === paketName(version));
      const pruefsumme = release.assets?.find((a) => a.name === `${paketName(version)}.sha256`);
      this.zustand.letztePruefung = new Date().toISOString();
      this.zustand.verfuegbar = {
        version, notizen: String(release.body ?? '').slice(0, 20_000), veroeffentlicht: release.published_at ?? null,
        paket: paket ? { url: paket.url, groesse: paket.size } : null, pruefsumme: pruefsumme ? { url: pruefsumme.url } : null,
      };
      if (vergleicheVersionen(version, this.installiert) > 0) this.log(`Update verfügbar: ${version} (installiert: ${this.installiert}).`);
    });
    return this.status();
  }

  async installieren(version) {
    if (!this.updates) throw new BasisFehler('Updates sind nicht eingerichtet.');
    if (!this.viaStarter) throw new BasisFehler('Die Basis wurde nicht über start.js gestartet und kann sich deshalb nicht selbst neu starten.');
    const ziel = this.zustand.verfuegbar;
    if (!ziel || ziel.version !== version) throw new BasisFehler('Bitte zuerst nach Updates suchen.');
    if (vergleicheVersionen(version, this.installiert) <= 0) throw new BasisFehler(`Version ${version} ist nicht neuer als die installierte Version ${this.installiert}.`);
    if (!ziel.paket || !ziel.pruefsumme) throw new BasisFehler('Das Release enthält kein vollständiges Paket mit Prüfsumme.');
    if (ziel.paket.groesse > MAX_PAKET) throw new BasisFehler('Das Paket ist unerwartet groß; Installation abgebrochen.');

    return this.exklusiv('herunterladen', async () => {
      this.log(`Update auf ${version} gestartet.`);
      await mkdir(this.versionenOrdner, { recursive: true });
      const daten = Buffer.from(await (await this.github(ziel.paket.url, { binaer: true })).arrayBuffer());
      if (daten.length > MAX_PAKET) throw new BasisFehler('Das Paket ist unerwartet groß; Installation abgebrochen.');

      this.zustand.phase = 'pruefen';
      const erwartet = (await (await this.github(ziel.pruefsumme.url, { binaer: true })).text()).trim().split(/\s+/)[0].toLowerCase();
      const tatsaechlich = createHash('sha256').update(daten).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(erwartet) || erwartet !== tatsaechlich) throw new BasisFehler('Die Prüfsumme des heruntergeladenen Pakets stimmt nicht. Nichts wurde geändert.');

      this.zustand.phase = 'entpacken';
      const temp = path.join(this.versionenOrdner, `.neu-${randomUUID()}`);
      const paketDatei = `${temp}.tar.gz`;
      const zielOrdner = path.join(this.versionenOrdner, version);
      try {
        await mkdir(temp, { recursive: true });
        await writeFile(paketDatei, daten);
        const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
        const entpackt = await prozess(this.spawn, tar, ['-xzf', paketDatei, '-C', temp], 120_000);
        if (entpackt.code !== 0) throw new BasisFehler(`Das Paket konnte nicht entpackt werden: ${entpackt.ausgabe}`);
        const paketJson = await jsonLesen(path.join(temp, 'package.json'));
        if (paketJson?.version !== version || !(await existiert(path.join(temp, 'basis', 'main.js')))) {
          throw new BasisFehler('Das Paket ist unvollständig oder enthält eine andere Version.');
        }

        this.zustand.phase = 'selbsttest';
        const test = await prozess(this.spawn, process.execPath, [path.join(temp, 'basis', 'main.js'), '--config', this.configDatei, '--selbsttest'], 60_000);
        if (test.code !== 0) throw new BasisFehler(`Die neue Version hat den Selbsttest nicht bestanden: ${test.ausgabe || `Exitcode ${test.code}`}`);

        await rm(zielOrdner, { recursive: true, force: true });
        await rename(temp, zielOrdner);
      } finally {
        await rm(temp, { recursive: true, force: true }).catch(() => {});
        await rm(paketDatei, { force: true }).catch(() => {});
      }

      const aktuell = await leseAktiv(this.installOrdner);
      await schreibeAktiv(this.installOrdner, { aktiv: path.relative(this.installOrdner, zielOrdner).split(path.sep).join('/'), vorher: aktuell.aktiv, probe: true });
      this.zustand.phase = 'neustart';
      this.log(`Version ${version} installiert. Die Basis startet neu.`);
      setTimeout(() => this.neustart(), 500).unref?.();
      return this.status();
    });
  }

  async vorherigeErmitteln() {
    const { vorher } = await leseAktiv(this.installOrdner);
    if (!vorher) return null;
    const ordner = path.resolve(this.installOrdner, vorher);
    const paketJson = await jsonLesen(path.join(ordner, 'package.json')).catch(() => null);
    return paketJson?.version ? { ordner: vorher, version: paketJson.version } : null;
  }

  async zurueck() {
    if (!this.viaStarter) throw new BasisFehler('Die Basis wurde nicht über start.js gestartet und kann sich deshalb nicht selbst neu starten.');
    const vorherige = await this.vorherigeErmitteln();
    if (!vorherige) throw new BasisFehler('Es gibt keine vorherige Version.');
    return this.exklusiv('neustart', async () => {
      const { aktiv } = await leseAktiv(this.installOrdner);
      await schreibeAktiv(this.installOrdner, { aktiv: vorherige.ordner, vorher: aktiv, probe: false });
      this.log(`Zurück auf Version ${vorherige.version}. Die Basis startet neu.`);
      setTimeout(() => this.neustart(), 500).unref?.();
      return this.status();
    });
  }

  // Entfernt alte Versionsordner und Reste abgebrochener Updates. Aktive und vorherige bleiben immer.
  async aufraeumen() {
    let eintraege;
    try { eintraege = await readdir(this.versionenOrdner, { withFileTypes: true }); }
    catch { return; }
    const { aktiv, vorher } = await leseAktiv(this.installOrdner);
    const geschuetzt = new Set([aktiv, vorher].filter(Boolean).map((p) => path.resolve(this.installOrdner, p)));
    const versionen = [];
    for (const e of eintraege) {
      const voll = path.join(this.versionenOrdner, e.name);
      if (e.name.startsWith('.neu-')) { await rm(voll, { recursive: true, force: true }).catch(() => {}); continue; }
      if (e.isDirectory() && zerlegeVersion(e.name) && !geschuetzt.has(voll)) versionen.push(e.name);
    }
    versionen.sort((a, b) => vergleicheVersionen(b, a));
    for (const alt of versionen.slice(Math.max(0, BEHALTEN - geschuetzt.size))) {
      await rm(path.join(this.versionenOrdner, alt), { recursive: true, force: true }).catch(() => {});
      this.log(`Alte Version ${alt} entfernt.`);
    }
  }

  // Sucht einmal täglich nach Updates, installiert aber nie selbst.
  taeglichPruefen() {
    if (!this.updates) return null;
    const pruefen = () => this.suchen().catch(() => {});
    setTimeout(pruefen, 60_000).unref();
    const timer = setInterval(pruefen, 24 * 3_600_000);
    timer.unref();
    return timer;
  }

  async starten() {
    this.zustand.vorherige = await this.vorherigeErmitteln().catch(() => null);
    await this.aufraeumen();
  }
}

export async function versionLesen(programmOrdner) {
  const paketJson = await jsonLesen(path.join(programmOrdner, 'package.json'));
  if (!paketJson?.version) throw new BasisFehler('package.json ohne Version.');
  return paketJson.version;
}
