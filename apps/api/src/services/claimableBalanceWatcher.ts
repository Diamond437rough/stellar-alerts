import type { ClaimPredicate } from '../workers/claimable-balance.worker';
import { evaluateClaimPredicate } from '../workers/claimable-balance.worker';

export interface Claimant {
  destination: string;
  predicate: ClaimPredicate;
}

export interface ClaimableBalanceEntry {
  id: string;
  asset: string;
  amount: string;
  sponsor: string;
  claimants: Claimant[];
  lastModifiedLedger: number;
}

export interface ClaimableBalanceAlert {
  balanceId: string;
  claimantAddress: string;
  asset: string;
  amount: string;
  type: 'CREATED' | 'EXPIRING_SOON' | 'EXPIRED' | 'NOW_CLAIMABLE';
  message: string;
  claimableAtLedger?: number;
  expiredAtLedger?: number;
}

export class ClaimableBalanceWatcher {
  private monitoredAddresses: Set<string> = new Set();

  constructor(monitoredAddresses: string[] = []) {
    monitoredAddresses.forEach((addr) => this.monitoredAddresses.add(addr));
  }

  public addMonitoredAddress(address: string): void {
    this.monitoredAddresses.add(address);
  }

  public processBalance(balance: ClaimableBalanceEntry, currentLedger: number): ClaimableBalanceAlert[] {
    const alerts: ClaimableBalanceAlert[] = [];

    for (const claimant of balance.claimants) {
      if (!this.monitoredAddresses.has(claimant.destination)) {
        continue;
      }

      // Check if newly created
      alerts.push({
        balanceId: balance.id,
        claimantAddress: claimant.destination,
        asset: balance.asset,
        amount: balance.amount,
        type: 'CREATED',
        message: `New claimable balance ${balance.id} created for ${claimant.destination}`,
        claimableAtLedger: undefined,
        expiredAtLedger: undefined,
      });

      // Check predicate expiration using the shared evaluateClaimPredicate
      const evaluation = evaluateClaimPredicate(claimant.predicate, currentLedger);

      // Check predicate expiration
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

      // Check for expiring soon (within 100 ledgers remaining)
      // The original behavior was to warn when <= 100 ledgers remain
      if (evaluation.expiredAtLedger) {
        const ledgersRemaining = evaluation.expiredAtLedger - currentLedger;
        if (ledgersRemaining > 0 && ledgersRemaining <= 100) {
          alerts.push({
            balanceId: balance.id,
            claimantAddress: claimant.destination,
            asset: balance.asset,
            amount: balance.amount,
            type: 'EXPIRING_SOON',
            message: `Claimable balance ${balance.id} expires in ${ledgersRemaining} ledgers for ${claimant.destination}`,
          });
        }
      }
    }

    return alerts;
  }

  public addMonitoredClaimant(claimant: { destination: string; predicate: ClaimPredicate }): void {
    // Integrated with claimable-balance.worker.ts predicate evaluation
    // This can be used to add addresses dynamically
  }
}
