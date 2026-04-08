'use strict';

/**
 * LockError
 * src/session/LockError.js
 *
 * Thrown by SessionManager when a user attempts to modify a StagedFile
 * that is locked by a different user.
 *
 * Caught by APIServer handlers to return HTTP 423 Locked with enough
 * context for the UI to display who holds the lock.
 */

class LockError extends Error {

    /**
     * @param {string}      lockedBy         - userId of the user holding the lock
     * @param {string|null} lockedByUsername - Display name of the lock holder, or null
     */
    constructor(lockedBy, lockedByUsername = null) {
        super(`File is locked by ${lockedByUsername || lockedBy}`);
        this.name             = 'LockError';
        this.lockedBy         = lockedBy;
        this.lockedByUsername = lockedByUsername;
    }

}

module.exports = LockError;
