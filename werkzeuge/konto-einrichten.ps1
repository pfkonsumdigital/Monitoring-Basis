#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Stellt die Monitoring-Basis auf ein eigenes Dienstkonto ohne Administratorrechte um.

.DESCRIPTION
  Einmal als Administrator auf dem Worker ausfuehren. Das Skript
    1. prueft, dass das Konto existiert und KEIN Administrator ist (sonst Abbruch),
    2. setzt die Dateirechte im Installationsordner:
         - Hauptordner: Lesen/Ausfuehren, Dateien anlegen (config.json, aktiv.json, Sicherungen),
           Start.exe und runtime\ bleiben fuer das Konto schreibgeschuetzt,
         - data\ und modules\: nur SYSTEM, Administratoren und das Konto,
         - logs\ und versionen\: Aendern,
         - config.json: nur SYSTEM, Administratoren und das Konto (Benutzer haben keinen Zugriff mehr),
    3. gibt dem Konto das Recht "Als Stapelverarbeitungsauftrag anmelden" (lokale Richtlinie),
    4. erlaubt dem Konto Starten, Beenden und Abfragen der Windows-Dienste FREIGEGEBENER Module,
    5. stellt die Aufgabe "Monitoring-Basis" im Aufgabenplaner auf das Konto um und startet sie neu.
  Mit -Zurueck laeuft die Basis wieder als SYSTEM; Dienst- und Anmelderecht des Kontos werden entfernt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\konto-einrichten.ps1 -Konto 'KONSUM-WEIMAR\svc-monitoring'

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\konto-einrichten.ps1 -Konto 'KONSUM-WEIMAR\svc-monitoring' -Zurueck
#>
[CmdletBinding()]
param(
  [string]$Konto,
  [string]$Installationsordner,
  [switch]$Zurueck,
  [string]$Aufgabe = 'Monitoring-Basis',
  [securestring]$Passwort,
  [int]$WartenSekunden = 90
)

$ErrorActionPreference = 'Stop'
$SID_SYSTEM = 'S-1-5-18'
$SID_ADMINS = 'S-1-5-32-544'
$SID_ERSTELLER = 'S-1-3-0'

function Schritt([string]$text) { Write-Host "-> $text" }
function Hinweis([string]$text) { Write-Host "   $text" }
function Warnung([string]$text) { Write-Warning $text }

function Befehl([string]$programm, [string[]]$argumente) {
  $ausgabe = & $programm @argumente 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$programm $($argumente -join ' ') fehlgeschlagen ($LASTEXITCODE): $($ausgabe -join ' ')" }
  return $ausgabe
}

function Installationsordner-Finden {
  if ($Installationsordner) { return (Resolve-Path $Installationsordner).Path }
  $o = $PSScriptRoot
  while ($o) {
    $hatStarter = (Test-Path (Join-Path $o 'Start.exe')) -or (Test-Path (Join-Path $o 'start.js'))
    if ($hatStarter -and (Test-Path (Join-Path $o 'config.json'))) { return $o }
    $o = Split-Path $o -Parent
  }
  throw 'Installationsordner nicht gefunden (Ordner mit Start.exe und config.json). Bitte mit -Installationsordner angeben.'
}

function Sid-Von([string]$name) {
  try { return (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
  catch { throw "Das Konto '$name' wurde nicht gefunden. Bitte in der Form DOMAENE\name angeben." }
}

# Gruppen des Kontos (auch verschachtelte) als SIDs, aus der Domaene bzw. vom lokalen Rechner.
function Gruppen-Sids([string]$sid) {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement
  $ergebnis = @()
  foreach ($art in @('Domain', 'Machine')) {
    try {
      $kontext = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::$art)
      $p = [System.DirectoryServices.AccountManagement.Principal]::FindByIdentity($kontext, [System.DirectoryServices.AccountManagement.IdentityType]::Sid, $sid)
      if (-not $p) { continue }
      try { $gruppen = $p.GetAuthorizationGroups() } catch { $gruppen = $p.GetGroups() }
      foreach ($g in $gruppen) { if ($g.Sid) { $ergebnis += $g.Sid.Value } }
    } catch { }
  }
  return $ergebnis
}

# Mitglieder der lokalen Gruppe Administratoren (SIDs). Laesst sich die Gruppe nicht lesen: Abbruch (sicherer Zustand).
function Lokale-Admins {
  try { return @(Get-LocalGroupMember -SID $SID_ADMINS | ForEach-Object { $_.SID.Value }) } catch { }
  $name = (New-Object System.Security.Principal.SecurityIdentifier($SID_ADMINS)).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
  foreach ($rechner in @('.', $env:COMPUTERNAME, 'localhost')) {
    try {
      $gruppe = [ADSI]"WinNT://$rechner/$name,group"
      $sids = @()
      foreach ($m in @($gruppe.psbase.Invoke('Members'))) {
        $bytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null)
        $sids += (New-Object System.Security.Principal.SecurityIdentifier($bytes, 0)).Value
      }
      return $sids
    } catch { }
  }
  throw 'Die Mitglieder der lokalen Gruppe Administratoren liessen sich nicht lesen - abgebrochen, nichts geaendert.'
}

function Ist-Admin([string]$sid) {
  $gruppen = @(Gruppen-Sids $sid)
  $lokal = @(Lokale-Admins)
  if ($lokal -contains $sid) { return $true }
  foreach ($g in $gruppen) {
    if ($g -eq $SID_ADMINS -or $lokal -contains $g -or $g -match '^S-1-5-21-\d+-\d+-\d+-(512|518|519)$') { return $true }
  }
  return $false
}

# Recht "Als Stapelverarbeitungsauftrag anmelden" (SeBatchLogonRight) setzen bzw. entfernen.
function Stapelrecht([string]$sid, [bool]$hinzu) {
  $id = [guid]::NewGuid()
  $inf = Join-Path $env:TEMP "mb-rechte-$id.inf"
  $db = Join-Path $env:TEMP "mb-rechte-$id.sdb"
  try {
    Befehl 'secedit.exe' @('/export', '/cfg', $inf, '/areas', 'USER_RIGHTS', '/quiet') | Out-Null
    $zeile = Get-Content $inf | Where-Object { $_ -match '^SeBatchLogonRight\s*=' } | Select-Object -First 1
    $werte = @()
    if ($zeile) { $werte = @(($zeile -split '=', 2)[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $eintrag = "*$sid"
    if ($hinzu) {
      if ($werte -contains $eintrag) { Hinweis 'Recht war schon gesetzt.'; return }
      $werte += $eintrag
    } else {
      if (-not ($werte -contains $eintrag)) { return }
      $werte = @($werte | Where-Object { $_ -ne $eintrag })
    }
    $inhalt = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', "SeBatchLogonRight = $($werte -join ',')")
    Set-Content -Path $inf -Value $inhalt -Encoding Unicode
    Befehl 'secedit.exe' @('/configure', '/db', $db, '/cfg', $inf, '/areas', 'USER_RIGHTS', '/quiet') | Out-Null
  } finally {
    Remove-Item $inf, $db -Force -ErrorAction SilentlyContinue
  }
}

# Dienste freigegebener Module: Fingerabdruck wie in basis\freigabe.js (typ und dienst).
function Freigegebene-Dienste([string]$moduleOrdner, [string]$datenOrdner) {
  $liste = @()
  $freigabeDatei = Join-Path $datenOrdner 'modulfreigaben.json'
  $freigaben = $null
  if (Test-Path $freigabeDatei) { $freigaben = Get-Content $freigabeDatei -Raw -Encoding UTF8 | ConvertFrom-Json }
  if (-not (Test-Path $moduleOrdner)) { return $liste }
  foreach ($ordner in Get-ChildItem $moduleOrdner -Directory) {
    $datei = Join-Path $ordner.FullName 'module.json'
    if (-not (Test-Path $datei)) { continue }
    try { $m = (Get-Content $datei -Raw -Encoding UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { continue }
    if ($m.typ -ne 'eigenstaendig' -or -not $m.dienst) { continue }
    if ($m.dienst -notmatch '^[A-Za-z0-9_.-]{1,256}$') { continue }
    $json = '{"typ":"eigenstaendig","dienst":"' + $m.dienst + '"}'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $wert = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($json)) | ForEach-Object { $_.ToString('x2') })
    $id = $ordner.Name
    $freigegeben = $freigaben -and $freigaben.module -and $freigaben.module.$id -and $freigaben.module.$id.wert -eq $wert
    if ($freigegeben) { $liste += $m.dienst }
    else { Warnung "Modul '$id' (Dienst '$($m.dienst)') ist nicht freigegeben - keine Dienstrechte. Erst in der Oberflaeche freigeben, dann dieses Skript erneut ausfuehren." }
  }
  return $liste
}

function Dienstrecht([string]$dienst, [string]$sid, [bool]$hinzu) {
  $alt = (& sc.exe sdshow $dienst 2>&1) -join ''
  if ($LASTEXITCODE -ne 0) { Warnung "Dienst '$dienst' nicht gefunden - uebersprungen."; return }
  $alt = $alt.Trim()
  $ohne = [regex]::Replace($alt, '\(A;;[A-Z]*;;;' + [regex]::Escape($sid) + '\)', '')
  $neu = $ohne
  if ($hinzu) {
    # CC Konfiguration lesen, LC Status abfragen, LO abfragen, RP starten, WP beenden, RC Rechte lesen.
    $ace = "(A;;CCLCLORPWPRC;;;$sid)"
    $i = $ohne.IndexOf('S:')
    if ($i -ge 0) { $neu = $ohne.Insert($i, $ace) } else { $neu = $ohne + $ace }
  }
  if ($neu -eq $alt) { return }
  Befehl 'sc.exe' @('sdset', $dienst, $neu) | Out-Null
  if ($hinzu) { Hinweis "Dienst '$dienst': Starten/Beenden erlaubt." } else { Hinweis "Dienst '$dienst': Rechte entfernt." }
}

function Basis-Anhalten([string]$root) {
  Stop-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
  $pidDatei = Join-Path $root 'starter.pid'
  if (Test-Path $pidDatei) {
    $starterPid = (Get-Content $pidDatei -Raw).Trim()
    if ($starterPid -match '^\d+$' -and (Get-Process -Id $starterPid -ErrorAction SilentlyContinue)) {
      & taskkill.exe /PID $starterPid /T /F 2>&1 | Out-Null
      Start-Sleep -Seconds 2
    }
    Remove-Item $pidDatei -Force -ErrorAction SilentlyContinue
  }
}

function Basis-Pruefen([string]$root, [int]$port, [string]$erwartet) {
  if ($WartenSekunden -le 0) { return }
  $ende = (Get-Date).AddSeconds($WartenSekunden)
  while ((Get-Date) -lt $ende) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { if ($client.ConnectAsync('127.0.0.1', $port).Wait(1000) -and $client.Connected) { break } } catch { } finally { $client.Dispose() }
    Start-Sleep -Seconds 2
  }
  # Nur die Basis selbst (start.js und basis\main.js), nicht die Prozesse von Modulen im Installationsordner.
  $prozesse = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $c = [string]$_.CommandLine
    ($c -match '(?i)(^|[\\/"\s])start\.js("|\s|$)' -or ($c -like "*$root*" -and $c -match '(?i)[\\/]basis[\\/]main\.js')) -and $c -notmatch '(?i)[\\/]modules[\\/]'
  })
  $konten = @($prozesse | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; "$($o.Domain)\$($o.User)" } | Sort-Object -Unique)
  if (-not $prozesse) { Warnung "Die Basis laeuft nach $WartenSekunden s nicht. Bitte logs\fehler.log und logs\starter-ausgabe.log pruefen." ; return }
  Hinweis "Basis laeuft unter: $($konten -join ', ')"
  if ($erwartet -and -not ($konten | Where-Object { $_ -ieq $erwartet })) { Warnung "Erwartet war $erwartet." }
}

# ---------------------------------------------------------------------------------------------

$root = Installationsordner-Finden
$configDatei = Join-Path $root 'config.json'
$config = (Get-Content $configDatei -Raw -Encoding UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
$moduleOrdner = Join-Path $root $(if ($config.module_ordner) { $config.module_ordner } else { 'modules' })
$datenOrdner = Join-Path $root $(if ($config.daten_ordner) { $config.daten_ordner } else { 'data' })
$port = $(if ($config.port) { [int]$config.port } else { 8443 })
Write-Host "Installationsordner: $root"

if ($Zurueck) {
  Schritt 'Aufgabe zurueck auf SYSTEM'
  $task = Get-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
  if (-not $task) { throw "Aufgabe '$Aufgabe' nicht gefunden. Autostart mit 'Start.exe --autostart' einrichten." }
  Basis-Anhalten $root
  $task.Principal = New-ScheduledTaskPrincipal -UserId $SID_SYSTEM -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $Aufgabe -InputObject $task -Force | Out-Null
  if ($Konto) {
    $sid = Sid-Von $Konto
    Schritt 'Dienstrechte und Anmelderecht des Kontos entfernen'
    foreach ($d in Freigegebene-Dienste $moduleOrdner $datenOrdner) { Dienstrecht $d $sid $false }
    Stapelrecht $sid $false
  }
  Start-ScheduledTask -TaskName $Aufgabe
  Basis-Pruefen $root $port $null
  Write-Host 'Fertig: Die Basis laeuft wieder als SYSTEM.'
  exit 0
}

if (-not $Konto) { $Konto = Read-Host 'Konto (DOMAENE\name)' }
$sid = Sid-Von $Konto
if (@($SID_SYSTEM, 'S-1-5-19', 'S-1-5-20') -contains $sid) { throw 'Bitte ein eigenes Benutzerkonto angeben, kein Systemkonto.' }
Schritt "Konto $Konto ($sid) pruefen"
if (Ist-Admin $sid) { throw "Das Konto $Konto hat Administratorrechte (lokale Administratoren oder Domaenen-Admins). Bitte ein Konto ohne Admin-Rechte verwenden - abgebrochen, nichts geaendert." }
Hinweis 'Kein Administrator - gut.'

Schritt 'Dateirechte setzen'
# Hauptordner: nur SYSTEM, Administratoren und das Konto. Das Konto darf lesen/ausfuehren und Dateien anlegen;
# eigene Dateien (Ersteller-Besitzer) darf es aendern. Start.exe und runtime\ bleiben fuer das Konto schreibgeschuetzt.
Befehl 'icacls.exe' @($root, '/inheritance:r', '/grant:r', "*${SID_SYSTEM}:(OI)(CI)F", "*${SID_ADMINS}:(OI)(CI)F", "*${sid}:(OI)(CI)RX", "*${SID_ERSTELLER}:(OI)(CI)(IO)M", '/Q') | Out-Null
Befehl 'icacls.exe' @($root, '/grant', "*${sid}:(WD,AD)", '/Q') | Out-Null
foreach ($muster in @('config.json*', 'aktiv.json*', 'starter.pid')) {
  foreach ($datei in Get-ChildItem $root -File -Filter $muster -ErrorAction SilentlyContinue) {
    Befehl 'icacls.exe' @($datei.FullName, '/grant', "*${sid}:M", '/Q') | Out-Null
  }
}
foreach ($o in @($datenOrdner, $moduleOrdner)) {
  if (-not (Test-Path $o)) { New-Item -ItemType Directory -Path $o | Out-Null }
  Befehl 'icacls.exe' @($o, '/inheritance:r', '/grant:r', "*${SID_SYSTEM}:(OI)(CI)F", "*${SID_ADMINS}:(OI)(CI)F", "*${sid}:(OI)(CI)F", '/Q') | Out-Null
  if (Get-ChildItem $o -Force) { Befehl 'icacls.exe' @((Join-Path $o '*'), '/reset', '/T', '/C', '/Q') | Out-Null }
  Hinweis "$o : SYSTEM, Administratoren, $Konto"
}
foreach ($o in @((Join-Path $root 'logs'), (Join-Path $root 'versionen'))) {
  if (-not (Test-Path $o)) { New-Item -ItemType Directory -Path $o | Out-Null }
  Befehl 'icacls.exe' @($o, '/grant', "*${sid}:(OI)(CI)M", '/Q') | Out-Null
  Hinweis "$o : Aendern fuer $Konto"
}

Schritt 'Recht "Als Stapelverarbeitungsauftrag anmelden"'
Stapelrecht $sid $true
Hinweis 'Legt eine Gruppenrichtlinie dieses Recht fest, ueberschreibt sie die lokale Einstellung - dann das Konto dort eintragen.'

Schritt 'Dienste freigegebener Module'
$dienste = @(Freigegebene-Dienste $moduleOrdner $datenOrdner)
if (-not $dienste) { Hinweis 'Keine (spaeter neues Modul mit Dienst: Skript erneut ausfuehren).' }
foreach ($d in $dienste) { Dienstrecht $d $sid $true }

Schritt "Aufgabe '$Aufgabe' auf $Konto umstellen"
$task = Get-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
if (-not $task) { throw "Aufgabe '$Aufgabe' nicht gefunden. Zuerst 'Start.exe --autostart' ausfuehren, dann dieses Skript erneut." }
if (-not $Passwort) { $Passwort = Read-Host "Passwort von $Konto" -AsSecureString }
$zeiger = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Passwort)
try {
  $klartext = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($zeiger)
  Basis-Anhalten $root
  $task.Principal = New-ScheduledTaskPrincipal -UserId $Konto -LogonType Password -RunLevel Limited
  Register-ScheduledTask -TaskName $Aufgabe -InputObject $task -User $Konto -Password $klartext -Force | Out-Null
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($zeiger)
  $klartext = $null
}
Start-ScheduledTask -TaskName $Aufgabe
Basis-Pruefen $root $port $Konto
Write-Host ''
Write-Host "Fertig: Die Basis laeuft unter $Konto. Einstellungen -> System zeigt das Konto."
Write-Host "Hinweis: 'Start.exe --autostart' stellt die Aufgabe wieder auf SYSTEM - danach dieses Skript erneut ausfuehren."
