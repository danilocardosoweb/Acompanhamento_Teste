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
$fepFolder = $null
foreach ($store in $ns.Stores) {
  if ($store.DisplayName -notlike 'pcp@tecnoperfilaluminio.com*') { continue }
  $root = $store.GetRootFolder()
  foreach ($name in @('Chamada FEP','FEP')) {
    try { $candidate = $root.Folders.Item('Caixa de Entrada').Folders.Item($name); if ($candidate) { $fepFolder = $candidate; break } } catch {}
  }
  if ($fepFolder) { break }
}
$records = @(); $warnings = @(); $skipped = 0; $newCount = 0
$fepRecords = @(); $fepWarnings = @(); $fepNewCount = 0
$old = @{}
$oldFep = @{}
$fepParserVersion = 5
$jsonPath = Join-Path $dataDir 'testes.json'
if (Test-Path $jsonPath) {
  $stored = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($r in @($stored.records)) { $old[$r.id] = $r }
  foreach ($r in @($stored.fepRecords)) { if ($r.id) { $oldFep[$r.id] = $r } }
}
$statePath = Join-Path $dataDir 'coleta-state.json'
$lastReceived = $null
$fepLastReceived = $null
if (Test-Path $statePath) {
  try { $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json; $lastReceived = [datetime]$state.lastReceived; if ($state.fepParserVersion -eq $fepParserVersion -and $state.fepLastReceived) { $fepLastReceived = [datetime]$state.fepLastReceived } else { $oldFep=@{} } } catch {}
}
if (-not $lastReceived -and $old.Count) {
  $lastReceived = [datetime](($old.Values | Sort-Object {[datetime]$_.received} -Descending | Select-Object -First 1).received)
}
$fepDates = @($oldFep.Values | Where-Object { $_.received } | Sort-Object {[datetime]$_.received} -Descending)
if (-not $fepLastReceived -and $fepDates.Count) { $fepLastReceived = [datetime]$fepDates[0].received }
$items = $folder.Items
if ($lastReceived) {
  # Revisit a short window so delayed Outlook synchronization cannot create gaps.
  $since = $lastReceived.AddHours(-48).ToString('MM/dd/yyyy HH:mm',[Globalization.CultureInfo]::InvariantCulture)
  $items = $items.Restrict("[ReceivedTime] >= '$since'")
}
$items.Sort('[ReceivedTime]', $true)
foreach ($mail in $items) {
  if ($mail.Class -ne 43 -or $mail.Subject -notmatch '^TESTE\b') { $skipped++; continue }
  $id = $null
  try {
    $hash = [Security.Cryptography.SHA256]::Create()
    $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder.StoreID + $mail.EntryID)))).Replace('-','').ToLower()
    $hash.Dispose()
    # The overlap is intentional; the stable Outlook ID prevents re-reading an imported message.
    if ($old.ContainsKey($id)) { continue }
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
    # SenderName is deliberately not read: Outlook treats it as protected address data
    # and may display one security prompt for every message.
    $records += @{id=$id; tool=$tool; sequence=$seq; test=$test; testDate=$date; received=$mail.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss'); status=$status; subject=$subject; comment=$comment; body=$body; sender=''; attachments=@($attachments)}
    $newCount++
  } catch {
    $warnings += "Falha ao importar '$($mail.Subject)': $($_.Exception.Message)"
    if ($id -and $old.ContainsKey($id)) { $records += $old[$id] }
  }
}
# A pasta FEP possui mensagens livres e tabelas com formatos variados. O parser
# usa palavras-chave, códigos de ferramenta e guarda a evidência para revisão.
function Normalize-FepText([string]$value) {
  if (-not $value) { return '' }
  return (($value.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', '') -replace '\s+', ' ').Trim().ToLowerInvariant()
}
function Hash-FepId([string]$value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLower() } finally { $hash.Dispose() }
}
function Get-FepTools([string]$value) {
  $seen = @{}
  $patterns = @('(?i)\b[A-Z0-9]{1,8}[-\s][A-Z0-9]{1,6}(?:[/-]\d{1,3})?\b','(?i)\b[A-Z]{1,6}\d{1,5}[/-]\d{1,3}\b')
  foreach ($pattern in $patterns) {
    foreach ($match in [regex]::Matches($value, $pattern)) {
      $raw = $match.Value.Trim() -replace '\s+', '-'
      $parts = $raw -split '[-/]'
      if ($parts.Count -lt 2) { continue }
      $sequence = $null
      if ($parts[-1] -match '^\d{1,3}$') { $sequence = [int]$parts[-1]; $base = ($parts[0..($parts.Count-2)] -join '-') } else { $base = $raw }
      if ($base -notmatch '^[A-Z]' -or $base -notmatch '\d' -or $base.Length -lt 4 -or $base -match '^(COM|DATA|STATUS|CLIENTE|PEDIDO|HTTP|EMAIL)(?:-|$)') { continue }
      $key = "$($base.ToUpperInvariant())|$sequence"
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      [pscustomobject]@{raw=$match.Value.Trim();tool=$base.ToUpperInvariant();sequence=$sequence}
    }
  }
}
function Get-FepClassification([string]$subject,[string]$body) {
  $text = Normalize-FepText "$subject $body"
  $state = 'REVISAR'; $confidence = 'baixa'; $score = 0; $reason = 'Nenhum padrão conclusivo encontrado.'
  if ($text -match 'cheg(?:ou|aram|aram-se)?\s+(?:da|a)\s+fep|chegou\s+a\s+pouco\s+da\s+soda|ferramentas?\s+que\s+chegaram') { $state='CHEGOU_DA_FEP'; $score+=4; $reason='Mensagem informa a chegada da ferramenta à FEP.' }
  if ($text -match 'disponivel\s+(?:para|p/|a)\s+(?:ser\s+)?(?:colet|retir)|pront[ao]s?\s+para\s+(?:coleta|retirada)|pode(?:m)?\s+ser\s+(?:colet|retir)|liberad[ao]s?\s+para\s+(?:coleta|retirada)') { $state='DISPONIVEL_PARA_COLETA'; $score+=5; $reason='Mensagem informa que a ferramenta está disponível para retirada.' }
  elseif ($text -match 'vamos\s+(?:realizar|fazer)|teremos\s+carro|carro\s+passando|passando\s+(?:hoje|amanha|a\s+tarde)|coleta\s+confirmada') { $state='COLETA_PROGRAMADA'; $score+=3; $reason='Mensagem indica uma coleta programada ou em andamento.' }
  if ($text -match '\bem\s+(?:servico|correcao)\b|status\s+ferramenta\s+em\s+servico') { $state='EM_SERVICO'; $score+=3; $reason='Mensagem informa que a ferramenta ainda está em serviço.' }
  if ($text -match 'data\s+de\s+retorno|retorno\s+(?:previsto|programado)|previs[aã]o\s+de\s+retorno') { if ($state -eq 'REVISAR') { $state='RETORNO_PREVISTO' }; $score+=2; if ($state -eq 'RETORNO_PREVISTO') { $reason='Mensagem informa uma previsão de retorno.' } }
  if ($score -ge 5) { $confidence='alta' } elseif ($score -ge 3) { $confidence='media' }
  [pscustomobject]@{state=$state;confidence=$confidence;reason=$reason}
}
function Convert-HtmlFragmentText([string]$fragment) {
  if (-not $fragment) { return '' }
  $text = [regex]::Replace($fragment, '(?is)<br\s*/?>', "`n")
  $text = [regex]::Replace($text, '(?is)<[^>]+>', ' ')
  $text = [Net.WebUtility]::HtmlDecode($text) -replace [string][char]0xA0, ' '
  return (($text -replace '\s+', ' ').Trim())
}
function Get-FollowUpRows([string]$html) {
  $result = @()
  if (-not $html -or $html -notmatch '(?is)follow\s*up') { return $result }
  $headerFound = $false
  foreach ($tr in [regex]::Matches($html, '(?is)<tr\b[^>]*>(.*?)</tr>')) {
    $cells = @([regex]::Matches($tr.Groups[1].Value, '(?is)<t[dh]\b[^>]*>(.*?)</t[dh]>') | ForEach-Object { Convert-HtmlFragmentText $_.Groups[1].Value })
    if ($cells.Count -lt 3) { continue }
    $joined = ($cells -join '|').ToUpperInvariant()
    if ($joined -match 'CLIENTE' -and $joined -match 'DESCRI' -and $joined -match 'FOLLOW') { $headerFound = $true; continue }
    if (-not $headerFound) { continue }
    if (-not $cells[1] -or $cells[1] -match '^(CLIENTE|DESCRI|FOLLOW)') { continue }
    $date = $null
    if ($cells[2] -match '(\d{1,2}/\d{1,2}/\d{4})') { $date = $Matches[1] }
    $result += [pscustomobject]@{client=$cells[0];description=$cells[1];followUpDate=$date}
  }
  return $result
}
if ($fepFolder) {
  $fepItems = $fepFolder.Items
  if ($fepLastReceived) { $fepSince = $fepLastReceived.AddDays(-30).ToString('MM/dd/yyyy HH:mm',[Globalization.CultureInfo]::InvariantCulture); $fepItems = $fepItems.Restrict("[ReceivedTime] >= '$fepSince'") }
  $fepItems.Sort('[ReceivedTime]', $true)
  foreach ($mail in $fepItems) {
    if ($mail.Class -ne 43) { continue }
    $messageId = $null
    try {
      $messageId = Hash-FepId "$($fepFolder.StoreID)|$($mail.EntryID)"
      if ($oldFep.Values | Where-Object { $_.messageId -eq $messageId }) { continue }
      $subject = [string]$mail.Subject
      $body = ([string]$mail.Body).Trim()
      $topBody = ($body -split '(?im)^\s*(De:|From:|Enviada em:)')[0]
      $classification = Get-FepClassification $subject $topBody
      $followUpRows = @(Get-FollowUpRows ([string]$mail.HTMLBody))
      if ($followUpRows.Count) {
        foreach ($followRow in $followUpRows) {
          $tools = @(Get-FepTools $followRow.description)
          foreach ($toolItem in $tools) {
            $eventDate = $null
            if ($followRow.followUpDate) { $parsed=[datetime]::MinValue; if ([datetime]::TryParseExact($followRow.followUpDate,'dd/MM/yyyy',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { $eventDate=$parsed.ToString('yyyy-MM-dd') } }
            if (-not $eventDate) { $eventDate = $mail.ReceivedTime.ToString('yyyy-MM-dd') }
            $eventId = Hash-FepId "$messageId|follow-up|$($toolItem.tool)|$($toolItem.sequence)|$($followRow.followUpDate)|$($followRow.description)"
            $fepRecords += @{id=$eventId;messageId=$messageId;tool=$toolItem.tool;sequence=$toolItem.sequence;rawTool=$toolItem.raw;state='FOLLOW_UP';confidence='alta';reason='Ferramenta identificada na tabela de Follow Up do e-mail.';eventDate=$eventDate;followUpDate=$eventDate;client=$followRow.client;description=$followRow.description;received=$mail.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss');subject=$subject;comment="$($followRow.client) · $($followRow.description) · Follow Up: $($followRow.followUpDate)";body=$body}
            $fepNewCount++
          }
        }
        continue
      }
      $tools = @(Get-FepTools "$subject`n$topBody")
      $eventDate = $null
      if ($topBody -match '(?<!\d)(\d{2}/\d{2}/\d{4})(?!\d)') { $parsed=[datetime]::MinValue; if ([datetime]::TryParseExact($Matches[1],'dd/MM/yyyy',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { $eventDate=$parsed.ToString('yyyy-MM-dd') } }
      if (-not $eventDate) { $eventDate = $mail.ReceivedTime.ToString('yyyy-MM-dd') }
      if (-not $tools.Count) { continue }
      foreach ($toolItem in $tools) {
        if (-not $toolItem.tool -and $classification.state -ne 'REVISAR') { $classification = [pscustomobject]@{state='REVISAR';confidence='baixa';reason="$($classification.reason) Nenhuma ferramenta foi identificada automaticamente."} }
        $eventId = Hash-FepId "$messageId|$($toolItem.tool)|$($toolItem.sequence)|$($classification.state)"
        $fepRecords += @{id=$eventId;messageId=$messageId;tool=$toolItem.tool;sequence=$toolItem.sequence;rawTool=$toolItem.raw;state=$classification.state;confidence=$classification.confidence;reason=$classification.reason;eventDate=$eventDate;received=$mail.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss');subject=$subject;comment=(($topBody -replace '(\r?\n\s*){3,}',"`r`n`r`n").Trim());body=$body}
        $fepNewCount++
      }
    } catch { $fepWarnings += "Falha ao importar '$($mail.Subject)': $($_.Exception.Message)" }
  }
}
# Preserve previously imported history even if mail is moved out of the source folder.
$seen = @{}; foreach ($r in $records) { $seen[$r.id] = $true }
foreach ($id in $old.Keys) { if (-not $seen.ContainsKey($id)) { $records += $old[$id] } }
$fepSeen = @{}; foreach ($r in $fepRecords) { $fepSeen[$r.id] = $true }
foreach ($id in $oldFep.Keys) { if (-not $fepSeen.ContainsKey($id)) { $fepRecords += $oldFep[$id] } }
$result = @{updatedAt=(Get-Date).ToString('o'); source=$folder.FolderPath; fepSource=if($fepFolder){$fepFolder.FolderPath}else{'Pasta FEP não encontrada'}; skipped=$skipped; warnings=@($warnings+$fepWarnings); records=@($records | Sort-Object received -Descending); fepRecords=@($fepRecords | Sort-Object received -Descending)}
$temp = Join-Path $dataDir 'testes.tmp'
[IO.File]::WriteAllText($temp, ($result | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temp -Destination $jsonPath -Force
$watermark = if ($result.records.Count) { ($result.records | Sort-Object {[datetime]$_.received} -Descending | Select-Object -First 1).received } else { $null }
$fepWatermark = if ($result.fepRecords.Count) { ($result.fepRecords | Sort-Object {[datetime]$_.received} -Descending | Select-Object -First 1).received } else { $fepLastReceived }
$state = @{lastReceived=$watermark; fepLastReceived=$fepWatermark; fepParserVersion=$fepParserVersion; lastRun=(Get-Date).ToString('o'); totalRecords=$result.records.Count; totalFepRecords=$result.fepRecords.Count}
[IO.File]::WriteAllText($statePath,($state | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
Write-Output "Coleta incremental concluida: $newCount teste(s), $fepNewCount evento(s) FEP; $($records.Count) testes e $($fepRecords.Count) eventos no historico; $($warnings.Count+$fepWarnings.Count) aviso(s)."
