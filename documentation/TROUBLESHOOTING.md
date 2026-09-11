# Sheet Agent troubleshooting

## The add-in is missing or blocked

Close every Excel window, confirm Sheet Agent is installed and running from the Start menu, then reopen Excel. Check **Home → Excel AI → AI Assistant**. In Excel, inspect **File → Options → Add-ins** for disabled items. If the button is still missing, repair by rerunning the same signed installer with **Register local Excel Add-in** selected. Organization Office policies can prohibit locally registered add-ins; contact your administrator in that case.

## The Companion does not start

Open `https://localhost:47831/health` in a browser. If it does not return a small `status: ok` response, exit any stale Sheet Agent process in Task Manager and launch it from Start. A port conflict on 47831, damaged localhost certificate, security software, or incomplete installation can block startup. Reinstall after closing Excel. Do not bypass certificate warnings.

## AI requests fail

Open tray **Settings** and save the correct API key. `#AUTH!` indicates missing/invalid/expired credentials; `#RATE!` indicates HTTP 429; `#TIMEOUT!` indicates a slow provider; `#AI!` generally indicates offline/DNS/provider 5xx/malformed response. Check the network/VPN and try later. Sheet Agent deliberately omits provider response bodies and secrets from errors.

## Installer, Defender, or SmartScreen warning

Verify both SHA-256 and Authenticode as described in [INSTALLATION.md](./INSTALLATION.md). A production release must be signed by the expected publisher. Installer logs are written by Inno Setup under `%TEMP%` with names similar to `Setup Log*.txt`; attach that log when requesting support. Windows Defender detections should be reported with the release version, checksum, and detection name—do not disable Defender.

## Safe reset

Close Excel, uninstall Sheet Agent through Windows Settings, confirm `%LOCALAPPDATA%\Programs\SheetAgent` is gone, and reinstall the latest signed release. Full uninstall intentionally removes the localhost certificate and saved provider credential. There is currently no persistent Companion application log; use the health endpoint and installer log for diagnosis.
