import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeEntry, type MultisigRegistryEntry } from '../src/vault/multisigRegistry';
import {
  createEmptyUsage,
  createMemoryUsageStorage,
  describeVaultBody,
  describeVaultHeader,
  deterministicLegacyTimestamp,
  deriveLastUsedAt,
  effectiveRecord,
  loadUsage,
  markUsed,
  mostRecentlyUsedAddress,
  parseUsage,
  saveUsage,
  serializeUsage,
  shouldAutoLoad,
  sortEntriesByLastUsed,
  VAULT_USAGE_STORAGE_KEY,
} from '../src/vault/vaultNavigation';

/**
 * Tests FOCALISES de l'etape 1 : selecteur de vault, recence locale et
 * auto-chargement. Tests PURS (modules partages + lecture des sources) ; aucun
 * RPC, aucun wallet, aucune transaction. Execution :
 * npx tsx scripts/vault-selector.test.ts
 */

const MULTISIG_A = '11111111111111111111111111111111';
const MULTISIG_B = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG_C = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const SHEET = readFileSync('src/ui/v2/VaultPickerSheet.tsx', 'utf8');
const REGISTRY_HOOK = readFileSync('src/vault/useMultisigRegistry.ts', 'utf8');
const NAVIGATION_SRC = readFileSync('src/vault/vaultNavigation.ts', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

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

// --- Auto-chargement ---------------------------------------------------------

check('1. auto-chargement : le vault le plus recemment utilise', () => {
  const older = entryFor(MULTISIG_A, '2026-09-01T10:00:00.000Z');
  const newer = entryFor(MULTISIG_B, '2026-09-02T10:00:00.000Z');
  const entries = [older, newer];
  // Sans usage persiste : migration deterministe depuis addedAt (B plus recent).
  assert.equal(mostRecentlyUsedAddress(entries, createEmptyUsage()), MULTISIG_B);
  // Avec usage persiste : A marque plus recent que B.
  const usage = markUsed(createEmptyUsage(), MULTISIG_A, undefined, '2026-09-10T10:00:00.000Z');
  assert.equal(mostRecentlyUsedAddress(entries, usage), MULTISIG_A);
});

check('2. auto-chargement gate : jamais sans sauvegarde, une seule tentative', () => {
  const base = {
    registryStatus: 'ready' as const,
    usageStatus: 'ready' as const,
    hasView: false,
    attempted: false,
    savedCount: 2,
    loading: false,
  };
  assert.equal(shouldAutoLoad(base), true);
  assert.equal(shouldAutoLoad({ ...base, attempted: true }), false);
  assert.equal(shouldAutoLoad({ ...base, savedCount: 0 }), false);
  assert.equal(shouldAutoLoad({ ...base, hasView: true }), false);
  assert.equal(shouldAutoLoad({ ...base, usageStatus: 'loading' }), false);
  assert.equal(shouldAutoLoad({ ...base, registryStatus: 'loading' }), false);
  assert.equal(shouldAutoLoad({ ...base, loading: true }), false);
  // Aucune sauvegarde : aucune cible a charger.
  assert.equal(mostRecentlyUsedAddress([], createEmptyUsage()), null);
});

// --- Etat vide « No multisig loaded » ---------------------------------------

check('3. « No multisig loaded » seulement sans aucune sauvegarde', () => {
  assert.equal(
    describeVaultBody({ registryStatus: 'ready', savedCount: 0, hasView: false, loadFailed: false }),
    'no-saved',
  );
  // Avec des sauvegardes : jamais l'etat vide, meme en echec de chargement.
  assert.equal(
    describeVaultBody({ registryStatus: 'ready', savedCount: 2, hasView: false, loadFailed: false }),
    'loading-vault',
  );
  assert.equal(
    describeVaultBody({ registryStatus: 'ready', savedCount: 2, hasView: false, loadFailed: true }),
    'load-failed',
  );
  // Pendant la lecture du registre : etat de chargement, pas l'etat vide.
  assert.equal(
    describeVaultBody({ registryStatus: 'loading', savedCount: 0, hasView: false, loadFailed: false }),
    'loading-registry',
  );
  // Un vault charge prime sur tout.
  assert.equal(
    describeVaultBody({ registryStatus: 'ready', savedCount: 0, hasView: true, loadFailed: false }),
    'vault',
  );
  assert.ok(CONNECT.includes("vaultBodyState === 'no-saved'"), 'ecran : etat vide gate');
  assert.ok(CONNECT.includes('No multisig loaded'), 'texte de l etat vide present');
});

// --- Tri par lastUsedAt ------------------------------------------------------

check('4. tri par recence (lastUsedAt), plus recent d abord', () => {
  const a = entryFor(MULTISIG_A, '2026-09-01T10:00:00.000Z');
  const b = entryFor(MULTISIG_B, '2026-09-02T10:00:00.000Z');
  const c = entryFor(MULTISIG_C, '2026-09-03T10:00:00.000Z');
  // Usage : B > C > A.
  let usage = createEmptyUsage();
  usage = markUsed(usage, MULTISIG_A, undefined, '2026-09-10T10:00:00.000Z');
  usage = markUsed(usage, MULTISIG_B, undefined, '2026-09-12T10:00:00.000Z');
  usage = markUsed(usage, MULTISIG_C, undefined, '2026-09-11T10:00:00.000Z');
  assert.deepEqual(
    sortEntriesByLastUsed([a, b, c], usage).map((entry) => entry.address),
    [MULTISIG_B, MULTISIG_C, MULTISIG_A],
  );
  // Sans usage : repli deterministe par date de creation, plus recent d'abord.
  assert.deepEqual(
    sortEntriesByLastUsed([a, b, c], createEmptyUsage()).map((entry) => entry.address),
    [MULTISIG_C, MULTISIG_B, MULTISIG_A],
  );
});

// --- Mise a jour apres succes / echec ---------------------------------------

check('5. selection : lastUsedAt mis a jour apres un chargement reussi', () => {
  const now = '2026-10-09T12:00:00.000Z';
  const usage = markUsed(createEmptyUsage(), MULTISIG_A, { threshold: 2, memberCount: 3 }, now);
  assert.equal(usage.records[MULTISIG_A]?.lastUsedAt, now);
  assert.equal(usage.records[MULTISIG_A]?.threshold, 2);
  assert.equal(usage.records[MULTISIG_A]?.memberCount, 3);
  // L'ecran n'enregistre la recence QUE dans l'effet « chargement reussi ».
  assert.ok(
    CONNECT.includes("if (msig.status !== 'loaded' || view === null) return;"),
    'recence gatee sur le chargement reussi',
  );
  assert.ok(CONNECT.includes('void usage.markUsed('), 'recence ecrite via l usage local');
});

check('6. un echec de chargement ne met PAS a jour lastUsedAt', () => {
  // La recence n'est ecrite nulle part ailleurs que dans l'effet « loaded » :
  // aucun `markUsed` sur un chemin d'echec.
  assert.equal(CONNECT.split('usage.markUsed(').length - 1, 1, 'un seul point d ecriture de la recence');
  // Fenetre bornee a l'effet lui-meme (jusqu'a son tableau de dependances),
  // pas a un nombre de caracteres arbitraire : la revendication reste exacte
  // meme si un commentaire ou une garde interne est ajoute.
  const effectEnd = CONNECT.indexOf('}, [msig.status, registry.entries, view, usage]);');
  const errorEffect = CONNECT.slice(
    CONNECT.indexOf("if (msig.status !== 'loaded'"),
    effectEnd,
  );
  assert.ok(errorEffect.includes('usage.markUsed('), 'l ecriture est bien dans cet effet');
  assert.ok(
    CONNECT.includes("msig.status === 'error'") || CONNECT.includes("vaultLoadFailed"),
    'un etat d erreur explicite existe',
  );
});

// --- Migration deterministe --------------------------------------------------

check('7. migration determinstique : date de creation quand exploitable', () => {
  const withDate = entryFor(MULTISIG_A, '2026-08-15T09:30:00.000Z');
  assert.equal(deriveLastUsedAt(withDate, 0), '2026-08-15T09:30:00.000Z');
  const legacy = entryFor(MULTISIG_B, 'not-a-date');
  const value = deriveLastUsedAt(legacy, 3);
  assert.equal(value, deterministicLegacyTimestamp(3));
  // Deterministe et JAMAIS l'heure courante.
  assert.equal(value, deriveLastUsedAt(legacy, 3));
  assert.ok(Math.abs(Date.parse(value) - Date.now()) > 3_000_000_000, 'jamais l heure courante');
  // Ordre de stockage preserve : index plus grand = plus ancien.
  assert.ok(Date.parse(deterministicLegacyTimestamp(0)) > Date.parse(deterministicLegacyTimestamp(4)));
  // Aucune derive de l'horloge dans le module pur.
  assert.ok(!NAVIGATION_SRC.includes('Date.now()'), 'aucune heure courante dans la migration');
});

check('8. migration : effectiveRecord retombe sur addedAt, pas sur maintenant', () => {
  const entry = entryFor(MULTISIG_A, '2026-07-01T00:00:00.000Z');
  const record = effectiveRecord(entry, createEmptyUsage(), 0);
  assert.equal(record.lastUsedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(record.threshold, null);
  assert.equal(record.memberCount, null);
});

check('9. usage : aller-retour de persistance et cle dediee', () => {
  assert.equal(VAULT_USAGE_STORAGE_KEY, 'pocket-multisig.vault-usage.v1');
  const usage = markUsed(createEmptyUsage(), MULTISIG_A, { threshold: 2, memberCount: 3 }, '2026-10-09T12:00:00.000Z');
  const reloaded = parseUsage(serializeUsage(usage));
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(reloaded.usage, usage);
  // Contenu corrompu : usage vide + erreur nommee, aucune exception.
  const corrupted = parseUsage('{ not json');
  assert.equal(Object.keys(corrupted.usage.records).length, 0);
  assert.ok(corrupted.errors.some((error) => /InvalidJson/.test(error)));
});

check('10. usage : stockage memoire (load/save)', async () => {
  const storage = createMemoryUsageStorage();
  await saveUsage(storage, markUsed(createEmptyUsage(), MULTISIG_B, undefined, '2026-10-09T12:00:00.000Z'));
  const reloaded = await loadUsage(storage);
  assert.deepEqual(reloaded.errors, []);
  assert.equal(reloaded.usage.records[MULTISIG_B]?.lastUsedAt, '2026-10-09T12:00:00.000Z');
});

// --- En-tete Vault -----------------------------------------------------------

check('11. enveloppe absente de l en-tete Vault', () => {
  assert.ok(!CONNECT.includes('mail-outline'), 'l icone enveloppe est retiree');
  assert.ok(CONNECT.includes('chevron-down'), 'un chevron indique l ouverture');
  assert.ok(CONNECT.includes('headerSelector'), 'le selecteur est dans l en-tete');
});

check('12. en-tete : nom du vault actif, ou « Select a multisig »', () => {
  assert.equal(
    describeVaultHeader({ hasView: false, activeName: null }).label,
    'Select a multisig',
  );
  assert.equal(describeVaultHeader({ hasView: true, activeName: 'Team' }).label, 'Team');
  assert.equal(describeVaultHeader({ hasView: true, activeName: null }).label, 'Main vault');
  assert.ok(CONNECT.includes('describeVaultHeader('), 'en-tete pilote par le helper pur');
});

check('13. aucune adresse de wallet dans l en-tete Vault', () => {
  assert.ok(!CONNECT.includes('styles.headerWallet'), 'le conteneur wallet de l en-tete a disparu');
  assert.ok(!CONNECT.includes('styles.headerWalletAddress'), 'le style d adresse a disparu');
  // La copie de l'adresse du wallet reste, elle, dans l'onglet Account (etape 2).
  assert.ok(CONNECT.includes('styles.accountWalletAddress'), 'Account conserve son adresse');
});

// --- Selecteur (feuille) -----------------------------------------------------

check('14. le selecteur marque le vault actif', () => {
  assert.ok(SHEET.includes('My multisigs'), 'titre de la feuille');
  assert.ok(SHEET.includes('accessibilityState={{ selected: active }}'), 'etat selectionne annonce');
  assert.ok(SHEET.includes('name="checkmark"'), 'coche sur le vault actif');
  assert.ok(SHEET.includes('const active = entry.address === activeAddress;'), 'comparaison a l actif');
  assert.ok(SHEET.includes('accessibilityLabel="Create a vault"'), 'action Create a vault');
  assert.ok(SHEET.includes('accessibilityLabel="Add existing multisig"'), 'action Add existing multisig');
});

check('15. selectionner charge le vault et ferme la feuille', () => {
  assert.ok(
    SHEET.includes('onSelect(entry.address)') && SHEET.includes('setMenuFor(null)'),
    'la ligne selectionne le vault et referme le menu',
  );
  assert.ok(CONNECT.includes('selectCloseRef.current = true'), 'selection -> fermeture demandee');
  assert.ok(CONNECT.includes('<VaultPickerSheet'), 'feuille montee');
  // La feuille se ferme DANS l'effet de chargement reussi, juste apres markUsed.
  const successEffect = CONNECT.slice(
    CONNECT.indexOf("if (msig.status !== 'loaded' || view === null) return;"),
    CONNECT.indexOf('}, [msig.status, registry.entries, view, usage]);'),
  );
  assert.ok(successEffect.includes('setVaultPickerOpen(false)'), 'fermeture au succes');
  assert.ok(successEffect.includes('usage.markUsed('), 'recence au succes');
});

check('16. aucune recence sans reseau ni appel ajoute', () => {
  assert.ok(!/useMobileWallet|signTransaction|signAndSendTransactions/.test(SHEET), 'feuille sans wallet');
  assert.ok(!/connection\.|getBalance|getAccountInfo/.test(SHEET), 'feuille sans RPC');
  assert.ok(!/getProgramAccounts/.test(CONNECT), 'aucun scan de programme ajoute');
  assert.equal(CONNECT.split('msig.load(').length - 1, 1, 'un seul chemin de chargement');
  // Le registre local n'est pas modifie : la recence vit dans un stockage dedie.
  assert.ok(REGISTRY_HOOK.includes('useMultisigRegistry'), 'hook registre inchange');
});

check('17. « Go to Inbox » renomme / absent', () => {
  assert.ok(!CONNECT.includes('Go to Inbox'), 'plus de « Go to Inbox » dans l ecran');
});

check('18. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/vault-selector.test.ts'), 'suite du selecteur dans le runner');
});

// --- Feuille « My multisigs » : action « Add existing multisig » -------------

check('19. la feuille cable REELLEMENT ses deux actions de pied', () => {
  // Le bouton « Add existing multisig » porte un handler : jamais `undefined`.
  assert.ok(SHEET.includes('onAddExisting: () => void;'), 'prop onAddExisting typee');
  assert.ok(SHEET.includes('onPress={onAddExisting}'), 'Add existing multisig -> onAddExisting');
  assert.ok(!SHEET.includes('onAddExisting={undefined'), 'aucun handler undefined');
  // « Create a vault » idem.
  assert.ok(SHEET.includes('onCreate: () => void;'), 'prop onCreate typee');
  assert.ok(SHEET.includes('onPress={onCreate}'), 'Create a vault -> onCreate');
  assert.ok(!SHEET.includes('onCreate={undefined'), 'aucun handler undefined');
});

check('20. l ecran transmet les deux callbacks de la feuille (aucune prop orpheline)', () => {
  assert.ok(CONNECT.includes('onAddExisting={onAddExistingFromPicker}'), 'Add existing branche');
  assert.ok(CONNECT.includes('onCreate={onCreateVaultFromPicker}'), 'Create branche');
  // Chaque prop de la feuille est fournie : aucune prop non transmise.
  assert.ok(CONNECT.includes('onClose={onCloseVaultPicker}'), 'onClose branche');
  assert.ok(CONNECT.includes('onSelect={onSelectVault}'), 'onSelect branche');
});

check('21. « Add existing multisig » (feuille) ferme la feuille et amene au champ', () => {
  const start = CONNECT.indexOf('const onAddExistingFromPicker = useCallback');
  assert.ok(start >= 0, 'handler present');
  const end = CONNECT.indexOf('}, []);', start);
  assert.ok(end > start, 'handler borne');
  const handler = CONNECT.slice(start, end);
  // Ferme la feuille...
  assert.ok(handler.includes('setVaultPickerOpen(false)'), 'la feuille se ferme');
  // ...et arme l'amenee au champ (bloc permanent, plus rien a deplier).
  assert.ok(handler.includes('setFocusMultisigToken('), 'demande d amenee au champ armee');

  // L'effet d'amenee defile et active le champ « Multisig address ».
  const effectStart = CONNECT.indexOf('if (focusMultisigToken === 0) return;');
  assert.ok(effectStart >= 0, 'effet d amenee present');
  const effectEnd = CONNECT.indexOf('}, [focusMultisigToken]);', effectStart);
  assert.ok(effectEnd > effectStart, 'effet borne');
  const effect = CONNECT.slice(effectStart, effectEnd);
  assert.ok(effect.includes('multisigInputRef.current?.focus()'), 'le champ est active');
  assert.ok(effect.includes('scrollTo('), 'l ecran defile vers le bloc');
  // Le champ cible est bien celui du bloc « Multisig address ».
  assert.ok(
    CONNECT.includes('inputRef={multisigInputRef}') && CONNECT.includes('label="Multisig address"'),
    'la ref pointe le champ Multisig address',
  );
});

check('22. « Create a vault » (feuille) ouvre la creation, feuille fermee', () => {
  const start = CONNECT.indexOf('const onCreateVaultFromPicker = useCallback');
  const end = CONNECT.indexOf('}, []);', start);
  assert.ok(start >= 0 && end > start, 'handler borne');
  const handler = CONNECT.slice(start, end);
  assert.ok(handler.includes('setVaultPickerOpen(false)'), 'la feuille se ferme');
  assert.ok(handler.includes('setVaultCreationOpen(true)'), 'la creation s ouvre');
});

check('23. le bloc d adresse est replie par defaut (option A), plus de repli « More »', () => {
  // Sans vault charge, la carte d'etat vide revele encore le bloc via addMultisigOpen.
  assert.ok(
    CONNECT.includes('{addMultisigOpen || choosingVault ? multisigLoaderBlock : null}'),
    'etat vide : bloc reveal par addMultisigOpen OU le chemin de choix',
  );
  // ADAPTATION (option A) : avec un vault charge, le bloc « Multisig address »
  // est REPLIE par defaut et n'est monte que si `addMultisigOpen` est vrai.
  assert.ok(
    /view === null \? null : \([\s\S]*?\{addMultisigOpen \? multisigLoaderBlock : null\}/.test(CONNECT),
    'bloc replie par defaut quand un vault est charge',
  );
  assert.ok(!CONNECT.includes('{multisigLoaderBlock}'), 'plus de rendu inconditionnel (permanent)');
  assert.ok(!CONNECT.includes('moreOpen'), 'repli « More » supprime');
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
