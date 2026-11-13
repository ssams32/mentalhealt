#!/usr/bin/env node
/**
 * scripts/check-env-example.mjs
 * .env.example 드리프트 검사 스크립트
 * 실행: node scripts/check-env-example.mjs
 * 
 * 검사 범위: HOMEPAGE_*·SURVEY_*·EXTERNAL_*·TRACK_*·BACKUP_*
 * 합격 기준: HOMEPAGE_* 드리프트 0건 → 종료 코드 0
 * 다른 접두사 드리프트는 경고만
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ENV_EXAMPLE_PATH = path.join(process.cwd(), ".env.example");
const SERVER_DIR = path.join(process.cwd(), "server");
const SERVER_JS = path.join(process.cwd(), "server.js");

const PREFIXES = ["HOMEPAGE_", "SURVEY_", "EXTERNAL_", "TRACK_", "BACKUP_"];

/**
 * .env.example에서 키 목록 파싱
 */
function parseEnvExample() {
  if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
    throw new Error(".env.example 파일이 없습니다");
  }
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const keys = new Set();
  
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    // KEY=VALUE 또는 KEY= 형태 파싱
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      if (key && !key.startsWith("#")) {
        keys.add(key);
      }
    }
  }
  
  return keys;
}

/**
 * 코드에서 process.env.<KEY> 참조 grep
 */
function grepEnvReferences() {
  const keys = new Set();
  
  // 검색할 디렉터리/파일
  const searchPaths = [SERVER_DIR, SERVER_JS];
  
  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;
    
    try {
      const cmd = `grep -rE "process\\.env\\.(HOMEPAGE_|SURVEY_|EXTERNAL_|TRACK_|BACKUP_)[A-Z0-9_]+" "${searchPath}" --include="*.js" --include="*.mjs" --include="*.ts" 2>/dev/null || true`;
      const output = execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
      
      for (const line of output.split("\n")) {
        // process.env.HOMEPAGE_API_BASE_URL 형태에서 키 추출
        const matches = line.match(/process\.env\.([A-Z0-9_]+)/g);
        if (matches) {
          for (const m of matches) {
            const key = m.replace("process.env.", "");
            if (PREFIXES.some(p => key.startsWith(p))) {
              keys.add(key);
            }
          }
        }
      }
    } catch (e) {
      // grep 실패 시 무시
    }
  }
  
  return keys;
}

/**
 * 메인 검사 로직
 */
function main() {
  console.log("=== .env.example 드리프트 검사 ===\n");
  
  const exampleKeys = parseEnvExample();
  console.log(`[INFO] .env.example 정의된 키: ${exampleKeys.size}개`);
  
  const codeKeys = grepEnvReferences();
  console.log(`[INFO] 코드에서 참조하는 키: ${codeKeys.size}개\n`);
  
  // 접두사별 분류
  const results = {
    HOMEPAGE_: { onlyInExample: [], onlyInCode: [] },
    SURVEY_: { onlyInExample: [], onlyInCode: [] },
    EXTERNAL_: { onlyInExample: [], onlyInCode: [] },
    TRACK_: { onlyInExample: [], onlyInCode: [] },
    BACKUP_: { onlyInExample: [], onlyInCode: [] },
  };
  
  for (const key of exampleKeys) {
    for (const prefix of PREFIXES) {
      if (key.startsWith(prefix)) {
        if (!codeKeys.has(key)) {
          results[prefix].onlyInExample.push(key);
        }
        break;
      }
    }
  }
  
  for (const key of codeKeys) {
    for (const prefix of PREFIXES) {
      if (key.startsWith(prefix)) {
        if (!exampleKeys.has(key)) {
          results[prefix].onlyInCode.push(key);
        }
        break;
      }
    }
  }
  
  // 결과 출력
  let homepageDriftCount = 0;
  let hasWarnings = false;
  
  for (const prefix of PREFIXES) {
    const r = results[prefix];
    const isHomepage = prefix === "HOMEPAGE_";
    const label = isHomepage ? "★ HOMEPAGE_ (합격 기준)" : prefix;
    
    if (r.onlyInExample.length > 0 || r.onlyInCode.length > 0) {
      console.log(`\n[${label}] 드리프트 발견:`);
      
      if (r.onlyInExample.length > 0) {
        console.log(`  .env.example에만 있음 (${r.onlyInExample.length}개):`);
        for (const k of r.onlyInExample.sort()) {
          console.log(`    - ${k}`);
        }
        if (isHomepage) homepageDriftCount += r.onlyInExample.length;
      }
      
      if (r.onlyInCode.length > 0) {
        console.log(`  코드에만 있음 (${r.onlyInCode.length}개):`);
        for (const k of r.onlyInCode.sort()) {
          console.log(`    - ${k}`);
        }
        if (isHomepage) homepageDriftCount += r.onlyInCode.length;
        hasWarnings = true;
      }
    } else {
      console.log(`[${label}] 드리프트 없음 ✓`);
    }
  }
  
  // 기타 접두사 경고
  const otherExampleKeys = [...exampleKeys].filter(k => !PREFIXES.some(p => k.startsWith(p)));
  const otherCodeKeys = [...codeKeys].filter(k => !PREFIXES.some(p => k.startsWith(p)));
  
  if (otherExampleKeys.length > 0 || otherCodeKeys.length > 0) {
    console.log(`\n[기타 접두사] 검사 범위 외 키:`);
    if (otherExampleKeys.length > 0) {
      console.log(`  .env.example에만 있음: ${otherExampleKeys.length}개 (예: ${otherExampleKeys.slice(0, 5).join(", ")}${otherExampleKeys.length > 5 ? "..." : ""})`);
    }
    if (otherCodeKeys.length > 0) {
      console.log(`  코드에만 있음: ${otherCodeKeys.length}개 (예: ${otherCodeKeys.slice(0, 5).join(", ")}${otherCodeKeys.length > 5 ? "..." : ""})`);
    }
  }
  
  // 최종 판정
  console.log("\n=== 검사 결과 ===");
  console.log(`HOMEPAGE_* 드리프트: ${homepageDriftCount}건`);
  
  if (homepageDriftCount === 0) {
    console.log("✅ 합격: HOMEPAGE_* 드리프트 0건");
    process.exit(0);
  } else {
    console.log("❌ 불합격: HOMEPAGE_* 드리프트 존재");
    process.exit(1);
  }
}

main();
