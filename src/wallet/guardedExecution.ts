/**
 * Orchestration PURE de la sequence d'execution d'une proposition.
 *
 * Aucun React, aucun import RN : uniquement l'ORDRE des operations et la
 * PROPRIETE du verrou. L'ecran fournit les effets (lecture du solde, wallet,
 * envoi) ; ce module decide l'ordre et garantit qu'une invocation concurrente
 * s'arrete AVANT toute lecture et tout envoi.
 *
 * Quatre etats DISTINCTS, jamais confondus :
 *   - « execution en cours »   -> le verrou (propriete, booleen, objet `lock`) ;
 *   - « signature obtenue »    -> porte par le resultat de `signAndSend` ;
 *   - « envoye, non verifie »  -> deduit d'une signature REELLE, jamais du verrou ;
 *   - « verifie on-chain »     -> porte par le resultat (`verified`).
 *
 * Un booleen de tentative n'est JAMAIS presente comme une preuve d'envoi.
 */

export type ExecutionBlockedReason =
  | 'already_starting'
  | 'balance_unreadable'
  | 'insufficient_balance'
  | 'approval_in_flight'
  | 'already_awaiting_verification'
  | 'no_wallet';

export type ExecutionRunDeps<TOutcome> = {
  /** Relecture du solde du vault. Un rejet est CAPTURE ici, jamais propage. */
  readBalance: () => Promise<number | null>;
  /** Le solde relu ne couvre pas le montant de la proposition. */
  isInsufficientBalance: (freshLamports: number | null) => boolean;
  /** Une approbation est encore en cours de verification. */
  approvalInFlight: () => boolean;
  /** Une signature d'execution REELLE et non verifiee existe deja (preuve). */
  hasUnverifiedExecutionSignature: () => boolean;
  /** Un wallet est connecte. */
  walletConnected: () => boolean;
  /** Remise a un etat propre (messages anterieurs effaces) JUSTE avant l'envoi. */
  prepare: () => void;
  /** Ouvre le wallet et soumet — appele AU PLUS UNE FOIS par invocation titulaire. */
  signAndSend: () => Promise<TOutcome>;
};

export type ExecutionRunResult<TOutcome> =
  | { kind: 'blocked'; reason: ExecutionBlockedReason; detail?: string }
  | { kind: 'sent'; outcome: TOutcome }
  | { kind: 'failed'; detail: string };

/** Titulaire du verrou : le MEME objet mutable est passe a chaque invocation. */
export type ExecutionLock = { current: boolean };

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Sequence gardee. L'invocation qui ACQUIERT le verrou (synchrone, avant toute
 * operation qui cede la main) est SEULE a pouvoir le rendre : toute invocation
 * concurrente sort immediatement, sans toucher a l'etat de la premiere.
 */
export async function runGuardedExecution<TOutcome>(
  lock: ExecutionLock,
  deps: ExecutionRunDeps<TOutcome>,
): Promise<ExecutionRunResult<TOutcome>> {
  // PROPRIETE : synchrone. Aucun `await` ne doit s'intercaler avant cette ligne,
  // sinon un double appui peut entrer deux fois dans la sequence.
  if (lock.current) return { kind: 'blocked', reason: 'already_starting' };
  lock.current = true;
  try {
    let freshLamports: number | null;
    try {
      freshLamports = await deps.readBalance();
    } catch (caught: unknown) {
      // Lecture impossible : RIEN n'a ete envoye, aucune ouverture de wallet.
      return { kind: 'blocked', reason: 'balance_unreadable', detail: describe(caught) };
    }
    if (deps.isInsufficientBalance(freshLamports)) {
      return { kind: 'blocked', reason: 'insufficient_balance' };
    }
    if (deps.approvalInFlight()) {
      return { kind: 'blocked', reason: 'approval_in_flight' };
    }
    if (deps.hasUnverifiedExecutionSignature()) {
      // Preuve REELLE (signature non verifiee), jamais le booleen ci-dessus.
      return { kind: 'blocked', reason: 'already_awaiting_verification' };
    }
    if (!deps.walletConnected()) {
      return { kind: 'blocked', reason: 'no_wallet' };
    }
    deps.prepare();
    try {
      const outcome = await deps.signAndSend();
      return { kind: 'sent', outcome };
    } catch (caught: unknown) {
      return { kind: 'failed', detail: describe(caught) };
    }
  } finally {
    // Seul le titulaire atteint ce point : le doublon est sorti AVANT d'acquérir.
    lock.current = false;
  }
}
