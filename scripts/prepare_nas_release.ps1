$deployName = "NAS_RELEASE_20260426"
$target = "$PSScriptRoot\$deployName"

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Path $target

# 1. Front-end (dist-local -> dist)
Write-Host "Copying Build Artifacts..." -ForegroundColor Green
Copy-Item -Path "dist-local" -Destination "$target\dist" -Recurse

# 2. Server Files
Write-Host "Copying Server Files..." -ForegroundColor Green
$files = @("server.js", "package.json", "package-lock.json", ".dockerignore")
foreach ($f in $files) {
    if (Test-Path $f) { Copy-Item $f $target }
}

# 3. Docker Config
# We'll create a lean Dockerfile that doesn't build
Write-Host "Creating Production Dockerfile..." -ForegroundColor Cyan
$dockerfile = @"
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY dist ./dist
COPY server.js ./
RUN mkdir -p /app/data /app/attachments
ENV PORT=3001 NODE_ENV=production TZ=Asia/Seoul FRONTEND_DIST=/app/dist
EXPOSE 3001
CMD ["node", "server.js"]
"@
$dockerfile | Out-File -FilePath "$target\Dockerfile" -Encoding utf8

# Copy docker-compose.yml
Copy-Item "docker-compose.yml" $target

# 4. Data
# Only copy JSON files to preserve existing work
Write-Host "Preserving Data Files..." -ForegroundColor Green
New-Item -ItemType Directory -Path "$target\app\data" -Force | Out-Null
if (Test-Path "app\data") {
    Get-ChildItem "app\data" -Filter "*.json" | Copy-Item -Destination "$target\app\data"
}

# 5. README
$readme = @"
=== 시놀로지 NAS 배포 패키지 (2026-04-26) ===

이 폴더는 PC에서 미리 빌드된 파일들을 포함하고 있어, 
NAS에서 직접 빌드할 필요가 없으므로 훨씬 빠르고 안정적으로 실행됩니다.

[배포 방법]
1. 시놀로지 File Station을 통해 NAS의 원하는 위치(예: /volume2/docker/imhc)에 
   이 폴더 안의 모든 파일들을 업로드하세요.
2. 관런 폴더 권한을 'Everyone' 또는 'Docker' 사용자에게 읽기/쓰기 권한을 주어야 합니다.
   (특히 app/data 폴더)
3. 시놀로지 Container Manager -> 프로젝트 -> 생성
   - 프로젝트 이름: referral-system
   - 경로: 방금 파일을 업로드한 폴더 선택
   - 'docker-compose.yml'을 사용하여 시작

[정보]
- 내부 포트: 3001
- 외부 접속 포트: 3000 (docker-compose.yml에서 변경 가능)
- 관리자 계정 정보는 서버 로그 또는 .env 설정을 확인하세요.
"@
$readme | Out-File -FilePath "$target\README_NAS.txt" -Encoding utf8

Write-Host "Done! Package created at: $target" -ForegroundColor Cyan
