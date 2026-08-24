[Setup]
AppName=MCIS Agent
AppVersion=1.0
DefaultDirName={autopf}\MCIS Agent
DefaultGroupName=MCIS Agent
OutputDir=installer-output
OutputBaseFilename=MCIS-Agent-Setup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest

[Files]
Source: "dist\mcis-agent-win.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\MCIS Agent"; Filename: "{app}\mcis-agent-win.exe"
Name: "{autodesktop}\MCIS Agent"; Filename: "{app}\mcis-agent-win.exe"; Tasks: desktopicon
Name: "{userstartup}\MCIS Agent"; Filename: "{app}\mcis-agent-win.exe"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\mcis-agent-win.exe"; Description: "Launch MCIS Agent"; Flags: nowait postinstall skipifsilent