# Windows Companion Service

The Stage 17 Windows companion is a self-contained Windows x64 tray application. It does not require a Sheet Agent account or user authentication.

Implemented:
- localhost-only Kestrel service on `127.0.0.1:47831`;
- strict Office add-in origin allowlist;
- one-time six-digit pairing code and rotating in-memory session token;
- DPAPI CurrentUser encryption for the Qwen API key;
- tray settings for key management and pairing;
- per-user Windows startup registration through HKCU;
- public health endpoint and protected credential endpoints;
- optional HTTPS certificate via `SHEET_AGENT_CERT_PATH` and `SHEET_AGENT_CERT_PASSWORD`;
- no shell, arbitrary-code, or unauthenticated secret endpoint.

## Build and test

```powershell
dotnet test tests/SheetAgent.Companion.Tests.csproj -c Release
dotnet publish SheetAgent.Companion.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

The local verified artifact is `artifacts/windows-companion/win-x64/SheetAgent.exe`. Production certificate provisioning, installer, code signing, update and uninstall belong to Stage 18.
