# Install Sheet Agent on Windows

Download both `SheetAgentSetup-x64.exe` and `SheetAgentSetup-x64.exe.sha256` from the same GitHub Release. Sheet Agent supports Windows 10/11 x64 and Microsoft Excel Desktop with ExcelApi 1.2 and CustomFunctionsRuntime 1.1. You also need network access to your organization’s LiteLLM provider and a provider API key.

Close Excel before installing. In PowerShell, verify the download:

```powershell
$expected = (Get-Content .\SheetAgentSetup-x64.exe.sha256).Split()[0]
$actual = (Get-FileHash .\SheetAgentSetup-x64.exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Checksum mismatch' }
Get-AuthenticodeSignature .\SheetAgentSetup-x64.exe
```

The checksum must match and a production release must show `Status: Valid`. Then double-click the installer. It installs only for your Windows user; administrator access and developer tools are not required. Leave **Register local Excel Add-in** selected. Desktop and start-with-Windows options are optional. Windows may show SmartScreen publisher information; do not continue if a production download is unsigned or the publisher is unexpected.

The installer places files in `%LOCALAPPDATA%\Programs\SheetAgent`, creates and trusts a localhost-only certificate for the current user, registers the add-in under the current user’s Office settings, and launches the tray Companion. Restart Excel after installation.

To uninstall, close Excel, open **Settings → Apps → Installed apps → Sheet Agent → Uninstall**, and finish the wizard. Uninstall stops the Companion and removes application files, Office registration, the localhost certificate, startup entry, and Sheet Agent’s DPAPI credential/configuration directory. Save any configuration you intend to reuse before uninstalling.
