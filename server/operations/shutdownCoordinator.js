/**
 * server/operations/shutdownCoordinator.js
 * Graceful shutdown coordinator for voice and operational subsystems.
 */

export const SHUTDOWN_STATE = Object.freeze({
    IDLE: 'IDLE',
    SHUTTING_DOWN: 'SHUTTING_DOWN',
    TERMINATED: 'TERMINATED',
    FAILED: 'FAILED'
});

export class ShutdownCoordinator {
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs || 5000;
        this.hooks = [];
        this.state = SHUTDOWN_STATE.IDLE;
    }

    /**
     * Register a graceful shutdown hook.
     * @param {string} name 
     * @param {Function} hookAsyncFn 
     * @param {number} priority higher runs first
     */
    registerHook(name, hookAsyncFn, priority = 10) {
        if (typeof hookAsyncFn !== 'function') {
            throw new Error('Shutdown hook must be a function');
        }
        this.hooks.push({ name, fn: hookAsyncFn, priority });
        this.hooks.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Execute registered shutdown hooks in order of priority within timeoutMs.
     */
    async shutdown() {
        if (this.state === SHUTDOWN_STATE.SHUTTING_DOWN || this.state === SHUTDOWN_STATE.TERMINATED) {
            return { state: this.state, completed: true };
        }

        this.state = SHUTDOWN_STATE.SHUTTING_DOWN;
        const results = [];

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Graceful shutdown timeout exceeded')), this.timeoutMs);
        });

        const executionPromise = (async () => {
            for (const hook of this.hooks) {
                try {
                    await hook.fn();
                    results.push({ name: hook.name, success: true });
                } catch (err) {
                    results.push({ name: hook.name, success: false, error: err.message || 'Unknown hook error' });
                }
            }
        })();

        try {
            await Promise.race([executionPromise, timeoutPromise]);
            this.state = SHUTDOWN_STATE.TERMINATED;
            return {
                state: this.state,
                completed: true,
                results
            };
        } catch (err) {
            this.state = SHUTDOWN_STATE.FAILED;
            return {
                state: this.state,
                completed: false,
                error: err.message,
                results
            };
        }
    }
}
