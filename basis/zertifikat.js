import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID, X509Certificate } from 'node:crypto';
import path from 'node:path';
import acme from 'acme-client';
import { BasisFehler } from './fehler.js';
import { melde } from './protokoll.js';

const ERNEUERN_VOR_MS = 30 * 24 * 3_600_000;
const PRUEFINTERVALL_MS = 12 * 3_600_000;

async function atomarSchreiben(datei, inhalt) {
  const temp = `${datei}.${randomUUID()}.tmp`;
  try { await writeFile(temp, inhalt, { mode: 0o600 }); await rename(temp, datei); }
  finally { await unlink(temp).catch(() => {}); }
}
const lesen = (datei) => readFile(datei, 'utf8').catch((f) => { if (f.code === 'ENOENT') return null; throw f; });

// Prüft, ob ein Zertifikat zum Hostnamen passt und noch mindestens 30 Tage gilt.
export function brauchtErneuerung(zertifikatPem, hostname, jetzt = Date.now()) {
  if (!zertifikatPem) return true;
  try {
    const zert = new X509Certificate(zertifikatPem);
    return Date.parse(zert.validTo) - jetzt < ERNEUERN_VOR_MS || !zert.checkHost(hostname);
  } catch {
    return true;
  }
}

function nochGueltig(zertifikatPem, hostname, jetzt = Date.now()) {
  try {
    const zert = new X509Certificate(zertifikatPem);
    return Date.parse(zert.validTo) > jetzt && Boolean(zert.checkHost(hostname));
  } catch {
    return false;
  }
}

// Minimaler Cloudflare-Client für TXT-Einträge der DNS-01-Prüfung.
export class CloudflareDns {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async anfrage(methode, weg, koerper) {
    let antwort, daten;
    try {
      antwort = await this.fetch(`https://api.cloudflare.com/client/v4${weg}`, {
        method: methode,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: koerper ? JSON.stringify(koerper) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      daten = await antwort.json().catch(() => null);
    } catch {
      throw new BasisFehler('Cloudflare-API nicht erreichbar. Internetzugang und Firewall des Workers prüfen.');
    }
    if (!antwort.ok || !daten?.success) {
      const meldung = daten?.errors?.[0]?.message ?? `HTTP ${antwort.status}`;
      throw new BasisFehler(`Cloudflare-API hat abgelehnt: ${meldung}. Token-Rechte („Zone: DNS: Bearbeiten“ für die Zone) prüfen.`);
    }
    return daten.result;
  }

  async zoneFinden(name) {
    const teile = name.split('.');
    for (let i = 0; i < teile.length - 1; i++) {
      const kandidat = teile.slice(i).join('.');
      const zonen = await this.anfrage('GET', `/zones?name=${encodeURIComponent(kandidat)}`);
      if (zonen.length) return zonen[0].id;
    }
    throw new BasisFehler(`Keine Cloudflare-Zone für ${name} gefunden. Die Domain muss in diesem Cloudflare-Konto verwaltet werden.`);
  }

  async txtAnlegen(name, inhalt) {
    const zone = await this.zoneFinden(name);
    const eintrag = await this.anfrage('POST', `/zones/${zone}/dns_records`, { type: 'TXT', name, content: inhalt, ttl: 60 });
    return { zone, id: eintrag.id };
  }

  async txtLoeschen({ zone, id }) {
    await this.anfrage('DELETE', `/zones/${zone}/dns_records/${id}`);
  }
}

// Minimaler Hetzner-Client (DNS in der Hetzner Console, Cloud-API) für TXT-Einträge der DNS-01-Prüfung.
// Token: Hetzner Console → Projekt mit der Zone → Sicherheit → API-Tokens, Rechte „Lesen & Schreiben“.
// Tokens aus der alten DNS Console (dns.hetzner.com) funktionieren mit der Cloud-API nicht.
export class HetznerDns {
  constructor(token, { fetchImpl = fetch, pauseMs = 2000, versuche = 60 } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.pauseMs = pauseMs;
    this.versuche = versuche;
  }

  async anfrage(methode, weg, koerper) {
    let antwort, daten;
    try {
      antwort = await this.fetch(`https://api.hetzner.cloud/v1${weg}`, {
        method: methode,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(koerper ? { 'Content-Type': 'application/json' } : {}) },
        body: koerper ? JSON.stringify(koerper) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      daten = await antwort.json().catch(() => null);
    } catch {
      throw new BasisFehler('Hetzner-API nicht erreichbar. Internetzugang und Firewall des Workers prüfen (api.hetzner.cloud).');
    }
    if (!antwort.ok) {
      const f = daten?.error;
      const meldung = f ? `${f.code}: ${f.message}` : `HTTP ${antwort.status}`;
      const hinweis = antwort.status === 401 ? 'Das Token ist ungültig – es muss in der Hetzner Console (Projekt mit der Zone) erstellt sein, nicht in der alten DNS Console.'
        : antwort.status === 403 ? 'Das Token braucht die Rechte „Lesen & Schreiben“.' : 'Token und Zone in der Hetzner Console prüfen.';
      throw new BasisFehler(`Hetzner-API hat abgelehnt (${meldung}). ${hinweis}`);
    }
    return daten;
  }

  // Zone zum Namen finden: _acme-challenge.monitoring.firma.de → firma.de (Zone) und _acme-challenge.monitoring (Eintrag).
  async zoneFinden(name) {
    const teile = name.split('.');
    for (let i = 1; i < teile.length - 1; i++) {
      const kandidat = teile.slice(i).join('.');
      const { zones = [] } = await this.anfrage('GET', `/zones?name=${encodeURIComponent(kandidat)}`);
      if (zones.some((z) => z.name === kandidat)) return { zone: kandidat, eintrag: teile.slice(0, i).join('.') };
    }
    throw new BasisFehler(`Keine Hetzner-Zone für ${name} gefunden. Die Domain muss im Projekt des Tokens in der Hetzner Console verwaltet werden.`);
  }

  // Hetzner bearbeitet Änderungen als „Action“; warten, bis sie fertig ist.
  async warteAufAktion(aktion) {
    for (let i = 0; i < this.versuche && aktion?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, this.pauseMs));
      ({ action: aktion } = await this.anfrage('GET', `/actions/${aktion.id}`));
    }
    if (aktion?.status === 'error') throw new BasisFehler(`Hetzner konnte den DNS-Eintrag nicht ändern: ${aktion.error?.message ?? 'unbekannter Fehler'}.`);
    if (aktion?.status === 'running') throw new BasisFehler('Hetzner hat den DNS-Eintrag nicht rechtzeitig geändert.');
  }

  rrsetWeg({ zone, eintrag }) { return `/zones/${encodeURIComponent(zone)}/rrsets/${encodeURIComponent(eintrag)}/TXT/actions`; }

  async txtAnlegen(name, inhalt) {
    const ziel = await this.zoneFinden(name);
    // TXT-Werte stehen bei Hetzner in Anführungszeichen.
    const wert = JSON.stringify(inhalt);
    const { action } = await this.anfrage('POST', `${this.rrsetWeg(ziel)}/add_records`, { ttl: 60, records: [{ value: wert }] });
    await this.warteAufAktion(action);
    return { ...ziel, wert };
  }

  async txtLoeschen({ zone, eintrag, wert }) {
    const { action } = await this.anfrage('POST', `${this.rrsetWeg({ zone, eintrag })}/remove_records`, { records: [{ value: wert }] });
    await this.warteAufAktion(action);
  }
}

// Wartet, bis der TXT-Eintrag über öffentliches DNS sichtbar ist. Das interne Firmen-DNS
// kennt öffentliche Einträge oft nicht, darum wird Cloudflares öffentlicher Resolver gefragt.
export async function warteAufTxt(name, wert, { fetchImpl = fetch, versuche = 30, pauseMs = 4000 } = {}) {
  for (let i = 0; i < versuche; i++) {
    try {
      const antwort = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) });
      const daten = await antwort.json();
      if ((daten.Answer ?? []).some((a) => a.data?.replaceAll('"', '') === wert)) return;
    } catch { /* nächster Versuch */ }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  throw new BasisFehler(`TXT-Eintrag ${name} wurde im öffentlichen DNS nicht sichtbar.`);
}

export class Zertifikatsverwaltung {
  constructor({ konfig, log = () => {}, acmeImpl = acme, dns, warten = warteAufTxt }) {
    this.konfig = konfig;
    this.log = log;
    this.acme = acmeImpl;
    this.ordner = path.join(konfig.datenOrdner, 'zertifikat');
    this.dns = dns ?? (konfig.tls.modus !== 'letsencrypt' ? null
      : konfig.tls.dnsAnbieter === 'hetzner' ? new HetznerDns(konfig.tls.hetznerToken) : new CloudflareDns(konfig.tls.cloudflareToken));
    this.warten = warten;
  }

  datei(name) { return path.join(this.ordner, name); }

  // Liefert Schlüssel und Zertifikat; bei tls.modus "aus" null (Server läuft dann per HTTP).
  async laden() {
    const tls = this.konfig.tls;
    if (tls.modus === 'aus') return null;
    if (tls.modus === 'dateien') {
      const [key, cert] = await Promise.all([lesen(tls.schluessel), lesen(tls.zertifikat)]);
      if (!key || !cert) throw new BasisFehler('Zertifikat- oder Schlüsseldatei nicht gefunden. Pfade unter tls in config.json prüfen.');
      if (brauchtErneuerung(cert, this.konfig.hostname)) melde(this.log, 'warnung', 'Zertifikat', 'Das Zertifikat läuft in weniger als 30 Tagen ab oder passt nicht zum hostname.');
      return { key, cert };
    }
    const [key, cert] = await Promise.all([lesen(this.datei('schluessel.pem')), lesen(this.datei('zertifikat.pem'))]);
    if (key && !brauchtErneuerung(cert, this.konfig.hostname)) return { key, cert };
    try {
      return await this.erneuern();
    } catch (fehler) {
      // Ein noch gültiges Zertifikat weiterverwenden, statt die Basis gar nicht zu starten.
      if (key && nochGueltig(cert, this.konfig.hostname)) {
        melde(this.log, 'warnung', 'Zertifikat', `Erneuerung fehlgeschlagen (${fehler.message}); das bisherige Zertifikat wird weiterverwendet.`);
        return { key, cert };
      }
      throw fehler;
    }
  }

  // Holt ein neues Let's-Encrypt-Zertifikat per DNS-01 über Cloudflare oder Hetzner.
  async erneuern() {
    const { hostname, tls } = this.konfig;
    await mkdir(this.ordner, { recursive: true });
    let kontoSchluessel = await lesen(this.datei('konto.pem'));
    if (!kontoSchluessel) {
      kontoSchluessel = (await this.acme.crypto.createPrivateKey()).toString();
      await atomarSchreiben(this.datei('konto.pem'), kontoSchluessel);
    }
    const client = new this.acme.Client({
      directoryUrl: tls.staging ? this.acme.directory.letsencrypt.staging : this.acme.directory.letsencrypt.production,
      accountKey: kontoSchluessel,
    });
    const [schluessel, csr] = await this.acme.crypto.createCsr({ commonName: hostname, altNames: [hostname] });
    const eintraege = new Map();
    this.log(`Zertifikat für ${hostname} wird bei Let's Encrypt${tls.staging ? ' (Testumgebung)' : ''} angefordert …`);
    let cert;
    try {
      cert = await client.auto({
        csr, email: tls.email, termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, schluesselAutorisierung) => {
          if (challenge.type !== 'dns-01') throw new BasisFehler('Nur die DNS-Prüfung wird unterstützt.');
          const name = `_acme-challenge.${authz.identifier.value}`;
          eintraege.set(schluesselAutorisierung, await this.dns.txtAnlegen(name, schluesselAutorisierung));
          await this.warten(name, schluesselAutorisierung);
        },
        challengeRemoveFn: async (authz, challenge, schluesselAutorisierung) => {
          const eintrag = eintraege.get(schluesselAutorisierung);
          if (eintrag) await this.dns.txtLoeschen(eintrag).catch(() => melde(this.log, 'warnung', 'Zertifikat', `TXT-Eintrag ${authz.identifier.value} konnte nicht gelöscht werden; bitte beim DNS-Anbieter (${tls.dnsAnbieter === 'hetzner' ? 'Hetzner Console' : 'Cloudflare'}) entfernen.`));
        },
      });
    } catch (fehler) {
      if (fehler instanceof BasisFehler) throw fehler;
      throw new BasisFehler(`Let's Encrypt hat kein Zertifikat ausgestellt: ${String(fehler?.message || fehler).slice(0, 300)}`);
    }
    const key = schluessel.toString();
    await atomarSchreiben(this.datei('schluessel.pem'), key);
    await atomarSchreiben(this.datei('zertifikat.pem'), cert);
    this.log(`Zertifikat erhalten, gültig bis ${new X509Certificate(cert).validTo}.`);
    return { key, cert };
  }

  // Prüft regelmäßig und tauscht das Zertifikat im laufenden Server ohne Neustart aus.
  automatischErneuern(server) {
    if (this.konfig.tls.modus !== 'letsencrypt') return null;
    const timer = setInterval(async () => {
      try {
        const cert = await lesen(this.datei('zertifikat.pem'));
        if (!brauchtErneuerung(cert, this.konfig.hostname)) return;
        server.setSecureContext(await this.erneuern());
        this.log('Neues Zertifikat ist aktiv.');
      } catch (fehler) {
        melde(this.log, 'fehler', 'Zertifikat', `Zertifikatserneuerung fehlgeschlagen: ${fehler.message}. Neuer Versuch in 12 Stunden.`);
      }
    }, PRUEFINTERVALL_MS);
    timer.unref();
    return timer;
  }
}
