'use strict';

/**
 * VerificationResult
 * src/fingerprint/VerificationResult.js
 *
 * Describes the outcome of a single file integrity check.
 * Returned by AssetStore.verify() and FingerprintStore.verify().
 *
 * status values:
 *   matched — file exists on disk and hash matches the record
 *   missing — file does not exist at record.extractedPath
 *   changed — file exists but hash differs from the record
 */

class VerificationResult {

    /**
     * @param {object} opts
     * @param {FingerprintRecord} opts.record       - The record that was verified
     * @param {string}            opts.status       - 'matched' | 'missing' | 'changed'
     * @param {string}            opts.expectedHash - Hash stored in the FingerprintRecord
     * @param {string|null}       opts.actualHash   - Hash computed from disk, null if missing
     */
    constructor({ record, status, expectedHash, actualHash = null }) {
        this.record       = record;
        this.status       = status;
        this.expectedHash = expectedHash;
        this.actualHash   = actualHash;
        this.verifiedAt   = new Date();
    }

    /**
     * Returns true if the file exists and its hash matches the record.
     * @returns {boolean}
     */
    isValid() {
        return this.status === 'matched';
    }

    toJSON() {
        return {
            status:       this.status,
            expectedHash: this.expectedHash,
            actualHash:   this.actualHash,
            verifiedAt:   this.verifiedAt.toISOString(),
            record:       this.record ? this.record.toJSON() : null
        };
    }

}

module.exports = VerificationResult;
