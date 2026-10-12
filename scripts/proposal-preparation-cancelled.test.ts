import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * « Preparation was cancelled » : le panneau d'echec d'APPROBATION cesse d'etre
 * un pave technique rouge. Il devient un message humain court, en ton
 * AVERTISSEMENT (ambre), et le detail brut reste accessible dans le repli
 * « Troubleshooting details ». Aucun wallet, aucun reseau.
 * npx tsx scripts/proposal-preparation-cancelled.test.ts
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

const DETAILS = readFileSync('src/screens/ProposalDetailsScreen.tsx', 'utf8');

/** Panneau d'erreur d'approbation : de sa condition au recu juste en dessous. */
const APPROVAL_ERROR_PANEL = DETAILS.slice(
  DETAILS.indexOf("approvalError !== null &&\n        actionState !== 'executed' &&"),
  DETAILS.indexOf("{approvalResult !== null && actionState !== 'executed' &&"),
);

/** Helper d'affichage d'un echec d'approbation, isolé du reste du fichier. */
const APPROVAL_FAILURE_HELPER = DETAILS.slice(
  DETAILS.indexOf('function describeApprovalFailure'),
  DETAILS.indexOf('Copie HUMAINE'),
);

check('1. copie humaine courte figee (titre + corps)', () => {
  assert.ok(
    DETAILS.includes("const PREPARATION_CANCELLED_TITLE = 'Preparation was cancelled';"),
    'titre humain',
  );
  assert.ok(
    DETAILS.includes(
      "const PREPARATION_CANCELLED_BODY = 'Nothing was signed and nothing was sent.';",
    ),
    'corps humain',
  );
});

check('2. le panneau principal rend la copie humaine, jamais le pave technique', () => {
  assert.ok(APPROVAL_ERROR_PANEL.length > 0, 'panneau present');
  assert.ok(APPROVAL_ERROR_PANEL.includes('{approvalError}'), 'le panneau rend approvalError');
  // Le pave technique (titre machine + formatMwaError) n'est jamais concatene ici.
  assert.ok(!APPROVAL_ERROR_PANEL.includes('formatMwaError'), 'aucun formatMwaError');
  assert.ok(
    !APPROVAL_ERROR_PANEL.includes('signAndSendTransactions failed'),
    'aucun code technique en clair',
  );
});

check('3. ton AVERTISSEMENT (ambre), jamais le ton ERREUR (rouge)', () => {
  assert.ok(APPROVAL_ERROR_PANEL.includes('tone="warning"'), 'panneau ambre');
  assert.ok(!APPROVAL_ERROR_PANEL.includes('tone="error"'), 'jamais rouge');
  assert.ok(!APPROVAL_ERROR_PANEL.includes('styles.errorBox'), 'jamais une carte rouge');
});

check('4. annulation : message humain, detail brut reserve au diagnostic', () => {
  assert.ok(DETAILS.includes('describeApprovalFailure(result)'), 'helper branche');
  assert.ok(DETAILS.includes('setApprovalError(failure.message);'), 'copie humaine affichee');
  assert.ok(
    DETAILS.includes('setApprovalDiagnostics((previous) => [...previous, failure.diagnostic]);'),
    'detail brut conserve pour le debug',
  );
  assert.ok(APPROVAL_FAILURE_HELPER.length > 0, 'helper present');
  assert.ok(APPROVAL_FAILURE_HELPER.includes('if (result.signature === null)'), 'sans signature');
  assert.ok(APPROVAL_FAILURE_HELPER.includes('PREPARATION_CANCELLED_TITLE'), 'titre humain');
  assert.ok(APPROVAL_FAILURE_HELPER.includes('PREPARATION_CANCELLED_BODY'), 'corps humain');
  assert.ok(/return \{ diagnostic, message: diagnostic \};/.test(APPROVAL_FAILURE_HELPER), 'signe : inchange');
});

check('5. redondance : le recu n est rendu que pour une soumission SIGNE', () => {
  // Sans signature, le panneau ambre porte deja le message unique : le recu
  // rouge « Nothing was sent. » ne s'affiche plus en doublon.
  assert.ok(
    DETAILS.includes('approvalResult.signature === null ? null : ('),
    'recu garde par la signature',
  );
});

check('6. detail technique toujours accessible dans « Troubleshooting details »', () => {
  assert.ok(DETAILS.includes('Troubleshooting details'), 'repli present');
  assert.ok(
    DETAILS.includes('{approvalDiagnostics.map((message, position) => ('),
    'diagnostics rendus dans le repli',
  );
});

check('7. aucune couleur codee en dur dans le panneau', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(APPROVAL_ERROR_PANEL), 'tokens du theme uniquement');
});

console.log(`\n${passed} test(s) OK`);