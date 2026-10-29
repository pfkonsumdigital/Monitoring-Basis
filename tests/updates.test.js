import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leseAktiv, schreibeAktiv, Updateverwaltung, vergleicheVersionen } from '../basis/updates.js';

const temp = () => mkdtemp(path.join(tmpdir(), 'mb-upd-'));

// Baut ein Testpaket wie scripts/paket-bauen.js: package.json + basis/main.js (Selbsttest-Verhalten wählbar).
async function testPaket(ordner, version, selbsttestCode = 0) {
  const quelle = path.join(ordner, `quelle-${version}`);
  await mkdir(path.join(quelle, 'basis'), { recursive: true });
  await writeFile(path.join(quelle, 'package.json'), JSON.stringify({ name: 'monitoring-basis', version }));
  await writeFile(path.join(quelle, 'basis', 'main.js'), `if (process.argv.includes('--selbsttest')) { console.log('Selbsttest ${selbsttestCode}'); process.exit(${selbsttestCode}); }`);
  const datei = path.join(ordner, `paket-${version}.tar.gz`);
  execFileSync('tar', ['-czf', datei, '-C', quelle, '.']);
  return readFile(datei);
}

function fakeGithub({ version = '0.2.0', paket, pruefsumme, status = 200 }) {
  const aufrufe = [];
  const fetchImpl = async (url, opt) => {
    aufrufe.push(url);
    assert.equal(opt.headers.Authorization, 'Bearer TOKEN');
    if (status !== 200) return new Response('{}', { status });
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: `v${version}`, body: '### Neu\n- Update-Funktion', published_at: '2026-10-29T10:00:00Z',
        assets: [
          { name: `monitoring-basis-${version}.tar.gz`, url: 'https://api.github.com/asset/1', size: paket?.length ?? 10 },
          { name: `monitoring-basis-${version}.tar.gz.sha256`, url: 'https://api.github.com/asset/2', size: 90 },
        ],
      });
    }
    assert.equal(opt.headers.Accept, 'application/octet-stream');
    if (url.endsWith('/asset/1')) return new Response(paket);
    if (url.endsWith('/asset/2')) return new Response(`${pruefsumme ?? createHash('sha256').update(paket).digest('hex')}  paket.tar.gz\n`);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, aufrufe };
}

function verwaltung(installOrdner, extra = {}) {
  let neugestartet = 0;
  const v = new Updateverwaltung({
    installOrdner, programmOrdner: installOrdner, configDatei: path.join(installOrdner, 'config.json'),
    updates: { repo: 'pfkonsumdigital/Monitoring-Basis', githubToken: 'TOKEN' }, installiert: '0.1.0', viaStarter: true,
    neustart: () => { neugestartet++; }, ...extra,
  });
  return { v, neugestartet: () => neugestartet };
}

test('Versionsvergleich', () => {
  assert.ok(vergleicheVersionen('0.2.0', '0.1.9') > 0);
  assert.ok(vergleicheVersionen('v1.0.0', '0.9.9') > 0);
  assert.ok(vergleicheVersionen('0.10.0', '0.9.0') > 0);
  assert.equal(vergleicheVersionen('1.2.3', 'v1.2.3'), 0);
  assert.throws(() => vergleicheVersionen('1.2', '1.2.3'), /Ungültige Version/);
});

test('Suchen: neues Release wird erkannt, gleiche Version nicht', async () => {
  const ordner = await temp();
  try {
    const { fetchImpl, aufrufe } = fakeGithub({ paket: Buffer.from('x') });
    const { v } = verwaltung(ordner, { fetchImpl });
    const st = await v.suchen();
    assert.equal(aufrufe[0], 'https://api.github.com/repos/pfkonsumdigital/Monitoring-Basis/releases/latest');
    assert.equal(st.verfuegbar.version, '0.2.0');
    assert.equal(st.updateMoeglich, true);
    assert.match(st.verfuegbar.notizen, /Update-Funktion/);
    assert.equal(st.phase, 'bereit');
    const gleich = verwaltung(ordner, { fetchImpl: fakeGithub({ version: '0.1.0', paket: Buffer.from('x') }).fetchImpl, installiert: '0.1.0' }).v;
    assert.equal((await gleich.suchen()).updateMoeglich, false);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Suchen: verständliche Fehler für Token, fehlendes Release und Netzwerk', async () => {
  const ordner = await temp();
  try {
    await assert.rejects(verwaltung(ordner, { fetchImpl: fakeGithub({ status: 401 }).fetchImpl }).v.suchen(), /Token abgelehnt/);
    await assert.rejects(verwaltung(ordner, { fetchImpl: fakeGithub({ status: 404 }).fetchImpl }).v.suchen(), /Kein Release/);
    const offline = verwaltung(ordner, { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }).v;
    await assert.rejects(offline.suchen(), /nicht erreichbar/);
    assert.equal(offline.status().phase, 'fehler');
    await assert.rejects(verwaltung(ordner, { updates: null }).v.suchen(), /nicht eingerichtet/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Installieren: Download, Prüfsumme, Entpacken, Selbsttest, Umschalten, Neustart', async () => {
  const ordner = await temp();
  try {
    const paket = await testPaket(ordner, '0.2.0');
    const { v, neugestartet } = verwaltung(ordner, { fetchImpl: fakeGithub({ paket }).fetchImpl });
    await v.suchen();
    const st = await v.installieren('0.2.0');
    assert.equal(st.phase, 'neustart');
    assert.equal(JSON.parse(await readFile(path.join(ordner, 'versionen', '0.2.0', 'package.json'), 'utf8')).version, '0.2.0');
    assert.deepEqual(await leseAktiv(ordner), { aktiv: 'versionen/0.2.0', vorher: '.', probe: true });
    assert.deepEqual((await readdir(path.join(ordner, 'versionen'))).sort(), ['0.2.0'], 'keine Reste');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(neugestartet(), 1);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Installieren: falsche Prüfsumme oder fehlgeschlagener Selbsttest ändern nichts', async () => {
  const ordner = await temp();
  try {
    const paket = await testPaket(ordner, '0.2.0');
    const falsch = verwaltung(ordner, { fetchImpl: fakeGithub({ paket, pruefsumme: 'a'.repeat(64) }).fetchImpl }).v;
    await falsch.suchen();
    await assert.rejects(falsch.installieren('0.2.0'), /Prüfsumme/);
    assert.equal(falsch.status().phase, 'fehler');

    const kaputt = await testPaket(ordner, '0.3.0', 2);
    const { v, neugestartet } = verwaltung(ordner, { fetchImpl: fakeGithub({ version: '0.3.0', paket: kaputt }).fetchImpl });
    await v.suchen();
    await assert.rejects(v.installieren('0.3.0'), /Selbsttest nicht bestanden: Selbsttest 2/);
    assert.deepEqual(await leseAktiv(ordner), { aktiv: '.', vorher: null, probe: false });
    assert.deepEqual(await readdir(path.join(ordner, 'versionen')), []);
    assert.equal(neugestartet(), 0);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Installieren: nur nach Suche, nur neuere Version, nur über den Starter', async () => {
  const ordner = await temp();
  try {
    const paket = await testPaket(ordner, '0.2.0');
    const { v } = verwaltung(ordner, { fetchImpl: fakeGithub({ paket }).fetchImpl });
    await assert.rejects(v.installieren('0.2.0'), /zuerst nach Updates suchen/);
    await v.suchen();
    await assert.rejects(v.installieren('0.9.9'), /zuerst nach Updates suchen/);
    const alt = verwaltung(ordner, { fetchImpl: fakeGithub({ paket }).fetchImpl, installiert: '0.2.0' }).v;
    await alt.suchen();
    await assert.rejects(alt.installieren('0.2.0'), /nicht neuer/);
    const ohneStarter = verwaltung(ordner, { fetchImpl: fakeGithub({ paket }).fetchImpl, viaStarter: false }).v;
    await ohneStarter.suchen();
    await assert.rejects(ohneStarter.installieren('0.2.0'), /start\.js/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Zurück auf die vorherige Version und Aufräumen alter Versionen', async () => {
  const ordner = await temp();
  try {
    await writeFile(path.join(ordner, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    for (const v of ['0.2.0', '0.3.0', '0.4.0', '0.5.0']) {
      await mkdir(path.join(ordner, 'versionen', v), { recursive: true });
      await writeFile(path.join(ordner, 'versionen', v, 'package.json'), JSON.stringify({ version: v }));
    }
    await mkdir(path.join(ordner, 'versionen', '.neu-rest'));
    await schreibeAktiv(ordner, { aktiv: 'versionen/0.5.0', vorher: 'versionen/0.4.0', probe: false });
    const { v, neugestartet } = verwaltung(ordner, { installiert: '0.5.0' });
    await v.starten();
    assert.deepEqual((await readdir(path.join(ordner, 'versionen'))).sort(), ['0.3.0', '0.4.0', '0.5.0']);
    assert.equal(v.status().vorherige.version, '0.4.0');
    await v.zurueck();
    assert.deepEqual(await leseAktiv(ordner), { aktiv: 'versionen/0.4.0', vorher: 'versionen/0.5.0', probe: false });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(neugestartet(), 1);

    const ohne = verwaltung(await temp()).v;
    await assert.rejects(ohne.zurueck(), /keine vorherige Version/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});
