import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BasisFehler } from './fehler.js';
import { melde } from './protokoll.js';

const MAX_PAKET = 200 * 1024 * 1024;
const BEHALTEN = 3;
export const NEUSTART_CODE = 3;
const STANDARD_REPO = 'pfkonsumdigital/Monitoring-Basis';
const TAG = 86_400_000;
const WARNEN_TAGE = 14;

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

// GitHub meldet das Ablaufdatum eines Tokens im Kopf github-authentication-token-expiration,
// z. B. "2026-12-31 00:00:00 UTC" oder "2026-12-31 00:00:00 +0100". Ohne Ablaufdatum: null.
export function ablaufLesen(kopf) {
  const t = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(String(kopf ?? '').trim());
  if (!t) return null;
  const zone = !t[3] || t[3] === 'UTC' || t[3] === 'Z' ? 'Z' : t[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${t[1]}T${t[2]}${zone}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export const paketName = (version) => `monitoring-basis-${version}.tar.gz`;

async function jsonLesen(datei) {
  try { return JSON.parse(await readFile(datei, 'utf8')); }
  catch (fehler) { if (fehler.code === 'ENOENT') return null; throw fehler; }
}
async function atomarSchreiben(datei, wert) {
  const temp = `${datei}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(datei), { recursive: true });
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

// 403/429 von GitHub: Abruflimit (mit Uhrzeit, ab wann es wieder geht) oder fehlendes Recht des Tokens.
export async function zugriffVerweigert(antwort, jetzt = Date.now()) {
  const kopf = (name) => antwort.headers.get(name);
  const warten = Number(kopf('retry-after'));
  if (Number.isFinite(warten) && warten > 0) return `GitHub meldet zu viele Anfragen. In ${Math.ceil(warten)} Sekunden erneut versuchen.`;
  if (antwort.status === 429 || kopf('x-ratelimit-remaining') === '0') {
    const ab = Number(kopf('x-ratelimit-reset')) * 1000;
    const uhrzeit = ab > jetzt ? new Date(ab).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : null;
    return `GitHub-Abruflimit erreicht. ${uhrzeit ? `Wieder möglich ab ${uhrzeit} Uhr.` : 'Später erneut versuchen.'}`;
  }
  const meldung = String((await antwort.json().catch(() => ({})))?.message ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return `GitHub verweigert den Zugriff${meldung ? ` („${meldung}“)` : ''}. Dem Token fehlt ein Recht: In GitHub beim Token unter „Repository permissions“ „Contents: Read-only“ ergänzen – der Token bleibt dabei gleich.`;
}

export class Updateverwaltung {
  constructor({ installOrdner, programmOrdner, configDatei, updates, installiert, viaStarter, neustart, datenOrdner = null, geheimnisse = [], log = () => {}, fetchImpl = fetch, spawnImpl = spawn, jetzt = () => Date.now() }) {
    this.installOrdner = installOrdner;
    this.programmOrdner = programmOrdner;
    this.configDatei = configDatei;
    // Token aus config.json (updates.github_token); ein in der Oberfläche gespeicherter Token hat Vorrang.
    this.konfigUpdates = updates;
    this.updates = updates;
    this.tokenDatei = datenOrdner ? path.join(datenOrdner, 'github.json') : null;
    this.oberflaechenToken = null;
    this.tokenInfo = { ablauf: null, geprueft: null, ok: null, fehler: null };
    this.geheimnisse = geheimnisse;
    this.jetzt = jetzt;
    this.installiert = installiert;
    this.viaStarter = viaStarter;
    this.neustart = neustart;
    this.log = log;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.versionenOrdner = path.join(installOrdner, 'versionen');
    this.zustand = { phase: 'bereit', fehler: null, verfuegbar: null, letztePruefung: null, vorherige: null };
  }

  // Wirksamer Zugang: Token aus der Oberfläche vor Token aus config.json.
  zugangSetzen() {
    const repo = this.konfigUpdates?.repo ?? STANDARD_REPO;
    if (this.oberflaechenToken) this.updates = { repo, githubToken: this.oberflaechenToken };
    else this.updates = this.konfigUpdates ?? null;
    if (this.updates?.githubToken && !this.geheimnisse.includes(this.updates.githubToken)) this.geheimnisse.push(this.updates.githubToken);
  }

  tokenStatus() {
    const ablauf = this.tokenInfo.ablauf;
    const restTage = ablauf ? Math.floor((Date.parse(ablauf) - this.jetzt()) / TAG) : null;
    return {
      gesetzt: Boolean(this.updates?.githubToken),
      quelle: this.oberflaechenToken ? 'oberflaeche' : this.konfigUpdates?.githubToken ? 'config' : null,
      repo: this.updates?.repo ?? this.konfigUpdates?.repo ?? STANDARD_REPO,
      ...this.tokenInfo,
      restTage,
      laeuftBaldAb: restTage !== null && restTage < WARNEN_TAGE,
    };
  }

  status() {
    return {
      eingerichtet: Boolean(this.updates), viaStarter: this.viaStarter, installiert: this.installiert,
      token: this.tokenStatus(),
      ...this.zustand,
      updateMoeglich: Boolean(this.zustand.verfuegbar && vergleicheVersionen(this.zustand.verfuegbar.version, this.installiert) > 0),
    };
  }

  async github(weg, { binaer = false, zugang = this.updates } = {}) {
    let antwort;
    try {
      antwort = await this.fetch(weg.startsWith('https://') ? weg : `https://api.github.com/repos/${zugang.repo}${weg}`, {
        headers: {
          Authorization: `Bearer ${zugang.githubToken}`,
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
    if (antwort.status === 401) throw new BasisFehler('GitHub hat den Token abgelehnt (abgelaufen oder falsch). Neuen Token im Dialog „Updates“ eintragen.');
    if (antwort.status === 403 || antwort.status === 429) throw new BasisFehler(await zugriffVerweigert(antwort, this.jetzt()));
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
    if (!this.updates) throw new BasisFehler('Updates sind nicht eingerichtet: Bitte im Dialog „Updates“ einen GitHub-Token eintragen.');
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

  // Gespeicherten Token aus der Oberfläche laden (data/github.json).
  async tokenLaden() {
    if (this.tokenDatei) {
      const wert = await jsonLesen(this.tokenDatei).catch(() => null);
      this.oberflaechenToken = typeof wert?.github_token === 'string' && wert.github_token ? wert.github_token : null;
    }
    this.zugangSetzen();
  }

  // Prüft, ob der Token das Repo lesen darf, und merkt sich das Ablaufdatum (falls GitHub es meldet).
  // Das Repo sehen reicht nicht: Für Releases braucht der Token „Contents: Read-only“ – das wird mitgeprüft.
  async tokenPruefen(zugang = this.updates) {
    if (!zugang?.githubToken) throw new BasisFehler('Kein GitHub-Token eingetragen.');
    const antwort = await this.github('', { zugang });
    await this.github('/releases?per_page=1', { zugang });
    return { ablauf: ablaufLesen(antwort.headers.get('github-authentication-token-expiration')) };
  }

  async tokenTesten() {
    const info = { geprueft: new Date(this.jetzt()).toISOString() };
    try {
      Object.assign(this.tokenInfo, info, await this.tokenPruefen(), { ok: true, fehler: null });
    } catch (fehler) {
      Object.assign(this.tokenInfo, info, { ok: false, fehler: fehler.message });
    }
    this.ablaufWarnen();
    return this.status();
  }

  // Speichert einen neuen Token aus der Oberfläche – nur, wenn GitHub ihn annimmt.
  async tokenSpeichern(token, benutzer) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token.trim())) throw new BasisFehler('Das sieht nicht wie ein GitHub-Token aus (z. B. github_pat_…).');
    if (!this.tokenDatei) throw new BasisFehler('Speichern nicht möglich.');
    const zugang = { repo: this.konfigUpdates?.repo ?? STANDARD_REPO, githubToken: token.trim() };
    if (!this.geheimnisse.includes(zugang.githubToken)) this.geheimnisse.push(zugang.githubToken);
    const { ablauf } = await this.tokenPruefen(zugang);
    await atomarSchreiben(this.tokenDatei, { github_token: zugang.githubToken });
    this.oberflaechenToken = zugang.githubToken;
    this.zugangSetzen();
    this.tokenInfo = { ablauf, geprueft: new Date(this.jetzt()).toISOString(), ok: true, fehler: null };
    this.log(`GitHub-Token für Updates gespeichert durch ${benutzer}${ablauf ? ` (gültig bis ${ablauf.slice(0, 10)})` : ''}.`);
    this.ablaufWarnen();
    return this.status();
  }

  async tokenEntfernen(benutzer) {
    if (this.tokenDatei) await rm(this.tokenDatei, { force: true });
    this.oberflaechenToken = null;
    this.zugangSetzen();
    this.tokenInfo = { ablauf: null, geprueft: null, ok: null, fehler: null };
    this.log(`GitHub-Token der Oberfläche entfernt durch ${benutzer}.`);
    return this.status();
  }

  ablaufWarnen() {
    const t = this.tokenStatus();
    if (!t.laeuftBaldAb) return;
    melde(this.log, 'warnung', 'Update', t.restTage < 0 ? `Der GitHub-Token ist abgelaufen (${t.ablauf.slice(0, 10)}). Neuen Token im Dialog „Updates“ eintragen.`
      : `Der GitHub-Token läuft in ${t.restTage} ${t.restTage === 1 ? 'Tag' : 'Tagen'} ab (${t.ablauf.slice(0, 10)}). Rechtzeitig einen neuen Token im Dialog „Updates“ eintragen.`);
  }

  // Sucht einmal täglich nach Updates (und prüft den Token), installiert aber nie selbst.
  taeglichPruefen() {
    const pruefen = async () => {
      if (!this.updates) return;
      await this.tokenTesten().catch(() => {});
      await this.suchen().catch(() => {});
    };
    setTimeout(pruefen, 60_000).unref();
    const timer = setInterval(pruefen, 24 * 3_600_000);
    timer.unref();
    return timer;
  }

  async starten() {
    await this.tokenLaden();
    this.zustand.vorherige = await this.vorherigeErmitteln().catch(() => null);
    await this.aufraeumen();
  }
}

export async function versionLesen(programmOrdner) {
  const paketJson = await jsonLesen(path.join(programmOrdner, 'package.json'));
  if (!paketJson?.version) throw new BasisFehler('package.json ohne Version.');
  return paketJson.version;
}
