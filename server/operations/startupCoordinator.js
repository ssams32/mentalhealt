/**
 * server/operations/startupCoordinator.js
 * Manages operational startup assessment for voice subsystems.
 * Ensures legacy referral operations remain unaffected if voice is unconfigured or disabled.
 */

import { VoiceSystemReadiness } from './voiceSystemReadiness.js';
import { OPERATIONAL_STATUS } from './operationConstants.js';

export class StartupCoordinator {
    constructor(options = {}) {
        this.options = options;
        this.readiness = new VoiceSystemReadiness(options);
    }

    /**
     * Coordinate startup check and decide if voice operations should be enabled.
     * Legacy operations are guaranteed to remain operational.
     */
    async evaluateStartup() {
        const assessment = this.readiness.assessReadiness();
        const canStartVoice = assessment.voiceSystemOperational &&
            assessment.overallStatus !== OPERATIONAL_STATUS.CORRUPTED &&
            assessment.overallStatus !== OPERATIONAL_STATUS.BLOCKED;

        return {
            timestamp: assessment.timestamp,
            voiceEnabled: this.options.voiceEnabled ?? false,
            voiceSystemCanStart: canStartVoice,
            overallVoiceStatus: assessment.overallStatus,
            legacyReferralOperationsOperational: true,
            summary: assessment.summary,
            subsystems: assessment.subsystems
        };
    }
}
