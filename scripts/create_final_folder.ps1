$packageName = "NAS_UPDATE_FINAL"
$targetDir = "$PSScriptRoot\$packageName"

if (Test-Path $targetDir) { 
    Remove-Item $targetDir -Recurse -Force 
}
New-Item -ItemType Directory -Path $targetDir | Out-Null

# Copy build artifacts
if (Test-Path "dist-local") {
    Copy-Item -Path "dist-local" -Destination "$targetDir\dist" -Recurse
}

# Copy specific source files
$filesToCopy = @("server.js", "constants.ts", "types.ts", "package.json", "package-lock.json", "Dockerfile", ".dockerignore")
foreach ($file in $filesToCopy) {
    if (Test-Path $file) {
        Copy-Item -Path $file -Destination $targetDir
    }
}

# Create docker-compose.yml with specific requirements
$composeContent = @"
version: '3.8'

services:
  app:
    build: .
    image: imhc-app:latest
    container_name: imhc-referral-v3
    restart: unless-stopped
    ports:
      - "3000:3001"
    volumes:
      - ./app/data:/app/data
      - ./app/data:/app/app/data
      - ./docker/Data:/app/attachments
    environment:
      - NODE_ENV=production
      - PORT=3001
      - TZ=Asia/Seoul
      - DATA_DIR=/app/data
      - ATTACHMENTS_DIR=/app/attachments
      - FRONTEND_DIST=/app/dist
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
"@
$composeContent | Out-File -FilePath "$targetDir\docker-compose.yml" -Encoding utf8

# Setup app/data
New-Item -ItemType Directory -Path "$targetDir\app\data" -Force | Out-Null
if (Test-Path "app\data") {
    Get-ChildItem "app\data" -Filter "*.json" | Copy-Item -Destination "$targetDir\app\data"
}

Write-Host "Created: $targetDir"
