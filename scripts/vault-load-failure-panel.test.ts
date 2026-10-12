import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADDRESS_FIELD_HINT } from '../src/ui/addressPaste';
import { describeVaultLoadError } from '../src/ui/vaultLoadMessage';

/**
 * Etat d'ECHEC de chargement du vault (ConnectScreen) — tests PURS, par lecture
 * des sources (le projet n'a pas de renderer) + un test pur du classifieur.
 *
 * Exigences verifiees :
 *  - plus AUCUN texte technique brut (`{msig.error}`, exception, hote RPC, base58) ;
 *  - UN SEUL bouton « Retry » dans cet etat (plus de triple redondance) ;
 *  - message court et humain au TITRE GENERIQUE en toutes circonstances
 *    (« Could not load this multisig » + « Check your connection and try
 *    again. ») : on ne pretend plus distinguer une absence de reseau d'une
 *    autre panne, aucune cause inventee ;
 *  - panneau AMBRE (ton `warning`), jamais le rouge `error` ;
 *  - « Choose another multisig » et le bloc « Multisig address » (+ Paste/Load +
 *    note de securite) CONSERVES.
 *
 * Execution : npx tsx scripts/vault-load-failure-panel.test.ts
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
    console.log(
      detail
        .split('\n')
        .filter((line) => !line.includes('node:internal'))
        .slice(0, 4)
        .join('\n'),
    );
    process.exitCode = 1;
  }
}

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');

// Bloc JSX de l'etat « load-failed » (carte d'etat vide).
const LOAD_FAILED_START = CONNECT.indexOf("vaultBodyState === 'load-failed'");
const LOAD_FAILED_END = CONNECT.indexOf(
  "vaultBodyState === 'loading-registry' || vaultBodyState === 'loading-vault' ? (",
  LOAD_FAILED_START,
);
const LOAD_FAILED_BLOCK = CONNECT.slice(LOAD_FAILED_START, LOAD_FAILED_END);

// Bloc de chargement manuel partage (champ Multisig address + Load).
const LOADER_START = CONNECT.indexOf('const multisigLoaderBlock = (');
const LOADER_END = CONNECT.indexOf("// Android : la fenetre n'etant", LOADER_START);
const LOADER_BLOCK = CONNECT.slice(LOADER_START, LOADER_END);

// Erreur reseau reelle, telle que produite par le SDK en bout de chaine.
const NETWORK_ERROR =
  'Could not read the account: failed to get info about account 8Zx7CeAbcD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZabcdef: Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "api.devnet.solana.com": No address associated with hostname';

check('1. Les blocs cibles sont bien extraits', () => {
  assert.ok(LOAD_FAILED_START > 0 && LOAD_FAILED_END > LOAD_FAILED_START, 'bloc load-failed');
  assert.ok(LOADER_START > 0 && LOADER_END > LOADER_START, 'bloc loader');
});

check('2. Plus AUCUN texte technique brut', () => {
  // Aucune interpolation JSX de l'erreur brute nulle part dans l'ecran.
  assert.ok(!CONNECT.includes('{msig.error}'), 'aucun {msig.error} en clair');
  assert.ok(!LOAD_FAILED_BLOCK.includes('{msig.error}'), 'load-failed : aucun {msig.error}');
  assert.ok(!LOADER_BLOCK.includes('{msig.error}'), 'loader : aucun {msig.error}');
  // Le message technique n'apparait jamais dans les deux panneaux.
  for (const marker of ['UnknownHostException', 'api.devnet.solana.com', 'fetch failed']) {
    assert.ok(!LOAD_FAILED_BLOCK.includes(marker), `load-failed sans « ${marker} »`);
    assert.ok(!LOADER_BLOCK.includes(marker), `loader sans « ${marker} »`);
  }
});

check('3. UN SEUL bouton « Retry »', () => {
  // Le seul PillButton « Retry » de tout l'ecran est dans l'etat load-failed.
  assert.equal(
    CONNECT.split('label="Retry"').length - 1,
    1,
    'un seul label="Retry" dans tout l ecran',
  );
  assert.equal(
    LOAD_FAILED_BLOCK.split('label="Retry"').length - 1,
    1,
    'load-failed porte l unique Retry',
  );
  // Le panneau de chargement manuel n'a PLUS aucun bouton Retry (deduplication).
  assert.ok(!LOADER_BLOCK.includes('label="Retry"'), 'loader : aucun bouton Retry');
  assert.ok(!LOADER_BLOCK.includes('>Retry<'), 'loader : aucun libelle Retry');
  assert.ok(!LOADER_BLOCK.includes('msig.retry'), 'loader : aucun appel a msig.retry');
});

check('4. Message court : titre GENERIQUE en toutes circonstances', () => {
  // Meme sur une erreur reseau explicite, le titre reste generique et SUR :
  // aucune cause inventee, aucune branche « No connection ».
  const offline = describeVaultLoadError(NETWORK_ERROR);
  assert.equal(offline.title, 'Could not load this multisig');
  assert.equal(offline.body, 'Check your connection and try again.');
  // Le repli (erreur non reseau) est IDENTIQUE : titre generique + corps court.
  const generic = describeVaultLoadError(
    'No account at this address on devnet. Check that it is a Squads v4 multisig deployed on devnet.',
  );
  assert.equal(generic.title, 'Could not load this multisig');
  assert.equal(generic.body, 'Check your connection and try again.');
  // Entrees nulles / vides : meme copie generique et sure.
  assert.equal(describeVaultLoadError(null).title, 'Could not load this multisig');
  assert.equal(describeVaultLoadError(undefined).title, 'Could not load this multisig');
  assert.equal(describeVaultLoadError('').title, 'Could not load this multisig');
  // Le message ne fuit JAMAIS le texte d'origine, quel que soit le cas.
  for (const msg of [offline, generic, describeVaultLoadError(null)]) {
    assert.ok(!msg.title.includes('UnknownHost') && !msg.body.includes('api.devnet'));
    assert.ok(!msg.title.includes('No connection'), 'jamais de titre « No connection »');
    assert.equal(msg.body, 'Check your connection and try again.');
  }
  // L'ecran REND le message court (jamais un litteral brut).
  assert.ok(CONNECT.includes('describeVaultLoadError'), 'classifieur utilise');
  assert.ok(CONNECT.includes('vaultLoadMessage.title'), 'titre court rendu');
  assert.ok(CONNECT.includes('vaultLoadMessage.body'), 'explication courte rendue');
});

check('5. Panneau AMBRE (warning), jamais rouge', () => {
  assert.ok(LOAD_FAILED_BLOCK.includes('tone="warning"'), 'load-failed : ton warning');
  assert.ok(!LOAD_FAILED_BLOCK.includes('tone="error"'), 'load-failed : jamais error');
  assert.ok(LOAD_FAILED_BLOCK.includes('styles.loadWarningBox'), 'load-failed : style ambre');
  assert.ok(LOADER_BLOCK.includes('tone="warning"'), 'loader : ton warning');
  assert.ok(!LOADER_BLOCK.includes('tone="error"'), 'loader : jamais error');
  // Le ton ambre provient du token du theme (aucune couleur codee en dur).
  const THEME = readFileSync('src/ui/theme.ts', 'utf8');
  assert.ok(THEME.includes("warning: '#F4C56A'"), 'token warning du theme present');
  assert.ok(THEME.includes("warningSoft: '#382A0D'"), 'token warningSoft du theme present');
});

check('6. Conserve : Choose another multisig + bloc Multisig address', () => {
  assert.ok(LOAD_FAILED_BLOCK.includes('Choose another multisig'), 'action secondaire conservee');
  assert.ok(
    LOAD_FAILED_BLOCK.includes('setVaultPickerOpen(true)'),
    'Choose another multisig ouvre le selecteur',
  );
  // Bloc « Multisig address » : champ + Paste + Load, intacts.
  assert.ok(LOADER_BLOCK.includes('label="Multisig address"'), 'champ Multisig address');
  assert.ok(LOADER_BLOCK.includes('onPress={onLoadMultisig}'), 'bouton Load present');
  assert.ok(LOADER_BLOCK.includes('<AddressInput'), 'champ partage (Paste integre)');
  // Note de securite du champ (dans AddressInput, jamais retiree).
  assert.ok(
    ADDRESS_FIELD_HINT.includes('Never paste a recovery phrase'),
    'note de securite conservee',
  );
});

check('7. Deduplication : le loader ne double pas le panneau d echec', () => {
  // Le panneau d'erreur du loader n'est rendu QUE hors de l'etat load-failed
  // (sinon la carte d'echec et lui montreraient deux fois le meme message).
  assert.ok(
    LOADER_BLOCK.includes("vaultBodyState !== 'load-failed'"),
    'loader : garde anti-duplication',
  );
});

setTimeout(() => {
  console.log(`\n${passed} test(s) OK`);
  if (process.exitCode === 1) process.exit(1);
}, 50);
