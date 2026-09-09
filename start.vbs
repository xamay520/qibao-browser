' Qibao Browser - silent launcher (no black console window)
Option Explicit
Dim ws, fso, dir, exe
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' change to app directory
On Error Resume Next
ws.CurrentDirectory = dir
On Error GoTo 0

' remove ELECTRON_RUN_AS_NODE if present (breaks Electron GUI)
On Error Resume Next
ws.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

' redirect Chromium temp to app _tmp (avoid filling system disk)
If Not fso.FolderExists(dir & "\_tmp") Then fso.CreateFolder(dir & "\_tmp")
ws.Environment("PROCESS")("TMP") = dir & "\_tmp"
ws.Environment("PROCESS")("TEMP") = dir & "\_tmp"

' runtime check
exe = dir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Electron runtime not found. Run 'npm install' in the app folder first.", vbExclamation, "Qibao Browser"
  WScript.Quit 1
End If

' launch app window normally (1 = SW_SHOWNORMAL). DO NOT use 0 (SW_HIDE):
' on a GUI app, 0 hides the whole main window -> "double-click does nothing"
Dim logf
logf = dir & "\_start.log"
On Error Resume Next
Dim f
Set f = fso.CreateTextFile(logf, True)
f.WriteLine Now & " vbs launched, dir=" & dir
f.WriteLine Now & " launching: " & exe
f.Close
On Error GoTo 0
ws.Run """" & exe & """ """ & dir & """", 1, False
