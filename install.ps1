<#
.SYNOPSIS
    gravityzilla: Antigravity Windows Portable Setup & Selectable Installer
.DESCRIPTION
    Deploys the portable subset of gravityzilla on Windows with selectable
    components (-Only / -Skip / -Interactive) and host detection (-List / -Json):
      - rules:       GEMINI.md, mcp_config.json, config.json, settings.json
      - skills:      Core portable agent skills (excludes Linux-only 'ship' and 'stats' plugin skill)
      - margin:      Right-pane Overview sidecar & margin_intent MCP
      - diagnostics: Post-edit syntax checks (agy-diagnostics + .cmd shim)
      - stats:       /stats telemetry & web dashboard (agy-stats + .cmd shim + /stats skill)
      - playwright:  On-demand Playwright MCP (disabled by default in config.json)

    Skips Linux-only / patching components:
      desktop-patch (agy-desktop-patch), watchdog (agy-watch), agy-statusline,
      memory (agent-memory, agy-compound), rtk, ship (git-wt-sync).
#>
[CmdletBinding()]
param(
    [switch]$Interactive,
    [switch]$Yes,
    [switch]$List,
    [switch]$Status,
    [switch]$Uninstall,
    [switch]$Force,
    [switch]$Junction,
    [switch]$Json,
    [string[]]$Only = @(),
    [string[]]$Skip = @(),
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    @"
Usage: .\install.ps1 [OPTIONS]

Modes:
  (Default on TTY) Interactive checklist to toggle portable components
  -Yes             Copy portable components non-interactively without prompting
  -Interactive     Force interactive checklist to toggle portable components
  -List            Show component inventory, host detection, and install state
  -Status          Check deployed components for drift or missing targets
  -Uninstall       Remove gravityzilla-managed files, shims, and junctions while
                   preserving local mutable configs and runtime data.

Selection & Flags:
  -Only <list>     Comma-separated or array of components to act on (implies -Yes unless -Interactive)
  -Skip <list>     Comma-separated or array of components to exclude (implies -Yes unless -Interactive)
  -Junction       Use NTFS directory junctions for skills and non-rewritten plugins
                  (playwright, margin). No Admin/Developer Mode required.
  -Json           JSON output for -List and -Status
  -Force          Back up and replace conflicting destination files/directories.
  -Help           Show this help message.

Components:
  rules, skills, margin, diagnostics, stats, playwright

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

$AllComponents = @('rules', 'skills', 'margin', 'diagnostics', 'stats', 'playwright')
$PortablePlugins = @('playwright', 'margin', 'stats', 'diagnostics')
$RewrittenPlugins = @('stats', 'diagnostics')
$ExcludedCoreSkills = @('ship', 'stats')
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

function Get-CoreSkillDirs {
    $skillsRoot = [System.IO.Path]::Combine($ScriptDir, '.agents', 'skills')
    if (-not [System.IO.Directory]::Exists($skillsRoot)) { return @() }
    $dirs = Get-ChildItem -LiteralPath $skillsRoot -Directory | Sort-Object Name
    $result = @()
    foreach ($d in $dirs) {
        if ($ExcludedCoreSkills -contains $d.Name) { continue }
        $result += $d
    }
    return $result
}

function Split-ComponentList {
    param([string[]]$Raw)
    $out = @()
    foreach ($entry in $Raw) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        foreach ($part in ($entry -split ',')) {
            $trimmed = $part.Trim().ToLowerInvariant()
            if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
                $out += $trimmed
            }
        }
    }
    return $out
}

function Resolve-ComponentSelection {
    $sel = @{}
    $onlyList = Split-ComponentList -Raw $Only
    $skipList = Split-ComponentList -Raw $Skip

    if ($onlyList.Count -gt 0) {
        foreach ($c in $AllComponents) { $sel[$c] = $false }
        foreach ($c in $onlyList) {
            if ($AllComponents -notcontains $c) {
                throw "Unknown component in -Only: '$c'. Valid components: $($AllComponents -join ', ')"
            }
            $sel[$c] = $true
        }
    }
    else {
        foreach ($c in $AllComponents) { $sel[$c] = $true }
    }

    foreach ($c in $skipList) {
        if ($AllComponents -notcontains $c) {
            throw "Unknown component in -Skip: '$c'. Valid components: $($AllComponents -join ', ')"
        }
        $sel[$c] = $false
    }
    return $sel
}

function Get-ComponentHostProbe {
    param($PythonInfo, $NodeCmd)

    $pyLabel = if ($null -ne $PythonInfo) { "python $($PythonInfo.Version)" } else { 'python missing' }
    $nodeLabel = 'node missing'
    if ($null -ne $NodeCmd) {
        $nv = (& $NodeCmd.Source -v 2>$null | Out-String).Trim()
        if ($nv) { $nodeLabel = "node $nv" } else { $nodeLabel = 'node ok' }
    }
    $agyLabel = if ($null -ne (Get-Command 'agy' -ErrorAction SilentlyContinue)) { 'agy ok' } else { 'agy missing' }
    $npxLabel = if ($null -ne (Get-Command 'npx' -ErrorAction SilentlyContinue)) { 'npx ok' } else { 'npx missing' }
    $sqLabel = if ($null -ne (Get-Command 'sqlite3' -ErrorAction SilentlyContinue)) { 'sqlite3 ok' } else { 'no sqlite3' }

    $coreSkills = Get-CoreSkillDirs
    $corePresent = 0
    foreach ($s in $coreSkills) {
        if ($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($AgentsSkillsDir, $s.Name)))) {
            $corePresent++
        }
    }
    $skillsInst = if ($coreSkills.Count -gt 0 -and $corePresent -eq $coreSkills.Count) { 'installed' } elseif ($corePresent -gt 0) { "partial ($corePresent/$($coreSkills.Count))" } else { 'not installed' }

    $rulesInst = if (($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($GeminiConfigDir, 'GEMINI.md')))) -and ([System.IO.File]::Exists([System.IO.Path]::Combine($GeminiCliDir, 'settings.json')))) { 'installed' } else { 'not installed' }
    $marginInst = if ($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($GeminiPluginsDir, 'margin')))) { 'installed' } else { 'not installed' }
    $diagInst = if (($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics')))) -and ($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($GeminiPluginsDir, 'diagnostics'))))) { 'installed' } else { 'not installed' }
    $statsInst = if (($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats')))) -and ($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($GeminiPluginsDir, 'stats'))))) { 'installed' } else { 'not installed' }
    $pwInst = if ($null -ne (Get-PathItemInfo -Path ([System.IO.Path]::Combine($GeminiPluginsDir, 'playwright')))) { 'installed' } else { 'not installed' }

    return [ordered]@{
        rules       = @{ installed = $rulesInst; detected = $agyLabel; desc = 'Global GEMINI.md, mcp_config.json, config.json, settings.json' }
        skills      = @{ installed = $skillsInst; detected = "$($coreSkills.Count) core skills"; desc = 'Portable core agent skills' }
        margin      = @{ installed = $marginInst; detected = "$nodeLabel, $sqLabel"; desc = 'Right-pane Overview sidecar & margin_intent MCP' }
        diagnostics = @{ installed = $diagInst; detected = $pyLabel; desc = 'Post-edit syntax checks (agy-diagnostics)' }
        stats       = @{ installed = $statsInst; detected = $pyLabel; desc = '/stats telemetry & web dashboard (agy-stats)' }
        playwright  = @{ installed = $pwInst; detected = "$npxLabel (disabled by default)"; desc = 'On-demand Playwright MCP' }
    }
}

function Invoke-ListCommand {
    param($Selection, $Probe)
    if ($Json) {
        $items = @()
        foreach ($c in $AllComponents) {
            $items += [PSCustomObject]@{
                name        = $c
                selected    = [bool]$Selection[$c]
                installed   = $Probe[$c].installed
                detected    = $Probe[$c].detected
                description = $Probe[$c].desc
            }
        }
        [PSCustomObject]@{ components = $items } | ConvertTo-Json -Depth 4 | Write-Output
        exit 0
    }
    Write-Output '==> gravityzilla Windows components (host detection trace):'
    foreach ($c in $AllComponents) {
        $flag = if ($Selection[$c]) { 'on ' } else { 'off' }
        Write-Output ("  {0,-13} [{1}] {2,-15} (detected: {3})" -f $c, $flag, $Probe[$c].installed, $Probe[$c].detected)
    }
    exit 0
}

function Invoke-InteractiveMenu {
    param($Selection, $Probe)
    $redirected = $false
    try {
        $redirected = [Console]::IsInputRedirected -or [Console]::IsOutputRedirected
    }
    catch {
        $redirected = $false
    }
    if ($redirected) {
        throw '-Interactive requires an interactive console session (use -Yes for non-interactive runs).'
    }

    while ($true) {
        Write-Host ''
        Write-Host '◆ ' -ForegroundColor Cyan -NoNewline
        Write-Host 'gravityzilla Windows' -ForegroundColor White -NoNewline
        $modeText = if ($Junction) { 'junction+copy' } else { 'copy' }
        Write-Host " — Select components (Mode: $modeText)" -ForegroundColor DarkGray
        for ($i = 0; $i -lt $AllComponents.Count; $i++) {
            $c = $AllComponents[$i]
            $isSel = [bool]$Selection[$c]
            $inst = $Probe[$c].installed
            $det = $Probe[$c].detected

            Write-Host '│ ' -ForegroundColor DarkGray -NoNewline
            Write-Host ("{0,2}. " -f ($i + 1)) -ForegroundColor DarkGray -NoNewline
            if ($isSel) {
                Write-Host '● ' -ForegroundColor Green -NoNewline
            }
            else {
                Write-Host '○ ' -ForegroundColor DarkGray -NoNewline
            }
            Write-Host ("{0,-13} " -f $c) -ForegroundColor $(if ($isSel) { 'Cyan' } else { 'Gray' }) -NoNewline

            $instColor = if ($inst -eq 'installed') { 'Green' } elseif ($inst -like 'partial*') { 'Yellow' } else { 'DarkGray' }
            $instLabel = if ($inst -eq 'not installed') { 'new' } else { $inst }
            Write-Host ("{0,-15} " -f $instLabel) -ForegroundColor $instColor -NoNewline

            $detColor = if ($det -match 'missing') { 'Yellow' } else { 'DarkCyan' }
            Write-Host "detected: $det" -ForegroundColor $detColor
        }
        $selNames = @($AllComponents | Where-Object { $Selection[$_] })
        Write-Host '└ ' -ForegroundColor DarkGray -NoNewline
        Write-Host ("Selected ({0}/{1}): " -f $selNames.Count, $AllComponents.Count) -ForegroundColor Green -NoNewline
        Write-Host $(if ($selNames.Count -gt 0) { $selNames -join ' ' } else { '(none)' }) -ForegroundColor White

        $raw = Read-Host 'Toggle numbers (e.g. 1 3), [a] all, [n] none, Enter to apply, [q] quit'
        if ([string]::IsNullOrWhiteSpace($raw)) { break }
        $t = $raw.Trim().ToLowerInvariant()
        if ($t -eq 'q') { Write-Host 'Cancelled.' -ForegroundColor Yellow; exit 0 }
        if ($t -eq 'a') { foreach ($c in $AllComponents) { $Selection[$c] = $true }; continue }
        if ($t -eq 'n') { foreach ($c in $AllComponents) { $Selection[$c] = $false }; continue }
        foreach ($tok in ($t -split '[\s,]+')) {
            if ($tok -match '^\d+$') {
                $idx = [int]$tok - 1
                if ($idx -ge 0 -and $idx -lt $AllComponents.Count) {
                    $c = $AllComponents[$idx]
                    $Selection[$c] = -not $Selection[$c]
                }
            }
        }
    }
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
    param($Selection, $Probe)
    $drift = 0
    $pyInfo = Find-PythonCommand
    $pyHook = Get-EffectivePythonHookCmd -PythonInfo $pyInfo
    $pyCmdLine = if ($null -ne $pyInfo) { $pyInfo.CmdLine } else { 'python' }

    $anyInstalled = $false
    foreach ($c in $AllComponents) {
        if ($Probe[$c].installed -ne 'not installed') { $anyInstalled = $true; break }
    }
    $hasFilter = ($Only.Count -gt 0) -or ($Skip.Count -gt 0)

    function Test-CheckComp {
        param([string]$Name)
        if ($hasFilter -or -not $anyInstalled) { return [bool]$Selection[$Name] }
        return ($Probe[$Name].installed -ne 'not installed')
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('==> Checking gravityzilla Windows install status...')

    if (Test-CheckComp 'rules') {
        $lines.Add("-- [rules] (detected: $($Probe['rules'].detected)):")
        $lines.Add((Check-FileStatus -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'GEMINI.md')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'GEMINI.md')) -Label '~/.gemini/config/GEMINI.md' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        $lines.Add((Check-FileStatus -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'mcp_config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'mcp_config.json')) -Label '~/.gemini/config/mcp_config.json' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        $lines.Add((Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'config.json')) -Label '~/.gemini/config/config.json' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        $lines.Add((Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($GeminiCliDir, 'settings.json')) -Label '~/.gemini/antigravity-cli/settings.json' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
    }

    if (Test-CheckComp 'skills') {
        $lines.Add("-- [skills] (detected: $($Probe['skills'].detected)):")
        foreach ($s in (Get-CoreSkillDirs)) {
            $sname = $s.Name
            $lines.Add((Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, $sname)) -Label "~/.agents/skills/$sname" -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            $lines.Add((Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiConfigSkillsDir, $sname)) -Label "~/.gemini/config/skills/$sname" -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            $lines.Add((Check-DirectoryStatus -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiCliSkillsDir, $sname)) -Label "~/.gemini/antigravity-cli/skills/$sname" -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        }
    }

    foreach ($pname in @('margin', 'diagnostics', 'stats', 'playwright')) {
        if (-not (Test-CheckComp $pname)) { continue }
        $lines.Add("-- [$pname] (detected: $($Probe[$pname].detected)):")
        if ($pname -eq 'diagnostics') {
            $diagSrc = [System.IO.Path]::Combine($ScriptDir, 'bin', 'agy-diagnostics')
            $lines.Add((Check-FileStatus -Src $diagSrc -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics')) -Label '~/.local/bin/agy-diagnostics' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            $lines.Add((Check-GeneratedStatus -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics.cmd')) -ExpectedContent (Get-CmdShimContent -ScriptName 'agy-diagnostics' -PythonCmdLine $pyCmdLine) -Label '~/.local/bin/agy-diagnostics.cmd' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        }
        elseif ($pname -eq 'stats') {
            $statsSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'stats', 'bin', 'agy-stats')
            $statsSkillSrc = [System.IO.Path]::Combine($ScriptDir, '.agents', 'skills', 'stats')
            $lines.Add((Check-FileStatus -Src $statsSrc -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats')) -Label '~/.local/bin/agy-stats' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            $lines.Add((Check-GeneratedStatus -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats.cmd')) -ExpectedContent (Get-CmdShimContent -ScriptName 'agy-stats' -PythonCmdLine $pyCmdLine) -Label '~/.local/bin/agy-stats.cmd' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            if ([System.IO.Directory]::Exists($statsSkillSrc)) {
                $lines.Add((Check-DirectoryStatus -SrcDir $statsSkillSrc -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, 'stats')) -Label '~/.agents/skills/stats' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
            }
            $lines.Add((Check-LocalConfigStatus -Dest ([System.IO.Path]::Combine($ConfigStatsDir, 'config.json')) -Label '~/.config/agy-stats/config.json' -DriftCount ([ref]$drift) | Out-String).TrimEnd())
        }
        $pSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', $pname)
        $pDest = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
        $lines.Add((Check-DirectoryStatus -SrcDir $pSrc -DestDir $pDest -Label "~/.gemini/config/plugins/$pname" -PluginName $pname -PythonHookCmd $pyHook -DriftCount ([ref]$drift) | Out-String).TrimEnd())
    }

    $lines.Add('')
    if ($drift -eq 0) {
        $lines.Add('Status: CLEAN (0 drift/missing items)')
    }
    else {
        $lines.Add("Status: $drift issue(s) found (run .\install.ps1 to reconcile)")
    }

    if ($Json) {
        [PSCustomObject]@{
            clean      = ($drift -eq 0)
            driftCount = $drift
            output     = ($lines -join "`n")
        } | ConvertTo-Json -Depth 4 | Write-Output
    }
    else {
        $lines | ForEach-Object { Write-Output $_ }
    }
    exit $(if ($drift -eq 0) { 0 } else { 1 })
}

function Invoke-Uninstall {
    param($Selection)
    Write-Output '==> Uninstalling gravityzilla Windows files and junctions...'

    if ($Selection['diagnostics']) {
        foreach ($fname in @('agy-diagnostics', 'agy-diagnostics.cmd')) {
            $p = [System.IO.Path]::Combine($LocalBinDir, $fname)
            if ($null -ne (Get-PathItemInfo -Path $p)) {
                Remove-PathSafely -Path $p
                Write-Output "  [REMOVED] $p"
            }
        }
        $p = [System.IO.Path]::Combine($GeminiPluginsDir, 'diagnostics')
        if ($null -ne (Get-PathItemInfo -Path $p)) { Remove-PathSafely -Path $p; Write-Output "  [REMOVED] $p" }
    }

    if ($Selection['stats']) {
        foreach ($fname in @('agy-stats', 'agy-stats.cmd')) {
            $p = [System.IO.Path]::Combine($LocalBinDir, $fname)
            if ($null -ne (Get-PathItemInfo -Path $p)) {
                Remove-PathSafely -Path $p
                Write-Output "  [REMOVED] $p"
            }
        }
        foreach ($root in @($GeminiConfigSkillsDir, $GeminiCliSkillsDir, $AgentsSkillsDir)) {
            $sp = [System.IO.Path]::Combine($root, 'stats')
            if ($null -ne (Get-PathItemInfo -Path $sp)) { Remove-PathSafely -Path $sp; Write-Output "  [REMOVED] $sp" }
        }
        $p = [System.IO.Path]::Combine($GeminiPluginsDir, 'stats')
        if ($null -ne (Get-PathItemInfo -Path $p)) { Remove-PathSafely -Path $p; Write-Output "  [REMOVED] $p" }
    }

    if ($Selection['rules']) {
        foreach ($cfgName in @('GEMINI.md', 'mcp_config.json')) {
            $p = [System.IO.Path]::Combine($GeminiConfigDir, $cfgName)
            if ($null -ne (Get-PathItemInfo -Path $p)) {
                Remove-PathSafely -Path $p
                Write-Output "  [REMOVED] $p"
            }
        }
    }

    foreach ($pname in @('margin', 'playwright')) {
        if (-not $Selection[$pname]) { continue }
        $p = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
        if ($null -ne (Get-PathItemInfo -Path $p)) {
            Remove-PathSafely -Path $p
            Write-Output "  [REMOVED] $p"
        }
    }

    if ($Selection['skills']) {
        $skills = Get-CoreSkillDirs
        foreach ($root in @($GeminiConfigSkillsDir, $GeminiCliSkillsDir, $AgentsSkillsDir)) {
            foreach ($s in $skills) {
                $p = [System.IO.Path]::Combine($root, $s.Name)
                if ($null -ne (Get-PathItemInfo -Path $p)) {
                    Remove-PathSafely -Path $p
                    Write-Output "  [REMOVED] $p"
                }
            }
        }
    }

    Write-Output ''
    Write-Output '==> Uninstall complete.'
    Write-Output '    Preserved local configs & runtime data (~/.gemini/config/config.json, settings.json, ~/.config/agy-stats/, ~/.agents/diagnostics/).'
    exit 0
}

$PyInfo = Find-PythonCommand
$NodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue
$Selection = Resolve-ComponentSelection
$Probe = Get-ComponentHostProbe -PythonInfo $PyInfo -NodeCmd $NodeCmd

if ($List) {
    Invoke-ListCommand -Selection $Selection -Probe $Probe
}

if ($Status) {
    Invoke-StatusCheck -Selection $Selection -Probe $Probe
}

if ($Uninstall) {
    Invoke-Uninstall -Selection $Selection
}

$IsInteractiveConsole = $false
try {
    $IsInteractiveConsole = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
}
catch {
    $IsInteractiveConsole = $false
}

$ShouldInteractive = $Interactive -or (-not $Yes -and $Only.Count -eq 0 -and $Skip.Count -eq 0 -and $IsInteractiveConsole)
if ($ShouldInteractive) {
    Invoke-InteractiveMenu -Selection $Selection -Probe $Probe
}

$modeLabel = if ($Junction) { 'junction+copy' } else { 'copy' }
Write-Output "==> Starting gravityzilla Windows setup (Mode: $modeLabel, Force: $Force)..."

# 1. Prerequisite checks
Write-Output '==> Verifying system requirements...'
if ($null -eq $PyInfo) {
    Write-Warning 'Python 3 not found in PATH (checked py -3, python, python3). Prompt, skills, and Margin will still install; stats and diagnostics hooks require Python >= 3.11.'
}
else {
    Write-Output "    [PASS] Python $($PyInfo.Version) via '$($PyInfo.HookCmd)'"
    if (($PyInfo.Major -lt 3) -or (($PyInfo.Major -eq 3) -and ($PyInfo.Minor -lt 11))) {
        Write-Warning "Python $($PyInfo.Version) detected (< 3.11). TOML diagnostics in agy-diagnostics will be skipped."
    }
}

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

# 3. Deploy selected components
Write-Output '==> Deploying selected components...'
$deployedNames = New-Object System.Collections.Generic.List[string]

if ($Selection['rules']) {
    Write-Output "-- [rules] (detected: $($Probe['rules'].detected))"
    Deploy-FileEntry -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'GEMINI.md')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'GEMINI.md'))
    Deploy-FileEntry -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'mcp_config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'mcp_config.json'))
    Deploy-TemplateFile -Src ([System.IO.Path]::Combine($ScriptDir, 'config', 'config.json')) -Dest ([System.IO.Path]::Combine($GeminiConfigDir, 'config.json')) -Label '~/.gemini/config/config.json'
    $winTemplate = [System.IO.Path]::Combine($ScriptDir, 'templates', 'settings.windows.json.template')
    Deploy-TemplateFile -Src $winTemplate -Dest ([System.IO.Path]::Combine($GeminiCliDir, 'settings.json')) -Label '~/.gemini/antigravity-cli/settings.json'
    $deployedNames.Add('rules')
}

$CoreSkills = Get-CoreSkillDirs
if ($Selection['skills']) {
    Write-Output "-- [skills] (detected: $($Probe['skills'].detected))"
    foreach ($s in $CoreSkills) {
        $sname = $s.Name
        Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, $sname)) -UseJunction:$Junction
        Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiConfigSkillsDir, $sname)) -UseJunction:$Junction
        Deploy-DirectoryEntry -SrcDir $s.FullName -DestDir ([System.IO.Path]::Combine($GeminiCliSkillsDir, $sname)) -UseJunction:$Junction
    }
    $deployedNames.Add("skills ($($CoreSkills.Count))")
}

if ($Selection['diagnostics']) {
    Write-Output "-- [diagnostics] (detected: $($Probe['diagnostics'].detected))"
    $diagSrcPath = [System.IO.Path]::Combine($ScriptDir, 'bin', 'agy-diagnostics')
    Deploy-FileEntry -Src $diagSrcPath -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics'))
    Deploy-GeneratedFile -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-diagnostics.cmd')) -Content (Get-CmdShimContent -ScriptName 'agy-diagnostics' -PythonCmdLine $PyCmdLine)
    Deploy-DirectoryEntry -SrcDir ([System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'diagnostics')) -DestDir ([System.IO.Path]::Combine($GeminiPluginsDir, 'diagnostics')) -UseJunction:$false -PluginName 'diagnostics' -PythonHookCmd $PyHookCmd
    $deployedNames.Add('diagnostics')
}

if ($Selection['stats']) {
    Write-Output "-- [stats] (detected: $($Probe['stats'].detected))"
    $statsSrcPath = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'stats', 'bin', 'agy-stats')
    Deploy-FileEntry -Src $statsSrcPath -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats'))
    Deploy-GeneratedFile -Dest ([System.IO.Path]::Combine($LocalBinDir, 'agy-stats.cmd')) -Content (Get-CmdShimContent -ScriptName 'agy-stats' -PythonCmdLine $PyCmdLine)
    Deploy-DirectoryEntry -SrcDir ([System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', 'stats')) -DestDir ([System.IO.Path]::Combine($GeminiPluginsDir, 'stats')) -UseJunction:$false -PluginName 'stats' -PythonHookCmd $PyHookCmd
    $statsSkillSrc = [System.IO.Path]::Combine($ScriptDir, '.agents', 'skills', 'stats')
    if ([System.IO.Directory]::Exists($statsSkillSrc)) {
        Deploy-DirectoryEntry -SrcDir $statsSkillSrc -DestDir ([System.IO.Path]::Combine($AgentsSkillsDir, 'stats')) -UseJunction:$Junction
        Deploy-DirectoryEntry -SrcDir $statsSkillSrc -DestDir ([System.IO.Path]::Combine($GeminiConfigSkillsDir, 'stats')) -UseJunction:$Junction
        Deploy-DirectoryEntry -SrcDir $statsSkillSrc -DestDir ([System.IO.Path]::Combine($GeminiCliSkillsDir, 'stats')) -UseJunction:$Junction
    }
    $statsCfgSrc = [System.IO.Path]::Combine($ScriptDir, 'config-extra', 'agy-stats', 'config.json')
    if ([System.IO.File]::Exists($statsCfgSrc)) {
        Deploy-TemplateFile -Src $statsCfgSrc -Dest ([System.IO.Path]::Combine($ConfigStatsDir, 'config.json')) -Label '~/.config/agy-stats/config.json'
    }
    $deployedNames.Add('stats')
}

foreach ($pname in @('margin', 'playwright')) {
    if (-not $Selection[$pname]) { continue }
    Write-Output "-- [$pname] (detected: $($Probe[$pname].detected))"
    $pSrc = [System.IO.Path]::Combine($ScriptDir, 'config', 'plugins', $pname)
    $pDest = [System.IO.Path]::Combine($GeminiPluginsDir, $pname)
    Deploy-DirectoryEntry -SrcDir $pSrc -DestDir $pDest -UseJunction:$Junction -PluginName $pname -PythonHookCmd $PyHookCmd
    $deployedNames.Add($pname)
}

# 4. Post-install verification
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

foreach ($optCmd in @('git', 'npx', 'agy', 'sqlite3', 'bun', 'ruff', 'rtk')) {
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
Write-Output "    Included:    $($deployedNames -join ', ')"
Write-Output '    Linux-only:  desktop-patch, watchdog, agy-statusline, memory/compound, rtk, ship'
if ($script:SkipCount -gt 0) {
    Write-Output "    Preserved:   $($script:SkipCount) existing target(s) (re-run with -Force to back up and replace)"
}
