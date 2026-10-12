import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeEntry, type MultisigRegistryEntry } from '../src/vault/multisigRegistry';
import {
  activeEntries,
  ARCHIVE_CONFIRMATION_COPY,
  archivedEntries,
  archivedSectionLabel,
  archiveRecordFor,
  createEmptyArchive,
  createEmptyUsage,
  createMemoryArchiveStorage,
  describeVaultBody,
  forgetArchived,
  isArchived,
  loadArchive,
  markArchived,
  markRestored,
  markUsed,
  matchesArchivedEntry,
  mostRecentlyUsedActiveAddress,
  nextActiveAfterArchiving,
  parseArchive,
  pendingProposalWarning,
  REMOVE_CONFIRMATION_COPY,
  RESTORE_ARCHIVED_PROMPT,
  saveArchive,
  serializeArchive,
  shouldAutoLoad,
  VAULT_ARCHIVE_STORAGE_KEY,
  VAULT_ARCHIVE_VERSION,
} from '../src/vault/vaultNavigation';

/**
 * Tests FOCALISES de l'etape 3 : ARCHIVAGE LOCAL des vaults.
 *
 * Tests PURS : modules partages + lecture des sources. Aucun RPC, aucun wallet,
 * aucune transaction, aucune signature, aucun stockage natif (le backend
 * memoire est utilise). Execution : npx tsx scripts/vault-archive.test.ts
 */

const MULTISIG_A = '11111111111111111111111111111111';
const MULTISIG_B = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG_C = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const SHEET = readFileSync('src/ui/v2/VaultPickerSheet.tsx', 'utf8');
const TABBAR = readFileSync('src/ui/v2/TabBar.tsx', 'utf8');
const NAVIGATION_SRC = readFileSync('src/vault/vaultNavigation.ts', 'utf8');
const ARCHIVE_HOOK = readFileSync('src/vault/useVaultArchive.ts', 'utf8');
const ARCHIVE_STORAGE = readFileSync('src/vault/deviceVaultArchiveStorage.ts', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

const T1 = '2026-10-09T10:00:00.000Z';
const T2 = '2026-10-09T11:00:00.000Z';
const T3 = '2026-10-09T12:00:00.000Z';

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

// ===========================================================================
// DONNEES / MIGRATION
// ===========================================================================

check('1. migration : toute entree existante est vue comme NON archivee', () => {
  // Aucun enregistrement d'archivage n'existe encore (migration) : la lecture
  // par defaut vaut « non archive », sans reecriture d'aucune donnee.
  const archive = createEmptyArchive();
  assert.equal(archive.version, VAULT_ARCHIVE_VERSION);
  assert.deepEqual(archive.records, {});
  assert.equal(isArchived(archive, MULTISIG_A), false);
  assert.deepEqual(archiveRecordFor(archive, MULTISIG_A), { archived: false, archivedAt: null });
  // Les entrees deja presentes (ajoutees avant l'archivage) restent ACTIVES.
  const entries = [entryFor(MULTISIG_A, T1), entryFor(MULTISIG_B, T2)];
  assert.deepEqual(
    activeEntries(entries, archive).map((entry) => entry.address),
    [MULTISIG_A, MULTISIG_B],
  );
  assert.deepEqual(archivedEntries(entries, archive), []);
  // L'archivage vit dans une cle DEDIEE : le registre n'est jamais reecrit.
  assert.equal(VAULT_ARCHIVE_STORAGE_KEY, 'pocket-multisig.vault-archive.v1');
  assert.ok(!NAVIGATION_SRC.includes('multisigRegistry.ts'), 'le modele archive n importe pas le registre');
});

check('2. persistance : l etat archive survit au rechargement du stockage', async () => {
  const storage = createMemoryArchiveStorage();
  await saveArchive(storage, markArchived(createEmptyArchive(), MULTISIG_A, T1));
  // Relance : un NOUVEAU stockage amorce avec ce qui a ete persiste.
  const raw = await storage.load();
  const relaunch = createMemoryArchiveStorage(raw);
  const reloaded = await loadArchive(relaunch);
  assert.deepEqual(reloaded.errors, []);
  assert.equal(isArchived(reloaded.archive, MULTISIG_A), true);
  assert.equal(reloaded.archive.records[MULTISIG_A]?.archivedAt, T1);
  // Round-trip direct du contenu.
  assert.deepEqual(parseArchive(serializeArchive(reloaded.archive)).archive, reloaded.archive);
});

check('3. archivage : marque l adresse, preserve les autres enregistrements', () => {
  const base = markArchived(createEmptyArchive(), MULTISIG_A, T1);
  const both = markArchived(base, MULTISIG_B, T2);
  assert.equal(isArchived(both, MULTISIG_A), true);
  assert.equal(isArchived(both, MULTISIG_B), true);
  assert.equal(both.records[MULTISIG_A]?.archivedAt, T1);
  assert.equal(both.records[MULTISIG_B]?.archivedAt, T2);
  // Aucune autre cle n'est perdue.
  assert.equal(Object.keys(both.records).length, 2);
});

check('4. restauration : repasse en actif sans perdre les autres archives', () => {
  const both = markArchived(markArchived(createEmptyArchive(), MULTISIG_A, T1), MULTISIG_B, T2);
  const restored = markRestored(both, MULTISIG_A);
  assert.equal(isArchived(restored, MULTISIG_A), false);
  assert.equal(restored.records[MULTISIG_A]?.archivedAt, null);
  assert.equal(isArchived(restored, MULTISIG_B), true, 'les autres enregistrements sont intacts');
  // Restore REUTILISE l'entree locale existante : aucune nouvelle cle creee.
  assert.deepEqual(Object.keys(restored.records).sort(), [MULTISIG_A, MULTISIG_B].sort());
});

check('5. retrait de l appareil : oublie l etat d archivage (forget)', () => {
  const both = markArchived(markArchived(createEmptyArchive(), MULTISIG_A, T1), MULTISIG_B, T2);
  const forgotten = forgetArchived(both, MULTISIG_A);
  assert.equal(MULTISIG_A in forgotten.records, false);
  assert.equal(isArchived(forgotten, MULTISIG_A), false);
  assert.equal(isArchived(forgotten, MULTISIG_B), true, 'les autres enregistrements restent');
});

check('6. contenu corrompu : archive vide + erreur nommee, jamais d exception', () => {
  const corrupted = parseArchive('{ not json');
  assert.equal(Object.keys(corrupted.archive.records).length, 0);
  assert.ok(corrupted.errors.some((error) => /InvalidJson/.test(error)));
  // Une entree dont `archived` n'est pas un booleen est ecartee.
  const partial = parseArchive(JSON.stringify({ version: 1, records: { [MULTISIG_A]: { archived: 'yes' } } }));
  assert.equal(MULTISIG_A in partial.archive.records, false);
  // Version inconnue : signalee, mais aucune exception.
  const wrongVersion = parseArchive(JSON.stringify({ version: 99, records: {} }));
  assert.ok(wrongVersion.errors.some((error) => /UnsupportedArchiveVersion/.test(error)));
});

// ===========================================================================
// ARCHIVAGE / RESTAURATION / LISTES
// ===========================================================================

check('7. archives EXCLUES de la liste principale et de l auto-chargement', () => {
  const entries = [entryFor(MULTISIG_A, T1), entryFor(MULTISIG_B, T2), entryFor(MULTISIG_C, T3)];
  const archive = markArchived(createEmptyArchive(), MULTISIG_B, T1);
  assert.deepEqual(
    activeEntries(entries, archive).map((entry) => entry.address),
    [MULTISIG_A, MULTISIG_C],
  );
  // L'auto-chargement ne compte QUE les actifs.
  const base = {
    registryStatus: 'ready' as const,
    usageStatus: 'ready' as const,
    hasView: false,
    attempted: false,
    loading: false,
  };
  assert.equal(shouldAutoLoad({ ...base, savedCount: activeEntries(entries, archive).length }), true);
  assert.equal(shouldAutoLoad({ ...base, savedCount: 0 }), false);
  // L'ecran calcule le compte ACTIF avant de decider d'auto-charger.
  assert.ok(CONNECT.includes('const active = activeEntries(registry.entries, archive.archive);'));
  assert.ok(CONNECT.includes('savedCount: active.length'));
  assert.ok(CONNECT.includes("if (archive.status !== 'ready') return;"));
  assert.ok(
    CONNECT.includes('mostRecentlyUsedActiveAddress(registry.entries, usage.usage, archive.archive)'),
    'la cible d auto-chargement exclut les archives',
  );
});

check('8. archiver le vault actif bascule vers le plus recent NON archive (lastUsedAt)', () => {
  const entries = [entryFor(MULTISIG_A, '2026-09-01T10:00:00.000Z'), entryFor(MULTISIG_B, '2026-09-02T10:00:00.000Z'), entryFor(MULTISIG_C, '2026-09-03T10:00:00.000Z')];
  // Usage : A plus recent, puis B, puis C.
  let usage = createEmptyUsage();
  usage = markUsed(usage, MULTISIG_A, undefined, T3);
  usage = markUsed(usage, MULTISIG_B, undefined, T2);
  usage = markUsed(usage, MULTISIG_C, undefined, T1);
  // Sans archive : le plus recent actif est A.
  assert.equal(mostRecentlyUsedActiveAddress(entries, usage, createEmptyArchive()), MULTISIG_A);
  // On archive A : bascule vers B (le plus recent des restants).
  assert.equal(nextActiveAfterArchiving(entries, usage, createEmptyArchive(), MULTISIG_A), MULTISIG_B);
  // Si C etait deja archive, A archive bascule quand meme vers B (jamais C).
  const withCArchived = markArchived(createEmptyArchive(), MULTISIG_C, T1);
  assert.equal(nextActiveAfterArchiving(entries, usage, withCArchived, MULTISIG_A), MULTISIG_B);
  assert.notEqual(nextActiveAfterArchiving(entries, usage, withCArchived, MULTISIG_A), MULTISIG_C);
});

check('9. archiver le DERNIER actif produit l etat vide « No active multisig »', () => {
  const entries = [entryFor(MULTISIG_A, T1)];
  const archive = markArchived(createEmptyArchive(), MULTISIG_A, T1);
  assert.equal(nextActiveAfterArchiving(entries, createEmptyUsage(), archive, MULTISIG_A), null);
  assert.equal(describeVaultBody({ registryStatus: 'ready', savedCount: 1, archivedCount: 1, hasView: false, loadFailed: false }), 'no-active');
  // Sans aucune sauvegarde : l'autre etat vide, jamais confondu.
  assert.equal(describeVaultBody({ registryStatus: 'ready', savedCount: 0, archivedCount: 0, hasView: false, loadFailed: false }), 'no-saved');
  assert.ok(CONNECT.includes('archivedCount,'));
  assert.ok(CONNECT.includes('const archivedCount = archivedOrderedEntries.length;'));
});

// ===========================================================================
// UI ARCHIVEE
// ===========================================================================

check('10. section « Archived (N) » absente a N=0, presente avec le bon compte', () => {
  assert.equal(archivedSectionLabel(0), null);
  assert.equal(archivedSectionLabel(-3), null);
  assert.equal(archivedSectionLabel(1), 'Archived (1)');
  assert.equal(archivedSectionLabel(2), 'Archived (2)');
  // Rendue SEULEMENT quand le libelle n'est pas null, dans le selecteur...
  assert.ok(SHEET.includes('archivedLabel !== null'));
  // ...et dans Account.
  assert.ok(CONNECT.includes('archivedSectionLabel(archivedCount) !== null'));
  // Le compte affiche vient du MEME ordonnancement que la section Account.
  assert.ok(CONNECT.includes('archivedOrderedEntries.map('));
  assert.ok(CONNECT.includes('orderArchivedEntries(registry.entries, usage.usage, archive.archive)'));
});

check('11. « Remove from this device » disponible UNIQUEMENT pour les archives', () => {
  // Dans le selecteur : les lignes ACTIVES n'exposent aucun retrait...
  const activeBlock = SHEET.slice(SHEET.indexOf('{entries.map('), SHEET.indexOf('archivedLabel !== null'));
  assert.ok(!activeBlock.includes('onRemove'), 'aucun retrait sur une entree active');
  // ...et les lignes ARCHIVEES l'exposent (une seule action de retrait dans le bloc).
  const archivedBlock = SHEET.slice(SHEET.indexOf('archivedEntries.map('));
  assert.ok(archivedBlock.includes('onRemove(entry.address)'));
  assert.equal(archivedBlock.split('onRemove(entry.address)').length - 1, 1);
  // Le prop est bien cable depuis l'ecran.
  assert.ok(CONNECT.includes('onRemove={onRequestRemove}'));
});

check('12. copie de confirmation du RETRAIT exacte', () => {
  assert.equal(
    REMOVE_CONFIRMATION_COPY,
    'Removes this vault from this device only. You can add it again with its address.',
  );
  assert.ok(CONNECT.includes('REMOVE_CONFIRMATION_COPY'), 'la copie exacte est utilisee par l ecran');
});

check('13. copie de confirmation de l ARCHIVAGE exacte (local uniquement)', () => {
  assert.equal(
    ARCHIVE_CONFIRMATION_COPY,
    'Hidden from this device only. The vault and its funds are not affected. You can restore it anytime.',
  );
  assert.ok(CONNECT.includes('ARCHIVE_CONFIRMATION_COPY'));
  // Archiver reste possible quelle que soit la disponibilite reseau/propositions :
  // le handler d'archivage ne consulte jamais l'etat des propositions.
  const archiveHandler = CONNECT.slice(
    CONNECT.indexOf('const onConfirmArchive = useCallback'),
    CONNECT.indexOf('}, [archive, archiveConfirmAddress'),
  );
  assert.ok(archiveHandler.includes('archive.markArchived('));
  assert.ok(!/proposals|connection\.|fetch\(|await load/.test(archiveHandler), 'archivage independant du reseau/propositions');
});

// ===========================================================================
// CONFIRMATION / PROPOSITIONS
// ===========================================================================

check('14. avertissement pending-proposal : singulier/pluriel, jamais sans donnee verifiee', () => {
  assert.equal(pendingProposalWarning(0), null);
  assert.equal(pendingProposalWarning(-2), null);
  assert.equal(pendingProposalWarning(1), 'This vault has 1 proposal waiting for your approval.');
  assert.equal(pendingProposalWarning(2), 'This vault has 2 proposals waiting for your approval.');
  assert.equal(pendingProposalWarning(5), 'This vault has 5 proposals waiting for your approval.');
  // L'ecran n'ajoute l'avertissement QUE pour le vault actif, a partir de la
  // source VERIFIEE deja lue (`proposals`, deja chargee pour le vault actif).
  assert.ok(CONNECT.includes('archiveConfirmAddress === viewAddress'));
  assert.ok(CONNECT.includes("proposals.status === 'loaded'"));
  assert.ok(CONNECT.includes('pendingProposalWarning(homeNeedsVote)'));
});

check('15. aucune lecture reseau pour l avertissement (jamais de requete ajoutee)', () => {
  const warningStart = CONNECT.indexOf('const archiveProposalWarning =');
  const warningEnd = CONNECT.indexOf(';', CONNECT.indexOf('pendingProposalWarning(homeNeedsVote)'));
  const warningBlock = CONNECT.slice(warningStart, warningEnd);
  assert.ok(warningBlock.length > 0);
  assert.ok(
    !/connection\.|loadProposalReview|getProgramAccounts|fetch\(|\bawait\b/.test(warningBlock),
    'le calcul de l avertissement ne declenche aucune lecture',
  );
  // Un seul chemin de chargement de multisig dans tout l'ecran.
  assert.equal(CONNECT.split('msig.load(').length - 1, 1, 'aucune lecture ajoutee');
});

check('16. une panne reseau/donnee ne bloque jamais l archivage', async () => {
  // Le stockage peut echouer : la lecture ne leve pas, elle renvoie un repli.
  const failing = {
    load: async () => {
      throw new Error('offline');
    },
    save: async () => {
      throw new Error('offline');
    },
  };
  const read = await loadArchive(failing);
  assert.deepEqual(read.archive, createEmptyArchive());
  assert.ok(read.errors.some((error) => /StorageReadFailed/.test(error)));
  // L'archivage lui-meme est une operation PURE et LOCALE : aucun reseau.
  const archived = markArchived(createEmptyArchive(), MULTISIG_A, T1);
  assert.equal(isArchived(archived, MULTISIG_A), true);
  // Le modele d'archivage ne contient aucun acces reseau ni signature.
  assert.ok(
    !/connection\.|getProgramAccounts|getAccountInfo|signTransaction|signAndSendTransactions|PublicKey/.test(NAVIGATION_SRC),
    'le modele archive est purement local',
  );
  assert.ok(
    !/proposals|connection\.|getProgramAccounts|fetch\(|PublicKey|signTransaction/.test(ARCHIVE_HOOK),
    'le hook d archivage ne touche ni aux propositions ni au reseau',
  );
});

// ===========================================================================
// BADGE PROPOSALS
// ===========================================================================

check('17. badge Proposals scope au vault ACTIF uniquement', () => {
  // Le badge recoit le compte du wallet pour le vault ACTIF (source verifiee).
  assert.ok(CONNECT.includes('badgeCount={homeNeedsVote}'));
  const voteStart = CONNECT.indexOf('const homeNeedsVote =');
  const voteEnd = CONNECT.indexOf('const homeReadyToExecute =');
  const voteBlock = CONNECT.slice(voteStart, voteEnd);
  assert.ok(voteBlock.includes("proposal.status === 'Active'"));
  assert.ok(voteBlock.includes("homeWalletRoles.includes('Vote')"));
  assert.ok(voteBlock.includes('!proposal.approvedAddresses.includes('));
  // Ce bloc ne scanne AUCUN vault stocke ni le reseau.
  assert.ok(
    !/connection\.|getProgramAccounts|registry\.entries|archivedEntries|archivedOrderedEntries/.test(voteBlock),
    'badge : ni scan de vaults ni lecture reseau',
  );
  // La barre est purement presentationnelle : elle ne lit rien.
  assert.ok(TABBAR.includes('badgeCount = 0'));
  assert.ok(!/connection\.|getProgramAccounts|useProposals|fetch\(|useMultisigRegistry/.test(TABBAR));
});

check('18. aucune recuperation de propositions multi-vault introduite', () => {
  assert.ok(!/getProgramAccounts/.test(CONNECT), 'aucun scan de programme');
  assert.ok(!/getProgramAccounts/.test(SHEET), 'feuille sans scan de programme');
  // La feuille et le modele archive ne fetchent rien.
  assert.ok(!/connection\.|fetch\(/.test(SHEET));
  assert.ok(!/fetch\(/.test(NAVIGATION_SRC));
  // Un seul hook de propositions, alimente par le vault actif (msig).
  assert.equal(CONNECT.split('useProposals(').length - 1, 1, 'un seul hook de propositions');
  // L'archivage ne modifie pas l'etat on-chain : aucun sign/execute ajoute.
  assert.ok(!/signAndSendTransactions|signTransaction/.test(NAVIGATION_SRC));
});

// ===========================================================================
// COHERENCE ACCOUNT <-> SELECTEUR
// ===========================================================================

check('19. Account et selecteur partagent la MEME source d archivage', () => {
  // Une seule lecture de l'archivage, une seule liste active, une seule archivee.
  assert.equal(CONNECT.split('useVaultArchive()').length - 1, 1, 'une seule lecture de l archivage');
  assert.equal(CONNECT.split('const orderedEntries = useMemo(').length - 1, 1);
  assert.equal(CONNECT.split('const archivedOrderedEntries = useMemo(').length - 1, 1);
  // Le selecteur ET Account consomment ces valeurs.
  assert.ok(CONNECT.includes('entries={orderedEntries}'));
  assert.ok(CONNECT.includes('archivedEntries={archivedOrderedEntries}'));
  assert.equal(CONNECT.split('orderedEntries.map(').length - 1, 1, 'Account itere la meme liste active');
  assert.ok(CONNECT.includes('archivedOrderedEntries.map('), 'Account itere la meme liste archivee');
});

check('20. archive/restore/remove reflechis a l identique dans les deux vues', () => {
  // Les MEMES handlers alimentent le selecteur (props) et Account (appels).
  assert.ok(CONNECT.includes('onArchive={onRequestArchive}'));
  assert.ok(CONNECT.includes('onRestore={onRestoreVault}'));
  assert.ok(CONNECT.includes('onRemove={onRequestRemove}'));
  assert.ok(CONNECT.includes('onRename={onRequestRename}'));
  assert.ok(CONNECT.includes('onRequestArchive(entry.address)'));
  assert.ok(CONNECT.includes('onRestoreVault(entry.address)'));
  assert.ok(CONNECT.includes('onRequestRemove(entry.address)'));
  // Un seul dialogue par action, rendu une seule fois (donc partage).
  assert.equal(CONNECT.split('visible={archiveConfirmAddress !== null}').length - 1, 1);
  assert.equal(CONNECT.split('visible={removeConfirmAddress !== null}').length - 1, 1);
  assert.equal(CONNECT.split('visible={restorePromptAddress !== null}').length - 1, 1);
});

// ===========================================================================
// ADRESSE EN DOUBLE
// ===========================================================================

check('21. ajouter une adresse deja archivee : pas de doublon, Restore / Cancel', () => {
  assert.equal(RESTORE_ARCHIVED_PROMPT, 'This vault is archived. Restore it?');
  const entries = [entryFor(MULTISIG_A, T1)];
  const archive = markArchived(createEmptyArchive(), MULTISIG_A, T1);
  assert.equal(matchesArchivedEntry(entries, archive, MULTISIG_A), true);
  assert.equal(matchesArchivedEntry(entries, archive, MULTISIG_B), false, 'adresse inconnue : aucun doublon propose');
  assert.equal(matchesArchivedEntry([], archive, MULTISIG_A), false);
  // L'ecran intercepte le chargement manuel d'une adresse archivee...
  assert.ok(CONNECT.includes('matchesArchivedEntry(registry.entries, archive.archive, multisigInput)'));
  assert.ok(CONNECT.includes('setRestorePromptAddress(multisigInput.trim())'));
  // ...et Restore REUTILISE l'entree locale existante (markRestored, pas d'ajout).
  assert.ok(CONNECT.includes('await archive.markRestored(address);'));
  // Le dialogue propose Restore / Cancel.
  assert.ok(CONNECT.includes('RESTORE_ARCHIVED_PROMPT'));
});

check('22. le stockage d archivage n est PAS le registre (aucune donnee reecrite)', () => {
  // Une seule cle dediee, un seul fichier de couche appareil.
  assert.equal(VAULT_ARCHIVE_STORAGE_KEY, 'pocket-multisig.vault-archive.v1');
  assert.ok(ARCHIVE_STORAGE.includes('VAULT_ARCHIVE_STORAGE_KEY'));
  assert.ok(!ARCHIVE_STORAGE.includes('multisigRegistry'), 'la couche appareil ne touche pas au registre');
  // Le module pur n'importe le registre QU'EN TYPE (aucun couplage d'execution,
  // donc aucune reecriture possible des entrees stockees).
  assert.ok(NAVIGATION_SRC.includes('import type { MultisigRegistryEntry }'), 'import de type uniquement');
});

check('23. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/vault-archive.test.ts'), 'suite d archivage dans le runner');
});

console.log(`\n${passed} test(s) OK`);
if (process.exitCode === 1) process.exit(1);
