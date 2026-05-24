$dest = ".\NAS_READY_PACKAGE"
$failed = @()

Write-Host "Cleaning up existing $dest folder..."
Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Path $dest -Force

$buildSrc = ""
if (Test-Path ".\dist-local") {
    $buildSrc = ".\dist-local"
    Write-Host "Found local build folder: dist-local"
} elseif (Test-Path ".\dist") {
    $buildSrc = ".\dist"
    Write-Host "Found production build folder: dist"
}

if ($buildSrc) {
    Write-Host "Copying build output as 'dist'..."
    Copy-Item -Path $buildSrc -Destination "$dest\dist" -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path "$dest\dist")) {
        $failed += "dist"
    }
} else {
    $failed += "dist (No build folder found)"
}

$files = @("server.js", "package.json", "package-lock.json", ".env.production")
foreach ($file in $files) {
    if (Test-Path ".\$file") {
        Write-Host "Copying $file..."
        Copy-Item -Path ".\$file" -Destination "$dest\$file" -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path "$dest\$file")) {
            $failed += $file
        }
    } else {
        $failed += "$file (Source Missing)"
    }
}

$nasFiles = @("Dockerfile", "docker-compose.yml", "README.md")
foreach ($file in $nasFiles) {
    if (Test-Path ".\nas-deploy\$file") {
        Write-Host "Copying $file from nas-deploy..."
        Copy-Item -Path ".\nas-deploy\$file" -Destination "$dest\$file" -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path "$dest\$file")) {
            $failed += $file
        }
    } else {
        $failed += "$file (nas-deploy Source Missing)"
    }
}

# Create empty data and attachments directories to make it ready-to-run
Write-Host "Creating empty data and attachments directories..."
$null = New-Item -ItemType Directory -Path "$dest\data" -Force
$null = New-Item -ItemType Directory -Path "$dest\attachments" -Force

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "=========================================="
    Write-Host "SUCCESS: All files packaged to NAS_READY_PACKAGE!"
    Write-Host "=========================================="
} else {
    Write-Host "=========================================="
    Write-Host "ERROR: Packaging failed for: $($failed -join ', ')"
    Write-Host "=========================================="
}
