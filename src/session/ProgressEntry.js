'use strict';

/**
 * ProgressEntry
 * src/session/ProgressEntry.js
 *
 * Tracks the four atomic build steps for a single asset through Phase 2.
 * Written to CommitProgress JSON on disk after each step completes —
 * allows the pipeline to resume from the exact step that failed.
 *
 * Steps in order:
 *   extracted — asset bytes read from AssetStore or working directory
 *   verified  — SHA-256 of extracted bytes confirmed against stored hash
 *   packed    — bytes written to the correct .build pack file
 *   cleaned   — asset removed from working directory (new assets only)
 *
 * deleted assets skip all four steps — they are excluded from the build.
 */

class ProgressEntry {

    /**
     * @param {object}  opts
     * @param {string}  opts.fileFingerprint - Hash identifying this asset
     * @param {string}  opts.decodedName     - Human-readable filename for logging
     * @param {number}  opts.packId          - Target pack slot (1-8)
     * @param {string}  opts.category        - 'in-store' | 'new' | 'deleted'
     * @param {boolean} opts.extracted
     * @param {boolean} opts.verified
     * @param {boolean} opts.packed
     * @param {boolean} opts.cleaned
     */
    constructor({
        fileFingerprint,
        decodedName,
        packId,
        category   = 'new',
        extracted  = false,
        verified   = false,
        packed     = false,
        cleaned    = false
    } = {}) {
        this.fileFingerprint = fileFingerprint;
        this.decodedName     = decodedName;
        this.packId          = packId;
        this.category        = category;
        this.extracted       = extracted;
        this.verified        = verified;
        this.packed          = packed;
        this.cleaned         = cleaned;
    }

    // ---------------------------------------------------------------------------
    // Status
    // ---------------------------------------------------------------------------

    /**
     * Returns true when all four steps are complete.
     * @returns {boolean}
     */
    isComplete() {
        return this.extracted && this.verified && this.packed && this.cleaned;
    }

    /**
     * Returns the name of the next incomplete step, or null if all done.
     * Used for resume logic and progress logging.
     *
     * @returns {string|null}
     */
    nextStep() {
        if (!this.extracted) return 'extracted';
        if (!this.verified)  return 'verified';
        if (!this.packed)    return 'packed';
        if (!this.cleaned)   return 'cleaned';
        return null;
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            fileFingerprint: this.fileFingerprint,
            decodedName:     this.decodedName,
            packId:          this.packId,
            category:        this.category,
            extracted:       this.extracted,
            verified:        this.verified,
            packed:          this.packed,
            cleaned:         this.cleaned
        };
    }

    /**
     * @param {object} obj
     * @returns {ProgressEntry}
     */
    static fromJSON(obj) {
        return new ProgressEntry({
            fileFingerprint: obj.fileFingerprint,
            decodedName:     obj.decodedName,
            packId:          obj.packId          || 0,
            category:        obj.category        || 'new',
            extracted:       obj.extracted       || false,
            verified:        obj.verified        || false,
            packed:          obj.packed          || false,
            cleaned:         obj.cleaned         || false
        });
    }

}

module.exports = ProgressEntry;
