param([Parameter(Mandatory=$true)][string]$PayloadPath)

$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
if([string]::IsNullOrWhiteSpace($payload.to)){ throw 'Informe ao menos um destinatário.' }

try {
  $outlook = New-Object -ComObject Outlook.Application
  $mail = $outlook.CreateItem(0)
  $mail.To = $payload.to
  $mail.Subject = $payload.subject
  $mail.HTMLBody = $payload.html
  foreach($attachment in @($payload.attachments)) {
    if(Test-Path -LiteralPath $attachment) { [void]$mail.Attachments.Add($attachment) }
  }
  $mail.Send()
  Write-Output 'Relatório encaminhado ao Outlook.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
