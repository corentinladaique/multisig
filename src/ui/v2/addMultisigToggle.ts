/**
 * Décisions PURES du bloc « Multisig address » de l'écran SANS vault
 * (`no-saved` / `no-active`).
 *
 * Le bloc est révélé soit par le chemin de choix (`choosingVault`, armé par
 * `openVaultPicker`), soit par un tap explicite (`addMultisigOpen`). Règle
 * voulue par l'utilisateur : un tap EXPLICITE gagne TOUJOURS — il doit pouvoir
 * REPLIER le bloc même lorsqu'il n'est visible que grâce au chemin de choix.
 */

/**
 * Valeur suivante de `addMultisigOpen` après un tap explicite de bascule.
 *
 * - Si le bloc n'est visible QUE grâce au chemin de choix
 *   (`choosingVault` vrai, `addMultisigOpen` faux), le tap le REPLIE :
 *   on force `false`.
 * - Sinon on bascule normalement : ouvre au 1er tap, referme au 2e.
 */
export function nextAddMultisigOpen(previous: boolean, choosingVault: boolean): boolean {
  return choosingVault ? false : !previous;
}

/**
 * Le bloc est-il visible ? Il l'est si l'utilisateur l'a ouvert explicitement
 * (`addMultisigOpen`) OU si le chemin de choix l'a révélé (`choosingVault`).
 * C'est EXACTEMENT la garde de rendu de la carte d'état vide.
 */
export function isAddMultisigVisible(addMultisigOpen: boolean, choosingVault: boolean): boolean {
  return addMultisigOpen || choosingVault;
}
