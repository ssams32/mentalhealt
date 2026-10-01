# ================================================
# NAS 배포용 Dockerfile (Multi-stage build)
# Docker 내에서 뷰를 직접 빌드하여 경로/권한 문제 방지
# ================================================

FROM node:20-alpine AS builder
WORKDIR /app
# 환경변수 증가로 메모리 부족 방지
ENV NODE_OPTIONS="--max-old-space-size=4096"
COPY package*.json ./
RUN npm install
COPY . .
# .agents 와 skills 폴더 및 로컬 데이터 폴더 삭제 (데이터 오염 방지)
RUN rm -rf .agents skills app/data
ARG VITE_TRACK_A_BASE_URL
ENV VITE_TRACK_A_BASE_URL=${VITE_TRACK_A_BASE_URL}
RUN npm run build:local

FROM node:20-alpine AS runner
WORKDIR /app

# Copy package files for production deps only
COPY package*.json ./
RUN npm install --omit=dev

# 빌드된 프론트엔드 복사
COPY --from=builder /app/dist-local ./dist

# Copy backend source
COPY server.js ./
COPY server/ ./server/

# Create directories for data persistence
RUN mkdir -p /app/data
RUN mkdir -p /app/attachments

# Environment setup
ENV PORT=3001
ENV NODE_ENV=production
ENV TZ=Asia/Seoul

# Expose port (Internal)
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start command
CMD ["node", "server.js"]
