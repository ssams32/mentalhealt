# Synology NAS (Watchtower + GHCR) 자동 배포 가이드

이 가이드는 **Synology NAS (/volume2/docker/imhc)** 환경에 최적화된 배포 절차입니다. PC에서의 빌드/푸시부터 NAS에서의 자동 업데이트 설정까지 포함합니다.

## 1. 개요
- **작업 디렉터리**: `/volume2/docker/imhc`
- **사용 포트**: 3000 (외부) -> 3001 (내부)
- **자동 업데이트**: Watchtower (GitHub Private Registry 인증 포함)
- **명령어**: 모든 NAS 명령어는 `sudo` 권한으로 실행

---

## 2. PC 환경 준비 (GitHub 업로드 & 이미지 푸시)

### 이미지 빌드 및 GitHub 푸시 (PC 터미널)
GitHub 상의 'Personal Access Token (classic)'이 필요합니다 (권한: `write:packages`).

```powershell
# 1. GitHub 로그인
$TOKEN = "귀하의_GitHub_토큰"
echo $TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# 2. 이미지 빌드 (referral-system-github 폴더에서 실행)
docker build -t ghcr.io/YOUR_GITHUB_USERNAME/icheon-referral:latest .

# 3. GitHub Packages로 푸시
docker push ghcr.io/YOUR_GITHUB_USERNAME/icheon-referral:latest
```

---

## 3. NAS 환경 구축 (SSH 터미널 접속 필요)

### 작업 디렉터리 이동 및 소스 업로드
NAS의 `/volume2/docker/imhc` 폴더에 `docker-compose.yml` 파일을 업로드한 후 진행합니다.

```bash
# 1. 작업 위치로 이동
cd /volume2/docker/imhc

# 2. 기존 데이터 보호 및 실행 (sudo 필수)
sudo docker-compose up -d
```

> [!IMPORTANT]
> **데이터 보존 확인**: `docker-compose.yml`의 볼륨 설정(`./app/data:/app/data`)에 의해 기존 `/volume2/docker/imhc/app/data` 폴더 안의 JSON 파일들은 안전하게 유지됩니다.

---

## 4. Watchtower 자동 업데이트 설정 (Private Registry 인증)

GitHub Packages가 **Private**인 경우, Watchtower가 이미지를 체크할 수 있도록 인증 정보를 주입해야 합니다.

### Watchtower 구동 명령어 (복사해서 사용)
`YOUR_GITHUB_USERNAME`과 `your_github_token` 부분을 실제 정보로 수정하세요.

```bash
sudo docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e REPO_USER=YOUR_GITHUB_USERNAME \
  -e REPO_PASS=your_github_token \
  containrrr/watchtower \
  --cleanup \
  --include-stopped \
  --interval 86400 \
  referral-system-v3
```

- `-e REPO_USER / REPO_PASS`: Private 레지스트리(GHCR) 접근을 위한 인증 정보입니다.
- `--interval 86400`: 24시간마다 업데이트 여부를 체크합니다 (초 단위).
- `referral-system-v3`: `docker-compose.yml`에 설정된 `container_name`입니다.

---

## 5. 최종 확인 (Troubleshooting)

### 컨테이너 상태 확인
```bash
sudo docker ps
```

### 이미지 수동 업데이트 테스트
업데이트가 즉시 반영되었는지 확인하려면 다음 명령어로 컨테이너를 다시 띄울 수 있습니다.
```bash
cd /volume2/docker/imhc
sudo docker-compose pull && sudo docker-compose up -d
```

> [!CAUTION]
> `docker-compose.yml`의 `ADMIN_INIT_PASSWORD`가 노출되지 않도록 주의하시고, 최초 1회 로그인 후 반드시 시스템 내에서 비밀번호를 변경하십시오.
