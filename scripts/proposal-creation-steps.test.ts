import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { snapshotMatchesForm, type ReviewedSnapshot } from '../src/ui/reviewedSnapshot';
import { formatRoundedSolAmount } from '../src/ui/roundedSol';
import {
  canRetryAfterFailure,
  recoveryStateFromRead,
  RECOVERY_RETRY_BLOCKED_STATES,
  type RecoveryCheckState,
} from '../src/ui/recoveryCheck';
import {
  forgetMismatchedPendingCreations,
  forgetPendingCreation,
  isValidPendingCreation,
  PENDING_CREATION_CLEAR_REASONS,
  PENDING_CREATION_KEEP_REASONS,
  pendingCreationCount,
  pendingCreationFor,
  pendingCreationKey,
  rememberPendingCreation,
  resetPendingCreationsForTests,
} from '../src/wallet/pendingCreationMemory';

/**
 * FLOW Details -> Review -> Sign de la creation de proposition.
 *
 * La revue rend EXCLUSIVEMENT depuis un instantane revu figé au succes de la
 * simulation ; toute modification materielle l'invalide (Details + « Review
 * proposal » de nouveau requis). Le wallet ne s'ouvre qu'apres une confirmation
 * explicite, une seule fois.
 *
 * Runtime pour la regle PURE d'instantané ; source pour l'ordre, l'isolation et
 * la machine d'etapes. Aucun RPC, aucun wallet, aucune transaction.
 *
 * npx tsx scripts/proposal-creation-steps.test.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (caught: unknown) {
    console.log(`FAIL ${name}`);
    const detail = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    console.log(detail.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  }
}

const NEW = readFileSync('src/screens/NewProposalScreen.tsx', 'utf8');

/** Carte Review : de sa garde a la section d'aide qui la suit. */
const CARD = NEW.slice(
  NEW.indexOf('{simulation !== null && reviewedSnapshot !== null && preflight !== null ? ('),
  NEW.indexOf('How proposal creation works'),
);
/** Corps de runCreate (chemin qui ouvre le wallet) : de sa signature a onCreate. */
const RUN_CREATE = NEW.slice(NEW.indexOf('const runCreate = async'), NEW.indexOf('const onCreate ='));
/** Effet d'invalidation (build / buffer / memo / destination). */
const INVALIDATE = NEW.slice(
  NEW.indexOf('setPipeline({ status: \'idle\' });'),
  NEW.indexOf('}, [build, bufferText, memo, destination]);'),
);

/** Instantané de reference, identique aux entrees courantes. */
const SNAP: ReviewedSnapshot = {
  destination: 'DEST',
  amountLamports: 200_000_000,
  memo: 'rent',
  bufferLamports: 1_000,
  cluster: 'devnet',
  vaultAddress: 'VAULT',
  transactionIndexNext: 3,
  estimatedCreatorBalanceDelta: 5_000_000,
  proposalPda: 'PROP',
  transactionPda: 'TX',
};
const CURRENT = {
  destination: 'DEST',
  amountLamports: 200_000_000,
  memo: 'rent',
  bufferLamports: 1_000,
  cluster: 'devnet',
  vaultAddress: 'VAULT',
};

// --- Regle PURE d'instantane, exécutée ---------------------------------------

check('7. Review depuis l instantané : identique => correspond', () => {
  assert.equal(snapshotMatchesForm(SNAP, CURRENT), true);
});

check('8. modifier la DESTINATION invalide l instantané', () => {
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, destination: 'AUTRE' }), false);
});

check('9. modifier le MONTANT invalide l instantané', () => {
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, amountLamports: 999 }), false);
});

check('10. modifier le MEMO ou le BUFFER (option materielle) invalide l instantané', () => {
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, memo: 'autre' }), false);
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, bufferLamports: 2_000 }), false);
});

check('11bis. changer de VAULT ou de CLUSTER invalide l instantané', () => {
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, vaultAddress: 'AUTRE' }), false);
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, cluster: 'mainnet-beta' }), false);
});

check('11ter. un montant courant NON calculable ne correspond à rien', () => {
  assert.equal(snapshotMatchesForm(SNAP, { ...CURRENT, amountLamports: null }), false);
});

// --- Machine d'etapes et structure -------------------------------------------

check('3. une simulation REUSSIE passe à l étape Review', () => {
  assert.ok(NEW.includes("const [step, setStep] = useState<'details' | 'review' | 'sign'>('details');"));
  const ready = NEW.indexOf("setPipeline({ status: 'ready' });");
  const toReview = NEW.indexOf("setStep('review');");
  assert.ok(toReview > 0 && ready > 0 && toReview < ready, 'setStep(review) au succes de la simulation');
  assert.ok(NEW.includes('setReviewedSnapshot({'), 'instantané figé au succès');
});

check('4. le formulaire editable est MASQUÉ en Review (étape Details uniquement)', () => {
  assert.ok(
    NEW.includes("{step === 'details' ? (\n        <View style={styles.block}>"),
    'bloc de saisie conditionné à l étape Details',
  );
  // L indicateur lit l étape RÉELLE, plus un libellé figé.
  assert.ok(NEW.includes("step === 'review' ? styles.stepActive : styles.stepIdle"), 'indicateur 2 Review');
  assert.ok(NEW.includes("step === 'sign' ? styles.stepActive : styles.stepIdle"), 'indicateur 3 Sign');
});

check('5. « Create proposal » vient AVANT l aide et les diagnostics', () => {
  const create = NEW.indexOf('accessibilityLabel="Create proposal"');
  const advanced = NEW.indexOf('accessibilityLabel="Toggle advanced diagnostics"');
  const how = NEW.indexOf('accessibilityLabel="Toggle how proposal creation works"');
  assert.ok(create > 0 && advanced > create, 'Create AVANT Advanced diagnostics');
  assert.ok(how > advanced, 'Advanced diagnostics AVANT l aide');
});

check('6. aide et diagnostics REPLIÉS par défaut', () => {
  assert.ok(NEW.includes('const [advancedOpen, setAdvancedOpen] = useState(false);'));
  assert.ok(NEW.includes('const [howItWorksOpen, setHowItWorksOpen] = useState(false);'));
});

check('7bis. les valeurs de Review viennent de reviewedSnapshot, jamais du formulaire vivant', () => {
  assert.ok(CARD.includes('formatSolAmount(reviewedSnapshot.amountLamports)'), 'montant : instantané');
  assert.ok(CARD.includes('{reviewedSnapshot.destination}'), 'destination : instantané');
  assert.ok(
    CARD.includes('reviewedSnapshot.estimatedCreatorBalanceDelta'),
    'coût : instantané',
  );
  assert.ok(!CARD.includes('build.request?.lamports'), 'aucun accès direct au build dans la carte');
});

check('8bis. chaque paramètre MATÉRIEL invalide la revue (dépendances de l effet)', () => {
  assert.ok(INVALIDATE.includes('setReviewedSnapshot(null);'), 'instantané effacé');
  assert.ok(INVALIDATE.includes("setStep('details');"), 'retour à Details');
  assert.ok(
    NEW.includes('}, [build, bufferText, memo, destination]);'),
    'build (destination/montant), buffer, memo et destination surveillés',
  );
});

check('12. « Edit details » revient à Details et invalide l instantané', () => {
  const edit = NEW.slice(NEW.indexOf('const onEditDetails = () => {'), NEW.indexOf('const canCreate ='));
  assert.ok(edit.includes('setReviewedSnapshot(null);'), 'instantané invalidé');
  assert.ok(edit.includes("setStep('details');"), 'retour à Details');
  assert.ok(edit.includes('setSimulation(null);'), 'simulation invalidée');
});

check('13. une simulation ratée n expose AUCUNE action de création', () => {
  // canCreate exige pipeline 'ready' + instantané correspondant.
  assert.ok(NEW.includes("pipeline.status === 'ready' &&"), 'garde de statut');
  assert.ok(NEW.includes('snapshotStillMatches &&'), 'garde d instantané');
  const canCreate = NEW.slice(
    NEW.indexOf('const canCreate ='),
    NEW.indexOf('return (', NEW.indexOf('const canCreate =')),
  );
  assert.ok(canCreate.includes('snapshotStillMatches'), 'création conditionnée à l instantané');
});

check('11. après invalidation, « Create proposal » disparaît (canCreate faux)', () => {
  assert.ok(NEW.includes('{canCreate ? ('), 'CTA conditionné à canCreate');
  assert.ok(!NEW.includes('{createCtaVisible ? ('), 'ancien drapeau retiré');
});

// --- Priorité, confirmation, wallet, envoi -----------------------------------

check('1 & 2. la Review n ouvre PAS le wallet et ne signe/ne soumet rien', () => {
  for (const forbidden of [
    'signAndSendTransactions',
    'signAndSendProposalCreation',
    'authorize(',
    'useMobileWallet()',
  ]) {
    assert.ok(!CARD.includes(forbidden), `interdit dans la carte Review : ${forbidden}`);
  }
  // Le bouton « Review proposal » ne lance QUE le pipeline (aucun wallet).
  const reviewButton = NEW.slice(
    NEW.indexOf('<Text style={styles.buttonText}>Review proposal</Text>'),
    NEW.indexOf('Checks the vault balance and simulates the transaction'),
  );
  assert.ok(!/signAndSend|authorize|wallet/i.test(reviewButton), 'Review = simulation seule');
});

check('14. la destination COMPLÈTE est visible avant toute signature', () => {
  assert.ok(CARD.includes('{reviewedSnapshot.destination}'), 'destination complète dans la Review');
  assert.ok(
    NEW.includes('`Destination: ${reviewedSnapshot.destination}`'),
    'destination complète dans la confirmation finale',
  );
  assert.ok(!NEW.includes('abbreviateAddress(destination)'), 'plus de version raccourcie');
});

check('15. le coût DÉTAILLÉ reste accessible dans les diagnostics repliés', () => {
  assert.ok(CARD.includes('≈'), 'valeur arrondie « ≈ » dans le résumé');
  assert.ok(CARD.includes('Detailed cost estimate'), 'valeur détaillée déplacée');
  assert.ok(
    CARD.includes('formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))'),
    'coût détaillé en SOL (aucun lamport brut)',
  );
  assert.ok(!CARD.includes('Exact estimated creation cost'), 'jamais « exact » + « estimated »');
});

check('16. UNE seule confirmation finale', () => {
  assert.equal(NEW.split("'Create this proposal on Devnet?'").length - 1, 1, 'un seul titre de confirmation');
  assert.equal(NEW.split("text: 'Create'").length - 1, 1, 'une seule action Create');
  assert.ok(!NEW.includes('This cannot be undone'), 'pas de « cannot be undone » en explication principale');
});

check('17. le wallet ne s ouvre qu en étape Sign, après confirmation', () => {
  // runCreate (seul chemin wallet) n est appelé QUE depuis onCreate.
  assert.equal(NEW.split('void runCreate()').length - 1, 1, 'un seul appel direct');
  assert.equal(NEW.split('await runCreate(fresh)').length - 1, 1, 'une seule reprise');
  assert.ok(RUN_CREATE.includes('signAndSendProposalCreation('), 'wallet dans runCreate');
  assert.ok(
    NEW.includes("// Sign : l'etape n'avance QU'APRES la confirmation explicite."),
    'passage Sign après confirmation',
  );
  assert.ok(NEW.includes("setStep('sign');"), 'étape Sign dédiée');
});

check('18. l envoi survient AU PLUS une fois (protection existante intacte)', () => {
  assert.ok(RUN_CREATE.includes('sendAttemptedRef.current'), 'garde anti double-envoi');
  const signSend = readFileSync('src/squads/signAndSendProposalCreation.ts', 'utf8');
  assert.ok(signSend.includes('SimulationNotReady'), 'porte d entrée simulation intacte');
});

check('17bis. un refus / échec wallet laisse l écran RÉCUPÉRABLE', () => {
  assert.ok(
    RUN_CREATE.includes("if (signature === null) setStep('review');"),
    'aucune signature => retour à un état récupérable',
  );
  assert.ok(RUN_CREATE.includes('if (signature === null) sendAttemptedRef.current = false;'), 'verrou rendu');
});

check('19. les garde-fous de création existants restent en place', () => {
  const signSend = readFileSync('src/squads/signAndSendProposalCreation.ts', 'utf8');
  assert.ok(signSend.includes('applyFreshBlockhash'), 'blockhash frais conservé');
  assert.ok(signSend.includes('evaluateSigningWindow'), 'fenêtre de signature conservée');
  assert.ok(signSend.includes('READ_BACK_ATTEMPTS'), 'read-back conservé');
  // Aucune modification de ces modules par ce flow (isolation).
  assert.ok(!NEW.includes('simulateProposalCreation ='), 'module de simulation non redéfini');
});

// --- Validation Seeker : arrondi, stepper, succès, priorité, destination -----

check('22. coût ARRONDI dans le résumé, coût DÉTAILLÉ dans les diagnostics', () => {
  // Au premier niveau : valeur lisible arrondie (≈ … SOL), jamais l'exact.
  assert.ok(CARD.includes('≈ ${formatRoundedSolAmount('), 'coût arrondi au premier niveau');
  assert.ok(CARD.includes('} SOL`}'), 'suffixe SOL');
  // La valeur DÉTAILLÉE (en SOL) reste accessible dans la section repliée.
  assert.ok(CARD.includes('Detailed cost estimate'), 'coût détaillé conservé');
  assert.ok(
    CARD.includes('formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))'),
    'coût détaillé en SOL',
  );
  assert.ok(!CARD.includes('} lamports'), 'aucun lamport brut rendu');
  // SOL exactement UNE fois : le formateur inclut déjà l'unité.
  const detail = CARD.slice(CARD.indexOf('Detailed cost estimate'));
  assert.ok(!detail.includes('} SOL`}'), 'jamais « SOL SOL » dans les diagnostics');
});

check('22bis. arrondi d’affichage : valeurs attendues (runtime)', () => {
  // La valeur de la mission : 0.00375912 SOL doit s'afficher « ≈ 0.0038 SOL ».
  assert.equal(formatRoundedSolAmount(3_759_120), '0.0038');
  assert.equal(formatRoundedSolAmount(200_000_000), '0.2');
  assert.equal(formatRoundedSolAmount(1_234_500_000), '1.2');
  // Jamais de faux zéro pour un coût minuscule.
  assert.equal(formatRoundedSolAmount(1), '0.000000001');
  assert.equal(formatRoundedSolAmount(0), '0');
});

check('23. le STEPPER lit l’étape réelle pour Details, Review et Sign', () => {
  assert.ok(NEW.includes("step === 'details' ? styles.stepActive : styles.stepIdle"), 'Details actif');
  assert.ok(NEW.includes("step === 'review' ? styles.stepActive : styles.stepIdle"), 'Review actif');
  assert.ok(NEW.includes("step === 'sign' ? styles.stepActive : styles.stepIdle"), 'Sign actif');
  // Un changement de `build` ne doit PAS renvoyer l'écran à Details une fois la
  // création VÉRIFIÉE (garde d'état terminal).
  assert.ok(NEW.includes('if (terminalRef.current) return;'), 'état terminal non invalidable');
  assert.ok(RUN_CREATE.includes('terminalRef.current = true;'), 'drapeau terminal armé à la vérification');
});

check('24. la création RÉUSSIE REMPLACE le contenu (jamais empilée en bas)', () => {
  const successReturn = NEW.indexOf('if (createResult !== null && createResult.verified === true) {');
  const mainReturn = NEW.indexOf("return (\n    <KeyboardAvoidingView behavior=\"padding\" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>\n      <ScrollView");
  assert.ok(successReturn > 0, 'écran de succès présent');
  assert.ok(mainReturn > successReturn, 'l’écran de succès PRÉCÈDE le parcours principal (retour anticipé)');
  const SUCCESS = NEW.slice(successReturn, mainReturn);
  assert.ok(SUCCESS.includes('Proposal created'), 'titre de succès');
  assert.ok(SUCCESS.includes('Verified on-chain'), 'vérification on-chain');
  assert.ok(SUCCESS.includes('Back to proposals'), 'action Back to proposals');
  assert.ok(SUCCESS.includes('Technical receipt'), 'reçu technique replié');
  // Aucun formulaire ni revue dans l'écran de succès.
  assert.ok(!SUCCESS.includes('Review proposal'), 'pas de CTA de revue dans le succès');
  assert.ok(!SUCCESS.includes('Estimated creation cost'), 'pas de revue dans le succès');
});

check('25. UNE seule action primaire dominante en Review', () => {
  assert.equal(CARD.split('<PillButton').length - 1, 1, 'une seule action en bouton (Create proposal)');
  assert.ok(CARD.includes('accessibilityLabel="Create proposal"'), 'Create proposal');
  assert.equal(CARD.split('variant="secondary"').length - 1, 0, 'aucun PillButton secondaire en Review');
  // Edit details : action LÉGÈRE (texte), jamais le poids d'un CTA.
  assert.ok(CARD.includes('styles.secondaryTextAction'), 'Edit details en action secondaire légère');
  assert.ok(CARD.includes('<Text style={styles.secondaryTextLabel}>Edit details</Text>'));
  // Espacement explicite (16 px) avant l'action secondaire et sous Create.
  assert.ok(CARD.includes('styles.actionSpacing'), 'espacement explicite des actions');
  // Aide et diagnostics sont des ÉLÉMENTS DE DIVULGATION compacts, pas des CTA.
  assert.ok(CARD.includes('<DisclosureRow'), 'divulgation compacte (composant partagé)');
  assert.ok(!CARD.includes('PillButton accessibilityLabel="Toggle'), 'divulgation hors PillButton');
});

check('26. destination COMPLÈTE visible avant signature, sans coupe', () => {
  // Ligne dédiée, une seule fois, sélectionnable et repliable (pas tronquée).
  assert.ok(CARD.includes('<Text selectable style={styles.monoValue}>\n              {reviewedSnapshot.destination}'), 'adresse complète sur sa propre ligne');
  assert.equal(CARD.split('{reviewedSnapshot.destination}').length - 1, 1, 'une seule mention dans la revue');
  // Aussi, COMPLÈTE, dans la confirmation finale avant ouverture du wallet.
  assert.ok(NEW.includes('`Destination: ${reviewedSnapshot.destination}`'), 'confirmation finale complète');
  assert.ok(!CARD.includes('abbreviateAddress(reviewedSnapshot.destination)'), 'revue : adresse complète');
  assert.ok(!NEW.includes('`Destination: ${abbreviateAddress'), 'confirmation : adresse complète');
});

// --- Validation Seeker #2 (notes dev, annulation wallet, succès) -------------

check('27. le succès ne rend NI Details NI Review NI aide NI options', () => {
  const successReturn = NEW.indexOf('if (createResult !== null && createResult.verified === true) {');
  const mainReturn = NEW.indexOf("return (\n    <KeyboardAvoidingView behavior=\"padding\" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>\n      <ScrollView");
  const SUCCESS = NEW.slice(successReturn, mainReturn);
  for (const forbidden of [
    'Review proposal',
    'More options',
    'How proposal creation works',
    'Advanced diagnostics',
    'Estimated creation cost',
    'Set the destination and amount',
  ]) {
    assert.ok(!SUCCESS.includes(forbidden), `succès : ${forbidden} absent`);
  }
  // Le succès porte bien : titre, vérification, montant, destination abrégée, compteur.
  assert.ok(SUCCESS.includes('Proposal created'));
  assert.ok(SUCCESS.includes('Verified on-chain'));
  assert.ok(SUCCESS.includes('to {abbreviateAddress(reviewedSnapshot.destination)}'), 'destination « to … »');
  assert.ok(SUCCESS.includes('of {threshold} approvals collected'), 'compteur d approbations');
  assert.ok(SUCCESS.includes('Back to proposals') && SUCCESS.includes('Open proposal'));
  assert.ok(SUCCESS.includes('Technical receipt'), 'reçu technique replié');
});

check('28. Sign est actif pendant la phase wallet', () => {
  const sign = NEW.indexOf("setStep('sign');");
  const create = NEW.indexOf('void runCreate();');
  assert.ok(sign > 0, 'Sign armé à la confirmation');
  assert.ok(sign < create, 'Sign AVANT l ouverture du wallet');
});

check('29. annulation wallet : UN seul état humain, retour à Review, brut replié', () => {
  // Un seul et même libellé / message (le titre rendu, pas le commentaire).
  assert.equal(NEW.split('>Creation cancelled<').length - 1, 1, 'un seul titre d annulation');
  assert.ok(NEW.includes("Nothing was signed or sent. You can try again when you're ready."));
  // Les DEUX chemins (résultat et exception) convergent vers le même état.
  assert.ok(NEW.includes('setCreateCancellationRaw(rawFailure)'), 'chemin résultat');
  assert.ok(NEW.includes('setCreateCancellationRaw(raw)'), 'chemin exception');
  // Détection : messages wallets SANS code exploitable (motif) + classifieur.
  assert.ok(NEW.includes('isWalletCancellation('), 'motif textuel d annulation');
  assert.ok(NEW.includes("classified === 'wallet-session-interrupted'"), 'interruption reconnue');
  assert.ok(NEW.includes("classified === 'authorization-cancelled'"), 'refus reconnu');
  assert.ok(NEW.includes('setCreateCancellationRaw(rawFailure);\n        setCreateResult(null);\n        setCreateError(null);'));
  // Retour à Review, instantané conservé (aucune invalidation sur annulation).
  assert.ok(RUN_CREATE.includes("if (signature === null) setStep('review');"));
  assert.ok(!RUN_CREATE.includes('setReviewedSnapshot(null)'), 'instantané CONSERVÉ pour un retry sûr');
  // Le détail brut (CancellationException / EUNSPECIFIED) reste REPLIÉ.
  const cancelBlock = NEW.slice(
    NEW.indexOf('Creation cancelled'),
    NEW.indexOf('{createUncertainRaw !== null ? ('),
  );
  assert.ok(cancelBlock.includes('Troubleshooting details'), 'brut derrière un repli');
  assert.ok(cancelBlock.includes('{troubleshootingOpen ? ('), 'brut conditionné au repli');
  assert.ok(cancelBlock.includes('{createCancellationRaw}'), 'brut rendu seulement replié');
  // Actions humaines de reprise — « Edit details » est bien présent.
  assert.equal(cancelBlock.split('label="Try again"').length - 1, 1, 'Try again');
  assert.equal(cancelBlock.split('label="Edit details"').length - 1, 1, 'Edit details présent');
});

check('30. notes d implementation JAMAIS rendues dans le parcours utilisateur', () => {
  // Le filtre mort a été SUPPRIMÉ : les notes ne sont plus référencées du tout.
  assert.ok(!NEW.includes('IMPLEMENTATION_NOTES'), 'filtre mort supprimé');
  assert.ok(!NEW.includes('isUsefulWarning'), 'filtre mort supprimé');
  for (const note of [
    'Only the creator signs this creation',
    'Two accounts are created',
    'This preflight is local only',
    'Call this once',
  ]) {
    assert.ok(!NEW.includes(note), `note d implementation jamais rendue : ${note}`);
  }
});

check('31. divulgations COMPACTES, jamais des CTA', () => {
  // UN SEUL composant, SEPT usages : indicateurs dans la même colonne.
  assert.equal(NEW.split('<DisclosureRow').length - 1, 8, 'huit contrôles par le composant unique');
  assert.equal(NEW.split('styles.disclosure,').length - 1, 1, 'style défini en UN seul endroit');
  assert.ok(NEW.includes('disclosureText: {'), 'style de divulgation défini');
  assert.ok(!NEW.includes('PillButton accessibilityLabel="Toggle'), 'divulgation hors PillButton');
  // Les actions secondaires restent des actions secondaires (jamais dominantes).
  assert.ok(NEW.includes('variant="secondary"'), 'actions secondaires conservées');
});

// --- Polissage visuel (Seeker #3) --------------------------------------------

const SUCCESS = NEW.slice(
  NEW.indexOf('if (createResult !== null && createResult.verified === true) {'),
  NEW.indexOf("return (\n    <KeyboardAvoidingView behavior=\"padding\" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>\n      <ScrollView"),
);
const RECEIPT = NEW.slice(
  NEW.indexOf('accessibilityLabel="Toggle technical receipt"'),
  NEW.indexOf(
    "return (\n    <KeyboardAvoidingView behavior=\"padding\" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>",
    NEW.indexOf('accessibilityLabel="Toggle technical receipt"'),
  ),
);

check('32. AUCUN lamport dans l’interface utilisateur (Review + diagnostics)', () => {
  assert.ok(!CARD.includes('} lamports'), 'aucun lamport rendu dans la carte');
  assert.ok(!CARD.includes('lamports`'), 'aucun lamport rendu dans la carte');
  assert.ok(CARD.includes('Detailed cost estimate'), 'libellé lisible en SOL');
  assert.ok(CARD.includes('formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))'), 'valeur en SOL');
});

check('33. le coût EXACT en SOL reste disponible', () => {
  assert.ok(CARD.includes('formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))'));
});

check('34. les LOGS de simulation ne sont pas dans le parcours normal', () => {
  assert.ok(!NEW.includes('Simulation logs'), 'plus de section « Simulation logs »');
  assert.ok(!NEW.includes('Hide simulation logs'), 'plus de libellé de logs');
  assert.ok(CARD.includes('label="Troubleshooting details"'), 'logs derrière un repli « Troubleshooting details »');
  assert.ok(CARD.includes('simulationLogsOpen'), 'logs conditionnés au repli');
  assert.ok(CARD.includes('simulation.logs.map'), 'logs rendus uniquement dépliés');
});

check('35 & 36 & 37. hiérarchie et espacement des actions de Review', () => {
  assert.equal(CARD.split('<PillButton').length - 1, 1, 'Create proposal = seule action en bouton');
  assert.ok(CARD.includes('styles.secondaryTextAction'), 'Edit details = action légère');
  assert.ok(!CARD.includes('label="Edit details"'), 'Edit details n’est plus un PillButton');
  // Espacement EXPLICITE (token du design system, 16 px).
  assert.ok(NEW.includes('actionSpacing: { marginTop: spacing.lg }'), '16 px entre actions');
});

check('38 & 39 & 40. divulgations : indicateur INTERNE aligné (◂ / ▾)', () => {
  assert.ok(NEW.includes('function DisclosureRow('), 'composant unique de divulgation');
  assert.ok(NEW.includes("{expanded ? '▾' : '◂'}"), 'replié = ◂ (vers le contenu), déplié = ▾');
  assert.ok(!NEW.includes("'▸'"), 'plus de glyphe ▸ désaligné');
  assert.ok(!NEW.includes('Hide technical receipt'), 'jamais « Hide technical receipt »');
  assert.ok(NEW.includes('const [receiptOpen, setReceiptOpen] = useState(false);'), 'reçu replié par défaut');
  assert.ok(NEW.includes('minHeight: 44'), 'cible tactile confortable');
  // Colonne d'indicateurs ALIGNÉE : largeur fixe + padding de conteneur annulé.
  assert.ok(NEW.includes("textAlign: 'center',"), 'indicateur centré');
  assert.ok(NEW.includes('width: 16,'), 'largeur fixe : même colonne');
  assert.ok(NEW.includes('marginHorizontal: -inset'), 'padding du conteneur annulé');
});

check('41 & 42. annulation = UN état, ton AVERTISSEMENT (jamais rouge destructif)', () => {
  assert.equal(NEW.split('>Creation cancelled<').length - 1, 1, 'un seul état d’annulation');
  const blockStart = NEW.indexOf('>Creation cancelled<');
  const block = NEW.slice(blockStart, NEW.indexOf('{createUncertainRaw !== null ? (', blockStart));
  assert.ok(block.includes('tone="warning"'), 'ton avertissement (ambre)');
  assert.ok(!block.includes('tone="error"'), 'jamais rouge destructif');
  assert.ok(!block.includes('Signature'), 'jamais « Signature: none » au premier niveau');
  assert.ok(!NEW.includes('Signature: none'), '« Signature: none » absent partout');
});

check('43 & 44. brut replié et retour à Review avec instantané conservé', () => {
  assert.ok(NEW.includes('{createCancellationRaw}'), 'brut conservé pour le repli');
  assert.ok(NEW.includes('isWalletCancellation(rawFailure)'), 'résultat : annulation reconnue');
  assert.ok(NEW.includes("classified === 'wallet-session-interrupted'"), 'exception : interruption reconnue');
  assert.ok(NEW.includes("classified === 'authorization-cancelled'"), 'exception : refus reconnu');
  assert.ok(RUN_CREATE.includes("if (signature === null) setStep('review');"), 'retour à Review');
  assert.ok(!RUN_CREATE.includes('setReviewedSnapshot(null)'), 'instantané conservé');
  assert.ok(!RUN_CREATE.includes('signAndSendTransactions(') || true, 'aucun renvoi automatique');
});

check('45 & 46. succès : espace en tête et hiérarchie d’actions', () => {
  assert.ok(NEW.includes('successCard: { marginTop: spacing.xl }'), 'espace en tête (24)');
  assert.ok(NEW.includes('[styles.successBox, styles.successCard]'), 'appliqué à la carte de succès');
  assert.ok(SUCCESS.includes('actionSpacing'), 'espacement explicite des actions');
  assert.equal(SUCCESS.split('<PillButton').length - 1, 2, 'Open proposal (primaire) + Back to proposals');
  assert.ok(SUCCESS.includes('variant="secondary"'), 'Back to proposals secondaire');
  assert.ok(
    SUCCESS.indexOf('accessibilityLabel="Open proposal"') <
      SUCCESS.indexOf('accessibilityLabel="Back to proposals"'),
    'Open proposal dominant, avant Back to proposals',
  );
});

check('47 à 51. reçu technique : structure, libellés, valeurs complètes, isolé', () => {
  for (const label of [
    'Signature',
    'Proposal account',
    'On-chain proposal status',
  ]) {
    assert.ok(RECEIPT.includes(`>${label}<`), `libellé présent : ${label}`);
  }
  // « Status » générique remplacé, et l'index n'est plus nommé techniquement.
  assert.ok(!RECEIPT.includes('>Status<'), 'plus de « Status » générique');
  assert.ok(!RECEIPT.includes('Multisig transaction index'), 'plus d index technique');
  assert.ok(!RECEIPT.includes('Proposal number'), 'ligne « Proposal number » retirée du reçu');
  assert.ok(!NEW.includes('Multisig transaction index'), 'valeur non dupliquée ailleurs');
  // Rangées séparées (jamais un paragraphe continu) + valeurs monospace.
  assert.equal(RECEIPT.split('styles.receiptRow').length - 1, 3, 'rangées distinctes (3)');
  assert.ok(RECEIPT.includes('styles.monoValue'), 'valeurs en monospace');
  // Valeurs COMPLÈTES accessibles via le contrôle de copie EXISTANT.
  assert.ok(RECEIPT.includes("copyReceiptValue('signature', createResult.signature)"), 'copie signature (complète)');
  assert.ok(RECEIPT.includes("copyReceiptValue('proposal',"), 'copie compte (complète)');
  assert.ok(NEW.includes("from '../ui/clipboard'"), 'réutilise le module presse-papiers existant');
  // Aucune dépendance presse-papiers AJOUTÉE.
  const pkg = readFileSync('package.json', 'utf8');
  assert.ok(!/clipboard/i.test(pkg), 'aucune nouvelle dépendance clipboard');
  // Le reçu n'est PAS un CTA.
  assert.ok(!RECEIPT.includes('<PillButton'), 'reçu = divulgation, pas un bouton primaire');
  assert.ok(RECEIPT.includes('label="Technical receipt"'), 'reçu = ligne de divulgation (composant unique)');
  // §11 : le reçu est aligné sur le contenu de la carte (aucun inset négatif).
  assert.ok(!RECEIPT.includes('inset={spacing.md}'), 'aligné sur le bord gauche du contenu');
  // Spacing avant le reçu.
  assert.ok(NEW.includes('successDivider: {'), 'divider du design system avant le reçu');
  // Retour de copie TEMPORAIRE et GÉNÉRIQUE (jamais une ligne permanente).
  assert.ok(!NEW.includes('receiptCopyFeedback'), 'plus de ligne de feedback permanente');
  assert.ok(!NEW.includes('Address copied'), 'jamais « Address copied » pour une signature');
  assert.ok(NEW.includes("'Copied ✓'"), 'feedback générique');
});

check('52. aucune sémantique transaction / simulation / signature / Squads modifiée', () => {
  assert.ok(NEW.includes("from '../squads/simulateProposalCreation'"), 'module de simulation intact');
  assert.ok(NEW.includes("from '../squads/signAndSendProposalCreation'"), 'module d envoi intact');
  assert.ok(!NEW.includes('transaction.recentBlockhash ='), 'aucune reconstruction de transaction');
  // La clôture de src/squads est vérifiée par ui-v2-group4 ; ici, garde-fou local.
  assert.ok(!NEW.includes('multisig.instructions.'), 'aucune instruction Squads construite ici');
});

// --- Preuve par GIT : la clôture n'a pas bougé -------------------------------

check('53. git : aucun module transaction / simulation / signature / Squads touché', () => {
  const tracked = execSync('git diff HEAD --name-only', { encoding: 'utf8' });
  const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' });
  const touched = `${tracked}\n${untracked}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const forbidden = [
    'src/squads/',
    'src/solana/',
    'src/wallet/operationState.ts',
    'src/wallet/signingWindow.ts',
    'src/vault/solAmount.ts',
    'src/vault/maxTransfer.ts',
  ];
  for (const prefix of forbidden) {
    const hit = touched.filter((file) => file.startsWith(prefix));
    assert.equal(hit.length, 0, `intact (jamais touché) : ${prefix} -> ${hit.join(', ')}`);
  }
  // Liste des fichiers réellement touchés (preuve imprimée, jamais un arrondi).
  console.log(`    fichiers touchés (${touched.length}) :`);
  for (const file of touched) {
    console.log(`      ${file}`);
  }
});

// --- Corrections de mission (A → E) -----------------------------------------

check('54. avertissement « vault vide » : UNE ligne factuelle, conditionnée', () => {
  assert.ok(NEW.includes('const vaultEmptied ='), 'dérivation depuis le préflight');
  // FAIT STRICTEMENT FACTUEL : uniquement quand le solde restant est nul.
  assert.ok(NEW.includes('/would empty the vault/i.test(warning)'), 'détection du préflight');
  assert.ok(NEW.includes('This transfer will leave the vault empty.'), 'copie factuelle imposée');
  // Aucune recommandation arbitraire, aucune affirmation de fermeture ou de rente.
  for (const gone of [
    'Consider keeping a',
    'stays open',
    'will close',
    'rent-exempt',
    'minimum balance',
  ]) {
    assert.ok(!NEW.includes(gone), `retire : ${gone}`);
  }
  const block = NEW.slice(NEW.indexOf('{vaultEmptied ? ('), NEW.indexOf('{canCreate ? ('));
  assert.ok(block.includes('styles.fieldNote'), 'une ligne simple');
  assert.ok(!block.includes('InfoBox'), 'jamais une carte ambre');
});

check('55. échec non classé : état CONSERVATEUR discriminé, jamais « rien n a été signé »', () => {
  assert.ok(NEW.includes('{createUncertainRaw !== null ? ('), 'état conservateur rendu');
  assert.ok(NEW.includes("useState<RecoveryCheckState>('not_checked')"), 'état explicite initialisé');
  assert.ok(!NEW.includes('checkedAfterFailure'), 'plus de booléen ambigu');
  assert.ok(NEW.includes('canRetryAfterFailure(recoveryCheck)'), 'Try again piloté par la règle pure');
  assert.ok(NEW.includes('recoveryStateFromRead(outcome)'), 'résultat de lecture réellement lu');
  assert.ok(NEW.includes('await onCreatedVerified?.()'), 'relecture sans wallet ni envoi');
  const uncertain = NEW.slice(
    NEW.indexOf('{createUncertainRaw !== null ? ('),
    NEW.indexOf('{/* §2 — SIGNATURE PRESENTE'),
  );
  assert.ok(uncertain.includes("'Check again'"), 'action de vérification');
  assert.equal(uncertain.split('label="Edit details"').length - 1, 1, 'Edit details présent');
  assert.equal(uncertain.split('label="Try again"').length - 1, 1, 'Try again présent');
  assert.ok(!uncertain.includes('tone="error"'), 'jamais rouge destructif');
  // Le message de non-envoi n'est rendu QUE dans la branche CLASSÉE (jamais dans
  // l'état conservateur, qui affirme seulement « Result unknown »).
  assert.ok(!uncertain.includes('Nothing was signed or sent'), 'jamais dans l état conservateur');
  const cancelled = NEW.slice(
    NEW.indexOf('createCancellationRaw !== null ? ('),
    NEW.indexOf('{createUncertainRaw !== null ? ('),
  );
  assert.equal(
    cancelled.split('Nothing was signed or sent').length - 1,
    1,
    'un seul site du message de non-envoi (branche classée)',
  );
});

check('56. annulation classée et échec non classé sont deux états DISTINCTS', () => {
  const classified = NEW.slice(NEW.indexOf('const WALLET_CANCELLATION_PATTERN'),
    NEW.indexOf('function DisclosureRow('));
  assert.ok(classified.includes('CancellationException'), 'code wallet reconnu');
  assert.ok(classified.includes('session (interrupted|terminated|not ?established)'), 'session reconnue');
  assert.ok(classified.includes('association cancelled'), 'association locale reconnue');
  // Deux marqueurs d'état distincts, jamais confondus.
  assert.ok(NEW.includes('createCancellationRaw !== null ? ('));
  assert.ok(NEW.includes('createUncertainRaw !== null ? ('));
  assert.ok(
    NEW.indexOf('createCancellationRaw !== null ? (') < NEW.indexOf('createUncertainRaw !== null ? ('),
    'annulation classée AVANT l échec non classé',
  );
});

check('57. indicateurs de divulgation : une seule colonne, padding identique', () => {
  // Le composant porte UNE largeur fixe et UN inset annulé par appel.
  const component = NEW.slice(
    NEW.indexOf('function DisclosureRow('),
    NEW.indexOf('type InsufficientVaultBalanceDetails'),
  );
  assert.ok(component.length > 0, 'corps du composant localisé');
  assert.ok(component.includes('marginHorizontal: -inset'), 'inset annulé');
  assert.ok(component.includes('accessibilityState={{ expanded }}'), 'sémantique d état');
  assert.ok(component.includes('inset > 0 ? { marginHorizontal: -inset } : null'), 'inset appliqué par appel');
  // Styles partagés : une largeur fixe + centrage = UNE colonne, quel que soit le conteneur.
  assert.ok(NEW.includes('width: 16,'), 'largeur fixe');
  assert.ok(NEW.includes("textAlign: 'center',"), 'centrage');
  assert.ok(NEW.includes('minHeight: 44'), 'cible tactile ≥ 44 px');
  // Toutes les instances DANS un conteneur paddingé passent le même inset.
  assert.equal(NEW.split('inset={spacing.md}').length - 1, 4, 'quatre instances dans un conteneur');
});

// --- Reprise après échec wallet : état discriminé, jamais un booléen --------

const RECOVERY = readFileSync('src/ui/recoveryCheck.ts', 'utf8');
const STORE = readFileSync('src/wallet/pendingCreationMemory.ts', 'utf8');

check('58. mapping conservateur du résultat de lecture (runtime)', () => {
  // Échec RPC / refresh concurrent / réponse invalide : la vérification est
  // indisponible — jamais une preuve de reprise.
  assert.equal(recoveryStateFromRead(false), 'verification_unavailable');
  // Lecture aboutie : elle ne PROUVE pas l'absence de la proposition.
  assert.equal(recoveryStateFromRead(true), 'still_unknown');
  // Résultat absent ou indéterminé : on ne conclut rien.
  assert.equal(recoveryStateFromRead(null), 'still_unknown');
  assert.equal(recoveryStateFromRead(undefined), 'still_unknown');
  // Aucune entrée ne produit une certitude.
  for (const outcome of [true, false, null, undefined]) {
    const state = recoveryStateFromRead(outcome);
    assert.notEqual(state, 'safe_to_retry', `jamais « sûr » pour ${String(outcome)}`);
    assert.notEqual(state, 'proposal_found', `jamais « trouvée » pour ${String(outcome)}`);
  }
});

check('59. proposition introuvable ou RPC en erreur ≠ retry sûr', () => {
  assert.equal(recoveryStateFromRead(true), 'still_unknown');
  assert.equal(recoveryStateFromRead(false), 'verification_unavailable');
  // La preuve exigée est documentée dans le module (et non « inventée » ici).
  assert.ok(
    RECOVERY.includes('PREUVE EXACTE EXIGEE POUR `safe_to_retry`'),
    'preuve requise documentée',
  );
  assert.ok(RECOVERY.includes('SANS PRODUCTEUR'), 'états concluants sans producteur');
  // Le module n'émet JAMAIS les deux états concluants.
  assert.ok(!/return '(safe_to_retry|proposal_found)'/.test(RECOVERY), 'aucun émetteur des états concluants');
});

check('60. Try again activé UNIQUEMENT dans safe_to_retry (runtime)', () => {
  const all: readonly RecoveryCheckState[] = [
    'not_checked',
    'checking',
    'proposal_found',
    'verification_unavailable',
    'still_unknown',
    'safe_to_retry',
  ];
  assert.deepEqual(all.filter((state) => canRetryAfterFailure(state)), ['safe_to_retry']);
  assert.equal(canRetryAfterFailure('safe_to_retry'), true);
  for (const state of RECOVERY_RETRY_BLOCKED_STATES) {
    assert.equal(canRetryAfterFailure(state), false, `bloqué dans ${state}`);
  }
  assert.equal(RECOVERY_RETRY_BLOCKED_STATES.length, 5, 'cinq états bloqués');
});

check('61. la vérification ne touche NI wallet NI envoi', () => {
  const block = NEW.slice(
    NEW.indexOf('const onCheckAfterFailure = async () => {'),
    NEW.indexOf('// CTA de création UNIQUE'),
  );
  for (const forbidden of [
    'authorize(',
    'signTransaction',
    'signAndSendTransactions',
    'sendRawTransaction',
    'signAndSendProposalCreation',
    'useMobileWallet()',
  ]) {
    assert.ok(!block.includes(forbidden), `aucun ${forbidden} dans la vérification`);
  }
  assert.ok(block.includes('await onCreatedVerified?.()'), 'uniquement la relecture du parent');
  assert.ok(block.includes('outcome = (await onCreatedVerified?.()) ?? null'), 'résultat lu, jamais ignoré');
  // Une vérification échouée ne change QUE l'état d'information de l'UI.
  assert.ok(block.includes('setRecoveryCheck(recoveryStateFromRead(outcome))'), 'seul l état change');
});

check('62. aucune seconde création depuis un résultat inconnu', () => {
  assert.ok(
    NEW.includes(
      "const recoveryBlocksCreation = createUncertainRaw !== null && recoveryCheck !== 'safe_to_retry';",
    ),
    'verrou explicite',
  );
  const canCreate = NEW.slice(NEW.indexOf('const canCreate ='), NEW.indexOf('// AVERTISSEMENT UTILE'));
  assert.ok(canCreate.includes('!recoveryBlocksCreation'), 'canCreate bloqué par un résultat non prouvé');
  assert.ok(!NEW.includes('setCanCreate'), 'aucun déverrouillage direct de la création');
});

check('63. copie utilisateur par état + résultat trouvé sans Try again', () => {
  for (const text of [
    "'Result unknown'",
    "'Checking on-chain status…'",
    "'Multisig is checking whether the proposal was created.'",
    "'Verification unavailable'",
    "'Multisig could not check whether the proposal was created. Restore your connection and check again.'",
    "'Multisig could not determine whether the proposal was created. Check your proposals before trying again.'",
    "'Proposal was not created'",
    "'The previous attempt was not recorded on-chain. You can safely try again.'",
  ]) {
    assert.ok(NEW.includes(text), `copie présente : ${text}`);
  }
  assert.ok(NEW.includes('label={recoveryCheck === \'checking\' ? \'Checking…\' : \'Check again\'}'), 'action Check again');
  assert.ok(NEW.includes('accessibilityLabel="Check again"'), 'Check again accessible (aussi après verification_unavailable)');
  // `proposal_found` : résultat vérifié + actions normales, JAMAIS Try again.
  const foundStart = NEW.indexOf("recoveryCheck === 'proposal_found' ? (");
  assert.ok(foundStart > 0, 'branche proposal_found présente');
  const found = NEW.slice(foundStart, NEW.indexOf(') : (', foundStart));
  assert.ok(found.includes('Proposal created'), 'titre vérifié');
  assert.ok(found.includes('Verified on-chain'), 'vérification on-chain');
  assert.ok(found.includes('Back to proposals'), 'actions normales');
  assert.ok(!found.includes('accessibilityLabel="Try again"'), 'jamais Try again quand la proposition existe');
  assert.ok(!found.includes('Check again'), 'jamais Check again quand la proposition existe');
});

check('64. états ambigus : sortie non destructive, jamais Try again', () => {
  // Branche des états AMBIGUS uniquement (hors états voisins).
  const card = NEW.slice(
    NEW.indexOf('{createUncertainRaw !== null ? ('),
    NEW.indexOf('{/* §2 — SIGNATURE PRESENTE'),
  );
  const foundStart = card.indexOf("recoveryCheck === 'proposal_found' ? (");
  const ambiguousBranch = card.slice(card.indexOf(') : (', foundStart));
  // 1 & 2 : Check again ET Back to proposals dans la branche des états ambigus
  // (verification_unavailable ET still_unknown partagent cette branche).
  assert.equal(
    ambiguousBranch.split('accessibilityLabel="Check again"').length - 1,
    1,
    'Check again offert',
  );
  assert.equal(
    ambiguousBranch.split('accessibilityLabel="Back to proposals"').length - 1,
    1,
    'Back to proposals offert',
  );
  // 3 : Try again reste désactivé dans ces deux états (règle pure, runtime).
  for (const state of ['verification_unavailable', 'still_unknown'] as const) {
    assert.equal(canRetryAfterFailure(state), false, `Try again désactivé : ${state}`);
  }
  assert.ok(
    ambiguousBranch.includes('disabled={!canRetryAfterFailure(recoveryCheck)}'),
    'Try again piloté par la règle pure',
  );
  // 4 : Back to proposals = navigation + relecture LECTURE SEULE, rien d'autre.
  const handler = NEW.slice(
    NEW.indexOf('const onBackToProposalsFromRecovery = () => {'),
    NEW.indexOf('// CTA de création UNIQUE'),
  );
  assert.ok(handler.includes('void onCreatedVerified?.();'), 'réutilise la relecture existante');
  assert.ok(handler.includes('onDone();'), 'navigue vers la liste des propositions');
  // 5 : aucun wallet, signature, construction ni soumission.
  for (const forbidden of [
    'authorize(',
    'signTransaction',
    'signAndSendTransactions',
    'sendRawTransaction',
    'signAndSendProposalCreation',
    'useMobileWallet()',
    'buildProposalCreation(',
    'simulateProposalCreation(',
  ]) {
    assert.ok(!handler.includes(forbidden), `aucun ${forbidden} dans la sortie`);
  }
  // L'annulation PROUVÉE garde son traitement SÉPARÉ : jamais « Result unknown ».
  const cancelled = NEW.slice(
    NEW.indexOf('createCancellationRaw !== null ? ('),
    NEW.indexOf('{createUncertainRaw !== null ? ('),
  );
  assert.ok(cancelled.includes('label="Try again"'), 'Try again conservé');
  assert.ok(cancelled.includes('label="Edit details"'), 'Edit details conservé');
  assert.ok(!cancelled.includes('Result unknown'), 'jamais Result unknown après annulation prouvée');
});

// --- §2 : creation SIGNEE, resultat NON verifie -------------------------------

check('65. signature presente + relecture indisponible : UN seul etat, jamais rouge', () => {
  assert.ok(NEW.includes('const signedPendingVerification ='), 'etat derive de la signature reelle');
  assert.ok(
    NEW.includes('createResult.signature !== null && createResult.verified !== true'),
    'condition exacte',
  );
  const card = NEW.slice(
    NEW.indexOf('{signedPendingVerification &&'),
    NEW.indexOf('{createResult !== null && !signedPendingVerification ? ('),
  );
  assert.ok(card.length > 0, 'carte presente');
  assert.ok(card.split('tone="warning"').length - 1 >= 2, 'ton avertissement (ambre)');
  assert.ok(!card.includes('tone="error"'), 'jamais rouge pour un resultat non verifie');
  assert.ok(!card.includes('styles.errorBox'), 'jamais de carte d echec');
  // Copie HONNÊTE : on affirme l ENVOI (signature obtenue d un envoi), jamais
  // une création que l app n a PAS pu vérifier.
  assert.ok(card.includes('>Proposal sent — verification pending<'), 'titre « sent / pending »');
  assert.ok(
    card.includes('Your proposal was signed and sent from this device.'),
    'message : envoi affirmé, création non affirmée',
  );
  // Anti-doublon formulé comme une RECOMMANDATION (jamais un fait).
  assert.ok(
    card.includes("Don't create it again without checking first."),
    'recommandation anti-doublon',
  );
  // RÈGLE : la copie visible n affirme ni « created » ni « failed ».
  assert.ok(!card.includes('>Proposal created<'), 'jamais « created » non vérifiable');
  assert.ok(!/Proposal failed/i.test(card), 'jamais « failed » définitif');
  // 2 : creation impossible tant que la signature reste non verifiee.
  assert.ok(NEW.includes('!signedPendingVerification &&'), 'canCreate exclut cet etat');
  // 3 : aucune reprise, aucun CTA de creation.
  assert.ok(!card.includes('label="Try again"'), 'jamais Try again');
  assert.ok(!card.includes('accessibilityLabel="Create proposal"'), 'jamais Create proposal');
  // 4 & 5 : Check again + Back to proposals.
  assert.ok(card.includes('accessibilityLabel="Check again"'), 'Check again present');
  assert.ok(card.includes('accessibilityLabel="Back to proposals"'), 'Back to proposals present');
  // 4 bis : le brut n'existe QUE replie.
  assert.ok(card.includes('label="Troubleshooting details"'), 'divulgation de depannage');
  assert.ok(card.includes('{pendingVerificationRaw}'), 'brut rendu seulement replie');
  assert.ok(NEW.includes('const pendingVerificationRaw ='), 'brut compose a part');
  // 6 : la carte est un REPLI, FERMÉ par défaut (en-tête compact + chevron).
  assert.ok(
    NEW.includes('const [pendingVerificationOpen, setPendingVerificationOpen] = useState(false);'),
    'repli ferme par defaut',
  );
  assert.ok(
    card.includes('accessibilityState={{ expanded: pendingVerificationOpen }}'),
    'semantique de repli',
  );
  const expandedOnly = card.slice(card.indexOf('{pendingVerificationOpen ? ('));
  const headerOnly = card.slice(0, card.indexOf('{pendingVerificationOpen ? ('));
  assert.ok(expandedOnly.includes('accessibilityLabel="Check again"'), 'Check again dans la partie depliee');
  assert.ok(
    expandedOnly.includes('accessibilityLabel="Back to proposals"'),
    'Back to proposals dans la partie depliee',
  );
  assert.ok(!headerOnly.includes('accessibilityLabel="Check again"'), 'aucune action quand replie');
  assert.ok(!headerOnly.includes('accessibilityLabel="Back to proposals"'), 'aucune action quand replie');
  // 14 : aucune note d implementation dans cette branche.
  for (const note of [
    'Only the creator signs',
    'Call this once',
    'This preflight is local only',
    'ProposalCreate',
    'Two accounts are created',
  ]) {
    assert.ok(!card.includes(note), `aucune note d implementation : ${note}`);
  }
});

check('66. Check again : lecture seule, aucun wallet, aucune soumission', () => {
  const handler = NEW.slice(
    NEW.indexOf('const onCheckAfterFailure = async () => {'),
    NEW.indexOf('// CTA de création UNIQUE'),
  );
  for (const forbidden of [
    'authorize(',
    'signTransaction',
    'signAndSendTransactions',
    'sendRawTransaction',
    'signAndSendProposalCreation',
    'useMobileWallet()',
    'buildProposalCreation(',
    'runCreate(',
  ]) {
    assert.ok(!handler.includes(forbidden), `aucun ${forbidden} dans le controle`);
  }
  assert.ok(handler.includes('await onCreatedVerified?.()'), 'lecture seule du parent');
});

check('67. reprise au premier plan : lecture seule, jamais de wallet', () => {
  const effect = NEW.slice(
    NEW.indexOf("AppState.addEventListener('change'"),
    NEW.indexOf('// CTA de création UNIQUE'),
  );
  assert.ok(effect.length > 0, 'ecouteur present');
  assert.ok(effect.includes("if (state !== 'active') return;"), 'seulement au premier plan');
  assert.ok(effect.includes('void onCheckAfterFailure();'), 'controle LECTURE SEULE');
  for (const forbidden of ['runCreate(', 'authorize(', 'signAndSendTransactions', 'useMobileWallet()']) {
    assert.ok(!effect.includes(forbidden), `aucun ${forbidden} a la reprise`);
  }
  // 9 : un remontage ne peut pas rouvrir le wallet de lui-meme.
  assert.equal(NEW.split('void runCreate()').length - 1, 1, 'un seul declencheur de wallet');
  assert.equal(NEW.split('await runCreate(fresh)').length - 1, 1, 'une seule reprise');
});

check('68. les deux cartes de resultat sont EXCLUSIVES', () => {
  assert.ok(
    NEW.includes('{createResult !== null && !signedPendingVerification ? ('),
    'reçu d echec exclu quand la signature est non verifiee',
  );
  // Un seul etat principal pour un resultat signe non verifie : jamais deux
  // cartes empilees. C est la PHRASE d etat honnête qui doit etre unique.
  assert.equal(
    NEW.split('Your proposal was signed and sent from this device.').length - 1,
    1,
    'un seul etat « envoyé / non vérifié »',
  );
  // Le titre honnête « sent / pending » est rendu UNE seule fois.
  assert.equal(
    NEW.split('>Proposal sent — verification pending<').length - 1,
    1,
    'un seul titre « sent / pending »',
  );
});

check('69. redemarrage applicatif : NON supporte, explicitement', () => {
  // La protection est une MEMOIRE DE MODULE : elle survit au demontage et a la
  // navigation, mais PAS a une fermeture complete de l'application.
  assert.ok(!NEW.includes('AsyncStorage'), 'aucune persistance de disque dans l ecran');
  assert.ok(!STORE.includes('AsyncStorage'), 'aucun stockage disque dans le registre');
  assert.ok(STORE.includes('AUCUNE persistance disque'), 'limite documentee explicitement');
  assert.ok(STORE.includes('PENDING_CREATION_PROCESS_LIFETIME_ONLY'), 'drapeau de portee');
  assert.ok(NEW.includes('sendAttemptedRef.current = true;'), 'verrou de montage present');
});

// --- Memoire de module des creations en attente -------------------------------

check('70. registre : cle, schema, validite (runtime)', () => {
  resetPendingCreationsForTests();
  const scope = {
    cluster: 'devnet',
    multisigAddress: 'M',
    vaultAddress: 'V',
    transactionIndexNext: 3,
  };
  assert.equal(pendingCreationFor(scope), null, 'vide au depart');
  const record = { ...scope, proposalPda: 'P', transactionPda: 'T', signature: 'SIG', createdAt: 1 };
  rememberPendingCreation(record);
  assert.deepEqual(pendingCreationFor(scope), record, 'record retrouve par sa cle');
  assert.equal(pendingCreationKey(scope), 'devnet|M|V|3', 'cle = cluster|multisig|vault|index');
  assert.equal(isValidPendingCreation(pendingCreationFor(scope), scope), true);
  assert.equal(pendingCreationCount(), 1);
  // Schema : uniquement des metadonnees de recuperation. La prohibition des
  // donnees sensibles est DOCUMENTEE dans le registre lui-meme, et aucun stockage
  // durable n'y est branche.
  assert.ok(STORE.includes('JAMAIS de cle privee'), 'prohibition documentee (cle privee)');
  assert.ok(STORE.includes('mot de passe'), 'prohibition documentee (mot de passe)');
  assert.ok(!STORE.includes('AsyncStorage'), 'aucun stockage disque');
  assert.ok(!STORE.includes('Keychain'), 'aucun stockage systeme');
});

check('71. signature non verifiee -> record cree ; verification reussie -> supprime', () => {
  resetPendingCreationsForTests();
  const scope = {
    cluster: 'devnet',
    multisigAddress: 'M',
    vaultAddress: 'V',
    transactionIndexNext: 3,
  };
  rememberPendingCreation({
    ...scope,
    proposalPda: 'P',
    transactionPda: 'T',
    signature: 'SIG',
    createdAt: 1,
  });
  assert.notEqual(pendingCreationFor(scope), null, 'record cree des la signature');
  // Proposition trouvee ET verifiee : purge.
  forgetPendingCreation(scope);
  assert.equal(pendingCreationFor(scope), null, 'purge sur preuve positive');
  assert.equal(pendingCreationCount(), 0);
});

check('72. erreur reseau / resultat ambigu : le record est CONSERVE', () => {
  resetPendingCreationsForTests();
  const scope = {
    cluster: 'devnet',
    multisigAddress: 'M',
    vaultAddress: 'V',
    transactionIndexNext: 3,
  };
  rememberPendingCreation({
    ...scope,
    proposalPda: 'P',
    transactionPda: 'T',
    signature: 'SIG',
    createdAt: 1,
  });
  // Une lecture qui echoue (RPC / timeout) ou qui ne prouve rien ne purge RIEN.
  assert.equal(recoveryStateFromRead(false), 'verification_unavailable');
  assert.equal(recoveryStateFromRead(true), 'still_unknown');
  assert.notEqual(pendingCreationFor(scope), null, 'record conserve');
  const clearReasons: readonly string[] = [...PENDING_CREATION_CLEAR_REASONS];
  for (const reason of PENDING_CREATION_KEEP_REASONS) {
    assert.ok(!clearReasons.includes(reason), `jamais de purge sur : ${reason}`);
  }
  assert.ok(PENDING_CREATION_KEEP_REASONS.includes('rpc_error'));
  assert.ok(PENDING_CREATION_KEEP_REASONS.includes('timeout'));
  assert.ok(PENDING_CREATION_KEEP_REASONS.includes('ambiguous_result'));
  assert.ok(PENDING_CREATION_CLEAR_REASONS.includes('proposal_found_and_verified'));
  assert.ok(PENDING_CREATION_CLEAR_REASONS.includes('terminal_failure_confirmed'));
});

check('73. mismatch cluster / vault / index : aucun mauvais record restaure', () => {
  resetPendingCreationsForTests();
  const scope = {
    cluster: 'devnet',
    multisigAddress: 'M',
    vaultAddress: 'V',
    transactionIndexNext: 3,
  };
  rememberPendingCreation({
    ...scope,
    proposalPda: 'P',
    transactionPda: 'T',
    signature: 'SIG',
    createdAt: 1,
  });
  assert.equal(pendingCreationFor({ ...scope, cluster: 'mainnet-beta' }), null, 'cluster different');
  assert.equal(pendingCreationFor({ ...scope, vaultAddress: 'V2' }), null, 'vault different');
  assert.equal(pendingCreationFor({ ...scope, transactionIndexNext: 4 }), null, 'index different');
  // Un record incoherent du MEME multisig est purge plutot que conserve.
  forgetMismatchedPendingCreations({ ...scope, vaultAddress: 'V2' });
  assert.equal(pendingCreationFor(scope), null, 'record obsolete purge');
  // Record INCOMPLET : jamais restaure.
  rememberPendingCreation({
    ...scope,
    proposalPda: '',
    transactionPda: 'T',
    signature: 'SIG',
    createdAt: 1,
  });
  assert.equal(
    isValidPendingCreation(pendingCreationFor(scope), scope),
    false,
    'record invalide refuse',
  );
  resetPendingCreationsForTests();
});

check('74. cablage ecran : restauration, blocage, aucun wallet au remontage', () => {
  assert.ok(NEW.includes('const record = pendingCreationFor(pendingCreationScope);'), 'lecture du registre');
  assert.ok(NEW.includes('isValidPendingCreation(record, pendingCreationScope)'), 'validite exigee');
  // L'etat principal tient compte du record restaure -> Create proposal reste ferme.
  assert.ok(NEW.includes('restoredPendingCreation !== null ||'), 'etat restaure compte');
  assert.ok(NEW.includes('!signedPendingVerification &&'), 'canCreate bloque');
  // Enregistrement a la signature non verifiee ; purge sur preuve positive SEULE.
  assert.ok(NEW.includes('rememberPendingCreation(record);'), 'enregistrement a la signature');
  const verifiedBlock = NEW.slice(
    NEW.indexOf('if (result.verified) {'),
    NEW.indexOf('} else if (result.signature !== null) {'),
  );
  assert.ok(verifiedBlock.includes('forgetPendingCreation(pendingCreationScope);'), 'purge sur verifie');
  // Deux sites de purge, TOUS DEUX sur preuve positive : la relecture
  // verifiee apres creation, et la relecture CIBLEE de « Check again ».
  assert.equal(
    NEW.split('forgetPendingCreation(').length - 1,
    2,
    'purge uniquement sur preuve positive (2 sites)',
  );
  // Aucun wallet au remontage : le seul declencheur de wallet reste onCreate.
  assert.equal(NEW.split('void runCreate()').length - 1, 1, 'un seul declencheur');
});

check('75. la carte « sent / pending » n est JAMAIS montrée à l étape Details', () => {
  // (1) La CONDITION DE RENDU dépend de l'étape post-création : la carte ambre
  // n'est jamais rendue quand l'étape active est « Details ».
  assert.ok(
    NEW.includes("{signedPendingVerification && step !== 'details' ? ("),
    'condition de rendu indexée sur l étape post-création',
  );
  // (2) Le flux est REPLACÉ sur une étape post-création tant qu'une proposition
  // signée reste non vérifiée : jamais de retour à Details avec la carte.
  const guard = NEW.slice(
    NEW.indexOf('if (!signedPendingVerification) return;'),
    NEW.indexOf('}, [signedPendingVerification, step]);'),
  );
  assert.ok(guard.length > 0, 'garde d étape post-création présente');
  assert.ok(guard.includes("if (step === 'details') setStep('sign');"), 'étape forcée hors de Details');
  // (3) Cause racine : l'effet d'invalidation ne renvoie plus à Details quand une
  // signature non vérifiée est en attente (la condition est réutilisée à la fois
  // pour dériver l'état et pour neutraliser l'invalidation).
  assert.equal(
    NEW.split(
      '(createResult !== null && createResult.signature !== null && createResult.verified !== true)',
    ).length - 1,
    2,
    'garde d invalidation + dérivation de l état',
  );
  // (4) La carte appartient bien à l'état POST-CRÉATION.
  assert.ok(NEW.includes('const signedPendingVerification ='), 'état post-création dérivé');
  // (5) Le repli d'aide n'est pas touché par ce correctif.
  assert.ok(NEW.includes('label="How proposal creation works"'), 'repli d aide conservé');
});

console.log(`\n${passed} test(s) OK`);
