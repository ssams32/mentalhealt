$ErrorActionPreference = "Stop"

$IMAGE_NAME = "icheon-referral:latest"
# 만약 Docker Hub 등을 사용하신다면 아래와 같이 수정하세요:
# $IMAGE_NAME = "your-docker-id/icheon-referral:latest"

Write-Host "=== 1. 프론트엔드 빌드 시작 (NAS용) ===" -ForegroundColor Cyan
npm run build:local

Write-Host "`n=== 2. 도커 이미지 빌드 시작 ===" -ForegroundColor Cyan
docker build -t $IMAGE_NAME .

Write-Host "`n=== 3. 도커 이미지 푸시 (Push) ===" -ForegroundColor Cyan
Write-Host "이미지를 레지스트리에 업로드합니다..." -ForegroundColor Gray
# docker push $IMAGE_NAME

Write-Host "`n=== 완료! ===" -ForegroundColor Green
Write-Host "이제 시놀로지의 Watchtower가 이 이미지를 감지하여 자동으로 컨테이너를 업데이트할 것입니다."
Write-Host "만약 수동으로 업데이트하려면 NAS 터미널에서 다음을 실행하세요:"
Write-Host "  cd /volume2/docker/imhc" -ForegroundColor Yellow
Write-Host "  docker-compose pull && docker-compose up -d" -ForegroundColor Yellow
