# Deletes the shortcut an earlier build left under its old name when that shortcut is dead.
# The installer runs it after every install and update (installer.nsh) with the Start menu and
# desktop folders of this user and of all users.
#
# A shortcut goes only when all of this holds: it is "<Name>.lnk" directly in one of the folders,
# its target is a file named "<Name>.exe", and that file is missing. A shortcut that still works,
# or one of that name that belongs to something else, stays.
param(
  # Folders to look in, joined with "|" (a character no path can hold).
  [Parameter(Mandatory = $true)][string]$Dirs,
  [string]$Name = 'Agent Ops'
)

$ErrorActionPreference = 'Stop'

# The installer is a 32-bit program, so this script runs in 32-bit PowerShell. There, Windows
# reports a target under "C:\Program Files" as under "C:\Program Files (x86)". The file counts as
# missing only when it is in neither place.
function Test-TargetExists([string]$Target) {
  if (Test-Path -LiteralPath $Target) { return $true }
  $x86 = ${env:ProgramFiles(x86)}
  $x64 = $env:ProgramW6432
  if ($x86 -and $x64 -and $Target.StartsWith("$x86\", [StringComparison]::OrdinalIgnoreCase)) {
    return Test-Path -LiteralPath ($x64 + $Target.Substring($x86.Length))
  }
  return $false
}

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $Dirs.Split('|')) {
  if (-not $dir) { continue }
  $link = Join-Path $dir "$Name.lnk"
  try {
    if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { continue }
    $target = $shell.CreateShortcut($link).TargetPath
    if (-not $target) { continue }
    if ((Split-Path -Leaf $target) -ne "$Name.exe") { continue }
    if (Test-TargetExists $target) { continue }
    Remove-Item -LiteralPath $link -Force
  } catch {
    # Unreadable, or in the all-users folder during an install without admin rights: leave it.
    continue
  }
}
