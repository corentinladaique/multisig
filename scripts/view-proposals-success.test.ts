import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES du defaut remonte sur appareil : sur l'ecran de succes de
 * creation de vault, le lien « View proposals » ouvrait par erreur la feuille
 * « My multisigs » (onGoToInbox -> setInboxOpen(true)) au lieu de l'onglet
 * Proposals du vault qui venait d'etre cree.
 *
 * Correction : le lien appelle desormais `onViewProposals`, dont le handler
 * (ConnectScreen) ferme la creation, charge le vault cree comme vault ACTIF
 * (`loadVault`, le meme chemin que le selecteur de vault) puis bascule sur
 * l'onglet Proposals (`setTab('proposals')`). Le retour systeme apres succes
 * continue d'aller vers l'inbox (`onGoToInbox`, inchange).
 *
 * Tests PURS : lecture des sources. Aucun RPC, aucun wallet, aucune transaction.
 * Execution : npx tsx scripts/view-proposals-success.test.ts
 */

const CREATE = readFileSync('src/screens/CreateVaultScreen.tsx', 'utf8');
const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

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

// Bloc des actions de succes (Open vault + View proposals), borne par le recu.
const successActionsStart = CREATE.indexOf('styles.successActions');
const SUCCESS_ACTIONS = CREATE.slice(
  successActionsStart,
  CREATE.indexOf('Technical receipt', successActionsStart),
);

// Handler `onViewProposals` fourni par ConnectScreen (le lien de succes).
const VIEW_START = CONNECT.indexOf('onViewProposals={(vault) => {');
const VIEW_HANDLER = CONNECT.slice(VIEW_START, CONNECT.indexOf('}}', VIEW_START));

// Handler `onGoToInbox` fourni par ConnectScreen (retour systeme apres succes).
const INBOX_START = CONNECT.indexOf('onGoToInbox={() => {');
const INBOX_HANDLER = CONNECT.slice(INBOX_START, CONNECT.indexOf('}}', INBOX_START));

check('1. le lien « View proposals » est cable sur onViewProposals (plus onGoToInbox)', () => {
  assert.ok(SUCCESS_ACTIONS.includes('View proposals'), 'le lien existe toujours');
  assert.ok(
    SUCCESS_ACTIONS.includes('onViewProposals({ address, vaultName })'),
    'le lien transmet le vault cree (adresse relue + nom local)',
  );
  assert.ok(
    !SUCCESS_ACTIONS.includes('onPress={onGoToInbox}'),
    'le lien n appelle plus le chemin Inbox',
  );
});

check('2. le handler onViewProposals ferme la creation, active le vault cree, ouvre Proposals', () => {
  assert.ok(VIEW_START > -1, 'handler onViewProposals present dans ConnectScreen');
  assert.ok(
    VIEW_HANDLER.includes('setVaultCreationOpen(false)'),
    'l ecran de creation est ferme (sortie de l assistant)',
  );
  assert.ok(
    VIEW_HANDLER.includes('loadVault(vault.address)'),
    'le vault cree devient le vault ACTIF (meme chemin que le selecteur : loadVault)',
  );
  assert.ok(
    VIEW_HANDLER.includes("setTab('proposals')"),
    'l onglet Proposals est active',
  );
});

check('3. le handler onViewProposals n ouvre PLUS la feuille « My multisigs »', () => {
  assert.ok(
    !VIEW_HANDLER.includes('setInboxOpen(true)'),
    'aucune ouverture de l inbox depuis « View proposals »',
  );
  // Un seul setInboxOpen(true) dans tout l ecran, et il appartient au chemin
  // de retour systeme (onGoToInbox) — jamais au lien de succes.
  assert.equal(
    CONNECT.split('setInboxOpen(true)').length - 1,
    1,
    'un unique setInboxOpen(true)',
  );
  assert.ok(
    INBOX_HANDLER.includes('setInboxOpen(true)'),
    'le retour systeme apres succes va toujours vers l inbox (inchange)',
  );
});

check('4. le retour systeme (_onGoToInbox_) reste le seul chemin vers l inbox', () => {
  assert.ok(
    CREATE.includes(
      'onViewProposals: (vault: { address: string; vaultName: string }) => void;',
    ),
    'la nouvelle prop est declaree avec le vault cree',
  );
  assert.ok(
    CREATE.includes('onGoToInbox: () => void;'),
    'onGoToInbox reste declaree (retour systeme)',
  );
  // Le retour systeme (hardware back) apres succes utilise toujours onGoToInbox.
  const BACK_HANDLER = CREATE.slice(
    CREATE.indexOf("BackHandler.addEventListener('hardwareBackPress'"),
    CREATE.indexOf('}, [createdAndVerified'),
  );
  assert.ok(BACK_HANDLER.includes('onGoToInbox()'), 'retour Android -> inbox conserve');
});

check('5. la suite est enregistree dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/view-proposals-success.test.ts'),
    'suite dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
