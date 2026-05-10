# .\deploy-many.ps1 -Lambdas ([ordered]@{
#     'mentortalk-mentee-discover' = 'sort_order on chip strip'
#     'mentortalk-onboarding'      = 'education presign accepts pdf+image'
# })
#
# Batch deploys multiple lambdas at once. Phases:
#
#   1. Serial git: commit each lambda's source dir, capture SHAs,
#      one push for everything (single network round-trip).
#   2. Parallel AWS: spawn a Start-Job per lambda - each builds its
#      own lambda-<name>.zip and runs aws lambda update-function-code
#      independently. AWS-side these don't conflict.
#   3. Serial tag: for every lambda whose Phase-2 job succeeded, force
#      the deploy/<name>/latest tag at the captured SHA, then a single
#      git push to send all the tag updates at once.
#
# Safety: the deploy/<name>/latest tag is set ONLY when AWS upload
# succeeds for that specific lambda. A lambda that fails Phase 2 keeps
# its commit but doesn't get a misleading tag. Operator sees a per-
# lambda success/fail report at the end.
#
# Recovery for a Phase-2 failure: don't re-run deploy-many - the commit
# already landed, so git add will be a no-op. Use the manual recovery
# in aws-operations-manual.md (zip + aws update-function-code +
# force-tag).
#
# Lock-free by design:
#   - Phase 1 serial -> no .git/index.lock contention
#   - Phase 2 zips to lambda-<name>.zip -> no shared zip path
#   - Phase 3 serial -> no .git/refs/tags/... contention

param(
    [Parameter(Mandatory=$true)]
    $Lambdas
)

$ErrorActionPreference = 'Stop'

if ($Lambdas -isnot [System.Collections.IDictionary]) {
    Write-Host "ABORT: -Lambdas must be a hashtable. Example:" -ForegroundColor Red
    Write-Host '  .\deploy-many.ps1 -Lambdas ([ordered]@{ "lambda-a" = "msg a"; "lambda-b" = "msg b" })' -ForegroundColor Red
    exit 1
}

if ($Lambdas.Count -eq 0) {
    Write-Host "ABORT: -Lambdas is empty. Nothing to deploy." -ForegroundColor Red
    exit 1
}

function Abort($message) {
    Write-Host "ABORT: $message" -ForegroundColor Red
    exit 1
}

$repoRoot = (Get-Location).Path

# ── Phase 1: serial commits, single batched push ────────────────────────
Write-Host "Phase 1: committing $($Lambdas.Count) lambda(s)..." -ForegroundColor Cyan

$commitShas = [ordered]@{}
$nothingToCommit = @()

foreach ($entry in $Lambdas.GetEnumerator()) {
    $name = [string]$entry.Key
    $msg  = [string]$entry.Value
    $sourceDir = Join-Path $repoRoot $name

    if (-not (Test-Path $sourceDir)) {
        Abort "$name : source directory $sourceDir not found"
    }
    if ([string]::IsNullOrWhiteSpace($msg)) {
        Abort "$name : commit message is empty"
    }

    git add $sourceDir
    if ($LASTEXITCODE -ne 0) { Abort "$name : git add failed" }

    # Anything actually staged for this dir?
    $diff = git diff --cached --name-only -- $sourceDir
    if (-not $diff) {
        Write-Host "  - $name : nothing to commit, skipping" -ForegroundColor DarkGray
        $nothingToCommit += $name
        continue
    }

    git commit -m "$name : $msg" -- $sourceDir
    if ($LASTEXITCODE -ne 0) { Abort "$name : git commit failed" }

    $sha = (git rev-parse HEAD).Trim()
    $commitShas[$name] = $sha
    Write-Host "  + $name : committed at $($sha.Substring(0,7))" -ForegroundColor Green
}

if ($commitShas.Count -eq 0) {
    Write-Host "ABORT: nothing to commit for any lambda." -ForegroundColor Red
    exit 1
}

git push
if ($LASTEXITCODE -ne 0) {
    Abort "git push failed - $($commitShas.Count) commit(s) sit locally. Inspect with 'git log @{u}..HEAD' and push manually before retrying."
}
Write-Host "Phase 1 done: $($commitShas.Count) commit(s) pushed.`n" -ForegroundColor Green

# ── Phase 2: parallel zip + AWS upload ──────────────────────────────────
Write-Host "Phase 2: parallel zip + upload of $($commitShas.Count) lambda(s)..." -ForegroundColor Cyan

$jobs = @()
foreach ($name in $commitShas.Keys) {
    $job = Start-Job -Name "deploy-$name" -ScriptBlock {
        param($name, $repoRoot)

        $zipFile = Join-Path $repoRoot "lambda-$name.zip"
        $sourceDir = Join-Path $repoRoot $name

        try {
            if (Test-Path $zipFile) { Remove-Item $zipFile -Force }

            Push-Location $sourceDir
            try {
                tar -acf $zipFile *
                $tarExit = $LASTEXITCODE
            } finally {
                Pop-Location
            }
            if ($tarExit -ne 0) { throw "tar exited $tarExit (run from PowerShell, not Bash)" }

            # Magic-byte check - GNU tar would silently produce a tarball.
            $bytes = [byte[]]::new(4)
            $fs = [System.IO.File]::OpenRead($zipFile)
            try { [void]$fs.Read($bytes, 0, 4) } finally { $fs.Close() }
            $magic = [BitConverter]::ToString($bytes)
            if ($magic -ne '50-4B-03-04') {
                throw "lambda-$name.zip is not a valid PK zip (magic=$magic)"
            }

            $lastModified = aws lambda update-function-code `
                --function-name $name `
                --zip-file "fileb://$zipFile" `
                --region ap-south-1 `
                --query "LastModified" `
                --output text
            if ($LASTEXITCODE -ne 0) { throw "aws lambda update-function-code exited $LASTEXITCODE" }

            return @{ name = $name; ok = $true; lastModified = $lastModified.Trim() }
        } catch {
            return @{ name = $name; ok = $false; error = $_.Exception.Message }
        } finally {
            if (Test-Path $zipFile) { Remove-Item $zipFile -Force -ErrorAction SilentlyContinue }
        }
    } -ArgumentList $name, $repoRoot
    $jobs += $job
}

$results = $jobs | ForEach-Object {
    $r = Receive-Job -Wait -Job $_
    Remove-Job -Job $_
    $r
}

$succeeded = @()
$failed = @()
foreach ($r in $results) {
    if ($r.ok) {
        Write-Host "  + $($r.name) : uploaded at $($r.lastModified)" -ForegroundColor Green
        $succeeded += $r.name
    } else {
        Write-Host "  X $($r.name) : FAILED - $($r.error)" -ForegroundColor Red
        $failed += $r.name
    }
}
Write-Host "Phase 2 done: $($succeeded.Count) succeeded, $($failed.Count) failed.`n" -ForegroundColor $(if ($failed.Count -eq 0) { "Green" } else { "Yellow" })

# ── Phase 3: tag successful deploys, single batched tag-push ────────────
$tagsToPush = @()
if ($succeeded.Count -gt 0) {
    Write-Host "Phase 3: tagging $($succeeded.Count) successful deploy(s)..." -ForegroundColor Cyan
    foreach ($name in $succeeded) {
        $tagName = "deploy/$name/latest"
        $sha = $commitShas[$name]
        git tag -f $tagName $sha
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ! $name : git tag failed (deploy is live but tag wasn't moved; run 'git tag -f $tagName $sha' manually)" -ForegroundColor Yellow
            continue
        }
        $tagsToPush += $tagName
    }

    if ($tagsToPush.Count -gt 0) {
        git push -f origin @tagsToPush
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ! git push tags failed - tags exist locally; rerun: git push -f origin $($tagsToPush -join ' ')" -ForegroundColor Yellow
        } else {
            Write-Host "Phase 3 done: $($tagsToPush.Count) tag(s) pushed.`n" -ForegroundColor Green
        }
    }
}

# ── Summary ─────────────────────────────────────────────────────────────
Write-Host "=== Deploy summary ===" -ForegroundColor Cyan
foreach ($name in $succeeded) {
    Write-Host "  OK   $name @ $($commitShas[$name].Substring(0,7))" -ForegroundColor Green
}
foreach ($name in $failed) {
    Write-Host "  FAIL $name (commit @ $($commitShas[$name].Substring(0,7)) is pushed; AWS upload failed)" -ForegroundColor Red
}
foreach ($name in $nothingToCommit) {
    Write-Host "  SKIP $name (nothing to commit)" -ForegroundColor DarkGray
}

if ($failed.Count -gt 0) {
    Write-Host "`nRecover failed lambdas with the manual procedure in aws-operations-manual.md." -ForegroundColor Yellow
    exit 1
}
