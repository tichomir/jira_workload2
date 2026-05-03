/**
 * FaultInjectionConfig — env-gated fault injection flags for backup/restore engines.
 *
 * IMPORTANT: All flags are hard-gated behind NODE_ENV !== 'production'.
 * In production every flag is null regardless of env var values — this
 * module can never alter production behaviour.
 *
 * Supported environment variables (test / dev / staging only):
 *
 *   FAULT_SUSPEND_HEARTBEAT_MS
 *     Suspend heartbeat emission for this many milliseconds.
 *     A value > 20 000 triggers the stalled-job alert in the UI.
 *     UI signal: GET /api/jobs/:id → { stalled: true, status: 'stalled' }
 *     Example: FAULT_SUSPEND_HEARTBEAT_MS=25000
 *
 *   FAULT_ATTACHMENT_ERROR_RATE
 *     Float in [0.0, 1.0]. Each attachment download fails with this probability.
 *     Drives the 'Completed with N errors' job completion status.
 *     UI signal: GET /api/jobs/:id → { displayStatus: 'Completed with N errors', status: 'completed_with_errors' }
 *     Example: FAULT_ATTACHMENT_ERROR_RATE=0.5   (≈50% of attachments fail)
 *
 *   FAULT_HALT_RESTORE_PHASE
 *     Name of the restore phase that should emit a hard diagnostic fault,
 *     halting all subsequent restore phases.
 *     Accepted values: project | workflow | custom_field | board | sprint | issue_body | post_issue
 *     UI signal: GET /restore/jobs/:id → { failureDiagnostic: '<PHASE>_FAULT_INJECTED: ...', status: 'failed' }
 *     Example: FAULT_HALT_RESTORE_PHASE=workflow
 *
 * Usage in code (only wire in at the injection site, not in hot paths):
 *
 *   import { readFaultInjectionFlags, isFaultInjectionActive } from '../fault-injection/FaultInjectionConfig';
 *
 *   const flags = readFaultInjectionFlags();
 *   if (isFaultInjectionActive(flags) && flags.attachmentErrorRate !== null) {
 *     if (Math.random() < flags.attachmentErrorRate) {
 *       throw new Error('ATTACHMENT_FAULT_INJECTED');
 *     }
 *   }
 */

export interface FaultInjectionFlags {
  /**
   * Suspend heartbeat emission for this many milliseconds.
   * Null when not set or when NODE_ENV === 'production'.
   */
  suspendHeartbeatMs: number | null;

  /**
   * Probability (0.0–1.0) that an individual attachment download fails.
   * Null when not set or when NODE_ENV === 'production'.
   */
  attachmentErrorRate: number | null;

  /**
   * Name of the restore phase that should fail hard (triggering phase-halt diagnostic).
   * Null when not set or when NODE_ENV === 'production'.
   */
  haltRestorePhase: string | null;
}

/** Null-safe sentinel: all flags off — safe to spread anywhere. */
export const NO_FAULT_INJECTION: Readonly<FaultInjectionFlags> = Object.freeze({
  suspendHeartbeatMs: null,
  attachmentErrorRate: null,
  haltRestorePhase: null,
});

/**
 * Reads fault-injection flags from environment variables.
 *
 * Returns a copy of NO_FAULT_INJECTION (all nulls) when:
 *   - NODE_ENV === 'production', OR
 *   - no fault env vars are set.
 *
 * Malformed numeric values (NaN, out-of-range) are silently treated as null.
 * Never throws.
 */
export function readFaultInjectionFlags(): FaultInjectionFlags {
  // Production hard-gate: no fault injection possible in production
  if (process.env.NODE_ENV === 'production') {
    return { ...NO_FAULT_INJECTION };
  }

  const rawSuspend = process.env.FAULT_SUSPEND_HEARTBEAT_MS;
  const rawRate    = process.env.FAULT_ATTACHMENT_ERROR_RATE;
  const rawPhase   = process.env.FAULT_HALT_RESTORE_PHASE ?? null;

  const suspendMs = rawSuspend != null ? parseInt(rawSuspend, 10) : null;
  const errorRate = rawRate    != null ? parseFloat(rawRate)       : null;

  return {
    suspendHeartbeatMs:
      suspendMs != null && isFinite(suspendMs) && suspendMs > 0 ? suspendMs : null,

    attachmentErrorRate:
      errorRate != null &&
      isFinite(errorRate) &&
      errorRate >= 0 &&
      errorRate <= 1
        ? errorRate
        : null,

    haltRestorePhase: rawPhase,
  };
}

/**
 * Returns true when at least one fault injection flag is active.
 * Use as a fast guard so hot-path code can skip the rest of the check.
 */
export function isFaultInjectionActive(flags: FaultInjectionFlags): boolean {
  return (
    flags.suspendHeartbeatMs !== null ||
    flags.attachmentErrorRate !== null ||
    flags.haltRestorePhase !== null
  );
}

/**
 * Decides deterministically whether a single attachment download should fail
 * under the current fault injection config.
 *
 * When NODE_ENV === 'production' or attachmentErrorRate is null, always returns false.
 *
 * @param flags  The current fault injection config.
 * @param random A [0, 1) random sample — defaults to Math.random().
 *               Inject a fixed value in tests for deterministic behaviour.
 */
export function shouldFailAttachment(
  flags: FaultInjectionFlags,
  random: number = Math.random(),
): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (flags.attachmentErrorRate === null) return false;
  return random < flags.attachmentErrorRate;
}

/**
 * Returns true when the given phase name matches the fault-halt phase.
 *
 * Always false in production or when haltRestorePhase is null.
 */
export function shouldHaltPhase(flags: FaultInjectionFlags, phase: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return flags.haltRestorePhase !== null && flags.haltRestorePhase === phase;
}
