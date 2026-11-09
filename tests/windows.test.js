import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { befehlAusfuehren, eigeneSid, ohneModulpfad, powershellPfad, rechteSetzen, SCHLUESSEL_DATEI, Tresor } from '../basis/geheimnis.js';

// Läuft nur unter Windows (GitHub Actions: Job „windows“). Prüft die echte DPAPI und icacls.
const nurWindows = { skip: process.platform !== 'win32' && 'nur unter Windows' };

test('DPAPI: verschlüsseln und öffnen (Basis und Module), falsche Schlüsseldatei', nurWindows, async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-dpapi-'));
  try {
    const t = new Tresor({ datenOrdner: ordner });
    assert.equal(t.verfuegbar, true);
    const werte = ['github_pat_11ABCDEF0123456789', 'Ümlaute ß € "Anführung" \\ Pfad', 'x'.repeat(500)];
    const zu = await t.schuetzen(werte, 'basis');
    for (const z of zu) assert.match(z, /^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/);
    const [einer] = await t.schuetzen(['einzeln'], 'modul');
    assert.match(einer, /^dpapi:m1:/);
    // Neuer Tresor ohne Zwischenspeicher: echter Aufruf.
    const t2 = new Tresor({ datenOrdner: ordner });
    assert.deepEqual(await t2.oeffnen([...zu, einer, 'klartext']), [...werte, 'einzeln', 'klartext']);
    // Ein Modul öffnet seine Werte ohne die Schlüsseldatei der Basis.
    assert.equal(await new Tresor({ datenOrdner: path.join(ordner, 'anders') }).einzeln(einer), 'einzeln');
    // Andere Schlüsseldatei → DPAPI lehnt ab.
    const anders = path.join(ordner, 'anders');
    await mkdir(anders, { recursive: true });
    await writeFile(path.join(anders, SCHLUESSEL_DATEI), Buffer.alloc(32, 1).toString('base64'));
    await assert.rejects(new Tresor({ datenOrdner: anders }).oeffnen([zu[0]]), /passt nicht|DPAPI/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Dateirechte: nur SYSTEM, Administratoren und das eigene Konto', nurWindows, async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-acl-'));
  try {
    await mkdir(path.join(ordner, 'unter'));
    await writeFile(path.join(ordner, 'unter', 'datei.json'), '{}');
    const ausfuehren = befehlAusfuehren();
    const sid = await eigeneSid(ausfuehren);
    assert.match(sid, /^S-1-5-/);
    const r = await rechteSetzen([ordner], { ausfuehren, sid });
    assert.deepEqual(r.fehler, []);
    // Rechte über .NET lesen (ohne Get-Acl, dessen Modul in manchen Umgebungen nicht lädt), als SIDs.
    const sids = (pfad) => [...new Set(execFileSync(powershellPfad(), ['-NoProfile', '-Command',
      `$p = '${pfad}'; if ([IO.Directory]::Exists($p)) { $i = New-Object IO.DirectoryInfo $p } else { $i = New-Object IO.FileInfo $p }; ` +
      '$i.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }'],
    { encoding: 'utf8', env: ohneModulpfad(process.env) }).split(/\r?\n/).map((z) => z.trim()).filter(Boolean))].sort();
    const erwartet = [...new Set(['S-1-5-18', 'S-1-5-32-544', sid])].sort();
    assert.deepEqual(sids(ordner), erwartet);
    assert.deepEqual(sids(path.join(ordner, 'unter', 'datei.json')), erwartet, 'Unterordner und Dateien erben');
    assert.ok(!sids(ordner).includes('S-1-5-32-545'), 'keine normalen Benutzer');
    // Leerer Ordner: kein Fehler.
    const leer = path.join(ordner, 'leer');
    await mkdir(leer);
    assert.deepEqual((await rechteSetzen([leer], { ausfuehren, sid })).fehler, []);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Modul-Freigabe unter Windows: Junction und Verknüpfung erkannt, Groß-/Kleinschreibung, Rechnername', nurWindows, async () => {
  const { fingerabdruck } = await import('../basis/freigabe.js');
  const { hostPruefer } = await import('../basis/webserver.js');
  const os = await import('node:os');
  const { symlink } = await import('node:fs/promises');
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-fgwin-'));
  try {
    const ordner = path.join(wurzel, 'modules', 'prog');
    await mkdir(path.join(ordner, 'lib'), { recursive: true });
    await writeFile(path.join(ordner, 'pruefe.exe'), 'MZ');
    const extern = path.join(wurzel, 'Werkzeuge');
    await mkdir(extern);
    await writeFile(path.join(extern, 'python.exe'), 'PY');
    const m = { id: 'prog', typ: 'programm', ordner, befehl: 'python', argumente: [], arbeitsordner: extern };
    const a = await fingerabdruck(m);
    assert.deepEqual(Object.keys(a.angaben.extern), [path.join(extern, 'python.exe')], 'Programmsuche im Arbeitsordner');
    assert.deepEqual(Object.keys(a.angaben.dateien), ['pruefe.exe']);
    // Arbeitsordner im Modulordner, nur anders geschrieben: zählt als innen.
    const innen = await fingerabdruck({ ...m, befehl: path.join(ordner.toUpperCase(), 'PRUEFE.EXE'), arbeitsordner: ordner.toUpperCase() });
    assert.deepEqual(innen.angaben.extern, {});
    assert.equal(innen.angaben.arbeitsordner, '.');
    // Junction (geht ohne Sonderrechte) und Datei-Verknüpfung werden abgelehnt.
    await symlink(extern, path.join(ordner, 'lib', 'verbindung'), 'junction');
    assert.match((await fingerabdruck(m)).fehler, /Verknüpfung \(lib\/verbindung\)/);
    await rm(path.join(ordner, 'lib', 'verbindung'));
    assert.equal((await fingerabdruck(m)).wert, a.wert);
    assert.equal(hostPruefer({ adressen: () => [] })(os.hostname().toLowerCase()), true, 'Rechnername erlaubt');
  } finally {
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Dienstkonto einrichten (werkzeuge\\konto-einrichten.ps1): Abbruch bei Admin, Rechte, Dienstrechte nur für freigegebene Module, Aufgabe, zurück', nurWindows, async () => {
  const { randomBytes, createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { readFile: lesen } = await import('node:fs/promises');
  const skript = path.resolve('werkzeuge', 'konto-einrichten.ps1');
  const id = randomBytes(3).toString('hex');
  const svc = `mbsvc${id}`;
  const adm = `mbadm${id}`;
  const pw = `Mb!${randomBytes(10).toString('hex')}Aa9`;
  const aufgabe = `MB-Test-${id}`;
  const dienst = `MBTest${id}`;
  const fremd = `MBBoese${id}`;
  // Nicht im Benutzerprofil: dorthin dürfte das Testkonto nicht einmal durchgehen.
  const wurzel = path.join(`${process.env.SystemDrive}\\`, `mb-konto-${id}`);
  // Windows PowerShell 5.1 ohne den PSModulePath von PowerShell 7 (GitHub Actions), sonst laden Module wie
  // Microsoft.PowerShell.Security nicht (ConvertTo-SecureString fehlt).
  const umgebung = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  const ps = (befehl) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', befehl], { encoding: 'utf8', env: umgebung });
  const pruefe = (r) => { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r.stdout; };
  // Kontoname so, wie Windows ihn auflöst (RECHNER\name) – COMPUTERNAME weicht auf Testrechnern teils ab.
  const ntName = (konto) => pruefe(ps(`(Get-LocalUser '${konto}').SID.Translate([System.Security.Principal.NTAccount]).Value`)).trim();
  const einrichten = (konto, extra = '') => ps(`& '${skript}' -Konto '${ntName(konto)}' -Passwort (ConvertTo-SecureString '${pw}' -AsPlainText -Force) -Installationsordner '${wurzel}' -Aufgabe '${aufgabe}' -WartenSekunden 0 ${extra}`);
  const sidVon = (konto) => pruefe(ps(`(Get-LocalUser '${konto}').SID.Value`)).trim();
  const sdshow = (name) => execFileSync('sc.exe', ['sdshow', name], { encoding: 'utf8' });
  const kontoDerAufgabe = () => pruefe(ps(`(Get-ScheduledTask -TaskName '${aufgabe}').Principal.UserId`)).trim();
  try {
    // Installationsordner wie auf dem Worker (Start.exe und node.exe als Platzhalter).
    for (const o of ['data', 'modules\\ftp', 'modules\\boese', 'logs', 'runtime']) await mkdir(path.join(wurzel, o), { recursive: true });
    await writeFile(path.join(wurzel, 'config.json'), JSON.stringify({ port: 18999, tls: { modus: 'aus' } }));
    await writeFile(path.join(wurzel, 'Start.exe'), 'MZ-platzhalter');
    await writeFile(path.join(wurzel, 'start.js'), '// platzhalter');
    await writeFile(path.join(wurzel, 'runtime', 'node.exe'), 'MZ-platzhalter');
    await writeFile(path.join(wurzel, 'modules', 'ftp', 'module.json'), JSON.stringify({ id: 'ftp', name: 'FTP', typ: 'eigenstaendig', dienst }));
    await writeFile(path.join(wurzel, 'modules', 'boese', 'module.json'), JSON.stringify({ id: 'boese', name: 'Böse', typ: 'eigenstaendig', dienst: fremd }));
    const wert = createHash('sha256').update(JSON.stringify({ typ: 'eigenstaendig', dienst })).digest('hex');
    await writeFile(path.join(wurzel, 'data', 'modulfreigaben.json'), JSON.stringify({ version: 1, module: { ftp: { wert, angaben: { typ: 'eigenstaendig', dienst } } } }));
    // Prüfskript: läuft als Aufgabe unter dem Testkonto und versucht, was die Basis darf und was nicht.
    await writeFile(path.join(wurzel, 'probe.ps1'), `$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$r = [ordered]@{ konto = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Teste($name, [scriptblock]$b) { try { & $b; $r[$name] = 'ok' } catch { $r[$name] = 'verweigert' } }
Teste 'data' { Set-Content "$root\\data\\p.txt" 'x'; Remove-Item "$root\\data\\p.txt" }
Teste 'modules' { Set-Content "$root\\modules\\ftp\\p.txt" 'x'; Remove-Item "$root\\modules\\ftp\\p.txt" }
Teste 'logs' { Set-Content "$root\\logs\\p.txt" 'x'; Remove-Item "$root\\logs\\p.txt" }
Teste 'versionen' { New-Item -ItemType Directory "$root\\versionen\\neu" | Out-Null; Remove-Item "$root\\versionen\\neu" }
Teste 'wurzelNeu' { Set-Content "$root\\neu.tmp" 'x'; Remove-Item "$root\\neu.tmp" }
Teste 'configOeffnen' { [IO.File]::Open("$root\\config.json", 'Open', 'ReadWrite').Close() }
Teste 'configErsetzen' { Set-Content "$root\\config.json.t.tmp" (Get-Content "$root\\config.json" -Raw); [IO.File]::Delete("$root\\config.json"); [IO.File]::Move("$root\\config.json.t.tmp", "$root\\config.json") }
Teste 'startExeSchreiben' { [IO.File]::Open("$root\\Start.exe", 'Open', 'ReadWrite').Close() }
Teste 'startExeLoeschen' { [IO.File]::Delete("$root\\Start.exe") }
Teste 'startExeUmbenennen' { [IO.File]::Move("$root\\Start.exe", "$root\\x.exe") }
Teste 'runtimeNeu' { Set-Content "$root\\runtime\\neu.dll" 'x' }
Teste 'nodeSchreiben' { [IO.File]::Open("$root\\runtime\\node.exe", 'Open', 'ReadWrite').Close() }
$r | ConvertTo-Json | Set-Content "$root\\data\\probe.json"
`);
    // Fehler beim Anlegen sofort sichtbar machen (sonst nur auf stderr und Exitcode 0).
    pruefe(ps(`$ErrorActionPreference = 'Stop'
New-LocalUser -Name '${svc}' -Password (ConvertTo-SecureString '${pw}' -AsPlainText -Force) -PasswordNeverExpires | Out-Null
New-LocalUser -Name '${adm}' -Password (ConvertTo-SecureString '${pw}' -AsPlainText -Force) -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-544' -Member '${adm}'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${wurzel}\\probe.ps1"'
Register-ScheduledTask -TaskName '${aufgabe}' -Action $a -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest) | Out-Null`));
    for (const name of [dienst, fremd]) execFileSync('sc.exe', ['create', name, 'binPath=', 'C:\\Windows\\System32\\cmd.exe /c exit 0', 'start=', 'demand'], { stdio: 'ignore' });
    const svcSid = sidVon(svc);

    // 1. Konto mit Admin-Rechten: Abbruch, nichts geändert.
    const abbruch = einrichten(adm);
    assert.notEqual(abbruch.status, 0);
    assert.match(`${abbruch.stdout}${abbruch.stderr}`, /Administratorrechte/);
    assert.match(kontoDerAufgabe(), /SYSTEM|S-1-5-18/);
    assert.doesNotMatch(sdshow(dienst), new RegExp(sidVon(adm)));

    // 2. Dienstkonto: Rechte, Dienstrecht nur für das freigegebene Modul, Aufgabe läuft unter dem Konto.
    const lauf = einrichten(svc);
    pruefe(lauf);
    assert.match(lauf.stdout, /Kein Administrator/);
    assert.match(`${lauf.stdout}${lauf.stderr}`, /Modul 'boese'.*nicht freigegeben/);
    assert.match(sdshow(dienst), new RegExp(`\\(A;;CCLCLORPWPRC;;;${svcSid}\\)`));
    assert.doesNotMatch(sdshow(fremd), new RegExp(svcSid), 'nicht freigegebenes Modul: Dienst unberührt');
    assert.match(kontoDerAufgabe(), new RegExp(`${svc}$`, 'i'));
    let probe = null;
    for (let i = 0; i < 60 && !probe; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { probe = JSON.parse((await lesen(path.join(wurzel, 'data', 'probe.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { probe = null; }
    }
    assert.ok(probe, 'Prüfskript lief nicht unter dem Konto (Anmelderecht als Stapelverarbeitung?)');
    assert.match(probe.konto, new RegExp(`\\\\${svc}$`, 'i'));
    for (const k of ['data', 'modules', 'logs', 'versionen', 'wurzelNeu', 'configOeffnen', 'configErsetzen']) assert.equal(probe[k], 'ok', k);
    for (const k of ['startExeSchreiben', 'startExeLoeschen', 'startExeUmbenennen', 'runtimeNeu', 'nodeSchreiben']) assert.equal(probe[k], 'verweigert', k);
    // Erneut ausführen ändert nichts Doppeltes.
    pruefe(einrichten(svc));
    assert.equal(sdshow(dienst).split(svcSid).length - 1, 1, 'Dienstrecht nur einmal');

    // 3. Zurück auf SYSTEM: Dienstrecht entfernt.
    pruefe(einrichten(svc, '-Zurueck'));
    assert.match(kontoDerAufgabe(), /SYSTEM|S-1-5-18/);
    assert.doesNotMatch(sdshow(dienst), new RegExp(svcSid));
  } finally {
    ps(`Unregister-ScheduledTask -TaskName '${aufgabe}' -Confirm:$false -ErrorAction SilentlyContinue; Remove-LocalUser -Name '${svc}' -ErrorAction SilentlyContinue; Remove-LocalUser -Name '${adm}' -ErrorAction SilentlyContinue`);
    for (const name of [dienst, fremd]) spawnSync('sc.exe', ['delete', name]);
    await rm(wurzel, { recursive: true, force: true });
  }
});
