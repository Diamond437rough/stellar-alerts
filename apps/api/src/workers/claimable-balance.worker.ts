import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { hashMerkleLeaf, buildMerkleTree, generateMerkleProof, verifyMerkleProof } from '@stellar-alerts/shared';

export const claimableBalanceLifecycle = new WorkerLifecycleManager({
  workerName: 'ClaimableBalanceWatcher',
  drainTimeoutMs: 10_000,
  maxInFlight: 5,
  autoRegisterSignals: true,
});

/** Predicate types for claimable balance time locks */
export type PredicateType = 'unconditional' | 'rel_before' | 'abs_before' | 'not' | 'and' | 'or';

/** A predicate node in a claimable balance claimant's claim predicate tree */
export interface ClaimPredicate {
  type: PredicateType;
  /** Absolute ledger number before which the balance can be claimed (for abs_before) */
  absBeforeLedger?: number;
  /** Relative ledger offset before which the balance can be claimed (for rel_before) */
  relBeforeLedger?: number;
  /** Negation of the sub-predicate */
  not?: ClaimPredicate;
  /** Conjunction of sub-predicates */
  and?: ClaimPredicate[];
  /** Disjunction of sub-predicates */
  or?: ClaimPredicate[];
}

/** Entry point for a claimable balance entry */
export interface ClaimableBalanceEntry {
  id: string;
  asset: string;
  amount: string;
  sponsor: string;
  claimants: ClaimantEntry[];
  lastModifiedLedger: number;
}

/** Individual claimant's predicate */
export interface ClaimantEntry {
  destination: string; // claimant's address
  predicate: ClaimPredicate;
}

/** Alert types for claimable balance lifecycle */
export type ClaimableBalanceAlertType = 'CREATED' | 'EXPIRING_SOON' | 'EXPIRED' | 'NOW_CLAIMABLE';

/** Alert generated for a claimable balance event */
export interface ClaimableBalanceAlert {
  balanceId: string;
  claimantAddress: string;
  asset: string;
  amount: string;
  type: ClaimableBalanceAlertType;
  message: string;
  /** The ledger number when the balance becomes/became claimable */
  claimableAtLedger?: number;
  /** The ledger number when the balance expires/expired */
  expiredAtLedger?: number;
}

/**
 * Evaluates a claim predicate tree against a current ledger number.
 *
 * Returns whether the balance is claimable and any relevant timing information.
 */
export function evaluateClaimPredicate(
  predicate: ClaimPredicate | Record<string, unknown>,
  currentLedger: number
): {
  isClaimable: boolean;
  claimableAtLedger?: number;
  expiredAtLedger?: number;
} {
  const type = predicate.type as PredicateType | undefined;
  const absBeforeLedger = predicate.absBeforeLedger as number | undefined;

  // Handle case where type is not specified (backward compatibility)
  if (!type && absBeforeLedger !== undefined) {
    // Original behavior: just check absBeforeLedger for expiry warning
    return {
      isClaimable: false, // Will be handled by caller as expiring soon
      expiredAtLedger: absBeforeLedger,
    };
  }

  switch (type) {
    case 'unconditional':
      return { isClaimable: true };

    case 'rel_before': {
      // Claimable relative to some base; in practice this would be relative to
      // when the balance was created. For now, we treat relBeforeLedger as
      // offset from current context.
      const ledgersUntilClaim = predicate.relBeforeLedger ?? 0;
      const claimableAt = currentLedger + ledgersUntilClaim;
      return {
        isClaimable: currentLedger >= claimableAt,
        claimableAtLedger: claimableAt,
      };
    }

    case 'abs_before': {
      // Absolute ledger number - claimable before this ledger
      const expiresAt = predicate.absBeforeLedger ?? 0;
      const stillValid = currentLedger < expiresAt;
      return {
        isClaimable: !stillValid, // Becomes claimable AFTER the expiry ledger
        expiredAtLedger: expiresAt,
      };
    }

    case 'not': {
      // predicate.not could be undefined, handle gracefully
      const notPredicate = predicate.not ?? { type: 'unconditional' };
      const result = evaluateClaimPredicate(notPredicate, currentLedger);
      return {
        isClaimable: !result.isClaimable,
        claimableAtLedger: result.claimableAtLedger,
        expiredAtLedger: result.expiredAtLedger,
      };
    }

    case 'and': {
      // All sub-predicates must be claimable
      const results = predicate.and!.map((sub) =>
        evaluateClaimPredicate(sub, currentLedger)
      );
      const allClaimable = results.every((r) => r.isClaimable);
      return {
        isClaimable: allClaimable,
        claimableAtLedger: results.find((r) => r.claimableAtLedger)?.claimableAtLedger,
        expiredAtLedger: results.find((r) => r.expiredAtLedger)?.expiredAtLedger,
      };
    }

    case 'or': {
      // At least one sub-predicate must be claimable
      const results = predicate.or!.map((sub) =>
        evaluateClaimPredicate(sub, currentLedger)
      );
      const anyClaimable = results.some((r) => r.isClaimable);
      return {
        isClaimable: anyClaimable,
        claimableAtLedger: results.find((r) => r.claimableAtLedger)?.claimableAtLedger,
        expiredAtLedger: results.find((r) => r.expiredAtLedger)?.expiredAtLedger,
      };
    }

    default:
      return { isClaimable: false };
  }
}

/**
 * Safely evaluate a claim predicate, returning a fallback if predicate is undefined */
function safeEvaluateClaimPredicate(predicate: ClaimPredicate | undefined, currentLedger: number): ReturnType<typeof evaluateClaimPredicate> {
  if (!predicate) return { isClaimable: false };
  return evaluateClaimPredicate(predicate, currentLedger);
}

/**
 * Process a claimable balance and generate alerts for monitored claimants.
 *
 * Recursively evaluates claimable balance predicate trees (unconditional, rel_before, abs_before)
 * and dispatches notifications to claimants when balances become claimable.
 */
export function processClaimableBalance(
  balance: ClaimableBalanceEntry,
  currentLedger: number,
  monitoredAddresses: Set<string>
): ClaimableBalanceAlert[] {
  const alerts: ClaimableBalanceAlert[] = [];

  for (const claimant of balance.claimants) {
    // Skip if this claimant is not being monitored
    if (!monitoredAddresses.has(claimant.destination)) {
      continue;
    }

    // Evaluate the predicate against the current ledger
    const evaluation = safeEvaluateClaimPredicate(claimant.predicate, currentLedger);

    // Newly created balance - always emit CREATED alert
    alerts.push({
      balanceId: balance.id,
      claimantAddress: claimant.destination,
      asset: balance.asset,
      amount: balance.amount,
      type: 'CREATED',
      message: `New claimable balance ${balance.id} created for ${claimant.destination}`,
      claimableAtLedger: evaluation.claimableAtLedger,
      expiredAtLedger: evaluation.expiredAtLedger,
    });

    // Check if balance has expired
    if (evaluation.expiredAtLedger && currentLedger >= evaluation.expiredAtLedger) {
      alerts.push({
        balanceId: balance.id,
        claimantAddress: claimant.destination,
        asset: balance.asset,
        amount: balance.amount,
        type: 'EXPIRED',
        message: `Claimable balance ${balance.id} expired at ledger ${evaluation.expiredAtLedger}`,
      });
    }

    // Check if balance is now claimable (within window)
    if (evaluation.isClaimable && !evaluation.expiredAtLedger) {
      alerts.push({
        balanceId: balance.id,
        claimantAddress: claimant.destination,
        asset: balance.asset,
        amount: balance.amount,
        type: 'NOW_CLAIMABLE',
        message: `Claimable balance ${balance.id} is now claimable for ${claimant.destination}`,
        claimableAtLedger: evaluation.claimableAtLedger,
      });
    }

    // Check for expiring soon (within 100 ledgers)
    if (evaluation.claimableAtLedger && currentLedger >= evaluation.claimableAtLedger - 100) {
      alerts.push({
        balanceId: balance.id,
        claimantAddress: claimant.destination,
        asset: balance.asset,
        amount: balance.amount,
        type: 'EXPIRING_SOON',
        message: `Claimable balance ${balance.id} expires in ${currentLedger - evaluation.claimableAtLedger + 100} ledgers for ${claimant.destination}`,
      });
    }
  }

  return alerts;
}

export default {
  processClaimableBalance,
  evaluateClaimPredicate,
};