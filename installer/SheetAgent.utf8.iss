#define ProductName "Sheet Agent"
#ifndef ProductVersion
  #define ProductVersion "0.3.0"
#endif
#ifndef StageDir
  #error StageDir must be provided
#endif
#ifndef OutputDir
  #error OutputDir must be provided
#endif

[Setup]
AppId={{8C23B01A-8EB7-4E38-B3A7-7A3B067592C1}
AppName={#ProductName}
AppVersion={#ProductVersion}
AppPublisher=Sheet Agent
DefaultDirName={localappdata}\Programs\SheetAgent
DefaultGroupName=Sheet Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
OutputDir={#OutputDir}
OutputBaseFilename=SheetAgentSetup-x64
VersionInfoVersion={#ProductVersion}.0
VersionInfoProductName={#ProductName}
VersionInfoProductVersion={#ProductVersion}
UninstallDisplayIcon={app}\SheetAgent.exe
CloseApplications=force
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes
UsePreviousTasks=yes

[Tasks]
Name: "autostart"; Description: "Запускать Sheet Agent вместе с Windows"; GroupDescription: "Дополнительно:"; Flags: checkedonce
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: checkedonce
Name: "localsideload"; Description: "Зарегистрировать локальный Excel Add-in для текущего пользователя"; GroupDescription: "Excel:"; Flags: checkedonce

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\wwwroot\*"; DestDir: "{app}\wwwroot"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\manifest\manifest.windows.xml"; DestDir: "{app}\manifest"; Flags: ignoreversion
Source: "{#StageDir}\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SheetAgent"; ValueData: """{app}\SheetAgent.exe"" --background"; Tasks: autostart; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\WEF\Developer"; ValueType: string; ValueName: "{app}\manifest\manifest.windows.xml"; ValueData: "{app}\manifest\manifest.windows.xml"; Tasks: localsideload; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\SheetAgent"; ValueType: string; ValueName: "InstallVersion"; ValueData: "{#ProductVersion}"; Flags: uninsdeletekeyifempty

[Icons]
Name: "{group}\Sheet Agent"; Filename: "{app}\SheetAgent.exe"
Name: "{userdesktop}\Sheet Agent"; Filename: "{app}\SheetAgent.exe"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-certificate.ps1"" -CertificateDirectory ""{localappdata}\SheetAgent\certificate"""; Flags: runhidden waituntilterminated
Filename: "{app}\SheetAgent.exe"; Description: "Запустить Sheet Agent"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM SheetAgent.exe /F"; Flags: runhidden; RunOnceId: "StopSheetAgent"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\remove-certificate.ps1"" -CertificateDirectory ""{localappdata}\SheetAgent\certificate"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveCertificate"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\SheetAgent"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  CertPath: String;
begin
  if CurStep = ssPostInstall then
  begin
    if not WizardIsTaskSelected('autostart') then
      RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'SheetAgent');
    if not WizardIsTaskSelected('localsideload') then
      RegDeleteValue(HKCU, 'Software\Microsoft\Office\16.0\WEF\Developer', ExpandConstant('{app}\manifest\manifest.windows.xml'));
    // Fail closed: the loopback HTTPS certificate must exist or Excel cannot load the add-in.
    CertPath := ExpandConstant('{localappdata}\SheetAgent\certificate\localhost.pfx');
    if not FileExists(CertPath) then
      RaiseException('Sheet Agent: the localhost HTTPS certificate was not created (' + CertPath + '). The add-in cannot start over HTTPS. Installation aborted.');
  end;
end;
