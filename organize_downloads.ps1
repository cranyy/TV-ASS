### SCRIPT TO AUTOMATICALLY ORGANIZE TRADINGVIEW STRATEGY CSV FILES ###

function Sanitize-QuotedBooleanValues {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    try {
        $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    } catch {
        Write-Warning "  - Unable to read file '$Path' for sanitation: $_"
        return $false
    }

    $doubleQuotedPattern = '(?im),\s*"\s*(true|false)\s*"\s*(?=,|\r?\n|$)'
    $singleQuotedPattern = "(?im),\s*'\s*(true|false)\s*'\s*(?=,|\r?\n|$)"

    $updated = $content
    $hasChange = $false

    $updated = [regex]::Replace($updated, $doubleQuotedPattern, { param($match) "," + $match.Groups[1].Value.ToLowerInvariant() })
    if ($updated -ne $content) {
        $hasChange = $true
        $content = $updated
    }

    $updated = [regex]::Replace($content, $singleQuotedPattern, { param($match) "," + $match.Groups[1].Value.ToLowerInvariant() })
    if ($updated -ne $content) {
        $hasChange = $true
        $content = $updated
    }

    if ($hasChange) {
        try {
            Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
            Write-Host "  - Sanitized quoted boolean parameters inside file." -ForegroundColor Cyan
        } catch {
            Write-Warning "  - Failed to sanitize file '$Path': $_"
            return $false
        }
    }

    return $hasChange
}

function Get-StrategyMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FileName,

        [Parameter(Mandatory = $true)]
        [string] $RawPattern,

        [Parameter(Mandatory = $true)]
        [string] $FormattedPattern
    )

    $rawMatch = [System.Text.RegularExpressions.Regex]::Match($FileName, $RawPattern)
    if ($rawMatch.Success) {
        return @{ Match = $rawMatch; Type = 'raw' }
    }

    $formattedMatch = [System.Text.RegularExpressions.Regex]::Match($FileName, $FormattedPattern)
    if ($formattedMatch.Success) {
        return @{ Match = $formattedMatch; Type = 'formatted' }
    }

    return $null
}

function Process-StrategyCsv {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo] $File,

        [Parameter(Mandatory = $true)]
        [System.Text.RegularExpressions.Match] $Match,

        [System.Collections.Generic.HashSet[string]] $ProcessedSet,

        [string] $PatternType,

        [string] $WatchFolder,

        [switch] $IsInitial
    )

    if (-not $File) {
        return $false
    }

    if (-not $Match -or -not $Match.Success) {
        return $false
    }

    if ($IsInitial) {
        Write-Host "----------------------------------------"
        Write-Host "Existing file detected: $($File.Name)" -ForegroundColor Cyan
        Write-Host "Processing existing file..."
    } else {
        Write-Host "Processing file..."
    }

    try {
        if ($ProcessedSet) {
            $ProcessedSet.Add($File.FullName) | Out-Null
        }

        Start-Sleep -Seconds 1

        Sanitize-QuotedBooleanValues -Path $File.FullName | Out-Null

        $primaryTicker = $Match.Groups['primary'].Value.ToUpperInvariant()
        $secondaryTicker = if ($Match.Groups['secondary'].Success) { $Match.Groups['secondary'].Value.ToUpperInvariant() } else { $null }
        $ticker = if ($secondaryTicker) { $secondaryTicker } else { $primaryTicker }

        $invariantCulture = [System.Globalization.CultureInfo]::InvariantCulture
        $netValue = [double]::Parse($Match.Groups['net'].Value, $invariantCulture)
        $winRate = [double]::Parse($Match.Groups['wr'].Value, $invariantCulture)
        $drawdownValue = [double]::Parse($Match.Groups['dd'].Value, $invariantCulture)

        $fileSuffix = $null
        if ($Match.Groups['suffix'].Success) {
            $fileSuffix = $Match.Groups['suffix'].Value
        }

        if ([string]::IsNullOrWhiteSpace($PatternType)) {
            $PatternType = 'raw'
        }

        if ($PatternType -eq 'formatted') {
            $netPercent = $netValue
            $winRatePercent = $winRate
            $drawdownPercent = $drawdownValue
        } else {
            # Raw format: values are already percentage ×100 (6315 = 63.15%), so divide by 100
            $netPercent = $netValue / 100
            $winRatePercent = $winRate / 100
            $drawdownPercent = $drawdownValue / 100
        }

        $targetRoot = if ($WatchFolder) { $WatchFolder } else { $File.DirectoryName }
        $destinationFolder = Join-Path -Path $targetRoot -ChildPath $ticker
        if (-not (Test-Path -Path $destinationFolder)) {
            Write-Host "  - Creating new folder: $destinationFolder"
            New-Item -ItemType Directory -Path $destinationFolder | Out-Null
        }


        # Parse the passthrough suffix into TF / Range / final / leftover tokens
        $tfValue = $null
        $rangeRaw = $null
        $isFinal = $false
        $optDir = $null
        $optName = $null
        $extraTokens = @()
        if ($fileSuffix) {
            foreach ($tok in ($fileSuffix -split '_')) {
                if ([string]::IsNullOrWhiteSpace($tok)) { continue }
                if ($tok -match '^TF(.+)$')         { $tfValue = $Matches[1] }
                elseif ($tok -match '^RANGE(.+)$')  { $rangeRaw = $Matches[1] }
                elseif ($tok -ieq 'final')          { $isFinal = $true }
                elseif ($tok -match '^(max|min)value-(.+)$') { $optDir = $Matches[1]; $optName = $Matches[2] }
                else                                { $extraTokens += $tok }
            }
        }

        # Reformat the range: jun-12-2024--jun-14-2026 -> Jun 12 2024 - Jun 14 2026 (raw fallback on any miss)
        $rangePretty = $rangeRaw
        if ($rangeRaw) {
            $ci = [System.Globalization.CultureInfo]::InvariantCulture
            $prettyDates = @()
            $rangeOk = $true
            foreach ($d in ($rangeRaw -split '--')) {
                $seg = $d -split '-'
                if ($seg.Count -ge 3) {
                    $mon = $ci.TextInfo.ToTitleCase($seg[0].ToLowerInvariant())
                    $prettyDates += ("{0} {1} {2}" -f $mon, $seg[1], $seg[2])
                } else {
                    $rangeOk = $false
                    break
                }
            }
            if ($rangeOk -and $prettyDates.Count -ge 1) { $rangePretty = $prettyDates -join ' - ' }
            else { $rangePretty = $rangeRaw }
        }

        # Created stamp inner text: dd.MM.yy HHhmm (space between date and time; 'h' literal via separate ToString calls)
        $createdInner = "{0} {1}h{2}" -f $File.CreationTime.ToString('dd.MM.yy'), $File.CreationTime.ToString('HH'), $File.CreationTime.ToString('mm')

        # Assemble (ticker UPPERCASE; empty TF/Range segments omitted; _FINAL appended after the Created bracket)
        $namePieces = @()
        $namePieces += ("{0}-[{1:N2}% Net, {2:0.##}% WR, {3:N2}% DD]" -f $ticker, $netPercent, $winRatePercent, $drawdownPercent)
        if ($tfValue)     { $namePieces += ("TF-[{0}]" -f $tfValue) }
        if ($rangePretty) { $namePieces += ("Range-[{0}]" -f $rangePretty) }
        foreach ($x in $extraTokens) { $namePieces += $x }
        $namePieces += ("Created-[{0}]" -f $createdInner)
        if ($optName) {
            $optLabel = if ($optDir -ieq 'min') { 'Min Value' } else { 'Max Value' }
            $namePieces += ("{0}-[{1}]" -f $optLabel, $optName)
        }
        $newFileName = ($namePieces -join ', ')
        if ($isFinal) { $newFileName += '_FINAL' }
        $newFileName += '.csv'
        $newFilePath = Join-Path -Path $destinationFolder -ChildPath $newFileName

        Write-Host "  - Moving and renaming to: $newFilePath"
        Move-Item -LiteralPath $File.FullName -Destination $newFilePath -Force

        if ($ProcessedSet) {
            $ProcessedSet.Add($newFilePath) | Out-Null
        }

        Write-Host "SUCCESS: Succesfully converted file to -> '$newFileName'" -ForegroundColor Green

    } catch {
        Write-Error "CRITICAL ERROR processing file '$($File.Name)': $_"
        return $false
    }

    return $true
}

# --- CONFIGURATION ---
$checkIntervalSeconds = 2 # How often to check for new files.
$rawFilePattern = '(?ix)^(?<primary>[A-Z0-9]+)(?:_(?<secondary>[A-Z0-9]+))?_(?<net>-?\d+(?:\.\d+)?)net_(?<wr>\d+(?:\.\d+)?)wr_(?<dd>\d+(?:\.\d+)?)dd(?:_(?<suffix>[A-Z0-9\x20%&#\.\-\[\]]+(?:_[A-Z0-9\x20%&#\.\-\[\]]+)*))?\.csv$'
$formattedFilePattern = '(?ix)^(?<primary>[A-Z0-9]+)(?:_(?<secondary>[A-Z0-9]+))?_(?<net>-?\d+(?:\.\d+)?)%net_(?<wr>-?\d+(?:\.\d+)?)%wr_(?<dd>-?\d+(?:\.\d+)?)%dd(?:_(?<suffix>[A-Z0-9\x20%&#\.\-\[\]]+(?:_[A-Z0-9\x20%&#\.\-\[\]]+)*))?\.csv$'

$scriptDir  = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$configPath = Join-Path $scriptDir 'organizer.config'

function Get-DefaultDownloadsFolder {
    $key  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $guid = '{374DE290-123F-4565-9164-39C4925E467B}'
    try {
        $raw = (Get-ItemProperty -Path $key -Name $guid -ErrorAction Stop).$guid
        if ($raw) {
            $expanded = [Environment]::ExpandEnvironmentVariables($raw)
            if ($expanded -and (Test-Path -LiteralPath $expanded)) { return $expanded }
        }
    } catch {}
    return (Join-Path $env:USERPROFILE 'Downloads')
}

function Get-SavedWatchFolder {
    try {
        if (Test-Path -LiteralPath $configPath) {
            $saved = (Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop).Trim()
            if ($saved -and (Test-Path -LiteralPath $saved)) { return $saved }
        }
    } catch {}
    return $null
}

function Save-WatchFolder {
    param([string]$Path)
    try { Set-Content -LiteralPath $configPath -Value $Path -Encoding UTF8 -ErrorAction Stop }
    catch { Write-Warning "Could not save your choice to '$configPath': $_" }
}

function Select-WatchFolder {
    param([string]$Current)
    $startPath = if ($Current -and (Test-Path -LiteralPath $Current)) { $Current } else { Get-DefaultDownloadsFolder }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description         = 'Where do your TradingView CSVs download to?'
        $dlg.SelectedPath        = $startPath
        $dlg.ShowNewFolderButton = $false
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            if ($dlg.SelectedPath -and (Test-Path -LiteralPath $dlg.SelectedPath)) {
                return (Resolve-Path -LiteralPath $dlg.SelectedPath).Path
            }
        }
        return $Current   # cancelled or invalid -> keep what we had
    } catch {
        $entry  = Read-Host "Folder to watch (Enter = $startPath)"
        $picked = if ([string]::IsNullOrWhiteSpace($entry)) { $startPath } else { $entry.Trim().Trim('"') }
        if ($picked -and (Test-Path -LiteralPath $picked)) { return (Resolve-Path -LiteralPath $picked).Path }
        return $Current
    }
}

$watchFolder = Get-SavedWatchFolder
if (-not $watchFolder) {
    $watchFolder = Select-WatchFolder -Current (Get-DefaultDownloadsFolder)
    if ($watchFolder) { Save-WatchFolder -Path $watchFolder }
}
$startWatching = $false
while (-not $startWatching) {
    Clear-Host
    Write-Host "=== TradingView CSV Organizer ===" -ForegroundColor Green
    Write-Host "Sorts your downloaded TradingView CSVs into per-symbol folders and gives them clean names."
    Write-Host ""
    $shown = if ($watchFolder) { $watchFolder } else { '(not set)' }
    Write-Host ("Watching:  {0}" -f $shown) -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [1] Start      [2] Change folder      [3] Quit"
    Write-Host ""
    Write-Host "Press 1, 2 or 3..." -NoNewline
    # single keypress, no Enter (fallback to Read-Host if no interactive console)
    try   { $choice = ([System.Console]::ReadKey($true)).KeyChar }
    catch { $choice = (Read-Host).Trim() }
    Write-Host ""
    switch ("$choice") {
        '1' {
            if ($watchFolder -and (Test-Path -LiteralPath $watchFolder)) { $startWatching = $true }
            else { Write-Host "Pick a valid folder first (press 2)." -ForegroundColor Yellow; Start-Sleep -Seconds 2 }
        }
        '2' {
            $picked = Select-WatchFolder -Current $watchFolder
            if ($picked) { $watchFolder = $picked; Save-WatchFolder -Path $watchFolder }
        }
        '3' { return }
        default { }
    }
}

# --- SCRIPT LOGIC ---
Write-Host "Initializing script..." -ForegroundColor Green
Write-Host "Scanning for all existing CSV files to prevent duplicates..."

# Get the initial list of ALL CSV files in the Downloads folder and its subfolders.
# This prevents re-processing files that have already been organized.
$processedFiles = New-Object 'System.Collections.Generic.HashSet[string]'
try {
    $initialFiles = Get-ChildItem -Path $watchFolder -Filter "*.csv" -Recurse
    foreach ($file in $initialFiles) {
        if ($file.DirectoryName -eq $watchFolder) {
            $matchInfo = Get-StrategyMatch -FileName $file.Name -RawPattern $rawFilePattern -FormattedPattern $formattedFilePattern
            if ($matchInfo) {
                if (Process-StrategyCsv -File $file -Match $matchInfo.Match -PatternType $matchInfo.Type -ProcessedSet $processedFiles -WatchFolder $watchFolder -IsInitial) {
                    $processedFiles.Add($file.FullName) | Out-Null
                    continue
                }
            }
        }
        $processedFiles.Add($file.FullName) | Out-Null
    }
} catch {
    Write-Error "Could not perform initial scan of existing files: $_"
}

Write-Host "Found $($processedFiles.Count) existing CSV files to ignore."
Write-Host "Watcher is now active. Press Ctrl+C to stop."
Write-Host "----------------------------------------"

while ($true) {
    try {
        # Get the current list of CSV files from the main Downloads folder only.
        $currentFiles = Get-ChildItem -Path $watchFolder -Filter "*.csv" -ErrorAction SilentlyContinue

        foreach ($file in $currentFiles) {
            # Check if we have already processed this file.
            if (-not $processedFiles.Contains($file.FullName)) {

                Write-Host "----------------------------------------"
                Write-Host "New file detected: $($file.Name)" -ForegroundColor Yellow

                $matchInfo = Get-StrategyMatch -FileName $file.Name -RawPattern $rawFilePattern -FormattedPattern $formattedFilePattern
                if (-not $matchInfo) {
                    Write-Host "Filename does not match expected structure. Skipping." -ForegroundColor Gray
                } else {
                    try {
                        if (Process-StrategyCsv -File $file -Match $matchInfo.Match -PatternType $matchInfo.Type -ProcessedSet $processedFiles -WatchFolder $watchFolder) {
                            continue
                        }
                    } catch {
                        Write-Error "CRITICAL ERROR processing file '$($file.Name)': $_"
                    }
                }
                # Add the original path to the processed list regardless of match, to avoid re-checking it.
                $processedFiles.Add($file.FullName) | Out-Null
            }
        }
    } catch {
        Write-Error "An unexpected error occurred in the main loop: $_"
    }

    # Wait for the next check.
    Start-Sleep -Seconds $checkIntervalSeconds
}
