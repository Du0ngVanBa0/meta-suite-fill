param([switch]$Single, [string]$InitialDirectory)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class PickerWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  private static System.Threading.Timer timer;
  public static void ActivateWhenVisible(string title) {
    timer = new System.Threading.Timer(_ => {
      var window = FindWindow(null, title);
      if (window == IntPtr.Zero) return;
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId != Process.GetCurrentProcess().Id) return;
      SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x43);
      SetForegroundWindow(window);
      Stop();
    }, null, 100, 100);
  }
  public static void Stop() {
    var active = System.Threading.Interlocked.Exchange(ref timer, null);
    if (active != null) active.Dispose();
  }
}
'@
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
[PickerWindow]::ActivateWhenVisible($dialog.Title)
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    @($dialog.FileNames) | ConvertTo-Json -Compress
  } else {
    '[]'
  }
} finally {
  [PickerWindow]::Stop()
  $owner.Dispose()
  $dialog.Dispose()
}
