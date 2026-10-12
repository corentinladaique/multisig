import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

import { connection } from '../solana/connection';
import { buildMultisigCreationTransaction, type MultisigTransactionBuildResult } from '../vault/buildMultisigCreation';
import { buildMultisigCreationPlan } from '../vault/multisigCreationPlan';
import {
  LOW_SECURITY_THRESHOLD_CONFIRM,
  LOW_SECURITY_THRESHOLD_DETAIL,
  LOW_SECURITY_THRESHOLD_LABEL,
  lowSecurityThresholdWarning,
  recommendationFor,
  recommendedThresholdFor,
} from '../vault/thresholdRecommendation';
import { thresholdGuidanceFor } from '../vault/thresholdGuidance';
import { runMultisigCreationPreflight } from '../vault/multisigCreationPreflight';
import {
  simulateMultisigCreation,
  type MultisigCreationSimulationResult,
} from '../vault/simulateMultisigCreation';
import {
  applyFreshBlockhash,
  signAndSendMultisigCreation,
  type MultisigCreationReadBack,
  type MultisigCreationSignSendResult,
} from '../vault/signAndSendMultisigCreation';
import {
  decodeMultisigCreationReadBack,
  validateMultisigCreationReadBack,
  type MultisigCreationExpectation,
} from '../vault/multisigCreationReadBack';
import { useMultisigRegistry } from '../vault/useMultisigRegistry';
import { useVaultUsage } from '../vault/useVaultUsage';
import { formatMwaError } from '../wallet/mwaDiagnostics';
import { AddressInput } from '../ui/AddressInput';
import { SAFE_TOP_PADDING } from '../ui/safeAreaPadding';
import { colors, radii, spacing, typography } from '../ui/theme';
import { Card, DevnetPill, InfoBox, InfoText, PillButton } from '../ui/v2/primitives';
import {
  buildOperationReport,
  classifyOperationFailure,
  classifyOperationResult,
  describeAttemptOutcome,
  evaluateSignatureEvidence,
  isTemporaryNetworkFailure,
  type OperationReport,
} from '../wallet/operationState';
import { confirmSignature } from '../solana/confirmSignature';
import type { SignatureConfirmationStatus } from '../wallet/operationState';
import { signingStateTitle } from '../wallet/signingWindow';
import {
  deriveVaultVisibleState,
  VAULT_VISIBLE_LABELS,
} from '../wallet/vaultCreationState';
import { lamportsToSolDisplay } from '../wallet/vaultBalance';
import {
  DEVNET_SOL_DISCLAIMER,
  formatPriceUpdatedAt,
  formatUsdEstimate,
  USD_ESTIMATE_UNAVAILABLE,
  type SolPrice,
} from '../wallet/fiatEstimate';
import {
  decomposeCreationCost,
  type CreationCostBreakdown,
} from '../vault/multisigCreationCost';
import * as multisig from '@sqds/multisig';
import { PublicKey } from '@solana/web3.js';
import {
  buildVaultCreationRequest,
  createEmptyDraft,
  createMember,
  evaluateDraft,
  isDraftReady,
  isValidSolanaAddress,
  minMembersFor,
  SETUP_PRESETS,
  shortenMemberAddress,
  type SetupType,
  type VaultDraftInput,
  type VaultMemberDraft,
} from '../vault/vaultDraft';

/**
 * Assistant LOCAL de configuration d'un vault Squads personnel.
 *
 * Aucun RPC, aucune signature, aucune API de creation Squads, aucune
 * transaction. Le brouillon ne contient que des adresses publiques et des
 * labels : jamais de cle privee, de seed phrase ou de PIN.
 */

const STEP_COUNT = 5;
// Marge de confort au-dessus du clavier (aucune dimension d'ecran codee).
const FIELD_KEYBOARD_MARGIN = 24;

/**
 * Signature ABREGEE pour l'affichage courant. La signature COMPLÈTE n'est
 * visible que dans le « Technical receipt » replié. Pure présentation.
 */
function shortenSignature(signature: string | null | undefined): string {
  if (signature === null || signature === undefined || signature.length === 0) {
    return 'unavailable';
  }
  if (signature.length <= 18) return signature;
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

/**
 * Nombre MAX de lignes de detail brut affichees dans le repli technique : au
 * dela, le reste est annonce (« +N more… »). Le brut INTEGRAL reste accessible
 * via « Show raw details » — aucune information n'est perdue.
 */
const TROUBLESHOOTING_MAX_LINES = 6;

/** Motifs d'erreur reseau : ils se repetent mot pour mot a chaque compte lu. */
const NETWORK_FAILURE_PATTERNS: RegExp[] = [
  /Unable to resolve host/gi,
  /java\.net\.[A-Za-z]+Exception/gi,
  /UnknownHostException/gi,
  /fetch failed/gi,
  /Network request failed/gi,
  /ECONNREFUSED/gi,
  /ENOTFOUND/gi,
  /EAI_AGAIN/gi,
  /ETIMEDOUT/gi,
  /socket hang up/gi,
];

/**
 * Compte les repetitions d'une MEME erreur reseau : on retient le maximum des
 * motifs (une meme repetition porte souvent plusieurs motifs), jamais leur
 * cumul. Un message hors ligne repete trois fois donne donc 3, pas 9.
 */
function countNetworkFailures(text: string): number {
  let count = 0;
  for (const pattern of NETWORK_FAILURE_PATTERNS) {
    count = Math.max(count, (text.match(pattern) ?? []).length);
  }
  return count;
}

/**
 * Retire d'un message le fragment reseau repete (factorise dans la ligne
 * reseau dediee) : le reste — prefixe / etape / annotation — est conserve.
 */
function stripNetworkNoise(message: string): string {
  const index = message.search(
    /fetch failed|java\.net\.[A-Za-z]+Exception|UnknownHostException|Network request failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i,
  );
  if (index === -1) return message;
  const head = message
    .slice(0, index)
    .replace(/[\s:—-]+$/, '')
    .trim();
  return head.length > 0 ? `${head} …` : '';
}

/**
 * Condense les messages techniques bruts en un digest lisible SANS perdre
 * l'information : dedoublonne les lignes identiques (×N), factorise l'erreur
 * reseau repetee (hote injoignable) en UNE ligne avec le nombre de requetes
 * concernees, puis plafonne l'affichage (le reste est annonce). Fonction PURE :
 * aucune I/O, testable hors ligne.
 */
function condenseTroubleshootingDetails(messages: string[]): {
  summary: string;
  lines: string[];
  hiddenCount: number;
} {
  const flat = messages
    .map((message) => message.replace(/\s+/g, ' ').trim())
    .filter((message) => message.length > 0);
  const joined = flat.join(' ');
  const networkCount = countNetworkFailures(joined);
  const host = joined.match(/Unable to resolve host "([^"]+)"/i)?.[1] ?? null;
  const exception = joined.match(/java\.net\.[A-Za-z]+Exception/)?.[0] ?? null;

  const lines: string[] = [];
  if (networkCount > 0) {
    // Une seule mention de l'hote injoignable (et de l'exception), quel que
    // soit le nombre de comptes interroges.
    const label = exception ?? 'Network unreachable';
    lines.push(
      host !== null
        ? `${label}: could not reach ${host} — ${networkCount} request${
            networkCount > 1 ? 's' : ''
          } failed.`
        : `${label} — ${networkCount} request${networkCount > 1 ? 's' : ''} failed.`,
    );
  }

  const counts = new Map<string, number>();
  for (const message of flat) counts.set(message, (counts.get(message) ?? 0) + 1);
  for (const [message, occurrences] of counts) {
    const stripped = stripNetworkNoise(message);
    const line = stripped.length > 0 ? stripped : message;
    if (lines.includes(line)) continue;
    lines.push(occurrences > 1 ? `${line} (×${occurrences})` : line);
  }

  const hiddenCount = Math.max(lines.length - TROUBLESHOOTING_MAX_LINES, 0);
  return {
    hiddenCount,
    lines: lines.slice(0, TROUBLESHOOTING_MAX_LINES),
    summary:
      networkCount > 0
        ? 'Vault preparation failed: the network was unreachable (step: Preparation).'
        : 'Vault preparation failed (step: Preparation).',
  };
}

/**
 * Création ANNULÉE avant toute signature : copie COURTE et humaine, ton
 * AVERTISSEMENT (une annulation n'est jamais une panne). Le détail technique brut
 * reste réservé au repli « Troubleshooting details », jamais dans ce panneau.
 * Textes validés par l'utilisateur.
 */
const CREATION_CANCELLED_TITLE = 'Creation was cancelled';
const CREATION_CANCELLED_BODY =
  'Nothing was signed and nothing was sent. Your vault was not created.';

type MeasurableInput = TextInput & {
  measureInWindow?: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
};

export function CreateVaultScreen({
  onCancel,
  onGoToInbox,
  onOpenVault,
  onViewProposals,
}: {
  onCancel: () => void;
  /** Sortie vers l'inbox des multisigs connus : retour systeme apres succes. */
  onGoToInbox: () => void;
  /** Ouvre le vault cree, a partir de son adresse deja verifiee on-chain. */
  onOpenVault: (vault: { address: string; vaultName: string }) => void;
  /** Bascule sur l'onglet Proposals du vault qui vient d'etre cree (lien de succes). */
  onViewProposals: (vault: { address: string; vaultName: string }) => void;
}) {
  const { account, connect, signAndSendTransactions } = useMobileWallet();
  // Registre local des multisigs connus (stockage seul, aucun RPC).
  const registry = useMultisigRegistry();
  // Recence locale : un vault CREÉ devient le DERNIER UTILISE, exactement comme
  // un vault charge avec succes — meme stockage local, aucun reseau.
  const usage = useVaultUsage();

  const [step, setStep] = useState(1);
  const [vaultName, setVaultName] = useState('');
  /** Le champ nom a-t-il ete touche ? Aucune erreur agressive avant interaction. */
  const [nameTouched, setNameTouched] = useState(false);
  const [setupType, setSetupType] = useState<SetupType | null>(null);
  const [members, setMembers] = useState<VaultMemberDraft[]>([]);
  const [threshold, setThreshold] = useState(1);
  // Le seuil a-t-il ete choisi EXPLICITEMENT par l'utilisateur sur le selecteur
  // de l'etape 3 ? Tant que non, un vault de trois signataires prend le defaut
  // recommande (2 of 3). Un choix explicite (y compris 1 of 3) n'est jamais
  // ecrase. Choisir un SETUP ne compte PAS comme un choix de seuil.
  const [thresholdTouched, setThresholdTouched] = useState(false);

  const [pendingAddress, setPendingAddress] = useState('');
  const [pendingLabel, setPendingLabel] = useState('');
  const [pendingError, setPendingError] = useState<string | null>(null);

  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Section repliable des diagnostics sur Step 5 : ouverte uniquement par un
  // tap explicite, jamais une etape obligatoire du parcours.
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);
  // Second niveau de repli (imbrique dans le premier) : le detail brut INTEGRAL
  // reste consultable a la demande, sans etre jamais impose.
  const [rawDetailsOpen, setRawDetailsOpen] = useState(false);
  // Reçu technique du succes : REPLIÉ par defaut. La signature COMPLÈTE n'apparait
  // qu'ici, sur demande explicite ; l'ecran n'affiche qu'une version abregee.
  const [receiptOpen, setReceiptOpen] = useState(false);

  // --- Creation reelle (devnet) : etat du flux d'envoi. Aucune execution
  // automatique : tout part d'un tap, puis d'une confirmation explicite.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<MultisigCreationSignSendResult | null>(null);
  // Cout estime de creation, issu EXCLUSIVEMENT de la simulation locale deja
  // calculee (aucune lecture RPC ajoutee). Unites internes en lamports ; jamais
  // affichees a l'utilisateur. La decomposition rent/frais n'est renseignee que
  // si elle est fiable (voir decomposeCreationCost).
  const [creationCost, setCreationCost] = useState<CreationCostBreakdown | null>(null);
  // Prix SOL/USD : AUCUNE source fiable branchee pour l'instant (pas de package,
  // pas de secret, pas de valeur codee en dur). L'interface est prete : il suffit
  // de renseigner ce prix plus tard, sans toucher au reste.
  const solPrice = null as SolPrice | null;
  // Verrou de tentative : jamais deux envois en parallele, jamais deux envois
  // apres une signature obtenue.
  const sendAttemptedRef = useRef(false);
  // Machine d'état : ce qui s'est réellement passé, et ce qui reste permis.
  const [operationReport, setOperationReport] = useState<OperationReport | null>(null);
  const [checkReport, setCheckReport] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Preuve relue sur la chaîne lors du dernier « Check transaction again » :
  // seule source capable d'autoriser une nouvelle tentative APRÈS signature.
  const [checkEvidence, setCheckEvidence] = useState<{
    status: SignatureConfirmationStatus;
    blockHeight: number | null;
    lastValidBlockHeight: number | null;
  } | null>(null);
  // Adresse multisig ATTENDUE, derivee PENDANT la tentative signee et conservee
  // jusqu'au verdict final. Check transaction again ne rederive jamais de cle et
  // n'utilise que cette adresse.
  const [expectedMultisigPda, setExpectedMultisigPda] = useState<string | null>(null);
  // Erreur technique BRUTE du dernier recheck : reservee a Troubleshooting
  // details, jamais concatenee dans le message utilisateur principal.
  const [checkError, setCheckError] = useState<string | null>(null);
  // Configure relue mais NON conforme (owner/threshold/membre/permissions…) :
  // echec DETERMINISTE, jamais presente comme une simple indisponibilite reseau.
  const [verificationMismatch, setVerificationMismatch] = useState(false);
  // Verdict unique de l'UI : sans signature, jamais de libellé « Sent ».
  const attemptOutcome =
    createResult === null
      ? null
      : describeAttemptOutcome({
          confirmed: createResult.confirmed === true,
          evidence: checkEvidence,
          // Réseau injoignable : temporaire, la signature reste valable.
          networkFailure: isTemporaryNetworkFailure(createResult.errorMessage ?? ''),
          signature: createResult.signature,
          verified: createResult.verified,
        });

  // --- Etats utiles portes sur Step 5 (ex-ecran de transaction) : tout est
  // derive de l'etat existant, aucun nouvel envoi ni reconstruction.
  const hasCreateResult = createResult !== null;
  const signatureObtained = createResult !== null && createResult.signature !== null;
  const createdAndVerified = createResult?.verified === true;
  const nothingWasSent = hasCreateResult && !signatureObtained;
  const signedPending = hasCreateResult && signatureObtained && !createdAndVerified;
  // « Prepare again » n'apparait que si la machine d'etat autorise une nouvelle
  // tentative : jamais apres une signature non revoquee.
  const needsPrepareAgain = hasCreateResult && attemptOutcome?.allowNewAttempt === true;
  // Statut de confirmation affichable : preuve relue si presente, sinon
  // deduction prudente (jamais « confirmed » sans preuve explicite).
  const signatureStatus: SignatureConfirmationStatus =
    checkEvidence?.status ?? (createResult?.confirmed === true ? 'confirmed' : 'pending');
  // Confirmation : preuve la plus avancee disponible (jamais de regression).
  const transactionConfirmed =
    createResult?.confirmed === true || checkEvidence?.status === 'confirmed';
  // Relecture impossible POUR UNE RAISON RESEAU (temporaire) : le read-back
  // initial peut avoir echoue sur UnknownHostException avant confirmation.
  const isTemporaryVerificationFailure =
    isTemporaryNetworkFailure(checkError ?? '') ||
    isTemporaryNetworkFailure(createResult?.errorMessage ?? '') ||
    isTemporaryNetworkFailure((createResult?.validationErrors ?? []).join(' '));
  // Etat visible UNIQUE, derive des preuves les plus avancees : confirmed ne
  // redevient jamais « confirmation pending ».
  const vaultVisibleState = deriveVaultVisibleState({
    confirmed: transactionConfirmed,
    creating,
    hasAttempt: hasCreateResult,
    networkFailure: isTemporaryVerificationFailure,
    signatureObtained,
    verificationMismatch,
    verified: createdAndVerified,
  });
  // Verdict de preuve : seule source capable d'autoriser une nouvelle tentative
  // APRES une signature deja obtenue.
  const signatureVerdict = signedPending
    ? evaluateSignatureEvidence({
        blockHeight: checkEvidence?.blockHeight ?? null,
        lastValidBlockHeight: createResult?.lastValidBlockHeight ?? null,
        status: signatureStatus,
      })
    : null;
  // Adresse du vault principal (PDA index 0) derivee UNIQUEMENT de l'adresse
  // VERIFIEE (read-back conforme), index 0 : aucune addresse de navigation,
  // aucune derivation avant verification.
  const mainVaultAddress = (() => {
    if (!createdAndVerified) return null;
    const address = createResult?.readBack?.address ?? null;
    if (address === null) return null;
    try {
      const [vaultPda] = multisig.getVaultPda({ index: 0, multisigPda: new PublicKey(address) });
      return vaultPda.toBase58();
    } catch {
      return null;
    }
  })();
  // Diagnostics disponibles : la section repliable n'apparait que s'il existe au
  // moins une information technique, jamais vide.
  const mwaReport = operationReport?.mwa ?? null;
  const signingStateLabel =
    createResult?.signingState === undefined ? null : signingStateTitle(createResult.signingState);
  // Message d'erreur wallet d'origine, VERBATIM. Le code MWA porte souvent la
  // description COMPLÈTE (le message de l'exception en est alors le suffixe) :
  // on retient le plus complet des deux pour ne JAMAIS répéter la phrase.
  const rawWalletError = (() => {
    const code = mwaReport?.code ?? null;
    const message = mwaReport?.message ?? createResult?.errorMessage ?? null;
    if (code !== null && (message === null || code.includes(message))) return code;
    return message ?? createError;
  })();
  const technicalErrors: string[] = [];
  if (nothingWasSent && rawWalletError !== null) {
    // Échec AVANT toute signature : détail DISCRET et DÉDOUBLONNÉ (une seule
    // mention du message wallet), jamais le pavé brut dans le panneau ambre.
    // Le « : » de séparation devient « — » pour une ligne lisible (forme validée).
    technicalErrors.push('Step: Preparation');
    technicalErrors.push(`Wallet error: ${rawWalletError.replace(/:\s+/, ' — ')}`);
  } else {
    if (createResult?.errorMessage != null) technicalErrors.push(createResult.errorMessage);
    for (const message of createResult?.validationErrors ?? []) technicalErrors.push(message);
    // Échec hors des modules d'envoi (aucun createResult) : le message reste
    // consultable ici, jamais en clair dans le panneau principal.
    if (technicalErrors.length === 0 && createError !== null) technicalErrors.push(createError);
  }
  if (checkError !== null && !technicalErrors.includes(checkError)) technicalErrors.push(checkError);
  const hasDiagnostics =
    // Apres une creation VERIFIEE, il n'y a aucun probleme : la section repliable
    // reste absente (et « Signing state: Confirmed on-chain » n'est jamais affiche
    // en plus de « Verified on-chain »).
    !createdAndVerified &&
    (technicalErrors.length > 0 ||
      mwaReport !== null ||
      signingStateLabel !== null ||
      checkEvidence !== null);

  // Digest LISIBLE du detail technique : resume humain court + lignes brutes
  // condensees (dedoublonnees, reseau factorise, plafonnees). Le brut INTEGRAL
  // reste consultable via le second repli « Show raw details ».
  const troubleshootingDigest = condenseTroubleshootingDetails(technicalErrors);

  // --- Affichage du cout : TOUJOURS en SOL (jamais de lamports a l'ecran). ---
  const costTotalSol = creationCost === null ? null : lamportsToSolDisplay(creationCost.totalLamports);
  const costRentSol =
    creationCost === null || creationCost.rentLamports === null
      ? null
      : lamportsToSolDisplay(creationCost.rentLamports);
  const costFeeSol =
    creationCost === null || creationCost.feeLamports === null
      ? null
      : lamportsToSolDisplay(creationCost.feeLamports);
  const costBreakdownAvailable = costRentSol !== null && costFeeSol !== null;
  const usdEstimate =
    creationCost === null ? null : formatUsdEstimate({ lamports: creationCost.totalLamports, price: solPrice });
  const priceUpdatedAt = solPrice === null ? null : formatPriceUpdatedAt(solPrice.fetchedAt);

  const memberCounter = useRef(0);

  // Suppression d'un signer : realigne le threshold sur le nombre de membres
  // restant pour ne jamais afficher un seuil inatteignable.
  useEffect(() => {
    setThreshold((current) => {
      const max = Math.max(members.length, 1);
      return current > max ? max : current;
    });
  }, [members.length]);

  const draftInput = useMemo<VaultDraftInput>(
    () => ({ ...createEmptyDraft(), vaultName, setupType: setupType ?? 'custom', members, threshold }),
    [members, setupType, threshold, vaultName],
  );
  const draft = useMemo(() => evaluateDraft(draftInput), [draftInput]);
  const ready = isDraftReady(draft);
  // Demande locale de creation : purement derivee du draft, utilisee pour le
  // recapitulatif de l'etape Review. Aucun appel reseau.
  const request = useMemo(() => buildVaultCreationRequest(draft), [draft]);
  // Plan technique : purement local (aucun RPC, aucune API Squads executee).
  const plan = useMemo(() => buildMultisigCreationPlan(request), [request]);

  // Pour un vault de TROIS signataires, le threshold recommande (2 of 3) est
  // applique par defaut — sauf choix explicite de l'utilisateur sur le selecteur
  // de seuil (thresholdTouched). Les autres nombres de signataires ne recoivent
  // aucun defaut force : leur comportement reste inchange.
  useEffect(() => {
    if (thresholdTouched) return;
    if (members.length !== 3) return;
    const recommended = recommendedThresholdFor(members.length);
    if (threshold !== recommended) setThreshold(recommended);
  }, [members.length, threshold, thresholdTouched]);

  // Recommandation affichee (2 of 2 / 2 of 3), ou null.
  const thresholdRecommendation = recommendationFor(members.length);

  // Guidance de seuil (ton + textes) du panneau « Threshold » : elle suit le
  // seuil choisi pour un vault de trois signataires. `null` hors de ce cas.
  const thresholdGuidance = thresholdGuidanceFor(
    members.length,
    threshold,
    thresholdRecommendation,
  );

  // Presets VISIBLES du wizard : le preset « 2 of 2 » n'est plus propose comme
  // point d'entree. Custom couvre TOUJOURS 2-of-2, 1-of-2 et toutes les
  // configurations deja valides (aucune capacite Squads retiree) ; « 2 of 2 »
  // n'est jamais presente comme recommande ni avec une coche verte.
  const visiblePresets = SETUP_PRESETS.filter((preset) => preset.type !== 'twoOfTwo');
  // Surcouche d'AFFICHAGE uniquement (aucun module metier modifie).
  const presetDetailOverride: Record<string, string> = {
    recommended: '3 signers, 2 approvals needed. One unavailable signer does not block the vault.',
  };

  // Configuration EXACTEMENT 2-of-2 : risque de disponibilite affiche des que la
  // configuration est atteinte (des l'etape Threshold), jamais comme recommande.
  const isTwoOfTwo = members.length === 2 && threshold === 2;
  const twoOfTwoAvailabilityRisk = isTwoOfTwo;

  // Valeurs attendues on-chain, préparées AVANT signature : utilisées à
  // l'identique par le read-back initial ET par « Check transaction again ».
  const creationExpectation = useMemo<MultisigCreationExpectation>(
    () => ({
      configAuthority: plan.configAuthority,
      memberCount: plan.members.length,
      members: plan.members.map((member) => ({
        key: member.key,
        permissions: member.permissions,
      })),
      rentCollector: plan.rentCollector,
      threshold: plan.threshold,
      timeLock: plan.timeLock,
    }),
    [plan],
  );

  const walletAddress = account === undefined ? null : account.address.toString();
  const walletAlreadyMember =
    walletAddress !== null && members.some((member) => member.publicKey === walletAddress);

  // --- Clavier : meme mecanisme que l'ecran principal (evenement reel +
  // position mesuree). En edge-to-edge la fenetre n'est plus redimensionnee
  // par l'IME, le KeyboardAvoidingView "padding" fait le travail.
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const fieldRefs = useRef<Record<string, TextInput | null>>({});
  const focusedFieldRef = useRef<string | null>(null);

  const registerField = useCallback(
    (key: string) => (instance: TextInput | null) => {
      fieldRefs.current[key] = instance;
    },
    [],
  );

  const onFieldFocus = useCallback(
    (key: string) => () => {
      focusedFieldRef.current = key;
    },
    [],
  );

  const onFieldBlur = useCallback(() => {
    focusedFieldRef.current = null;
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      const key = focusedFieldRef.current;
      const scroller = scrollViewRef.current;
      const field = key === null ? null : (fieldRefs.current[key] as MeasurableInput | null);
      if (key === null || scroller === null || field === null || field === undefined) return;
      // measureInWindow n'est pas expose par les types publics de ScrollView.
      const measurableScroller = scroller as unknown as MeasurableInput;
      measurableScroller.measureInWindow?.((_viewX, viewY) => {
        field.measureInWindow?.((_fieldX, fieldY) => {
          const targetY = Math.max(
            scrollOffsetRef.current + fieldY - viewY - FIELD_KEYBOARD_MARGIN,
            0,
          );
          if (__DEV__) {
            console.log('[vault] keyboardDidShow ; champ =', key, '; scrollTo.y =', targetY);
          }
          scroller.scrollTo({ animated: true, y: targetY });
        });
      });
    });
    return () => subscription.remove();
  }, []);

  // --- Actions du brouillon (aucun appel reseau).
  const chooseSetup = useCallback((type: SetupType, presetThreshold: number) => {
    setSetupType(type);
    setThreshold(presetThreshold);
    // Choisir un SETUP n'est PAS un choix de seuil : le defaut recommande
    // (2 of 3) reste applique tant que l'utilisateur n'a pas touche le
    // selecteur de seuil a l'etape 3 (voir setThresholdTouched dans le rendu).
  }, []);

  const addConnectedWallet = useCallback(() => {
    if (walletAddress === null) return;
    memberCounter.current += 1;
    const label = account?.label ?? 'Seeker wallet';
    setMembers((previous) => [
      ...previous,
      createMember({
        index: memberCounter.current,
        label,
        publicKey: walletAddress,
      }),
    ]);
  }, [account?.label, walletAddress]);

  const addPendingMember = useCallback(() => {
    const address = pendingAddress.trim();
    const label = pendingLabel.trim().length > 0 ? pendingLabel.trim() : 'Unlabelled signer';
    if (!isValidSolanaAddress(address)) {
      setPendingError('Invalid Solana public address.');
      return;
    }
    if (members.some((member) => member.publicKey === address)) {
      setPendingError('This public address is already a member.');
      return;
    }
    memberCounter.current += 1;
    setMembers((previous) => [
      ...previous,
      createMember({ index: memberCounter.current, label, publicKey: address }),
    ]);
    setPendingAddress('');
    setPendingLabel('');
    setPendingError(null);
  }, [members, pendingAddress, pendingLabel]);

  const removeMember = useCallback((id: string) => {
    setMembers((previous) => previous.filter((member) => member.id !== id));
    setRenameId((current) => (current === id ? null : current));
  }, []);

  const startRename = useCallback((member: VaultMemberDraft) => {
    setRenameId(member.id);
    setRenameValue(member.label);
  }, []);

  const commitRename = useCallback(() => {
    const id = renameId;
    if (id === null) return;
    const label = renameValue.trim();
    setMembers((previous) =>
      previous.map((member) =>
        member.id === id ? { ...member, label: label.length > 0 ? label : member.label } : member,
      ),
    );
    setRenameId(null);
  }, [renameId, renameValue]);

  const onScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  /**
   * Sequence technique AVANT confirmation : un seul build conserve (meme clé
   * ephemere du debut a la fin), treasury lu on-chain, puis simulation. Renvoie
   * exactement l'instance de transaction qui sera signee et envoyee.
   */
  const prepareCreation = useCallback(
    async (creator: string): Promise<{
      build: MultisigTransactionBuildResult;
      simulation: MultisigCreationSimulationResult;
    }> => {
      const firstBuild = buildMultisigCreationTransaction({ plan, creator, treasury: null });
      const preflight = await runMultisigCreationPreflight({
        connection,
        creator,
        createKey: firstBuild.createKeyPublicKey,
        plan,
      });
      if (preflight.treasury === null) {
        throw new Error(
          `Preflight failed: ${preflight.validationErrors.join(' ') || 'treasury unavailable.'}`,
        );
      }
      const build = buildMultisigCreationTransaction({
        plan,
        creator,
        treasury: preflight.treasury,
      });
      if (build.transaction === null) {
        throw new Error(`Construction failed: ${build.validationErrors.join(' ')}`);
      }
      // Blockhash explicite AVANT toute simulation : sans lui, web3.js injecte
      // un blockhash issu du cache de Connection, qui peut etre inconnu de la
      // grappe (BlockhashNotFound).
      await applyFreshBlockhash(connection, build.transaction);
      const simulation = await simulateMultisigCreation({
        connection,
        transaction: build.transaction,
        multisigPda: build.multisigPda,
        creator,
      });
      if (simulation.err !== null || !simulation.readyToSign) {
        throw new Error(
          `Simulation refusée : ${
            simulation.validationErrors.join(' ') || JSON.stringify(simulation.err)
          }`,
        );
      }
      return { build, simulation };
    },
    [plan],
  );

  /**
   * Envoi effectif, apres confirmation explicite. Simule une derniere fois la
   * MEME instance (fraicheur), puis signe avec la clé éphémère et envoie via
   * le wallet, puis relit le multisig.
   */
  const confirmAndSend = useCallback(
    async (
      prepared: { build: MultisigTransactionBuildResult; simulation: MultisigCreationSimulationResult },
      creator: string,
    ) => {
      const transaction = prepared.build.transaction;
      if (transaction === null || sendAttemptedRef.current) return;
      sendAttemptedRef.current = true;
      // Adresse ATTENDUE de cette tentative signee : conservee jusqu'au verdict
      // final, y compris si la relecture initiale echoue (reseau).
      setExpectedMultisigPda(prepared.build.multisigPda);
      setCreating(true);
      setCreateError(null);
      let signature: string | null = null;
      try {
        // Blockhash frais unique, pose AVANT la simulation finale et reutilise
        // tel quel pour partialSign puis pour l'envoi MWA.
        const blockhash = await applyFreshBlockhash(connection, transaction);
        const fresh = await simulateMultisigCreation({
          connection,
          transaction,
          multisigPda: prepared.build.multisigPda,
          creator,
        });
        if (fresh.err !== null || !fresh.readyToSign) {
          throw new Error(
            `Simulation refusée avant envoi : ${
              fresh.validationErrors.join(' ') || JSON.stringify(fresh.err)
            }`,
          );
        }
        const result = await signAndSendMultisigCreation({
          connection,
          transaction,
          ephemeralCreateKey: prepared.build.ephemeralCreateKey,
          signAndSendTransactions,
          multisigPda: prepared.build.multisigPda,
          expectation: creationExpectation,
          blockhash,
        });
        signature = result.signature;
        setCreateResult(result);
        if (!result.verified) {
          setCreateError(
            result.errorMessage !== null
              ? // Échec côté wallet : étape, code et message conservés tels quels.
                formatMwaError({
                  code: result.errorCode ?? null,
                  message: result.errorMessage,
                  step: 'signAndSendTransactions',
                })
              : result.validationErrors.join(' '),
          );
          // Machine d'état : signature obtenue ou non déterminent seuls la suite.
          setOperationReport(
            buildOperationReport({
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
            }),
          );
        } else if (result.readBack !== null) {
          setOperationReport(
            buildOperationReport({
              evidence: { confirmed: true, readBackVerified: true, signatureObtained: true },
              state: 'operation-created-and-verified',
            }),
          );
          // Creation verifiee on-chain : on conserve localement de quoi la
          // retrouver (adresse, nom local, labels). Aucun secret n'est ecrit.
          const memberLabels: Record<string, string> = {};
          for (const member of plan.members) {
            if (member.label.length > 0) memberLabels[member.key] = member.label;
          }
          const saved = await registry.add({
            address: result.readBack.address,
            vaultName,
            memberLabels,
            source: 'created',
          });
          if (saved.entry === null) {
            setCreateError(
              `Multisig created and verified, but the local record could not be saved: ${
                saved.errors.join(' ') || 'unknown storage error'
              }`,
            );
          }
          // Le vault CREÉ devient le DERNIER UTILISE (donc auto-charge a
          // l'ouverture suivante), avec le seuil et le nombre de membres REELS
          // relus on-chain. Ecrit uniquement apres une creation VERIFIEE.
          await usage.markUsed(result.readBack.address, {
            memberCount: result.readBack.memberCount,
            threshold: result.readBack.threshold,
          });
        }
      } catch (caught: unknown) {
        setCreateError(caught instanceof Error ? caught.message : String(caught));
        // Échec hors des modules d'envoi : classé ici, sans jamais conclure
        // à un succès (CancellationException = interruption de session).
        const state = classifyOperationFailure({
          caught,
          step: 'signAndSendTransactions',
        });
        setOperationReport(buildOperationReport({ caught, state, step: 'signAndSendTransactions' }));
      } finally {
        // Aucune signature obtenue -> la tentative n'a rien produit : on
        // reautorise un essai. Sinon, plus aucun envoi automatique.
        if (signature === null) sendAttemptedRef.current = false;
        setCreating(false);
      }
    },
    [plan, registry, signAndSendTransactions, usage],
  );

  /**
   * Reconnexion wallet uniquement : aucune préparation, aucune signature.
   * Utile après une interruption de session ou un refus d'autorisation.
   */
  const onReconnectWallet = useCallback(async () => {
    setCheckReport(null);
    setCreateError(null);
    try {
      await connect();
    } catch (caught: unknown) {
      const state = classifyOperationFailure({ caught, step: 'authorize' });
      setOperationReport(buildOperationReport({ caught, state, step: 'authorize' }));
    }
  }, [connect]);

  /**
   * Relecture SEULE apres qu'une signature a existe : confirmation de la
   * transaction puis relecture du compte multisig ATTENDU (derive pendant la
   * tentative signee). Ne prepare rien, ne signe rien, ne renvoie rien et
   * n'ouvre aucun wallet : uniquement des lectures RPC.
   */
  const onCheckTransactionAgain = useCallback(async () => {
    const signature = createResult?.signature ?? null;
    if (signature === null) {
      setCheckReport('No signature exists: nothing was sent, nothing to check.');
      return;
    }
    // Une seule relecture a la fois : ignore les taps simultanes.
    if (checking) return;
    setChecking(true);
    setCheckReport('Checking transaction…');
    setCheckError(null);
    // Adresse ATTENDUE de la tentative signee : jamais rederivee, jamais une
    // nouvelle cle.
    const expectedPda = expectedMultisigPda ?? createResult?.readBack?.address ?? null;
    try {
      const confirmation = await confirmSignature({ connection, signature });
      // Hauteur de bloc relue : c'est elle, avec lastValidBlockHeight, qui
      // decide si une nouvelle tentative est permise apres signature.
      let currentBlockHeight: number | null = null;
      try {
        currentBlockHeight = await connection.getBlockHeight('confirmed');
      } catch {
        currentBlockHeight = null;
      }
      const confirmed = confirmation.status === 'confirmed';
      setCheckEvidence({
        blockHeight: currentBlockHeight,
        lastValidBlockHeight: createResult?.lastValidBlockHeight ?? null,
        status: confirmation.status,
      });

      // Relecture du compte multisig ATTENDU (lecture seule). Le verdict est
      // rendu par la MEME fonction pure que le read-back initial : owner,
      // configAuthority, threshold, membres, permissions, timeLock, rentCollector.
      let readBack: MultisigCreationReadBack | null = null;
      let readBackError: string | null = null;
      let mismatchDeterministic = false;
      if (confirmed && expectedPda !== null) {
        try {
          const info = await connection.getAccountInfo(new PublicKey(expectedPda), 'confirmed');
          if (info === null) {
            readBackError = 'ReadBackMissing: the multisig account is not readable yet.';
          } else {
            const decoded = decodeMultisigCreationReadBack(info, expectedPda);
            const validation = validateMultisigCreationReadBack({
              expectedAddress: expectedPda,
              expectation: creationExpectation,
              readBack: decoded,
            });
            if (validation.verified) {
              readBack = validation.readBack;
            } else {
              readBackError = validation.errors.join(' ');
              // Mismatch DETERMINISTE (owner/threshold/membre/permissions…) :
              // jamais classe comme une simple panne reseau.
              mismatchDeterministic = validation.errors.every(
                (error) => !isTemporaryNetworkFailure(error),
              );
            }
          }
        } catch (caught: unknown) {
          const detail = caught instanceof Error ? caught.message : String(caught);
          readBackError = `ReadBackDecodeFailed: ${detail}`;
          mismatchDeterministic = !isTemporaryNetworkFailure(detail);
        }
      }

      if (readBack !== null) {
        // Trois preuves reunies : signature, confirmation, read-back coherent.
        // Aucun envoi, aucune signature : on ne fait que completer le resultat.
        setCreateResult((previous) =>
          previous === null
            ? previous
            : {
                ...previous,
                confirmed: true,
                errorCode: null,
                errorMessage: null,
                readBack,
                signingState: 'confirmed',
                verified: true,
              },
        );
        setCreateError(null);
        setCheckError(null);
        setVerificationMismatch(false);
        setCheckReport('Vault created and verified.');
        setOperationReport(
          buildOperationReport({
            evidence: { confirmed: true, readBackVerified: true, signatureObtained: true },
            state: 'operation-created-and-verified',
          }),
        );
        // Meme effet local que l'envoi initial : retrouver le vault plus tard.
        const memberLabels: Record<string, string> = {};
        for (const member of plan.members) {
          if (member.label.length > 0) memberLabels[member.key] = member.label;
        }
        await registry.add({
          address: readBack.address,
          memberLabels,
          source: 'created',
          vaultName,
        });
        // Le vault CREÉ (verifie apres coup) devient le DERNIER UTILISE, avec
        // son seuil et son nombre de membres REELS relus on-chain.
        await usage.markUsed(readBack.address, {
          memberCount: readBack.memberCount,
          threshold: readBack.threshold,
        });
        return;
      }

      if (confirmed) {
        if (readBackError !== null) setCheckError(readBackError);
        setVerificationMismatch(mismatchDeterministic);
        setCheckReport(
          mismatchDeterministic
            ? 'Verification mismatch: the on-chain configuration does not match the configuration you reviewed.'
            : readBackError !== null && isTemporaryNetworkFailure(readBackError)
              ? 'Transaction confirmed. Vault verification is temporarily unavailable.'
              : 'Transaction confirmed. Vault details are not readable yet.',
        );
        setOperationReport(
          buildOperationReport({
            evidence: { confirmed: true, readBackVerified: false, signatureObtained: true },
            state: 'transaction-confirmed-readback-failed',
          }),
        );
        return;
      }

      // Pas encore confirmee : lecture seule, aucune preuve n'avance.
      setCheckReport('Still not confirmed on-chain. Check transaction again later.');
      setOperationReport(
        buildOperationReport({
          evidence: { confirmed: false, readBackVerified: false, signatureObtained: true },
          state: 'signature-obtained-confirmation-pending',
        }),
      );
    } catch (caught: unknown) {
      // Erreur RPC/reseau : conservee pour Troubleshooting details, jamais
      // concatenee dans le message principal. Signature et bouton conserves.
      const detail = caught instanceof Error ? caught.message : String(caught);
      setCheckError(detail);
      setCheckReport(
        isTemporaryNetworkFailure(detail)
          ? 'Transaction confirmed. Vault verification is temporarily unavailable.'
          : 'Transaction verification failed: see troubleshooting details.',
      );
    } finally {
      setChecking(false);
    }
  }, [checking, connection, createResult, creationExpectation, expectedMultisigPda, plan, registry, usage, vaultName]);

  const onCreateOnDevnet = useCallback(() => {
    const creator = walletAddress;
    if (creator === null || creating || sendAttemptedRef.current) return;
    setCreating(true);
    setCreateError(null);
    setCreateResult(null);
    // Nouvelle tentative : aucun vestige de la precedente (adresse attendue,
    // preuve relue, erreur technique du recheck).
    setExpectedMultisigPda(null);
    setCheckEvidence(null);
    setCheckReport(null);
    setCheckError(null);
    setVerificationMismatch(false);
    setCreationCost(null);
    void (async () => {
      try {
        const prepared = await prepareCreation(creator);
        const charged =
          prepared.simulation.creatorBalanceDelta === null
            ? null
            : Math.abs(prepared.simulation.creatorBalanceDelta);
        // Decomposition NON inventee : le rent vient des lamports reellement
        // alloues au compte multisig simule ; les frais reseau sont le reste,
        // payes par le wallet createur (fee payer).
        setCreationCost(
          decomposeCreationCost({
            rentLamports: prepared.simulation.multisigRentLamports,
            totalLamports: charged,
          }),
        );
        setCreating(false);
        Alert.alert(
          'Create this vault on Devnet?',
          [
            `${plan.members.length} signers · ${plan.threshold} approvals required`,
            `Estimated cost: ${charged === null ? 'unknown' : lamportsToSolDisplay(charged)}`,
            '',
            'Your connected wallet will sign the creation.',
            'The other members do not need to approve this step.',
          ].join('\n'),
          [
            { onPress: () => setCreating(false), style: 'cancel', text: 'Cancel' },
            {
              onPress: () => {
                void confirmAndSend(prepared, creator);
              },
              text: 'Create vault',
            },
          ],
          { cancelable: true, onDismiss: () => setCreating(false) },
        );
      } catch (caught: unknown) {
        setCreateError(caught instanceof Error ? caught.message : String(caught));
        setCreating(false);
      }
    })();
  }, [confirmAndSend, creating, plan, prepareCreation, walletAddress]);

  const goBack = useCallback(() => {
    setStep((previous) => Math.max(previous - 1, 1));
  }, []);

  const goNext = useCallback(() => {
    setStep((previous) => Math.min(previous + 1, STEP_COUNT));
  }, []);

  // Retour systeme Android (bouton physique ET geste, tous deux routes vers
  // onBackPressed) : etape precedente tant qu'il en reste, sinon confirmation
  // d'abandon. Remonter d'une etape ne perd aucune donnee saisie.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const requestDiscard = useCallback(() => {
    Alert.alert('Cancel vault setup?', 'Your current setup will be lost.', [
      { style: 'cancel', text: 'Keep editing' },
      { onPress: () => onCancelRef.current(), style: 'destructive', text: 'Cancel' },
    ]);
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // Apres un succes verifie : le retour systeme sort vers l'inbox, jamais
      // vers le wizard (aucun second envoi possible).
      if (createdAndVerified) {
        onGoToInbox();
        return true;
      }
      if (step > 1) {
        setStep((previous) => Math.max(previous - 1, 1));
        return true;
      }
      requestDiscard();
      return true;
    });
    return () => subscription.remove();
  }, [createdAndVerified, onGoToInbox, requestDiscard, step]);

  const requiredMembers = minMembersFor(setupType ?? 'custom');

  // Le preset « Recommended: 2 of 3 » plafonne a son nombre de signers
  // (minMembersFor('recommended') === 3, cf. SETUP_PRESETS) : une fois atteint,
  // le formulaire d'ajout disparait DEFINITIVEMENT, sans porte de sortie.
  // Le setup « custom » n'a AUCUNE limite : le bloc d'ajout reste toujours rendu.
  const reachedRecommendedSigners =
    setupType === 'recommended' && members.length >= minMembersFor('recommended');
  const showAddSignerBlock = !reachedRecommendedSigners;

  // Message d'INFORMATION (ambre, NON bloquant) du setup custom : un vault a 2
  // signataires peut etre bloque par la perte d'un seul ; a 1 signataire, une
  // seule cle peut tout deplacer. Rien n'est reclame, le custom continue des 2
  // signataires ; le message disparait des que le risque n'existe plus.
  const customSignerRiskMessage =
    setupType !== 'custom'
      ? null
      : members.length === 1
        ? 'With 1 signer, one key can move everything alone.'
        : members.length === 2
          ? 'With 2 signers, losing one blocks the vault.'
          : null;

  const canContinue =
    step === 1
      ? // Nom OBLIGATOIRE des Vault setup : le placeholder n'est jamais une
        // valeur, et des espaces seuls ne comptent pas comme un nom.
        setupType !== null && vaultName.trim().length > 0
      : step === 2
        ? members.length >= requiredMembers
        : step === 3
          ? threshold >= 1 && threshold <= members.length
          : step === 4
            ? draft.validationErrors.length === 0
            : true;

  /** Meme condition que le CTA de Step 5 : verdict unique de preparation. */
  const canCreate =
    walletAddress !== null &&
    plan.readyForInstructionBuild &&
    (createResult === null || attemptOutcome?.allowNewAttempt === true) &&
    !creating;

  /**
   * Echec de PREPARATION (preflight / RPC / simulation) : un message d'erreur
   * existe alors qu'AUCUN `createResult` n'a ete produit — l'echec survient
   * AVANT toute tentative signee. Sans ce garde-fou, hors ligne, l'utilisateur
   * restait devant le CTA principal sans AUCUNE explication (le seul panneau
   * d'echec existant, ETAT B, exige un `createResult`).
   */
  const preparationFailed =
    createError !== null && createResult === null && !creating && !createdAndVerified;
  const preparationNetworkFailure =
    preparationFailed && isTemporaryNetworkFailure(createError ?? '');

  /** Raison utilisateur affichee a cote du CTA (jamais un libelle mort). */
  const createBlockedReason =
    walletAddress === null
      ? { action: 'Connect your wallet', message: 'Connect the wallet that will create this multisig.' }
      : !request.readyForCreation
        ? { action: 'Add members and set the threshold', message: 'Complete the member configuration.' }
        : request.vaultName.trim().length === 0
          ? { action: 'Back to vault setup', message: 'Enter a vault name to continue.' }
          : plan.validationErrors.length > 0
            ? { action: 'Fix the members and the threshold', message: 'Preflight failed.' }
            : {
                action: 'Run the checks again',
                message: creating ? 'Preparing creation…' : 'Ready to create on Devnet.',
              };
  /**
   * Verdict de preparation : la MEME condition que le bouton, avec une raison
   * utilisateur. Aucune validation n'est assouplie. Partage entre Step 5 et
   * l'ecran technique facultatif.
   */
  const createReadiness = (() => {
    if (walletAddress === null) {
      return {
        ready: false,
        reasonCode: 'no-creator-wallet',
        recommendedAction: 'Connect your wallet',
        userMessage: 'Connect your wallet to create this multisig.',
      };
    }
    if (plan.validationErrors.length > 0) {
      return {
        ready: false,
        reasonCode: 'invalid-draft',
        recommendedAction: 'Fix the members and the threshold',
        userMessage: 'Fix the validation errors above.',
      };
    }
    if (!request.readyForCreation) {
      return {
        ready: false,
        reasonCode: 'draft-incomplete',
        recommendedAction: 'Add members and set the threshold',
        userMessage: 'Complete the member configuration.',
      };
    }
    if (request.vaultName.trim().length === 0) {
      return {
        ready: false,
        reasonCode: 'missing-vault-name',
        recommendedAction: 'Back to vault setup',
        userMessage: 'Enter a vault name to create this multisig.',
      };
    }
    if (!plan.readyForInstructionBuild) {
      return {
        ready: false,
        reasonCode: 'plan-not-ready',
        recommendedAction: 'Run the checks again',
        userMessage: 'Run the readiness checks before creating.',
      };
    }
    return {
      ready: true,
      reasonCode: 'ready',
      recommendedAction: 'Create on Devnet',
      userMessage: 'Ready to create on Devnet.',
    };
  })();

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        ref={scrollViewRef}
        scrollEventThrottle={16}
        style={styles.scrollView}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel vault creation"
            hitSlop={{ bottom: 8, left: 8, right: 8, top: 8 }}
            onPress={requestDiscard}
            style={({ pressed }) => [styles.ghostAction, pressed && styles.pressed]}
          >
            <Text style={styles.ghostActionText}>Cancel</Text>
          </Pressable>
          <DevnetPill />
        </View>

        <Text style={styles.title}>Create a vault</Text>
        <Text style={styles.stepBar}>Step {step} of {STEP_COUNT}</Text>

        {/* Progression du wizard visible : un segment par etape, l'etape courante
            et les precedentes marquees. Purement visuel, aucun pas ajoute. */}
        <View style={styles.progressRow}>
          {Array.from({ length: STEP_COUNT }, (_entry, index) => index + 1).map((value) => (
            <View
              key={`progress-${value}`}
              style={[styles.progressSegment, value <= step && styles.progressSegmentActive]}
            />
          ))}
        </View>

        {step === 1 ? (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>Choose your setup</Text>
            {visiblePresets.map((preset) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: setupType === preset.type }}
                key={preset.type}
                onPress={() => chooseSetup(preset.type, preset.threshold)}
                style={({ pressed }) => [
                  styles.option,
                  setupType === preset.type && styles.optionSelected,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.optionHeader}>
                  <Text style={styles.optionTitle}>{preset.title}</Text>
                  {setupType === preset.type ? <Text style={styles.optionCheck}>✓</Text> : null}
                </View>
                <Text style={styles.optionDetail}>
                  {presetDetailOverride[preset.type] ?? preset.detail}
                </Text>
              </Pressable>
            ))}

            <Text style={styles.fieldLabel}>Vault name *</Text>
            <TextInput
              autoCapitalize="words"
              onChangeText={setVaultName}
              onBlur={() => {
                setNameTouched(true);
                onFieldBlur();
              }}
              onFocus={onFieldFocus('vaultName')}
              placeholder="Personal savings vault"
              placeholderTextColor={colors.textMuted}
              ref={registerField('vaultName')}
              style={styles.input}
              value={vaultName}
            />
            {/* Nom OBLIGATOIRE : le placeholder ne devient jamais la valeur. */}
            <Text style={styles.fieldHint}>
              Required. Enter a name for this vault.
            </Text>
            {vaultName.trim().length === 0 && nameTouched ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="warning">
                <InfoText tone="warning">Enter a vault name to continue.</InfoText>
              </InfoBox>
            ) : null}
          </View>
        ) : null}

        {step === 2 ? (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>Add signers</Text>

            {walletAddress !== null ? (
              walletAlreadyMember ? (
                <Text style={styles.hint}>Your connected wallet is already a signer.</Text>
              ) : (
                <PillButton
                  label={`Add connected wallet (${shortenMemberAddress(walletAddress)})`}
                  onPress={addConnectedWallet}
                  variant="secondary"
                />
              )
            ) : (
              <Text style={styles.hint}>
                No wallet connected: add signers manually below.
              </Text>
            )}

            {/* Formulaire d'ajout d'un signer : chaque champ dans SON PROPRE
                conteneur, ordre vertical STRICT (adresse -> label -> bouton).
                Aucune position absolue, hauteur automatique, CTA sous les champs,
                atteignable au scroll (voir styles.fieldBlock).
                Le bloc n'est masque QUE par le preset recommande, une fois ses
                3 signers ajoutes (voir showAddSignerBlock) ; le setup custom le
                garde toujours visible. */}
            {showAddSignerBlock ? (
              <>
                {/* 1) Signer address — champ partage avec « Paste » integre. Le collage
                    remplit le champ UNIQUEMENT. Aucun membre ajoute, aucun role. */}
                <View style={styles.fieldBlock}>
                  <AddressInput
                    inputRef={registerField('pendingAddress')}
                    label="Public address"
                    onBlur={onFieldBlur}
                    onChangeText={setPendingAddress}
                    onFocus={onFieldFocus('pendingAddress')}
                    placeholder="Solana public address"
                    testID="member-pending-address"
                    value={pendingAddress}
                  />
                </View>

                {/* 2) Signer label — conteneur separe, label separe du champ. */}
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Signer label</Text>
                  <TextInput
                    autoCapitalize="words"
                    onChangeText={setPendingLabel}
                    onBlur={onFieldBlur}
                    onFocus={onFieldFocus('pendingLabel')}
                    placeholder="Ledger at home"
                    placeholderTextColor={colors.textMuted}
                    ref={registerField('pendingLabel')}
                    style={styles.input}
                    value={pendingLabel}
                  />
                </View>

                {/* 3) roles/permissions : absents du formulaire d'ajout aujourd'hui. */}

                {/* 4) « Add signer » SOUS les champs, dans son propre conteneur. */}
                <View style={styles.fieldBlock}>
                  <PillButton label="Add signer" onPress={addPendingMember} variant="secondary" />
                </View>
              </>
            ) : null}

            {pendingError !== null ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="error">
                <InfoText tone="error">{pendingError}</InfoText>
              </InfoBox>
            ) : null}

            {/* Titre de liste FIXE : « Signers », sans compteur, a toutes les
                etapes et quel que soit le nombre de signataires. */}
            <Text style={styles.sectionTitle}>Signers</Text>
            {/* Setup custom : message d'INFORMATION AMBRE (non bloquant) sur le
                risque d'un vault a 2 (ou 1) signataires. Present uniquement dans
                les cas concernes, disparait des que le risque n'existe plus. */}
            {customSignerRiskMessage !== null ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="warning">
                <InfoText tone="warning">{customSignerRiskMessage}</InfoText>
              </InfoBox>
            ) : null}
            {members.map((member) => (
              <Card key={member.id} style={styles.memberCard}>
                {renameId === member.id ? (
                  <View style={styles.renameBlock}>
                    <TextInput
                      autoCapitalize="words"
                      onChangeText={setRenameValue}
                      onBlur={onFieldBlur}
                      onFocus={onFieldFocus(`rename-${member.id}`)}
                      ref={registerField(`rename-${member.id}`)}
                      style={styles.input}
                      value={renameValue}
                    />
                    <Pressable
                      accessibilityRole="button"
                      onPress={commitRename}
                      style={styles.inlineAction}
                    >
                      <Text style={styles.inlineActionText}>Save label</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Text style={styles.memberLabel}>{member.label}</Text>
                    <Text style={styles.memberAddress}>
                      {shortenMemberAddress(member.publicKey)}
                    </Text>
                    <View style={styles.memberActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Rename ${member.label}`}
                        onPress={() => startRename(member)}
                        style={styles.inlineAction}
                      >
                        <Text style={styles.inlineActionText}>Rename</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${member.label}`}
                        onPress={() => removeMember(member.id)}
                        style={styles.inlineAction}
                      >
                        <Text style={styles.inlineActionText}>Remove</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </Card>
            ))}

            {draft.validationErrors.length > 0 ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="error">
                {draft.validationErrors.map((message) => (
                  <InfoText key={message} tone="error">{message}</InfoText>
                ))}
              </InfoBox>
            ) : null}
          </View>
        ) : null}

        {step === 3 ? (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>Threshold</Text>
            <Text style={styles.hint}>
              How many signers must approve before anything can move?
            </Text>
            {members.length === 0 ? (
              <Text style={styles.hint}>Add signers first.</Text>
            ) : (
              <View style={styles.kindRow}>
                {Array.from({ length: members.length }, (_entry, index) => index + 1).map((value) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: threshold === value }}
                    key={value}
                    onPress={() => {
                      setThreshold(value);
                      setThresholdTouched(true);
                    }}
                    style={({ pressed }) => [
                      styles.kindChip,
                      threshold === value && styles.kindChipSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.kindChipText,
                        threshold === value && styles.kindChipTextSelected,
                      ]}
                    >
                      {value}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <Text style={styles.fieldValue}>
              {threshold} of {members.length} approvals required.
            </Text>
            {/* Panneau de seuil pour un vault de TROIS signataires : le TON et
                les TEXTES suivent le seuil selectionne — 2 = vert recommande,
                1 = danger (rouge), 3 = avertissement (ambre). Tokens du theme
                uniquement (tons `success` / `error` / `warning` de la primitive).
                « 2 of 2 » n'est jamais presente comme recommande. */}
            {thresholdGuidance !== null ? (
              <InfoBox
                glyph={thresholdGuidance.glyph}
                style={
                  thresholdGuidance.tone === 'success'
                    ? styles.infoBox
                    : [styles.infoBox, styles.alertBoxTop]
                }
                tone={thresholdGuidance.tone}
              >
                <InfoText tone={thresholdGuidance.tone}>{thresholdGuidance.label}</InfoText>
                <InfoText>{thresholdGuidance.detail}</InfoText>
              </InfoBox>
            ) : null}
            {lowSecurityThresholdWarning(members.length, threshold) !== null ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBoxTop]} tone="warning">
                <InfoText tone="warning">{LOW_SECURITY_THRESHOLD_LABEL}</InfoText>
                <InfoText tone="warning">{LOW_SECURITY_THRESHOLD_DETAIL}</InfoText>
                <InfoText tone="warning">
                  {'To continue with this setting, confirm explicitly: "'}
                  {LOW_SECURITY_THRESHOLD_CONFIRM}
                  {'".'}
                </InfoText>
              </InfoBox>
            ) : null}
            {/* EXACTEMENT 2-of-2 : alerte de disponibilite affichee IMMEDIATEMENT
                (des l'etape Threshold), sans bloquer ni ecraser le choix. */}
            {twoOfTwoAvailabilityRisk ? (
              <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBoxTop]} tone="warning">
                <InfoText tone="warning">Availability risk</InfoText>
                <InfoText tone="warning">
                  If either signer loses access, the vault may become permanently unusable.
                </InfoText>
                <InfoText tone="warning">
                  Use this setup only if both signers have reliable recovery plans.
                </InfoText>
              </InfoBox>
            ) : null}
            {/* Phrase recapitulative coherente avec le seuil choisi : elle suit
                la MÊME selection que le panneau ci-dessus (3 signataires). */}
            {thresholdGuidance !== null ? (
              <Text style={styles.hint}>{thresholdGuidance.summary}</Text>
            ) : null}
          </View>
        ) : null}

        {step === 4 ? (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>Vault configuration</Text>

            <Text style={styles.checkLine}>
              {members.length >= 2 ? '✓ ' : '✗ '}
              {members.length} valid signer addresses
            </Text>
            <Text style={styles.checkLine}>
              {threshold >= 1 && threshold <= members.length ? '✓ ' : '✗ '}
              {threshold} of {members.length} approvals required
            </Text>
            <Text style={styles.checkLine}>
              {draft.validationErrors.length === 0 ? '✓ ' : '✗ '}
              No duplicate addresses
            </Text>

            {draft.validationErrors.map((message) => (
              <InfoBox glyph="⚠" key={message} style={[styles.infoBox, styles.alertBox]} tone="error">
                <InfoText tone="error">{message}</InfoText>
              </InfoBox>
            ))}
            {draft.validationWarnings.map((message) => (
              <InfoBox glyph="⚠" key={message} style={[styles.infoBox, styles.alertBox]} tone="warning">
                <InfoText tone="warning">{message}</InfoText>
              </InfoBox>
            ))}

            {/* Conseils pratiques : jamais un langage de validation technique. */}
            <InfoBox glyph="ℹ" style={styles.infoBox}>
              <Text style={styles.infoHeading}>Good to know</Text>
              <InfoText>
                Verify hardware wallet addresses on the hardware device itself.
              </InfoText>
              <InfoText>
                Multisig never asks for a recovery phrase or private key.
              </InfoText>
            </InfoBox>
          </View>
        ) : null}

        {step === 5 ? (
          <View style={styles.block}>
            <Text style={styles.blockTitle}>Review</Text>

            {!createdAndVerified ? (
              <>
              <Text style={styles.fieldLabel}>Vault name *</Text>
              <Text style={styles.fieldValue}>
                {vaultName.trim().length > 0 ? vaultName.trim() : 'Vault name required'}
              </Text>

              <Text style={styles.fieldLabel}>Members ({members.length})</Text>
              {members.map((member) => (
                <View key={member.id} style={styles.reviewMember}>
                  <Text style={styles.memberLabel}>
                    {member.label}
                  </Text>
                  <Text selectable style={styles.memberAddress}>{member.publicKey}</Text>
                </View>
              ))}

              <Text style={styles.fieldLabel}>Threshold</Text>
              <Text style={styles.fieldValue}>
                {threshold} of {members.length}
              </Text>

              {/* Version COMPACTE de l'alerte 2-of-2 conservee sur la Review finale. */}
              {twoOfTwoAvailabilityRisk ? (
                <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBoxTop]} tone="warning">
                  <InfoText tone="warning">Availability risk</InfoText>
                  <InfoText tone="warning">
                    If either signer loses access, the vault may become permanently unusable.
                  </InfoText>
                  <InfoText tone="warning">
                    Use this setup only if both signers have reliable recovery plans.
                  </InfoText>
                </InfoBox>
              ) : null}

              <Text style={styles.fieldLabel}>Network</Text>
              <Text style={styles.fieldValue}>Devnet</Text>

              {/* Resume UNIQUE : plus de triple libelle de preparation. */}
              <Card style={styles.summaryBox}>
                <Text style={ready ? styles.statusReady : styles.warningText}>
                  {ready ? 'Vault ready' : 'Not ready yet — see below'}
                </Text>
                <Text style={styles.hint}>
                  {members.length} signers · {threshold} approvals required · Devnet
                </Text>
              </Card>

              {/* Erreurs bloquantes et avertissements rappeles ici : la revue doit
                  rester lisible sans revenir a l'etape Security check. */}
              {draft.validationErrors.length > 0 ? (
                <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="error">
                  {draft.validationErrors.map((message) => (
                    <InfoText key={message} tone="error">{message}</InfoText>
                  ))}
                </InfoBox>
              ) : null}

              {draft.validationWarnings.length > 0 ? (
                <InfoBox glyph="⚠" style={[styles.infoBox, styles.alertBox]} tone="warning">
                  {draft.validationWarnings.map((message) => (
                    <InfoText key={message} tone="warning">{message}</InfoText>
                  ))}
                </InfoBox>
              ) : null}

              {/* Cout estime : TOUJOURS en SOL (jamais de lamports a l'ecran).
                  Total issu de la simulation reelle ; decomposition rent/frais
                  uniquement quand les deux composantes sont disponibles. */}
              {creationCost !== null && costTotalSol !== null && vaultVisibleState !== 'awaiting-wallet' ? (
                <Card style={styles.summaryBox}>
                  <Text style={styles.fieldLabel}>Estimated creation cost</Text>
                  <Text style={styles.costValue}>{costTotalSol}</Text>

                  {costBreakdownAvailable ? (
                    <>
                      <Text style={styles.fieldLabel}>Includes</Text>
                      <Text style={styles.fieldValue}>• Account creation / rent: {costRentSol}</Text>
                      <Text style={styles.fieldValue}>• Network fee: {costFeeSol}</Text>
                      <Text style={styles.hint}>Network fee paid by your connected wallet.</Text>
                    </>
                  ) : (
                    <Text style={styles.hint}>Cost breakdown unavailable</Text>
                  )}

                  <Text style={styles.hint}>Final cost may vary slightly before signing.</Text>

                  {usdEstimate !== null ? (
                    <>
                      <Text style={styles.fieldValue}>{usdEstimate}</Text>
                      {priceUpdatedAt !== null ? (
                        <Text style={styles.hint}>
                          Indicative mainnet SOL value — {priceUpdatedAt}
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <Text style={styles.hint}>{USD_ESTIMATE_UNAVAILABLE}</Text>
                  )}

                  <Text style={styles.hint}>{DEVNET_SOL_DISCLAIMER}</Text>
                </Card>
              ) : null}

              {/* ETAT 1 — avant tentative : verdict de preparation
                  (createReadiness) + recapitulatif deja affiche ci-dessus.
                  Quand tout est pret, le statut est une PETITE ligne/badge (jamais
                  un gros bloc adjacent au bouton). Sinon, un bandeau d'action.
                  Masque pendant la creation (ETAT 2) et apres succes. */}
              {vaultVisibleState !== 'awaiting-wallet' ? (
                canCreate ? null : (
                  <InfoBox glyph="⚠" style={[styles.noticeBox, styles.alertBoxTop]} tone="warning">
                    <InfoText tone="warning">{createReadiness.userMessage}</InfoText>
                    <InfoText tone="warning">{createReadiness.recommendedAction}</InfoText>
                    <InfoText tone="warning">{createBlockedReason.message}</InfoText>
                    <InfoText tone="warning">{createBlockedReason.action}</InfoText>
                  </InfoBox>
                )
              ) : null}

              {/* ECHEC DE PREPARATION (hors ligne, RPC injoignable…) : un retour
                  HUMAIN toujours visible a cote du CTA, jamais un bouton mort
                  sans explication. Le CTA reste ACTIONNABLE (canCreate
                  inchange) : un simple nouveau tap relance la preparation,
                  aucun nouveau flux de reessai n'est cree. */}
              {preparationFailed ? (
                <InfoBox glyph="⚠" style={[styles.noticeBox, styles.alertBoxTop]} tone="warning">
                  <InfoText tone="warning">
                    {preparationNetworkFailure
                      ? 'You appear to be offline'
                      : 'Creation could not be prepared'}
                  </InfoText>
                  <InfoText tone="warning">
                    {preparationNetworkFailure
                      ? 'Check your connection and try again. Nothing was signed and nothing was sent.'
                      : 'See troubleshooting details below, then try again. Nothing was signed and nothing was sent.'}
                  </InfoText>
                </InfoBox>
              ) : null}

              {/* ETAT 2 — creation en cours : progression uniquement. */}
              {vaultVisibleState === 'awaiting-wallet' ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator color={colors.mint} />
                  <Text style={styles.hint}>Preparing creation…</Text>
                </View>
              ) : null}

              {/* CTA PRINCIPAL UNIQUE (ETAT 1 et ETAT 3) : meme handler que
                  l'ancien ecran de transaction. Le libelle bascule sur « Prepare
                  again » seulement si la machine d'etat autorise une nouvelle
                  tentative. JAMAIS rendu pendant la creation (ETAT 2), des qu'une
                  signature existe (ETAT 4) ou apres succes (ETAT 5). */}
              {!signatureObtained && vaultVisibleState !== 'awaiting-wallet' ? (
                <View style={styles.ctaBlock}>
                  <PillButton
                    busy={creating}
                    disabled={!canCreate || creating}
                    label={needsPrepareAgain ? 'Prepare again' : 'Review and create'}
                    onPress={onCreateOnDevnet}
                    variant="primary"
                  />

                  <Text style={styles.hint}>
                    Your wallet will ask you to sign on Devnet.
                  </Text>
                  <Text style={styles.hint}>
                    Nothing is sent on-chain before the final confirmation.
                  </Text>
                </View>
              ) : null}

              {/* ETAT B — echec AVANT signature : rien n'a ete signe ni envoye.
                  Copie HUMAINE et courte en ton AVERTISSEMENT (une annulation
                  n'est pas une panne) ; les details techniques vivent dans
                  Troubleshooting details, jamais dans ce panneau. Le flux de
                  nouvelle tentative reste le CTA unique ci-dessus. */}
              {nothingWasSent ? (
                <InfoBox glyph="⚠" style={[styles.noticeBox, styles.alertBoxTop]} tone="warning">
                  <InfoText tone="warning">{CREATION_CANCELLED_TITLE}</InfoText>
                  <InfoText tone="warning">{CREATION_CANCELLED_BODY}</InfoText>
                  <InfoText>
                    {needsPrepareAgain
                      ? 'Prepare again is available: no signature was obtained.'
                      : 'A new attempt is not available right now.'}
                  </InfoText>
                </InfoBox>
              ) : null}

              {/* ETAT C — signature obtenue, PAS encore confirmee. Un seul libelle,
                  derive des preuves : jamais de contradiction avec le statut. */}
              {vaultVisibleState === 'signed-pending-confirmation' ? (
                <InfoBox glyph="⏳" style={[styles.noticeBox, styles.alertBoxTop]} tone="warning">
                  <InfoText tone="warning">
                    {VAULT_VISIBLE_LABELS['signed-pending-confirmation']}
                  </InfoText>
                  <Text selectable style={styles.fieldValue}>
                    Signature: {createResult?.signature}
                  </Text>
                  <Text style={styles.hint}>Confirmation: {signatureStatus}</Text>
                  <Text style={styles.hint}>Vault verification: pending</Text>
                  {checkReport !== null ? <Text style={styles.hint}>{checkReport}</Text> : null}
                  <View style={styles.recheckBlock}>
                    <PillButton
                      accessibilityLabel="Check transaction again"
                      busy={checking}
                      disabled={checking}
                      label="Check transaction again"
                      onPress={() => {
                        void onCheckTransactionAgain();
                      }}
                      variant="secondary"
                    />
                  </View>
                  {signatureVerdict?.retryAllowed !== true ? (
                    <Text style={styles.hint}>
                      A signature already exists: no second send is allowed until the transaction is
                      proven absent, expired or failed.
                    </Text>
                  ) : null}
                </InfoBox>
              ) : null}

              {/* ETAT D — transaction CONFIRMEE mais read-back pas encore disponible.
                  Bloc principal NEUTRE : rien a renvoyer, la signature est valide. Le
                  rouge est reserve a un echec definitivement prouve. */}
              {vaultVisibleState === 'confirmed-pending-readback' ||
              vaultVisibleState === 'confirmed-readback-temporarily-unavailable' ? (
                <InfoBox glyph="⏳" style={styles.noticeBox} tone="info">
                  <Text style={styles.infoHeading}>Transaction confirmed</Text>
                  <InfoText>
                    {vaultVisibleState === 'confirmed-readback-temporarily-unavailable'
                      ? 'The vault details could not be loaded because the network connection was unavailable.'
                      : 'The vault details are not readable yet.'}
                  </InfoText>
                  <InfoText>Nothing needs to be sent again.</InfoText>
                  <Text selectable style={styles.fieldValue}>
                    Signature: {createResult?.signature}
                  </Text>
                  <Text style={styles.hint}>Confirmation: {signatureStatus}</Text>
                  <Text style={styles.hint}>Vault verification: pending</Text>
                  {checkReport !== null ? <Text style={styles.hint}>{checkReport}</Text> : null}
                  <View style={styles.recheckBlock}>
                    <PillButton
                      accessibilityLabel="Check transaction again"
                      busy={checking}
                      disabled={checking}
                      label="Check transaction again"
                      onPress={() => {
                        void onCheckTransactionAgain();
                      }}
                      variant="secondary"
                    />
                  </View>
                  {operationReport?.actions.allowReconnect === true ? (
                    <View style={styles.recheckBlock}>
                      <PillButton
                        accessibilityLabel="Reconnect wallet"
                        label="Reconnect wallet"
                        onPress={() => {
                          void onReconnectWallet();
                        }}
                        variant="secondary"
                      />
                    </View>
                  ) : null}
                  <Text style={styles.hint}>
                    A signature already exists: no second send is allowed until the transaction is
                    proven absent, expired or failed.
                  </Text>
                </InfoBox>
              ) : null}
              </>
            ) : null}

            {/* ETAT D — succes : creation confirmee ET multisig relu/verifie.
                Le libelle d'accessibilite porte la formulation historique
                « Vault created and verified. » ; a l'ecran, le succes est
                decompose en « ✓ Vault created » puis « Verified on-chain ». */}
            {createdAndVerified ? (
              <View accessibilityLabel="Vault created and verified." accessibilityRole="text">
                <Card style={styles.successBox}>
                  <Text style={styles.successHeading}>✓ Vault created</Text>
                  <View style={styles.verifiedBadge}>
                    <Text style={styles.verifiedBadgeText}>Verified on-chain</Text>
                  </View>

                  {/* Les adresses COMPLETES ne sont plus le contenu principal :
                      elles restent dans le recu technique replie. */}
                  <Text style={styles.fieldLabel}>Approvals required</Text>
                  <Text style={styles.fieldValue}>
                    {createResult?.readBack?.threshold} of {createResult?.readBack?.memberCount}
                  </Text>
                  <Text style={styles.fieldLabel}>Signers</Text>
                  <Text style={styles.fieldValue}>{createResult?.readBack?.memberCount}</Text>
                  <Text style={styles.fieldLabel}>Signature</Text>
                  <Text style={styles.fieldValue}>
                    {shortenSignature(createResult?.signature)}
                  </Text>

                  {/* CTA principal unique : « Open vault ». « View proposals » est un
                      lien secondaire (jamais trois gros boutons concurrents). */}
                  <View style={styles.successActions}>
                    <PillButton
                      accessibilityLabel="Open the created vault"
                      label="Open vault"
                      onPress={() => {
                        const address = createResult?.readBack?.address ?? null;
                        if (address !== null) onOpenVault({ address, vaultName });
                      }}
                      variant="primary"
                    />
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        const address = createResult?.readBack?.address ?? null;
                        if (address !== null) onViewProposals({ address, vaultName });
                      }}
                      style={({ pressed }) => [styles.successLink, pressed && styles.pressed]}
                    >
                      <Text style={styles.successLinkText}>View proposals</Text>
                    </Pressable>
                  </View>

                  {/* Reçu technique REPLIÉ par defaut : la signature COMPLÈTE n'est
                      visible qu'ici, jamais en clair dans le parcours. */}
                  <Pressable
                    accessibilityLabel="Technical receipt"
                    accessibilityRole="button"
                    onPress={() => setReceiptOpen((open) => !open)}
                    style={({ pressed }) => [styles.receiptToggle, pressed && styles.pressed]}
                  >
                    <Text style={styles.receiptToggleText}>
                      {receiptOpen ? 'Hide technical receipt' : 'Technical receipt'}
                    </Text>
                  </Pressable>
                  {receiptOpen ? (
                    <View style={styles.detailBox}>
                      <Text selectable style={styles.detailText}>
                        Signature: {createResult?.signature}
                      </Text>
                      <Text selectable style={styles.detailText}>
                        Main vault: {mainVaultAddress ?? 'unavailable'}
                      </Text>
                      <Text selectable style={styles.detailText}>
                        Multisig configuration: {createResult?.readBack?.address ?? 'unavailable'}
                      </Text>
                    </View>
                  ) : null}
                </Card>
              </View>
            ) : null}

            {/* ETAT E — transaction CONFIRMEE mais configuration NON conforme
                (owner/threshold/membre/permissions…). Echec DETERMINISTE : aucun
                second envoi, aucune ouverture de wallet, aucun Prepare again. */}
            {vaultVisibleState === 'confirmed-verification-mismatch' ? (
              <InfoBox glyph="✕" style={[styles.errorBox, styles.alertBoxTop]} tone="error">
                <InfoText tone="error">Transaction confirmed</InfoText>
                <InfoText tone="error">
                  The multisig account could not be verified against the configuration you
                  reviewed.
                </InfoText>
                <InfoText tone="error">Nothing needs to be sent again.</InfoText>
                <Text selectable style={styles.fieldValue}>
                  Signature: {createResult?.signature}
                </Text>
                <Text style={styles.hint}>Confirmation: {signatureStatus}</Text>
                <Text style={styles.hint}>Vault verification: failed</Text>
                <InfoText tone="error">Verification mismatch</InfoText>
                <Text style={styles.hint}>
                  The exact differences are in Troubleshooting details. No second send is allowed
                  while a confirmed signature exists.
                </Text>
              </InfoBox>
            ) : null}

            {/* TROUBLESHOOTING DETAILS — repliable, affiche uniquement si au
                moins un diagnostic existe. Jamais une etape obligatoire. */}
            {hasDiagnostics ? (
              <View style={[styles.block, styles.troubleshootingBlock]}>
                <PillButton
                  accessibilityLabel="Troubleshooting details"
                  label="Troubleshooting details"
                  onPress={() => setTroubleshootingOpen((open) => !open)}
                  variant="secondary"
                />
                {/* Ferme par defaut : les details techniques ne sont jamais
                    imposes a l'utilisateur. Erreurs RPC completes, MWA, block
                    heights. */}
                {troubleshootingOpen ? (
                  <View style={styles.detailBox}>
                    {/* Resume HUMAIN court : nature de l'echec + etape. */}
                    <Text style={styles.detailSummary}>{troubleshootingDigest.summary}</Text>
                    {/* Detail brut CONDENSE : dedoublonne, reseau factorise en UNE
                        ligne, plafonne. Jamais le pave repete trois fois. */}
                    {troubleshootingDigest.lines.map((message, index) => (
                      <Text key={`digest-${index}`} selectable style={styles.detailText}>
                        {message}
                      </Text>
                    ))}
                    {troubleshootingDigest.hiddenCount > 0 ? (
                      <Text style={styles.detailText}>
                        +{troubleshootingDigest.hiddenCount} more line
                        {troubleshootingDigest.hiddenCount > 1 ? 's' : ''} — open raw details for the full
                        log.
                      </Text>
                    ) : null}
                    {mwaReport !== null && !nothingWasSent ? (
                      <>
                        <Text style={styles.detailText}>MWA step: {mwaReport.step}</Text>
                        <Text style={styles.detailText}>
                          MWA code: {mwaReport.code ?? 'none returned'}
                        </Text>
                        <Text style={styles.detailText}>MWA message: {mwaReport.message}</Text>
                      </>
                    ) : null}
                    {signingStateLabel !== null ? (
                      <Text style={styles.detailText}>Signing state: {signingStateLabel}</Text>
                    ) : null}
                    {checkEvidence !== null ? (
                      <Text style={styles.detailText}>
                        Blockhash: height {checkEvidence.blockHeight ?? 'unknown'} · last valid{' '}
                        {checkEvidence.lastValidBlockHeight ?? 'unknown'}
                      </Text>
                    ) : null}
                    {checkReport !== null ? (
                      <Text style={styles.detailText}>Last recheck: {checkReport}</Text>
                    ) : null}
                    {/* Second niveau de repli : le detail brut INTEGRAL reste
                        consultable a la demande, jamais impose. */}
                    <Pressable
                      accessibilityLabel="Show raw details"
                      accessibilityRole="button"
                      onPress={() => setRawDetailsOpen((open) => !open)}
                      style={({ pressed }) => [styles.rawDetailsToggle, pressed && styles.pressed]}
                    >
                      <Text style={styles.receiptToggleText}>
                        {rawDetailsOpen ? 'Hide raw details' : 'Show raw details'}
                      </Text>
                    </Pressable>
                    {rawDetailsOpen ? (
                      <View>
                        {technicalErrors.map((message, index) => (
                          <Text key={`raw-${index}`} selectable style={styles.detailText}>
                            {message}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.navRow}>
          {step > 1 && !createdAndVerified ? (
            <PillButton label="Back" onPress={goBack} variant="secondary" />
          ) : null}
          {step < STEP_COUNT ? (
            <PillButton
              disabled={!canContinue}
              label="Continue"
              onPress={goNext}
              variant="primary"
            />
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardAvoider: {
    backgroundColor: colors.background,
    flex: 1,
    width: '100%',
  },
  scrollView: {
    backgroundColor: colors.background,
    flex: 1,
    width: '100%',
  },
  container: {
    alignItems: 'stretch',
    backgroundColor: colors.background,
    flexGrow: 1,
    padding: spacing.lg,
    // Meme marge basse que la preview : le dernier bloc du wizard reste
    // atteignable au scroll.
    paddingBottom: spacing.xxl * 2,
  },
  // En-tete du wizard : Discard et la pastille reseau.
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  ghostAction: {
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
  },
  pressed: {
    opacity: 0.82,
  },
  ghostActionText: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: typography.screenTitle - 10,
    fontWeight: '800',
  },
  stepBar: {
    color: colors.textMuted,
    fontSize: typography.caption,
    fontWeight: '700',
    marginBottom: spacing.md,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  // Progression du wizard : une barre de segments, aucun pas ajoute.
  progressRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  progressSegment: {
    backgroundColor: colors.disabled,
    borderRadius: radii.pill,
    flex: 1,
    height: 4,
  },
  progressSegmentActive: {
    backgroundColor: colors.mint,
  },
  block: {
    alignSelf: 'stretch',
  },
  blockTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  option: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    marginTop: spacing.sm,
    padding: spacing.lg,
  },
  optionSelected: {
    borderColor: colors.mint,
    borderWidth: 2,
  },
  optionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  optionTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
  },
  optionCheck: {
    color: colors.mint,
    fontSize: typography.body,
    fontWeight: '800',
  },
  optionDetail: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    marginTop: spacing.xs,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: typography.micro,
    marginTop: spacing.md,
    textTransform: 'uppercase',
  },
  fieldValue: {
    color: colors.text,
    fontSize: typography.bodySmall,
    marginTop: spacing.xs,
  },
  fieldHint: {
    color: colors.textMuted,
    fontSize: typography.caption,
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    color: colors.text,
    fontSize: typography.bodySmall,
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginTop: spacing.lg,
  },
  kindRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  kindChip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: spacing.lg,
  },
  kindChipSelected: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  kindChipText: {
    color: colors.text,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
  kindChipTextSelected: {
    color: colors.onLight,
  },
  hint: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  warningText: {
    color: colors.warning,
    fontSize: typography.secondary,
    marginTop: spacing.xs,
  },
  statusReady: {
    color: colors.success,
    fontSize: typography.bodySmall,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  checkLine: {
    color: colors.text,
    fontSize: typography.bodySmall,
    marginTop: spacing.xs,
  },
  infoBox: {
    marginTop: spacing.md,
  },
  // Correctif LOCAL du déséquilibre vertical des encarts warning/error.
  // La primitive V2 `InfoBox` est FIGÉE par un test (« les primitives V2
  // restent figées ») : elle applique `alignItems: 'flex-start'` et son glyphe
  // (⚠ : fontSize ~15 SANS `lineHeight`) a une boîte de ligne plus haute que
  // le texte (qui, lui, porte un `lineHeight` de 19). Le glyphe gonfle donc la
  // rangée et le texte, calé en haut, laissait plus d'espace SOUS lui qu'AU-
  // dessus (bas du panneau non aligné sur le bas du texte). On corrige l'INSTANCE
  // via le prop `style`, exactement comme les correctifs déjà validés
  // (NewProposalScreen.warningBox, ConnectScreen.dialogWarning) :
  //  - `alignItems: 'center'` : centre verticalement les enfants, le résidu de
  //    hauteur (glyphe − ligne de texte) se répartit à parts égales en haut et
  //    en bas ;
  //  - `padding: spacing.lg` : air interne symétrique (haut = bas).
  // Appliqué EN TABLEAU avec le style existant (styles.infoBox / noticeBox /
  // errorBox) : ces styles sont PARTAGÉS à l'échelle du fichier (y compris des
  // encarts `info`/`success`), on ne les modifie donc pas — on empile ce style
  // par-dessus uniquement sur les 14 encarts warning/error.
  alertBox: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  // Variante HAUT du même correctif : encarts dont le CORPS comporte un TITRE
  // (1re ligne) PUIS du contenu supplémentaire (phrase(s), bouton, divulgation).
  // Centrer verticalement contre tout le bloc décrochait le glyphe ⚠ de son
  // titre ; en `flex-start` la rangée s'aligne en HAUT et le glyphe reste sur la
  // PREMIÈRE ligne. Corps multi-lignes → hauteur de rangée donnée par le corps :
  // aucun déséquilibre vertical réintroduit. Les encarts à contenu COURT (une
  // seule InfoText : nom obligatoire, pendingError, listes de messages brutes)
  // gardent `alertBox`.
  alertBoxTop: {
    alignItems: 'flex-start',
    padding: spacing.lg,
  },
  infoHeading: {
    color: colors.warning,
    fontSize: typography.body,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  noticeBox: {
    marginTop: spacing.lg,
  },
  errorBox: {
    marginTop: spacing.lg,
  },
  successBox: {
    marginTop: spacing.lg,
  },
  // Fond de champ : chaque champ du formulaire signer dans SON PROPRE conteneur.
  // Aucune position absolue, hauteur automatique, espacement vertical coherent.
  fieldBlock: {
    alignSelf: 'stretch',
    marginTop: spacing.md,
  },
  // Statut « Ready » compact (petite ligne/badge, jamais un gros bloc).
  readyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.pill,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  readyBadgeText: {
    color: colors.success,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  successHeading: {
    color: colors.success,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
  },
  verifiedBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.pill,
    borderWidth: 1,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  verifiedBadgeText: {
    color: colors.success,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  successActions: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
  },
  // Lien secondaire « View proposals » : jamais un troisieme gros bouton.
  successLink: {
    alignSelf: 'center',
    borderRadius: radii.pill,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  successLinkText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  receiptToggle: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
  },
  receiptToggleText: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  summaryBox: {
    marginTop: spacing.md,
  },
  // Espace vertical entre un panneau/bloc et le CTA principal qui le suit.
  // Meme token que les autres ecarts « bloc -> bouton » de l'ecran
  // (successActions, noticeBox, errorBox, busyRow : spacing.lg), pour rester
  // coherent sur toute la page. Aucune valeur codee en dur.
  ctaBlock: {
    marginTop: spacing.lg,
  },
  // Meme espace vertical devant le bouton « Troubleshooting details », quand un
  // diagnostic (ex. panneau « Nothing was sent. ») le precede immediatement.
  troubleshootingBlock: {
    marginTop: spacing.lg,
  },
  // Meme espace vertical devant les boutons de relecture INSERES dans les encarts
  // de statut (ETATS C/D) : « Check transaction again » colle au hint au-dessus,
  // et « Reconnect wallet » colle au bouton precedent. Meme token que les autres
  // ecarts « bloc -> bouton » de l'ecran (successActions, noticeBox, errorBox,
  // busyRow, ctaBlock, troubleshootingBlock : spacing.lg). Aucune valeur codee en dur.
  recheckBlock: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
  },
  costValue: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  busyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  memberCard: {
    marginTop: spacing.sm,
  },
  memberLabel: {
    color: colors.text,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
  memberAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: typography.caption,
    marginTop: spacing.xs,
  },
  memberActions: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  renameBlock: {
    alignSelf: 'stretch',
  },
  inlineAction: {
    borderRadius: radii.pill,
    paddingVertical: spacing.xs,
  },
  inlineActionText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  reviewMember: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  detailBox: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  detailText: {
    color: colors.textMuted,
    fontSize: typography.caption,
    marginTop: spacing.xs,
  },
  // Resume humain court en tete du bloc technique : plus visible que le brut.
  detailSummary: {
    color: colors.text,
    fontSize: typography.secondary,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  // Second repli « Show raw details » : meme gabarit que le recu technique.
  rawDetailsToggle: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
  },
  navRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
});
