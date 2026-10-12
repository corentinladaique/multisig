import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createEmptyRegistry,
  findEntry,
  listEntries,
  makeEntry,
  parseRegistry,
  serializeRegistry,
  upsertEntry,
  upsertEntryPreserving,
  type MultisigRegistry,
  type MultisigRegistryEntry,
} from '../src/vault/multisigRegistry';
import {
  createMemoryRegistryStorage,
  loadRegistry,
  saveRegistry,
} from '../src/vault/multisigRegistryStorage';
import {
  createEmptyUsage,
  createMemoryUsageStorage,
  loadUsage,
  markUsed,
  mostRecentlyUsedActiveAddress,
  mostRecentlyUsedAddress,
  saveUsage,
  shouldAutoLoad,
} from '../src/vault/vaultNavigation';

/**
 * Tests FOCALISES du defaut remonte sur appareil (Seeker) :
 *
 * (1) un vault CREÉ (« Create a vault », etape 5 « Review and create ») n'etait
 *     pas conserve localement : absent de la liste apres relance ;
 * (2) il ne devenait PAS le DERNIER UTILISE (donc pas auto-charge au lancement
 *     suivant) ;
 * (3) une ecriture automatique `manual` VIDE (effet de chargement reussi de
 *     l'ecran d'accueil) pouvait ECRASER l'entree CREÉE et perdre son nom, son
 *     seuil et ses membres.
 *
 * Tests PURS : modeles partages (registre, usage) + lecture des sources.
 * Aucun RPC, aucun wallet, aucune signature, aucune transaction, aucun stockage
 * natif (backend memoire). Execution :
 * npx tsx scripts/vault-create-persist.test.ts
 */

const MULTISIG_V = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG_OLD = '11111111111111111111111111111111';
const MULTISIG_OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const CREATE = readFileSync('src/screens/CreateVaultScreen.tsx', 'utf8');
const CONNECT = readFileSync('src/screens/ConnectScreen.tsx', 'utf8');
const REGISTRY_HOOK = readFileSync('src/vault/useMultisigRegistry.ts', 'utf8');
const RUNNER = readFileSync('scripts/run-pure-tests.sh', 'utf8');

const T_CREATE = '2026-10-09T10:00:00.000Z';
const T_LATER = '2026-10-09T12:00:00.000Z';
const T_EARLIER = '2026-10-09T08:00:00.000Z';

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

/** Entree CREÉE : provenance `created`, nom local + labels de membres. */
function createdEntry(
  address: string,
  addedAt: string,
  vaultName = 'My created vault',
  memberLabels: Record<string, string> = { [MULTISIG_OTHER]: 'Ledger' },
): MultisigRegistryEntry {
  const { entry, errors } = makeEntry({ address, vaultName, memberLabels, now: addedAt, source: 'created' });
  assert.deepEqual(errors, []);
  if (entry === null) throw new Error('created entry was rejected');
  return entry;
}

/** Entree `manual` VIDE : exactement la forme ecrite par l'effet de chargement reussi. */
function manualPlaceholder(address: string, addedAt: string): MultisigRegistryEntry {
  const { entry, errors } = makeEntry({
    address,
    vaultName: '',
    memberLabels: {},
    now: addedAt,
    source: 'manual',
  });
  assert.deepEqual(errors, []);
  if (entry === null) throw new Error('manual placeholder was rejected');
  return entry;
}

/**
 * Reproduit le chemin d'ecriture CORRIGE du hook : base = dernier registre
 * PERSISTE (jamais un instantane perime), puis upsert PROTEGE. Renvoie l'etat
 * de stockage resultant.
 */
async function hookAdd(
  storage: ReturnType<typeof createMemoryRegistryStorage>,
  staleRef: MultisigRegistry,
  entry: MultisigRegistryEntry,
): Promise<MultisigRegistry> {
  const persisted = (await loadRegistry(storage)).registry;
  void staleRef; // un instantane perime ne doit plus etre la base
  const next = upsertEntryPreserving(persisted, entry);
  await saveRegistry(storage, next);
  return next;
}

// ===========================================================================
// (1) LE VAULT CREÉ EST AJOUTE AU REGISTRE ET PERSISTE
// ===========================================================================

check('1. un vault CREÉ est ajoute au registre et present dans la liste', () => {
  const base = createEmptyRegistry();
  const next = upsertEntryPreserving(base, createdEntry(MULTISIG_V, T_CREATE));
  assert.deepEqual(
    listEntries(next).map((entry) => entry.address),
    [MULTISIG_V],
    'le vault cree est dans la liste locale',
  );
  assert.equal(findEntry(next, MULTISIG_V)?.source, 'created');
});

check('2. un vault CREÉ survit a une RELANCE (round-trip du stockage)', async () => {
  const storage = createMemoryRegistryStorage();
  const next = upsertEntryPreserving(createEmptyRegistry(), createdEntry(MULTISIG_V, T_CREATE));
  await saveRegistry(storage, next);

  // Relance : un NOUVEAU stockage amorce avec ce qui a ete persiste.
  const relaunch = createMemoryRegistryStorage(await storage.load());
  const reloaded = await loadRegistry(relaunch);
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(
    listEntries(reloaded.registry).map((entry) => entry.address),
    [MULTISIG_V],
    'le vault cree est present apres relance',
  );
  // Round-trip direct : aucune donnee sensible, contenu identique.
  assert.deepEqual(parseRegistry(serializeRegistry(next)).registry, next);
});

check('3. le vault CREÉ devient le DERNIER UTILISE (auto-charge a l ouverture)', () => {
  // Un autre vault, plus ancien, existe deja (ajoute avant la creation).
  let registry = upsertEntryPreserving(createEmptyRegistry(), manualPlaceholder(MULTISIG_OLD, T_EARLIER));
  registry = upsertEntryPreserving(registry, createdEntry(MULTISIG_V, T_CREATE));
  // Le vault créé est marque comme dernier utilise, avec son seuil/effectif reels.
  const usage = markUsed(createEmptyUsage(), MULTISIG_V, { threshold: 2, memberCount: 3 }, T_LATER);

  assert.equal(
    mostRecentlyUsedAddress(registry.entries, usage),
    MULTISIG_V,
    'le vault cree est le plus recemment utilise',
  );
  assert.equal(usage.records[MULTISIG_V]?.threshold, 2);
  assert.equal(usage.records[MULTISIG_V]?.memberCount, 3);
  assert.equal(
    mostRecentlyUsedActiveAddress(registry.entries, usage, {
      version: 1,
      records: {},
    }),
    MULTISIG_V,
  );
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

check('4. nom, seuil et membres du vault CREÉ survivent a un rechargement', async () => {
  const registryStorage = createMemoryRegistryStorage();
  const usageStorage = createMemoryUsageStorage();

  const registry = upsertEntryPreserving(
    createEmptyRegistry(),
    createdEntry(MULTISIG_V, T_CREATE, 'Treasury 2-of-3', { [MULTISIG_OTHER]: 'Ledger at home' }),
  );
  const usage = markUsed(createEmptyUsage(), MULTISIG_V, { threshold: 2, memberCount: 3 }, T_CREATE);
  await saveRegistry(registryStorage, registry);
  await saveUsage(usageStorage, usage);

  const reloadedRegistry = await loadRegistry(createMemoryRegistryStorage(await registryStorage.load()));
  const reloadedUsage = await loadUsage(createMemoryUsageStorage(await usageStorage.load()));
  const entry = findEntry(reloadedRegistry.registry, MULTISIG_V);
  assert.equal(entry?.vaultName, 'Treasury 2-of-3', 'le nom local est conserve');
  assert.equal(entry?.source, 'created', 'la provenance reste created');
  assert.equal(entry?.memberLabels[MULTISIG_OTHER], 'Ledger at home', 'les labels de membres sont conserves');
  assert.equal(reloadedUsage.usage.records[MULTISIG_V]?.threshold, 2, 'le seuil est conserve');
  assert.equal(reloadedUsage.usage.records[MULTISIG_V]?.memberCount, 3, 'le nombre de membres est conserve');
});

// ===========================================================================
// (2) LE VAULT CREÉ N'EST PAS ECRASE PAR UNE ECRITURE `manual` VIDE
// ===========================================================================

check('5. upsert PROTEGE : un placeholder manual vide n ecrase pas l entree CREÉE', () => {
  const base = upsertEntryPreserving(createEmptyRegistry(), createdEntry(MULTISIG_V, T_CREATE));
  const afterManual = upsertEntryPreserving(base, manualPlaceholder(MULTISIG_V, T_LATER));
  const entry = findEntry(afterManual, MULTISIG_V);
  assert.equal(entry?.vaultName, 'My created vault', 'le nom du vault cree est conserve');
  assert.equal(entry?.source, 'created', 'la provenance created est conservee');
  assert.deepEqual(entry?.memberLabels, { [MULTISIG_OTHER]: 'Ledger' }, 'les labels sont conserves');
  // Contre-preuve : l'upsert BRUT (comportement defectueux) ecraserait tout.
  const clobbered = findEntry(upsertEntry(base, manualPlaceholder(MULTISIG_V, T_LATER)), MULTISIG_V);
  assert.equal(clobbered?.vaultName, '', 'sans protection, un placeholder vide ecraserait le nom');
  assert.equal(clobbered?.source, 'manual');
});

check('6. sequence REELLE : une autre instance du hook ne peut plus effacer le vault CREÉ', async () => {
  const storage = createMemoryRegistryStorage();
  // Les deux instances montent sur un stockage vide.
  const connectRefBefore = (await loadRegistry(storage)).registry; // instantane de l'ecran d'accueil
  const createRefBefore = (await loadRegistry(storage)).registry; // instantane de l'ecran de creation
  assert.deepEqual(connectRefBefore.entries, []);
  assert.deepEqual(createRefBefore.entries, []);

  // L'ecran de creation ecrit le vault CREÉ (nom + labels).
  await hookAdd(storage, createRefBefore, createdEntry(MULTISIG_V, T_CREATE, 'Created vault'));

  // Plus tard, l'ecran d'accueil (instantane perime) croit le vault inconnu et
  // ecrit un placeholder manual vide.
  await hookAdd(storage, connectRefBefore, manualPlaceholder(MULTISIG_V, T_LATER));

  const persisted = (await loadRegistry(storage)).registry;
  const entry = findEntry(persisted, MULTISIG_V);
  assert.equal(entry?.vaultName, 'Created vault', 'le vault cree survit a l ecriture manual');
  assert.equal(entry?.source, 'created');
  // Le vault reste present dans la liste apres relance.
  const relaunch = await loadRegistry(createMemoryRegistryStorage(await storage.load()));
  assert.deepEqual(
    listEntries(relaunch.registry).map((e) => e.address),
    [MULTISIG_V],
  );
});

check('7. la base d ecriture est le registre PERSISTE, pas un instantane perime', async () => {
  const storage = createMemoryRegistryStorage();
  // Un vault existant deja persiste (non connu de l'instantane perime).
  await saveRegistry(storage, upsertEntryPreserving(createEmptyRegistry(), manualPlaceholder(MULTISIG_OLD, T_CREATE)));
  const staleRef = createEmptyRegistry(); // l'instance n'a jamais vu OLD
  await hookAdd(storage, staleRef, createdEntry(MULTISIG_V, T_LATER));
  const persisted = (await loadRegistry(storage)).registry;
  assert.deepEqual(
    listEntries(persisted).map((e) => e.address).sort(),
    [MULTISIG_OLD, MULTISIG_V].sort(),
    'ajouter un vault ne perd pas celui deja persiste',
  );
});

// ===========================================================================
// (3) L'ECRAN DE CREATION ECRIT LE REGISTRE ET LA RECENCE AU SUCCES VERIFIE
// ===========================================================================

check('8. l ecran de creation persiste le vault CREÉ et le marque comme utilise', () => {
  // Le registre recoit une entre pour le vault cree, de provenance `created`.
  assert.ok(CREATE.includes("source: 'created'"), 'ecriture locale de provenance created');
  assert.equal(
    CREATE.split("source: 'created'").length - 1,
    2,
    'les deux sorties de succes (envoi puis relecture) ecrivent le registre',
  );
  // La recence est ecrite, une fois par sortie de succes.
  assert.equal(CREATE.split('usage.markUsed(').length - 1, 2, 'recence ecrite au succes de creation');
  // La recence est ecrite APRES l'ecriture du registre (jamais avant).
  const firstCreate = CREATE.indexOf("source: 'created'");
  const firstMark = CREATE.indexOf('usage.markUsed(');
  assert.ok(firstMark > firstCreate, 'recence apres persistance du registre');
  // Le seuil et l'effectif viennent du read-back ON-CHAIN, jamais d'une valeur inventee.
  assert.ok(
    CREATE.includes('threshold: result.readBack.threshold') &&
      CREATE.includes('memberCount: result.readBack.memberCount'),
    'seuil/effectif relus on-chain',
  );
  assert.ok(
    CREATE.includes('threshold: readBack.threshold') &&
      CREATE.includes('memberCount: readBack.memberCount'),
    'seuil/effectif relus on-chain (relecture)',
  );
  assert.ok(CREATE.includes("import { useVaultUsage }"), 'recence via le hook d usage local dedie');
});

check('9. le hook de registre ecrit sur la base PERSISTE et protege les entrees riches', () => {
  assert.ok(
    REGISTRY_HOOK.includes('latestPersistedRegistry('),
    'la base d ecriture est relue depuis le stockage (jamais un instantane perime)',
  );
  assert.ok(
    REGISTRY_HOOK.includes('upsertEntryPreserving('),
    'l ecriture protege une entree existante plus riche',
  );
  // L'ancien chemin (upsert brut sur l'instantane) ne subsiste pas dans l ecran.
  assert.ok(
    !/upsertEntry\(\s*registryRef\.current/.test(REGISTRY_HOOK),
    'plus d upsert brut sur l instantane courant',
  );
});

// ===========================================================================
// INVARIANT CONSERVE : un echec de chargement n'ecrit JAMAIS la recence
// (la correction du chemin d'AJOUT de ConnectScreen reste intacte)
// ===========================================================================

check('10. l invariant « echec de chargement = pas de recence » reste vrai', () => {
  // Un seul point d'ecriture de la recence dans l'ecran d'accueil.
  assert.equal(CONNECT.split('usage.markUsed(').length - 1, 1, 'un seul usage.markUsed(');
  const guard = "if (msig.status !== 'loaded' || view === null) return;";
  const effectEnd = CONNECT.indexOf('}, [msig.status, registry.entries, view, usage]);');
  const effect = CONNECT.slice(CONNECT.indexOf(guard), effectEnd);
  assert.ok(effect.length > 0, 'l effet de succes existe');
  assert.ok(effect.startsWith(guard), 'gate sur chargement reussi en tete d effet');
  assert.ok(effect.includes('usage.markUsed('), 'la recence est ecrite dans cet effet');
  // La persistance d'un multisig AJOUTE reste dans le meme effet de succes.
  assert.ok(effect.includes('registry.add('), 'l ajout manuel est persiste dans l effet');
  assert.ok(effect.includes("source: 'manual'"), 'un multisig ajoute a la main est de source manual');
  assert.ok(effect.includes('!registry.entries.some('), 'persistance seulement si encore inconnu');
  assert.ok(!effect.includes("msig.status === 'error'"), 'aucune recence sur un chemin d erreur');
});

check('11. la suite est enregistree dans npm test', () => {
  assert.ok(RUNNER.includes('scripts/vault-create-persist.test.ts'), 'suite dans le runner');
});

// ===========================================================================
// (4) L'ECRAN D'ACCUEIL RELIT LE REGISTRE AU RETOUR DE LA CREATION
//     (cause racine : le vault cree n'apparaissait pas dans « My multisigs »)
// ===========================================================================

check('12. ConnectScreen relit le registre au retour de la creation (instance jamais perimee)', () => {
  // La fonction stable est DESTRUCTUREE : l'objet `registry` entier est recree a
  // chaque rendu ; le mettre en dep re-declencherait l'effet (`refresh` change
  // `status`, donc re-rendu) -> boucle infinie. On depend donc de `refresh`
  // (`useCallback([storage])`, identite stable) et du drapeau booleen.
  assert.ok(
    CONNECT.includes('const { refresh: refreshRegistry } = registry;'),
    'refresh destructure : dep stable, jamais l objet registry entier',
  );
  const start = CONNECT.indexOf('const { refresh: refreshRegistry } = registry;');
  const end = CONNECT.indexOf('}, [vaultCreationOpen, refreshRegistry]);', start);
  assert.ok(start > -1 && end > start, 'effet de relecture present et borne');
  const effect = CONNECT.slice(start, end);
  // La relecture ne se declenche QUE lorsqu'un flux de creation se referme.
  assert.ok(
    effect.includes('if (vaultCreationWasOpenRef.current && !vaultCreationOpen)'),
    'relecture gatee sur la fermeture du flux de creation',
  );
  assert.ok(effect.includes('refreshRegistry();'), 'le registre est relu au retour de la creation');
  // Deps STABLES, bornees a la fin de l'effet : jamais l objet `registry`.
  assert.ok(
    CONNECT.includes('}, [vaultCreationOpen, refreshRegistry]);'),
    'deps de l effet : drapeau + fonction stable (aucune boucle)',
  );
  assert.ok(
    !CONNECT.includes('}, [vaultCreationOpen, registry]);'),
    'jamais l objet registry entier en dep (boucle infinie)',
  );
  // Le drapeau retombe a `false` dans chacun des flux de fermeture de la creation.
  assert.ok(CONNECT.includes('setVaultCreationOpen(false)'), 'les flux de fermeture existent');
});

check('13. deux instances : A (accueil) perimee tant qu elle n a pas relu le stockage', async () => {
  const storage = createMemoryRegistryStorage();

  // Les deux instances montent sur un stockage VIDE : instantanes identiques.
  const connectSnapshot = (await loadRegistry(storage)).registry; // instance A (ConnectScreen)
  const createSnapshot = (await loadRegistry(storage)).registry; // instance B (CreateVaultScreen)
  assert.deepEqual(listEntries(connectSnapshot).map((e) => e.address), []);

  // L'instance B ecrit le vault CREÉ (nom + labels) dans le stockage.
  await hookAdd(storage, createSnapshot, createdEntry(MULTISIG_V, T_CREATE, 'Created vault'));

  // SANS refresh : l'instantane de A reste perime -> le vault n'apparait PAS.
  // (C'est exactement le bug : la liste « My multisigs » de A restait vide.)
  assert.deepEqual(
    listEntries(connectSnapshot).map((e) => e.address),
    [],
    'sans relecture, A ne voit pas le vault cree (reproduit le bug)',
  );

  // APRES refresh (ce que fait desormais ConnectScreen au retour de la creation) :
  // A relit le stockage et voit le vault creé.
  const refreshed = (await loadRegistry(storage)).registry;
  assert.deepEqual(
    listEntries(refreshed).map((e) => e.address),
    [MULTISIG_V],
    'apres refresh, A voit le vault cree',
  );
  assert.equal(findEntry(refreshed, MULTISIG_V)?.source, 'created');
});

setTimeout(() => {
  console.log(`\n${passed} test(s) OK`);
  if (process.exitCode === 1) process.exit(1);
}, 50);