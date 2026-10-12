import assert from 'node:assert/strict';

import {
  runGuardedExecution,
  type ExecutionLock,
  type ExecutionRunDeps,
} from '../src/wallet/guardedExecution';

/**
 * TESTS D'ORDONNANCEMENT REEL de la sequence d'execution (regression Seeker
 * « Execute ne fait rien / spinner permanent »).
 *
 * Contrairement aux garde-fous par chaines de source, ces tests EXECUTENT la
 * sequence avec des doublures et comptent les appels : entrees, lectures,
 * ouvertures wallet, soumissions. Aucun RPC, aucun wallet, aucune signature.
 *
 * npx tsx scripts/execution-guard-runtime.test.ts
 */

let passed = 0;
function check(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    })
    .catch((caught: unknown) => {
      console.log(`FAIL ${name}`);
      const detail = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
      console.log(detail.split('\n').slice(0, 4).join('\n'));
      process.exitCode = 1;
    });
}

type SendOutcome = { signature: string | null; verified: boolean; errorMessage: string | null };

/** Doublure comptable : chaque effet est compté et peut etre pilote. */
function makeHarness(overrides: Partial<ExecutionRunDeps<SendOutcome>> = {}) {
  const calls = { readBalance: 0, prepare: 0, signAndSend: 0 };
  const deps: ExecutionRunDeps<SendOutcome> = {
    readBalance: async () => {
      calls.readBalance += 1;
      return 1_000_000_000;
    },
    isInsufficientBalance: () => false,
    approvalInFlight: () => false,
    hasUnverifiedExecutionSignature: () => false,
    walletConnected: () => true,
    prepare: () => {
      calls.prepare += 1;
    },
    signAndSend: async () => {
      calls.signAndSend += 1;
      return { signature: 'sig-ok', verified: true, errorMessage: null };
    },
    ...overrides,
  };
  return { calls, deps };
}

async function main(): Promise<void> {
  // --- Test 1 — premiere execution normale : une entree, un wallet, un envoi.
  await check('1. premiere execution : une entree, un wallet, un envoi, aucun faux « awaiting »', async () => {
    const { calls, deps } = makeHarness();
    const lock: ExecutionLock = { current: false };
    const result = await runGuardedExecution(lock, deps);
    assert.equal(result.kind, 'sent', 'la premiere confirmation doit aller au bout');
    assert.equal(calls.readBalance, 1, 'une seule lecture du solde');
    assert.equal(calls.prepare, 1, 'un seul effacement juste avant l envoi');
    assert.equal(calls.signAndSend, 1, 'wallet ouvert et soumis une seule fois');
    assert.equal(lock.current, false, 'le verrou est rendu apres la fin');
    if (result.kind === 'sent') {
      assert.equal(result.outcome.signature, 'sig-ok');
    }
  });

  // --- Test 2 — double appui rapide : la 2e invocation ne fait RIEN.
  await check('2. double appui rapide : une seule acquisition, un seul envoi, etat de la 1re intacte', async () => {
    let releaseBalance: (lamports: number) => void = () => {};
    const firstRead = new Promise<number>((resolve) => {
      releaseBalance = resolve;
    });
    let readCount = 0;
    const { calls, deps } = makeHarness({
      readBalance: () => {
        readCount += 1;
        // La premiere lecture reste en suspens : la seconde invocation arrive
        // pendant que la premiere detient le verrou.
        return readCount === 1 ? firstRead : Promise.resolve(1_000_000_000);
      },
    });
    const lock: ExecutionLock = { current: false };
    const first = runGuardedExecution(lock, deps); // acquis synchrone, avant tout await
    const second = await runGuardedExecution(lock, deps); // concurrente
    assert.equal(second.kind, 'blocked');
    if (second.kind === 'blocked') {
      assert.equal(second.reason, 'already_starting', 'doublon = deja en cours, pas « awaiting »');
    }
    // La deuxieme n'a touche a AUCUN effet de la premiere.
    assert.equal(calls.signAndSend, 0, 'aucun wallet tant que la premiere est en vol');
    assert.equal(calls.prepare, 0, 'aucun effacement par la doublure concurrente');
    releaseBalance(1_000_000_000);
    const firstResult = await first;
    assert.equal(firstResult.kind, 'sent');
    assert.equal(calls.signAndSend, 1, 'un seul envoi au total');
    assert.equal(calls.prepare, 1, 'un seul effacement au total');
    assert.equal(lock.current, false, 'verrou rendu a la fin');
  });

  // --- Test 3 — lecture du solde impossible : rien n'est envoye, retry possible.
  await check('3. lecture du solde en echec : aucun wallet, verrou rendu, retry possible', async () => {
    let rejectOnce = true;
    const { calls, deps } = makeHarness({
      readBalance: async () => {
        calls.readBalance += 1;
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error('getaddrinfo ENOTFOUND devnet');
        }
        return 1_000_000_000;
      },
    });
    const lock: ExecutionLock = { current: false };
    const failed = await runGuardedExecution(lock, deps);
    assert.equal(failed.kind, 'blocked');
    if (failed.kind === 'blocked') {
      assert.equal(failed.reason, 'balance_unreadable');
      assert.match(failed.detail ?? '', /ENOTFOUND/);
    }
    assert.equal(calls.signAndSend, 0, 'aucun wallet sur une lecture ratee');
    assert.equal(lock.current, false, 'le verrou est rendu malgre l echec');
    // La verification qui suit est une NOUVELLE tentative legitime : elle passe.
    const retry = await runGuardedExecution(lock, deps);
    assert.equal(retry.kind, 'sent', 'une nouvelle tentative doit pouvoir demarrer');
    assert.equal(calls.signAndSend, 1, 'un seul envoi, celui de la tentative reussie');
  });

  // --- Test 4 — envoi signe non verifie REEL : pas de second envoi.
  await check('4. envoi signe non verifie reel : blocage en attente de verification, aucun wallet', async () => {
    const { calls, deps } = makeHarness({ hasUnverifiedExecutionSignature: () => true });
    const lock: ExecutionLock = { current: false };
    const result = await runGuardedExecution(lock, deps);
    assert.equal(result.kind, 'blocked');
    if (result.kind === 'blocked') {
      assert.equal(result.reason, 'already_awaiting_verification', 'vraie preuve d envoi');
    }
    assert.equal(calls.signAndSend, 0, 'aucun second envoi');
    assert.equal(lock.current, false, 'verrou rendu');
  });

  // --- Test 5 — un BOOLEEN seul n'est JAMAIS une preuve d'envoi en attente.
  await check('5. un booleen de tentative seul ne produit jamais « awaiting verification »', async () => {
    const { calls, deps } = makeHarness(); // aucune signature, aucun pending
    const lock: ExecutionLock = { current: true }; // verrou de tentative deja pose
    const result = await runGuardedExecution(lock, deps);
    assert.equal(result.kind, 'blocked');
    if (result.kind === 'blocked') {
      assert.equal(result.reason, 'already_starting', 'un booleen = « en cours », jamais « en attente »');
      assert.notEqual(result.reason, 'already_awaiting_verification');
    }
    assert.equal(calls.signAndSend, 0);
    // Le verrou d'une AUTRE invocation n'est pas rendu par cette sortie anticipee.
    assert.equal(lock.current, true, 'la sortie anticipee ne rend pas un verrou qu elle n a pas pose');
  });

  console.log(`\n${passed} test(s) OK`);
}

void main();
