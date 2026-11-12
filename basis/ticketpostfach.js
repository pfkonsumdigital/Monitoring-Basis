import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';
import { GraphMail } from './benachrichtigung.js';
import { istKlartext, istVerschluesselt } from './geheimnis.js';

// Abruf eingehender E-Mails für die Tickets aus einem Postfach (z. B. it@…) über Microsoft Graph.
// Eigene App-Registrierung (getrennt von der App für die Warnmails) mit der Anwendungsberechtigung Mail.Read –
// am besten per RBAC for Applications auf dieses Postfach beschränkt (README „Tickets“).
// Nur lesen: Mails werden weder als gelesen markiert noch verschoben. Zuordnung über die Ticketnummer im Betreff.

const MAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STANDARD = { aktiv: false, tenant_id: '', client_id: '', client_secret: '', postfach: '', rueckblick_tage: 30 };
const ZUGANG = ['tenant_id', 'client_id', 'client_secret'];
const ABRUF_MS = 2 * 60_000;
const MAX_SEITEN = 20;

export function pruefePostfach(eingabe, bisher) {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const text = (k) => (typeof e[k] === 'string' ? e[k].trim() : bisher[k]);
  const werte = {
    aktiv: e.aktiv === undefined ? bisher.aktiv : e.aktiv === true,
    tenant_id: text('tenant_id'),
    client_id: text('client_id'),
    // Leeres Feld = bisherigen Schlüssel behalten (er wird nie angezeigt).
    client_secret: typeof e.client_secret === 'string' && e.client_secret !== '' ? e.client_secret : bisher.client_secret,
    postfach: text('postfach'),
    rueckblick_tage: e.rueckblick_tage === undefined ? bisher.rueckblick_tage : Number(e.rueckblick_tage),
  };
  const feldfehler = {};
  if (werte.postfach && !MAIL.test(werte.postfach)) feldfehler.postfach = 'keine gültige Mailadresse';
  if (werte.tenant_id && !GUID.test(werte.tenant_id) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(werte.tenant_id)) feldfehler.tenant_id = 'GUID oder Domain (z. B. firma.onmicrosoft.com)';
  if (werte.client_id && !GUID.test(werte.client_id)) feldfehler.client_id = 'muss eine GUID sein';
  if (typeof werte.client_secret !== 'string' || werte.client_secret.length > 500) feldfehler.client_secret = 'ungültig';
  if (werte.aktiv) for (const k of [...ZUGANG, 'postfach']) if (!werte[k] && !feldfehler[k]) feldfehler[k] = 'Pflichtfeld, wenn der Abruf aktiv ist';
  if (!Number.isInteger(werte.rueckblick_tage) || werte.rueckblick_tage < 0 || werte.rueckblick_tage > 365) feldfehler.rueckblick_tage = 'ganze Zahl von 0 bis 365';
  return Object.keys(feldfehler).length ? { feldfehler } : { werte };
}

export class TicketPostfach {
  // tresor: verschlüsselt den Schlüssel in der Datei (Windows-DPAPI); geheimnisse: Liste, die das Protokoll herausfiltert.
  constructor({ datenOrdner, tickets, tresor = null, geheimnisse = [], fetchImpl = fetch, log = () => {}, jetzt = () => Date.now() }) {
    Object.assign(this, { tickets, tresor, geheimnisse, fetchImpl, log, jetzt });
    this.zugang = null;
    this.datei = path.join(datenOrdner, 'tickets-postfach.json');
    this.werte = { ...STANDARD };
    // seit: Eingangszeit der jüngsten abgerufenen Mail (ISO); letzterAbruf/letzterFehler/zugeordnet: für die Oberfläche.
    this.zustand = { seit: null, letzterAbruf: null, letzterFehler: null, zugeordnet: 0 };
    this.laeuft = null;
    this.timer = null;
  }

  async laden() {
    try {
      const roh = JSON.parse(await readFile(this.datei, 'utf8'));
      this.werte = { ...STANDARD, ...roh.werte };
      this.zustand = { ...this.zustand, ...roh.zustand };
    } catch { /* noch nicht eingerichtet */ }
    // Der Schlüssel liegt verschlüsselt in der Datei, im Speicher als Klartext.
    if (istVerschluesselt(this.werte.client_secret)) {
      try { this.werte.client_secret = await this.tresor.einzeln(this.werte.client_secret); }
      catch (fehler) {
        this.werte.client_secret = '';
        melde(this.log, 'fehler', 'Tickets', `Der Schlüssel für das Ticket-Postfach lässt sich nicht entschlüsseln (${fehler.message}). Bitte unter „Tickets“ neu eintragen.`);
      }
    }
    this.geheimnisMerken();
  }

  geheimnisMerken() {
    if (this.werte.client_secret && !this.geheimnisse.includes(this.werte.client_secret)) this.geheimnisse.push(this.werte.client_secret);
  }

  // Schreibt Einstellungen und Zustand; der Schlüssel wird unter Windows verschlüsselt gespeichert.
  async speichernDatei() {
    const s = this.werte.client_secret;
    const werte = this.tresor?.verfuegbar && istKlartext(s) ? { ...this.werte, client_secret: (await this.tresor.schuetzen([s], 'basis'))[0] } : this.werte;
    await schreibeAtomar(this.datei, { werte, zustand: this.zustand });
  }

  eingerichtet() { return ZUGANG.every((k) => this.werte[k]); }

  // Graph-Zugang mit der eigenen App (Token wird bis kurz vor Ablauf wiederverwendet).
  graph() {
    if (!this.eingerichtet()) return null;
    this.zugang ??= new GraphMail({ tenantId: this.werte.tenant_id, clientId: this.werte.client_id, clientSecret: this.werte.client_secret, absender: this.werte.postfach, fetchImpl: this.fetchImpl, jetzt: this.jetzt });
    return this.zugang;
  }

  // Für die Oberfläche: der Schlüssel wird nie herausgegeben.
  ansicht() {
    const { client_secret: schluessel, ...rest } = this.werte;
    return { werte: { ...rest, client_secret: { gesetzt: Boolean(schluessel) } }, zustand: this.zustand, zugangEingerichtet: this.eingerichtet() };
  }

  async speichern(eingabe, benutzer) {
    const r = pruefePostfach(eingabe, this.werte);
    if (r.feldfehler) return r;
    const geaendert = Object.keys(r.werte).filter((k) => r.werte[k] !== this.werte[k]);
    // Anderes Postfach: wieder ab dem Rückblick abrufen.
    if (r.werte.postfach !== this.werte.postfach || r.werte.rueckblick_tage !== this.werte.rueckblick_tage) this.zustand.seit = null;
    this.werte = r.werte;
    this.zugang = null;
    // Neue Zugangsdaten: alten Fehler nicht weiter anzeigen, der nächste Abruf entscheidet.
    if (geaendert.some((k) => ZUGANG.includes(k) || k === 'postfach')) this.zustand.letzterFehler = null;
    await this.speichernDatei();
    this.geheimnisMerken();
    if (geaendert.length) this.log(`Ticket-Postfach geändert durch ${benutzer}: ${geaendert.map((k) => (k === 'client_secret' ? 'geheimer Schlüssel' : k)).join(', ')}.`);
    return { ansicht: this.ansicht() };
  }

  start() {
    this.timer = setInterval(() => { if (this.werte.aktiv) this.abrufen().catch(() => {}); }, ABRUF_MS);
    this.timer.unref?.();
    if (this.werte.aktiv) setTimeout(() => this.abrufen().catch(() => {}), 20_000).unref?.();
  }

  stop() { clearInterval(this.timer); }

  // Ruft neue Mails ab und ordnet sie zu. Läuft nie doppelt. Liefert { abgerufen, zugeordnet } oder wirft.
  abrufen() {
    this.laeuft ??= this.#abrufen().finally(() => { this.laeuft = null; });
    return this.laeuft;
  }

  async #abrufen() {
    const zugang = this.graph();
    try {
      if (!this.werte.postfach) throw new Error('Kein Postfach eingetragen.');
      if (!zugang) throw new Error('Zugangsdaten fehlen (Mandanten-ID, Anwendungs-ID, geheimer Schlüssel der App für die Tickets).');
      const token = await zugang.token();
      // Eine Minute Überlappung: Mails mit gleicher Eingangszeit gehen nicht verloren, doppelte erkennt die Message-ID.
      const seitMs = this.zustand.seit ? Date.parse(this.zustand.seit) - 60_000 : this.jetzt() - this.werte.rueckblick_tage * 86_400_000;
      const filter = `receivedDateTime ge ${new Date(seitMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
      let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.werte.postfach)}/mailFolders/inbox/messages?${new URLSearchParams({
        $filter: filter, $orderby: 'receivedDateTime asc', $top: '50', $select: 'internetMessageId,subject,from,receivedDateTime,uniqueBody' })}`;
      let abgerufen = 0;
      let zugeordnet = 0;
      for (let seite = 0; url && seite < MAX_SEITEN; seite += 1) {
        const antwort = await zugang.anfrage(url, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"' } });
        if (!antwort.ok) {
          if (antwort.status === 401) this.zugang = null;
          const code = (await antwort.json().catch(() => ({})))?.error?.code;
          throw new Error({
            401: 'Zugriff abgelehnt (Token ungültig). Anwendungs-ID und Schlüssel prüfen.',
            403: `Die App darf das Postfach ${this.werte.postfach} nicht lesen. Berechtigung „Mail.Read“ (Anwendung) prüfen: Administratorzustimmung in Entra oder Rolle „Application Mail.Read“ für dieses Postfach in Exchange (RBAC) – Änderungen wirken nach bis zu 2 Stunden.`,
            404: `Postfach ${this.werte.postfach} nicht gefunden.`,
          }[antwort.status] ?? `Abruf fehlgeschlagen (HTTP ${antwort.status}${code ? `, ${code}` : ''}).`);
        }
        const daten = await antwort.json();
        for (const m of daten.value ?? []) {
          abgerufen += 1;
          const von = m.from?.emailAddress?.address ?? '';
          if (m.receivedDateTime && (!this.zustand.seit || m.receivedDateTime > this.zustand.seit)) this.zustand.seit = m.receivedDateTime;
          // Mails des Postfachs an sich selbst sind keine Eingänge.
          if (von.toLowerCase() === this.werte.postfach.toLowerCase()) continue;
          const r = await this.tickets.mailZuordnen({ nachrichtId: m.internetMessageId, von, name: m.from?.emailAddress?.name, betreff: m.subject, zeit: m.receivedDateTime, text: m.uniqueBody?.content ?? '' });
          if (r.ergebnis === 'zugeordnet') zugeordnet += 1;
        }
        url = daten['@odata.nextLink'] ?? null;
      }
      const vorherFehler = this.zustand.letzterFehler;
      Object.assign(this.zustand, { letzterAbruf: new Date(this.jetzt()).toISOString(), letzterFehler: null, zugeordnet: this.zustand.zugeordnet + zugeordnet });
      await this.speichernDatei();
      if (vorherFehler) this.log(`Ticket-Postfach: Abruf klappt wieder (${this.werte.postfach}).`);
      return { abgerufen, zugeordnet };
    } catch (fehler) {
      const neu = fehler.message !== this.zustand.letzterFehler;
      Object.assign(this.zustand, { letzterAbruf: new Date(this.jetzt()).toISOString(), letzterFehler: fehler.message });
      await this.speichernDatei().catch(() => {});
      // Gleichen Fehler nur einmal melden, sonst alle 2 Minuten ein Eintrag.
      if (neu) melde(this.log, 'fehler', 'Tickets', `Ticket-Postfach: ${fehler.message}`);
      throw fehler;
    }
  }
}
