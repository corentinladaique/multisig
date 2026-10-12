import {
  classifyProposal,
  type ProposalFilterGroup,
  type ProposalFilterInput,
} from '../squads/proposalFilters';

/**
 * Filtre à SÉLECTIONNER au retour depuis le détail d'une proposition.
 *
 * Règle : la dernière catégorie VÉRIFIÉE on-chain si elle est connue, sinon le
 * filtre d'ORIGINE. Un statut inconnu (`verifiedStatus === null`, lecture
 * impossible / panne réseau) ne devine RIEN : on garde l'origine, on ne classe
 * jamais la proposition dans un groupe inventé (donc jamais « Done » à tort).
 *
 * Pure et testable : réutilise `classifyProposal` (AUCUNE seconde logique de
 * classement), aucun RPC, aucun wallet, aucun effet de bord.
 */
export function resolveReturnFilter(
  origin: ProposalFilterGroup,
  verifiedStatus: string | null,
  input: Omit<ProposalFilterInput, 'status'>,
): ProposalFilterGroup {
  if (verifiedStatus === null) return origin;
  return classifyProposal({ ...input, status: verifiedStatus });
}
