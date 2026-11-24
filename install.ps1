<#
.SYNOPSIS
    gravityzilla: Antigravity Windows Portable Setup & Installer
.DESCRIPTION
    Deploys the portable subset of gravityzilla on Windows:
      - Global prompt (GEMINI.md) and base configs (config.json, mcp_config.json, settings.json)
      - Portable agent skills (16 of 17; skips Linux bash-only 'ship')
      - Portable plugins (gemini-api, playwright, margin, stats, diagnostics)
      - Helper launchers in %USERPROFILE%\.local\bin (agy-stats, agy-diagnostics + .cmd shims)

    Skips Linux-only / patching components:
      desktop-patch (agy-desktop-patch), watchdog (agy-watch), agy-statusline,
      memory (agent-memory, agy-compound), rtk, ship (git-wt-sync).
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Uninstall,
    [switch]$Force,
    [switch]$Junction,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    @"
Usage: .\install.ps1 [OPTIONS]

Options:
  (Default)    Copy portable configs, skills, plugins, and helper scripts.
               Rewrites Windows hook commands in deployed stats/diagnostics plugins.
  -Junction    Use NTFS directory junctions for skills and non-rewritten plugins
               (gemini-api, playwright, margin). No Admin/Developer Mode required.
  -Status      Check deployed files/junctions for drift or missing targets.
  -Uninstall   Remove gravityzilla-managed files, shims, and junctions while
               preserving local mutable configs and runtime data.
  -Force       Back up and replace conflicting destination files/directories.
  -Help        Show this help message.

Targets configured:
  %USERPROFILE%\.local\bin\              Helper scripts + .cmd shims (agy-stats, agy-diagnostics)
  %USERPROFILE%\.agents\skills\          Portable skills (linked into Antigravity)
  %USERPROFILE%\.gemini\config\          GEMINI.md, mcp_config.json, config.json, portable plugins
  %USERPROFILE%\.gemini\antigravity-cli\ settings.json (Windows template) & skills
  %USERPROFILE%\.config\agy-stats\       Stats preferences (copied once; keys/ never deployed)

Skipped on Windows (Linux-only / ASAR patching):
  desktop-patch, watchdog, agy-statusline, memory/compound, rtk, ship (git-wt-sync)
"@ | Write-Output
    exit 0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($HomeDir)) {
    $HomeDir = [Environment]::GetFolderPath('UserProfile')
}

$BackupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$PortablePlugins = @('gemini-api', 'playwright', 'margin', 'stats', 'diagnostics')
$RewrittenPlugins = @('stats', 'diagnostics')
$ExcludedSkills = @('ship')
$ExcludedDirNames = @('__pycache__', '.playwright-mcp')
$ExcludedFileExts = @('.pyc')

$LocalBinDir = [System.IO.Path]::Combine($HomeDir, '.local', 'bin')
$GeminiConfigDir = [System.IO.Path]::Combine($HomeDir, '.gemini', 'config')
$GeminiPluginsDir = [System.IO.Path]::Combine($GeminiConfigDir, 'plugins')
$GeminiConfigSkillsDir = [System.IO.Path]::Combine($GeminiConfigDir, 'skills')
$GeminiCliDir = [System.IO.Path]::Combine($HomeDir, '.gemini', 'antigravity-cli')
$GeminiCliSkillsDir = [System.IO.Path]::Combine($GeminiCliDir, 'skills')
$AgentsDir = [System.IO.Path]::Combine($HomeDir, '.agents')
$AgentsSkillsDir = [System.IO.Path]::Combine($AgentsDir, 'skills')
$AgentsDiagnosticsDir = [System.IO.Path]::Combine($AgentsDir, 'diagnostics')
$ConfigStatsDir = [System.IO.Path]::Combine($HomeDir, '.config', 'agy-stats')

$script:SkipCount = 0

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [System.IO.Directory]::Exists($Path)) {
        [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    }
}

function Get-PathItemInfo {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Test-IsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-PathItemInfo -Path $Path
    if ($null -eq $item) { return $false }
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-ReparseTargetPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-PathItemInfo -Path $Path
    if ($null -eq $item) { return $null }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return $null }
    $targetProp = $item.PSObject.Properties['Target']
    if ($null -eq $targetProp -or $null -eq $targetProp.Value) { return $null }
    $val = $targetProp.Value
    if ($val -is [System.Array]) {
        if ($val.Count -gt 0) { $val = [string]$val[0] } else { return $null }
    }
    else {
        $val = [string]$val
    }
    if ([string]::IsNullOrWhiteSpace($val)) { return $null }
    return [System.IO.Path]::GetFullPath($val).TrimEnd('\')
}

function Remove-PathSafely {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-PathItemInfo -Path $Path
    if ($null -eq $item) { return }
    $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    if ($isReparse) {
        if ($item.PSIsContainer) {
            [System.IO.Directory]::Delete($Path, $false)
        }
        else {
            [System.IO.File]::Delete($Path)
        }
        return
    }
    if ($item.PSIsContainer) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    else {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Backup-Or-RemoveDestination {
    param([Parameter(Mandatory = $true)][string]$Dest)
    if (Test-IsReparsePoint -Path $Dest) {
        Remove-PathSafely -Path $Dest
        return
    }
    $backupPath = "$Dest.bak.$BackupStamp"
    Move-Item -LiteralPath $Dest -Destination $backupPath -Force
    Write-Output "  [BACKUP] $Dest -> $backupPath"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Find-PythonCommand {
    $candidates = @(
        @{ Exe = 'py'; PrefixArgs = @('-3'); HookCmd = 'py -3'; CmdLine = 'py -3' },
        @{ Exe = 'python'; PrefixArgs = @(); HookCmd = 'python'; CmdLine = 'python' },
        @{ Exe = 'python3'; PrefixArgs = @(); HookCmd = 'python3'; CmdLine = 'python3' }
    )

    foreach ($cand in $candidates) {
        $cmd = Get-Command $cand.Exe -ErrorAction SilentlyContinue
        if ($null -eq $cmd) { continue }
        $probeArgs = @()
        $probeArgs += $cand.PrefixArgs
        $probeArgs += @('-c', "import sys; print('{}.{}'.format(sys.version_info.major, sys.version_info.minor))")
        try {
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $out = & $cmd.Source @probeArgs 2>$null
            $code = $LASTEXITCODE
            $ErrorActionPreference = $oldPref
            if ($code -ne 0 -or $null -eq $out) { continue }
            $ver = ($out | Out-String).Trim()
            if ($ver -match '^(\d+)\.(\d+)$') {
                $maj = [int]$Matches[1]
                $min = [int]$Matches[2]
                if ($maj -ge 3) {
                    return [PSCustomObject]@{
                        Exe        = $cmd.Source
                        PrefixArgs = $cand.PrefixArgs
                        HookCmd    = $cand.HookCmd
                        CmdLine    = $cand.CmdLine
                        Major      = $maj
                        Minor      = $min
                        Version    = $ver
                    }
                }
            }
        }
        catch {
            $ErrorActionPreference = 'Stop'
        }
    }
    return $null
}

function Get-EffectivePythonHookCmd {
    param($PythonInfo)
    if ($null -ne $PythonInfo) { return $PythonInfo.HookCmd }
    return 'python'
}

function Get-CmdShimContent {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [Parameter(Mandatory = $true)][string]$PythonCmdLine
    )
    return "@echo off`r`n$PythonCmdLine `"%~dp0$ScriptName`" %*`r`n"
}

function Get-RewrittenHooksJson {
    param(
        [Parameter(Mandatory = $true)][string]$PluginName,
        [Parameter(Mandatory = $true)][string]$SourceHooksPath,
        [Parameter(Mandatory = $true)][string]$PythonHookCmd
    )
    $raw = Read-Utf8Text -Path $SourceHooksPath
    $data = $raw | ConvertFrom-Json

    if ($PluginName -eq 'stats') {
        foreach ($entry in $data.stats.PreInvocation) {
            if ($entry.command -match '^python3\s+(.+)$') {
                $entry.command = "$PythonHookCmd $($Matches[1])"
            }
        }
    }
    elseif ($PluginName -eq 'diagnostics') {
        $diagScript = [System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics')
        foreach ($eventName in @('PostToolUse', 'PreInvocation', 'Stop')) {
            $groups = $data.diagnostics.$eventName
            if ($null -eq $groups) { continue }
            foreach ($group in $groups) {
                foreach ($hook in $group.hooks) {
                    if ($hook.command -match '^~/.local/bin/agy-diagnostics\s*(.*)$') {
                        $rest = $Matches[1].Trim()
                        if ([string]::IsNullOrEmpty($rest)) {
                            $hook.command = "$PythonHookCmd `"$diagScript`""
                        }
                        else {
                            $hook.command = "$PythonHookCmd `"$diagScript`" $rest"
                        }
                    }
                }
            }
        }
    }

    return ($data | ConvertTo-Json -Depth 10) + "`n"
}

function Get-PortableSkillDirs {
    $skillsRoot = [System.IO.Path]::Combine($ScriptDir, '.agents', 'skills')
    if (-not [System.IO.Directory]::Exists($skillsRoot)) { return @() }
    $dirs = Get-ChildItem -LiteralPath $skillsRoot -Directory | Sort-Object Name
    $result = @()
    foreach ($d in $dirs) {
        if ($ExcludedSkills -contains $d.Name) { continue }
        $result += $d
    }
    return $result
}

function Get-FilteredRelativeFiles {
    param([Parameter(Mandatory = $true)][string]$RootDir)
    $fullRoot = [System.IO.Path]::GetFullPath($RootDir).TrimEnd('\')
    $files = @{}
    if (-not [System.IO.Directory]::Exists($fullRoot)) { return $files }

    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($fullRoot)
    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()
        foreach ($sub in [System.IO.Directory]::GetDirectories($cur)) {
            $name = [System.IO.Path]::GetFileName($sub)
            if ($ExcludedDirNames -contains $name) { continue }
            $stack.Push($sub)
        }
        foreach ($f in [System.IO.Directory]::GetFiles($cur)) {
            $ext = [System.IO.Path]::GetExtension($f).ToLowerInvariant()
            if ($ExcludedFileExts -contains $ext) { continue }
            $rel = $f.Substring($fullRoot.Length + 1)
            $files[$rel] = $f
        }
    }
    return $files
}

function Copy-FilteredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$SrcDir,
        [Parameter(Mandatory = $true)][string]$DestDir,
        [string]$PluginName = '',
        [string]$PythonHookCmd = 'python'
    )
    Ensure-Directory -Path $DestDir
    $srcFiles = Get-FilteredRelativeFiles -RootDir $SrcDir
    foreach ($rel in $srcFiles.Keys) {
        $destFile = [System.IO.Path]::Combine($DestDir, $rel)
        Ensure-Directory -Path (Split-Path -Parent $destFile)
        [System.IO.File]::Copy($srcFiles[$rel], $destFile, $true)
    }

    if ($RewrittenPlugins -contains $PluginName) {
        $srcHooks = [System.IO.Path]::Combine($SrcDir, 'hooks.json')
        if ([System.IO.File]::Exists($srcHooks)) {
            $rewritten = Get-RewrittenHooksJson -PluginName $PluginName -SourceHooksPath $srcHooks -PythonHookCmd $PythonHookCmd
            $destHooks = [System.IO.Path]::Combine($DestDir, 'hooks.json')
            Write-Utf8NoBom -Path $destHooks -Content $rewritten
        }
    }
}

function Test-DirectoryInSync {
    param(
        [Parameter(Mandatory = $true)][string]$SrcDir,
        [Parameter(Mandatory = $true)][string]$DestDir,
        [string]$PluginName = '',
        [string]$PythonHookCmd = 'python'
    )
    $srcFiles = Get-FilteredRelativeFiles -RootDir $SrcDir
    $destFiles = Get-FilteredRelativeFiles -RootDir $DestDir

    if ($srcFiles.Count -ne $destFiles.Count) { return $false }

    foreach ($rel in $srcFiles.Keys) {
        if (-not $destFiles.ContainsKey($rel)) { return $false }
        $destFile = $destFiles[$rel]
        if (($RewrittenPlugins -contains $PluginName) -and ($rel -eq 'hooks.json')) {
            $expected = Get-RewrittenHooksJson -PluginName $PluginName -SourceHooksPath $srcFiles[$rel] -PythonHookCmd $PythonHookCmd
            $actual = Read-Utf8Text -Path $destFile
            if ($expected.Replace("`r`n", "`n") -ne $actual.Replace("`r`n", "`n")) { return $false }
        }
        else {
            if ((Get-FileSha256 -Path $srcFiles[$rel]) -ne (Get-FileSha256 -Path $destFile)) { return $false }
        }
    }
    return $true
}

function Deploy-FileEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Src,
        [Parameter(Mandatory = $true)][string]$Dest
    )
    $existing = Get-PathItemInfo -Path $Dest
    if ($null -ne $existing) {
        if (-not $existing.PSIsContainer -and -not (Test-IsReparsePoint -Path $Dest)) {
            if ((Get-FileSha256 -Path $Src) -eq (Get-FileSha256 -Path $Dest)) {
                return
            }
        }
        if (-not $Force) {
            Write-Output "  [SKIP] $Dest already exists (preserving; re-run with -Force to back up and replace)"
            $script:SkipCount++
            return
        }
        Backup-Or-RemoveDestination -Dest $Dest
    }
    Ensure-Directory -Path (Split-Path -Parent $Dest)
    [System.IO.File]::Copy($Src, $Dest, $true)
}

function Deploy-GeneratedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $existing = Get-PathItemInfo -Path $Dest
    if ($null -ne $existing) {
        if (-not $existing.PSIsContainer -and -not (Test-IsReparsePoint -Path $Dest)) {
            $cur = Read-Utf8Text -Path $Dest
            if ($cur -eq $Content) { return }
        }
        if (-not $Force) {
            Write-Output "  [SKIP] $Dest already exists (preserving; re-run with -Force to back up and replace)"
            $script:SkipCount++
            return
        }
        Backup-Or-RemoveDestination -Dest $Dest
    }
    Write-Utf8NoBom -Path $Dest -Content $Content
}

function Deploy-TemplateFile {
    param(
        [Parameter(Mandatory = $true)][string]$Src,
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $existing = Get-PathItemInfo -Path $Dest
    if ($null -ne $existing) {
        if (-not $Force) {
            Write-Output "    Preserving existing $Label (use -Force to back up and overwrite)."
            return
        }
        Backup-Or-RemoveDestination -Dest $Dest
    }
    Ensure-Directory -Path (Split-Path -Parent $Dest)
    [System.IO.File]::Copy($Src, $Dest, $true)
}

function Deploy-DirectoryEntry {
    param(
        [Parameter(Mandatory = $true)][string]$SrcDir,
        [Parameter(Mandatory = $true)][string]$DestDir,
        [switch]$UseJunction,
        [string]$PluginName = '',
        [string]$PythonHookCmd = 'python'
    )
    $fullSrc = [System.IO.Path]::GetFullPath($SrcDir).TrimEnd('\')
    $existing = Get-PathItemInfo -Path $DestDir

    if ($null -ne $existing) {
        if ($UseJunction -and (Test-IsReparsePoint -Path $DestDir)) {
            $target = Get-ReparseTargetPath -Path $DestDir
            if ($target -eq $fullSrc) { return }
        }
        elseif (-not $UseJunction -and $existing.PSIsContainer -and -not (Test-IsReparsePoint -Path $DestDir)) {
            if (Test-DirectoryInSync -SrcDir $SrcDir -DestDir $DestDir -PluginName $PluginName -PythonHookCmd $PythonHookCmd) {
                return
            }
        }

        if (-not $Force) {
            Write-Output "  [SKIP] $DestDir already exists (preserving; re-run with -Force to back up and replace)"
            $script:SkipCount++
            return
        }
        Backup-Or-RemoveDestination -Dest $DestDir
    }

    Ensure-Directory -Path (Split-Path -Parent $DestDir)
    if ($UseJunction) {
        New-Item -ItemType Junction -Path $DestDir -Target $fullSrc | Out-Null
    }
    else {
        Copy-FilteredDirectory -SrcDir $SrcDir -DestDir $DestDir -PluginName $PluginName -PythonHookCmd $PythonHookCmd
    }
}

function Check-FileStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Src,
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$Label,
        [ref]$DriftCount
    )
    $item = Get-PathItemInfo -Path $Dest
    if ($null -eq $item) {
        Write-Output "  [MISSING] $Label"
        $DriftCount.Value++
        return
    }
    if ($item.PSIsContainer -or (Test-IsReparsePoint -Path $Dest)) {
        Write-Output "  [DRIFT]   $Label (type mismatch)"
        $DriftCount.Value++
        return
    }
    if ((Get-FileSha256 -Path $Src) -eq (Get-FileSha256 -Path $Dest)) {
        Write-Output "  [OK]      $Label"
    }
    else {
        Write-Output "  [DRIFT]   $Label (differs from $Src)"
        $DriftCount.Value++
    }
}

function Check-GeneratedStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$ExpectedContent,
        [Parameter(Mandatory = $true)][string]$Label,
        [ref]$DriftCount
    )
    $item = Get-PathItemInfo -Path $Dest
    if ($null -eq $item) {
        Write-Output "  [MISSING] $Label"
        $DriftCount.Value++
        return
    }
    if ($item.PSIsContainer -or (Test-IsReparsePoint -Path $Dest)) {
        Write-Output "  [DRIFT]   $Label (type mismatch)"
        $DriftCount.Value++
        return
    }
    $actual = Read-Utf8Text -Path $Dest
    if ($actual -eq $ExpectedContent) {
        Write-Output "  [OK]      $Label"
    }
    else {
        Write-Output "  [DRIFT]   $Label (differs from expected shim)"
        $DriftCount.Value++
    }
}

function Check-LocalConfigStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$Label,
        [ref]$DriftCount
    )
    $item = Get-PathItemInfo -Path $Dest
    if ($null -eq $item) {
        Write-Output "  [MISSING] $Label"
        $DriftCount.Value++
        return
    }
    if ($item.PSIsContainer -or (Test-IsReparsePoint -Path $Dest)) {
        Write-Output "  [DRIFT]   $Label (expected regular local config file)"
        $DriftCount.Value++
        return
    }
    Write-Output "  [OK]      $Label (local config)"
}

function Check-DirectoryStatus {
    param(
        [Parameter(Mandatory = $true)][string]$SrcDir,
        [Parameter(Mandatory = $true)][string]$DestDir,
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$PluginName = '',
        [string]$PythonHookCmd = 'python',
        [ref]$DriftCount
    )
    $item = Get-PathItemInfo -Path $DestDir
    if ($null -eq $item) {
        Write-Output "  [MISSING] $Label"
        $DriftCount.Value++
        return
    }
    $fullSrc = [System.IO.Path]::GetFullPath($SrcDir).TrimEnd('\')
    if (Test-IsReparsePoint -Path $DestDir) {
        $target = Get-ReparseTargetPath -Path $DestDir
        if ($target -eq $fullSrc) {
            Write-Output "  [OK]      $Label (junction)"
        }
        else {
            Write-Output "  [DRIFT]   $Label (junction points to $target, expected $fullSrc)"
            $DriftCount.Value++
        }
        return
    }
    if (-not $item.PSIsContainer) {
        Write-Output "  [DRIFT]   $Label (not a directory)"
        $DriftCount.Value++
        return
    }
    if (Test-DirectoryInSync -SrcDir $SrcDir -DestDir $DestDir -PluginName $PluginName -PythonHookCmd $PythonHookCmd) {
        Write-Output "  [OK]      $Label (copy)"
    }
    else {
        Write-Output "  [DRIFT]   $Label (directory differs from $SrcDir)"
        $DriftCount.Value++
    }
}

function Invoke-StatusCheck {
    $drift = 0
    $pyInfo = Find-PythonCommand
    $pyHook = Get-EffectivePythonHookCmd -PythonInfo $pyInfo
    $pyCmdLine = if ($null -ne $pyInfo) { $pyInfo.CmdLine } else { 'python' }

    Write-Output '==> Checking gravityzilla Windows install status...'

    Write-Output '-- Binaries (%USERPROFILE%\.local\bin\):'
    $diagSrc = [System.IO.Path]::Combine($ScriptDir, 'bin', 'agy-diagnostics')
    $statsSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'stats', 'bin', 'agy-stats')
    Check-FileStatus -Src $diagSrc -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics')) -Label '~/.local/bin/agy-diagnostics' -DriftCount ([ref]$drift)
    Check-GeneratedStatus -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics.cmd')) -ExpectedContent (Get-CmdShimContent -ScriptName 'agy-diagnostics' -PythonCmdLine $pyCmdLine) -Label '~/.local/bin/agy-diagnostics.cmd' -DriftCount ([ref]$drift)
    Check-FileStatus -Src $statsSrc -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats')) -Label '~/.local/bin/agy-stats' -DriftCount ([ref]$drift)
    Check-GeneratedStatus -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats.cmd')) -ExpectedContent (Get-CmdShimContent -ScriptName 'agy-stats' -PythonCmdLine $pyCmdLine) -Label '~/.local/bin/agy-stats.cmd' -DriftCount ([ref]$drift)

    Write-Output '-- Antigravity Config (%USERPROFILE%\.gemini\config\):'
    Check-FileStatus -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'GEMINI.md')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'GEMINI.md')) -Label '~/.gemini/config/GEMINI.md' -DriftCount ([ref]$drift)
    Check-FileStatus -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'mcp_config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'mcp_config.json')) -Label '~/.gemini/config/mcp_config.json' -DriftCount ([ref]$drift)
    Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'config.json')) -Label '~/.gemini/config/config.json' -DriftCount ([ref]$drift)

    foreach ($pname in $PortablePlugins) {
        $pSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', $pname)
        $pDest = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
        Check-DirectoryStatus -SrcDir $pSrc -DestDir $pDest -Label "~/.gemini/config/plugins/$pname" -PluginName $pname -PythonHookCmd $pyHook -DriftCount ([ref]$drift)
    }

    Write-Output '-- Extra Configs & Settings:'
    Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($ConfigStatsDir, 'config.json')) -Label '~/.config/agy-stats/config.json' -DriftCount ([ref]$drift)
    Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($GeminiCliDir, 'settings.json')) -Label '~/.gemini/antigravity-cli/settings.json' -DriftCount ([ref]$drift)

    Write-Output '-- Portable Skills:'
    $skills = Get-PortableSkillDirs
    foreach ($s in $skills) {
        $sname = $s.Name
        Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, $sname)) -Label "~/.agents/skills/$sname" -DriftCount ([ref]$drift)
        Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiConfigSkillsDir, $sname)) -Label "~/.gemini/config/skills/$sname" -DriftCount ([ref]$drift)
        Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiCliSkillsDir, $sname)) -Label "~/.gemini/antigravity-cli/skills/$sname" -DriftCount ([ref]$drift)
    }

    Write-Output ''
    if ($drift -eq 0) {
        Write-Output 'Status: CLEAN (0 drift/missing items)'
        exit 0
    }
    else {
        Write-Output "Status: $drift issue(s) found (run .\install.ps1 to reconcile)"
        exit 1
    }
}

function Invoke-Uninstall {
    Write-Output '==> Uninstalling gravityzilla Windows files and junctions...'

    foreach ($fname in @('agy-diagnostics', 'agy-diagnostics.cmd', 'agy-stats', 'agy-stats.cmd')) {
        $p = [System.IO.Path]::Combine($LocalBinDir, $fname)
        if ($null -ne (Get-PathItemInfo -Path $p)) {
            Remove-PathSafely -Path $p
            Write-Output "  [REMOVED] $p"
        }
    }

    foreach ($cfgName in @('GEMINI.md', 'mcp_config.json')) {
        $p = [System.IO.Path]::Combine($GeminiConfigDir, $cfgName)
        if ($null -ne (Get-PathItemInfo -Path $p)) {
            Remove-PathSafely -Path $p
            Write-Output "  [REMOVED] $p"
        }
    }

    foreach ($pname in $PortablePlugins) {
        $p = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
        if ($null -ne (Get-PathItemInfo -Path $p)) {
            Remove-PathSafely -Path $p
            Write-Output "  [REMOVED] $p"
        }
    }

    $skills = Get-PortableSkillDirs
    foreach ($root in @($GeminiConfigSkillsDir, $GeminiCliSkillsDir, $AgentsSkillsDir)) {
        foreach ($s in $skills) {
            $p = [System.IO.Path]::Combine($root, $s.Name)
            if ($null -ne (Get-PathItemInfo -Path $p)) {
                Remove-PathSafely -Path $p
                Write-Output "  [REMOVED] $p"
            }
        }
    }

    Write-Output ''
    Write-Output '==> Uninstall complete.'
    Write-Output '    Preserved local configs & runtime data (~/.gemini/config/config.json, settings.json, ~/.config/agy-stats/, ~/.agents/diagnostics/).'
    exit 0
}

if ($Status) {
    Invoke-StatusCheck
}

if ($Uninstall) {
    Invoke-Uninstall
}

$modeLabel = if ($Junction) { 'junction+copy' } else { 'copy' }
Write-Output "==> Starting gravityzilla Windows setup (Mode: $modeLabel, Force: $Force)..."

# 1. Prerequisite checks
Write-Output '==> Verifying system requirements...'
$PyInfo = Find-PythonCommand
if ($null -eq $PyInfo) {
    Write-Warning 'Python 3 not found in PATH (checked py -3, python, python3). Prompt, skills, and Margin will still install; stats and diagnostics hooks require Python >= 3.11.'
}
else {
    Write-Output "    [PASS] Python $($PyInfo.Version) via '$($PyInfo.HookCmd)'"
    if (($PyInfo.Major -lt 3) -or (($PyInfo.Major -eq 3) -and ($PyInfo.Minor -lt 11))) {
        Write-Warning "Python $($PyInfo.Version) detected (< 3.11). TOML diagnostics in agy-diagnostics will be skipped."
    }
}

$NodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue
if ($null -eq $NodeCmd) {
    Write-Warning 'node not found in PATH. Margin plugin and UI skills require Node.js >= 22.13.'
}
else {
    $nodeVer = (& $NodeCmd.Source -v 2>$null | Out-String).Trim()
    if ($nodeVer -match '^v(\d+)\.(\d+)\.') {
        $nMaj = [int]$Matches[1]
        $nMin = [int]$Matches[2]
        if (($nMaj -lt 22) -or (($nMaj -eq 22) -and ($nMin -lt 13))) {
            Write-Warning "Node.js $nodeVer detected (< v22.13). Margin node:sqlite memory queries will degrade gracefully."
        }
        else {
            Write-Output "    [PASS] Node.js $nodeVer"
        }
    }
}

$PyHookCmd = Get-EffectivePythonHookCmd -PythonInfo $PyInfo
$PyCmdLine = if ($null -ne $PyInfo) { $PyInfo.CmdLine } else { 'python' }

# 2. Prepare directories
Write-Output '==> Preparing target directories...'
foreach ($dir in @(
    $LocalBinDir,
    $GeminiConfigDir,
    $GeminiPluginsDir,
    $GeminiConfigSkillsDir,
    $GeminiCliDir,
    $GeminiCliSkillsDir,
    $AgentsDir,
    $AgentsSkillsDir,
    $AgentsDiagnosticsDir,
    $ConfigStatsDir
)) {
    Ensure-Directory -Path $dir
}

# 3. Deploy helper scripts + .cmd launchers
Write-Output '==> Deploying portable helper launchers into %USERPROFILE%\.local\bin\...'
$diagSrcPath = [System.IO.Path]::Combine($ScriptDir, 'bin', 'agy-diagnostics')
$statsSrcPath = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'stats', 'bin', 'agy-stats')
Deploy-FileEntry -Src $diagSrcPath -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics'))
Deploy-GeneratedFile -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics.cmd')) -Content (Get-CmdShimContent -ScriptName 'agy-diagnostics' -PythonCmdLine $PyCmdLine)
Deploy-FileEntry -Src $statsSrcPath -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats'))
Deploy-GeneratedFile -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats.cmd')) -Content (Get-CmdShimContent -ScriptName 'agy-stats' -PythonCmdLine $PyCmdLine)

# 4. Deploy ~/.gemini/config/ items and portable plugins
Write-Output '==> Deploying Antigravity configuration into %USERPROFILE%\.gemini\config\...'
Deploy-FileEntry -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'GEMINI.md')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'GEMINI.md'))
Deploy-FileEntry -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'mcp_config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'mcp_config.json'))
Deploy-TemplateFile -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'config.json')) -Label '~/.gemini/config/config.json'

foreach ($pname in $PortablePlugins) {
    $pSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', $pname)
    $pDest = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
    $useJuncForPlugin = ($Junction -and ($RewrittenPlugins -notcontains $pname))
    Deploy-DirectoryEntry -SrcDir $pSrc -DestDir $pDest -UseJunction:$useJuncForPlugin -PluginName $pname -PythonHookCmd $PyHookCmd
}

# 5. Deploy portable skills (per-skill so existing user skills are never clobbered)
Write-Output '==> Deploying portable skills...'
$PortableSkills = Get-PortableSkillDirs
foreach ($s in $PortableSkills) {
    $sname = $s.Name
    Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, $sname)) -UseJunction:$Junction
    Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiConfigSkillsDir, $sname)) -UseJunction:$Junction
    Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiCliSkillsDir, $sname)) -UseJunction:$Junction
}

# 6. Deploy mutable agy-stats config template (keys/ is never deployed)
$statsCfgSrc = [System.IO.Path]::Combine($ScriptDir, 'config-extra', 'agy-stats', 'config.json')
if ([System.IO.File]::Exists($statsCfgSrc)) {
    Deploy-TemplateFile -Src $statsCfgSrc -Dest ([System.IO.Path]::Combine($ConfigStatsDir, 'config.json')) -Label '~/.config/agy-stats/config.json'
}

# 7. Deploy Windows settings.json template
Write-Output '==> Configuring %USERPROFILE%\.gemini\antigravity-cli\settings.json...'
$winTemplate = [System.IO.Path]::Combine($ScriptDir, 'templates', 'settings.windows.json.template')
Deploy-TemplateFile -Src $winTemplate -Dest ([System.IO.Path]::Combine($GeminiCliDir, 'settings.json')) -Label '~/.gemini/antigravity-cli/settings.json'

# 8. Post-install verification
Write-Output '==> Verifying installation...'
if ($null -ne $PyInfo) {
    foreach ($pyBinName in @('agy-diagnostics', 'agy-stats')) {
        $pyTarget = [System.IO.Path]::Combine($LocalBinDir, $pyBinName)
        if ([System.IO.File]::Exists($pyTarget)) {
            $compileArgs = @()
            $compileArgs += $PyInfo.PrefixArgs
            $compileArgs += @('-m', 'py_compile', $pyTarget)
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & $PyInfo.Exe @compileArgs 2>$null
            $code = $LASTEXITCODE
            $ErrorActionPreference = $oldPref
            if ($code -eq 0) {
                Write-Output "    [PASS] $pyBinName syntax OK"
            }
            else {
                Write-Output "    [WARN] $pyBinName syntax verification warning"
            }
        }
    }
}

if ($null -ne $NodeCmd) {
    foreach ($mjsRel in @('mcp\server.mjs', 'lib\agy-worker.mjs')) {
        $mjsTarget = [System.IO.Path]::Combine($GeminiPluginsDir, 'margin', $mjsRel)
        if ([System.IO.File]::Exists($mjsTarget)) {
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & $NodeCmd.Source --check $mjsTarget 2>$null
            $code = $LASTEXITCODE
            $ErrorActionPreference = $oldPref
            if ($code -eq 0) {
                Write-Output "    [PASS] margin/$mjsRel syntax OK"
            }
            else {
                Write-Output "    [WARN] margin/$mjsRel syntax verification warning"
            }
        }
    }
}

foreach ($optCmd in @('git', 'npx', 'agy', 'sqlite3', 'bun', 'ruff')) {
    $found = Get-Command $optCmd -ErrorAction SilentlyContinue
    if ($null -ne $found) {
        Write-Output "    [PASS] $optCmd ($($found.Source))"
    }
    else {
        Write-Output "    [OPT]  $optCmd not found in PATH"
    }
}

$pathEntries = ($env:PATH -split ';') | ForEach-Object { $_.Trim().TrimEnd('\').ToLowerInvariant() }
$normLocalBin = $LocalBinDir.TrimEnd('\').ToLowerInvariant()
if ($pathEntries -contains $normLocalBin) {
    Write-Output "    [PASS] $LocalBinDir is in PATH"
}
else {
    Write-Output "    [NOTICE] $LocalBinDir is NOT in your current PATH."
    Write-Output '    Add it for your user account if you want agy-stats / agy-diagnostics in any shell:'
    Write-Output "    [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$LocalBinDir', 'User')"
}

Write-Output ''
Write-Output '==> gravityzilla Windows setup completed!'
Write-Output "    Config root: $GeminiConfigDir"
Write-Output "    Binaries:    $LocalBinDir"
Write-Output "    Mode:        $modeLabel"
Write-Output '    Included:    GEMINI.md, 16 skills, configs, gemini-api, playwright, margin, stats, diagnostics'
Write-Output '    Skipped:     desktop-patch, watchdog, agy-statusline, memory/compound, rtk, ship'
if ($script:SkipCount -gt 0) {
    Write-Output "    Preserved:   $($script:SkipCount) existing target(s) (re-run with -Force to back up and replace)"
}
