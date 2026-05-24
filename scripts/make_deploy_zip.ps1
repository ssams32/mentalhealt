$ErrorActionPreference = "Stop"

Write-Host "=== 이천센터 의뢰관리시스템 NAS 배포 패키지 생성 ===" -ForegroundColor Cyan

# 배포 폴더 구성
$projectName = "referral-system"
$targetBase = "nas_deploy"
$deployPath = "$targetBase\$projectName"

# 기존 배포 폴더 초기화
if (Test-Path $deployPath) { Remove-Item $deployPath -Recurse -Force }
New-Item -ItemType Directory -Path $deployPath | Out-Null

Write-Host "배포 폴더 생성: $deployPath" -ForegroundColor Green

# 1. dist-local (빌드된 프론트엔드) -> dist 로 복사
if (Test-Path "dist-local") {
    Write-Host "프론트엔드(dist-local) 복사 중..."
    Copy-Item -Path "dist-local" -Destination "$deployPath\dist" -Recurse
    Write-Host "  -> $deployPath\dist" -ForegroundColor Green
} else {
    Write-Host "경고: dist-local 폴더가 없습니다! 빌드 먼저 실행하세요." -ForegroundColor Yellow
}

# 2. 빈 데이터/첨부파일 디렉토리 생성
New-Item -ItemType Directory -Path "$deployPath\app\data" -Force | Out-Null
New-Item -ItemType Directory -Path "$deployPath\docker\Data\attachments" -Force | Out-Null
Write-Host "데이터 폴더 생성 완료" -ForegroundColor Green

# 3. 핵심 서버 파일 복사
$serverFiles = @(
    "server.js",
    "package.json",
    "package-lock.json",
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore"
)

foreach ($file in $serverFiles) {
    if (Test-Path $file) {
        Copy-Item -Path $file -Destination "$deployPath\$file"
        Write-Host "  복사: $file" -ForegroundColor Gray
    } else {
        Write-Host "  경고: $file 파일 없음" -ForegroundColor Yellow
    }
}

# 4. 기존 데이터(Users.json 등)가 있으면 보존
if (Test-Path "app\data") {
    $dataFiles = Get-ChildItem "app\data" -Filter "*.json"
    foreach ($df in $dataFiles) {
        Copy-Item -Path $df.FullName -Destination "$deployPath\app\data\$($df.Name)"
        Write-Host "  데이터 보존: $($df.Name)" -ForegroundColor Cyan
    }
}

Write-Host ""
Write-Host "=== 배포 패키지 준비 완료 ===" -ForegroundColor Cyan
Write-Host "NAS에 '$targetBase\$projectName' 폴더를 업로드하세요."
Write-Host ""
Write-Host "NAS Docker 실행 명령:"
Write-Host "  cd /volume2/docker/imhc"
Write-Host "  docker-compose up -d --build"
Write-Host ""
Write-Host "최초 관리자 계정: admin / Admin@2026! (첫 로그인 후 변경 필수!)" -ForegroundColor Yellow
