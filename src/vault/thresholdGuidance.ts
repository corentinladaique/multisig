/**
 * Guidance de seuil pour un vault de TROIS signataires (2 of 3).
 *
 * Module PUR : aucun `react-native`, aucun RPC, aucun envoi. Il rend le TON et
 * les TEXTES du panneau d'aide de l'etape « Threshold » en fonction du seuil
 * choisi (1, 2 ou 3) :
 *   - 2 -> ton `success` (vert) : recommandation, comportement historique ;
 *   - 1 -> ton `error` (danger) : aucun accord partage, un seul signer suffit ;
 *   - 3 -> ton `warning` (avertissement) : accord unanime, disponibilite a risque.
 *
 * `null` hors du cas 3 signataires : les configurations a 2 ou plus de 3 signers
 * gardent leurs propres avertissements, rien n'est force ici.
 */

import {
  THREE_MEMBER_RECOMMENDATION,
  THREE_MEMBER_RECOMMENDATION_DETAIL,
} from './thresholdRecommendation';

export type ThresholdTone = 'success' | 'error' | 'warning';

export type ThresholdGuidance = {
  /** Ton du panneau : doit correspondre a un `InfoTone` de la primitive V2. */
  tone: ThresholdTone;
  glyph: string;
  /** Titre du panneau (premiere ligne). */
  label: string;
  /** Corps du panneau (explication courte et concrete). */
  detail: string;
  /** Phrase recapitulative affichee sous le panneau. */
  summary: string;
};

/**
 * Guidance du seuil pour un vault de trois signataires, ou `null`.
 *
 * `recommendation` est la recommandation partagee du module
 * `thresholdRecommendation` : elle reste la SEULE source du texte « 2 of 3 »
 * recommande, de sorte que le panneau vert ne diverge jamais du module fige.
 */
export function thresholdGuidanceFor(
  memberCount: number,
  threshold: number,
  recommendation: { detail: string; label: string } | null = null,
): ThresholdGuidance | null {
  if (memberCount !== 3) return null;
  if (threshold === 1) {
    return {
      detail:
        'Any single signer can move funds alone. One compromised or malicious signer takes everything.',
      glyph: '⚠',
      label: 'Not recommended: 1 of 3',
      summary: 'With 1 of 3, a single signer can approve alone. Approval is never shared.',
      tone: 'error',
    };
  }
  if (threshold === 2) {
    return {
      detail: recommendation?.detail ?? THREE_MEMBER_RECOMMENDATION_DETAIL,
      glyph: '★',
      label: recommendation?.label ?? THREE_MEMBER_RECOMMENDATION,
      summary:
        'With 2 of 3, any two signers can approve. The vault remains accessible if one signer is unavailable.',
      tone: 'success',
    };
  }
  if (threshold === 3) {
    return {
      detail:
        'All three members must approve. If one signer is unavailable, the vault is blocked.',
      glyph: '⚠',
      label: 'Risky: 3 of 3',
      summary: 'With 3 of 3, all three approvals are required. Losing one signer makes the vault unusable.',
      tone: 'warning',
    };
  }
  return null;
}