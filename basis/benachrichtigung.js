import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';

// Zentrale Benachrichtigung per Mail über Microsoft 365 (Graph, App-Registrierung mit
// Client-Secret, Anwendungsberechtigung Mail.Send – per RBAC for Applications auf das
// Absenderpostfach beschränkt). Läuft ohne angemeldeten Benutzer, auch unter SYSTEM.

const STUNDE = 3_600_000;
const WIEDERHOLEN_MS = 5 * 60_000;
const MAX_VERLAUF = 20;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const STANDARD = { aktiv: false, tenant_id: '', client_id: '', client_secret: '', absender: '', empfaenger: [], erinnerung_stunden: 4, melden_nach_laeufen: 1, link: '' };

export class MailFehler extends Error {}

// Versand über Microsoft Graph. Das Zugriffstoken wird bis kurz vor Ablauf wiederverwendet.
export class GraphMail {
  constructor({ tenantId, clientId, clientSecret, absender, fetchImpl = fetch, jetzt = () => Date.now() }) {
    Object.assign(this, { tenantId, clientId, clientSecret, absender, fetchImpl, jetzt });
    this.zugang = null;
  }

  async anfrage(url, optionen) {
    try { return await this.fetchImpl(url, { ...optionen, signal: AbortSignal.timeout(20_000) }); }
    catch (fehler) { throw new MailFehler(`Microsoft 365 nicht erreichbar (${fehler.cause?.code ?? fehler.name ?? fehler.message}). Ausgehende Verbindung zu login.microsoftonline.com und graph.microsoft.com prüfen.`); }
  }

  async token() {
    if (this.zugang && this.zugang.bis > this.jetzt()) return this.zugang.token;
    const antwort = await this.anfrage(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok || !daten.access_token) {
      const code = String(daten.error_description ?? '').match(/AADSTS\d+/)?.[0];
      throw new MailFehler(`Anmeldung bei Microsoft fehlgeschlagen (${code ?? daten.error ?? `HTTP ${antwort.status}`}). Mandanten-ID, Anwendungs-ID und geheimen Schlüssel prüfen; abgelaufene Schlüssel in Entra erneuern.`);
    }
    this.zugang = { token: daten.access_token, bis: this.jetzt() + Math.max(60, (daten.expires_in ?? 3600) - 300) * 1000 };
    return this.zugang.token;
  }

  async senden({ an, betreff, text }) {
    const token = await this.token();
    const antwort = await this.anfrage(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.absender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { subject: betreff, body: { contentType: 'Text', content: text }, toRecipients: an.map((address) => ({ emailAddress: { address } })) },
        saveToSentItems: false,
      }),
    });
    if (antwort.status === 202) return;
    if (antwort.status === 401) this.zugang = null;
    const fehler = (await antwort.json().catch(() => ({})))?.error ?? {};
    const hinweis = {
      403: `Die App darf nicht als ${this.absender} senden. Berechtigung „Application Mail.Send“ für dieses Postfach in Exchange (RBAC for Applications) prüfen – Änderungen wirken erst nach bis zu 2 Stunden.`,
      404: `Absenderpostfach ${this.absender} nicht gefunden.`,
      401: 'Zugriff abgelehnt (Token ungültig).',
    }[antwort.status] ?? `Versand fehlgeschlagen (HTTP ${antwort.status}${fehler.code ? `, ${fehler.code}` : ''}).`;
    throw new MailFehler(hinweis);
  }
}

// Prüft die Eingabe aus dem Formular. Liefert { werte } oder { feldfehler }.
export function pruefeEinstellungen(eingabe, bisher) {
  const feldfehler = {};
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const text = (k) => (typeof e[k] === 'string' ? e[k].trim() : e[k] === undefined ? bisher[k] : '');
  const werte = {
    aktiv: e.aktiv === undefined ? bisher.aktiv : e.aktiv === true,
    tenant_id: text('tenant_id'),
    client_id: text('client_id'),
    // Leeres Feld = bisherigen Schlüssel behalten (er wird nie angezeigt).
    client_secret: typeof e.client_secret === 'string' && e.client_secret !== '' ? e.client_secret : bisher.client_secret,
    absender: text('absender'),
    empfaenger: Array.isArray(e.empfaenger) ? e.empfaenger.map((x) => String(x).trim()).filter(Boolean)
      : typeof e.empfaenger === 'string' ? e.empfaenger.split(/[\s,;]+/).filter(Boolean) : bisher.empfaenger,
    erinnerung_stunden: e.erinnerung_stunden === undefined ? bisher.erinnerung_stunden : Number(String(e.erinnerung_stunden).replace(',', '.')),
    melden_nach_laeufen: e.melden_nach_laeufen === undefined ? bisher.melden_nach_laeufen : Number(e.melden_nach_laeufen),
    link: text('link'),
  };
  if (werte.tenant_id && !GUID.test(werte.tenant_id) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(werte.tenant_id)) feldfehler.tenant_id = 'GUID oder Domain (z. B. firma.onmicrosoft.com)';
  if (werte.client_id && !GUID.test(werte.client_id)) feldfehler.client_id = 'muss eine GUID sein';
  if (werte.absender && !MAIL.test(werte.absender)) feldfehler.absender = 'keine gültige Mailadresse';
  if (werte.empfaenger.length > 20) feldfehler.empfaenger = 'höchstens 20 Empfänger';
  const falsch = werte.empfaenger.filter((m) => !MAIL.test(m));
  if (falsch.length) feldfehler.empfaenger = `ungültig: ${falsch.join(', ')}`;
  if (!Number.isFinite(werte.erinnerung_stunden) || werte.erinnerung_stunden < 0 || werte.erinnerung_stunden > 168) feldfehler.erinnerung_stunden = '0 (aus) bis 168';
  if (!Number.isInteger(werte.melden_nach_laeufen) || werte.melden_nach_laeufen < 1 || werte.melden_nach_laeufen > 20) feldfehler.melden_nach_laeufen = 'ganze Zahl von 1 bis 20';
  if (werte.link && !/^https?:\/\/[^\s]+$/.test(werte.link)) feldfehler.link = 'muss mit http:// oder https:// beginnen';
  if (typeof werte.client_secret !== 'string' || werte.client_secret.length > 500) feldfehler.client_secret = 'ungültig';
  if (werte.aktiv) {
    for (const k of ['tenant_id', 'client_id', 'client_secret', 'absender']) if (!werte[k] && !feldfehler[k]) feldfehler[k] = 'Pflichtfeld, wenn die Benachrichtigung aktiv ist';
    if (!werte.empfaenger.length && !feldfehler.empfaenger) feldfehler.empfaenger = 'mindestens ein Empfänger';
  }
  return Object.keys(feldfehler).length ? { feldfehler } : { werte };
}

const TITEL = { fehler: 'FEHLER', warnung: 'WARNUNG', 'keine-meldung': 'KEINE MELDUNG', 'dienst-gestoppt': 'DIENST GESTOPPT', 'wieder-ok': 'WIEDER OK', erinnerung: 'ERINNERUNG' };
const STATUSTEXT = { fehler: 'Fehler', warnung: 'Warnung', 'keine-meldung': 'Keine Meldung', 'dienst-gestoppt': 'Dienst gestoppt', ok: 'OK' };
const zeitText = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
function dauerText(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 120 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} Tagen`;
}

// Welche Kategorie zählt für die Benachrichtigung? null = nichts melden/ändern.
function kategorie(m, meldenNach) {
  if (m.anzeige === 'modulfehler') return 'fehler';
  if (m.anzeige === 'keine-meldung') return 'keine-meldung';
  if (m.anzeige === 'dienst-gestoppt') return 'dienst-gestoppt';
  if (m.anzeige === 'ok') return 'ok';
  if (m.anzeige === 'fehler' || m.anzeige === 'warnung') return m.problemLaeufe >= meldenNach ? m.anzeige : null;
  return null; // inaktiv, beendet, unbekannt, läuft
}

export class Benachrichtigung {
  constructor({ datenOrdner, log = () => {}, geheimnisse = [], fetchImpl = fetch, jetzt = () => Date.now() }) {
    Object.assign(this, { log, geheimnisse, fetchImpl, jetzt });
    this.datei = path.join(datenOrdner, 'benachrichtigung.json');
    this.zustandDatei = path.join(datenOrdner, 'benachrichtigung-zustand.json');
    this.werte = { ...STANDARD };
    this.zustand = { module: {}, verlauf: [] };
  }

  async laden() {
    try { this.werte = { ...STANDARD, ...JSON.parse(await readFile(this.datei, 'utf8')) }; } catch { /* noch nicht eingerichtet */ }
    try { this.zustand = { module: {}, verlauf: [], ...JSON.parse(await readFile(this.zustandDatei, 'utf8')) }; } catch { /* erster Start */ }
    this.geheimnisMerken();
    this.mail = null;
  }

  geheimnisMerken() {
    if (this.werte.client_secret && !this.geheimnisse.includes(this.werte.client_secret)) this.geheimnisse.push(this.werte.client_secret);
  }

  eingerichtet() {
    const w = this.werte;
    return Boolean(w.tenant_id && w.client_id && w.client_secret && w.absender && w.empfaenger.length);
  }

  postfach() {
    this.mail ??= new GraphMail({ tenantId: this.werte.tenant_id, clientId: this.werte.client_id, clientSecret: this.werte.client_secret, absender: this.werte.absender, fetchImpl: this.fetchImpl, jetzt: this.jetzt });
    return this.mail;
  }

  // Für die Oberfläche: der Schlüssel wird nie herausgegeben.
  ansicht() {
    const { client_secret: schluessel, ...rest } = this.werte;
    return { werte: { ...rest, client_secret: { gesetzt: Boolean(schluessel) } }, eingerichtet: this.eingerichtet(), verlauf: this.zustand.verlauf };
  }

  async speichern(eingabe, benutzer) {
    const { werte, feldfehler } = pruefeEinstellungen(eingabe, this.werte);
    if (feldfehler) return { feldfehler };
    const vorher = this.werte;
    this.werte = werte;
    this.mail = null;
    await schreibeAtomar(this.datei, werte);
    this.geheimnisMerken();
    const geaendert = Object.keys(werte).filter((k) => JSON.stringify(werte[k]) !== JSON.stringify(vorher[k]));
    if (geaendert.length) this.log(`Benachrichtigung geändert durch ${benutzer}: ${geaendert.map((k) => (k === 'client_secret' ? 'geheimer Schlüssel' : k)).join(', ')}.`);
    return { geaendert };
  }

  text(zeilen) { return zeilen.filter((z) => z !== null && z !== undefined).join('\n'); }

  async versenden(art, betreff, text, modulId = null) {
    const eintrag = { zeit: new Date(this.jetzt()).toISOString(), art, modul: modulId, betreff, ok: true };
    try {
      await this.postfach().senden({ an: this.werte.empfaenger, betreff, text });
      this.log(`Benachrichtigung gesendet: ${betreff}`);
    } catch (fehler) {
      eintrag.ok = false;
      eintrag.fehler = fehler.message;
      melde(this.log, 'fehler', 'Benachrichtigung', `Mail „${betreff}“ nicht gesendet: ${fehler.message}`, fehler instanceof MailFehler ? undefined : fehler);
    }
    this.zustand.verlauf = [eintrag, ...this.zustand.verlauf].slice(0, MAX_VERLAUF);
    return eintrag;
  }

  async testmail(benutzer) {
    if (!this.eingerichtet()) return { ok: false, fehler: 'Bitte zuerst Mandanten-ID, Anwendungs-ID, Schlüssel, Absender und Empfänger speichern.' };
    const eintrag = await this.versenden('test', '[Monitoring] Testmail', this.text([
      `Diese Testmail wurde von ${benutzer} in der Monitoring-Basis ausgelöst.`,
      'Wenn sie ankommt, ist die Benachrichtigung richtig eingerichtet.',
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
    ]));
    await this.zustandSpeichern();
    return eintrag;
  }

  mailText(m, art, jetzt, seit) {
    const l = m.letztes;
    return this.text([
      `Modul: ${m.name}${m.version ? ` (v${m.version})` : ''}`,
      `Status: ${STATUSTEXT[m.anzeige === 'modulfehler' ? 'fehler' : m.anzeige] ?? m.anzeige}`,
      m.fehler ? `Problem: ${m.fehler}` : m.anzeige === 'dienst-gestoppt' ? `Problem: ${m.dienst?.fehler ?? `Windows-Dienst „${m.dienst?.name}“ ist gestoppt.`}` : m.anzeige === 'keine-meldung' ? `Letzte Meldung: ${l ? zeitText(Date.parse(l.ende ?? l.beginn)) : 'noch nie'}` : l ? `Meldung: ${l.zusammenfassung}` : null,
      art !== 'wieder-ok' && seit ? `Seit: ${zeitText(seit)} (${dauerText(jetzt - seit)})` : null,
      m.problemLaeufe > 1 ? `Läufe ohne OK: ${m.problemLaeufe}` : null,
      ...(art !== 'wieder-ok' && l?.details?.length ? ['', 'Details:', ...l.details.slice(0, 20).map((d) => `- ${d}`), ...(l.details.length > 20 ? [`… und ${l.details.length - 20} weitere`] : [])] : []),
      this.werte.link ? `\nOberfläche: ${this.werte.link}` : null,
      `\nZeit: ${zeitText(jetzt)}`,
    ]);
  }

  // Wird nach jedem Einlesen der Module aufgerufen. Meldet Statuswechsel und Erinnerungen.
  async pruefen(ansichten) {
    if (this.laeuft || !this.werte.aktiv || !this.eingerichtet()) return;
    this.laeuft = true;
    try {
      const jetzt = this.jetzt();
      let geaendert = false;
      for (const m of ansichten) {
        const k = kategorie(m, this.werte.melden_nach_laeufen);
        if (!k) continue;
        const z = this.zustand.module[m.id] ?? { gemeldet: 'ok' };
        if (z.naechsterVersuch && jetzt < z.naechsterVersuch) continue;
        let art = null;
        if (k !== z.gemeldet) art = k === 'ok' ? 'wieder-ok' : k;
        else if (k !== 'ok' && this.werte.erinnerung_stunden > 0 && z.letzteMail && jetzt - z.letzteMail >= this.werte.erinnerung_stunden * STUNDE) art = 'erinnerung';
        if (!art) continue;
        const seit = art === 'erinnerung' ? z.seit : k === 'dienst-gestoppt' ? jetzt : (m.problemSeit ? Date.parse(m.problemSeit) : m.ueberfaelligSeit ? Date.parse(m.ueberfaelligSeit) : jetzt);
        const titel = art === 'erinnerung' ? `ERINNERUNG: ${m.name} – ${STATUSTEXT[k]} seit ${dauerText(jetzt - z.seit)}` : `${TITEL[art]}: ${m.name}`;
        const eintrag = await this.versenden(art, `[Monitoring] ${titel}`, this.mailText(m, art, jetzt, seit), m.id);
        geaendert = true;
        // Fehlgeschlagen: Zustand nicht übernehmen und in 5 Minuten erneut versuchen.
        if (!eintrag.ok) { this.zustand.module[m.id] = { ...z, naechsterVersuch: jetzt + WIEDERHOLEN_MS }; continue; }
        this.zustand.module[m.id] = art === 'erinnerung' ? { ...z, letzteMail: jetzt, naechsterVersuch: undefined }
          : { gemeldet: k, seit: k === 'ok' ? jetzt : seit, letzteMail: jetzt };
      }
      if (geaendert) await this.zustandSpeichern();
    } finally {
      this.laeuft = false;
    }
  }

  // Vor dem Beenden der Basis: Bescheid geben, dass bis zum nächsten Start nichts überwacht wird.
  async basisBeendet(benutzer, mitModulen, fehler = []) {
    if (!this.werte.aktiv || !this.eingerichtet()) return null;
    const eintrag = await this.versenden('basis-beendet', `[Monitoring] Basis beendet durch ${benutzer}`, this.text([
      `Die Monitoring-Basis wurde von ${benutzer} beendet.`,
      'Bis zum nächsten Start werden keine Module überwacht und keine Benachrichtigungen verschickt.',
      mitModulen ? 'Die eigenständigen Module wurden ebenfalls beendet.' : 'Eigenständige Module laufen weiter.',
      ...(fehler.length ? ['', 'Nicht beendet:', ...fehler.map((f) => `- ${f}`)] : []),
      '',
      'Neu starten: auf dem Worker Start.exe ausführen oder im Aufgabenplaner die Aufgabe „Monitoring-Basis“ starten (oder Rechner neu starten).',
      `\nZeit: ${zeitText(this.jetzt())}`,
    ]));
    await this.zustandSpeichern();
    return eintrag;
  }

  async zustandSpeichern() {
    try { await schreibeAtomar(this.zustandDatei, this.zustand); }
    catch (fehler) { melde(this.log, 'fehler', 'Benachrichtigung', `Zustand konnte nicht gespeichert werden: ${fehler.message}`); }
  }
}
