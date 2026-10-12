/**
 * MEMOIRE DE PROCESSUS des creations SIGNees mais NON VERIFIEES.
 *
 * POURQUOI : apres « Back to proposals », l'ecran de creation est DEMONTE et
 * perd son etat local (`createResult`). Sans registre, revenir dans
 * « New proposal » pendant la MEME session redevenait une seconde creation
 * possible alors qu'une signature reelle existe deja.
 *
 * PORTEE EXACTE : memoire de module. Elle survit au demontage / remontage de
 * l'ecran et a la navigation dans la session courante. Elle NE survit PAS a la
 * fermeture complete de l'application : AUCUNE persistance disque n'est
 * implementee ici, donc la protection apres app kill reste explicitement NON
 * couverte (voir `PENDING_CREATION_PROCESS_LIFETIME_ONLY`).
 *
 * DONNEES STOCKEES : uniquement les metadonnees necessaires a la recuperation.
 * JAMAIS de cle privee, mot de passe, seed, session wallet, ni payload de
 * transaction signee.
 */

export type PendingCreationScope = {
  /** Reseau cible (« devnet »). */
  cluster: string;
  /** Adresse du multisig proprietaire. */
  multisigAddress: string;
  /** Adresse du vault source. */
  vaultAddress: string;
  /** Index de transaction ATTENDU pour cette creation. */
  transactionIndexNext: number;
};

export type PendingCreationRecord = PendingCreationScope & {
  /** PDA de proposition attendu (capture a la signature). */
  proposalPda: string;
  /** PDA de transaction attendu (capture a la signature). */
  transactionPda: string;
  /** Signature REELLE de creation : seule preuve d'un envoi possible. */
  signature: string;
  /** Horodatage d'enregistrement (diagnostic / duree de vie). */
  createdAt: number;
};

/**
 * Ce drapeau documente la limite : la protection est valable pendant la duree de
 * vie du processus, PAS apres une fermeture complete de l'application.
 */
export const PENDING_CREATION_PROCESS_LIFETIME_ONLY = true;

/** Motifs de purge AUTORISES (preuves uniquement). */
export const PENDING_CREATION_CLEAR_REASONS = [
  'proposal_found_and_verified',
  'terminal_failure_confirmed',
  'cluster_mismatch',
  'vault_mismatch',
  'invalid_record',
] as const;

/** Motifs qui NE purgent JAMAIS (resultat non concluant). */
export const PENDING_CREATION_KEEP_REASONS = [
  'rpc_error',
  'timeout',
  'proposal_temporarily_absent',
  'ambiguous_result',
] as const;

const records = new Map<string, PendingCreationRecord>();

/** Cle d'identite du record : cluster + multisig + vault + index attendu. */
export function pendingCreationKey(scope: PendingCreationScope): string {
  return [
    scope.cluster,
    scope.multisigAddress,
    scope.vaultAddress,
    String(scope.transactionIndexNext),
  ].join('|');
}

/** Enregistre une creation signee non verifiee (ecrase toute entree identique). */
export function rememberPendingCreation(record: PendingCreationRecord): void {
  records.set(pendingCreationKey(record), record);
}

/** Record en attente pour ce perimetre exact, ou null. */
export function pendingCreationFor(scope: PendingCreationScope): PendingCreationRecord | null {
  return records.get(pendingCreationKey(scope)) ?? null;
}

/**
 * Purge du record. Uniquement sur une PREUVE (proposition verifiee, echec
 * terminal confirme, incoherence). Jamais sur une erreur reseau, un timeout ou
 * une absence momentanee.
 */
export function forgetPendingCreation(scope: PendingCreationScope): void {
  records.delete(pendingCreationKey(scope));
}

/**
 * Un record n'est restauré que s'il est COMPLET et COHERENT avec le perimetre
 * courant : un cluster ou un vault qui ne correspond pas ne doit jamais
 * ressusciter l'etat d'une autre tentative.
 */
export function isValidPendingCreation(
  record: PendingCreationRecord | null,
  scope: PendingCreationScope,
): boolean {
  if (record === null) return false;
  if (record.cluster !== scope.cluster) return false;
  if (record.multisigAddress !== scope.multisigAddress) return false;
  if (record.vaultAddress !== scope.vaultAddress) return false;
  if (record.transactionIndexNext !== scope.transactionIndexNext) return false;
  if (record.signature.length === 0) return false;
  if (record.proposalPda.length === 0) return false;
  if (record.transactionPda.length === 0) return false;
  return true;
}

/**
 * Purge les records INCOHERENTS du meme multisig (cluster / vault / index
 * differents) : ils ne peuvent plus correspondre a une reprise legitime.
 */
export function forgetMismatchedPendingCreations(scope: PendingCreationScope): void {
  const expected = pendingCreationKey(scope);
  for (const key of [...records.keys()]) {
    const record = records.get(key);
    if (record === undefined) continue;
    if (record.multisigAddress !== scope.multisigAddress) continue;
    if (key !== expected) records.delete(key);
  }
}

/** Nombre de records vivants (diagnostic). */
export function pendingCreationCount(): number {
  return records.size;
}

/** Reinitialisation : reservee aux tests (aucun usage applicatif). */
export function resetPendingCreationsForTests(): void {
  records.clear();
}
