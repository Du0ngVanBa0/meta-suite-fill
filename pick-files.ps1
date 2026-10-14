param([switch]$Single, [string]$InitialDirectory)
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Chọn video cho các hàng Sheets'
$dialog.Filter = 'Video|*.mp4;*.mov;*.m4v;*.webm;*.avi|Tất cả file|*.*'
$dialog.Multiselect = -not $Single
$dialog.CheckFileExists = $true
if ($InitialDirectory -and [System.IO.Directory]::Exists($InitialDirectory)) {
  $dialog.InitialDirectory = $InitialDirectory
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  @($dialog.FileNames) | ConvertTo-Json -Compress
} else {
  '[]'
}
$owner.Dispose()
$dialog.Dispose()
