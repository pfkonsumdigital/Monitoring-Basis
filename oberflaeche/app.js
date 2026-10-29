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
    $('version').textContent = daten.version ? `v${daten.version}` : '';
    $('updates-oeffnen').hidden = !daten.admin;
    $('update-hinweis').hidden = !daten.updateVerfuegbar;
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

// ---- Updates (nur Admins) ----
const PHASEN = { suche: 'Suche nach Updates …', herunterladen: 'Paket wird heruntergeladen …', pruefen: 'Prüfsumme wird kontrolliert …', entpacken: 'Paket wird entpackt …', selbsttest: 'Neue Version wird getestet …', neustart: 'Die Basis startet neu …' };
let updateStatus = null;

function updateMeldung(text, art = '') {
  $('upd-meldung').textContent = text;
  $('upd-meldung').dataset.art = art;
}

function updateZeigen(st) {
  updateStatus = st;
  $('upd-installiert').textContent = st.installiert ? `v${st.installiert}` : '–';
  $('upd-verfuegbar').textContent = st.verfuegbar ? `v${st.verfuegbar.version}${st.verfuegbar.veroeffentlicht ? ` (${zeit(st.verfuegbar.veroeffentlicht)})` : ''}` : '–';
  $('upd-geprueft').textContent = st.letztePruefung ? zeit(st.letztePruefung) : 'noch nicht';
  $('upd-notizen').hidden = !(st.updateMoeglich && st.verfuegbar?.notizen);
  $('upd-notizen').textContent = st.verfuegbar?.notizen ?? '';
  const beschaeftigt = Boolean(PHASEN[st.phase]);
  $('upd-suchen').disabled = beschaeftigt || !st.eingerichtet;
  $('upd-installieren').hidden = !(st.updateMoeglich && st.viaStarter) || beschaeftigt;
  $('upd-installieren').textContent = st.verfuegbar ? `Auf v${st.verfuegbar.version} updaten` : 'Updaten';
  $('upd-zurueck').hidden = !(st.vorherige && st.viaStarter) || beschaeftigt;
  $('upd-zurueck').textContent = st.vorherige ? `Zurück auf v${st.vorherige.version}` : 'Vorherige Version wiederherstellen';
  if (!st.eingerichtet) updateMeldung('Updates sind nicht eingerichtet: In config.json fehlt der Abschnitt "updates" mit GitHub-Token.', 'fehler');
  else if (beschaeftigt) updateMeldung(PHASEN[st.phase]);
  else if (st.phase === 'fehler') updateMeldung(st.fehler, 'fehler');
  else if (!st.viaStarter) updateMeldung('Die Basis läuft nicht über start.js. Updates können gesucht, aber nicht installiert werden.', 'fehler');
  else if (st.verfuegbar && !st.updateMoeglich) updateMeldung('Die Basis ist auf dem neuesten Stand.', 'ok');
  else if (st.updateMoeglich) updateMeldung(`Version ${st.verfuegbar.version} ist verfügbar.`);
  else updateMeldung('');
}

async function updateAktion(weg, koerper) {
  const antwort = await api(`/api/updates/${weg}`, { method: 'POST', headers: { 'X-Monitor-Anfrage': '1', 'Content-Type': 'application/json' }, body: koerper ? JSON.stringify(koerper) : undefined });
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) { if (daten.status) updateZeigen(daten.status); updateMeldung(daten.fehler || 'Aktion nicht möglich.', 'fehler'); return null; }
  updateZeigen(daten);
  return daten;
}

// Wartet auf den Neustart. Nach dem Neustart ist die alte Sitzung ungültig (401) – dann neu anmelden.
async function aufNeustartWarten() {
  updateMeldung(PHASEN.neustart);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const antwort = await fetch('/api/updates', { credentials: 'same-origin' });
      if (antwort.status === 401) { location.href = '/login?update=1'; return; }
      if (antwort.ok) {
        const st = await antwort.json();
        if (st.phase !== 'neustart') { updateZeigen(st); return; }
      }
    } catch { /* Server startet gerade neu */ }
  }
  updateMeldung('Die Basis meldet sich nicht zurück. Bitte logs\\basis.log auf dem Worker prüfen.', 'fehler');
}

async function updatesOeffnen() {
  $('upd-bestaetigen').hidden = true;
  if (!$('updates').open) $('updates').showModal();
  const antwort = await api('/api/updates');
  if (antwort.ok) updateZeigen(await antwort.json());
}

$('updates-oeffnen').addEventListener('click', updatesOeffnen);
$('updates-schliessen').addEventListener('click', () => $('updates').close());
$('upd-suchen').addEventListener('click', async () => { updateMeldung(PHASEN.suche); $('upd-suchen').disabled = true; await updateAktion('suchen'); });
$('upd-installieren').addEventListener('click', () => {
  $('upd-bestaetigen-version').textContent = `v${updateStatus.verfuegbar.version}`;
  $('upd-bestaetigen').hidden = false;
  $('upd-installieren').hidden = true;
});
$('upd-nein').addEventListener('click', () => { $('upd-bestaetigen').hidden = true; updateZeigen(updateStatus); });
$('upd-ja').addEventListener('click', async () => {
  $('upd-bestaetigen').hidden = true;
  $('upd-installieren').hidden = true;
  updateMeldung(PHASEN.herunterladen);
  const ergebnis = await updateAktion('installieren', { version: updateStatus.verfuegbar.version });
  if (!ergebnis) return;
  // Fortschritt anzeigen, bis die Basis neu startet.
  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    let st;
    try { st = await (await fetch('/api/updates', { credentials: 'same-origin' })).json(); } catch { break; }
    updateZeigen(st);
    if (st.phase === 'neustart' || !PHASEN[st.phase]) break;
  }
  if (updateStatus.phase === 'neustart' || updateStatus.phase === 'herunterladen') await aufNeustartWarten();
});
$('upd-zurueck').addEventListener('click', async () => {
  if (await updateAktion('zurueck')) await aufNeustartWarten();
});

$('details-schliessen').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { offenesModul = null; });
aktualisieren();
setInterval(aktualisieren, 10_000);
