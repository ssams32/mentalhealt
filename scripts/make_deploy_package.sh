#!/bin/bash

# ==============================================================================
# IMHC NAS 배포 패키지 빌드 및 추출 스크립트 (Mac 전용)
# ==============================================================================

# 스크립트 오류 발생 시 즉시 중단
set -e

# 경로 정의
PROJECT_ROOT="/Users/ssams32/Desktop/gas-export"
TARGET_DIR="/Users/ssams32/Desktop/IMHC_UPDATE_FINAL"
ZIP_FILE="/Users/ssams32/Desktop/IMHC_UPDATE_FINAL.zip"

echo "=================================================="
echo "🚀 IMHC 배포 패키지 생성을 시작합니다."
echo "=================================================="

# 1. 대상 폴더 및 압축파일 초기화
echo "📁 1. 기존 배포 폴더 및 압축 파일이 있으면 삭제 후 새로 생성 중..."
if [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
fi
if [ -f "$ZIP_FILE" ]; then
    rm -f "$ZIP_FILE"
fi
mkdir -p "$TARGET_DIR"

# 2. 프로젝트 루트로 이동 및 최신 소스 빌드
cd "$PROJECT_ROOT"
echo "🛠️ 2. 최신 프론트엔드 코드 빌드 중 (npm run build:local)..."
npm run build:local

# 3. 폴더 구조 생성
echo "📂 3. 배포 패키지 구조 생성 중..."
mkdir -p "$TARGET_DIR/dist"
mkdir -p "$TARGET_DIR/app/data"

# 4. 파일 복사
echo "📦 4. 필수 파일 복사 중..."

# dist/ 폴더 전체 복사 (빌드 결과물인 dist-local의 결과가 Dockerfile 설정에 맞춤)
if [ -d "dist-local" ]; then
    cp -R dist-local/* "$TARGET_DIR/dist/"
    echo "  ✅ dist-local 복사 완료 (dist 폴더로 통합)"
elif [ -d "dist" ]; then
    cp -R dist/* "$TARGET_DIR/dist/"
    echo "  ✅ dist 복사 완료"
else
    echo "  ⚠️ 경고: 빌드 결과물 폴더(dist-local 또는 dist)를 찾을 수 없습니다."
fi

# app/data/sampleBudgetHierarchy.json 복사 (샘플 계층 구조)
if [ -f "components/budget/sampleBudgetHierarchy.json" ]; then
    cp "components/budget/sampleBudgetHierarchy.json" "$TARGET_DIR/app/data/sampleBudgetHierarchy.json"
    echo "  ✅ sampleBudgetHierarchy.json 복사 완료"
else
    echo "  ⚠️ 경고: sampleBudgetHierarchy.json 원본 파일을 찾을 수 없습니다."
fi

# .env 복사
if [ -f ".env" ]; then
    cp ".env" "$TARGET_DIR/.env"
    echo "  ✅ .env 복사 완료"
else
    echo "  ⚠️ 경고: .env 파일을 찾을 수 없습니다."
fi

# 루트 실행 파일들 및 docker-compose.yml 복사
cp server.js "$TARGET_DIR/server.js"
cp package.json "$TARGET_DIR/package.json"
cp package-lock.json "$TARGET_DIR/package-lock.json"
cp Dockerfile "$TARGET_DIR/Dockerfile"
if [ -f "docker-compose.yml" ]; then
    cp docker-compose.yml "$TARGET_DIR/docker-compose.yml"
    echo "  ✅ docker-compose.yml 복사 완료"
fi
echo "  ✅ 루트 파일들(server.js, package.json, package-lock.json, Dockerfile) 복사 완료"

# 5. 폴더 압축 진행
echo "🤐 5. 배포용 압축 파일 생성 중 (IMHC_UPDATE_FINAL.zip)..."
cd /Users/ssams32/Desktop
zip -r IMHC_UPDATE_FINAL.zip IMHC_UPDATE_FINAL/ > /dev/null
echo "  ✅ 압축 파일 생성 완료"

echo "=================================================="
echo "🎉 배포 패키지 추출 & 압축 성공!"
echo "📍 폴더 경로: $TARGET_DIR"
echo "📍 압축 파일: $ZIP_FILE"
echo "=================================================="

# 6. 바탕화면에 생성된 압축 파일을 Finder 창으로 선택 강조하여 띄우기
open -R "$ZIP_FILE"
