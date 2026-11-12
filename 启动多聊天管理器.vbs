Option Explicit
Dim shell, fso, root, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(root, "src\multi-chat-manager.mjs")
shell.CurrentDirectory = root
command = """node"" """ & scriptPath & """"
shell.Run command, 0, False
