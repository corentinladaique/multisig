import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createEmptyRegistry,
  listEntries,
  makeEntry,
  parseRegistry,
  removeEntry,
  serializeRegistry,
  upsertEntry,
  type MultisigRegistryEntry,
} from '../src/vault/multisigRegistry';
import {
  createMemoryRegistryStorage,
  loadRegistry,
  saveRegistry,
} from '../src/vault/multisigRegistryStorage';
import {
  createEmptyArchive,
  createEmptyUsage,
  markArchived,
  markUsed,
  mostRecentlyUsedActiveAddress,
  mostRecentlyUsedAddress,
  shouldAutoLoad,
  sortEntriesByLastUsed,
} from '../src/vault/vaultNavigation';

/**
 * Tests FOCALISES du defaut remonte sur appareil (Seeker) :
 *
 * (1) un multisig AJOUTE (« Add existing multisig ») n'etait pas PERSISTE
 *     localement : absent de la liste apres relance ;
 * (2) un multisig ajoute ne devenait PAS le DERNIER UTILISE (donc pas
 *     auto-charge a l'ouverture suivante).
 *
 * Tests PURS : modeles partages (registre, usage, archivage) + lecture des
 * sources. Aucun RPC, aucun wallet, aucune signature, aucune transaction,
 * aucun stockage natif (le backend memoire est utilise).
 * Execution : npx tsx scripts/vault-add-persist.test.ts
 */

const MULTISIG_A = '11111111111111111111111111111111';
const MULTISIG_B = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG_C = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const REGISTRY_STORAGE = readFileSync('src/vault/multisigRegistryStorage.ts', 'utf8');
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

/** Entree « ajoutee a la main » : le nom local est vide (aucune saisie). */
function manualEntry(address: string, addedAt: string, vaultName = ''): MultisigRegistryEntry {
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

/**
 * Reproduit EXACTEMENT l'effet de l'ecran apres un chargement REUSSI : si
 * l'adresse chargee est INCONNUE du registre, on l'ajoute (upsert), puis on
 * marque l'usage. Renvoie l'etat local resultant.
 */
function applySuccessfulLoad(input: {
  registry: ReturnType<typeof createEmptyRegistry>;
  usage: ReturnType<typeof createEmptyUsage>;
  address: string;
  now: string;
  stats?: { threshold?: number | null; memberCount?: number | null };
}): {
  registry: ReturnType<typeof createEmptyRegistry>;
  usage: ReturnType<typeof createEmptyUsage>;
} {
  let registry = input.registry;
  if (!registry.entries.some((entry) => entry.address === input.address)) {
    registry = upsertEntry(registry, manualEntry(input.address, input.now));
  }
  const usage = markUsed(input.usage, input.address, input.stats, input.now);
  return { registry, usage };
}

// ===========================================================================
// (1) PERSISTANCE D'UN MULTISIG AJOUTE
// ===========================================================================

check('1. ajout d un vault INCONNU : il est bien ajoute a la liste locale', () => {
  const base = createEmptyRegistry();
  assert.equal(listEntries(base).length, 0, 'registre vide au depart');
  const next = upsertEntry(base, manualEntry(MULTISIG_A, T1));
  assert.deepEqual(
    listEntries(next).map((entry) => entry.address),
    [MULTISIG_A],
  );
  assert.equal(next.entries[0]?.source, 'manual');
  // Une adresse = une entree : un second ajout de la meme adresse ne duplique pas.
  const again = upsertEntry(next, manualEntry(MULTISIG_A, T2, 'Renamed'));
  assert.equal(again.entries.length, 1);
  assert.equal(again.entries[0]?.vaultName, 'Renamed');
});

check('2. persistance : l ajout survit a une RELANCE (round-trip du stockage)', async () => {
  const storage = createMemoryRegistryStorage();
  const added = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  await saveRegistry(storage, added);

  // Relance : un NOUVEAU stockage amorce avec ce qui a ete persiste.
  const raw = await storage.load();
  const relaunch = createMemoryRegistryStorage(raw);
  const reloaded = await loadRegistry(relaunch);
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(
    listEntries(reloaded.registry).map((entry) => entry.address),
    [MULTISIG_A],
    'le multisig ajoute est present apres relance',
  );
  // Round-trip direct : le contenu ne contient aucun secret.
  assert.deepEqual(parseRegistry(serializeRegistry(added)).registry, added);
});

check('3. ajout depuis un etat VIDE (aucun vault) fonctionne', async () => {
  const storage = createMemoryRegistryStorage(); // aucune sauvegarde prealable
  const before = await loadRegistry(storage);
  assert.deepEqual(before.registry.entries, [], 'aucun vault au depart');
  const after = upsertEntry(before.registry, manualEntry(MULTISIG_B, T1));
  await saveRegistry(storage, after);
  const reread = await loadRegistry(createMemoryRegistryStorage(await storage.load()));
  assert.deepEqual(
    listEntries(reread.registry).map((entry) => entry.address),
    [MULTISIG_B],
  );
});

check('4. ajout apres qu un vault a ete RETIRE / archive fonctionne', async () => {
  const storage = createMemoryRegistryStorage();
  // Etat initial : A present, puis on le RETIRE de l'appareil.
  let registry = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  await saveRegistry(storage, registry);
  registry = removeEntry(registry, MULTISIG_A);
  await saveRegistry(storage, registry);
  assert.deepEqual(registry.entries, [], 'le vault retire a bien disparu');

  // L'ajout SUIVANT (B) depuis cet etat doit se persister normalement.
  registry = upsertEntry(registry, manualEntry(MULTISIG_B, T2));
  await saveRegistry(storage, registry);
  const reloaded = await loadRegistry(createMemoryRegistryStorage(await storage.load()));
  assert.deepEqual(
    listEntries(reloaded.registry).map((entry) => entry.address),
    [MULTISIG_B],
    'l ajout apres retrait est bien sauvegarde',
  );

  // Variante « archive » : une entree archivee ne bloque pas un ajout inconnu.
  const archived = markArchived(createEmptyArchive(), MULTISIG_A, T1);
  const withArchived = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  const addedWhileAArchived = upsertEntry(withArchived, manualEntry(MULTISIG_C, T3));
  assert.deepEqual(
    listEntries(addedWhileAArchived).map((entry) => entry.address).sort(),
    [MULTISIG_A, MULTISIG_C].sort(),
  );
  assert.equal(archived.records[MULTISIG_A]?.archived, true);
});

// ===========================================================================
// (2) LE MULTISIG AJOUTE DEVIENT LE DERNIER UTILISE
// ===========================================================================

check('5. le vault ajoute devient le DERNIER UTILISE (auto-charge a l ouverture)', () => {
  const address = MULTISIG_C;
  // Etat de depart : un autre vault plus ancien existe.
  const base = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  const { registry, usage } = applySuccessfulLoad({
    registry: base,
    usage: createEmptyUsage(),
    address,
    now: T3,
    stats: { threshold: 2, memberCount: 3 },
  });
  assert.ok(
    registry.entries.some((entry) => entry.address === address),
    'le vault ajoute est persiste',
  );
  assert.equal(mostRecentlyUsedAddress(registry.entries, usage), address, 'dernier utilise');
  // Le seuil lu on-chain est memorise avec la recence (aucune lecture ajoutee).
  assert.equal(usage.records[address]?.threshold, 2);
  assert.equal(usage.records[address]?.memberCount, 3);
  // L'ecran autorise alors l'auto-chargement (au moins une sauvegarde locale).
  assert.equal(
    shouldAutoLoad({
      registryStatus: 'ready',
      usageStatus: 'ready',
      hasView: false,
      attempted: false,
      savedCount: registry.entries.length,
      loading: false,
    }),
    true,
  );
});

check('6. ajout depuis un etat vide : il est immediatement le plus recent', () => {
  const { registry, usage } = applySuccessfulLoad({
    registry: createEmptyRegistry(),
    usage: createEmptyUsage(),
    address: MULTISIG_B,
    now: T2,
  });
  assert.equal(mostRecentlyUsedAddress(registry.entries, usage), MULTISIG_B);
  // Sans usage persiste : le repli deterministe (addedAt) donne AUSSI ce vault
  // quand il est le seul present.
  assert.equal(mostRecentlyUsedAddress(registry.entries, createEmptyUsage()), MULTISIG_B);
  // Le tri par recence place le nouveau vault en tete.
  assert.equal(sortEntriesByLastUsed(registry.entries, usage)[0]?.address, MULTISIG_B);
});

check('7. ajout apres retrait : le nouveau vault prime sur les plus anciens', () => {
  // A (ancien) retire, puis B (nouveau) ajoute et charge.
  let registry = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  registry = removeEntry(registry, MULTISIG_A);
  registry = upsertEntry(registry, manualEntry(MULTISIG_B, T2));
  const usage = markUsed(createEmptyUsage(), MULTISIG_B, undefined, T3);
  assert.equal(mostRecentlyUsedAddress(registry.entries, usage), MULTISIG_B);
  // Cible d'auto-chargement (aucun vault archive ici).
  assert.equal(
    mostRecentlyUsedActiveAddress(registry.entries, usage, createEmptyArchive()),
    MULTISIG_B,
  );
});

// ===========================================================================
// INVARIANT CONSERVE : un echec de chargement n'ecrit JAMAIS la recence
// ===========================================================================

check('8. l ecrivain de recence reste garde sur le chargement REUSSI', () => {
  // Un seul point d'ecriture de la recence dans tout l'ecran.
  assert.equal(CONNECT.split('usage.markUsed(').length - 1, 1, 'un seul usage.markUsed(');
  const effectEnd = CONNECT.indexOf('}, [msig.status, registry.entries, view, usage]);');
  const effect = CONNECT.slice(
    CONNECT.indexOf("if (msig.status !== 'loaded' || view === null) return;"),
    effectEnd,
  );
  assert.ok(effect.length > 0, 'l effet de succes existe');
  assert.ok(effect.includes('usage.markUsed('), 'la recence est ecrite dans cet effet');
  // L'effet commence par les deux gardes de succes : jamais sur erreur/idle.
  assert.ok(
    effect.startsWith("if (msig.status !== 'loaded' || view === null) return;"),
    'gate sur chargement reussi en tete d effet',
  );
  assert.ok(
    !effect.includes("msig.status === 'error'"),
    'aucune ecriture de recence sur un chemin d erreur',
  );
});

check('9. la PERSISTANCE du multisig ajoute est DANS l effet de succes', () => {
  const effectEnd = CONNECT.indexOf('}, [msig.status, registry.entries, view, usage]);');
  const effect = CONNECT.slice(
    CONNECT.indexOf("if (msig.status !== 'loaded' || view === null) return;"),
    effectEnd,
  );
  // L'ecran persiste un multisig charge encore INCONNU (upsert, source manual).
  assert.ok(effect.includes('registry.add('), 'l ajout est persiste dans l effet');
  assert.ok(effect.includes("source: 'manual'"), 'un multisig ajoute est de source manual');
  assert.ok(effect.includes('!registry.entries.some('), 'uniquement si encore inconnu');
  // Le registre N'EST PAS ecrit quand le chargement a echoue : la garde de
  // succes precede l'appel a registry.add dans le meme corps d'effet.
  const guardIdx = effect.indexOf("if (msig.status !== 'loaded' || view === null) return;");
  const addIdx = effect.indexOf('registry.add(');
  assert.ok(guardIdx >= 0 && addIdx > guardIdx, 'registry.add apres la garde de succes');
  // L'ancienne garde qui SUPPRIMAIT l'ajout hors registre a disparu.
  assert.ok(
    !CONNECT.includes(
      'if (!registry.entries.some((entry) => entry.address === view.address)) return;',
    ),
    'l ancienne garde d arret anticipe a ete remplacee par la persistance',
  );
});

check('10. aucune donnee sensible ni reseau dans la persistance', () => {
  // Le registre ne stocke que des donnees publiques : le contenu persiste ne
  // contient jamais de cle privee / seed.
  const registry = upsertEntry(createEmptyRegistry(), manualEntry(MULTISIG_A, T1));
  const persisted = serializeRegistry(registry);
  assert.ok(!/privateKey|secretKey|mnemonic|seed/i.test(persisted), 'aucun secret persiste');
  // La couche de stockage du registre n'accede jamais au reseau.
  assert.ok(
    !/connection\.|getProgramAccounts|getAccountInfo|signTransaction|signAndSendTransactions/.test(
      REGISTRY_STORAGE,
    ),
    'stockage registre purement local',
  );
});

check('11. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/vault-add-persist.test.ts'), 'suite dans le runner');
});

setTimeout(() => {
  console.log(`\n${passed} test(s) OK`);
  if (process.exitCode === 1) process.exit(1);
}, 50);
