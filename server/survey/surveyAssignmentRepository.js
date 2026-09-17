/**
 * server/survey/surveyAssignmentRepository.js
 * Append-only assignment history store for Track B survey submissions.
 */

import crypto from 'crypto';
import { SURVEY_STORAGE_FILES } from './surveyConstants.js';

export class SurveyAssignmentRepository {
    /**
     * @param {Object} deps
     * @param {Function} deps.getData
     * @param {Function} deps.persistData
     */
    constructor(deps = {}) {
        if (!deps.getData || !deps.persistData) {
            throw new Error('SurveyAssignmentRepository requires getData and persistData dependencies');
        }
        this.getData = deps.getData;
        this.persistData = deps.persistData;
    }

    _nowIso() {
        return new Date().toISOString();
    }

    getHistoryList() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_ASSIGNMENT_HISTORY, []);
    }

    async saveHistoryList(list) {
        return this.persistData(SURVEY_STORAGE_FILES.SURVEY_ASSIGNMENT_HISTORY, list);
    }

    /**
     * Record an assignment or reassignment event into append-only history.
     */
    async recordAssignmentHistory({
        surveySubmissionId,
        previousAssignedUserId,
        newAssignedUserId,
        changedByUserId,
        reason,
        previousPriority,
        newPriority
    }) {
        const list = this.getHistoryList();
        const historyItem = {
            assignmentHistoryId: `asgh_${crypto.randomUUID()}`,
            surveySubmissionId,
            previousAssignedUserId: previousAssignedUserId || null,
            newAssignedUserId,
            assignedUserId: newAssignedUserId,
            changedByUserId: changedByUserId || 'system',
            actorUserId: changedByUserId || 'system',
            changedAt: this._nowIso(),
            timestamp: this._nowIso(),
            reason: reason ? String(reason).trim() : null,
            previousPriority: previousPriority || null,
            newPriority,
            priority: newPriority
        };

        list.push(historyItem);
        await this.saveHistoryList(list);
        return historyItem;
    }

    /**
     * Alias for recordAssignmentHistory supporting flexible payload formats.
     */
    async recordAssignment(params = {}) {
        return this.recordAssignmentHistory({
            surveySubmissionId: params.surveySubmissionId || params.submissionId || params.internalSurveyId,
            previousAssignedUserId: params.previousAssignedUserId,
            newAssignedUserId: params.newAssignedUserId || params.assignedUserId,
            changedByUserId: params.changedByUserId || params.actorUserId || params.actorId,
            reason: params.reason,
            previousPriority: params.previousPriority,
            newPriority: params.newPriority || params.priority
        });
    }

    /**
     * Get assignment history for a specific survey submission.
     */
    getHistoryBySurveyId(surveySubmissionId) {
        const list = this.getHistoryList();
        return list
            .filter(item => item.surveySubmissionId === surveySubmissionId)
            .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());
    }
}
