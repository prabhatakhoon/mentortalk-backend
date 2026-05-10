# .\update.ps1 mentortalk-support "fix ticket auto-creation bug"
#
# Hardened: aborts on any failure and validates the produced zip is a real
# PK archive before upload. Prevents the "tag lies" trap where a locked
# lambda.zip or a malformed tar would let git claim a successful deploy
# while AWS still ran the previous version. See
# aws-operations-manual.md "Recovering from an interrupted deploy".

param(
    [Parameter(Position=0)]
    [string]$LambdaName,

    [Parameter(Position=1)]
    [string]$CommitMessage
)

$ErrorActionPreference = 'Stop'

if (-not $LambdaName -or -not $CommitMessage) {
    Write-Host "Usage: .\update.ps1 <lambda-name> `"commit message`"" -ForegroundColor Red
    exit 1
}

$SourceDir = ".\$LambdaName"
$ZipFile   = ".\lambda.zip"

function Abort($message) {
    Write-Host "ABORT: $message" -ForegroundColor Red
    exit 1
}

# ── 1. Stage, commit, push ──
git add $SourceDir
git commit -m "$LambdaName : $CommitMessage"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nothing to commit - aborting deploy." -ForegroundColor Red
    exit 1
}
git push
if ($LASTEXITCODE -ne 0) { Abort "git push failed" }

# ── 2. Build a fresh zip ──
# If lambda.zip is locked (Explorer preview, stale handle, prior aws upload
# still draining), Remove-Item throws and we abort here. Letting tar overwrite
# a locked file silently produced malformed archives in past incidents.
if (Test-Path $ZipFile) {
    try {
        Remove-Item $ZipFile -Force
    } catch {
        Abort "Could not remove existing $ZipFile (locked by another process?). Close anything holding it and retry. $($_.Exception.Message)"
    }
}

Push-Location $SourceDir
try {
    tar -acf ..\lambda.zip *
    if ($LASTEXITCODE -ne 0) { Abort "tar failed (exit $LASTEXITCODE) - run this from PowerShell, not Bash" }
} finally {
    Pop-Location
}

# Verify magic bytes 50 4B 03 04 (PK zip). Catches the GNU-tar-on-Bash case
# where lambda.zip would actually be a plain tarball that AWS rejects.
if (-not (Test-Path $ZipFile)) { Abort "Expected $ZipFile but it wasn't created" }
$bytes = [byte[]]::new(4)
$fs = [System.IO.File]::OpenRead((Resolve-Path $ZipFile))
try { [void]$fs.Read($bytes, 0, 4) } finally { $fs.Close() }
$magic = [BitConverter]::ToString($bytes)
if ($magic -ne '50-4B-03-04') {
    Abort "lambda.zip is not a valid PK zip (magic=$magic). Run from PowerShell, not Bash - Bash's GNU tar produces tarballs that AWS rejects."
}

# ── 3. Upload to AWS ──
aws lambda update-function-code `
    --function-name $LambdaName `
    --zip-file "fileb://$ZipFile" `
    --query "[LastModified,CodeSha256,LastUpdateStatus]" `
    --output json
if ($LASTEXITCODE -ne 0) { Abort "aws lambda update-function-code failed (exit $LASTEXITCODE)" }

# ── 4. Tag the deploy ──
# Reached only when every step above succeeded - prevents the "tag lies" trap.
$shortHash = git rev-parse --short HEAD
git tag -f "deploy/$LambdaName/latest" HEAD
if ($LASTEXITCODE -ne 0) { Abort "git tag failed" }
git push -f origin "deploy/$LambdaName/latest"
if ($LASTEXITCODE -ne 0) { Abort "git push tag failed" }

Write-Host "Deployed $LambdaName at $shortHash successfully." -ForegroundColor Green
