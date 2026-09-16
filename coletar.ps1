$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$mutex = New-Object Threading.Mutex($false, 'Local\TecnoperfilQualidadeColeta')
try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
if (-not $locked) { Write-Output 'Coleta ja em andamento.'; exit 0 }
$dataDir = Join-Path $base 'dados'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
$found = @()
foreach ($store in $ns.Stores) {
  if ($store.DisplayName -notlike 'pcp@tecnoperfilaluminio.com*') { continue }
  $root = $store.GetRootFolder()
  try { $found += $root.Folders.Item('Caixa de Entrada').Folders.Item('Testes Qualidade') } catch {}
}
if ($found.Count -ne 1) { throw "Encontradas $($found.Count) pastas Testes Qualidade. Configure uma conta unica antes de coletar." }
$folder = $found[0]
$records = @(); $warnings = @(); $skipped = 0
$old = @{}
$jsonPath = Join-Path $dataDir 'testes.json'
if (Test-Path $jsonPath) { foreach ($r in (Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).records) { $old[$r.id] = $r } }
foreach ($mail in $folder.Items) {
  if ($mail.Class -ne 43 -or $mail.Subject -notmatch '^TESTE\b') { $skipped++; continue }
  $id = $null
  try {
    $hash = [Security.Cryptography.SHA256]::Create()
    $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder.StoreID + $mail.EntryID)))).Replace('-','').ToLower()
    $hash.Dispose()
    $subject = [string]$mail.Subject
    $body = ([string]$mail.Body).Trim()
    $normalized = $subject.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
    $tool = ''; $seq = ''; $test = ''; $date = $null
    if ($normalized -match '(?i)^TESTE\s+([A-Z0-9]+-\d+[A-Z]*)') { $tool = $Matches[1].ToUpper() }
    if ($normalized -match '(?i)SEQ[.\s:-]*(\d+)') { $seq = $Matches[1].PadLeft(2,'0') }
    if ($normalized -match '(?i)TESTE\s+(\d+)\s*$') { $test = $Matches[1] }
    $topBody = ($body -split '(?im)^\s*(De:|From:|Enviada em:)')[0]
    $statuses = @([regex]::Matches($topBody, '(?i)\bDimensional\s+(APROVADO|REPROVADO)\b') | ForEach-Object { $_.Groups[1].Value.ToUpper() } | Select-Object -Unique)
    $status = 'REVISAR'
    if ($statuses.Count -eq 1) { $status = $statuses[0] }
    if ($topBody -match '\b(\d{2}/\d{2}/\d{4})\b') {
      $parsed = [datetime]::MinValue
      if ([datetime]::TryParseExact($Matches[1], 'dd/MM/yyyy', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)) { $date = $parsed.ToString('yyyy-MM-dd') }
    }
    $comment = ($topBody -split '(?im)^\s*(Qualquer d[uú]vida|Grato[,!]?|Atenciosamente)')[0]
    $comment = ($comment -replace '(\r?\n\s*){3,}', "`r`n`r`n").Trim()
    $attachments = @()
    for ($i=1; $i -le $mail.Attachments.Count; $i++) {
      $a = $mail.Attachments.Item($i)
      $name = [IO.Path]::GetFileName([string]$a.FileName) -replace '[<>:"/\\|?*\x00-\x1F]', '_'
      if ([IO.Path]::GetExtension($name) -notmatch '^(?i)\.(xlsx|xls|xlsm|xlsb|csv|pdf)$') { continue }
      $inline = $false
      try { $inline = [bool]$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x7FFE000B') } catch {}
      if ($inline) { continue }
      $dir = Join-Path $base ('anexos/' + $id)
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $relative = 'anexos/' + $id + '/' + $i + '-' + $name
      $dest = Join-Path $base $relative
      $a.SaveAsFile($dest)
      $attachments += @{name=$name; path=$relative; size=$a.Size}
    }
    $records += @{id=$id; tool=$tool; sequence=$seq; test=$test; testDate=$date; received=$mail.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss'); status=$status; subject=$subject; comment=$comment; body=$body; sender=[string]$mail.SenderName; attachments=@($attachments)}
  } catch {
    $warnings += "Falha ao importar '$($mail.Subject)': $($_.Exception.Message)"
    if ($id -and $old.ContainsKey($id)) { $records += $old[$id] }
  }
}
# Preserve previously imported history even if mail is moved out of the source folder.
$seen = @{}; foreach ($r in $records) { $seen[$r.id] = $true }
foreach ($id in $old.Keys) { if (-not $seen.ContainsKey($id)) { $records += $old[$id] } }
$result = @{updatedAt=(Get-Date).ToString('o'); source=$folder.FolderPath; skipped=$skipped; warnings=@($warnings); records=@($records | Sort-Object received -Descending)}
$temp = Join-Path $dataDir 'testes.tmp'
[IO.File]::WriteAllText($temp, ($result | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temp -Destination $jsonPath -Force
Write-Output "Importados $($records.Count) registros; $($warnings.Count) avisos."
