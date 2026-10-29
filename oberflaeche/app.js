'use strict';

const STATUS_TEXT = { ok: 'OK', warnung: 'Warnung', fehler: 'Fehler', unbekannt: 'Noch nicht geprüft', inaktiv: 'Inaktiv', laeuft: 'Läuft …' };
const $ = (id) => document.getElementById(id);
let offenesModul = null;

function relativ(iso) {
  if (!iso) return null;
  const sekunden = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const betrag = Math.abs(sekunden);
  const text = betrag < 60 ? `${betrag} s` : betrag < 3600 ? `${Math.round(betrag / 60)} min` : betrag < 86400 ? `${Math.round(betrag / 3600)} h` : `${Math.round(betrag / 86400)} Tagen`;
  return sekunden < 0 ? `vor ${text}` : `in ${text}`;
}
const zeit = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });

function anzeigeStatus(modul) {
  if (modul.fehler) return 'fehler';
  if (modul.laeuft) return 'laeuft';
  if (!modul.aktiv) return 'inaktiv';
  return modul.letztes?.status ?? 'unbekannt';
}

async function api(weg, optionen = {}) {
  const antwort = await fetch(weg, { credentials: 'same-origin', ...optionen });
  if (antwort.status === 401) { location.href = '/login'; throw new Error('abgemeldet'); }
  return antwort;
}

function kachelBauen(modul) {
  const kachel = $('kachel-vorlage').content.firstElementChild.cloneNode(true);
  const status = anzeigeStatus(modul);
  kachel.dataset.status = status;
  kachel.querySelector('.name').textContent = modul.name;
  const pill = kachel.querySelector('.status');
  pill.textContent = STATUS_TEXT[status] ?? status;
  pill.dataset.status = status;
  kachel.querySelector('.zusammenfassung').textContent = modul.fehler ?? modul.letztes?.zusammenfassung ?? '';
  const zeiten = [];
  if (modul.letztes) zeiten.push(`Geprüft ${relativ(modul.letztes.beginn)}`);
  if (modul.naechsterLauf && !modul.laeuft) zeiten.push(`nächste Prüfung ${relativ(modul.naechsterLauf)}`);
  else if (!modul.intervallMinuten && !modul.fehler) zeiten.push('nur manuell');
  kachel.querySelector('.zeiten').textContent = zeiten.join(' · ');
  const knopf = kachel.querySelector('.pruefen');
  knopf.disabled = Boolean(modul.fehler || modul.laeuft);
  knopf.addEventListener('click', () => pruefen(modul.id, knopf));
  kachel.querySelector('.mehr').addEventListener('click', () => detailsOeffnen(modul));
  return kachel;
}

async function aktualisieren() {
  try {
    const daten = await (await api('/api/status')).json();
    $('verbindung').hidden = true;
    $('benutzer').textContent = daten.benutzer;
    const zaehler = { ok: 0, warnung: 0, fehler: 0 };
    for (const m of daten.module) {
      const s = m.fehler ? 'fehler' : m.letztes?.status;
      if (s in zaehler) zaehler[s]++;
    }
    for (const [s, n] of Object.entries(zaehler)) $(`anzahl-${s}`).textContent = n;
    $('kacheln').replaceChildren(...daten.module.map(kachelBauen));
    $('leer').hidden = daten.module.length > 0;
    $('stand').textContent = `Stand ${new Date().toLocaleTimeString('de-DE')}`;
    document.title = zaehler.fehler ? `(${zaehler.fehler}) Monitoring` : 'Monitoring';
    if (offenesModul) {
      const neu = daten.module.find((m) => m.id === offenesModul);
      if (neu) detailsFuellen(neu);
    }
  } catch (fehler) {
    if (fehler.message === 'abgemeldet') return;
    $('verbindung').textContent = 'Keine Verbindung zur Monitoring-Basis. Neuer Versuch in wenigen Sekunden …';
    $('verbindung').hidden = false;
  }
}

async function pruefen(id, knopf) {
  knopf.disabled = true;
  knopf.textContent = 'Wird gestartet …';
  const antwort = await api(`/api/module/${encodeURIComponent(id)}/pruefen`, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1' } });
  if (!antwort.ok) {
    const { fehler } = await antwort.json().catch(() => ({}));
    knopf.textContent = fehler || 'Nicht möglich';
  }
  setTimeout(aktualisieren, 800);
}

async function detailsFuellen(modul) {
  $('details-titel').textContent = modul.name;
  const letztes = modul.letztes;
  $('details-zusammenfassung').textContent = modul.fehler ?? (letztes ? `${STATUS_TEXT[letztes.status]}: ${letztes.zusammenfassung} (${zeit(letztes.beginn)}, ${(letztes.dauerMs / 1000).toFixed(1)} s)` : 'Noch nicht geprüft.');
  $('details-messwerte').replaceChildren(...Object.entries(letztes?.messwerte ?? {}).flatMap(([name, wert]) => {
    const dt = document.createElement('dt'); dt.textContent = name;
    const dd = document.createElement('dd'); dd.textContent = wert.toLocaleString('de-DE');
    return [dt, dd];
  }));
  $('details-liste').replaceChildren(...(letztes?.details ?? []).map((d) => { const li = document.createElement('li'); li.textContent = d; return li; }));
  $('details-ausgabe').hidden = !letztes?.fehlerausgabe;
  $('details-ausgabe').textContent = letztes?.fehlerausgabe ?? '';
  if (modul.fehler) { $('details-verlauf').replaceChildren(); return; }
  const { verlauf } = await (await api(`/api/module/${encodeURIComponent(modul.id)}/verlauf?anzahl=30`)).json();
  $('details-verlauf').replaceChildren(...verlauf.map((e) => {
    const li = document.createElement('li');
    li.dataset.status = e.status;
    const punkt = document.createElement('span'); punkt.className = 'punkt';
    const text = document.createElement('span'); text.textContent = `${zeit(e.beginn)} – ${e.zusammenfassung}`;
    li.append(punkt, text);
    return li;
  }));
}

function detailsOeffnen(modul) {
  offenesModul = modul.id;
  detailsFuellen(modul);
  if (!$('details').open) $('details').showModal();
}

$('details-schliessen').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { offenesModul = null; });
aktualisieren();
setInterval(aktualisieren, 10_000);
