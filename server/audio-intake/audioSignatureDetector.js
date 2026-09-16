/**
 * server/audio-intake/audioSignatureDetector.js
 * Binary Header Magic-Number and Structure Detector for Mind-ERP OS Audio Intake.
 * Validates MP3, WAV, and M4A signatures while detecting dangerous executable/archive disguises.
 */

import { AUDIO_FORMAT, DANGEROUS_SIGNATURES, MEDIA_VALIDATION_STAGE } from './audioIntakeConstants.js';

/**
 * Compare buffer prefix against target byte array.
 */
function matchesBytes(buffer, offset, targetBytes) {
    if (buffer.length < offset + targetBytes.length) return false;
    for (let i = 0; i < targetBytes.length; i++) {
        if (buffer[offset + i] !== targetBytes[i]) return false;
    }
    return true;
}

/**
 * Check if buffer starts with any dangerous executable or archive signatures.
 */
export function detectDangerousSignature(buffer) {
    if (!buffer || buffer.length < 4) return null;

    if (matchesBytes(buffer, 0, DANGEROUS_SIGNATURES.MZ_EXECUTABLE)) {
        return { dangerous: true, type: 'MZ_EXECUTABLE', reason: 'Windows 실행파일 헤더 감지' };
    }
    if (matchesBytes(buffer, 0, DANGEROUS_SIGNATURES.ELF_EXECUTABLE)) {
        return { dangerous: true, type: 'ELF_EXECUTABLE', reason: 'Linux ELF 실행파일 헤더 감지' };
    }
    if (matchesBytes(buffer, 0, DANGEROUS_SIGNATURES.ZIP_ARCHIVE)) {
        return { dangerous: true, type: 'ZIP_ARCHIVE', reason: 'ZIP 압축파일 헤더 감지' };
    }
    if (matchesBytes(buffer, 0, DANGEROUS_SIGNATURES.PDF_DOCUMENT)) {
        return { dangerous: true, type: 'PDF_DOCUMENT', reason: 'PDF 문서 헤더 감지' };
    }
    if (matchesBytes(buffer, 0, DANGEROUS_SIGNATURES.PNG_IMAGE)) {
        return { dangerous: true, type: 'PNG_IMAGE', reason: 'PNG 이미지 헤더 감지' };
    }

    // HTML / XML detection
    const textSnippet = buffer.slice(0, Math.min(buffer.length, 64)).toString('utf8').trim().toLowerCase();
    if (textSnippet.startsWith('<!doctype html') || textSnippet.startsWith('<html') || textSnippet.startsWith('<?xml') || textSnippet.startsWith('{"')) {
        return { dangerous: true, type: 'NON_AUDIO_TEXT', reason: 'HTML/XML/JSON 텍스트 형식 감지' };
    }

    return null;
}

/**
 * Validate WAV (RIFF/WAVE) structure.
 */
function detectWav(buffer) {
    if (buffer.length < 44) return null; // Standard minimum WAV header is 44 bytes

    // Bytes 0-3: 'RIFF'
    if (buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46) {
        return null;
    }
    // Bytes 8-11: 'WAVE'
    if (buffer[8] !== 0x57 || buffer[9] !== 0x41 || buffer[10] !== 0x56 || buffer[11] !== 0x45) {
        return null;
    }

    // Scan for 'fmt ' chunk in the first 512 bytes
    let hasFmt = false;
    for (let i = 12; i < Math.min(buffer.length - 4, 512); i++) {
        if (buffer[i] === 0x66 && buffer[i + 1] === 0x6D && buffer[i + 2] === 0x74 && buffer[i + 3] === 0x20) {
            hasFmt = true;
            break;
        }
    }

    if (!hasFmt) return null;

    return {
        format: AUDIO_FORMAT.WAV,
        canonicalMime: 'audio/wav',
        details: 'RIFF/WAVE PCM',
        mediaValidationStage: MEDIA_VALIDATION_STAGE.STRUCTURAL
    };
}

/**
 * Check if a 4-byte slice at offset is a valid MPEG Audio Frame Header.
 */
function parseMpegFrameHeaderAt(buffer, offset) {
    if (buffer.length < offset + 4) return null;
    if (buffer[offset] === 0xFF && (buffer[offset + 1] & 0xE0) === 0xE0) {
        const versionBits = (buffer[offset + 1] >> 3) & 0x03;
        const layerBits = (buffer[offset + 1] >> 1) & 0x03;
        const bitrateBits = (buffer[offset + 2] >> 4) & 0x0F;
        const sampleRateBits = (buffer[offset + 2] >> 2) & 0x03;

        // versionBits: 00=MPEG2.5, 10=MPEG2, 11=MPEG1. (01 is reserved)
        // layerBits: 01=Layer III, 10=Layer II, 11=Layer I. (00 is reserved)
        // bitrateBits: 1111 (15) is bad/forbidden
        // sampleRateBits: 11 (3) is reserved
        if (versionBits !== 1 && layerBits !== 0 && bitrateBits !== 15 && sampleRateBits !== 3) {
            return { versionBits, layerBits, bitrateBits, sampleRateBits };
        }
    }
    return null;
}

/**
 * Validate MP3 (ID3v2 with synchsafe size and MPEG Audio frame header).
 */
function detectMp3(buffer) {
    if (buffer.length < 10) return null;

    // 1. Check ID3v2 container
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
        const version = buffer[3];
        if (version >= 2 && version <= 4) {
            // Synchsafe integer validation: high bit of each byte must be 0
            const b6 = buffer[6], b7 = buffer[7], b8 = buffer[8], b9 = buffer[9];
            if ((b6 & 0x80) || (b7 & 0x80) || (b8 & 0x80) || (b9 & 0x80)) {
                return null; // Invalid synchsafe integer in ID3 size header
            }

            const tagDataSize = ((b6 & 0x7F) << 21) | ((b7 & 0x7F) << 14) | ((b8 & 0x7F) << 7) | (b9 & 0x7F);
            const totalId3Size = 10 + tagDataSize + ((buffer[5] & 0x10) ? 10 : 0); // 10-byte footer if flag set

            // Search for MPEG Audio Frame right after ID3 tag if buffer is sufficiently large
            let frameFound = false;
            if (buffer.length >= totalId3Size + 4) {
                const frame = parseMpegFrameHeaderAt(buffer, totalId3Size);
                if (frame) frameFound = true;
            }

            return {
                format: AUDIO_FORMAT.MP3,
                canonicalMime: 'audio/mpeg',
                details: `ID3v2.${version}${frameFound ? ' + MPEG Frame' : ' (ID3 container candidate)'}`,
                // If only ID3 tag exists without frame yet decoded, mark as pending_decode
                mediaValidationStage: frameFound ? MEDIA_VALIDATION_STAGE.STRUCTURAL : MEDIA_VALIDATION_STAGE.PENDING_DECODE
            };
        }
    }

    // 2. Scan for raw MPEG Audio Frame Header within first 512 bytes
    for (let i = 0; i < Math.min(buffer.length - 4, 512); i++) {
        const frame = parseMpegFrameHeaderAt(buffer, i);
        if (frame) {
            return {
                format: AUDIO_FORMAT.MP3,
                canonicalMime: 'audio/mpeg',
                details: 'MPEG Audio Sync Frame',
                mediaValidationStage: MEDIA_VALIDATION_STAGE.STRUCTURAL
            };
        }
    }

    return null;
}

/**
 * Validate M4A (ISO BMFF with ftyp box and audio brands).
 * Candidate container only - actual audio stream confirmation deferred to decode stage.
 */
function detectM4a(buffer) {
    if (buffer.length < 16) return null;

    // Bytes 4-7 must be 'ftyp' (0x66, 0x74, 0x79, 0x70)
    if (buffer[4] !== 0x66 || buffer[5] !== 0x74 || buffer[6] !== 0x79 || buffer[7] !== 0x70) {
        return null;
    }

    const boxSize = buffer.readUInt32BE(0);
    if (boxSize < 8 || boxSize > 4096) {
        return null; // Malformed box size
    }

    // Major brand at offset 8-11
    const majorBrand = buffer.slice(8, 12).toString('ascii');
    const validBrands = ['M4A ', 'M4B ', 'isom', 'mp42', 'mp41', 'dash', 'qt  '];

    let brandMatch = validBrands.includes(majorBrand) ? majorBrand.trim() : null;

    // Check compatible brands within ftyp box if majorBrand is generic
    if (!brandMatch) {
        for (let i = 16; i < Math.min(buffer.length - 4, boxSize); i += 4) {
            const brand = buffer.slice(i, i + 4).toString('ascii');
            if (validBrands.includes(brand)) {
                brandMatch = brand.trim();
                break;
            }
        }
    }

    if (brandMatch) {
        return {
            format: AUDIO_FORMAT.M4A,
            canonicalMime: 'audio/mp4',
            details: `ISO BMFF candidate (ftyp:${brandMatch})`,
            mediaValidationStage: MEDIA_VALIDATION_STAGE.PENDING_DECODE
        };
    }

    return null;
}

/**
 * Analyze buffer to detect audio signature or identify non-audio disguised payloads.
 * 
 * @param {Buffer} headerBuffer - Initial chunk buffer (at least 44 to 4096 bytes)
 * @returns {{ detected: boolean, format?: string, canonicalMime?: string, isDangerous: boolean, dangerType?: string, reason?: string }}
 */
export function detectAudioSignature(headerBuffer) {
    if (!headerBuffer || !Buffer.isBuffer(headerBuffer) || headerBuffer.length === 0) {
        return {
            detected: false,
            isDangerous: false,
            reason: '헤더 버퍼가 비어있습니다.'
        };
    }

    // 1. Check for dangerous non-audio signatures first
    const danger = detectDangerousSignature(headerBuffer);
    if (danger) {
        return {
            detected: false,
            isDangerous: true,
            dangerType: danger.type,
            reason: danger.reason
        };
    }

    // 2. Test for WAV
    const wavResult = detectWav(headerBuffer);
    if (wavResult) {
        return {
            detected: true,
            format: wavResult.format,
            canonicalMime: wavResult.canonicalMime,
            mediaValidationStage: wavResult.mediaValidationStage,
            isDangerous: false,
            details: wavResult.details
        };
    }

    // 3. Test for M4A
    const m4aResult = detectM4a(headerBuffer);
    if (m4aResult) {
        return {
            detected: true,
            format: m4aResult.format,
            canonicalMime: m4aResult.canonicalMime,
            mediaValidationStage: m4aResult.mediaValidationStage,
            isDangerous: false,
            details: m4aResult.details
        };
    }

    // 4. Test for MP3
    const mp3Result = detectMp3(headerBuffer);
    if (mp3Result) {
        return {
            detected: true,
            format: mp3Result.format,
            canonicalMime: mp3Result.canonicalMime,
            mediaValidationStage: mp3Result.mediaValidationStage,
            isDangerous: false,
            details: mp3Result.details
        };
    }

    // Signature not recognized as valid audio
    return {
        detected: false,
        isDangerous: false,
        mediaValidationStage: MEDIA_VALIDATION_STAGE.REJECTED,
        reason: '지원되는 오디오(MP3, WAV, M4A) 매직넘버 시그니처가 감지되지 않았습니다.'
    };
}
