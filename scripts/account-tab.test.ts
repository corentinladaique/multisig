import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { APP_VERSION } from '../src/appInfo';
import { makeEntry, type MultisigRegistryEntry } from '../src/vault/multisigRegistry';
import {
  createEmptyUsage,
  markUsed,
  sortEntriesByLastUsed,
} from '../src/vault/vaultNavigation';

/**
 * Tests FOCALISES de l'etape 2 : onglet ACCOUNT.
 *
 * Tests PURS (lecture des sources + modules partages) ; aucun RPC, aucun
 * wallet, aucune transaction, aucun stockage natif. Execution :
 * npx tsx scripts/account-tab.test.ts
 */

const MULTISIG_A = '11111111111111111111111111111111';
const MULTISIG_B = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG_C = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const SHEET = readFileSync('src/ui/v2/VaultPickerSheet.tsx', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

// Version REELLE de l'application, lue a l'execution depuis la source de build.
const APPJSON = JSON.parse(readFileSync('app.json', 'utf8')) as {
  expo: { version: string };
};

// Tranche de la branche Account uniquement, bornee par des reperes stables.
const ACCOUNT_START = CONNECT.indexOf("{tab === 'account' ? (");
const ACCOUNT_END = CONNECT.indexOf('</>', ACCOUNT_START);
const ACCOUNT = CONNECT.slice(ACCOUNT_START, ACCOUNT_END);

let passed = 0;

function check(name: string, run: () => void | Promise<void>): void {
  try {
    const outcome = run();
    if (outcome instanceof Promise) {
      outcome
        .then(() => {
          passed += 1;
          console.log(`PASS ${name}`);
        })
        .catch((caught: unknown) => {
          console.error(`FAIL ${name}`);
          console.error(`  ${caught instanceof Error ? caught.message : String(caught)}`);
          process.exitCode = 1;
        });
      return;
    }
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (caught: unknown) {
    console.error(`FAIL ${name}`);
    console.error(`  ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  }
}

function entryFor(address: string, addedAt: string, vaultName = 'Vault'): MultisigRegistryEntry {
  const { entry, errors } = makeEntry({
    address,
    vaultName,
    memberLabels: {},
    now: addedAt,
    source: 'manual',
  });
  assert.deepEqual(errors, []);
  if (entry === null) throw new Error('entry was rejected');
  return entry;
}

// --- Carte « Connected wallet » ---------------------------------------------

check('1. la carte « Connected wallet » rend le wallet connecte', () => {
  assert.ok(ACCOUNT.includes('Connected wallet'), 'titre de la carte present');
  assert.ok(ACCOUNT.includes('<Card'), 'la carte utilise la primitive Card');
  assert.ok(
    ACCOUNT.includes("{walletIdentity?.label ?? 'Wallet without label'}"),
    'nom du wallet s il est deja connu, sinon repli explicite',
  );
  assert.ok(
    ACCOUNT.includes('walletIdentity'),
    'le nom vient de l identite de session EXISTANTE, aucune nouvelle logique',
  );
});

check('2. l adresse abregée du wallet est affichée', () => {
  assert.ok(
    ACCOUNT.includes('{shortenAddress(account.address.toString())}'),
    'adresse du wallet abregée',
  );
  assert.ok(ACCOUNT.includes('styles.accountWalletAddress'), 'style d adresse conserve');
});

// --- Copy --------------------------------------------------------------------

check('3. Copy réutilise le retour temporaire EXISTANT « Copied ✓ »', () => {
  assert.ok(ACCOUNT.includes('onPress={onCopyWallet}'), 'Copy reutilise le handler existant');
  assert.ok(
    ACCOUNT.includes('{walletCopyFeedback !== null ? ('),
    'le retour est le MEME etat walletCopyFeedback, pas un second',
  );
  assert.ok(ACCOUNT.includes('styles.copyFeedback'), 'memes styles de retour de copie');
  // Le mecanisme « Copied ✓ » est l'unique source de copie (clipboard existant).
  assert.ok(
    CONNECT.includes('copyToClipboard(account.address.toString()) ? COPIED_MESSAGE : COPY_FAILED_MESSAGE'),
    'retour « Copied ✓ » existant reutilise tel quel',
  );
  assert.equal(CONNECT.split('copyToClipboard(').length - 1, 1, 'un seul appel de copie');
  // Un seul etat de retour de copie dans tout l'ecran.
  assert.equal(
    CONNECT.split('const [walletCopyFeedback, setWalletCopyFeedback]').length - 1,
    1,
    'un seul etat de retour de copie',
  );
  // Aucun second etat de retour de copie n'est invente.
  assert.ok(!CONNECT.includes('walletCardCopyFeedback'), 'pas de second retour de copie');
  assert.ok(!CONNECT.includes('cardCopied'), 'pas de second mecanisme de copie');
});

// --- Disconnect --------------------------------------------------------------

check('4. Disconnect n est exposé que via le comportement DEJA supporté', () => {
  // Le flux wallet/session supporte deja la deconnexion : useMobileWallet()
  // expose `disconnect`, et le handler `onDisconnect` existe (aucun nouveau).
  // On lit la destructure REELLE du hook (elle a pu evoluer) et on exige que
  // `disconnect` en provienne — la garantie, pas la liste exacte des champs.
  const walletHook = CONNECT.match(/const \{([^}]*)\} = useMobileWallet\(\);/);
  assert.ok(walletHook !== null, 'la session wallet provient du hook useMobileWallet');
  assert.ok(/\bdisconnect\b/.test(walletHook[1]),
    'disconnect provient du hook de session existant');
  assert.ok(CONNECT.includes('const onDisconnect = useCallback'), 'handler de deconnexion existant');
  assert.ok(CONNECT.includes('await disconnect();'), 'appel de deconnexion reel existant');
  // La carte expose ce handler DEJA supporte, sans nouvelle logique.
  assert.ok(ACCOUNT.includes('label="Disconnect wallet"'), 'bouton dans la carte');
  assert.ok(ACCOUNT.includes('onPress={onDisconnect}'), 'handler existant reutilise');
  // Une seule exposition de la deconnexion dans Account (pas de doublon).
  assert.equal(ACCOUNT.split('onPress={onDisconnect}').length - 1, 1, 'deconnexion exposee une seule fois');
});

// --- Source locale partagee des multisigs -----------------------------------

check('5. Account réutilise la MEME source locale que le selecteur de vault', () => {
  // Une seule lecture du registre local dans tout l'ecran.
  assert.equal(CONNECT.split('useMultisigRegistry()').length - 1, 1, 'une seule lecture du registre');
  // Une seule definition des entrees ordonnees (registre + recence).
  assert.equal(
    CONNECT.split('sortEntriesByLastUsed(registry.entries, usage.usage)').length - 1,
    1,
    'une seule source d entrees ordonnees',
  );
  // Le selecteur recoit CETTE valeur...
  assert.ok(CONNECT.includes('entries={orderedEntries}'), 'selecteur alimente par orderedEntries');
  assert.ok(
    CONNECT.includes('statsByAddress={vaultStatsByAddress}'),
    'selecteur alimente par vaultStatsByAddress',
  );
  // ...et Account itere EXACTEMENT la meme valeur, pas une seconde liste.
  assert.ok(ACCOUNT.includes('orderedEntries.map('), 'Account itere orderedEntries');
  assert.ok(
    ACCOUNT.includes('const stat = vaultStatsByAddress[entry.address];'),
    'Account lit les memes seuils que le selecteur',
  );
  // Aucune seconde source de stockage : Account ne touche a aucun stockage.
  assert.ok(!/AsyncStorage|STORAGE_KEY|deviceVaultUsageStorage|deviceMultisigStorage/.test(ACCOUNT),
    'Account ne cree aucune seconde source de stockage');
});

check('6. la liste d Account reste coherente avec le selecteur (meme ordre)', () => {
  // La cohérence se PROUVE sur la source partagee : entrees + recence.
  const a = entryFor(MULTISIG_A, '2026-09-01T10:00:00.000Z');
  const b = entryFor(MULTISIG_B, '2026-09-02T10:00:00.000Z');
  const c = entryFor(MULTISIG_C, '2026-09-03T10:00:00.000Z');
  let usage = createEmptyUsage();
  usage = markUsed(usage, MULTISIG_A, undefined, '2026-09-10T10:00:00.000Z');
  usage = markUsed(usage, MULTISIG_B, undefined, '2026-09-12T10:00:00.000Z');
  // Ordre attendu, identique pour le selecteur et pour Account (meme fonction).
  const ordered = sortEntriesByLastUsed([a, b, c], usage).map((entry) => entry.address);
  assert.deepEqual(ordered, [MULTISIG_B, MULTISIG_A, MULTISIG_C]);
  // Account et le selecteur consomment la MEME liste `orderedEntries`.
  assert.ok(CONNECT.includes('orderedEntries.map('), 'Account : orderedEntries');
  assert.ok(CONNECT.includes('entries={orderedEntries}'), 'selecteur : orderedEntries');
  // Aucune requete reseau ajoutee pour obtenir la liste.
  assert.ok(!/connection\.|getBalance|getAccountInfo|getProgramAccounts/.test(ACCOUNT),
    'Account : aucune lecture reseau');
});

// --- Seuil -------------------------------------------------------------------

check('7. le seuil est affiché quand il est DEJA disponible, sans reseau', () => {
  // Le seuil provient de vaultStatsByAddress (memes valeurs que le selecteur).
  assert.ok(ACCOUNT.includes('styles.accountMultisigThreshold'), 'renderer de seuil present');
  assert.ok(
    ACCOUNT.includes('stat.threshold !== null && stat.memberCount !== null'),
    'seuil affiche UNIQUEMENT s il est deja connu',
  );
  assert.ok(
    ACCOUNT.includes('`${stat.threshold} of ${stat.memberCount}`'),
    'format « 2 of 3 », identique au selecteur',
  );
  // Meme format de seuil dans le selecteur (coherence de libelle).
  assert.ok(
    SHEET.includes('`${stat.threshold} of ${stat.memberCount}`'),
    'selecteur : meme format de seuil',
  );
  // Aucune lecture reseau n'est ajoutee pour obtenir un seuil manquant.
  assert.ok(!/getAccountInfo|getProgramAccounts|connection\.|\.load\(/.test(ACCOUNT),
    'aucune lecture reseau ni chargement pour le seuil');
});

// --- Nom d'entree ------------------------------------------------------------

check('8. nom et adresse abregée de chaque entrée, comme le selecteur', () => {
  assert.ok(
    ACCOUNT.includes("{entry.vaultName.length > 0 ? entry.vaultName : 'Untitled vault'}"),
    'nom local, meme repli que le selecteur',
  );
  assert.ok(ACCOUNT.includes('{shortenMemberAddress(entry.address)}'), 'adresse abregée partagee');
  // Le selecteur utilise le MEME helper d'abrege.
  assert.ok(SHEET.includes('shortenMemberAddress(entry.address)'), 'selecteur : meme helper');
});

check('9. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/account-tab.test.ts'), 'suite d Account dans le runner');
});

// --- Ligne About STATIQUE + lien X de retour dans la liste -------------------

check('10. la ligne « About » est PRESENTE, NON cliquable, et porte la version (source reelle)', () => {
  assert.ok(ACCOUNT.includes('title="About"'), 'ligne About presente');
  // La ligne est STATIQUE : une seule balise auto-fermante, donc aucun onPress
  // (ni accessibilityRole bouton) — elle n ouvre plus aucune feuille.
  assert.ok(
    ACCOUNT.includes('<ListRow subtitle={`Version ${APP_VERSION}`} title="About" />'),
    'ligne About auto-fermante : aucune action (non cliquable)',
  );
  // Aucun handler d ouverture de feuille ne subsiste.
  assert.ok(!ACCOUNT.includes('setAboutOpen'), 'aucun handler About residuel');
  // Le sous-titre affiche la version, lue a l execution depuis app.json.
  assert.equal(APP_VERSION, APPJSON.expo.version, 'version identique a app.json (jamais en dur)');
  assert.ok(
    ACCOUNT.includes('subtitle={`Version ${APP_VERSION}`}'),
    'le sous-titre porte APP_VERSION (jamais codee en dur)',
  );
  assert.ok(
    !ACCOUNT.includes('subtitle="Multisig"'),
    'l ancien sous-titre muet « Multisig » reste absent',
  );
});

check('11. le lien X (@Corentin_Lad) est VISIBLE et TAPPABLE dans la liste d Account', () => {
  // La poignee et l URL de profil X sont de retour dans la liste Account.
  assert.ok(ACCOUNT.includes('@Corentin_Lad'), 'la poignee X est visible dans la liste');
  assert.ok(ACCOUNT.includes('X_PROFILE_URL'), 'la constante de lien X est presente dans la liste');
  assert.ok(
    CONNECT.includes("const X_PROFILE_URL = 'https://x.com/Corentin_Lad'"),
    'l URL du profil X est definie (non opaque)',
  );
  // Libelle EXPLICITE : l utilisateur voit qu il s agit de son compte X/Twitter.
  assert.ok(
    ACCOUNT.includes('title="X (Twitter)"'),
    'la ligne nomme la plateforme (pas un « X » opaque)',
  );
  // La ligne est TAPPABLE : le tap ouvre le lien dans le navigateur.
  assert.ok(
    ACCOUNT.includes('void Linking.openURL(X_PROFILE_URL).catch(() => undefined)'),
    'le tap ouvre le lien X via Linking',
  );
  assert.ok(
    ACCOUNT.includes('accessibilityLabel="Open the X profile of the app (@Corentin_Lad)"'),
    'la ligne X est etiquetee explicitement',
  );
});

// --- Section « Archived (N) » repliable (compte cache par defaut) ------------

check('12. la section « Archived (N) » est REPLIEE par defaut (etat initial)', () => {
  // L'etat est initialise a `false` : au montage, la liste des archives n'est
  // PAS rendue — seul l'en-tete avec le compteur l'est.
  assert.ok(
    CONNECT.includes('const [accountArchivedOpen, setAccountArchivedOpen] = useState(false)'),
    'etat initial replie (useState(false))',
  );
  // La liste n'est rendue QUE dans la branche depliee.
  assert.ok(
    /accountArchivedOpen\s*\?\s*archivedOrderedEntries\.map\(/.test(ACCOUNT),
    'la liste des archives n est rendue que si l en-tete est deplie',
  );
});

check('13. l en-tete « Archived (N) » est un controle accessible qui bascule', () => {
  assert.ok(ACCOUNT.includes('accessibilityRole="button"'), 'role bouton');
  assert.ok(
    ACCOUNT.includes('accessibilityState={{ expanded: accountArchivedOpen }}'),
    'expose l etat deploye/replie',
  );
  assert.ok(
    ACCOUNT.includes('onPress={() => setAccountArchivedOpen((previous) => !previous)}'),
    'un tap bascule le repli',
  );
  assert.ok(ACCOUNT.includes('Show archived vaults'), 'libelle explicite en anglais (replie)');
  assert.ok(ACCOUNT.includes('Hide archived vaults'), 'libelle explicite en anglais (deplie)');
});

check('14. le compteur « (N) » reste visible quand c est replie', () => {
  // Le texte de l en-tete porte le compteur et est rendu HORS de la branche
  // depliee : il reste affiche quand la liste est repliee.
  assert.ok(
    /<Text style=\{styles\.accountArchivedHeader\}>\s*\{archivedSectionLabel\(archivedCount\)\}/.test(
      ACCOUNT,
    ),
    'l en-tete rend archivedSectionLabel(archivedCount)',
  );
  assert.ok(
    ACCOUNT.includes('styles.accountArchivedHeaderRow'),
    'l en-tete est une ligne cliquable (chessis/chevron + texte)',
  );
  assert.ok(
    ACCOUNT.includes("name={accountArchivedOpen ? 'chevron-down' : 'chevron-forward'}"),
    'indicateur visuel (chevron) coherent avec le reste de l app',
  );
});

check('15. la section disparait quand aucun vault n est archive', () => {
  // La section ENTIERE n est rendue que si le libelle existe (donc N > 0).
  assert.ok(
    ACCOUNT.includes('archivedSectionLabel(archivedCount) !== null ? ('),
    'section gardee par le libelle (absente a N=0)',
  );
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);