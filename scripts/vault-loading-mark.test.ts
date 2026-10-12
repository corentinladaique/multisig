import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES de la variante B de l'état « chargement du vault » de l'onglet
 * Vault : la marque animée RÉELLE (réutilisée, jamais redessinée) coiffe la carte
 * de chargement, l'ensemble centré. Tests PURS (lecture des sources) : aucun RPC,
 * aucun wallet, aucune transaction. Execution :
 * npx tsx scripts/vault-loading-mark.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const PKG = readFileSync('package.json', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

/** Balise JSX EXACTE de la page de connexion du wallet (ConnectScreen.tsx). */
const MARK_TAG = '<CardsMark loop size={132} style={styles.brandMark} tile />';

// Garde du rendu de la marque : les DEUX états de chargement, PLUS les états
// neutres « aucun vault à l'écran » (`no-saved` — y compris après une
// déconnexion — et `no-active` — toutes les entrées archivées). La marque doit
// s'afficher dans ces quatre états, champ d'adresse replié COMME déplié.
const LOADING_GATE =
  "vaultBodyState === 'loading-registry' || vaultBodyState === 'loading-vault' || vaultBodyState === 'no-saved' || vaultBodyState === 'no-active' ? (";

/** Position du premier rendu de la marque (bloc « Variante B »). */
const loadingMarkGate = CONNECT.indexOf(LOADING_GATE);
/** Fenêtre de source : le bloc « Variante B » uniquement. */
const loadingBranch = CONNECT.slice(
  CONNECT.indexOf('Variante B'),
  CONNECT.indexOf('Variante B') + 1200,
);

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

// --- Réutilisation du composant RÉEL -----------------------------------------

check('1. l\'état de chargement monte le composant RÉEL CardsMark importé', () => {
  assert.ok(
    CONNECT.includes("import { CardsMark } from '../ui/v2/CardsMark';"),
    'CardsMark est importé depuis le composant partagé (pas redessiné)',
  );
  assert.ok(loadingMarkGate !== -1, 'un rendu de la marque est gate sur l\'état de chargement');
  assert.ok(
    CONNECT.slice(loadingMarkGate, loadingMarkGate + 340).includes(MARK_TAG),
    'la marque est montée exactement sous la garde de chargement',
  );
});

check('1b. la marque coiffe AUSSI les états neutres « no-saved » et « no-active »', () => {
  // Exigence : la marque n'est PLUS réservée aux états de chargement — elle
  // s'affiche dans `no-saved` (aucun vault local, y compris après déconnexion)
  // ET dans `no-active` (toutes les entrées archivées), pour la cohérence.
  assert.ok(loadingMarkGate !== -1, 'la garde de la marque existe');
  const gate = CONNECT.slice(loadingMarkGate, loadingMarkGate + 200);
  assert.ok(gate.includes("'no-saved'"), 'la garde de la marque inclut « no-saved »');
  assert.ok(gate.includes("'no-active'"), 'la garde de la marque inclut « no-active »');
});

check('1c. la marque ne dépend NI du repli du champ NI du chemin de choix', () => {
  // La marque doit RESTER visible quand « Add existing multisig » déplie le champ
  // d'adresse (`addMultisigOpen`) et quand on arrive par le chemin de sélection
  // (`choosingVault`) : la garde du rendu de la marque ne mentionne NI l'un NI
  // l'autre — ni en direct, ni par sa négation. Le dépliage du champ ne fait donc
  // jamais disparaître la marque. La marque reste AU-DESSUS de la carte (checked 3).
  const gate = CONNECT.slice(loadingMarkGate, loadingMarkGate + 200);
  assert.ok(!gate.includes('addMultisigOpen'), 'la garde ne dépend pas du repli du champ');
  assert.ok(!gate.includes('choosingVault'), 'la garde ne dépend pas du chemin de choix');
  // Le champ adresse est bien celui déplié par « Add existing multisig » (le seul
  // bloc manuel) : la marque le coiffe dans les deux positions.
  assert.ok(
    CONNECT.includes('{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}'),
    'le champ se déplie toujours via le même bloc (replié/déplié)',
  );
});

check('2. props STRICTEMENT identiques à la page de connexion du wallet', () => {
  // La balise EXACTE (loop + size={132} + style brandMark + tile) n'existe que
  // deux fois : page de connexion (account === undefined) et état de chargement.
  const occurrences = CONNECT.split(MARK_TAG).length - 1;
  assert.equal(occurrences, 2, 'mêmes props aux deux emplacements, aucune copie divergente');
  assert.ok(MARK_TAG.includes('loop'), 'animation en boucle');
  assert.ok(MARK_TAG.includes('size={132}'), 'même taille que la page de connexion');
  assert.ok(MARK_TAG.includes('tile'), 'mode tuile (indispensable sur fond sombre)');
});

// --- Disposition : marque AU-DESSUS, carte EN DESSOUS -------------------------

check('3. la marque précède la carte de chargement (marque en HAUT)', () => {
  const markAt = loadingBranch.indexOf(MARK_TAG);
  const cardAt = loadingBranch.indexOf('<Card elevated style={styles.vaultCard}>');
  assert.ok(markAt !== -1, 'la marque est dans le bloc « Variante B »');
  assert.ok(cardAt !== -1, 'la carte est dans le bloc « Variante B »');
  assert.ok(markAt < cardAt, 'la marque vient AVANT la carte (marque en haut)');
});

check('4. le groupe est centré verticalement (plus de vide noir)', () => {
  assert.ok(
    CONNECT.includes(
      'view === null && !addMultisigOpen ? styles.homeBodyEmpty : styles.homeBody',
    ),
    'le conteneur centré reste appliqué à l\'état sans vault',
  );
  assert.ok(
    /homeBodyEmpty:\s*\{[^}]*justifyContent: 'center'/s.test(CONNECT),
    'homeBodyEmpty centre le groupe (marque + carte)',
  );
  assert.ok(
    /homeBodyEmpty:\s*\{[^}]*flex: 1/s.test(CONNECT),
    'homeBodyEmpty occupe toute la hauteur disponible',
  );
});

// --- Contenu de la carte INCHANGÉ --------------------------------------------

check('5. contenu de la carte de chargement intact', () => {
  assert.ok(CONNECT.includes("'Loading your multisig…'"), 'libellé vault intact');
  assert.ok(CONNECT.includes("'Getting your most recent vault.'"), 'sous-titre vault intact');
  assert.ok(CONNECT.includes("'Loading saved multisigs…'"), 'libellé registre intact');
  assert.ok(CONNECT.includes("'Reading the local registry.'"), 'sous-titre registre intact');
});

check('6. aucune structure ajoutée à la carte (bloc de chargement unique)', () => {
  // Un SEUL AddressInput dans tout l'écran : rien de dupliqué dans l'état de
  // chargement, le bloc manuel reste rendu par `multisigLoaderBlock` seul.
  assert.equal(CONNECT.split('<AddressInput').length - 1, 1, 'un seul champ adresse');
  assert.ok(
    CONNECT.includes('{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}'),
    'le bloc de chargement manuel est gate par addMultisigOpen OU choosingVault',
  );
  // Les deux Cart de l'onglet Vault (vide/chargement, puis vault chargé).
  assert.equal(
    CONNECT.split('<Card elevated style={styles.vaultCard}>').length - 1,
    2,
    'aucune carte supplémentaire ajoutée',
  );
});

// --- Aucune dépendance nouvelle ----------------------------------------------

check('7. aucune dépendance nouvelle (pas de svg / lottie)', () => {
  assert.ok(!/react-native-svg/.test(PKG), 'react-native-svg non ajouté');
  assert.ok(!/lottie/i.test(PKG), 'lottie non ajouté');
  assert.ok(!/react-native-reanimated/.test(PKG), 'reanimated non ajouté');
});

// --- Enregistrement dans la suite npm test -----------------------------------

check('8. la suite est enregistrée dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/vault-loading-mark.test.ts'),
    'suite de la variante B dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
