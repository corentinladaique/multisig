import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Tests FOCALISES de l'ARTEFACT VISUEL de la marque animée (CardsMark) :
 * supprimer les LIGNES HORIZONTALES parasites qui apparaissaient EN TRAVERS de
 * la tuile menthe, ET garantir que l'usage de l'état « No multisig loaded »
 * (`no-saved`) est STRICTEMENT identique à celui de l'écran de connexion du
 * wallet (mêmes props, même taille, même enveloppe, même rendu).
 *
 * CAUSE : la tuile est un empilement de 24 bandes de `View` (le dégradé). Avec
 * `flex: 1`, chaque bande reçoit `132 / 24 = 5,5 px` ; l'arrondi au pixel du
 * parent ouvre une COUTURE sous-pixel là où le fond `BRAND_BG` (mint plus foncé)
 * transparaît — une LIGNE HORIZONTALE. Le défaut n'apparaît que selon le
 * contexte de layout (ici le centrage par `homeBodyEmpty`), d'où un écran de
 * connexion PROPRE et un état `no-saved` strié.
 *
 * CORRECTIF : bandes en position ABSOLUE, chacune chevauchant la suivante d'1 px
 * (hauteur `size / TILE_BANDS + 1`). Plus aucune couture, quel que soit le
 * contexte — donc rendu identique partout.
 *
 * Tests PURS (lecture des sources) : aucun rendu, aucun RPC, aucun wallet.
 * Exécution : npx tsx scripts/vault-mark-seams.test.ts
 */

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const MARK = readFileSync('src/ui/v2/CardsMark.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

/** Balise JSX EXACTE de la marque (elle doit être identique aux deux endroits). */
const MARK_TAG = '<CardsMark loop size={132} style={styles.brandMark} tile />';

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

// --- (a) MÊMES props que l'écran de connexion, aux deux emplacements ---------

check('1. exactement deux usages de CardsMark : connexion + état sans vault', () => {
  const tags = CONNECT.match(/<CardsMark[^>]*>/g) ?? [];
  assert.equal(tags.length, 2, 'un seul usage à la connexion, un seul dans l’onglet Vault');
});

check('2. les DEUX usages sont BYTE-IDENTIQUES (mêmes props, même enveloppe)', () => {
  const first = CONNECT.indexOf(MARK_TAG);
  const second = CONNECT.indexOf(MARK_TAG, first + 1);
  assert.ok(first !== -1 && second !== -1, 'les deux balises exactes existent');
  const tags = CONNECT.match(/<CardsMark[^>]*>/g) ?? [];
  assert.ok(
    tags.every((tag) => tag === MARK_TAG),
    'aucune variante : loop + size={132} + style brandMark + tile partout',
  );
  // L'écran de connexion (account === undefined) et l'état sans vault (view === null).
  assert.ok(
    CONNECT.slice(0, first).includes('account === undefined'),
    'le premier usage est l’écran de connexion du wallet',
  );
  assert.ok(
    CONNECT.slice(0, second).includes('Variante B'),
    'le second usage est l’état sans multisig (bloc « Variante B »)',
  );
});

check('3. l’état « no-saved » est couvert par la garde qui monte cette balise', () => {
  const gate =
    "vaultBodyState === 'loading-registry' || vaultBodyState === 'loading-vault' || vaultBodyState === 'no-saved' || vaultBodyState === 'no-active' ? (";
  const at = CONNECT.indexOf(gate);
  assert.ok(at !== -1, 'la garde des quatre états existe');
  assert.ok(
    CONNECT.slice(at, at + 400).includes(MARK_TAG),
    'la marque rendue sous cette garde est la balise identique à la connexion',
  );
});

// --- Le correctif des coutures, dans la primitive partagée CardsMark ---------

check('4. les bandes du dégradé ne peuvent plus laisser de couture (artefact)', () => {
  // Positions ABSOLUES : la hauteur de chaque bande ne dépend plus de l'arrondi
  // au pixel du parent (c'était la source des lignes horizontales).
  assert.ok(
    /band:\s*\{[^}]*position: 'absolute'/s.test(MARK),
    'les bandes sont positionnées en absolu',
  );
  assert.ok(
    !/band:\s*\{[^}]*flex: 1/s.test(MARK),
    'plus de `flex: 1` (fractionnaire, source des coutures) sur les bandes',
  );
  // Chaque bande CHEVAUCHE la suivante d'1 px : aucune bande morte entre deux.
  assert.ok(MARK.includes('height: size / TILE_BANDS + 1'), 'hauteur des bandes = pas + 1 px de recouvrement');
  assert.ok(MARK.includes('top: (size / TILE_BANDS) * i'), 'chaque bande est posée à son pas');
});

check('5. la composition de la tuile reste inchangée (mêmes couleurs, même fond)', () => {
  assert.ok(MARK.includes('const TILE_BANDS = 24;'), 'nombre de bandes inchangé');
  assert.ok(MARK.includes("const BRAND_BG = '#A3D9D2';"), 'fond menthe de secours inchangé');
  assert.ok(MARK.includes('backgroundColor: tile ? BRAND_BG : undefined'), 'le fond de la tuile est inchangé');
  assert.ok(/box:\s*\{[^}]*overflow: 'hidden'/s.test(MARK), 'le débordement de la boîte reste masqué');
});

// --- Enregistrement ----------------------------------------------------------

check('6. la suite est enregistrée dans npm test', () => {
  assert.ok(
    RUNNER.includes('scripts/vault-mark-seams.test.ts'),
    'suite des coutures de la marque dans le runner',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
