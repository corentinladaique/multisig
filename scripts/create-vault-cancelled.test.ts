import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeMwaError, formatMwaError } from '../src/wallet/mwaDiagnostics';

/**
 * « Creation was cancelled » : le panneau d'echec AVANT signature de la creation
 * de vault cesse d'etre un pave technique rouge. Il devient un message humain
 * court, en ton AVERTISSEMENT (ambre), et le detail brut part — DEDOUBLONNE —
 * dans le repli « Troubleshooting details ». Aucun wallet, aucun reseau.
 * npx tsx scripts/create-vault-cancelled.test.ts
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

const CREATE = readFileSync('src/screens/CreateVaultScreen.tsx', 'utf8');

/** Panneau d'echec avant signature : de sa condition a l'etat signe suivant. */
const PANEL = CREATE.slice(
  CREATE.indexOf('{nothingWasSent ? ('),
  CREATE.indexOf("vaultVisibleState === 'signed-pending-confirmation' ? ("),
);

/** Derivation du detail technique dedoublonne, isolee du reste du fichier. */
const DERIVATION = CREATE.slice(
  CREATE.indexOf('const rawWalletError = (() => {'),
  CREATE.indexOf('const hasDiagnostics ='),
);

check('1. copie humaine courte figee (titre + corps)', () => {
  assert.ok(
    CREATE.includes("const CREATION_CANCELLED_TITLE = 'Creation was cancelled';"),
    'titre humain',
  );
  assert.ok(
    CREATE.includes(
      "const CREATION_CANCELLED_BODY =\n  'Nothing was signed and nothing was sent. Your vault was not created.';",
    ),
    'corps humain',
  );
});

check('2. le panneau rend la copie humaine, jamais le pave technique', () => {
  assert.ok(PANEL.length > 0, 'panneau present');
  assert.ok(PANEL.includes('{CREATION_CANCELLED_TITLE}'), 'titre rendu');
  assert.ok(PANEL.includes('{CREATION_CANCELLED_BODY}'), 'corps rendu');
  // Le pave technique (createError / formatMwaError / titre machine) n'est plus
  // concatene ici.
  assert.ok(!PANEL.includes('createError'), 'aucune erreur brute dans le panneau');
  assert.ok(!PANEL.includes('formatMwaError'), 'aucun formatMwaError dans le panneau');
  assert.ok(!PANEL.includes('operationReport.title'), 'aucun titre machine dans le panneau');
  assert.ok(!PANEL.includes('Nothing was sent.'), 'plus de pave « Nothing was sent. »');
});

check('3. ton AVERTISSEMENT (ambre), jamais le ton ERREUR (rouge)', () => {
  assert.ok(PANEL.includes('tone="warning"'), 'panneau ambre');
  assert.ok(!PANEL.includes('tone="error"'), 'jamais rouge');
  assert.ok(!PANEL.includes('styles.errorBox'), 'jamais une carte rouge');
});

check('4. detail technique dedoublonne dans « Troubleshooting details »', () => {
  assert.ok(CREATE.includes('Troubleshooting details'), 'repli present');
  assert.ok(DERIVATION.includes("technicalErrors.push('Step: Preparation')"), 'etape lisible');
  assert.ok(DERIVATION.includes('`Wallet error: ${rawWalletError'), 'ligne wallet unique');
  // La branche d'annulation est conditionnee et n'ajoute QUE ces deux lignes.
  assert.ok(
    DERIVATION.includes('if (nothingWasSent && rawWalletError !== null)'),
    'branche dediee',
  );
  // Dedoublonnage : on retient le plus complet du code et du message, jamais les deux.
  assert.ok(DERIVATION.includes('code.includes(message)'), 'regle de non-duplication');
  // Le rendu brut MWA est ecarte quand le detail dedoublonne le remplace.
  assert.ok(
    CREATE.includes('mwaReport !== null && !nothingWasSent'),
    'brut MWA reserve hors annulation dedoublonne',
  );
});

check('5. la phrase « Local association cancelled by user » n apparait qu UNE fois', () => {
  // Erreur reelle du wallet Android : le CODE porte la description complete et le
  // MESSAGE en est le suffixe (d'ou la repetition historique dans formatMwaError).
  const phrase = 'Local association cancelled by user';
  const walletError = Object.assign(
    new Error(phrase),
    { code: 'Session not established: Local association cancelled by user' },
  );
  const mwa = describeMwaError(walletError, 'signAndSendTransactions');
  assert.equal(mwa.code, 'Session not established: Local association cancelled by user');
  assert.equal(mwa.message, phrase);
  // Ancien pave : la phrase apparaissait DEUX fois (code + message concatenes).
  const legacy = formatMwaError({
    step: 'signAndSendTransactions',
    code: mwa.code,
    message: mwa.message,
  });
  assert.equal((legacy.match(new RegExp(phrase, 'g')) ?? []).length, 2, 'regression documentee');
  // Regle de l'ecran : le plus complet des deux, donc UNE seule mention.
  const deduped = mwa.code.includes(mwa.message) ? mwa.code : mwa.message;
  assert.equal((deduped.match(new RegExp(phrase, 'g')) ?? []).length, 1, 'phrase unique');
  // Le separateur « : » devient « — » pour la ligne affichee (forme validee).
  assert.equal(
    deduped.replace(/:\s+/, ' — '),
    'Session not established — Local association cancelled by user',
  );
});

check('6. aucune couleur codee en dur dans le panneau', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(PANEL), 'tokens du theme uniquement');
});

console.log(`\n${passed} test(s) OK`);
