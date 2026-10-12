/**
 * Affichage LISIBLE et ARRONDI d'un coût, SANS suffixe.
 *
 * PUREMENT d'affichage : la valeur transactionnelle en lamports n'est NI lue ni
 * modifiée. La valeur EXACTE reste disponible ailleurs (diagnostics replies).
 * Volontairement séparé de `vaultBalance` (qui exige une arithmétique ENTIÈRE) :
 * l'arrondi est un service de PRÉSENTATION, pas un calcul de solde.
 *
 * Exemples : 3_759_120 -> '0.0038' ; 200_000_000 -> '0.2' ;
 *            1_234_500_000 -> '1.2' ; 1 -> '0.000000001'.
 */

/** Chiffres significatifs conservés. */
const SIGNIFICANT_DIGITS = 2;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function formatRoundedSolAmount(lamports: number): string {
  if (!Number.isFinite(lamports) || lamports === 0) return '0';
  const sol = lamports / LAMPORTS_PER_SOL;
  const magnitude = Math.floor(Math.log10(Math.abs(sol)));
  const decimals = Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(sol * factor) / factor;
  const text = rounded.toFixed(decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
