/**
 * server/external-api/urlValidator.js
 * Homepage Integration Engine — Base URL Validation
 * ESM module.
 * surveyUrlValidator.js 규칙을 홈페이지용으로 일반화.
 */

/**
 * 홈페이지 API 기본 주소 검증
 * @param {string} rawUrl - 원본 URL 문자열
 * @param {string} [mode='mock'] - 모드 ('mock' | 'staging' | 'production')
 * @returns {string} 정규화된 origin + 경로 (trailing slash 제거)
 * @throws {Error} 검증 실패 시
 */
export function validateHomepageBaseUrl(rawUrl, mode = "mock") {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error(
      "HOMEPAGE_API_BASE_URL은 필수이며 유효한 문자열이어야 합니다",
    );
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("HOMEPAGE_API_BASE_URL은 비어 있을 수 없습니다");
  }

  // 경로 순회(traversal) 문자 검사
  if (trimmed.includes("..") || trimmed.includes("\\")) {
    throw new Error(
      "HOMEPAGE_API_BASE_URL에 금지된 경로 순회 문자가 포함되어 있습니다",
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    throw new Error(
      `HOMEPAGE_API_BASE_URL이 유효한 URL이 아닙니다: "${trimmed}"`,
    );
  }

  // 내장 자격증명(user:pass@) 금지
  if (parsed.username || parsed.password) {
    throw new Error(
      "HOMEPAGE_API_BASE_URL에는 내장 자격증명을 포함할 수 없습니다",
    );
  }

  // 프로토콜 검사: staging/production은 HTTPS 필수
  if (mode === "staging" || mode === "production") {
    if (parsed.protocol !== "https:") {
      throw new Error(
        `HOMEPAGE_API_BASE_URL은 ${mode} 모드에서 HTTPS 프로토콜을 사용해야 합니다 (수신: ${parsed.protocol})`,
      );
    }
  }

  const hostname = parsed.hostname.toLowerCase();

  // Production 환경 제한: localhost 계열 금지
  if (mode === "production") {
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.startsWith("[::1]") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local")
    ) {
      throw new Error(
        `HOMEPAGE_API_BASE_URL이 production 모드에서 localhost 또는 .local 도메인을 사용할 수 없습니다: ${hostname}`,
      );
    }
  }

  // Staging 환경 제한: localhost 금지 (실제 스테이징 배포 URL만 허용)
  if (mode === "staging") {
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    ) {
      throw new Error(
        `HOMEPAGE_API_BASE_URL이 staging 모드에서 실제 스테이징 HTTPS 배포 URL을 사용해야 합니다, localhost 불가: ${hostname}`,
      );
    }
  }

  // Mock 모드에서는 http://localhost 허용 (그 외는 동일하게 검증)
  // 주의: mock 모드에서도 경로 순회, 내장 자격증명은 여전히 금지

  // 정규화된 origin + 경로 반환 (trailing slash 제거)
  const normalizedPath =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${normalizedPath}`;
}

/**
 * URL이 유효한지 여부만 확인 (예외 던지지 않음)
 * @param {string} rawUrl
 * @param {string} [mode='mock']
 * @returns {boolean}
 */
export function isValidHomepageBaseUrl(rawUrl, mode = "mock") {
  try {
    validateHomepageBaseUrl(rawUrl, mode);
    return true;
  } catch {
    return false;
  }
}
