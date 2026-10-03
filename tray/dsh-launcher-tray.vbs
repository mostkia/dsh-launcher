' dsh-launcher-tray.vbs - start the DSH tray launcher with no console window at all.
' ASCII only on purpose: wscript reads .vbs as ANSI, so keep this file BOM-free.
' Extra arguments are forwarded to dsh-launcher-tray.ps1 (e.g. -Port 3599 -Headless).
Option Explicit
Dim fso, sh, here, ps1, cmd, i, args
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = here & "\dsh-launcher-tray.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "dsh-launcher-tray.ps1 not found:" & vbCrLf & ps1, 16, "DSH Launcher tray"
  WScript.Quit 1
End If
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & Replace(WScript.Arguments(i), """", "") & """"
Next
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & ps1 & """" & args
sh.Run cmd, 0, False
