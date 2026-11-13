/**
 * tests/externalApiKeyEntry.test.js
 * Homepage Integration Engine — Admin API Key Entry Tests
 * Run with: node --test tests/externalApiKeyEntry.test.js
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import express from "express";

const engineConfigPath = "../server/external-api/engineConfig.js";
const engineErrorsPath = "../server/external-api/engineErrors.js";
const indexPath = "../server/external-api/index.js";
const routerPath = "../server/external-api/engineRouter.js";

let engineConfig, engineErrors, indexModule, routerModule;

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString("hex");
const TEST_DIFFERENT_MASTER_KEY_HEX = crypto.randomBytes(32).toString("hex");
const VALID_SAMPLE_KEY = "test-external-api-sample-key-12345678";

let tempTestDir = null;

function createTempDir() {
  const dir = path.join("/tmp", `api-key-test-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

before(async () => {
  [engineConfig, engineErrors, indexModule, routerModule] = await Promise.all([
    import(engineConfigPath),
    import(engineErrorsPath),
    import(indexPath),
    import(routerPath),
  ]);
});

describe("Unit Tests: Key Validation & AES-256-GCM Encryption", () => {
  beforeEach(() => {
    tempTestDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempTestDir);
  });

  test("1. validateApiKeyFormat rejects empty, spaces, invalid lengths, URLs, Bearer prefix", () => {
    const { validateApiKeyFormat } = engineConfig;

    // Valid key
    assert.strictEqual(validateApiKeyFormat(VALID_SAMPLE_KEY), true);
    assert.strictEqual(validateApiKeyFormat("a".repeat(16)), true);
    assert.strictEqual(validateApiKeyFormat("a".repeat(512)), true);

    // Empty / short / too long
    assert.strictEqual(validateApiKeyFormat(""), false);
    assert.strictEqual(validateApiKeyFormat("short-key-123"), false); // 13 chars (< 16)
    assert.strictEqual(validateApiKeyFormat("a".repeat(513)), false); // > 512 chars

    // Whitespace / newlines
    assert.strictEqual(validateApiKeyFormat("key with space 12345"), false);
    assert.strictEqual(validateApiKeyFormat("key\nwith\nnewline1234"), false);
    assert.strictEqual(validateApiKeyFormat(" keywithleadingspace16"), false);
    assert.strictEqual(validateApiKeyFormat("keywithtrailingspace16 "), false);

    // Quotes
    assert.strictEqual(validateApiKeyFormat('"quoted-key-value-1234"'), false);
    assert.strictEqual(validateApiKeyFormat("'quoted-key-value-1234'"), false);

    // URLs and Bearer
    assert.strictEqual(validateApiKeyFormat("https://api.example.com/key"), false);
    assert.strictEqual(validateApiKeyFormat("http://api.example.com/key"), false);
    assert.strictEqual(validateApiKeyFormat("Bearer my-secret-api-key-123"), false);

    // Non-string
    assert.strictEqual(validateApiKeyFormat(null), false);
    assert.strictEqual(validateApiKeyFormat(undefined), false);
    assert.strictEqual(validateApiKeyFormat(1234567890123456), false);
  });

  test("2. Master key parsing supports hex and base64", () => {
    const { getMasterKey, isMasterKeyConfigured } = engineConfig;

    const hexKey = crypto.randomBytes(32).toString("hex");
    const base64Key = crypto.randomBytes(32).toString("base64");

    const bufHex = getMasterKey(hexKey);
    assert.ok(bufHex);
    assert.strictEqual(bufHex.length, 32);
    assert.strictEqual(isMasterKeyConfigured(hexKey), true);

    const bufB64 = getMasterKey(base64Key);
    assert.ok(bufB64);
    assert.strictEqual(bufB64.length, 32);
    assert.strictEqual(isMasterKeyConfigured(base64Key), true);

    // Invalid master key
    assert.strictEqual(getMasterKey("invalid-short-key"), null);
    assert.strictEqual(isMasterKeyConfigured("invalid-short-key"), false);
  });

  test("3. Encryption and decryption roundtrip succeeds with matching key, fails with different key", () => {
    const { encryptApiKeyString, decryptApiKeyString } = engineConfig;
    const masterBuf1 = Buffer.from(TEST_MASTER_KEY_HEX, "hex");
    const masterBuf2 = Buffer.from(TEST_DIFFERENT_MASTER_KEY_HEX, "hex");

    const encrypted = encryptApiKeyString(VALID_SAMPLE_KEY, masterBuf1);
    assert.strictEqual(encrypted.version, 1);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.tag);
    assert.ok(encrypted.data);

    // Plain text is NOT contained in encrypted payload
    assert.strictEqual(encrypted.data.includes(VALID_SAMPLE_KEY), false);

    // Decrypt with same key
    const decrypted = decryptApiKeyString(encrypted, masterBuf1);
    assert.strictEqual(decrypted, VALID_SAMPLE_KEY);

    // Decrypt with different key MUST fail
    assert.throws(() => {
      decryptApiKeyString(encrypted, masterBuf2);
    });
  });

  test("4. saveEncryptedApiKey stores ciphertext to ExternalApiKey.enc.json without plaintext", async () => {
    const { saveEncryptedApiKey, loadEncryptedApiKey } = engineConfig;

    await saveEncryptedApiKey(VALID_SAMPLE_KEY, {
      dataDir: tempTestDir,
      masterKey: TEST_MASTER_KEY_HEX,
    });

    const filePath = path.join(tempTestDir, "ExternalApiKey.enc.json");
    assert.ok(fs.existsSync(filePath), "File should be created");

    const rawFileContent = fs.readFileSync(filePath, "utf8");
    assert.strictEqual(
      rawFileContent.includes(VALID_SAMPLE_KEY),
      false,
      "Plaintext key MUST NEVER appear in encrypted file"
    );

    const parsed = JSON.parse(rawFileContent);
    assert.strictEqual(parsed.version, 1);
    assert.ok(parsed.iv);
    assert.ok(parsed.tag);
    assert.ok(parsed.data);
    assert.ok(parsed.createdAt);
    assert.ok(parsed.updatedAt);

    // Load with matching key
    const loaded = loadEncryptedApiKey({
      dataDir: tempTestDir,
      masterKey: TEST_MASTER_KEY_HEX,
    });
    assert.ok(loaded);
    assert.strictEqual(loaded.key, VALID_SAMPLE_KEY);

    // Load with different key returns null
    const badLoad = loadEncryptedApiKey({
      dataDir: tempTestDir,
      masterKey: TEST_DIFFERENT_MASTER_KEY_HEX,
    });
    assert.strictEqual(badLoad, null);
  });

  test("5. deleteEncryptedApiKey deletes file and getEncryptedKeyMetadata reports existence", async () => {
    const { saveEncryptedApiKey, deleteEncryptedApiKey, getEncryptedKeyMetadata } = engineConfig;

    let meta = getEncryptedKeyMetadata({ dataDir: tempTestDir });
    assert.strictEqual(meta.exists, false);

    await saveEncryptedApiKey(VALID_SAMPLE_KEY, {
      dataDir: tempTestDir,
      masterKey: TEST_MASTER_KEY_HEX,
    });

    meta = getEncryptedKeyMetadata({ dataDir: tempTestDir });
    assert.strictEqual(meta.exists, true);
    assert.ok(meta.createdAt);
    assert.ok(meta.updatedAt);

    await deleteEncryptedApiKey({ dataDir: tempTestDir });

    meta = getEncryptedKeyMetadata({ dataDir: tempTestDir });
    assert.strictEqual(meta.exists, false);
  });

  test("6. resolveApiKey priorities: env > encrypted file > null", async () => {
    const { resolveApiKey, saveEncryptedApiKey } = engineConfig;
    const originalEnvKey = process.env.HOMEPAGE_API_KEY;
    const originalMasterKey = process.env.HOMEPAGE_KEY_ENCRYPTION_KEY;

    try {
      process.env.HOMEPAGE_KEY_ENCRYPTION_KEY = TEST_MASTER_KEY_HEX;
      delete process.env.HOMEPAGE_API_KEY;

      // When neither exists: returns null
      let resolved = await resolveApiKey({ dataDir: tempTestDir });
      assert.strictEqual(resolved, null);

      // When encrypted file exists: returns encrypted_file
      await saveEncryptedApiKey(VALID_SAMPLE_KEY, {
        dataDir: tempTestDir,
        masterKey: TEST_MASTER_KEY_HEX,
      });
      resolved = await resolveApiKey({ dataDir: tempTestDir });
      assert.ok(resolved);
      assert.strictEqual(resolved.key, VALID_SAMPLE_KEY);
      assert.strictEqual(resolved.source, "encrypted_file");

      // When env var is also set: env takes priority
      const ENV_KEY = "env-priority-api-key-1234567890";
      process.env.HOMEPAGE_API_KEY = ENV_KEY;
      resolved = await resolveApiKey({ dataDir: tempTestDir });
      assert.ok(resolved);
      assert.strictEqual(resolved.key, ENV_KEY);
      assert.strictEqual(resolved.source, "env");
    } finally {
      if (originalEnvKey !== undefined) process.env.HOMEPAGE_API_KEY = originalEnvKey;
      else delete process.env.HOMEPAGE_API_KEY;

      if (originalMasterKey !== undefined) process.env.HOMEPAGE_KEY_ENCRYPTION_KEY = originalMasterKey;
      else delete process.env.HOMEPAGE_KEY_ENCRYPTION_KEY;
    }
  });
});

describe("Integration & Route Tests: POST /key, DELETE /key, GET /config", () => {
  let app, server, baseUrl;
  let auditLogs = [];
  let testEngine = null;
  const originalMasterKey = process.env.HOMEPAGE_KEY_ENCRYPTION_KEY;
  const originalEnvKey = process.env.HOMEPAGE_API_KEY;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tempTestDir = createTempDir();
    auditLogs = [];

    // Clear env key so encrypted file is tested cleanly
    delete process.env.HOMEPAGE_API_KEY;
    process.env.DATA_DIR = tempTestDir;
    process.env.HOMEPAGE_KEY_ENCRYPTION_KEY = TEST_MASTER_KEY_HEX;

    // Create Express app
    app = express();
    app.use(express.json());

    // Fake auth middleware for tests
    let reqCount = 0;
    const requireAuth = (req, res, next) => {
      const adminId = req.headers["x-test-admin-id"] || `admin_${Date.now()}_${++reqCount}`;
      req.auth = { userId: adminId, role: "admin" };
      next();
    };
    const requireAdmin = (req, res, next) => next();

    const auditLogger = async (entry) => {
      auditLogs.push(entry);
    };

    // Staging mode to test actual HomepageClient creation
    testEngine = await indexModule.createExternalApiEngine({
      getData: () => [],
      persistData: async () => {},
      requireAuth,
      requireAdmin,
      auditLogger,
      dataDir: tempTestDir,
    });

    app.use("/api/external-api", testEngine.engineRouter);

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api/external-api`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    cleanupTempDir(tempTestDir);

    if (originalMasterKey !== undefined) {
      process.env.HOMEPAGE_KEY_ENCRYPTION_KEY = originalMasterKey;
    } else {
      delete process.env.HOMEPAGE_KEY_ENCRYPTION_KEY;
    }

    if (originalEnvKey !== undefined) {
      process.env.HOMEPAGE_API_KEY = originalEnvKey;
    } else {
      delete process.env.HOMEPAGE_API_KEY;
    }

    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
  });

  test("7. When master key is not configured, POST /key returns 503", async () => {
    delete process.env.HOMEPAGE_KEY_ENCRYPTION_KEY;

    const res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: VALID_SAMPLE_KEY }),
    });

    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "KEY_ENCRYPTION_UNAVAILABLE");
    assert.ok(body.error?.message.includes("마스터 키"));
  });

  test("8. Format error key is rejected with 400 (empty, spaces, >512 chars)", async () => {
    // Empty
    let res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "" }),
    });
    assert.strictEqual(res.status, 400);
    let body = await res.json();
    assert.strictEqual(body.error?.code, "INVALID_KEY_FORMAT");

    // Whitespace
    res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "invalid key with spaces" }),
    });
    assert.strictEqual(res.status, 400);

    // > 512 chars
    res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "a".repeat(513) }),
    });
    assert.strictEqual(res.status, 400);
  });

  test("9. Full Lifecycle: Register key -> GET config (present + fp) -> Delete key -> GET config (absent)", async () => {
    // Initial state: keyPresent should be false
    let res = await fetch(`${baseUrl}/config`);
    assert.strictEqual(res.status, 200);
    let configBody = await res.json();
    assert.strictEqual(configBody.keyPresent, false);
    assert.strictEqual(configBody.keyFingerprint, null);
    assert.strictEqual(configBody.masterKeyConfigured, true);

    // 1. Register key
    res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: VALID_SAMPLE_KEY }),
    });

    assert.strictEqual(res.status, 200);
    const regBody = await res.json();
    assert.strictEqual(regBody.success, true);
    assert.strictEqual(regBody.keyPresent, true);
    assert.ok(regBody.keyFingerprint);
    // MUST NOT return the plaintext key
    assert.strictEqual("key" in regBody, false);
    assert.strictEqual("apiKey" in regBody, false);

    const expectedFingerprint = regBody.keyFingerprint;

    // 2. Check GET /config
    res = await fetch(`${baseUrl}/config`);
    assert.strictEqual(res.status, 200);
    configBody = await res.json();
    assert.strictEqual(configBody.keyPresent, true);
    assert.strictEqual(configBody.keyFingerprint, expectedFingerprint);
    assert.ok(configBody.keyRegisteredAt);
    // Plaintext key MUST NOT appear anywhere in config
    assert.strictEqual("key" in configBody, false);
    assert.strictEqual("apiKey" in configBody, false);
    assert.strictEqual(JSON.stringify(configBody).includes(VALID_SAMPLE_KEY), false);

    // 3. Check Audit Logs: Key plaintext must never be logged
    const auditStr = JSON.stringify(auditLogs);
    assert.strictEqual(
      auditStr.includes(VALID_SAMPLE_KEY),
      false,
      "API key plaintext MUST NOT appear in audit logs"
    );
    const regAudit = auditLogs.find((e) => e.action === "EXTERNAL_API_KEY_REGISTERED");
    assert.ok(regAudit, "Audit event EXTERNAL_API_KEY_REGISTERED should be logged");
    assert.strictEqual(regAudit.targetId, expectedFingerprint.slice(0, 8));

    // 4. Delete key
    res = await fetch(`${baseUrl}/key`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const delBody = await res.json();
    assert.strictEqual(delBody.success, true);
    assert.strictEqual(delBody.keyPresent, false);

    // 5. Check GET /config after deletion
    res = await fetch(`${baseUrl}/config`);
    assert.strictEqual(res.status, 200);
    configBody = await res.json();
    assert.strictEqual(configBody.keyPresent, false);
    assert.strictEqual(configBody.keyFingerprint, null);

    // Check delete audit event
    const delAudit = auditLogs.find((e) => e.action === "EXTERNAL_API_KEY_DELETED");
    assert.ok(delAudit, "Audit event EXTERNAL_API_KEY_DELETED should be logged");
  });

  test("10. Engine client reload updates client on registration", async () => {
    // Register key
    const res = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: VALID_SAMPLE_KEY }),
    });
    assert.strictEqual(res.status, 200);

    // Verify client was loaded in engine
    assert.ok(testEngine.engineService.client, "Client should be regenerated and set on engineService");
    assert.strictEqual(testEngine.engineService.client.apiKey, VALID_SAMPLE_KEY);

    // Delete key
    await fetch(`${baseUrl}/key`, { method: "DELETE" });
    if (testEngine.engineService.config.mode !== "mock") {
      assert.strictEqual(testEngine.engineService.client, null, "Client should be cleared when key is deleted in non-mock mode");
    }
  });

  test("11. Rate limit: 6 consecutive calls by same admin trigger 429 RATE_LIMITED", async () => {
    const fixedAdminId = "admin_rate_limit_test";

    // 5 calls
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-admin-id": fixedAdminId,
        },
        body: JSON.stringify({ key: VALID_SAMPLE_KEY }),
      });
      assert.strictEqual(res.status, 200, `Call ${i + 1} should succeed`);
    }

    // 6th call MUST be rate limited
    const res6 = await fetch(`${baseUrl}/key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-admin-id": fixedAdminId,
      },
      body: JSON.stringify({ key: VALID_SAMPLE_KEY }),
    });

    assert.strictEqual(res6.status, 429, "6th call should be 429 RATE_LIMITED");
    assert.ok(res6.headers.get("retry-after"), "Should have Retry-After header");
    const body6 = await res6.json();
    assert.strictEqual(body6.error?.code, "RATE_LIMITED");
  });
});
