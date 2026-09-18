param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$renderer=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe'
if (-not (Test-Path -LiteralPath $renderer)) { throw 'Conversor de visualizacao indisponivel neste computador.' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$excel=$null; $book=$null; $sheets=@()
try {
  if ([IO.Path]::GetExtension($Source) -eq '.pdf') {
    Copy-Item -LiteralPath $Source -Destination (Join-Path $Destination 'sheet-1.pdf') -Force
    $sheets += @{name='Documento'; file='sheet-1.pdf'; prefix='sheet-1'}
  } else {
    $excel=New-Object -ComObject Excel.Application
    $excel.Visible=$false
    $excel.DisplayAlerts=$false
    $excel.EnableEvents=$false
    $excel.AskToUpdateLinks=$false
    $excel.AutomationSecurity=3
    $book=$excel.Workbooks.Open($Source,0,$true)
    for($i=1;$i -le $book.Worksheets.Count;$i++) {
      $sheet=$book.Worksheets.Item($i)
      if($sheet.Visible -ne -1) {continue}
      $file="sheet-$i.pdf"
      $sheet.ExportAsFixedFormat(0,(Join-Path $Destination $file),0,$true,$false)
      $sheets += @{name=$sheet.Name; file=$file; prefix="sheet-$i"}
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sheet)
    }
  }
} finally {
  if($book) {$book.Close($false); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($book)}
  if($excel) {$excel.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)}
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
foreach($s in $sheets) {
  & $renderer -png -r 140 (Join-Path $Destination $s.file) (Join-Path $Destination $s.prefix) 2>$null
  $s.pages=@(Get-ChildItem -LiteralPath $Destination -Filter "$($s.prefix)-*.png" | Sort-Object { [int]($_.BaseName -replace '^.*-','') } | ForEach-Object {$_.Name})
  if($s.pages.Count -eq 0) {throw "Nao foi possivel renderizar $($s.name)."}
  $s.Remove('prefix')
}
$manifest=@{sheets=@($sheets); generatedAt=(Get-Date).ToString('o')}
[IO.File]::WriteAllText((Join-Path $Destination 'manifest.json'),($manifest | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
