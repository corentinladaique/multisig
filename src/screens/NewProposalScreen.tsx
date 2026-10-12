import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

import { connection } from '../solana/connection';
import { buildProposalCreation } from '../squads/buildProposalCreation';
import {
  hasInvalidDestinationError,
  INVALID_DESTINATION_MESSAGE,
  proposalCreationErrorMessage,
} from '../ui/proposalCreationMessages';
import {
  runProposalCreationPreflight,
  type ProposalCreationPreflightResult,
} from '../squads/proposalCreationPreflight';
import {
  signAndSendProposalCreation,
  type ProposalCreationReadBack,
  type ProposalCreationSignSendResult,
} from '../squads/signAndSendProposalCreation';
import {
  simulateProposalCreation,
  type ProposalCreationSimulationResult,
} from '../squads/simulateProposalCreation';
import { snapshotMatchesForm, type ReviewedSnapshot } from '../ui/reviewedSnapshot';
import { formatMwaError } from '../wallet/mwaDiagnostics';
import { buildOperationReport, classifyOperationFailure, classifyOperationResult, describeAttemptOutcome, isTemporaryNetworkFailure } from '../wallet/operationState';
import { signingStateTitle } from '../wallet/signingWindow';
import { AddressInput } from '../ui/AddressInput';
import { SAFE_TOP_PADDING } from '../ui/safeAreaPadding';
import { colors, radii, spacing, typography } from '../ui/theme';
import { Card, DevnetPill, InfoBox, InfoText, PillButton } from '../ui/v2/primitives';
import {
  computeMaxTransfer,
  isMaxSnapshotCurrent,
  maxSnapshotFrom,
  type MaxSnapshot,
  type MaxTransferPlan,
} from '../vault/maxTransfer';
import {
  formatSolAmount,
  lamportsToSolText,
  parseSolToLamports,
  SOL_AMOUNT_MESSAGES,
} from '../vault/solAmount';
import { formatRoundedSolAmount } from '../ui/roundedSol';
import { abbreviateAddress } from '../types/transactionReview';
import { copyToClipboard } from '../ui/clipboard';
import {
  forgetMismatchedPendingCreations,
  forgetPendingCreation,
  isValidPendingCreation,
  pendingCreationFor,
  rememberPendingCreation,
  type PendingCreationRecord,
  type PendingCreationScope,
} from '../wallet/pendingCreationMemory';
import {
  canRetryAfterFailure,
  recoveryStateFromRead,
  type RecoveryCheckState,
} from '../ui/recoveryCheck';

/**
 * Creation d'une proposition de transfert SOL, de bout en bout.
 *
 * Pipeline : saisie → build local → preflight local (après lecture du solde du
 * vault) → simulation (aucune signature, aucun envoi) → revue locale →
 * double confirmation → signature et envoi par le wallet → relecture.
 *
 * Aucun Reject, aucun batch, aucune Address Lookup Table : seulement un
 * transfert SOL simple. Rien n'est envoye sans les trois portes du pipeline
 * (build, preflight, simulation) et sans double confirmation explicite.
 *
 * UI : theme sombre « Seeker style » (UI V2). Seule la présentation a changé :
 * handlers, machine d'état, parsing SOL<->lamports, buffer Max, validation,
 * Paste, runPipeline, préflight, simulation et déclenchement EXPLICITE du wallet
 * sont inchangés.
 */

/**
 * Erreur de préflight « solde du vault insuffisant » : DÉTECTION seule du message
 * BRUT produit par le module de préflight (jamais modifié). Les valeurs sont
 * converties à l'affichage avec `formatSolAmount` (fonction existante) ; le nom
 * technique et les lamports bruts restent confinés à « Troubleshooting details ».
 */
const INSUFFICIENT_VAULT_BALANCE_PATTERN =
  /InsufficientVaultBalance:\s*(\d+)\s*lamports requested,\s*vault holds\s*(\d+)\./;

/**
 * Annulation utilisateur OU association locale interrompue.
 *
 * Les wallets remontent souvent des messages SANS code exploitable
 * (« Session not established », « Local association cancelled by user »,
 * `CancellationException`, `EUNSPECIFIED`) : la detection est donc TEXTUELLE,
 * et c'est une limite assumee. Ce n'est JAMAIS un echec confirme (jamais rouge).
 */
const WALLET_CANCELLATION_PATTERN =
  /CancellationException|session (interrupted|terminated|not ?established)|association cancelled|cancelled by user|user (rejected|cancelled|denied|dismissed)|declined by user/i;

function isWalletCancellation(raw: string | null): boolean {
  return raw !== null && WALLET_CANCELLATION_PATTERN.test(raw);
}

/**
 * LIGNE DE DIVULGATION UNIQUE, partagée par TOUS les contrôles repliables.
 *
 * `inset` annule le padding horizontal d'un conteneur (carte de revue, carte de
 * succès, InfoBox = `spacing.md`) : les indicateurs tombent ainsi dans la MÊME
 * colonne à droite, quel que soit le conteneur. Indicateur replié = ◂ (pointe
 * vers le contenu), déplié = ▾. Cible tactile ≥ 44 px, sémantique d'état
 * conservée.
 */
function DisclosureRow({
  accessibilityLabel,
  expanded,
  inset = 0,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  expanded: boolean;
  inset?: number;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.disclosure,
        inset > 0 ? { marginHorizontal: -inset } : null,
        pressed && styles.togglePressed,
      ]}
    >
      <Text style={styles.disclosureText}>{label}</Text>
      <Text style={styles.disclosureChevron}>{expanded ? '▾' : '◂'}</Text>
    </Pressable>
  );
}

type InsufficientVaultBalanceDetails = {
  requestedLamports: number;
  availableLamports: number;
  missingLamports: number;
};

function parseInsufficientVaultBalance(
  message: string,
): InsufficientVaultBalanceDetails | null {
  const match = INSUFFICIENT_VAULT_BALANCE_PATTERN.exec(message);
  if (match === null) return null;
  const requestedLamports = Number(match[1]);
  const availableLamports = Number(match[2]);
  if (!Number.isSafeInteger(requestedLamports) || !Number.isSafeInteger(availableLamports)) {
    return null;
  }
  return {
    requestedLamports,
    availableLamports,
    missingLamports: Math.max(0, requestedLamports - availableLamports),
  };
}

type PipelineState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export function NewProposalScreen({
  address,
  members,
  onBack,
  onCreatedVerified,
  onDone,
  onOpenCreatedProposal,
  threshold,
  transactionIndex,
  vaultAddress,
}: {
  /** Adresse du multisig (PAS le vault). */
  address: string;
  /** Membres et rôles, lus par l'écran appelant (aucune lecture ici). */
  members: readonly { address: string; roles: readonly string[] }[];
  /** Seuil d'approbation du multisig (affichage du succès uniquement). */
  threshold: number;
  onBack: () => void;
  /**
   * Appelé UNE fois après une création VÉRIFIÉE (signature + confirmation +
   * read-back) : le parent relit le multisig et la liste. Renvoie `true` si
   * l'actualisation a réussi. Lecture seule, aucun wallet.
   */
  onCreatedVerified?: () => Promise<boolean>;
  /** Appelé après une création vérifiée, pour revenir à la liste. */
  onDone: () => void;
  /** Ouvre la proposition créée (index on-chain relu par le parent). */
  onOpenCreatedProposal?: (index: number) => void;
  transactionIndex: number;
  vaultAddress: string;
}) {
  const { account, signAndSendTransactions } = useMobileWallet();
  const creator = account === undefined ? '' : account.address.toString();

  const [destination, setDestination] = useState('');
  /** Montant saisi par l'utilisateur en SOL (jamais en lamports). */
  const [solText, setSolText] = useState('');
  /** Buffer EXPLICITE choisi par l'utilisateur, en SOL : jamais une réserve cachée. */
  const [bufferText, setBufferText] = useState('');
  const [maxPlan, setMaxPlan] = useState<MaxTransferPlan | null>(null);
  /**
   * Instantané du calcul Max : le résumé et son avertissement ne s'affichent que
   * si montant, destination, buffer ET solde de référence correspondent encore.
   */
  const [maxSnapshot, setMaxSnapshot] = useState<MaxSnapshot | null>(null);
  /**
   * Solde CONFIRMÉ du Main vault, relu à l'ouverture de l'écran (lecture SEULE :
   * aucun wallet, aucune signature). Il sert UNIQUEMENT à savoir si le bouton
   * « Max » a quelque chose à proposer : un vault sans SOL disponible le rend
   * « grisé » — mais toujours cliquable.
   */
  const [vaultLamportsRead, setVaultLamportsRead] = useState<number | null>(null);
  /**
   * Message EN LIGNE (jamais une alerte, jamais une popup) affiché quand
   * l'utilisateur presse « Max » alors que le montant maximal transférable vaut
   * 0. Éphémère : aucun stockage, effacé dès que la situation change.
   */
  const [maxZeroNotice, setMaxZeroNotice] = useState(false);
  /**
   * Une tentative EXPLICITE (Prepare / Preview / Create) a-t-elle eu lieu ?
   * Tant que non, aucune erreur de montant n'est affichee : coller une adresse
   * ne doit jamais ressembler a une erreur de saisie.
   */
  const [amountAttempted, setAmountAttempted] = useState(false);
  const [memo, setMemo] = useState('');

  const [pipeline, setPipeline] = useState<PipelineState>({ status: 'idle' });
  const [preflight, setPreflight] = useState<ProposalCreationPreflightResult | null>(null);
  const [simulation, setSimulation] = useState<ProposalCreationSimulationResult | null>(null);
  // ETAPE REELLE du parcours : Details -> Review -> Sign. La revue n'est
  // atteinte QU'APRES une simulation reussie ; Sign qu'apres confirmation.
  const [step, setStep] = useState<'details' | 'review' | 'sign'>('details');
  // INSTANTANE REVU : seule source des valeurs de l'ecran Review. Invalide des
  // qu'un parametre materiel change (voir l'effet d'invalidation plus bas).
  const [reviewedSnapshot, setReviewedSnapshot] = useState<ReviewedSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<ProposalCreationSignSendResult | null>(null);
  const sendAttemptedRef = useRef(false);
  /** Suivi de l'actualisation post-création (une seule, on-chain). */
  const [postCreate, setPostCreate] = useState<'idle' | 'refreshing' | 'done' | 'failed'>('idle');
  /** Section technique repliable, FERMÉE par défaut. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Sous-repli « Troubleshooting details » (logs bruts), FERMÉ par défaut. */
  const [simulationLogsOpen, setSimulationLogsOpen] = useState(false);
  /** Diagnostic brut d'une erreur de préflight, FERMÉ par défaut. */
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);
  /** Section explicative repliable, FERMÉE par défaut. */
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  /**
   * Carte « sent / pending » : c'est un REPLI, FERMÉ par défaut. Replié, le
   * titre de l'en-tête dit déjà tout l'essentiel (« envoyé / non vérifié ») :
   * l'utilisateur n'a pas à déplier pour comprendre qu'un envoi a peut-être eu
   * lieu. Le corps (message + actions) n'est révélé qu'au tap.
   */
  const [pendingVerificationOpen, setPendingVerificationOpen] = useState(false);
  /** Section « More options » repliable, FERMÉE par défaut (buffer + Max). */
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  /** Reçu technique de l'écran de succès, replié par défaut. */
  const [receiptOpen, setReceiptOpen] = useState(false);
  /**
   * Retour de copie TEMPORAIRE et INDÉPENDANT par champ : « Copy » devient
   * « Copied ✓ » ~1,5 s puis redevient « Copy ». AUCUNE ligne permanente, donc
   * aucune hauteur ajoutée au reçu. La valeur copiée est la valeur COMPLÈTE.
   */
  const [copyFeedback, setCopyFeedback] = useState<{
    field: 'signature' | 'transaction' | 'proposal';
    ok: boolean;
  } | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyReceiptValue = (
    field: 'signature' | 'transaction' | 'proposal',
    value: string | null | undefined,
  ): void => {
    if (value === null || value === undefined || value.length === 0) return;
    // Contrôle de copie EXISTANT (src/ui/clipboard) : valeur COMPLÈTE, jamais abrégée.
    setCopyFeedback({ field, ok: copyToClipboard(value) });
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null;
      setCopyFeedback(null);
    }, 1500);
  };
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    [],
  );
  /**
   * Détail BRUT d'une ANNULATION wallet (jamais un échec confirmé) : rendu
   * uniquement dans « Troubleshooting details », jamais au premier niveau.
   */
  const [createCancellationRaw, setCreateCancellationRaw] = useState<string | null>(null);
  /**
   * ÉCHEC NON CLASSÉ, sans signature prouvée : état CONSERVATEUR « Result
   * unknown ». Le brut reste replié ; « Try again » reste DÉSACTIVÉ jusqu'à ce
   * qu'une relecture LECTURE SEULE ait rendu la main.
   */
  const [createUncertainRaw, setCreateUncertainRaw] = useState<string | null>(null);
  /**
   * Contrôle de reprise DISCRIMINÉ (jamais un booléen) : seul `safe_to_retry`
   * autorise une nouvelle tentative, et il ne se déduit pas d'une promesse
   * terminée. Voir `RecoveryCheckState`.
   */
  const [recoveryCheck, setRecoveryCheck] = useState<RecoveryCheckState>('not_checked');

  /**
   * PERIMETRE du registre de creations en attente : cluster + multisig + vault +
   * index attendu. L'index vient de la prop (index courant du multisig, celui
   * que la creation consomme) : la MEME valeur sert a enregistrer ET a restaurer.
   */
  const pendingCreationScope: PendingCreationScope = {
    cluster: 'devnet',
    multisigAddress: address,
    vaultAddress,
    transactionIndexNext: transactionIndex,
  };
  /**
   * RESTAURATION apres demontage / remontage (memoire de module, session
   * courante uniquement : aucune persistance disque, voir pendingCreationMemory).
   */
  const [restoredPendingCreation, setRestoredPendingCreation] =
    useState<PendingCreationRecord | null>(null);
  /** ETAT TERMINAL : une creation VERIFIEE ne doit plus jamais etre invalidee. */
  const terminalRef = useRef(false);
  // Verdict unique de l'UI : sans signature, jamais de libellé « Sent ».
  const attemptOutcome =
    createResult === null
      ? null
      : describeAttemptOutcome({
          confirmed: createResult.confirmed === true,
          // Preuve disponible sans nouvelle lecture : hauteur inconnue, donc
          // aucun déverrouillage après signature (règle B).
          evidence: {
            blockHeight: null,
            lastValidBlockHeight: createResult.lastValidBlockHeight ?? null,
            status: createResult.confirmationStatus ?? 'notFound',
          },
          networkFailure: isTemporaryNetworkFailure(createResult.errorMessage ?? ''),
          signature: createResult.signature,
          verified: createResult.verified,
        });

  // Saisie en SOL, convertie EXACTEMENT en lamports (arithmetique entiere,
  // 9 decimales max). Toute forme invalide produit NaN : le builder refuse et
  // l'ecran affiche un message en SOL explicite.
  const parsedSol = parseSolToLamports(solText);
  const lamports = parsedSol.ok ? parsedSol.lamports : Number.NaN;

  const build = useMemo(
    () =>
      buildProposalCreation({
        creator,
        destination,
        lamports,
        memo,
        multisigPda: address,
        transactionIndex,
      }),
    [address, creator, destination, lamports, memo, transactionIndex],
  );

  // NOTE : les avertissements du builder (explications d'implementation, notes
  // de rente, instructions de developpement) ne sont PLUS rendus du tout — ni
  // dans le parcours, ni dans les diagnostics. L'aide pedagogique et les
  // donnees brutes vivent dans des sections repliables distinctes.

  // Toute modification de la saisie invalide le pipeline déjà calculé : on ne
  // signe jamais sur la base d'une simulation qui ne correspond plus. Le buffer
  // du Max en fait partie : changer le buffer change le montant.
  useEffect(() => {
    // Etat TERMINAL atteint (creation VERIFIEE) : plus AUCUNE invalidation. Sans
    // cette garde, la relecture du parent (index suivant) change `build` et
    // renvoyait l'ecran a Details — effacant la revue et le succes.
    if (terminalRef.current) return;
    // Une proposition SIGNÉE mais NON vérifiée est un état POST-CRÉATION : la
    // relecture du parent (qui change `build`) ne doit PAS renvoyer l'écran à
    // l'étape Details, sinon « 1 Details » cohabiterait avec la carte ambre
    // « Proposal sent / verification pending » (incohérence d'état signalée).
    // Le flux reste sur son étape post-création tant que la vérification n'est
    // pas résolue.
    if (
      restoredPendingCreation !== null ||
      (createResult !== null && createResult.signature !== null && createResult.verified !== true)
    ) {
      return;
    }
    setPipeline({ status: 'idle' });
    setPreflight(null);
    setSimulation(null);
    // Toute modification materielle invalide AUSSI la revue : on revient a
    // l'etape Details et la creation redevient impossible jusqu'a une nouvelle
    // « Review proposal ». C'est l'invariant « instantane revu ».
    setReviewedSnapshot(null);
    setStep('details');
  }, [build, bufferText, memo, destination]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  /**
   * §4 — TOUTE modification materielle de la saisie purge l'etat de la tentative
   * PRECEDENTE : une annulation ou un resultat inconnu ne doit JAMAIS rester
   * visible apres un changement de formulaire. Les dependances sont les ENTREES
   * BRUTES (jamais `build`) : un simple rafraichissement de solde ne doit pas
   * effacer un message de securite.
   */
  useEffect(() => {
    if (terminalRef.current) return;
    setCreateCancellationRaw(null);
    setCreateUncertainRaw(null);
    setRecoveryCheck('not_checked');
    setCreateError(null);
    setCreateResult(null);
    setTroubleshootingOpen(false);
    setSimulationLogsOpen(false);
    setAdvancedOpen(false);
    // §4 — le message « Max » (vault sans SOL) ne survit à AUCUNE modification
    // de saisie : montant, destination, mémo ou buffer le font disparaître.
    setMaxZeroNotice(false);
  }, [destination, solText, memo, bufferText]);

  /**
   * LECTURE SEULE du solde du Main vault pour refléter l'état du bouton « Max » :
   * grisé quand rien n'est transférable. Aucun wallet, aucune signature, aucun
   * envoi — la même lecture que `onMax`, mais faite dès l'ouverture pour que
   * l'aspect « désactivé » soit visible d'un coup d'œil, AVANT tout clic.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let read: number | null = null;
      try {
        read = await connection.getBalance(new PublicKey(vaultAddress), 'confirmed');
      } catch {
        read = null;
      }
      if (!cancelled) setVaultLamportsRead(read);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultAddress]);

  /**
   * §2 — NOUVEL ÉTAT POST-WALLET (annulation classée, échec non classé, résultat
   * de création) : TOUTES les divulgations se REFERMENT. Un état qui survient
   * après l'ouverture du wallet doit être lu d'un seul tenant, jamais hérité
   * d'une section restée ouverte pendant le parcours précédent.
   */
  useEffect(() => {
    if (createCancellationRaw === null && createUncertainRaw === null && createResult === null) {
      return;
    }
    setAdvancedOpen(false);
    setSimulationLogsOpen(false);
    setTroubleshootingOpen(false);
    setHowItWorksOpen(false);
    setMoreOptionsOpen(false);
    setReceiptOpen(false);
  }, [createCancellationRaw, createUncertainRaw, createResult]);

  /**
   * RESTAURATION de l'etat « proposition envoyée, vérification en attente » apres un demontage / remontage.
   * Les records d'un AUTRE perimetre (cluster / vault / index) sont purges : ils
   * ne peuvent plus correspondre a une reprise legitime.
   */
  useEffect(() => {
    forgetMismatchedPendingCreations(pendingCreationScope);
    const record = pendingCreationFor(pendingCreationScope);
    setRestoredPendingCreation(isValidPendingCreation(record, pendingCreationScope) ? record : null);
  }, [
    pendingCreationScope.cluster,
    pendingCreationScope.multisigAddress,
    pendingCreationScope.transactionIndexNext,
    pendingCreationScope.vaultAddress,
  ]);

  // Le résumé Max n'est visible que si la saisie correspond encore exactement à
  // l'instantané du calcul : montant, destination, buffer et solde de référence.
  const parsedMaxBuffer = bufferText.trim().length === 0 ? null : parseSolToLamports(bufferText);
  const maxBufferLamports =
    parsedMaxBuffer !== null && parsedMaxBuffer.ok ? parsedMaxBuffer.lamports : 0;
  /**
   * Montant maximal transférable = solde du Main vault MOINS le buffer explicite.
   * Il vaut 0 (ou moins) quand le vault n'a aucun SOL disponible : c'est le SEUL
   * cas où le bouton « Max » est grisé (mais reste cliquable). Dérivé, jamais
   * stocké : toute nouvelle lecture du solde fait disparaître l'état à l'écran.
   */
  const maxTransferableZero =
    vaultLamportsRead !== null && vaultLamportsRead - maxBufferLamports <= 0;
  const maxSummaryVisible =
    maxPlan !== null &&
    maxPlan.ready &&
    isMaxSnapshotCurrent(maxSnapshot, {
      amountLamports: Number.isFinite(lamports) && lamports > 0 ? lamports : null,
      bufferLamports: maxBufferLamports,
      destination,
      vaultLamports: maxSnapshot?.vaultLamports ?? null,
    });

  const canRunPipeline =
    creator.length > 0 && build.errors.length === 0 && pipeline.status !== 'working';

  /**
   * Destination « tentee » : tant que le champ est vide, aucune erreur de
   * destination n'est presentee (le builder produit deja une erreur nommee des
   * le premier rendu, mais elle reste invisible avant toute saisie).
   */
  const destinationAttempted = destination.trim().length > 0;

  /**
   * Max : relit le solde CONFIRMÉ du Main vault, puis fige un montant exact en
   * lamports. Aucune réserve cachée : seul le buffer explicite est retiré, et
   * aucun frais n'est déduit du vault (le membre signataire paie les frais).
   * Aucun wallet, aucune signature, aucun envoi.
   */
  const onMax = useCallback(async () => {
    setMaxPlan(null);
    let freshLamports: number | null = null;
    try {
      freshLamports = await connection.getBalance(new PublicKey(vaultAddress), 'confirmed');
    } catch {
      freshLamports = null;
    }
    // Le buffer saisi est en SOL : il est converti exactement en lamports.
    const parsedBuffer = bufferText.trim().length === 0 ? null : parseSolToLamports(bufferText);
    const bufferLamports = parsedBuffer !== null && parsedBuffer.ok ? parsedBuffer.lamports : 0;
    const plan = computeMaxTransfer({
      explicitBufferLamports: bufferLamports,
      // Faits du chemin de code : ce formulaire ne construit qu'un transfert SOL
      // dont la source est le Main vault (buildProposalCreation).
      recognizedSolTransfer: true,
      sourceMatchesMainVault: true,
      vaultLamports: freshLamports,
    });
    setMaxPlan(plan);
    // Le solde vient d'être relu : l'état « grisé » du bouton Max suit la même
    // valeur, sans lecture supplémentaire.
    setVaultLamportsRead(freshLamports);
    if (plan.amountLamports !== null && freshLamports !== null) {
      // Montant figé maintenant : il ne suivra jamais un solde futur.
      // La valeur reste un nombre ENTIER de lamports ; seul l'affichage est en SOL.
      setSolText(lamportsToSolText(plan.amountLamports));
      // Instantané : le résumé disparaîtra dès que la saisie changera.
      setMaxSnapshot(maxSnapshotFrom(plan, destination, freshLamports));
      setPipeline({ status: 'idle' });
      setPreflight(null);
      setSimulation(null);
      setMaxZeroNotice(false);
    } else {
      // Le montant maximal transférable vaut 0 : on n'INVENTE rien et on ne
      // remplit PAS le champ. Un message EN LIGNE explique pourquoi (jamais une
      // alerte). Vault sans SOL disponible, ou buffer supérieur au solde.
      setMaxSnapshot(null);
      setMaxZeroNotice(freshLamports !== null && freshLamports - bufferLamports <= 0);
    }
  }, [bufferText, destination, vaultAddress]);

  /** Portes locales + une lecture de solde, puis simulation (aucun envoi). */
  const runPipeline = async (): Promise<ProposalCreationSimulationResult | null> => {
    // Action explicite : a partir d'ici, les erreurs de montant sont legitimes.
    setAmountAttempted(true);
    if (!canRunPipeline) return null;
    setPipeline({ status: 'working' });
    setPreflight(null);
    setSimulation(null);
    setCreateError(null);
    try {
      const vaultLamports = await connection.getBalance(new PublicKey(vaultAddress), 'confirmed');
      const preflightResult = runProposalCreationPreflight({
        build,
        multisig: { members, transactionIndex, vaultAddress },
        vault: { address: vaultAddress, lamports: vaultLamports },
      });
      setPreflight(preflightResult);
      if (!preflightResult.readyForInstructionBuild) {
        setPipeline({
          message: preflightResult.errors.join(' ') || 'The local preflight refused this build.',
          status: 'error',
        });
        return null;
      }
      const simulationResult = await simulateProposalCreation({
        build,
        connection,
        preflight: preflightResult,
      });
      setSimulation(simulationResult);
      if (!simulationResult.readyToSign) {
        setPipeline({
          message: simulationResult.errors.join(' ') || 'The simulation refused this build.',
          status: 'error',
        });
        return null;
      }
      // Simulation REUSSIE : on fige l'INSTANTANE REVU (seule source de l'ecran
      // Review) puis on passe a l'etape Review. Aucun wallet, aucune signature.
      setReviewedSnapshot({
        destination,
        amountLamports: lamports,
        memo,
        bufferLamports: maxBufferLamports,
        cluster: 'devnet',
        vaultAddress,
        transactionIndexNext: build.transactionIndexNext,
        estimatedCreatorBalanceDelta: simulationResult.estimatedCreatorBalanceDelta,
        proposalPda: build.proposalPda,
        transactionPda: build.transactionPda,
      });
      setStep('review');
      setPipeline({ status: 'ready' });
      return simulationResult;
    } catch (caught: unknown) {
      setPipeline({
        message: caught instanceof Error ? caught.message : String(caught),
        status: 'error',
      });
      return null;
    }
  };

  const runCreate = async (freshSimulation?: ProposalCreationSimulationResult | null) => {
    const effectiveSimulation = freshSimulation ?? simulation;
    if (sendAttemptedRef.current || effectiveSimulation === null || preflight === null) return;
    if (effectiveSimulation.readyToSign !== true) return;
    sendAttemptedRef.current = true;
    setCreating(true);
    setCreateError(null);
    setCreateCancellationRaw(null);
    setCreateUncertainRaw(null);
    setRecoveryCheck('not_checked');
    setCreateResult(null);
    let signature: string | null = null;
    try {
      const result = await signAndSendProposalCreation({
        build,
        connection,
        preflight,
        signAndSendTransactions,
        simulation: effectiveSimulation,
      });
      // ANNULATION UTILISATEUR : ce n'est PAS un échec confirmé. Un seul état
      // humain de reprise ; le brut reste replié, et aucun reçu
      // d'échec n'est publié.
      const rawFailure =
        result.signature === null
          ? result.errorMessage ?? result.validationErrors.join(' ')
          : null;
      if (isWalletCancellation(rawFailure)) {
        setCreateCancellationRaw(rawFailure);
        setCreateResult(null);
        setCreateError(null);
        return;
      }
      // ÉCHEC NON CLASSÉ, SANS signature : état CONSERVATEUR. On ne prétend PAS
      // « rien n'a été signé » : le résultat est INCONNU jusqu'à une relecture.
      if (rawFailure !== null) {
        setCreateUncertainRaw(rawFailure);
        setCreateResult(null);
        setCreateError(null);
        setRecoveryCheck('not_checked');
        return;
      }
      signature = result.signature;
      setCreateResult(result);
      if (!result.verified) {
        setCreateError(
          // La machine d'état parle d'abord : « sent, verification pending »
          // ne doit jamais être présenté comme un échec de création.
          `${
            result.signingState !== undefined
              ? signingStateTitle(result.signingState)
              : buildOperationReport({
              evidence: {
                confirmed: result.confirmed === true,
                readBackVerified: result.verified,
                signatureObtained: result.signature !== null,
              },
              state: classifyOperationResult({
                confirmed: result.confirmed === true,
                readBackVerified: result.verified,
                signatureObtained: result.signature !== null,
              }),
            }).title
          } ${
            result.errorMessage !== null
              ? formatMwaError({
                  code: result.errorCode ?? null,
                  message: result.errorMessage,
                  step: 'signAndSendTransactions',
                })
              : result.validationErrors.join(' ')
          }`,
        );
      }
      if (result.verified) {
        // PREUVE POSITIVE : plus AUCUNE creation en attente pour ce perimetre.
        forgetPendingCreation(pendingCreationScope);
        setRestoredPendingCreation(null);
        // Création VÉRIFIÉE : état TERMINAL. Toute invalidation ulterieure est
        // desormais interdite (la relecture du parent change le `build`).
        terminalRef.current = true;
        // UNE SEULE actualisation explicite du multisig et de la liste. La
        // chaîne reste la source de vérité, aucun wallet.
        setPostCreate('refreshing');
        const refreshed = onCreatedVerified === undefined ? true : await onCreatedVerified();
        setPostCreate(refreshed ? 'done' : 'failed');
      } else if (result.signature !== null) {
        // §2 — SIGNATURE REELLE MAIS NON VERIFIEE : enregistre en MEMOIRE DE
        // MODULE (aucune donnee sensible, aucune persistance disque) afin qu'un
        // demontage / remontage de l'ecran ne rouvre PAS une seconde creation.
        const record: PendingCreationRecord = {
          ...pendingCreationScope,
          proposalPda: reviewedSnapshot?.proposalPda ?? '',
          transactionPda: reviewedSnapshot?.transactionPda ?? '',
          signature: result.signature,
          createdAt: Date.now(),
        };
        rememberPendingCreation(record);
        setRestoredPendingCreation(record);
      }
    } catch (caught: unknown) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      // Motif textuel (messages wallets SANS code) + classifieur partage.
      const classified = classifyOperationFailure({ caught, step: 'signAndSendTransactions' });
      const cancelled =
        isWalletCancellation(raw) ||
        classified === 'wallet-session-interrupted' ||
        classified === 'authorization-cancelled';
      if (cancelled) {
        setCreateCancellationRaw(raw);
        setCreateResult(null);
        setCreateError(null);
      } else {
        // Aucune signature PROUVÉE : on ne conclut RIEN (état conservateur).
        setCreateUncertainRaw(raw);
        setCreateResult(null);
        setCreateError(null);
        setRecoveryCheck('not_checked');
      }
    } finally {
      if (signature === null) sendAttemptedRef.current = false;
      setCreating(false);
      // Flux wallet echoue / refuse (AUCUNE signature) : l'ecran revient a un
      // etat RECUPERABLE (Review) — jamais bloque, jamais occupe en permanence.
      if (signature === null) setStep('review');
    }
  };

  /** Double confirmation explicite avant toute demande au wallet. */
  const onCreate = () => {
    setAmountAttempted(true);
    if (reviewedSnapshot === null || creating || sendAttemptedRef.current) return;
    // Nouvelle tentative après un échec SANS signature : état propre, saisie
    // (destination, montant, memo) intacte. Une tentative signée ne peut pas
    // emprunter ce chemin (bouton désactivé).
    const isRetry = createResult !== null && attemptOutcome?.allowNewAttempt === true;
    if (isRetry) {
      setCreateResult(null);
      setCreateError(null);
    }
    // UN SEUL dialogue de confirmation : les deux dialogues precedents
    // dupliquaient la meme information. Aucun detail de construction de compte
    // ici (VaultTransaction / Proposal account / rente) : il vit dans
    // la section technique repliable. Le montant est formate en SOL lisible, jamais
    // « 0.200000000 ». Le transfert n'a PAS lieu a la creation : c'est dit.
    Alert.alert(
      'Create this proposal on Devnet?',
      [
        `Amount: ${formatSolAmount(reviewedSnapshot.amountLamports)}`,
        // Destination COMPLETE (jamais abregee) : elle doit etre verifiable
        // avant toute signature.
        `Destination: ${reviewedSnapshot.destination}`,
        `Estimated creation cost: ${
          reviewedSnapshot.estimatedCreatorBalanceDelta === null
            ? 'not measurable'
            : `≈ ${formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))}`
        }`,
        '',
        'This records the proposal on-chain. The transfer will only happen after the required approvals are collected and the proposal is executed.',
      ].join('\n'),
      [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => {
            // Sign : l'etape n'avance QU'APRES la confirmation explicite.
            setStep('sign');
            // Nouvelle tentative : préflight et simulation sont refaits
            // AVANT d'ouvrir le wallet (transaction neuve, blockhash neuf).
            if (isRetry) {
              void (async () => {
                const fresh = await runPipeline();
                if (fresh === null || fresh.readyToSign !== true) return;
                await runCreate(fresh);
              })();
              return;
            }
            void runCreate();
          },
          text: 'Create',
        },
      ],
      { cancelable: true },
    );
  };

  // Erreur de préflight « solde insuffisant » : détection purement UI (aucune
  // décision métier) afin de ne jamais exposer de lamports au premier niveau.
  const insufficientVaultBalance =
    pipeline.status === 'error' ? parseInsufficientVaultBalance(pipeline.message) : null;

  /** CTA secondaire « Edit details » : revient a la SAISIE et INVALIDE
   *  l'instantane revu — donc « Review proposal » est de nouveau requis. */
  const onEditDetails = () => {
    setPipeline({ status: 'idle' });
    setPreflight(null);
    setSimulation(null);
    setReviewedSnapshot(null);
    setStep('details');
    setAdvancedOpen(false);
    setSimulationLogsOpen(false);
    setTroubleshootingOpen(false);
    // §4 — l'etat de la tentative precedente est purge en entier : aucune
    // annulation ni aucun resultat inconnu ne survit a un retour en Details.
    setCreateCancellationRaw(null);
    setCreateUncertainRaw(null);
    setRecoveryCheck('not_checked');
    setCreateError(null);
    setCreateResult(null);
  };

  /**
   * RELECTURE CIBLÉE des DEUX comptes créés (proposition + VaultTransaction).
   *
   * LECTURE SEULE : aucun wallet, aucune signature, aucun envoi, aucune
   * reconstruction. Renvoie la vue de read-back si — et seulement si — les deux
   * comptes sont lisibles ET appartiennent au programme Squads ; sinon `null`.
   * C'est la SEULE preuve positive qui autorise l'état terminal « créée ».
   */
  const readBackCreatedProposal = async (): Promise<ProposalCreationReadBack | null> => {
    const proposalAddress =
      createResult?.readBack?.proposalAddress ??
      reviewedSnapshot?.proposalPda ??
      restoredPendingCreation?.proposalPda ??
      null;
    const transactionAddress =
      createResult?.readBack?.transactionAddress ??
      reviewedSnapshot?.transactionPda ??
      restoredPendingCreation?.transactionPda ??
      null;
    if (proposalAddress === null || transactionAddress === null) return null;
    try {
      const proposalInfo = await connection.getAccountInfo(
        new PublicKey(proposalAddress),
        'confirmed',
      );
      const transactionInfo = await connection.getAccountInfo(
        new PublicKey(transactionAddress),
        'confirmed',
      );
      if (proposalInfo === null || transactionInfo === null) return null;
      const programId = multisig.PROGRAM_ID.toString();
      if (
        proposalInfo.owner.toString() !== programId ||
        transactionInfo.owner.toString() !== programId
      ) {
        return null;
      }
      const [proposal] = multisig.accounts.Proposal.fromAccountInfo(proposalInfo);
      const [vaultTransaction] = multisig.accounts.VaultTransaction.fromAccountInfo(
        transactionInfo,
      );
      return {
        creatorIsApprover: proposal.approved.some(
          (approver) => approver.toBase58() === creator,
        ),
        proposalAddress,
        proposalApprovedCount: proposal.approved.length,
        proposalStatus: proposal.status.__kind,
        transactionAddress,
        transactionIndex: Number(vaultTransaction.index),
        transactionVaultIndex: vaultTransaction.vaultIndex,
      };
    } catch {
      return null;
    }
  };

  /**
   * « Check again » : RELANCE RÉELLE de la vérification, LECTURE SEULE (aucun
   * wallet, aucune signature, aucune soumission). Relit d'abord les comptes
   * créés (preuve POSITIVE) ; sinon délègue à la relecture du parent (booléen
   * CONSERVATEUR). Dans tous les cas, l'ÉTAT de l'écran est mis à jour :
   *   - comptes lisibles        -> état terminal « vérifiée » (écran de succès,
   *                                carte ambre et doublon impossibles) ;
   *   - lecture échouée         -> verification_unavailable ;
   *   - lecture aboutie muette  -> still_unknown.
   */
  const onCheckAfterFailure = async () => {
    if (recoveryCheck === 'checking') return;
    setRecoveryCheck('checking');
    // 1) Preuve POSITIVE : les deux comptes créés sont lisibles on-chain.
    const readBack = await readBackCreatedProposal();
    if (readBack !== null) {
      const verifiedResult: ProposalCreationSignSendResult = {
        blockhash: createResult?.blockhash ?? null,
        confirmed: true,
        confirmationStatus: 'confirmed',
        errorCode: null,
        errorMessage: null,
        lastValidBlockHeight: createResult?.lastValidBlockHeight ?? null,
        readBack,
        signature: createResult?.signature ?? restoredPendingCreation?.signature ?? null,
        signingState: createResult?.signingState,
        validationErrors: [],
        validationWarnings: createResult?.validationWarnings ?? [],
        verified: true,
      };
      // Création PROUVÉE : état TERMINAL (plus aucune invalidation), purge du
      // record en attente, écran de succès. La proposition ne peut plus être
      // recréée en double.
      terminalRef.current = true;
      forgetPendingCreation(pendingCreationScope);
      setRestoredPendingCreation(null);
      setCreateError(null);
      setRecoveryCheck('proposal_found');
      setCreateResult(verifiedResult);
      // Rafraîchit la liste du parent (lecture seule).
      void onCreatedVerified?.();
      return;
    }
    // 2) Sinon : relecture du parent. Le RÉSULTAT est lu (jamais ignoré) :
    // `false` = échec RPC / refresh concurrent / réponse invalide ; `true` =
    // lecture aboutie mais NON probante.
    let outcome: boolean | null = null;
    try {
      outcome = (await onCreatedVerified?.()) ?? null;
    } catch {
      outcome = false;
    }
    setRecoveryCheck(recoveryStateFromRead(outcome));
  };

  /**
   * SORTIE NON DESTRUCTIVE des états ambigus : réutilise la relecture LECTURE
   * SEULE du parent (jamais dupliquée) puis revient à la liste. Aucun wallet,
   * aucune signature, aucune construction, aucune soumission.
   */
  const onBackToProposalsFromRecovery = () => {
    void onCreatedVerified?.();
    onDone();
  };

  /**
   * §2.5 — RETOUR AU PREMIER PLAN (le wallet rend le focus) : LECTURE SEULE
   * uniquement. Jamais de wallet, jamais de nouvelle creation automatique : on
   * ne fait que relire l'etat on-chain quand une tentative reste non verifiee.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (createResult === null || createResult.verified === true) return;
      void onCheckAfterFailure();
    });
    return () => subscription.remove();
  }, [createResult, onCheckAfterFailure]);

  // CTA de création UNIQUE : visible tant que la création n'est pas vérifiée
  // (ou qu'une reprise sans signature reste possible).
  // Invariant « instantane revu » : la creation n'est permise que si la
  // simulation a reussi, que l'instantane existe, qu'il correspond ENCORE a
  // TOUS les parametres materiels courants, et qu'aucun envoi n'est en vol.
  const snapshotStillMatches =
    reviewedSnapshot !== null &&
    snapshotMatchesForm(reviewedSnapshot, {
      destination,
      amountLamports: Number.isFinite(lamports) && lamports > 0 ? lamports : null,
      memo,
      bufferLamports: maxBufferLamports,
      cluster: 'devnet',
      vaultAddress,
    });
  // AUCUNE seconde création depuis un résultat NON PROUVÉ : tant que l'échec
  // wallet reste inconnu, `canCreate` est faux. Seul `safe_to_retry` (preuve que
  // rien n'a été enregistré) lèverait ce verrou — et il n'a AUCUN producteur
  // aujourd'hui. Une erreur réseau ou une promesse terminée ne le lèvent jamais.
  const recoveryBlocksCreation = createUncertainRaw !== null && recoveryCheck !== 'safe_to_retry';

  /**
   * §2 — SIGNATURE REELLE PRESENTE (resultat du montage courant, OU record
   * restaure depuis la memoire de module apres un remontage), relecture
   * indisponible. Tant que ce resultat n'est pas verifie, AUCUNE seconde creation
   * n'est possible : le CTA disparait, aucun wallet ne se rouvre, aucune reprise
   * n'est proposee, et aucun echec n'est affiche en rouge.
   */
  const signedPendingVerification =
    restoredPendingCreation !== null ||
    (createResult !== null && createResult.signature !== null && createResult.verified !== true);

  /**
   * INCOHÉRENCE D'ÉTAT CORRIGÉE (étape « 1 Details » + carte « sent / pending »).
   *
   * Une proposition SIGNÉE mais NON vérifiée est un état POST-CRÉATION : tant que
   * la vérification n'est pas résolue, l'écran ne doit JAMAIS rester ou revenir à
   * l'étape Details. Sans cette garde, un REMONTAGE (état restauré depuis la
   * mémoire de module) démarre à `step = 'details'` et afficherait « 1 Details »
   * en même temps que la carte ambre. On replace donc le flux sur l'étape Sign
   * (celle d'où la création a été envoyée) : le formulaire Details disparaît et
   * la carte reste seule, cohérente avec l'indicateur d'étapes.
   */
  useEffect(() => {
    if (!signedPendingVerification) return;
    if (step === 'details') setStep('sign');
  }, [signedPendingVerification, step]);

  /**
   * §2.4 — Donnees BRUTES du resultat non verifie : uniquement dans la section
   * repliable de depannage, jamais dans le parcours principal.
   */
  const pendingVerificationRaw =
    createResult !== null
      ? [
          `signature: ${createResult.signature ?? 'none'}`,
          `confirmed: ${createResult.confirmed === true ? 'yes' : 'no'}`,
          `read-back verified: ${createResult.verified === true ? 'yes' : 'no'}`,
          createResult.errorMessage === null ? null : `error: ${createResult.errorMessage}`,
          createResult.validationErrors.length === 0
            ? null
            : `details: ${createResult.validationErrors.join(' ')}`,
        ]
          .filter((line) => line !== null)
          .join('\n')
      : restoredPendingCreation === null
        ? null
        : [
            `signature: ${restoredPendingCreation.signature}`,
            `recorded at: ${new Date(restoredPendingCreation.createdAt).toISOString()}`,
            `expected proposal: ${restoredPendingCreation.proposalPda}`,
            `expected transaction: ${restoredPendingCreation.transactionPda}`,
          ].join('\n');

  // Etat d'ANNULATION wallet : le CTA primaire « Create proposal » est RETIRÉ.
  // La carte « Creation cancelled » porte déjà ses actions (« Try again » et
  // « Edit details ») : laisser « Create proposal » produirait deux actions de
  // création concurrentes. La condition est STRICTEMENT limitée à la présence
  // d'une annulation : le cas nominal de Review (aucune annulation) conserve son
  // bouton « Create proposal ».
  const canCreate =
    createCancellationRaw === null &&
    pipeline.status === 'ready' &&
    snapshotStillMatches &&
    !creating &&
    !sendAttemptedRef.current &&
    !recoveryBlocksCreation &&
    !signedPendingVerification &&
    (createResult === null || (attemptOutcome?.allowNewAttempt ?? false));

  // AVERTISSEMENT UTILE, une seule ligne HUMAINE. FAIT STRICTEMENT FACTUEL :
  // le preflight ne pousse cette phrase que lorsque le montant demande EGALE le
  // solde du vault (son propre test interne), soit un solde restant EXACTEMENT
  // zero. Aucune recommandation de reserve, aucune affirmation sur la fermeture
  // du compte ou le minimum de rente.
  const vaultEmptied =
    preflight !== null && preflight.warnings.some((warning) => /would empty the vault/i.test(warning));

  // Review nominale = simulation RÉUSSIE : « Advanced diagnostics » n'est rendu
  // QUE hors de ce cas. Helper (et non un booléen mémorisé) : un booléen ferait
  // hériter le type « non ready » à l'intérieur du bloc, ce qui invaliderait
  // les comparaisons de statut.
  const advancedDiagnosticsVisible = (): boolean => pipeline.status !== 'ready';

  // Copie et disponibilité des actions du contrôle de reprise : un état = une
  // phrase = des actions. Aucune ne se déduit d'une promesse terminée.
  const recoveryTitle =
    recoveryCheck === 'checking'
      ? 'Checking on-chain status…'
      : recoveryCheck === 'verification_unavailable'
        ? 'Verification unavailable'
        : recoveryCheck === 'safe_to_retry'
          ? 'Proposal was not created'
          : 'Result unknown';
  const recoveryMessage =
    recoveryCheck === 'checking'
      ? 'Multisig is checking whether the proposal was created.'
      : recoveryCheck === 'verification_unavailable'
        ? 'Multisig could not check whether the proposal was created. Restore your connection and check again.'
        : recoveryCheck === 'safe_to_retry'
          ? 'The previous attempt was not recorded on-chain. You can safely try again.'
          : 'Multisig could not determine whether the proposal was created. Check your proposals before trying again.';
  /** Try again : activé dans le SEUL état prouvé (règle pure, testée). */

  // Création VÉRIFIÉE : état TERMINAL. L'écran de succès REMPLACE tout le
  // parcours (formulaire ET revue) : le reçu n'est jamais empilé en bas d'une
  // longue page. La barre d'étapes disparaît au profit d'un état dédié.
  if (createResult !== null && createResult.verified === true) {
    const createdIndex = createResult.readBack?.transactionIndex ?? null;
    return (
      <KeyboardAvoidingView behavior="padding" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          style={styles.scrollView}
        >
          <View style={styles.headerRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to multisig details"
              onPress={onBack}
              style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            >
              <Text style={styles.backGlyph}>‹</Text>
            </Pressable>
            <DevnetPill />
          </View>

          <Text style={styles.kicker}>DEVNET · SOL TRANSFER</Text>

          <View style={[styles.successBox, styles.successCard]}>
            <Text style={styles.successTitle}>Proposal created</Text>
            {reviewedSnapshot !== null ? (
              <>
                <Text style={styles.fieldValue}>
                  {formatSolAmount(reviewedSnapshot.amountLamports)}
                </Text>
                <Text selectable style={styles.monoValue}>
                  to {abbreviateAddress(reviewedSnapshot.destination)}
                </Text>
              </>
            ) : null}
            {createdIndex !== null ? (
              <Text style={styles.fieldNote}>Proposal #{createdIndex}</Text>
            ) : null}
            {createResult.readBack !== null ? (
              <Text style={styles.fieldNote}>
                {createResult.readBack.proposalApprovedCount ?? 0} of {threshold} approvals collected
              </Text>
            ) : null}
            <Text style={styles.successLine}>✓ Verified on-chain</Text>

            {onOpenCreatedProposal !== undefined && createdIndex !== null ? (
              <View style={styles.actionSpacing}>
                <PillButton
                  accessibilityLabel="Open proposal"
                  label="Open proposal"
                  onPress={() => onOpenCreatedProposal(createdIndex)}
                />
              </View>
            ) : null}
            <View style={styles.actionSpacing}>
              <PillButton
                accessibilityLabel="Back to proposals"
                label="Back to proposals"
                onPress={onDone}
                variant="secondary"
              />
            </View>

            {/* RECU TECHNIQUE : divulgation à chevron, séparée du résumé par un
                divider du design system. Rangées LIBELLÉ + valeur, jamais un
                paragraphe continu. Les valeurs COMPLÈTES restent accessibles via
                le contrôle de copie EXISTANT (src/ui/clipboard). */}
            <View style={styles.successDivider}>
              <DisclosureRow
                accessibilityLabel="Toggle technical receipt"
                expanded={receiptOpen}
                label="Technical receipt"
                onPress={() => setReceiptOpen((previous) => !previous)}
              />
              {receiptOpen ? (
                <View>
                  <View style={styles.receiptRow}>
                    <Text style={styles.receiptLabel}>Signature</Text>
                    <View style={styles.receiptValueRow}>
                      <Text selectable style={styles.monoValue}>
                        {createResult.signature === null
                          ? 'unavailable'
                          : abbreviateAddress(createResult.signature)}
                      </Text>
                      {createResult.signature !== null ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Copy signature"
                          onPress={() => copyReceiptValue('signature', createResult.signature)}
                        >
                          <Text style={styles.receiptCopy}>
                            {copyFeedback !== null && copyFeedback.field === 'signature'
                              ? copyFeedback.ok
                                ? 'Copied ✓'
                                : 'Copy failed'
                              : 'Copy'}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                  {createResult.readBack !== null ? (
                    <>
                      <View style={styles.receiptRow}>
                        <Text style={styles.receiptLabel}>Proposal account</Text>
                        <View style={styles.receiptValueRow}>
                          <Text selectable style={styles.monoValue}>
                            {abbreviateAddress(createResult.readBack.proposalAddress)}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Copy proposal account"
                            onPress={() =>
                              copyReceiptValue('proposal', createResult.readBack?.proposalAddress)
                            }
                          >
                            <Text style={styles.receiptCopy}>
                              {copyFeedback !== null && copyFeedback.field === 'proposal'
                                ? copyFeedback.ok
                                  ? 'Copied ✓'
                                  : 'Copy failed'
                                : 'Copy'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                      <View style={styles.receiptRow}>
                        <Text style={styles.receiptLabel}>On-chain proposal status</Text>
                        <Text selectable style={styles.monoValue}>
                          {createResult.readBack.proposalStatus ?? 'unknown'}
                        </Text>
                      </View>
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        style={styles.scrollView}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to multisig details"
            onPress={onBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <DevnetPill />
        </View>

        <Text style={styles.kicker}>DEVNET · SOL TRANSFER</Text>
        <Text style={styles.title}>New proposal</Text>
        {/* Sous-titre recentre sur CE QUE FAIT l'ecran. La promesse « rien n'est
            signe » n'apparait plus qu'UNE fois, sous le bouton Review, au point
            de decision : l'ancien doublon (haut + bas) diluait le message. */}
        <Text style={styles.subtitle}>
          A SOL transfer paid by the vault. Set the destination and amount, then review.
        </Text>

        {/* Indicateur d'étapes : il lit l'ÉTAPE RÉELLE (Details / Review / Sign). */}
        <View style={styles.steps}>
          <Text style={step === 'details' ? styles.stepActive : styles.stepIdle}>1 Details</Text>
          <Text style={step === 'review' ? styles.stepActive : styles.stepIdle}>2 Review</Text>
          <Text style={step === 'sign' ? styles.stepActive : styles.stepIdle}>3 Sign</Text>
        </View>

        {/* ETAPE 1 — DETAILS : formulaire editable. Il est MASQUE des qu'on passe
            en Review (aucune page qui grandit, aucun defilement impose). */}
        {step === 'details' ? (
        <View style={styles.block}>
          {/* Destination : le collage passe par le MEME setter qu'une saisie
              manuelle, donc le build et la simulation sont invalidés pareil. */}
          <AddressInput
            label="Destination"
            onChangeText={setDestination}
            placeholder="Public address"
            testID="proposal-destination"
            value={destination}
          />

          <Text style={styles.fieldLabel}>Amount (SOL)</Text>
          <View style={styles.amountField}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="decimal-pad"
              onChangeText={setSolText}
              placeholder="e.g. 300"
              placeholderTextColor={colors.textMuted}
              style={styles.amountInput}
              value={solText}
            />
            <Text style={styles.amountUnit}>SOL</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                maxTransferableZero
                  ? 'Max — no SOL available'
                  : 'Fill the maximum transferable amount'
              }
              onPress={() => {
                void onMax();
              }}
              style={[styles.amountMax, maxTransferableZero && styles.amountMaxMuted]}
            >
              <Text
                style={[styles.amountMaxText, maxTransferableZero && styles.amountMaxTextMuted]}
              >
                Max
              </Text>
            </Pressable>
          </View>
          <Text style={styles.fieldNote}>
            {Number.isFinite(lamports) && lamports > 0
              ? `Proposal amount: ${formatSolAmount(lamports)}`
              : parsedSol.ok
                ? 'Enter an amount to continue.'
                : SOL_AMOUNT_MESSAGES[parsedSol.reason]}
          </Text>
          {maxZeroNotice && maxTransferableZero ? (
            <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBox]} tone="warning">
              <InfoText tone="warning">No SOL in the vault to send</InfoText>
            </InfoBox>
          ) : null}

          {/* « More options » : replié par défaut. Contient le buffer EXPLICITE,
              le bouton Max et le mémo optionnel. Aucun effet sur les validations. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle more options"
            accessibilityState={{ expanded: moreOptionsOpen }}
            onPress={() => setMoreOptionsOpen((previous) => !previous)}
            style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
          >
            <Text style={styles.toggleText}>
              {moreOptionsOpen ? 'Hide more options' : 'More options'}
            </Text>
          </Pressable>

          {moreOptionsOpen ? (
            <View style={styles.moreOptions}>
              <Text style={styles.fieldLabel}>Optional safety buffer (SOL)</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="decimal-pad"
                onChangeText={setBufferText}
                placeholder="e.g. 0.001"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={bufferText}
              />
              <Text style={styles.fieldNote}>
                Amount kept in the Main vault when using Max.
              </Text>

              {maxSummaryVisible && maxPlan !== null ? (
                <Text style={styles.fieldNote}>
                  Max: {formatSolAmount(maxPlan.amountLamports ?? 0)} available
                </Text>
              ) : maxPlan !== null && !maxPlan.ready ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorTitle}>{maxPlan.label}</Text>
                  <Text style={styles.fieldNote}>{maxPlan.hint}</Text>
                </View>
              ) : null}

              <Text style={styles.fieldLabel}>Memo (optional)</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                onChangeText={setMemo}
                placeholder="What is this transfer for?"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.memoInput]}
                value={memo}
              />
            </View>
          ) : null}
        </View>
        ) : null}

        {/* Etats utilisateur de la SAISIE — etape Details uniquement. */}
        {step === 'details' ? (
        <>
        {build.errors.length > 0 && amountAttempted ? (
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.errorTop]} tone="error">
            <InfoText tone="error">
              {parsedSol.ok ? 'Not ready' : SOL_AMOUNT_MESSAGES[parsedSol.reason]}
            </InfoText>
            {build.errors
              .filter((error) => !/lamports/i.test(error))
              .map((error) => (
                <InfoText key={error} tone="error">
                  · {proposalCreationErrorMessage(error)}
                </InfoText>
              ))}
          </InfoBox>
        ) : null}
        {/* Une seule indication de montant manquant, près du champ. La raison
            « destination » n'apparait qu'APRES une saisie (jamais a vide) et
            sous forme de message utilisateur (jamais de code interne). */}
        {!amountAttempted && destinationAttempted && hasInvalidDestinationError(build.errors) ? (
          <Text style={styles.fieldNote}>{INVALID_DESTINATION_MESSAGE}</Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: pipeline.status === 'working', disabled: !canRunPipeline }}
          disabled={!canRunPipeline}
          onPress={() => {
            void runPipeline();
          }}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.primaryPressed,
            !canRunPipeline && styles.disabled,
          ]}
        >
          {pipeline.status === 'working' ? (
            <ActivityIndicator color={colors.onLight} />
          ) : (
            <Text style={styles.buttonText}>Review proposal</Text>
          )}
        </Pressable>
        <Text style={styles.fieldNote}>
          Checks the vault balance and simulates the transaction. Nothing is signed or sent.
        </Text>
        </>
        ) : null}

        {pipeline.status === 'error' ? (
          insufficientVaultBalance !== null ? (
            <>
              {/* Message utilisateur en SOL — jamais « lamports » au premier niveau. */}
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.errorTop]} tone="error">
                <InfoText tone="error">Insufficient vault balance</InfoText>
                <InfoText tone="error">
                  Requested: {formatSolAmount(insufficientVaultBalance.requestedLamports)}
                </InfoText>
                <InfoText tone="error">
                  Available: {formatSolAmount(insufficientVaultBalance.availableLamports)}
                </InfoText>
                <InfoText tone="error">
                  Missing: {formatSolAmount(insufficientVaultBalance.missingLamports)}
                </InfoText>
                <InfoText tone="error">Nothing was signed or sent.</InfoText>
              </InfoBox>
              <DisclosureRow
                accessibilityLabel="Toggle troubleshooting details"
                expanded={troubleshootingOpen}
                inset={spacing.md}
                label="Troubleshooting details"
                onPress={() => setTroubleshootingOpen((previous) => !previous)}
              />
              {troubleshootingOpen ? (
                <Card style={styles.block}>
                  <Text style={styles.fieldNote}>Error name: InsufficientVaultBalance</Text>
                  <Text selectable style={styles.monoValue}>
                    Requested lamports: {insufficientVaultBalance.requestedLamports}
                  </Text>
                  <Text selectable style={styles.monoValue}>
                    Available lamports: {insufficientVaultBalance.availableLamports}
                  </Text>
                  <Text selectable style={styles.monoValue}>
                    Missing lamports: {insufficientVaultBalance.missingLamports}
                  </Text>
                  <Text selectable style={styles.fieldNote}>{pipeline.message}</Text>
                </Card>
              ) : null}
            </>
          ) : (
            <InfoBox glyph="⚠" style={[styles.infoBox, styles.errorTop]} tone="error">
              <InfoText tone="error">Pipeline stopped before any signature</InfoText>
              <InfoText tone="error">{pipeline.message}</InfoText>
            </InfoBox>
          )
        ) : null}

        {/* ANNULATION wallet : COMPACTE et EN TÊTE de la Review (juste au-dessus
            de la carte de revue), pour être vue sans défiler. Un SEUL état
            humain — jamais deux blocs rouges. L'annulation n'est pas un échec
            confirmé : ton neutre, action de reprise, et le brut
            (CancellationException / EUNSPECIFIED) replié. */}
        {createCancellationRaw !== null ? (
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBoxTop]} tone="warning">
            <InfoText tone="warning">Creation cancelled</InfoText>
            <InfoText tone="warning">
              Nothing was signed or sent. You can try again when you're ready.
            </InfoText>
            <View style={styles.actionSpacing}>
              {/* Reprise : action SECONDAIRE — l'unique action PRIMAIRE reste
                  « Create proposal » de la carte de revue (juste en dessous),
                  pour ne pas offrir deux CTA dominants concurrents. */}
              <PillButton
                accessibilityLabel="Try again"
                label="Try again"
                onPress={onCreate}
                variant="secondary"
              />
            </View>
            <View style={styles.actionSpacing}>
              <PillButton
                accessibilityLabel="Edit details"
                label="Edit details"
                onPress={onEditDetails}
                variant="secondary"
              />
            </View>
            <DisclosureRow
              accessibilityLabel="Toggle troubleshooting details"
              expanded={troubleshootingOpen}
              inset={spacing.md}
              label="Troubleshooting details"
              onPress={() => setTroubleshootingOpen((previous) => !previous)}
            />
            {troubleshootingOpen ? (
              <View style={styles.block}>
                <Text selectable style={styles.monoValue}>
                  {createCancellationRaw}
                </Text>
              </View>
            ) : null}
          </InfoBox>
        ) : null}

        {simulation !== null && reviewedSnapshot !== null && preflight !== null ? (
          <View
            accessibilityLabel={
              pipeline.status === 'ready' ? 'Simulation succeeded' : 'Simulation did not pass'
            }
            style={pipeline.status === 'ready' ? styles.successBox : styles.noticeBox}
          >
            <Text style={pipeline.status === 'ready' ? styles.successTitle : styles.noticeTitle}>
              {pipeline.status === 'ready' ? 'Simulation passed' : 'Simulation did not pass'}
            </Text>
            <Text style={styles.fieldValue}>
              Amount: {formatSolAmount(reviewedSnapshot.amountLamports)}
            </Text>
            {/* Destination COMPLÈTE, UNE seule fois, sur sa propre ligne (repli
                sûr si besoin). La valeur copiée/signée n'est jamais transformée. */}
            <Text style={styles.fieldLabel}>Destination</Text>
            <Text selectable style={styles.monoValue}>
              {reviewedSnapshot.destination}
            </Text>
            <Text style={styles.fieldValue}>
              Estimated creation cost:{' '}
              {reviewedSnapshot.estimatedCreatorBalanceDelta === null
                ? 'not measurable'
                : `≈ ${formatRoundedSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))} SOL`}
            </Text>
            <Text style={styles.fieldNote}>
              Creating this proposal does not move the funds. The transfer only happens after
              approval and execution.
            </Text>

            {/* CTA PRIMAIRE AVANT l'aide et les diagnostics : visible sans
                défilement. Le formulaire est masqué en Review. */}
            {/* AVERTISSEMENT VAULT VIDE : une seule ligne, uniquement dans ce cas. */}
            {/* AUDIT (§3) : `proposalCreationPreflight` declenche cet
                avertissement quand le montant demande EGALE le solde du vault
                (« la totalite du solde disponible est utilisee »). Aucune autre
                affirmation n'est faite : ni fermeture de compte, ni rente. */}
            {vaultEmptied ? (
              <Text style={styles.fieldNote}>This transfer will leave the vault empty.</Text>
            ) : null}
            {canCreate ? (
              <View style={styles.actionSpacing}>
                <PillButton
                  accessibilityLabel="Create proposal"
                  busy={creating}
                  disabled={creating}
                  label="Create proposal"
                  onPress={onCreate}
                />
              </View>
            ) : null}
            {createResult === null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit details"
                onPress={onEditDetails}
                style={({ pressed }) => [
                  styles.secondaryTextAction,
                  pressed && styles.togglePressed,
                ]}
              >
                <Text style={styles.secondaryTextLabel}>Edit details</Text>
              </Pressable>
            ) : null}

            {/* Section technique FACULTATIVE, fermée par défaut : aucun CTA, et
                elle ne modifie ni le build, ni la simulation, ni la transaction.
                Elle n'est rendue QUE sur un échec : une simulation réussie
                (Review nominale) n'affiche AUCUN diagnostic technique. */}
            {advancedDiagnosticsVisible() ? (
              <>
                <DisclosureRow
                  accessibilityLabel="Toggle advanced diagnostics"
                  expanded={advancedOpen}
                  label="Advanced diagnostics"
                  onPress={() => setAdvancedOpen((previous) => !previous)}
                />

                {advancedOpen ? (
                  <View style={styles.block}>
                    {/* DIAGNOSTICS SEULS (§2) : uniquement des champs structures et
                        utiles a l'inspection. Ni pedagogie, ni console de logs, ni
                        unites brutes, ni compute units, ni index de transaction. */}
                    <Text style={styles.fieldNote}>Detailed cost estimate</Text>
                    <Text selectable style={styles.monoValue}>
                      {reviewedSnapshot.estimatedCreatorBalanceDelta === null
                        ? 'not measurable'
                        : formatSolAmount(Math.abs(reviewedSnapshot.estimatedCreatorBalanceDelta))}
                    </Text>
                    <Text style={styles.fieldNote}>Network</Text>
                    <Text selectable style={styles.monoValue}>{reviewedSnapshot.cluster}</Text>
                    <Text style={styles.fieldNote}>Simulation status</Text>
                    <Text selectable style={styles.monoValue}>
                      {pipeline.status === 'ready' ? 'passed' : 'did not pass'}
                    </Text>

                    {/* Adresses internes : compactes, abregees, valeur COMPLETE copiable. */}
                    <Text style={styles.fieldNote}>Transaction account</Text>
                    <View style={styles.receiptValueRow}>
                      <Text selectable style={styles.monoValue}>
                        {build.transactionPda === null
                          ? 'unknown'
                          : abbreviateAddress(build.transactionPda)}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Copy transaction account"
                        onPress={() => copyReceiptValue('transaction', build.transactionPda)}
                      >
                        <Text style={styles.receiptCopy}>
                          {copyFeedback !== null && copyFeedback.field === 'transaction'
                            ? copyFeedback.ok
                              ? 'Copied ✓'
                              : 'Copy failed'
                            : 'Copy'}
                        </Text>
                      </Pressable>
                    </View>
                    <Text style={styles.fieldNote}>Proposal account</Text>
                    <View style={styles.receiptValueRow}>
                      <Text selectable style={styles.monoValue}>
                        {build.proposalPda === null
                          ? 'unknown'
                          : abbreviateAddress(build.proposalPda)}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Copy proposal account"
                        onPress={() => copyReceiptValue('proposal', build.proposalPda)}
                      >
                        <Text style={styles.receiptCopy}>
                          {copyFeedback !== null && copyFeedback.field === 'proposal'
                            ? copyFeedback.ok
                              ? 'Copied ✓'
                              : 'Copy failed'
                            : 'Copy'}
                        </Text>
                      </Pressable>
                    </View>

                    {/* DEPANNAGE (§2) : uniquement quand un ECHEC a des informations
                        techniques a inspecter. JAMAIS sur une simulation nominale. */}
                    {pipeline.status !== 'ready' && simulation.logs.length > 0 ? (
                      <>
                        <DisclosureRow
                          accessibilityLabel="Toggle troubleshooting details"
                          expanded={simulationLogsOpen}
                          label="Troubleshooting details"
                          onPress={() => setSimulationLogsOpen((previous) => !previous)}
                        />
                        {simulationLogsOpen
                          ? simulation.logs.map((log, position) => (
                              <Text key={`simulation-log-${position}`} style={styles.monoValue}>
                                {log}
                              </Text>
                            ))
                          : null}
                      </>
                    ) : null}
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}

        {/* EDUCATION SEULE : une courte explication HUMAINE, repliée par défaut.
            Les notes d'implementation ne sont rendues NULLE PART. */}
        {/* EN-TÊTE ALIGNÉ sur « Advanced diagnostics » : ce dernier vit dans la
            carte de revue (padding `spacing.md`) ; on applique donc le MÊME
            retrait ici pour une seule colonne de libellés, quel que soit le
            conteneur. Le contenu reste identique. */}
        <View style={styles.disclosureIndent}>
          <DisclosureRow
            accessibilityLabel="Toggle how proposal creation works"
            expanded={howItWorksOpen}
            label="How proposal creation works"
            onPress={() => setHowItWorksOpen((previous) => !previous)}
          />
        </View>
        {howItWorksOpen ? (
          <InfoBox style={styles.infoBox}>
            <InfoText>
              Creating a proposal records the transfer instructions on Devnet. Funds only move
              after the required approvals are collected and the proposal is executed.
            </InfoText>
          </InfoBox>
        ) : null}

        {creating ? (
          <Text style={styles.fieldNote}>Waiting for the wallet…</Text>
        ) : null}

        {/* ÉCHEC NON CLASSÉ : état CONSERVATEUR et DISCRIMINÉ. Tant que rien n'est
            prouvé, Try again reste DÉSACTIVÉ et aucune seconde création n'est
            possible. Aucune phrase ne promet une reprise sûre. */}
        {createUncertainRaw !== null ? (
          recoveryCheck === 'proposal_found' ? (
            /* Preuve POSITIVE : actions normales, jamais Try again. */
            <InfoBox glyph="✓" style={styles.infoBox} tone="success">
              <InfoText tone="success">Proposal created</InfoText>
              <InfoText tone="success">Verified on-chain</InfoText>
              <View style={styles.actionSpacing}>
                <PillButton
                  accessibilityLabel="Back to proposals"
                  label="Back to proposals"
                  onPress={onDone}
                />
              </View>
            </InfoBox>
          ) : (
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBoxTop]} tone="warning">
            <InfoText tone="warning">{recoveryTitle}</InfoText>
            <InfoText tone="warning">{recoveryMessage}</InfoText>
            {/* « Check again » : seule action capable de faire progresser un
                résultat inconnu. Le wallet n'est JAMAIS ouvert ici. */}
            <View style={styles.actionSpacing}>
              <PillButton
                accessibilityLabel="Check again"
                busy={recoveryCheck === 'checking'}
                disabled={recoveryCheck === 'checking'}
                label={recoveryCheck === 'checking' ? 'Checking…' : 'Check again'}
                onPress={() => {
                  void onCheckAfterFailure();
                }}
              />
            </View>
            {/* SORTIE NON DESTRUCTIVE : disponible dans TOUS les états ambigus
                (jamais dans l'état prouvé sûr). Relecture lecture seule + retour. */}
            {recoveryCheck === 'safe_to_retry' ? null : (
              <View style={styles.actionSpacing}>
                <PillButton
                  accessibilityLabel="Back to proposals"
                  label="Back to proposals"
                  onPress={onBackToProposalsFromRecovery}
                  variant="secondary"
                />
              </View>
            )}
            <View style={styles.actionSpacing}>
              <PillButton
                accessibilityLabel="Try again"
                disabled={!canRetryAfterFailure(recoveryCheck)}
                label="Try again"
                onPress={onCreate}
                variant="secondary"
              />
            </View>
            <View style={styles.actionSpacing}>
              <PillButton
                accessibilityLabel="Edit details"
                label="Edit details"
                onPress={onEditDetails}
                variant="secondary"
              />
            </View>
            <DisclosureRow
              accessibilityLabel="Toggle troubleshooting details"
              expanded={troubleshootingOpen}
              inset={spacing.md}
              label="Troubleshooting details"
              onPress={() => setTroubleshootingOpen((previous) => !previous)}
            />
            {troubleshootingOpen ? (
              <View style={styles.block}>
                <Text selectable style={styles.monoValue}>
                  {createUncertainRaw}
                </Text>
              </View>
            ) : null}
          </InfoBox>
          )
        ) : null}

        {/* §2 — SIGNATURE PRESENTE, RELECTURE INDISPONIBLE : UN SEUL etat, ton
            avertissement (jamais rouge : l'echec n'est pas confirme). Aucune
            action de creation, aucune reprise : le wallet ne se rouvre jamais. */}
        {signedPendingVerification && step !== 'details' ? (
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBoxTop]} tone="warning">
            {/* EN-TÊTE COMPACT : la carte « sent / pending » est un REPLI, FERMÉ
                par défaut. Replié, le titre dit déjà tout l'essentiel (« envoyé /
                non vérifié ») — l'utilisateur n'a pas à déplier pour comprendre
                qu'un envoi a peut-être eu lieu. Le chevron suit la convention des
                autres replis de l'app (◂ replié / ▾ déplié). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle proposal sent details"
              accessibilityState={{ expanded: pendingVerificationOpen }}
              onPress={() => setPendingVerificationOpen((previous) => !previous)}
              style={({ pressed }) => [styles.pendingHeader, pressed && styles.togglePressed]}
            >
              <Text style={styles.pendingHeaderTitle}>Proposal sent — verification pending</Text>
              <Text style={styles.pendingHeaderChevron}>{pendingVerificationOpen ? '▾' : '◂'}</Text>
            </Pressable>
            {/* Repli : l'en-tête compact (titre + chevron) reste visible ; le corps
                et les actions ci-dessous ne sont rendus qu'UNE FOIS déplié. */}
            {pendingVerificationOpen ? (
              <>
                <InfoText tone="warning">
                  Your proposal was signed and sent from this device. Multisig couldn't verify it yet
                  because the network is unavailable.
                </InfoText>
                {/* RECOMMANDATION (jamais un fait) : éviter de recréer un doublon.
                    L'app n'a PAS pu prouver la création : elle ne l'affirme pas. */}
                <InfoText tone="warning">
                  Open your proposals when you're back online — if it was accepted, it will be there.
                  Don't create it again without checking first.
                </InfoText>
                {recoveryCheck === 'verification_unavailable' ? (
                  <InfoText tone="warning">Still no connection to verify it yet.</InfoText>
                ) : null}
                <View style={styles.actionSpacing}>
                  <PillButton
                    accessibilityLabel="Check again"
                    busy={recoveryCheck === 'checking'}
                    disabled={recoveryCheck === 'checking'}
                    label={recoveryCheck === 'checking' ? 'Checking…' : 'Check again'}
                    onPress={() => {
                      void onCheckAfterFailure();
                    }}
                  />
                </View>
                <View style={styles.actionSpacing}>
                  <PillButton
                    accessibilityLabel="Back to proposals"
                    label="Back to proposals"
                    onPress={onBackToProposalsFromRecovery}
                    variant="secondary"
                  />
                </View>
                <DisclosureRow
                  accessibilityLabel="Toggle troubleshooting details"
                  expanded={troubleshootingOpen}
                  inset={spacing.md}
                  label="Troubleshooting details"
                  onPress={() => setTroubleshootingOpen((previous) => !previous)}
                />
                {troubleshootingOpen ? (
                  <View style={styles.block}>
                    <Text selectable style={styles.monoValue}>
                      {pendingVerificationRaw}
                    </Text>
                    {createError !== null ? (
                      <Text selectable style={styles.monoValue}>
                        {createError}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </>
            ) : null}
          </InfoBox>
        ) : null}

        {createResult !== null && !signedPendingVerification ? (
          <View
            style={
              attemptOutcome !== null && attemptOutcome.tone === 'success'
                ? styles.successBox
                : styles.errorBox
            }
          >
            <Text
              style={
                attemptOutcome !== null && attemptOutcome.tone === 'success'
                  ? styles.successTitle
                  : styles.errorTitle
              }
            >
              {/* Sans signature, jamais « Sent » : le libellé vient du verdict. */}
              {attemptOutcome?.label ?? 'Proposal created and verified'}
            </Text>
            <Text selectable style={styles.monoValue}>
              Signature: {createResult.signature ?? 'none'}
            </Text>
            {createResult.readBack !== null ? (
              <>
                <Text style={styles.monoValue}>
                  Proposal: {createResult.readBack.proposalStatus ?? 'unknown'} ·{' '}
                  {createResult.readBack.proposalApprovedCount ?? 0}{' '}
                  {(createResult.readBack.proposalApprovedCount ?? 0) === 1
                    ? 'approval collected'
                    : 'approvals collected'}
                </Text>
                <Text style={styles.monoValue}>
                  Transaction index: {createResult.readBack.transactionIndex ?? 'unknown'} ·
                  vault index {createResult.readBack.transactionVaultIndex ?? 'unknown'}
                </Text>
                <Text style={styles.monoValue}>
                  Creator recorded as approver:{' '}
                  {createResult.readBack.creatorIsApprover === null
                    ? 'not observable'
                    : createResult.readBack.creatorIsApprover
                      ? 'yes'
                      : 'no'}
                </Text>
                <Text selectable style={styles.monoValue}>
                  {createResult.readBack.proposalAddress}
                </Text>
              </>
            ) : null}
            {attemptOutcome !== null && attemptOutcome.tone === 'success' ? (
              <>
                <Text style={styles.fieldNote}>
                  {postCreate === 'refreshing'
                    ? 'Refreshing proposals…'
                    : postCreate === 'failed'
                      ? 'Proposal created, but the proposal list could not be refreshed.'
                      : 'The proposal list was refreshed from the chain.'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open the created proposal"
                  disabled={
                    createResult.readBack === null ||
                    createResult.readBack.transactionIndex === null
                  }
                  onPress={() => {
                    const createdIndex = createResult.readBack?.transactionIndex ?? null;
                    if (createdIndex !== null) {
                      onOpenCreatedProposal?.(createdIndex);
                    }
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.secondaryPressed,
                    (createResult.readBack === null ||
                      createResult.readBack.transactionIndex === null) &&
                      styles.disabled,
                  ]}
                >
                  <Text style={styles.secondaryText}>Open proposal</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to proposals list"
              disabled={postCreate === 'refreshing'}
              onPress={onDone}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.secondaryPressed,
                postCreate === 'refreshing' && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryText}>
                {postCreate === 'refreshing' ? 'Refreshing proposals…' : 'Go to Proposals'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Erreur de création : le message BRUT vit UNIQUEMENT dans le repli
            « Troubleshooting details » de la carte ambre ci-dessus (jamais un
            encart rouge autonome au premier niveau). */}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
          onPress={onBack}
          style={({ pressed }) => [styles.cancel, pressed && styles.secondaryPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardAvoider: { backgroundColor: colors.background, flex: 1, width: '100%' },
  scrollView: { backgroundColor: colors.background, flex: 1, width: '100%' },
  container: {
    alignItems: 'stretch',
    backgroundColor: colors.background,
    flexGrow: 1,
    padding: spacing.lg,
    // Assez d'espace sous le contenu pour que MEMO et « Review proposal »
    // restent atteignables par scroll quand le clavier est ouvert.
    paddingBottom: 160,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  backButtonPressed: { backgroundColor: colors.surface },
  backGlyph: { color: colors.text, fontSize: 24, lineHeight: 26 },
  kicker: {
    color: colors.textMuted,
    fontSize: typography.micro,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: typography.screenTitle,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  steps: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: spacing.lg,
    marginTop: spacing.lg,
  },
  stepActive: {
    color: colors.mint,
    fontSize: typography.caption,
    fontWeight: '800',
    marginRight: spacing.lg,
  },
  stepIdle: {
    color: colors.textMuted,
    fontSize: typography.caption,
    fontWeight: '700',
    marginRight: spacing.lg,
  },
  block: { alignSelf: 'stretch' },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: typography.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    textTransform: 'uppercase',
  },
  /** Champ Amount : texte a gauche, unite et « Max » a droite (modele Paste). */
  amountField: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.sm,
    minHeight: 52,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
  },
  amountInput: {
    color: colors.text,
    flex: 1,
    fontSize: typography.balance,
    fontWeight: '800',
    minHeight: 48,
    paddingVertical: spacing.xs,
  },
  amountUnit: {
    color: colors.textSecondary,
    fontSize: typography.sectionTitle,
    fontWeight: '700',
    marginLeft: spacing.sm,
    // Detache l'unite du bouton « Max » (modele Paste) : sans cela les deux
    // se touchent horizontalement dans le champ Amount.
    marginRight: spacing.md,
  },
  /** « Max » dans le champ : memes taille, style et rôle que « Paste ». */
  amountMax: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: spacing.md,
  },
  amountMaxText: { color: colors.mint, fontSize: typography.bodySmall, fontWeight: '700' },
  /**
   * Bouton « Max » GRISÉ quand le montant maximal transférable vaut 0 : la
   * teinte et le texte sont ATTÉNUÉS à partir des tokens du thème (aucune
   * couleur codée en dur). Le bouton reste un Pressable ACTIF : seul l'aspect
   * change, jamais la cliquabilité.
   */
  amountMaxMuted: { opacity: 0.55 },
  amountMaxTextMuted: { color: colors.disabledText },
  input: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    color: colors.text,
    fontSize: typography.bodySmall,
    marginTop: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  memoInput: { minHeight: 72, textAlignVertical: 'top' },
  fieldNote: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  fieldValue: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  toggle: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  togglePressed: { backgroundColor: colors.surfaceElevated },
  toggleText: { color: colors.text, fontSize: typography.bodySmall, fontWeight: '700' },
  /** Ligne de divulgation COMPACTE et INTERACTIVE (chevron à droite). */
  disclosure: {
    alignItems: 'center',
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  disclosureText: { color: colors.mint, fontSize: typography.bodySmall, fontWeight: '700' },
  /** Chevron : ▸ replié, ▾ déplié — communique l'état, jamais un libellé « Hide ». */
  disclosureChevron: {
    color: colors.mint,
    fontSize: typography.bodySmall,
    fontWeight: '800',
    marginLeft: spacing.sm,
    // Colonne d'indicateurs ALIGNÉE : largeur fixe + centrage, quelle que soit
    // la largeur réelle du glyphe (◂ replié / ▾ déplié).
    textAlign: 'center',
    width: 16,
  },
  /** Retrait PARTAGÉ : « How proposal creation works » doit partager le bord
   *  gauche de « Advanced diagnostics » (qui vit dans une carte paddingée
   *  `spacing.md`). Même constante, une seule colonne de libellés. */
  disclosureIndent: {
    marginHorizontal: spacing.md,
  },
  /** En-tête COMPACT et interactif de la carte « sent / pending » (repli) :
   *  une seule ligne — titre ambre + chevron — pour que la carte repliée
   *  n'occupe presque pas de place. Cible tactile ≥ 44 px. */
  pendingHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  /** Titre de l'en-tête en ambre (même teinte que le corps replié), `flex: 1`
   *  pour autoriser le retour à la ligne sans jamais pousser le chevron. */
  pendingHeaderTitle: {
    color: colors.warning,
    flex: 1,
    fontSize: typography.secondary,
    lineHeight: 19,
  },
  /** Chevron de l'en-tête : ◂ replié, ▾ déplié — même convention que les autres
   *  replis de l'app (largeur fixe + centrage = colonne alignée). */
  pendingHeaderChevron: {
    color: colors.warning,
    fontSize: typography.bodySmall,
    fontWeight: '800',
    marginLeft: spacing.sm,
    textAlign: 'center',
    width: 16,
  },
  successLine: { color: colors.success, fontSize: typography.bodySmall, fontWeight: '800' },
  /** Espacement EXPLICITE entre actions primaire et secondaire (16 px). */
  actionSpacing: { marginTop: spacing.lg },
  /** Action secondaire LÉGÈRE : texte centré, jamais le poids d'un CTA. */
  secondaryTextAction: {
    alignItems: 'center',
    marginTop: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  secondaryTextLabel: { color: colors.textSecondary, fontSize: typography.bodySmall, fontWeight: '700' },
  /** Espace en tête de la carte de succès (sous « DEVNET · SOL TRANSFER »). */
  successCard: { marginTop: spacing.xl },
  /** Divider subtil entre le résumé de succès et le reçu technique. */
  successDivider: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    marginTop: spacing.xl,
    paddingTop: spacing.sm,
  },
  /** Reçu technique : rangées LIBELLÉ + valeur, jamais un paragraphe continu.
   *  Libellés alignés sur le bloc voisin « Proposal created » (mêmes principes :
   *  libellé en `textSecondary` taille `secondary`, non gras — cf. `fieldNote`),
   *  valeurs en monospace (`monoValue`). */
  receiptRow: { marginTop: spacing.md },
  /** Valeur et action de copie ALIGNÉES sur une même ligne. */
  receiptValueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  receiptLabel: { color: colors.textSecondary, fontSize: typography.secondary },
  receiptCopy: { color: colors.mint, fontSize: typography.caption, fontWeight: '800' },
  moreOptions: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  infoBox: { marginTop: spacing.md },
  /** Encart d'avertissement ambré : un peu plus d'air interne (16 px) pour que
   *  le message et ses actions « respirent », sans changer la logique.
   *  `alignItems: 'center'` : le glyphe ⚠ a une boîte de ligne plus haute que
   *  le texte (il n'hérite pas du `lineHeight` de `InfoText`) ; en `flex-start`
   *  il gonflait la ligne et le texte, calé en haut, laissait plus d'espace
   *  sous lui qu'au-dessus. Centrer verticalement les enfants rend l'encart
   *  équilibré (bas du panneau aligné sur le bas du texte) et aligne le glyphe
   *  sur la même ligne visuelle que le message. Padding déjà symétrique. */
  warningBox: { alignItems: 'center', padding: spacing.lg },
  /** Encart d'ERREUR : même correction verticale que `warningBox` (le glyphe ⚠,
   *  privé de `lineHeight`, a une boîte de ligne plus haute que le texte ; en
   *  `flex-start` — défaut de la primitive figée — il gonflait la rangée et le
   *  texte, calé en haut, laissait plus d'espace sous lui qu'au-dessus).
   *  `alignItems: 'center'` répartit ce résidu symétriquement (haut = bas) et
   *  aligne le glyphe sur la ligne du message. On NE reprend PAS le `padding`
   *  élargi de `warningBox` : les encarts d'erreur gardent l'air interne de la
   *  primitive (`spacing.md`, déjà symétrique). Tokens du thème uniquement. */
  errorCentered: { alignItems: 'center' },
  /** Variante HAUT : encarts dont le CORPS comporte un TITRE (1re ligne) PUIS du
   *  contenu supplémentaire (phrase, liste, boutons, divulgation). Centrer
   *  verticalement contre TOUT le bloc (`warningBox` / `errorCentered`) décrochait
   *  le glyphe ⚠ de son titre : il se retrouvait isolé dans la colonne de gauche,
   *  à hauteur du milieu du bloc. En `flex-start`, la rangée s'aligne en HAUT et le
   *  glyphe reste sur la PREMIÈRE ligne, juste à côté du titre. Sur un corps
   *  multi-lignes la hauteur de rangée est donnée par le corps (jamais par le
   *  glyphe), donc AUCUN déséquilibre vertical n'est réintroduit. Les encarts à
   *  contenu COURT (une seule ligne) gardent `warningBox` / `errorCentered`. */
  warningBoxTop: { alignItems: 'flex-start', padding: spacing.lg },
  errorTop: { alignItems: 'flex-start' },
  errorBox: {
    alignSelf: 'stretch',
    backgroundColor: colors.errorSoft,
    borderColor: colors.errorSoft,
    borderRadius: radii.field,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  errorTitle: { color: colors.error, fontSize: typography.bodySmall, fontWeight: '800' },
  successBox: {
    alignSelf: 'stretch',
    backgroundColor: colors.successSoft,
    borderColor: colors.successSoft,
    borderRadius: radii.field,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  successTitle: { color: colors.success, fontSize: typography.bodySmall, fontWeight: '800' },
  noticeBox: {
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  noticeTitle: { color: colors.mint, fontSize: typography.bodySmall, fontWeight: '800' },
  monoValue: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: typography.micro,
    marginTop: spacing.xs,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.xl,
    minHeight: 52,
    paddingHorizontal: spacing.xl,
  },
  primaryPressed: { opacity: 0.82 },
  buttonText: { color: colors.onLight, fontSize: typography.body, fontWeight: '800', textAlign: 'center' },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  secondaryPressed: { backgroundColor: colors.surface },
  secondaryText: { color: colors.text, fontSize: typography.bodySmall, fontWeight: '700', textAlign: 'center' },
  createButton: { marginTop: spacing.xl },
  // Etat desactive LISIBLE (WCAG AA) : fond gris-clair + texte presque noir
  // (colors.onLight) => contraste ~7:1. Avant, fond `colors.disabled` (#1B2925)
  // sur texte #08110F : le CTA principal disparaissait quand le formulaire etait
  // vide. Un etat desactive doit rester LISIBLE, jamais invisible.
  disabled: { backgroundColor: colors.textSecondary, borderColor: colors.textSecondary },
  cancel: {
    alignItems: 'center',
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.lg,
    minHeight: 48,
  },
  cancelText: { color: colors.textSecondary, fontSize: typography.bodySmall, fontWeight: '700' },
});
