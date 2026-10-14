[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$found = @(Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.CommandLine -match '--remote-debugging-port[= ](\d+)') {
    $port = [int]$Matches[1]
    if ($port -eq 0) {
      $match = [regex]::Match($_.CommandLine, '--user-data-dir=(?:"([^"]+)"|(\S+))')
      if ($match.Success) {
        $directory = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        $portFile = Join-Path $directory 'DevToolsActivePort'
        if (Test-Path -LiteralPath $portFile) {
          $port = [int](Get-Content -LiteralPath $portFile -TotalCount 1)
        }
      }
    }
    [PSCustomObject]@{
      port = $port
      pid = [int]$_.ProcessId
      name = [string]$_.Name
    }
  }
})
ConvertTo-Json -InputObject $found -Compress
