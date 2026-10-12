import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isAddMultisigVisible, nextAddMultisigOpen } from '../src/ui/v2/addMultisigToggle';

/**
 * Tests FOCALISES de « Add existing multisig » comme VRAI interrupteur :
 * un second tap (ou tout tap EXPLICITE de l'utilisateur) REPLIE le bloc
 * « Multisig address », y compris quand il n'était visible que grâce au
 * chemin de choix — SANS régresser la PREMIÈRE révélation automatique.
 *
 * Deux parties :
 *  - un PROUVEUR pur exécutable (import du decision-module réel) : la table de
 *    vérité de la bascule et de la visibilité du bloc ;
 *  - des assertions de SOURCE : câblage du handler, garde de rendu inchangée,
 *    non-régression de la branche « vault chargé » (option A).
 *
 * Tests PURS : aucun rendu, aucun RPC, aucun wallet, aucune transaction.
 * Exécution : npx tsx scripts/vault-address-toggle.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

const GATE = '{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}';

let passed = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (caught: unknown) {
    console.error(`FAIL ${name}`);
    console.error(`  ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  }
}

// --- PROUVEUR pur : la bascule replie, y compris après le chemin de choix -----

check('1. bascule normale : 1er tap ouvre, 2e tap referme', () => {
  const opened = nextAddMultisigOpen(false, false);
  assert.equal(opened, true, '1er tap (choix fermé) ouvre le bloc');
  assert.equal(isAddMultisigVisible(opened, false), true, 'bloc visible après ouverture');
  const closed = nextAddMultisigOpen(opened, false);
  assert.equal(closed, false, '2e tap referme le bloc');
  assert.equal(isAddMultisigVisible(closed, false), false, 'bloc replié au 2e tap');
});

check('2. chemin de choix : le tap EXPLICITE replie le bloc (plus jamais bloqué ouvert)', () => {
  // État de départ : l'utilisateur est passé par le sélecteur -> le bloc est
  // visible par le chemin de choix, SANS tap explicite.
  let addMultisigOpen = false;
  let choosingVault = true;
  assert.equal(
    isAddMultisigVisible(addMultisigOpen, choosingVault),
    true,
    'première révélation : le chemin de choix montre bien le bloc',
  );

  // Tap de l'utilisateur sur « Add existing multisig » : le handler referme
  // AUSSI le drapeau de choix (un tap explicite gagne toujours).
  addMultisigOpen = nextAddMultisigOpen(addMultisigOpen, choosingVault);
  choosingVault = false;
  assert.equal(addMultisigOpen, false, 'le tap referme le bloc au lieu de le maintenir');
  assert.equal(
    isAddMultisigVisible(addMultisigOpen, choosingVault),
    false,
    'bloc EFFECTIVEMENT replié après le tap, malgré le passage par le choix',
  );

  // Et un nouveau tap rouvre normalement (interrupteur complet).
  addMultisigOpen = nextAddMultisigOpen(addMultisigOpen, choosingVault);
  assert.equal(isAddMultisigVisible(addMultisigOpen, choosingVault), true, 're-tap rouvre');
});

check('3. cas limite : choix ET tap explicite déjà vrai -> replié', () => {
  assert.equal(nextAddMultisigOpen(true, true), false, 'choix actif + ouvert -> tap replie');
});

// --- Câblage RÉEL dans ConnectScreen -----------------------------------------

check('4. le composant importe et utilise le décideur pur', () => {
  assert.ok(
    CONNECT.includes("import { nextAddMultisigOpen } from '../ui/v2/addMultisigToggle';"),
    'import du décideur pur',
  );
  assert.ok(
    CONNECT.includes('setAddMultisigOpen((previous) => nextAddMultisigOpen(previous, choosingVault))'),
    'la bascule explicite passe par le décideur',
  );
});

check('5. le handler explicite referme AUSSI le chemin de choix', () => {
  const at = CONNECT.indexOf('const onToggleAddMultisig = useCallback(');
  assert.ok(at !== -1, 'handler « onToggleAddMultisig » présent');
  const body = CONNECT.slice(at, CONNECT.indexOf('}, [choosingVault]);', at));
  assert.ok(body.includes('setChoosingVault(false)'), 'le tap explicite referme choosingVault');
});

check('6. les DEUX cartes d’état vide (no-saved, no-active) basculent par ce handler', () => {
  const noSavedStart = CONNECT.indexOf("vaultBodyState === 'no-saved' ? (");
  const noSavedEnd = CONNECT.indexOf("vaultBodyState === 'no-active' ? (", noSavedStart);
  assert.ok(noSavedStart !== -1 && noSavedEnd > noSavedStart, 'branches no-saved/no-active bornées');
  const noSaved = CONNECT.slice(noSavedStart, noSavedEnd);
  assert.ok(noSaved.includes('onPress={onToggleAddMultisig}'), 'no-saved bascule par le handler');

  const noActiveEnd = CONNECT.indexOf("vaultBodyState === 'load-failed' ? (", noSavedEnd);
  assert.ok(noActiveEnd > noSavedEnd, 'branche no-active bornée');
  const noActive = CONNECT.slice(noSavedEnd, noActiveEnd);
  assert.ok(noActive.includes('onPress={onToggleAddMultisig}'), 'no-active bascule par le handler');
});

check('7. plus aucune bascule aveugle dans les cartes d’état vide', () => {
  const noSavedStart = CONNECT.indexOf("vaultBodyState === 'no-saved' ? (");
  const noActiveEnd = CONNECT.indexOf("vaultBodyState === 'load-failed' ? (", noSavedStart);
  const emptyStates = CONNECT.slice(noSavedStart, noActiveEnd);
  assert.ok(
    !emptyStates.includes('setAddMultisigOpen((previous) => !previous)'),
    'la bascule qui ignorait choosingVault a disparu des cartes d’état vide',
  );
});

// --- Non-régression ----------------------------------------------------------

check('8. première révélation automatique INCHANGÉE (chemin de choix)', () => {
  // « Switch multisig » / l'en-tête arment choosingVault vrai, et la garde de
  // rendu inclut toujours choosingVault : le bloc apparaît sans aucun tap.
  assert.ok(CONNECT.includes('setChoosingVault(true)'), 'le chemin de choix arme choosingVault');
  assert.ok(CONNECT.includes(GATE), 'la garde de rendu du bloc reste `addMultisigOpen || choosingVault`');
  assert.ok(
    /const openVaultPicker = useCallback\(\(\) => \{\s*setChoosingVault\(true\);\s*setVaultPickerOpen\(true\);/.test(
      CONNECT,
    ),
    'openVaultPicker arme le choix puis ouvre le sélecteur',
  );
});

check('9. branche « vault chargé » (option A) STRICTEMENT inchangée', () => {
  const at = CONNECT.indexOf('label="Switch multisig"');
  const manage = CONNECT.slice(at, CONNECT.indexOf('{addMultisigOpen ? multisigLoaderBlock : null}', at));
  assert.ok(manage.includes('label="Add existing multisig"'), 'bouton de gestion présent');
  assert.ok(
    manage.includes('onPress={() => setAddMultisigOpen((previous) => !previous)}'),
    'option A garde sa bascule simple',
  );
  assert.ok(!manage.includes('onToggleAddMultisig'), 'option A n’utilise pas le nouveau handler');
  assert.ok(
    /addMultisigOpen \? multisigLoaderBlock : null\}\s*\{multisigDisconnectBlock\}/.test(CONNECT),
    '« Disconnect this vault » reste hors du repli',
  );
});

// --- Enregistrement ----------------------------------------------------------

check('10. la suite est enregistrée dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/vault-address-toggle.test.ts'),
    'suite de l’interrupteur dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
