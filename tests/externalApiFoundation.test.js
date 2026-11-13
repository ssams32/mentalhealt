/**
 * tests/externalApiFoundation.test.js
 * Homepage Integration Engine Foundation Module Tests
 * Run with: node --test tests/externalApiFoundation.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";

// Test imports (using dynamic import for ESM modules)
const engineErrorsPath = "../server/external-api/engineErrors.js";
const urlValidatorPath = "../server/external-api/urlValidator.js";
const engineConfigPath = "../server/external-api/engineConfig.js";
const homepageClientPath = "../server/external-api/homepageClient.js";
const payloadValidatorPath = "../server/external-api/payloadValidator.js";

let engineErrors, urlValidator, engineConfig, homepageClient, payloadValidator;

before(async () => {
  [engineErrors, urlValidator, engineConfig, homepageClient, payloadValidator] =
    await Promise.all([
      import(engineErrorsPath),
      import(urlValidatorPath),
      import(engineConfigPath),
      import(homepageClientPath),
      import(payloadValidatorPath),
    ]);
});

describe("engineErrors", () => {
  test("ENGINE_ERROR_CODES has all required codes with correct structure", () => {
    const { ENGINE_ERROR_CODES } = engineErrors;
    const requiredCodes = [
      "CONFIG_MISSING",
      "CONFIG_INVALID_URL",
      "CONFIG_KEY_IN_SETTINGS",
      "ENGINE_DISABLED",
      "SCRAPER_CONFLICT",
      "AUTH_FAILED",
      "NOT_FOUND",
      "RATE_LIMITED",
      "REQUEST_TIMEOUT",
      "NETWORK_ERROR",
      "NON_JSON_RESPONSE",
      "INVALID_PAYLOAD_SCHEMA",
      "VALIDATION_FAILED",
      "DUPLICATE_SKIPPED",
      "PERSIST_FAILED",
      "ACK_FAILED",
      "SYNC_ALREADY_RUNNING",
      "SYNC_TOO_FREQUENT",
      "RETRY_EXHAUSTED",
    ];

    for (const code of requiredCodes) {
      assert.ok(code in ENGINE_ERROR_CODES, `Missing error code: ${code}`);
      const info = ENGINE_ERROR_CODES[code];
      assert.ok(
        typeof info.http === "number",
        `${code}: http should be number`,
      );
      assert.ok(
        typeof info.retryable === "boolean",
        `${code}: retryable should be boolean`,
      );
      assert.ok(
        typeof info.message === "string",
        `${code}: message should be string`,
      );
    }
  });

  test("HomepageIntegrationError creates error with correct properties", () => {
    const { HomepageIntegrationError } = engineErrors;
    const err = new HomepageIntegrationError({
      message: "Test error message",
      code: "CONFIG_MISSING",
      externalId: "TEST-123",
      details: { field: "baseUrl" },
    });

    assert.strictEqual(err.name, "HomepageIntegrationError");
    assert.strictEqual(err.code, "CONFIG_MISSING");
    assert.strictEqual(err.externalId, "TEST-123");
    assert.strictEqual(err.statusCode, 500);
    assert.strictEqual(err.retryable, false);
    assert.ok(err.message.includes("Test error message"));
  });

  test("HomepageIntegrationError masks sensitive data in message", () => {
    const { HomepageIntegrationError } = engineErrors;
    const err = new HomepageIntegrationError({
      message: "API key: abc123def456, phone: 010-1234-5678",
      code: "AUTH_FAILED",
    });

    assert.ok(!err.message.includes("abc123def456"));
    assert.ok(!err.message.includes("010-1234-5678"));
    assert.ok(
      err.message.includes("[REDACTED_API_KEY]") ||
        err.message.includes("[REDACTED_PHONE]"),
    );
  });

  test("HomepageIntegrationError masks sensitive data in details", () => {
    const { HomepageIntegrationError } = engineErrors;
    const err = new HomepageIntegrationError({
      message: "Error",
      code: "AUTH_FAILED",
      details: {
        apiKey: "secret123",
        phone: "010-1234-5678",
        normalField: "value",
      },
    });

    assert.strictEqual(err.details.apiKey, "[REDACTED]");
    assert.strictEqual(err.details.phone, "[REDACTED_PHONE]");
    assert.strictEqual(err.details.normalField, "value");
  });

  test("maskForLog masks phone numbers", () => {
    const { maskForLog } = engineErrors;
    const result = maskForLog("Contact: 010-1234-5678 and 01012345678");
    assert.ok(result.includes("[REDACTED_PHONE]"));
    assert.ok(!result.includes("010-1234-5678"));
  });

  test("maskForLog masks resident registration numbers", () => {
    const { maskForLog } = engineErrors;
    const result = maskForLog("RRN: 900101-1234567");
    assert.ok(result.includes("[REDACTED_RESIDENT_REG]"));
    assert.ok(!result.includes("900101-1234567"));
  });

  test("maskForLog masks API keys", () => {
    const { maskForLog } = engineErrors;
    const result = maskForLog("X-Api-Key: abcdefghijklmnop");
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(!result.includes("abcdefghijklmnop"));
  });

  test("maskForLog preserves engine error codes", () => {
    const { maskForLog } = engineErrors;
    // 에러 코드는 비밀이 아니라 식별자라 마스킹하면 안 된다 (T2: 메시지에 코드가 남아 있어야 한다)
    const result = maskForLog("HOMEPAGE_AUTH_FAILED: Invalid API key");
    assert.strictEqual(result, "HOMEPAGE_AUTH_FAILED: Invalid API key");
    assert.strictEqual(maskForLog("NETWORK_ERROR: timeout"), "NETWORK_ERROR: timeout");
    // 실제 키처럼 생긴 값은 계속 가려진다
    assert.ok(maskForLog("key=mock-homepage-key").includes("[REDACTED_API_KEY]"));
  });

  test("maskPayloadForLog redacts sensitive keys", () => {
    const { maskPayloadForLog } = engineErrors;
    const payload = {
      apiKey: "secret123",
      phone: "010-1234-5678",
      clientName: "John Doe",
      answers: ["answer1", "answer2"],
      normalField: "normal value",
    };

    const result = maskPayloadForLog(payload);
    assert.strictEqual(result.apiKey, "[REDACTED]");
    assert.strictEqual(result.phone, "[REDACTED]");
    assert.strictEqual(result.clientName, "[REDACTED]");
    assert.strictEqual(result.answers, "[REDACTED]");
    assert.strictEqual(result.normalField, "normal value");
  });

  test("createErrorFromFetchError handles timeout", () => {
    const { createErrorFromFetchError } = engineErrors;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";

    const result = createErrorFromFetchError(err, "TEST-123");
    assert.strictEqual(result.code, "REQUEST_TIMEOUT");
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(result.statusCode, 504);
  });

  test("createErrorFromFetchError handles network error", () => {
    const { createErrorFromFetchError } = engineErrors;
    const err = new Error("ENOTFOUND");

    const result = createErrorFromFetchError(err, "TEST-123");
    assert.strictEqual(result.code, "NETWORK_ERROR");
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(result.statusCode, 503);
  });

  test("computeAuthFingerprint produces consistent 8-char hash", () => {
    const { computeAuthFingerprint } = engineErrors;
    const fp1 = computeAuthFingerprint("test-api-key-12345");
    const fp2 = computeAuthFingerprint("test-api-key-12345");
    assert.strictEqual(fp1.length, 8);
    assert.strictEqual(fp1, fp2);
  });
});

describe("urlValidator", () => {
  test("validateHomepageBaseUrl rejects empty string", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(() => validateHomepageBaseUrl(""), /필수/);
    assert.throws(() => validateHomepageBaseUrl(null), /필수/);
    assert.throws(() => validateHomepageBaseUrl(123), /문자열/);
  });

  test("validateHomepageBaseUrl rejects path traversal", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(
      () => validateHomepageBaseUrl("https://example.com/../path"),
      /경로 순회/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://example.com\\path"),
      /경로 순회/,
    );
  });

  test("validateHomepageBaseUrl rejects embedded credentials", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(
      () => validateHomepageBaseUrl("https://user:pass@example.com"),
      /자격증명/,
    );
  });

  test("validateHomepageBaseUrl rejects non-HTTPS in production", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(
      () => validateHomepageBaseUrl("http://example.com", "production"),
      /HTTPS/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("http://example.com", "staging"),
      /HTTPS/,
    );
  });

  test("validateHomepageBaseUrl allows HTTP in mock mode", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    const result = validateHomepageBaseUrl("http://localhost:3000", "mock");
    assert.strictEqual(result, "http://localhost:3000");
  });

  test("validateHomepageBaseUrl rejects localhost in production", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(
      () => validateHomepageBaseUrl("https://localhost", "production"),
      /localhost/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://127.0.0.1", "production"),
      /localhost/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://::1", "production"),
      /유효한 URL이 아닙니다|localhost/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://test.localhost", "production"),
      /localhost/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://test.local", "production"),
      /localhost/,
    );
  });

  test("validateHomepageBaseUrl rejects localhost in staging", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    assert.throws(
      () => validateHomepageBaseUrl("https://localhost", "staging"),
      /localhost/,
    );
    assert.throws(
      () => validateHomepageBaseUrl("https://127.0.0.1", "staging"),
      /localhost/,
    );
  });

  test("validateHomepageBaseUrl normalizes trailing slash", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    const result = validateHomepageBaseUrl("https://example.com/api/", "mock");
    assert.strictEqual(result, "https://example.com/api");
  });

  test("validateHomepageBaseUrl handles path correctly", () => {
    const { validateHomepageBaseUrl } = urlValidator;
    const result = validateHomepageBaseUrl(
      "https://example.com/api/v1/",
      "mock",
    );
    assert.strictEqual(result, "https://example.com/api/v1");
  });
});

describe("engineConfig", () => {
  test("loadEnvConfig reads environment variables", () => {
    const { loadEnvConfig } = engineConfig;

    // Set test env vars
    process.env.HOMEPAGE_API_BASE_URL = "https://test.example.com";
    process.env.HOMEPAGE_ORG_ID = "test-org";
    process.env.HOMEPAGE_API_KEY_HEADER = "X-Custom-Key";
    process.env.HOMEPAGE_API_AUTH_SCHEME = "bearer";

    const config = loadEnvConfig();

    assert.strictEqual(config.baseUrl, "https://test.example.com");
    assert.strictEqual(config.orgId, "test-org");
    assert.strictEqual(config.apiKeyHeader, "X-Custom-Key");
    assert.strictEqual(config.authScheme, "bearer");

    // Cleanup
    delete process.env.HOMEPAGE_API_BASE_URL;
    delete process.env.HOMEPAGE_ORG_ID;
    delete process.env.HOMEPAGE_API_KEY_HEADER;
    delete process.env.HOMEPAGE_API_AUTH_SCHEME;
  });

  test("validateConfig throws on missing baseUrl", () => {
    const { validateConfig } = engineConfig;
    assert.throws(
      () => validateConfig({ orgId: "test" }, "production"),
      /필수 설정 누락.*baseUrl/,
    );
  });

  test("validateConfig throws on missing orgId", () => {
    const { validateConfig } = engineConfig;
    assert.throws(
      () => validateConfig({ baseUrl: "https://test.com" }, "production"),
      /필수 설정 누락.*orgId/,
    );
  });

  test("validateConfig applies defaults for numeric fields", () => {
    const { validateConfig } = engineConfig;
    const config = validateConfig(
      {
        baseUrl: "https://test.com",
        orgId: "test",
        pollIntervalSeconds: 5000, // Should clamp to 3600
        requestTimeoutMs: 500, // Should clamp to 1000
        maxBatchSize: 200, // Should clamp to 100
      },
      "mock",
    );

    assert.strictEqual(config.pollIntervalSeconds, 3600);
    assert.strictEqual(config.requestTimeoutMs, 1000);
    assert.strictEqual(config.maxBatchSize, 100);
  });

  test("validateConfig validates mode", () => {
    const { validateConfig } = engineConfig;
    assert.throws(
      () =>
        validateConfig(
          { baseUrl: "https://test.com", orgId: "test", mode: "invalid" },
          "invalid",
        ),
      /잘못된 모드/,
    );
  });

  test("getEngineConfigSummary excludes key", () => {
    const { getEngineConfigSummary } = engineConfig;
    const config = {
      baseUrl: "https://test.com",
      orgId: "test-org",
      mode: "production",
      pollEnabled: true,
      pollIntervalSeconds: 60,
    };

    const summary = getEngineConfigSummary(config, "abc12345");

    assert.strictEqual(summary.baseUrl, "https://test.com");
    assert.strictEqual(summary.orgId, "test-org");
    assert.strictEqual(summary.keyPresent, true);
    assert.strictEqual(summary.keyFingerprint, "abc12345");
    assert.ok(!("apiKey" in summary));
  });

  test("validateApiKeyFormat validates correctly", () => {
    const { validateApiKeyFormat } = engineConfig;

    assert.ok(validateApiKeyFormat("valid-api-key-12345678"));
    assert.ok(!validateApiKeyFormat("short"));
    assert.ok(!validateApiKeyFormat("has spaces"));
    assert.ok(!validateApiKeyFormat("Bearer token"));
    assert.ok(!validateApiKeyFormat("http://example.com"));
    assert.ok(!validateApiKeyFormat(""));
  });
});

describe("homepageClient", () => {
  test("HomepageClient constructor validates required params", () => {
    const { HomepageClient } = homepageClient;

    assert.throws(() => new HomepageClient({}), /baseUrl/);
    assert.throws(
      () => new HomepageClient({ baseUrl: "https://test.com" }),
      /apiKey/,
    );
    assert.throws(
      () => new HomepageClient({ baseUrl: "https://test.com", apiKey: "key" }),
      /orgId/,
    );
  });

  test("HomepageClient rejects HTTP in production", () => {
    const { HomepageClient } = homepageClient;
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    assert.throws(
      () =>
        new HomepageClient({
          baseUrl: "http://example.com",
          apiKey: "valid-api-key-12345",
          orgId: "test",
        }),
      /HTTPS/,
    );

    process.env.NODE_ENV = originalEnv;
  });

  test("HomepageClient normalizes baseUrl trailing slash", () => {
    const { HomepageClient } = homepageClient;
    const client = new HomepageClient({
      baseUrl: "https://example.com/api/",
      apiKey: "valid-api-key-12345",
      orgId: "test",
    });

    assert.strictEqual(client.baseUrl, "https://example.com/api");
  });

  test("_sanitizeId validates ID format", () => {
    const { HomepageClient } = homepageClient;
    const client = new HomepageClient({
      baseUrl: "https://example.com",
      apiKey: "valid-api-key-12345",
      orgId: "test",
    });

    assert.strictEqual(client._sanitizeId("REF-123"), "REF-123");
    assert.strictEqual(client._sanitizeId("test_id"), "test_id");
    assert.throws(() => client._sanitizeId(""), /형식/);
    assert.throws(() => client._sanitizeId("test@id"), /형식/);
  });

  test("ENDPOINT_PATHS has all required paths", () => {
    const { ENDPOINT_PATHS } = homepageClient;

    assert.ok(ENDPOINT_PATHS.REFERRALS_LIST);
    assert.ok(ENDPOINT_PATHS.ASSESSMENTS_LIST);
    assert.ok(typeof ENDPOINT_PATHS.REFERRAL_BY_ID === "function");
    assert.ok(typeof ENDPOINT_PATHS.ASSESSMENT_BY_ID === "function");
    assert.ok(ENDPOINT_PATHS.CAPABILITIES);
    assert.ok(ENDPOINT_PATHS.HEALTH_FALLBACK);
    assert.ok(typeof ENDPOINT_PATHS.ACK_REFERRAL === "function");
    assert.ok(typeof ENDPOINT_PATHS.ACK_ASSESSMENT === "function");
    assert.ok(typeof ENDPOINT_PATHS.FAILED_REFERRAL === "function");
    assert.ok(typeof ENDPOINT_PATHS.FAILED_ASSESSMENT === "function");
  });
});

describe("payloadValidator", () => {
  let validator;

  before(() => {
    validator = new payloadValidator.HomepagePayloadValidator();
  });

  test("validateBatch rejects non-object payload", () => {
    assert.throws(
      () => validator.validateBatch(null, "referral"),
      /객체가 아닙니다/,
    );
    assert.throws(
      () => validator.validateBatch("string", "referral"),
      /객체가 아닙니다/,
    );
  });

  test("validateBatch returns empty for empty items", () => {
    const result = validator.validateBatch({ items: [] }, "referral");
    assert.deepStrictEqual(result, {
      valid: [],
      quarantined: [],
      rejected: [],
    });
  });

  test("validateReferralItem quarantines missing externalId", () => {
    const result = validator.validateReferralItem({ name: "Test" });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("externalId"));
  });

  test("validateReferralItem quarantines missing receivedAt", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      name: "Test",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("receivedAt"));
  });

  test("validateReferralItem quarantines missing name and phone", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("이름과 연락처"));
  });

  test("validateReferralItem passes with name", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "홍길동",
    });
    assert.strictEqual(result.status, "valid");
  });

  test("validateReferralItem passes with phone", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      phone: "010-1234-5678",
    });
    assert.strictEqual(result.status, "valid");
  });

  test("validateReferralItem quarantines invalid field types", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "Test",
      age: 123, // should be string
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("타입 불일치"));
  });

  test("validateReferralItem quarantines length overflow", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "Test",
      problem: "x".repeat(2001), // max 2000
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("길이 초과"));
  });

  test("validateReferralItem normalizes unknown gender to null", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "Test",
      gender: "unknown",
    });
    assert.strictEqual(result.status, "valid");
    assert.strictEqual(result.normalized.gender, null);
  });

  test("validateReferralItem normalizes unknown referralPath to null", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "Test",
      referralPath: "unknown-path",
    });
    assert.strictEqual(result.status, "valid");
    assert.strictEqual(result.normalized.referralPath, null);
  });

  test("validateReferralItem quarantines spam patterns", () => {
    const result = validator.validateReferralItem({
      externalId: "REF-001",
      receivedAt: "2024-01-01T00:00:00Z",
      name: "Test",
      problem: "<script>alert(1)</script>",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("스팸"));
  });

  test("validateAssessmentItem quarantines missing externalId", () => {
    const result = validator.validateAssessmentItem({
      scale: "phq-9",
      submittedAt: "2024-01-01T00:00:00Z",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("externalId"));
  });

  test("validateAssessmentItem quarantines missing scale", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      submittedAt: "2024-01-01T00:00:00Z",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("scale"));
  });

  test("validateAssessmentItem quarantines missing submittedAt", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      scale: "phq-9",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("submittedAt"));
  });

  test("validateAssessmentItem quarantines non-numeric totalScore", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      scale: "phq-9",
      submittedAt: "2024-01-01T00:00:00Z",
      totalScore: "not-a-number",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("숫자가 아님"));
  });

  test("validateAssessmentItem sets severity to null when missing", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      scale: "phq-9",
      submittedAt: "2024-01-01T00:00:00Z",
      totalScore: 10,
    });
    assert.strictEqual(result.status, "valid");
    assert.strictEqual(result.normalized.severity, null);
  });

  test("validateAssessmentItem quarantines invalid scaleScores", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      scale: "phq-9",
      submittedAt: "2024-01-01T00:00:00Z",
      scaleScores: "not-an-object",
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("객체가 아님"));
  });

  test("validateAssessmentItem quarantines spam patterns", () => {
    const result = validator.validateAssessmentItem({
      externalId: "ASM-001",
      scale: "phq-9",
      submittedAt: "2024-01-01T00:00:00Z",
      answers: ["javascript:alert(1)"],
    });
    assert.strictEqual(result.status, "quarantined");
    assert.ok(result.reason.includes("스팸"));
  });

  test("validateBatch processes mixed valid/quarantined items", () => {
    const payload = {
      items: [
        {
          externalId: "REF-001",
          receivedAt: "2024-01-01T00:00:00Z",
          name: "Valid",
        },
        { externalId: "REF-002", receivedAt: "2024-01-01T00:00:00Z" }, // missing name+phone
        { receivedAt: "2024-01-01T00:00:00Z", name: "No ID" }, // missing externalId
      ],
    };

    const result = validator.validateBatch(payload, "referral");
    assert.strictEqual(result.valid.length, 1);
    assert.strictEqual(result.quarantined.length, 2);
    assert.strictEqual(result.rejected.length, 0);
  });

  test("isSpamProbe detects various patterns", () => {
    assert.ok(validator.isSpamProbe({ content: "sparrow scan" }));
    assert.ok(validator.isSpamProbe({ content: "dast scanner" }));
    assert.ok(validator.isSpamProbe({ content: "<script>alert(1)</script>" }));
    assert.ok(validator.isSpamProbe({ content: "onload=steal()" }));
    assert.ok(validator.isSpamProbe({ content: "javascript:void(0)" }));
    assert.ok(validator.isSpamProbe({ content: "alert(1)" }));
    assert.ok(!validator.isSpamProbe({ content: "normal content" }));
  });
});

// Summary test count
describe("Test Suite Summary", () => {
  test("All test groups defined", () => {
    // This test just confirms the test file structure
    assert.ok(true);
  });
});
