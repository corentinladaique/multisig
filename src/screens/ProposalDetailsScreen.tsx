import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

import { checkReviewAllowlist } from '../squads/instructionAllowlist';
import {
  signAndSendProposalApproval,
  type ProposalApprovalSignSendResult,
} from '../squads/signAndSendProposalApproval';
import {
  signAndSendProposalExecution,
  type ProposalExecutionSignSendResult,
} from '../squads/signAndSendProposalExecution';
import { connection } from '../solana/connection';
import { confirmSignature } from '../solana/confirmSignature';
import { SAFE_TOP_PADDING } from '../ui/safeAreaPadding';
import { colors, radii, spacing, typography } from '../ui/theme';
import { Card, DevnetPill, InfoBox, InfoText, PillButton } from '../ui/v2/primitives';
import {
  estimateRemainingBalance,
  describeTransferSource,
  lamportsToSolDisplay,
} from '../wallet/vaultBalance';

import { useWalletGuard, type ReviewGuardContext } from '../wallet/useWalletGuard';
import {
  loadProposalReview,
  summarizeOperation,
  type ProposalStatusKind,
} from '../squads/proposals';
import {
  APPROVAL_OUTCOME_LABELS,
  approvalOutcomeActions,
  classifyApprovalOutcome,
  walletHasApproved,
} from '../squads/approvalOutcome';
import {
  PROPOSAL_ACTION_LABELS,
  approvalProgress,
  deriveProposalActionState,
  deriveProposalExecuteState,
  executionNotAvailableDetail,
} from '../squads/proposalActionState';
import { abbreviateAddress, type TransactionReviewModel } from '../types/transactionReview';
import {
  effectiveProposalDisplay,
  type ProposalDisplaySource,
} from '../ui/proposalDisplayState';
import { computeCanConfirm, TransactionReviewScreen } from './TransactionReviewScreen';
import { formatMwaError } from '../wallet/mwaDiagnostics';
import { buildOperationReport, classifyOperationResult, describeAttemptOutcome, isTemporaryNetworkFailure } from '../wallet/operationState';
import {
  isNetworkFailure,
  NETWORK_INCIDENT_BODY,
  NETWORK_INCIDENT_REASSURANCE,
  NETWORK_INCIDENT_TITLE,
} from '../ui/networkFailure';
import {
  forgetPendingSubmission,
  pendingSubmissionFor,
  rememberPendingSubmission,
} from '../wallet/pendingSubmissionMemory';
import { signingStateTitle, type SigningState } from '../wallet/signingWindow';
import { runGuardedExecution } from '../wallet/guardedExecution';

/**
 * Annulation de préparation : rien n'a été signé, rien n'a été envoyé. Copie
 * COURTE et humaine ; le détail technique brut reste réservé au repli
 * « Troubleshooting details ».
 */
const PREPARATION_CANCELLED_TITLE = 'Preparation was cancelled';
const PREPARATION_CANCELLED_BODY = 'Nothing was signed and nothing was sent.';

type OperationFailureResult = {
  confirmed?: boolean;
  errorCode?: string | null;
  errorMessage: string | null;
  signature: string | null;
  signingState?: SigningState;
  validationErrors: string[];
  verified: boolean;
};

/**
 * Titre humain d'un échec : la machine d'état parle d'abord (pour ne jamais
 * présenter « signature obtenue » comme un échec). L'état de signature du
 * module prime : il distingue « requête expirée avant signature » de « signée,
 * confirmation en attente ».
 */
function operationFailureTitle(result: OperationFailureResult): string {
  const evidence = {
    confirmed: result.confirmed === true,
    readBackVerified: result.verified,
    signatureObtained: result.signature !== null,
  };
  return result.signingState !== undefined
    ? signingStateTitle(result.signingState)
    : buildOperationReport({
        evidence,
        state: classifyOperationResult(evidence),
      }).title;
}

/** Diagnostic MWA d'origine, repris verbatim avec son code. */
function operationFailureDetail(result: OperationFailureResult): string {
  return result.errorMessage !== null
    ? formatMwaError({
        code: result.errorCode ?? null,
        message: result.errorMessage,
        step: 'signAndSendTransactions',
      })
    : result.validationErrors.join(' ');
}

/**
 * Message d'échec homogène : titre humain puis diagnostic MWA d'origine.
 */
function describeOperationFailure(result: OperationFailureResult): string {
  return `${operationFailureTitle(result)} ${operationFailureDetail(result)}`;
}

/**
 * Affichage d'un échec d'APPROBATION.
 *
 * Sans signature, la copie est HUMAINE et courte (« Preparation was cancelled »)
 * et le détail brut part dans le diagnostic (repli « Troubleshooting details ») :
 * une annulation de préparation n'est jamais présentée comme un pavé technique.
 * Avec une signature, le couple titre + détail reste inchangé.
 */
function describeApprovalFailure(result: OperationFailureResult): {
  message: string;
  diagnostic: string;
} {
  const diagnostic = `${operationFailureTitle(result)} ${operationFailureDetail(result)}`;
  if (result.signature === null) {
    return {
      diagnostic,
      message: `${PREPARATION_CANCELLED_TITLE}\n${PREPARATION_CANCELLED_BODY}`,
    };
  }
  return { diagnostic, message: diagnostic };
}

/**
 * Copie HUMAINE d'une verification impossible. La signature existe : la
 * transaction n'est ni invalide ni perdue, donc jamais presentee comme un echec.
 */
const EXECUTION_SENT_TITLE = 'Transaction sent';
const EXECUTION_UNVERIFIED_MESSAGE =
  'Verification is temporarily unavailable. Multisig will check again when the network connection returns.';
const EXECUTION_CHECK_FAILED_MESSAGE = 'Verification failed — nothing was sent by this check.';
/**
 * Copie EXACTE d'un doublon concurrent : l'invocation deja en cours detient le
 * verrou. Jamais « awaiting verification » ici : aucun envoi n'a encore eu lieu.
 */
const EXECUTION_ALREADY_STARTING = 'Execution is already starting.';
/** Approbation : meme contrat que l'execution (envoi signe != echec). */
const APPROVAL_SENT_TITLE = 'Approval sent';
const APPROVAL_UNVERIFIED_MESSAGE =
  'Verification is temporarily unavailable. Multisig will check again when the network connection returns.';
/** Lecture prealable impossible : RIEN n'a ete envoye, la copie le dit. */
const EXECUTION_PRECHECK_TITLE = 'Network verification unavailable';
const EXECUTION_PRECHECK_MESSAGE =
  'Multisig could not refresh the latest proposal state. Check your connection and try again. Nothing was sent.';
/** Lecture prealable impossible cote approbation : RIEN n'a ete approuve. */
const APPROVAL_PRECHECK_TITLE = 'Verification pending';
const APPROVAL_PRECHECK_MESSAGE =
  'This proposal could not be read right now, so nothing was approved. Check the network connection and try again.';
/** Reprises AUTOMATIQUES bornees : compte maximal et espacement croissant. */
const MAX_VERIFICATION_ATTEMPTS = 3;
const VERIFICATION_RETRY_DELAYS_MS = [4000, 8000, 15000];

/**
 * Detail d'une proposition : LECTURE SEULE.
 *
 * Aucune écriture : pas d'approbation, pas de rejet, pas d'execution, aucune
 * signature. Aucun appel réseau non plus : tout ce qui est affiché provient des
 * entites déjà lues (`ProposalView`) et d'un modèle DÉJÀ décodé s'il est fourni
 * par l'appelant. Le PDA de proposition et l'adresse de la vault transaction
 * sont dérivés localement par le SDK.
 */

function proposalPda(multisigAddress: string, index: number): string | null {
  try {
    const [pda] = multisig.getProposalPda({
      multisigPda: new PublicKey(multisigAddress),
      transactionIndex: BigInt(index),
    });
    return pda.toBase58();
  } catch {
    return null;
  }
}

export function ProposalDetailsScreen({
  address,
  decodedModel,
  guardContext,
  index,
  members,
  onBack,
  proposal,
  threshold,
  vaultTransactionAddress,
  walletAddress,
}: {
  address: string;
  /** Modèle déjà décodé, aucune lecture déclenchée ici. */
  decodedModel: TransactionReviewModel | null;
  /** Contexte de revue déjà construit par l'appelant, transmis tel quel. */
  guardContext?: ReviewGuardContext | null;
  index: number;
  /** Membres et rôles lus dans le multisig (déjà chargés par le détail). */
  members: readonly { address: string; roles: readonly string[] }[];
  onBack: (verifiedStatus: string | null) => void;
  proposal: {
    approvedAddresses: string[];
    status: ProposalStatusKind;
  };
  threshold: number;
  vaultTransactionAddress: string;
  walletAddress: string | null;
  walletCanApprove: boolean;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  // Section technique repliée par défaut : aucun détail brut à l'ouverture.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // --- Approbation : uniquement des verdicts DÉJÀ calculés par l'existant.
  const { signAndSendTransactions } = useMobileWallet();
  // Décodage fait ICI, quel que soit le chemin d'entrée (Home ou Inbox) :
  // c'est ce qui rend visibles le montant, la destination et la revue, et qui
  // les rafraîchit en relisant la chaîne. Lecture seule, aucun wallet.
  const [selfModel, setSelfModel] = useState<TransactionReviewModel | null>(null);
  const [selfGuardContext, setSelfGuardContext] = useState<ReviewGuardContext | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // Repli du détail technique brut de l'incident réseau : FERMÉ par défaut.
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  // Approbateurs RELUS on-chain : source unique du libelle « Already approved ».
  // Jamais un etat memoire local seul — une reouverture repart de la chaine.
  // §1 : declare AVANT la derivation du contexte de revue pour que CETTE lecture
  // soit la source unique de TOUS les affichages (jamais les props d'ouverture).
  const [onchainApproval, setOnchainApproval] = useState<{
    approvedAddresses: string[];
    status: string;
  } | null>(null);
  const displayProposal = effectiveProposalDisplay(onchainApproval, proposal);

  const deriveGuardContext = useCallback(
    (reviewModel: TransactionReviewModel, display: ProposalDisplaySource): ReviewGuardContext | null => {
      try {
        const multisigPda = new PublicKey(address);
        const [vaultPda] = multisig.getVaultPda({ index: 0, multisigPda });
        return {
          multisig: {
            address,
            members: members.map((member) => ({
              address: member.address,
              roles: [...member.roles],
            })),
            threshold,
            vaultAddress: vaultPda.toBase58(),
          },
          proposal: {
            // §1 : compteurs et statut issus de la MEME source verifiee.
            approvedAddresses: [...display.approvedAddresses],
            index,
            status: display.status,
          },
          review: reviewModel,
          walletAddress,
        };
      } catch {
        return null;
      }
    },
    [address, index, members, threshold, walletAddress],
  );

  /** Relecture + décodage : aucune signature, aucun envoi, aucun wallet. */
  const runDecode = useCallback(async () => {
    setDecoding(true);
    setDecodeError(null);
    try {
      const multisigPda = new PublicKey(address);
      const [vaultPda] = multisig.getVaultPda({ index: 0, multisigPda });
      const result = await loadProposalReview(
        connection,
        multisigPda,
        {
          multisigAddress: address,
          network: 'devnet',
          proposalIndex: index,
          proposalStatus: displayProposal.status,
          signerWallet: walletAddress ?? 'Unknown',
          vaultAddress: vaultPda.toBase58(),
        },
        index,
      );
      setSelfModel(result.model);
      setSelfGuardContext(deriveGuardContext(result.model, displayProposal));
    } catch (caught: unknown) {
      setDecodeError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecoding(false);
    }
  }, [address, deriveGuardContext, displayProposal, index, walletAddress]);

  // Relecture canonique à l'ouverture, quel que soit le chemin (Home ou Inbox) :
  // le modèle et le contexte fournis par l'appelant servent d'affichage immédiat,
  // mais le verdict du guard est TOUJOURS calculé sur une relecture on-chain
  // fraîche — exactement la même lecture que « Refresh proposal ». Strictement
  // en lecture seule : aucun wallet, aucune signature, aucun envoi.
  useEffect(() => {
    void runDecode();
  }, [runDecode]);

  const model = selfModel ?? decodedModel;
  const effectiveGuardContext = selfGuardContext ?? guardContext;

  // Solde du vault, relu à l'ouverture et AVANT chaque exécution. Lecture seule.
  const vaultPda = (() => {
    try {
      return multisig.getVaultPda({ index: 0, multisigPda: new PublicKey(address) })[0].toBase58();
    } catch {
      return null;
    }
  })();
  const [proposalVaultLamports, setProposalVaultLamports] = useState<number | null>(null);
  const readVaultBalance = useCallback(async (): Promise<number | null> => {
    if (vaultPda === null) return null;
    try {
      const lamports = await connection.getBalance(new PublicKey(vaultPda), 'confirmed');
      setProposalVaultLamports(lamports);
      return lamports;
    } catch {
      // Une lecture impossible ne bloque pas l'écran : l'estimation devient
      // indisponible, sans inventer de valeur.
      return null;
    }
  }, [vaultPda]);

  useEffect(() => {
    void readVaultBalance();
  }, [readVaultBalance]);

  const guard = useWalletGuard(effectiveGuardContext ?? null);
  const allowlist = model === null ? null : checkReviewAllowlist(model);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalResult, setApprovalResult] = useState<ProposalApprovalSignSendResult | null>(null);
  // Une seule tentative : jamais deux envois en parallele, jamais de second
  // envoi apres une signature obtenue.
  const approvalAttemptedRef = useRef(false);
  // Approbateurs RELUS on-chain : source unique du libelle « Already approved ».
  // Jamais un etat memoire local seul — une reouverture repart de la chaine.
  // §1 — Verite on-chain si elle a ete relue, sinon donnee fournie par
  // l'appelant. MEME source que le contexte de revue et le decode du modele :
  // aucune surface ne peut plus diverger.
  const effectiveApprovedAddresses = displayProposal.approvedAddresses;
  const effectiveProposalStatus = displayProposal.status;
  const verifiedStatusForReturn = onchainApproval === null ? null : onchainApproval.status;
  // Relecture seule « Check approval again ».
  const [checkingApproval, setCheckingApproval] = useState(false);
  const [approvalCheckReport, setApprovalCheckReport] = useState<string | null>(null);
  // Diagnostic technique d'une tentative ANTERIEURE : jamais prioritaire sur
  // l'etat courant, uniquement dans « Troubleshooting details ».
  const [approvalDiagnostics, setApprovalDiagnostics] = useState<string[]>([]);
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);
  // Relecture seule « Check execution again » : meme contrat que l'approbation.
  const [checkingExecution, setCheckingExecution] = useState(false);
  const [executionCheckReport, setExecutionCheckReport] = useState<string | null>(null);
  // Diagnostic BRUT (RPC, Java, DNS, ReadBack, ConfirmationCheck) d'une execution :
  // jamais dans le bloc principal, uniquement dans « Troubleshooting details ».
  const [executionDiagnostics, setExecutionDiagnostics] = useState<string[]>([]);
  // Reprises bornees : compteur, minuteur, anti-chevauchement, drapeau de demontage.
  const [verificationRound, setVerificationRound] = useState(0);
  const verificationAttemptsRef = useRef(0);
  const verificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verificationInFlightRef = useRef(false);
  // Reprises AUTOMATIQUES bornees de la VERIFICATION D'APPROBATION : miroir
  // exact du mecanisme d'execution, avec des refs SEPAREES (les deux minuteurs
  // ne doivent jamais se marcher dessus). LECTURES seules : aucune signature,
  // aucune reconstruction, aucun envoi, aucun wallet.
  const [approvalVerificationRound, setApprovalVerificationRound] = useState(0);
  const approvalVerificationAttemptsRef = useRef(0);
  const approvalVerificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalCheckInFlightRef = useRef(false);
  // Anti-chevauchement de la relecture de retour au premier plan.
  const refreshInFlightRef = useRef(false);
  const unmountedRef = useRef(false);
  // IDENTITE DE LA PROPOSITION VERIFIEE. Le composant n'est PAS remonte par un
  // changement de proposition (aucune `key` cote appelant) : sans cette garde,
  // une relecture lancee pour la proposition A pourrait ecrire dans l'ecran de
  // la proposition B, et un minuteur de A pourrait relancer une relecture ici.
  const proposalKey = `${address}:${index}`;
  const proposalKeyRef = useRef(proposalKey);
  // Signature d'une execution signee dans ce PROCESSUS mais pas encore verifiee.
  // Elle survit au demontage de l'ecran (jamais a la fermeture de l'app, et
  // jamais persistee). Sans elle, rouvrir la proposition reproposerait Execute
  // alors qu'un envoi signe peut encore etre traite.
  const [rememberedSignature, setRememberedSignature] = useState<string | null>(() =>
    pendingSubmissionFor(proposalKey),
  );
  // (Derivation placee APRES la declaration d'executionResult : voir plus bas.)

  const walletAlreadyApproved = walletHasApproved(effectiveApprovedAddresses, walletAddress);

  const canConfirm =
    model !== null &&
    allowlist !== null &&
    !walletAlreadyApproved &&
    effectiveProposalStatus === 'Active' &&
    computeCanConfirm(model, guard.status, allowlist.status);

  // --- Execution : trois conditions lisibles, aucune invention.
  // Note : le guard de revue vérifie la permission `Vote` (il bloque donc à
  // juste titre un membre qui n'aurait que `Execute`). Exécuter n'est pas
  // approuver : la condition ICI est la permission `Execute`, plus le statut
  // `Approved` et le seuil réellement atteint.
  const walletHasExecute =
    walletAddress !== null &&
    members.some(
      (member) => member.address === walletAddress && member.roles.includes('Execute'),
    );
  const thresholdReached = effectiveApprovedAddresses.length >= threshold;
  const canExecute =
    effectiveProposalStatus === 'Approved' && thresholdReached && walletHasExecute;
  const [executing, setExecuting] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ProposalExecutionSignSendResult | null>(
    null,
  );
  const executionAttemptedRef = useRef(false);
  // Signature d'execution NON verifiee disponible : celle du montage courant, ou
  // celle memorisee dans le processus (ecran rouvert). Tant qu'elle existe,
  // Execute n'est jamais repropose.
  const unverifiedExecutionSignature =
    executionResult?.signature ?? rememberedSignature;

  // Verdict unique de l'UI : sans signature, jamais de libellé « Sent ».
  const approvalOutcome =
    approvalResult === null
      ? null
      : describeAttemptOutcome({
          confirmed: approvalResult.confirmed === true,
          evidence: {
            blockHeight: null,
            lastValidBlockHeight: approvalResult.lastValidBlockHeight ?? null,
            status: approvalResult.confirmationStatus ?? 'notFound',
          },
          networkFailure: isTemporaryNetworkFailure(approvalResult.errorMessage ?? ''),
          signature: approvalResult.signature,
          verified: approvalResult.verified,
        });
  // Etat lisible de l'approbation (libelles exacts) + actions autorisees.
  const approvalState =
    approvalResult === null
      ? null
      : classifyApprovalOutcome({
          confirmed: approvalResult.confirmed === true,
          signature: approvalResult.signature,
          verified: approvalResult.verified,
        });
  const approvalActions = approvalState === null ? null : approvalOutcomeActions(approvalState);
  const approvalLabel =
    approvalState === null ? 'Approval recorded on-chain' : APPROVAL_OUTCOME_LABELS[approvalState];

  // --- États principaux EXCLUSIFS (présentation pure) -------------------
  // « Exécutée » : statut on-chain terminal, ou exécution vérifiée.
  const executed =
    effectiveProposalStatus === 'Executed' || executionResult?.verified === true;
  // Une signature existe mais l'approbation n'est pas encore vérifiée.
  const signaturePendingVerification =
    approvalResult !== null && approvalResult.signature !== null && approvalResult.verified !== true;
  // Nouvelle tentative sans signature (échec avant envoi) : seul cas où le CTA reste.
  const approvalRetry =
    approvalResult !== null &&
    approvalResult.signature === null &&
    (approvalActions?.allowPrepareAgain ?? false);
  // Progression : EXCLUSIVEMENT issue des approbations relues on-chain.
  const progress = approvalProgress({
    approvedCount: effectiveApprovedAddresses.length,
    threshold,
  });
  const actionState = deriveProposalActionState({
    executed,
    signaturePendingVerification,
    thresholdReached: progress.reached,
    walletAlreadyApproved,
  });
  const executeState = deriveProposalExecuteState({
    executed,
    thresholdReached: progress.reached,
    walletHasExecute,
  });

  // Etat TERMINAL atteint : la memoire d'envoi et les minuteurs de reprise n'ont
  // plus lieu d'etre, et aucun reçu « Transaction sent » ne doit reapparaitre en
  // rouvrant une proposition deja Done.
  useEffect(() => {
    if (!executed) return;
    forgetPendingSubmission(proposalKey);
    setRememberedSignature(null);
    if (verificationTimerRef.current !== null) {
      clearTimeout(verificationTimerRef.current);
      verificationTimerRef.current = null;
    }
  }, [executed, proposalKey]);

  const executionOutcome =
    executionResult === null
      ? null
      : describeAttemptOutcome({
          confirmed: executionResult.confirmed === true,
          evidence: {
            blockHeight: null,
            lastValidBlockHeight: executionResult.lastValidBlockHeight ?? null,
            status: executionResult.confirmationStatus ?? 'notFound',
          },
          networkFailure: isTemporaryNetworkFailure(executionResult.errorMessage ?? ''),
          signature: executionResult.signature,
          verified: executionResult.verified,
        });

  const runExecution = async () => {
    // VERROU DE PROPRIETE, teste SYNCHRONEMENT : un doublon concurrent sort ICI,
    // AVANT de toucher a l'etat occupe de la premiere invocation (aucun
    // remplacement de statut, aucune extinction de son spinner).
    if (executionAttemptedRef.current) {
      setExecutionError(EXECUTION_ALREADY_STARTING);
      return;
    }
    setExecuting(true);
    try {
      // L'ORDRE des operations et la PROPRIETE du verrou vivent dans un module
      // PUR et testable (`src/wallet/guardedExecution.ts`). Le verrou est le ref
      // ci-dessus : la seconde invocation est rejetee AVANT toute lecture, tout
      // wallet et tout envoi, et seule la titulaire le rend.
      const result = await runGuardedExecution(executionAttemptedRef, {
        readBalance: readVaultBalance,
        isInsufficientBalance: (freshLamports) =>
          freshLamports !== null &&
          isRecognizedTransfer &&
          sourceVerdict.matches &&
          amountLamports !== null &&
          freshLamports < amountLamports,
        approvalInFlight: () => approving,
        hasUnverifiedExecutionSignature: () => unverifiedExecutionSignature !== null,
        walletConnected: () => walletAddress !== null,
        prepare: () => {
          setExecutionError(null);
          setExecutionResult(null);
        },
        signAndSend: () =>
          signAndSendProposalExecution({
            connection,
            // Le module a deja exige un wallet connecte avant cet appel.
            memberAddress: walletAddress as string,
            multisigPda: address,
            signAndSendTransactions,
            threshold,
            transactionIndex: index,
          }),
      });
      if (result.kind === 'blocked') {
        if (result.reason === 'balance_unreadable') {
          // P0.2 — Un rejet RPC/DNS ne sort JAMAIS en silence et n'ouvre jamais
          // le wallet : message humain ici, detail brut dans Troubleshooting.
          setExecutionDiagnostics((previous) => [...previous, result.detail ?? '']);
          setExecutionError(
            'Could not verify the vault balance. Nothing was sent. Check your connection and try again.',
          );
        } else if (result.reason === 'insufficient_balance') {
          setExecutionError(
            'Insufficient vault balance: the vault does not hold the amount this proposal moves. Nothing was sent.',
          );
        } else if (result.reason === 'approval_in_flight') {
          setExecutionError('An approval is still being verified. Nothing was sent.');
        } else if (result.reason === 'already_awaiting_verification') {
          setExecutionError(
            'An execution is already awaiting verification. Use Check execution again instead of sending it twice.',
          );
        } else if (result.reason === 'no_wallet') {
          setExecutionError('No wallet connected: an execution must be signed by a member.');
        } else {
          // Doublon concurrent : aucune preuve d'envoi n'existe encore.
          setExecutionError(EXECUTION_ALREADY_STARTING);
        }
        return;
      }
      if (result.kind === 'failed') {
        setExecutionDiagnostics((previous) => [...previous, result.detail]);
        setExecutionError(result.detail);
        return;
      }
      // kind === 'sent' : le wallet a ete ouvert (au plus une fois) et un resultat
      // existe. Une signature, quand elle existe, est une PREUVE — jamais le ref.
      const sent = result.outcome;
      setExecutionResult(sent);
      if (sent.signature !== null) {
        rememberPendingSubmission(proposalKey, sent.signature);
        setRememberedSignature(sent.signature);
      }
      // Après une exécution vérifiée, le solde du vault a changé : on le relit.
      if (sent.verified) void readVaultBalance();
      if (!sent.verified) {
        // Le detail BRUT part dans les diagnostics ; le bloc principal ne montre
        // jamais une pile Java. Sans signature, aucune copie « sent ».
        const raw = describeOperationFailure(sent);
        setExecutionDiagnostics((previous) => [...previous, raw]);
        const networkFailure =
          isTemporaryNetworkFailure(sent.errorMessage ?? '') || isTemporaryNetworkFailure(raw);
        setExecutionError(
          sent.signature !== null && networkFailure
            ? `${EXECUTION_SENT_TITLE}\n${EXECUTION_UNVERIFIED_MESSAGE}`
            : raw,
        );
      }
    } finally {
      // Rend l'etat « occupe » sur TOUS les chemins (succes, blocage, echec) :
      // aucun spinner ne peut plus rester actif. Le verrou, lui, est rendu par le
      // module — et uniquement par l'invocation qui l'avait acquis.
      setExecuting(false);
    }
  };

  /**
   * Tap sur Execute : DOUBLE confirmation explicite avant toute demande au
   * wallet. Rien ne part du premier dialogue, ni d'un effet, ni d'un rendu.
   */
  const onExecute = async () => {
    if (
      !canExecute ||
      insufficientBalance ||
      executing ||
      checkingExecution ||
      executionAttemptedRef.current
    )
      return;
    if (insufficientBalance) {
      setExecutionError(
        'Insufficient vault balance: the vault does not currently hold the amount this proposal moves. Nothing was sent.',
      );
      return;
    }
    // Nouvelle tentative après un échec SANS signature : on repart d'un état
    // propre. Une tentative déjà signée n'ouvre jamais ce chemin (bouton
    // désactivé), donc aucun résultat signé n'est effacé ici.
    if (executionResult !== null && executionOutcome?.allowNewAttempt === true) {
      setExecutionResult(null);
      setExecutionError(null);
    }
    // PORTE DE SECURITE : relecture on-chain AVANT toute confirmation. Le
    // dialogue ne s'appuie jamais sur l'instantane recu en props (c'est ce qui
    // affichait « 1 of 2 » devant une carte a « 2 of 2 »). Une lecture
    // impossible ne regresse rien et n'autorise AUCUN envoi.
    setCheckingExecution(true);
    const fresh = await refreshProposalFromChain();
    setCheckingExecution(false);
    if (fresh === null) {
      setExecutionError(`${EXECUTION_PRECHECK_TITLE}\n${EXECUTION_PRECHECK_MESSAGE}`);
      return;
    }
    if (fresh.status !== 'Approved' || fresh.approvedAddresses.length < threshold) {
      setExecutionError(
        `Approval threshold not yet verified on-chain: ${fresh.approvedAddresses.length} of ${threshold} approvals collected. Nothing was sent.`,
      );
      return;
    }
    const collected = fresh.approvedAddresses.length;
    const destinationLabel =
      fullDestination ?? (summary !== null ? summary.destination : 'the destination');
    const amountLabel =
      amountLamports === null ? 'The stored amount' : lamportsToSolDisplay(amountLamports);
    Alert.alert(
      'Review execution',
      [
        // Destination affichee UNE seule fois, EN ENTIER : l'abrege ne permet pas
        // de verifier ou part l'argent, et la doubler (abrege + complet) rendait
        // le dialogue illisible.
        `${amountLabel} will be transferred to ${destinationLabel}.`,
        `${collected} of ${threshold} approvals collected.`,
        'The approval threshold has been reached.',
        'Your connected wallet will sign the execution.',
      ].join('\n'),
      [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => {
            // DEUXIEME CONFIRMATION CONSERVEE : garde-fou delibere du projet
            // (une execution est irreversible). Volontairement courte, sans
            // repeter l'explication du premier dialogue.
            Alert.alert(
              'Execute now?',
              'This action cannot be undone.',
              [
                { style: 'cancel', text: 'Cancel' },
                {
                  onPress: () => {
                    void runExecution();
                  },
                  style: 'destructive',
                  text: 'Execute',
                },
              ],
              { cancelable: true },
            );
          },
          text: 'Continue',
        },
      ],
      { cancelable: true },
    );
  };

  /**
   * Relecture on-chain de la Proposal : approbateurs et statut RÉELS.
   * Strictement en lecture seule : aucun wallet, aucune signature, aucun envoi.
   */
  const refreshProposalFromChain = async (): Promise<{
    approvedAddresses: string[];
    status: string;
  } | null> => {
    // Identite capturee AVANT la lecture : si la proposition affichee a change
    // pendant l'aller-retour, le resultat ne doit toucher a AUCUN etat.
    const requestKey = proposalKeyRef.current;
    try {
      const [proposalPdaKey] = multisig.getProposalPda({
        multisigPda: new PublicKey(address),
        transactionIndex: BigInt(index),
      });
      const info = await connection.getAccountInfo(proposalPdaKey, 'confirmed');
      if (info === null) return null;
      const [decoded] = multisig.accounts.Proposal.fromAccountInfo(info);
      if (proposalKeyRef.current !== requestKey) return null;
      const fresh = {
        approvedAddresses: decoded.approved.map((entry) => entry.toBase58()),
        status: decoded.status.__kind,
      };
      setOnchainApproval(fresh);
      // P0.4 — La relecture mettait a jour la CARTE mais laissait la TENTATIVE
      // d'approbation (et son erreur) en l'etat : l'ecran pouvait afficher en
      // meme temps « seuil atteint », « Approval sent », « Check approval again »
      // et une ancienne erreur rouge. Des que la chaine PROUVE que ce wallet est
      // approbateur, la tentative est reconciliee et l'erreur courante disparait.
      if (walletAddress !== null && walletHasApproved(fresh.approvedAddresses, walletAddress)) {
        setApprovalResult((previous) =>
          previous === null
            ? previous
            : { ...previous, confirmationStatus: 'confirmed', confirmed: true, verified: true },
        );
        setApprovalError(null);
        setApprovalCheckReport(null);
      }
      return fresh;
    } catch {
      // Une lecture impossible ne fabrique aucun état : on garde le précédent.
      return null;
    }
  };

  /**
   * Relecture LECTURE SEULE au RETOUR AU PREMIER PLAN. Le wallet prend le focus
   * pendant qu'il signe, puis nous le rend : sans cette relecture, une
   * approbation signee dans le wallet n'est JAMAIS vue par cet ecran, et Execute
   * reste bloque jusqu'a une sortie/rentree. Aucun wallet, aucune signature,
   * aucun envoi : uniquement des lectures, protegees contre le chevauchement.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (unmountedRef.current || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      void (async () => {
        try {
          await runDecode();
          await refreshProposalFromChain();
        } finally {
          refreshInFlightRef.current = false;
        }
      })();
    });
    return () => subscription.remove();
  }, [runDecode]);

  /**
   * Relecture SEULE d'une execution DEJA signee : statut de la signature, puis
   * relecture de la Proposal. Renvoie la preuve obtenue, ou null si la lecture
   * n'a rien pu produire. Aucune reconstruction, aucun wallet, aucun envoi.
   */
  const verifyExecutionOnce = async (): Promise<
    { confirmed: boolean; executedOnchain: boolean } | null
  > => {
    const signature = executionResult?.signature ?? rememberedSignature;
    if (signature === null) return null;
    const requestKey = proposalKeyRef.current;
    const confirmation = await confirmSignature({ connection, signature });
    const fresh = await refreshProposalFromChain();
    // Proposition changee pendant la relecture : resultat IGNORE.
    if (proposalKeyRef.current !== requestKey) return null;
    const confirmed = confirmation.status === 'confirmed';
    const executedOnchain = fresh !== null && fresh.status === 'Executed';
    setExecutionResult((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            confirmed,
            confirmationStatus: confirmation.status,
            readBack:
              fresh === null
                ? previous.readBack
                : {
                    proposalAccountPresent: true,
                    proposalStatusAfter: fresh.status,
                    vaultAddress: previous.readBack?.vaultAddress ?? '',
                    vaultLamportsAfter: previous.readBack?.vaultLamportsAfter ?? null,
                    vaultLamportsDelta: previous.readBack?.vaultLamportsDelta ?? null,
                  },
            verified: confirmed && executedOnchain,
          },
    );
    return { confirmed, executedOnchain };
  };

  /**
   * « Check execution again » : LECTURES uniquement. Jamais de reconstruction,
   * jamais d'ouverture du wallet, jamais de seconde signature, jamais d'envoi.
   * Une reussite fait disparaitre l'erreur COURANTE du bloc principal (l'historique
   * technique reste dans Troubleshooting details) et arrete les reprises.
   */
  const onCheckExecutionAgain = async () => {
    const signature = executionResult?.signature ?? rememberedSignature;
    if (signature === null || verificationInFlightRef.current) return;
    verificationInFlightRef.current = true;
    setCheckingExecution(true);
    setExecutionCheckReport('Checking the execution…');
    try {
      const evidence = await verifyExecutionOnce();
      if (evidence === null) {
        setExecutionCheckReport(EXECUTION_CHECK_FAILED_MESSAGE);
        return;
      }
      setExecutionCheckReport(
        evidence.executedOnchain
          ? 'Execution verified on-chain.'
          : evidence.confirmed
            ? 'Transaction confirmed, proposal verification pending.'
            : EXECUTION_UNVERIFIED_MESSAGE,
      );
      if (evidence.executedOnchain) {
        setExecutionError(null);
        verificationAttemptsRef.current = MAX_VERIFICATION_ATTEMPTS;
        // L'etat est tranche : la memoire d'envoi n'a plus de raison d'etre.
        forgetPendingSubmission(proposalKey);
        setRememberedSignature(null);
      }
    } catch (caught: unknown) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      setExecutionDiagnostics((previous) => [...previous, raw]);
      setExecutionCheckReport(
        isTemporaryNetworkFailure(caught)
          ? EXECUTION_UNVERIFIED_MESSAGE
          : EXECUTION_CHECK_FAILED_MESSAGE,
      );
    } finally {
      verificationInFlightRef.current = false;
      setCheckingExecution(false);
      setVerificationRound((round) => round + 1);
    }
  };

  // Une verification impossible POUR UNE RAISON RESEAU sur un envoi SIGNE : seul
  // cas ou une reprise automatique est autorisee. Elle RELIT, elle ne renvoie pas.
  const executionNetworkFailure =
    executionResult !== null &&
    executionResult.signature !== null &&
    !executionResult.verified &&
    isTemporaryNetworkFailure(executionResult.errorMessage ?? '');
  // Meme regle cote approbation : une signature qui existe et une relecture
  // impossible ne sont PAS un echec.
  const approvalNetworkFailure =
    approvalResult !== null &&
    approvalResult.signature !== null &&
    !approvalResult.verified &&
    isTemporaryNetworkFailure(approvalError ?? '');

  // --- Incident « vérification réseau » UNIQUE --------------------------------
  // Décodage impossible ou envoi signé non vérifié : c'est le MÊME problème
  // (le réseau). On ne rend donc QU'UN panneau, en AMBRE, avec le texte humain
  // et le détail brut replié — jamais trois encarts rouges pour un incident.
  const decodeNetworkIncident = decodeError !== null && isNetworkFailure(decodeError);
  const executionSentIncident =
    (executionError !== null &&
      !executed &&
      (executionNetworkFailure || executionError.includes(EXECUTION_SENT_TITLE))) ||
    (executionResult === null && rememberedSignature !== null && !executed);
  // Le détail brut INTÉGRAL de l'incident (jamais tronqué) : l'erreur de
  // décodage si elle existe, sinon les diagnostics d'exécution.
  const networkIncidentRaw = decodeNetworkIncident
    ? decodeError
    : executionDiagnostics.length > 0
      ? executionDiagnostics.join('\n')
      : executionError;
  // Une signature d'exécution mémorisée (aucun résultat encore) reste visible.
  const networkIncidentSignature =
    executionResult === null && !executed ? rememberedSignature : null;
  const latestCheckRef = useRef<() => void>(() => {});
  useEffect(() => {
    latestCheckRef.current = () => {
      void onCheckExecutionAgain();
    };
  });
  useEffect(() => {
    if (proposalKeyRef.current === proposalKey) return;
    // Changement de proposition : on ANNULE les reprises en cours et on oublie
    // tout resultat de l'ancienne. Aucun etat n'est herite d'une autre proposition.
    proposalKeyRef.current = proposalKey;
    if (verificationTimerRef.current !== null) {
      clearTimeout(verificationTimerRef.current);
      verificationTimerRef.current = null;
    }
    verificationAttemptsRef.current = 0;
    // Meme remise a zero pour les reprises d'approbation.
    if (approvalVerificationTimerRef.current !== null) {
      clearTimeout(approvalVerificationTimerRef.current);
      approvalVerificationTimerRef.current = null;
    }
    approvalVerificationAttemptsRef.current = 0;
    setExecutionResult(null);
    setExecutionError(null);
    setExecutionDiagnostics([]);
    setExecutionCheckReport(null);
    setCheckingExecution(false);
    setApprovalResult(null);
    setApprovalError(null);
    setCheckingApproval(false);
    setOnchainApproval(null);
    // Cette proposition a-t-elle un envoi signe non verifie dans ce processus ?
    setRememberedSignature(pendingSubmissionFor(proposalKey));
  }, [proposalKey]);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (verificationTimerRef.current !== null) {
        clearTimeout(verificationTimerRef.current);
        verificationTimerRef.current = null;
      }
      if (approvalVerificationTimerRef.current !== null) {
        clearTimeout(approvalVerificationTimerRef.current);
        approvalVerificationTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!executionNetworkFailure) return;
    if (verificationAttemptsRef.current >= MAX_VERIFICATION_ATTEMPTS) return;
    const delay =
      VERIFICATION_RETRY_DELAYS_MS[
        Math.min(verificationAttemptsRef.current, VERIFICATION_RETRY_DELAYS_MS.length - 1)
      ];
    verificationAttemptsRef.current += 1;
    verificationTimerRef.current = setTimeout(() => {
      verificationTimerRef.current = null;
      if (unmountedRef.current || verificationInFlightRef.current) return;
      latestCheckRef.current();
    }, delay);
    return () => {
      if (verificationTimerRef.current !== null) {
        clearTimeout(verificationTimerRef.current);
        verificationTimerRef.current = null;
      }
    };
  }, [executionNetworkFailure, verificationRound]);

  /**
   * « Check approval again » : LECTURES uniquement (statut de signature,
   * confirmation, relecture de la Proposal). Jamais de reconstruction, jamais
   * d'ouverture du wallet, jamais de signature, jamais de second envoi.
   */
  const onCheckApprovalAgain = async () => {
    const signature = approvalResult?.signature ?? null;
    if (signature === null || checkingApproval || approvalCheckInFlightRef.current) return;
    approvalCheckInFlightRef.current = true;
    const requestKey = proposalKeyRef.current;
    setCheckingApproval(true);
    setApprovalCheckReport('Checking the approval…');
    try {
      const confirmation = await confirmSignature({ connection, signature });
      const fresh = await refreshProposalFromChain();
      // Proposition changee pendant la relecture : resultat IGNORE.
      if (proposalKeyRef.current !== requestKey) return;
      const confirmed = confirmation.status === 'confirmed';
      const verified =
        confirmed && fresh !== null && walletHasApproved(fresh.approvedAddresses, walletAddress);
      setApprovalResult((previous) =>
        previous === null
          ? previous
          : {
              ...previous,
              confirmed,
              confirmationStatus: confirmation.status,
              readBack:
                fresh === null
                  ? previous.readBack
                  : {
                      address: proposalPda(address, index) ?? previous.readBack?.address ?? '',
                      approvedAddresses: fresh.approvedAddresses,
                      index,
                      status: fresh.status,
                    },
              verified,
            },
      );
      setApprovalCheckReport(
        verified
          ? 'Proposal approved and verified.'
          : confirmed
            ? 'Approval confirmed, proposal verification pending.'
            : 'Approval signed, confirmation pending.',
      );
      if (verified) {
        // Etat courant REUSSI : l'ancienne erreur disparait du bloc principal.
        // L'historique technique reste consultable dans Troubleshooting details.
        setApprovalError(null);
        // L'etat est TRANCHE : plus aucune reprise automatique ne doit s'armer.
        approvalVerificationAttemptsRef.current = MAX_VERIFICATION_ATTEMPTS;
      }
    } catch (caught: unknown) {
      const detail = isTemporaryNetworkFailure(caught)
        ? 'Verification temporarily unavailable: check again later.'
        : 'Verification failed — this action sent nothing.';
      setApprovalCheckReport(detail);
      setApprovalDiagnostics((previous) => [...previous, detail]);
    } finally {
      approvalCheckInFlightRef.current = false;
      setCheckingApproval(false);
      setApprovalVerificationRound((round) => round + 1);
    }
  };

  const latestApprovalCheckRef = useRef<() => void>(() => {});
  useEffect(() => {
    latestApprovalCheckRef.current = () => {
      void onCheckApprovalAgain();
    };
  });
  // Une verification d'APPROBATION impossible POUR UNE RAISON RESEAU sur un
  // envoi SIGNE : seul cas ou une reprise automatique est autorisee. Elle RELIT
  // (statut de la signature + relecture de la Proposal), elle ne renvoie RIEN :
  // aucun wallet, aucune signature, aucune reconstruction, aucun envoi. Miroir
  // exact de la reprise d'execution, avec ses propres refs bornees.
  useEffect(() => {
    if (!approvalNetworkFailure) return;
    if (approvalVerificationAttemptsRef.current >= MAX_VERIFICATION_ATTEMPTS) return;
    const delay =
      VERIFICATION_RETRY_DELAYS_MS[
        Math.min(approvalVerificationAttemptsRef.current, VERIFICATION_RETRY_DELAYS_MS.length - 1)
      ];
    approvalVerificationAttemptsRef.current += 1;
    approvalVerificationTimerRef.current = setTimeout(() => {
      approvalVerificationTimerRef.current = null;
      if (unmountedRef.current || approvalCheckInFlightRef.current) return;
      latestApprovalCheckRef.current();
    }, delay);
    return () => {
      if (approvalVerificationTimerRef.current !== null) {
        clearTimeout(approvalVerificationTimerRef.current);
        approvalVerificationTimerRef.current = null;
      }
    };
  }, [approvalNetworkFailure, approvalVerificationRound]);

  const runApproval = async () => {
    if (model === null || allowlist === null || approvalAttemptedRef.current) return;
    if (walletAddress === null) {
      setApprovalError('No wallet connected: an approval must be signed by a member.');
      return;
    }
    // Défense on-chain AVANT toute construction : un wallet déjà approbateur ne
    // reconstruit rien (le module relit aussi la Proposal, mais on évite ici
    // même d'ouvrir le wallet).
    if (walletAlreadyApproved) {
      setApprovalError('Already approved: this wallet already approved this proposal.');
      return;
    }
    approvalAttemptedRef.current = true;
    setApproving(true);
    setApprovalError(null);
    setApprovalResult(null);
    setApprovalCheckReport(null);
    let signature: string | null = null;
    try {
      const result = await signAndSendProposalApproval({
        connection,
        memberAddress: walletAddress,
        multisigPda: address,
        preconditions: {
          allowlistStatus: allowlist.status,
          guardReasons: guard.reasons,
          guardStatus: guard.status,
        },
        signAndSendTransactions,
        threshold,
        transactionIndex: index,
      });
      signature = result.signature;
      setApprovalResult(result);
      // Une signature existe : on relit la Proposal pour afficher l'état RÉEL
      // (dont « Already approved »). Lecture seule, aucun wallet.
      if (signature !== null) {
        void refreshProposalFromChain();
      }
      if (!result.verified) {
        // Copie HUMAINE dans le bloc principal ; le détail technique brut part
        // dans « Troubleshooting details », jamais dans le panneau ambre.
        const failure = describeApprovalFailure(result);
        setApprovalError(failure.message);
        setApprovalDiagnostics((previous) => [...previous, failure.diagnostic]);
      }
    } catch (caught: unknown) {
      // La signature n'est posée qu'après un retour réussi : ici, rien n'a été
      // signé. Même copie humaine, détail brut réservé à Troubleshooting.
      const detail = caught instanceof Error ? caught.message : String(caught);
      setApprovalError(`${PREPARATION_CANCELLED_TITLE}\n${PREPARATION_CANCELLED_BODY}`);
      setApprovalDiagnostics((previous) => [...previous, detail]);
    } finally {
      // Aucune signature obtenue : rien n'a ete produit, un nouvel essai reste
      // possible. Sinon, plus aucune tentative automatique.
      if (signature === null) approvalAttemptedRef.current = false;
      setApproving(false);
    }
  };

  /** Tap sur Approve : préparation des verdicts déjà là, puis confirmation. */
  const onApprove = async () => {
    if (!canConfirm || approving || checkingApproval || approvalAttemptedRef.current) return;
    // Même logique qu'Execute : un échec sans signature redevient une tentative
    // neuve, un envoi signé ne peut jamais être réessayé.
    if (approvalResult !== null && approvalOutcome?.allowNewAttempt === true) {
      setApprovalResult(null);
      setApprovalError(null);
    }
    // PORTE DE SECURITE : relecture on-chain AVANT le dialogue. Le compteur du
    // dialogue vient de CETTE lecture, jamais de l'instantane des props (c'est
    // ce qui faisait afficher un compteur perime, inferieur a la carte). Une
    // lecture impossible ne regresse rien et n'approuve rien.
    setCheckingApproval(true);
    const fresh = await refreshProposalFromChain();
    setCheckingApproval(false);
    if (fresh === null) {
      setApprovalError(`${APPROVAL_PRECHECK_TITLE}\n${APPROVAL_PRECHECK_MESSAGE}`);
      return;
    }
    if (walletHasApproved(fresh.approvedAddresses, walletAddress)) {
      setApprovalError('Already approved: this wallet already approved this proposal on-chain.');
      return;
    }
    Alert.alert(
      'Approve this proposal?',
      [
        `Proposal #${index}`,
        `${fresh.approvedAddresses.length} of ${threshold} approvals collected`,
        'Your connected wallet will approve this proposal.',
        'Approving does not move the funds.',
      ].join('\n'),
      [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => {
            void runApproval();
          },
          text: 'Approve',
        },
      ],
      { cancelable: true },
    );
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack(verifiedStatusForReturn);
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  const summary = summarizeOperation(model);
  // Adresse de destination COMPLETE, telle que décodée : l'abréviation des
  // cartes compactes ne permet pas de vérifier où part l'argent.
  const fullDestination =
    model !== null && model.destination.known ? model.destination.value : null;
  // Vault index 0 dérivé localement : aucune lecture réseau pour l'obtenir.
  const vaultPdaAddress = (() => {
    try {
      return multisig.getVaultPda({ index: 0, multisigPda: new PublicKey(address) })[0].toBase58();
    } catch {
      return null;
    }
  })();
  const sourceVerdict = describeTransferSource({
    source: model !== null && model.source.known ? model.source.value : null,
    vaultAddress: vaultPdaAddress ?? '',
  });
  const amountLamports = model !== null && model.amount.known ? Number(model.amount.value.lamports) : null;
  const isRecognizedTransfer = summary !== null && summary.action === 'SOL transfer';

  // Instrumentation de développement : quelles données sont disponibles, pour
  // diagnostiquer un guard bloqué au premier rendu. Aucune donnée sensible.
  useEffect(() => {
    if (!__DEV__) return;
    console.log(
      '[proposal-details] availability',
      JSON.stringify({
        allowlistReady: model !== null,
        decodedModelReady: model !== null,
        guardContextReady: effectiveGuardContext !== null,
        multisigReady: address.length > 0,
        proposalReady: index >= 0,
        vaultPdaReady: vaultPdaAddress !== null,
        walletReady: walletAddress !== null,
      }),
    );
  }, [address, effectiveGuardContext, index, model, vaultPdaAddress, walletAddress]);
  const remaining = estimateRemainingBalance({
    amountLamports,
    recognizedSolTransfer: isRecognizedTransfer,
    sourceMatchesVault: sourceVerdict.matches,
    vaultLamports: proposalVaultLamports,
  });
  // Solde insuffisant : découvert AVANT toute signature, jamais présenté comme
  // un solde restant négatif.
  const insufficientBalance =
    isRecognizedTransfer &&
    sourceVerdict.matches &&
    proposalVaultLamports !== null &&
    amountLamports !== null &&
    proposalVaultLamports < amountLamports;
  const pda = proposalPda(address, index);

  // Relecture de la revue existante : aucun nouvel écran, aucune écriture.
  if (reviewOpen && model !== null) {
    return (
      <TransactionReviewScreen
        executed={executed}
        guardContext={effectiveGuardContext ?? null}
        model={model}
        onBack={() => setReviewOpen(false)}
      />
    );
  }

  // --- Présentation pure (UI V2) : aucune logique métier, aucun nouveau CTA.
  // CTA Approve : porte EXACTEMENT la même garde que l'existant.
  const approveCtaVisible = actionState === 'approval-available' || approvalRetry;
  // Statut utilisateur RÉEL : uniquement dérivé des verdicts déjà calculés.
  const userStatusTitle = executed
    ? 'Executed'
    : effectiveProposalStatus === 'Approved' && progress.reached
      ? PROPOSAL_ACTION_LABELS.thresholdReached
      : walletAlreadyApproved
        ? PROPOSAL_ACTION_LABELS.approvedByYou
        : canConfirm
          ? 'Needs your approval'
          : `Status: ${effectiveProposalStatus}`;
  // « Confirmed on-chain » : uniquement sur une preuve réelle.
  const confirmedOnchain =
    executionResult?.verified === true || effectiveProposalStatus === 'Executed';
  // Statut wallet « déjà approuvé » : information, jamais un bouton, et jamais
  // affiché dans l'état terminal exécuté.
  const showApprovedStatus = actionState !== 'executed' && walletAlreadyApproved;

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        style={styles.scrollView}
      >
        {/* --- En-tête : retour existant + DevnetPill + titre. --- */}
        <View style={styles.headerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to proposals"
            onPress={() => onBack(verifiedStatusForReturn)}
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <DevnetPill />
        </View>

        <Text style={styles.title}>Proposal #{index}</Text>

        {/* --- Résumé RÉEL : action décodée, montant on-chain, destination. --- */}
        <Card style={styles.hero}>
          <Text style={styles.heroAction}>
            {summary === null ? 'Transaction' : summary.action}
          </Text>
          <Text style={styles.heroAmount}>
            {amountLamports === null ? 'Amount unavailable' : lamportsToSolDisplay(amountLamports)}
          </Text>
          <Text style={styles.heroCaption}>To</Text>
          <Text selectable style={styles.monoValue}>
            {summary === null ? 'Destination unavailable' : summary.destination}
          </Text>
        </Card>

        {/* --- Étapes Proposed → Approved → Execute : état RÉEL uniquement,
            aucune étape remplie artificiellement. L'étape « Approved » affiche
            la progression réelle (1/2) dès la première approbation, pour ne plus
            apparaitre comme une étape vide — mais le ✓ reste réservé au seuil
            réellement atteint (`progress.reached`). --- */}
        <View style={styles.stepper}>
          {[
            { label: 'Proposed', done: true, partial: null },
            {
              label: 'Approved',
              done: progress.reached,
              partial:
                !progress.reached && progress.collected > 0
                  ? `${progress.collected}/${progress.collected + progress.remaining}`
                  : null,
            },
            { label: 'Execute', done: executed, partial: null },
          ].map((step, position) => (
            <View key={step.label} style={styles.stepItem}>
              <View style={[styles.stepDot, step.done && styles.stepDotDone]}>
                <Text style={[styles.stepDotText, step.done && styles.stepDotTextDone]}>
                  {step.done ? '✓' : String(position + 1)}
                </Text>
              </View>
              <Text style={[styles.stepLabel, step.done && styles.stepLabelDone]}>
                {step.partial === null ? step.label : `${step.label} ${step.partial}`}
              </Text>
            </View>
          ))}
        </View>

        {/* --- Carte principale UNIQUE : statut utilisateur, progression on-chain
            et statut du wallet fusionnés (aucune répétition). Masquée dans
            l'état terminal où la carte « Executed » fait seule foi. --- */}
        {actionState !== 'executed' ? (
          <Card style={styles.statusCard}>
            <Text style={styles.statusTitle}>{userStatusTitle}</Text>
            <Text style={styles.statusDetail}>{progress.collectedLabel}</Text>
            {/* Statut du wallet : INFORMATION, jamais un bouton. */}
            {showApprovedStatus ? (
              <View
                accessibilityLabel="Approved by you"
                accessibilityRole="text"
                accessible
                style={styles.successBox}
              >
                <Text style={styles.fieldNote}>{PROPOSAL_ACTION_LABELS.approvedByYouDetail}</Text>
              </View>
            ) : null}
            {!progress.reached ? (
              <Text style={styles.fieldNote}>
                {progress.remaining === 1
                  ? 'Execution becomes available after one more approval.'
                  : executionNotAvailableDetail(progress.remaining)}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {/* --- CTA Approve : uniquement si les guards l'autorisent. --- */}
        {approveCtaVisible && canConfirm ? (
          <PillButton
            accessibilityLabel={
              approvalRetry ? 'Prepare the approval again' : 'Approve this proposal'
            }
            busy={approving}
            disabled={!canConfirm || approving || checkingApproval}
            label={approvalRetry ? 'Prepare again' : 'Approve'}
            onPress={onApprove}
          />
        ) : null}

        {actionState === 'approval-available' && !canConfirm ? (
          <Text style={styles.fieldNote}>
            {decoding || model === null
              ? // Pas refus terminal : le contexte se construit localement
                // (multisig + proposition + modèle + wallet + vault PDA).
                'Checking approval permissions…'
              : effectiveGuardContext === null
                ? 'Checking approval permissions…'
                : guard.status !== 'allowed'
                  ? `Guard: ${guard.reasons.join(' ') || 'blocked'}`
                  : allowlist !== null && allowlist.status !== 'allowed'
                    ? `Instruction allowlist: ${allowlist.status}.`
                    : 'Approval is not available for this proposal in its current state.'}
          </Text>
        ) : null}

        {approving ? (
          <Text style={styles.fieldNote}>
            Preparing the instruction and waiting for the wallet…
          </Text>
        ) : null}

        {approvalError !== null &&
        actionState !== 'executed' &&
        !approvalNetworkFailure &&
        !progress.reached ? (
          /* Une annulation de preparation n'est PAS une erreur grave : ton
             AVERTISSEMENT (ambre). Le detail technique brut vit dans
             « Troubleshooting details ». */
          <InfoBox
            glyph="⚠"
            style={styles.infoBox}
            tone="warning"
          >
            <InfoText tone="warning">{approvalError}</InfoText>
          </InfoBox>
        ) : null}

        {approvalResult !== null && actionState !== 'executed' && !progress.reached ? (
          // Sans signature, rien n'a ete envoye : le panneau ambre « Preparation
          // was cancelled » ci-dessus porte DEJA le message unique — aucun doublon
          // ici (le recu n'existe que pour une soumission signee).
          approvalResult.signature === null ? null : (
          <View
            style={
              approvalOutcome !== null && approvalOutcome.tone === 'success'
                ? styles.successBox
                : approvalNetworkFailure
                  ? /* Etat INCONNU (envoi signe, relecture indisponible) : jamais
                       rouge. Le ton neutre est reserve aux etats non tranches. */
                    styles.infoBox
                  : styles.errorBox
            }
          >
            <Text
              style={
                approvalOutcome !== null && approvalOutcome.tone === 'success'
                  ? styles.successText
                  : approvalNetworkFailure
                    ? styles.fieldValue
                    : styles.errorText
              }
            >
              {/* Sans signature, ce libellé est le SEUL autorisé : jamais « Sent ».
                  Avec une signature non verifiee, la copie humaine remplace le
                  libelle technique (le detail brut vit dans Troubleshooting). */}
              {approvalNetworkFailure
                ? `${APPROVAL_SENT_TITLE}\n${APPROVAL_UNVERIFIED_MESSAGE}`
                : approvalLabel}
            </Text>
            {approvalResult.signature !== null ? (
              <Text selectable style={styles.fieldNote}>
                Signature: {abbreviateAddress(approvalResult.signature)}
              </Text>
            ) : null}
            {approvalResult.readBack !== null ? (
              <>
                <Text style={styles.fieldValue}>
                  {approvalResult.readBack.approvedAddresses.length} of {threshold} approvals
                  collected
                </Text>
                {approvalResult.readBack.approvedAddresses.length >= threshold ? (
                  <Text style={styles.successText}>Approval threshold reached</Text>
                ) : null}
              </>
            ) : null}
            {approvalActions?.allowCheckAgain ? (
              <PillButton
                accessibilityLabel="Check approval again"
                busy={checkingApproval}
                disabled={checkingApproval}
                label={checkingApproval ? 'Checking…' : 'Check approval again'}
                onPress={() => {
                  void onCheckApprovalAgain();
                }}
                variant="secondary"
              />
            ) : null}
            {approvalCheckReport !== null ? (
              <Text style={styles.fieldNote}>{approvalCheckReport}</Text>
            ) : null}
          </View>
          )
        ) : null}

        {/* --- Progression : fusionnée dans la carte principale (aucun doublon). --- */}

        {/* --- Execute : uniquement quand les guards l'autorisent. --- */}
        {executeState === 'available' ? (
          insufficientBalance ? (
            <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBox]} tone="error">
              <InfoText tone="error">Insufficient vault balance</InfoText>
            </InfoBox>
          ) : (
            <>
              <PillButton
                accessibilityLabel="Execute this proposal"
                busy={executing}
                disabled={
                  executing ||
                  checkingExecution ||
                  unverifiedExecutionSignature !== null ||
                  (executionResult !== null && !(executionOutcome?.allowNewAttempt ?? false))
                }
                label={PROPOSAL_ACTION_LABELS.executeCta}
                onPress={onExecute}
                /* Action POSITIVE : le rouge reste reserve aux echecs confirmes. */
                variant="primary"
              />
              <Text style={styles.fieldNote}>
                Executing submits the stored transaction to the vault. It is irreversible and
                requires a double confirmation.
              </Text>
              {checkingExecution ? (
                <Text style={styles.fieldNote}>Checking the approvals on-chain…</Text>
              ) : null}
            </>
          )
        ) : executeState === 'unavailable-threshold' ? (
          // Raison déjà portée par la carte principale (approbations restantes
          // + « Execution becomes available… ») : aucun bloc séparé.
          null
        ) : executeState === 'no-permission' ? (
          <InfoBox glyph="•" style={styles.infoBox}>
            <InfoText>{PROPOSAL_ACTION_LABELS.executeNoPermissionTitle}</InfoText>
            <InfoText>{PROPOSAL_ACTION_LABELS.executeNoPermissionDetail}</InfoText>
          </InfoBox>
        ) : (
          /* Etat terminal : proposition exécutée, AUCUN CTA Approve/Execute. */
          <View style={styles.executedCard}>
            <Text style={styles.executedCheck}>✓</Text>
            <Text style={styles.executedTitle}>Transaction executed</Text>
            <Text style={styles.fieldNote}>Proposal #{index}</Text>
            <Text style={styles.executedAmount}>
              {amountLamports === null ? 'Amount unavailable' : lamportsToSolDisplay(amountLamports)}
            </Text>
            <Text style={styles.fieldNote}>Destination</Text>
            {/* Abregee : l'adresse complete est dans Troubleshooting details. */}
            <Text selectable style={styles.monoValue}>
              {fullDestination !== null
                ? abbreviateAddress(fullDestination)
                : summary !== null
                  ? abbreviateAddress(summary.destination)
                  : 'Destination unavailable'}
            </Text>
            <Text style={styles.fieldNote}>{progress.collectedLabel}</Text>
            {/* Aucune date n'est affichée : aucune date n'est réellement disponible. */}
            {confirmedOnchain ? (
              <Text style={styles.successText}>Verified on-chain</Text>
            ) : null}
            {/* Ni signature abregee ni signature complete sur la carte terminale :
                la liste demandee est stricte (titre, montant, destination abregee,
                approbations, verification). Le reste vit dans Troubleshooting. */}
            {/* Statut brut et signature complete : deplaces dans le recu technique. */}
          </View>
        )}

        {executing ? (
          <Text style={styles.fieldNote}>Waiting for the wallet…</Text>
        ) : null}

        {executionError !== null && !executed ? (
          /* L'incident RESEAU d'un envoi signe est rendu UNE seule fois par le
             panneau d'incident ci-dessous. Ici ne reste que la VRAIE erreur
             d'execution, en rouge, avec son message d'origine. */
          executionSentIncident ? null : (
            <InfoBox
              glyph="⚠"
              style={styles.infoBox}
              tone={executionNetworkFailure ? 'warning' : 'error'}
            >
              <InfoText tone={executionNetworkFailure ? 'warning' : 'error'}>{executionError}</InfoText>
            </InfoBox>
          )
        ) : null}

        {executionResult === null && rememberedSignature !== null && !executed ? (
          /* Envoi SIGNE d'un montage precedent de cet ecran (ou d'un ecran
             rouvert) : Execute n'est jamais repropose sans preuve on-chain ; la
             main est laissee a la relecture. Cet incident RESEAU (payload +
             signature + reprise) est desormais rendu UNE seule fois par le
             panneau d'incident ci-dessous — aucun doublon. */
          null
        ) : null}

        {executionResult !== null && executeState !== 'executed' ? (
          <View
            style={
              executionOutcome !== null && executionOutcome.tone === 'success'
                ? styles.successBox
                : executionOutcome !== null && executionOutcome.tone === 'warning'
                  ? /* Etat SIGNE / EN ATTENTE (transitoire) : AMBRE, jamais rouge —
                       ce n'est pas un echec, la transaction a bien ete signee. */
                    styles.warningPanel
                  : styles.errorBox
            }
          >
            <Text
              style={
                executionOutcome !== null && executionOutcome.tone === 'success'
                  ? styles.successText
                  : executionOutcome !== null && executionOutcome.tone === 'warning'
                    ? styles.warningPanelText
                    : styles.errorText
              }
            >
              {/* Sans signature, jamais « Sent » : le libellé vient du verdict. */}
              {executionOutcome?.label ?? 'Execution verified on-chain'}
            </Text>
            {executionResult.signature !== null ? (
              /* Signature ABREGEE ici ; la complete vit dans Troubleshooting. */
              <Text selectable style={styles.fieldNote}>
                Signature: {abbreviateAddress(executionResult.signature)}
              </Text>
            ) : null}
            <Text style={styles.fieldValue}>
              Status before: {executionResult.statusBefore ?? 'unknown'} ·{' '}
              {executionResult.approvalsBefore} of {threshold} required approvals
            </Text>
            {executionResult.readBack !== null ? (
              <>
                <Text style={styles.fieldValue}>
                  Proposal after:{' '}
                  {executionResult.readBack.proposalAccountPresent
                    ? executionResult.readBack.proposalStatusAfter ?? 'unknown status'
                    : 'account consumed (no longer present)'}
                </Text>
                <Text style={styles.fieldValue}>
                  Vault:{' '}
                  {executionResult.readBack.vaultLamportsDelta === null
                    ? 'balance change not measurable'
                    : `${executionResult.readBack.vaultLamportsDelta} lamports`}
                </Text>
                <Text selectable style={styles.monoValue}>
                  {executionResult.readBack.vaultAddress}
                </Text>
              </>
            ) : null}
            {executionOutcome?.allowCheckAgain ? (
              <PillButton
                accessibilityLabel="Check execution again"
                busy={checkingExecution}
                disabled={checkingExecution}
                label={checkingExecution ? 'Checking…' : 'Check execution again'}
                onPress={() => {
                  void onCheckExecutionAgain();
                }}
                variant="secondary"
              />
            ) : null}
            {executionCheckReport !== null ? (
              <Text style={styles.fieldNote}>{executionCheckReport}</Text>
            ) : null}
          </View>
        ) : null}

        {decoding ? (
          <Text style={styles.fieldNote}>Decoding the transaction from the chain…</Text>
        ) : null}

        {decodeNetworkIncident || executionSentIncident ? (
          /* Panneau UNIQUE de l'incident RESEAU : un seul incident (le reseau),
             un seul encart. Texte HUMAIN en tete ; le detail technique brut
             reste accessible, INTEGRAL, derriere un repli FERME par defaut. */
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBoxTop]} tone="warning">
            <InfoText tone="warning">{NETWORK_INCIDENT_TITLE}</InfoText>
            <InfoText tone="warning">{NETWORK_INCIDENT_BODY}</InfoText>
            {decodeNetworkIncident ? (
              <InfoText tone="warning">{NETWORK_INCIDENT_REASSURANCE}</InfoText>
            ) : null}
            {networkIncidentSignature !== null ? (
              <Text selectable style={styles.fieldNote}>
                Signature: {abbreviateAddress(networkIncidentSignature)}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show technical details"
              accessibilityState={{ expanded: showTechnicalDetails }}
              onPress={() => setShowTechnicalDetails((open) => !open)}
              style={styles.inlineAction}
            >
              <Text style={styles.inlineActionText}>
                {showTechnicalDetails ? 'Hide technical details' : 'Show technical details'}
              </Text>
            </Pressable>
            {showTechnicalDetails && networkIncidentRaw !== null ? (
              <Text selectable style={styles.incidentRawDetails}>
                {networkIncidentRaw}
              </Text>
            ) : null}
            {decodeNetworkIncident ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry decoding this proposal"
                onPress={() => {
                  void runDecode();
                }}
                style={styles.inlineAction}
              >
                <Text style={styles.inlineActionText}>Retry decode</Text>
              </Pressable>
            ) : null}
            {networkIncidentSignature !== null ? (
              <PillButton
                accessibilityLabel="Check execution again"
                busy={checkingExecution}
                disabled={checkingExecution}
                label={checkingExecution ? 'Checking…' : 'Check execution again'}
                onPress={() => {
                  void onCheckExecutionAgain();
                }}
                variant="secondary"
              />
            ) : null}
          </InfoBox>
        ) : null}

        {decodeError !== null && !decodeNetworkIncident ? (
          /* VRAIE erreur de decodage (donnees invalides, compte absent) : elle
             reste ROUGE, avec son message d'origine, et conserve la reprise. */
          <InfoBox glyph="⚠" style={[styles.infoBox, styles.warningBoxTop]} tone="error">
            <InfoText tone="error">{decodeError}</InfoText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry decoding this proposal"
              onPress={() => {
                void runDecode();
              }}
              style={styles.inlineAction}
            >
              <Text style={styles.inlineActionText}>Retry decode</Text>
            </Pressable>
          </InfoBox>
        ) : null}

        {/* Relecture lecture seule : re-decode la proposition et son message.
            Aucune signature, aucun envoi, aucun wallet sollicité. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh this proposal and decode it again"
          disabled={decoding}
          onPress={() => {
            void runDecode();
          }}
          style={({ pressed }) => [
            styles.inlineAction,
            pressed && styles.secondaryPressed,
            decoding && styles.disabled,
          ]}
        >
          <Text style={styles.inlineActionText}>
            {decoding ? 'Refreshing…' : 'Refresh proposal'}
          </Text>
        </Pressable>

        {/* --- Advanced transaction details : repliée par défaut. Ouvre la vue
            de revue lecture seule existante. Aucun CTA d'écriture ici. --- */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Advanced transaction details"
          accessibilityState={{ expanded: advancedOpen }}
          onPress={() => setAdvancedOpen((open) => !open)}
          style={styles.advancedToggle}
        >
          <Text style={styles.advancedToggleText}>
            {advancedOpen ? '▾ Advanced transaction details' : '▸ Advanced transaction details'}
          </Text>
        </Pressable>

        {advancedOpen ? (
          <Card style={styles.advancedBody}>
            {summary === null ? (
              <Text style={styles.fieldNote}>
                Decoding this proposal… the amount and the destination appear as soon as the
                transaction message is decoded. No wallet is involved.
              </Text>
            ) : (
              <>
                <Text style={styles.fieldLabel}>Action</Text>
                <Text style={styles.fieldValue}>{summary.action}</Text>
                <Text selectable style={styles.monoValue}>Amount: {summary.amount}</Text>
                <Text style={styles.fieldLabel}>Destination</Text>
                <Text selectable style={styles.monoValue}>
                  {fullDestination ?? summary.destination}
                </Text>
                {model !== null && model.source.known ? (
                  <>
                    <Text style={styles.fieldLabel}>Funds will be sent from</Text>
                    <Text selectable style={styles.monoValue}>
                      {model.source.value}
                    </Text>
                  </>
                ) : null}
                <Text style={styles.fieldNote}>{sourceVerdict.label}</Text>
                <Text style={styles.fieldNote}>{sourceVerdict.hint}</Text>
                {/* Estimation LOCALE, jamais un solde inventé : « Not available »
                    si la lecture du vault n'a pas abouti. Formatage ASSAINI :
                    `lamportsToSolDisplay` coupe les zéros de queue inutiles
                    (« 0.080000000 » -> « 0.08 SOL », « 0 » -> « 0 SOL ») sans
                    jamais masquer de décimale significative. */}
                <Text style={styles.fieldLabel}>Estimated remaining balance</Text>
                <Text selectable style={styles.monoValue}>
                  {remaining.remainingLamports === null
                    ? 'Not available'
                    : lamportsToSolDisplay(remaining.remainingLamports)}
                </Text>
                <Text style={styles.fieldNote}>{remaining.reason}</Text>
              </>
            )}
            <Text style={styles.fieldLabel}>Proposal account</Text>
            <Text selectable style={styles.monoValue}>{pda ?? 'unavailable'}</Text>
            <Text style={styles.fieldLabel}>Vault transaction account</Text>
            <Text selectable style={styles.monoValue}>{vaultTransactionAddress}</Text>
            <Text style={styles.fieldLabel}>Multisig</Text>
            <Text selectable style={styles.monoValue}>{address}</Text>
            <PillButton
              disabled={model === null}
              label="Open read-only review"
              onPress={() => setReviewOpen(true)}
              variant="secondary"
            />
            {model === null ? (
              <Text style={styles.fieldNote}>
                The technical review is available once the proposal has been decoded by the
                existing review flow.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {/* TROUBLESHOOTING DETAILS — diagnostic d'une tentative ANTERIEURE,
            replie par defaut, jamais prioritaire sur l'etat courant. */}
        {approvalDiagnostics.length > 0 ||
        (approvalResult?.validationErrors.length ?? 0) > 0 ||
        approvalResult?.signature != null ||
        executionDiagnostics.length > 0 ||
        executionError !== null ? (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Troubleshooting details"
              accessibilityState={{ expanded: troubleshootingOpen }}
              onPress={() => setTroubleshootingOpen((open) => !open)}
              style={styles.advancedToggle}
            >
              <Text style={styles.advancedToggleText}>
                {troubleshootingOpen
                  ? '▾ Troubleshooting details'
                  : '▸ Troubleshooting details'}
              </Text>
            </Pressable>
            {troubleshootingOpen ? (
              <Card style={styles.advancedBody}>
                <Text style={styles.fieldNote}>Diagnostics from an earlier attempt.</Text>
                {approvalDiagnostics.map((message, position) => (
                  <Text key={`approval-detail-${position}`} selectable style={styles.fieldNote}>
                    {message}
                  </Text>
                ))}
                {(approvalResult?.validationErrors ?? []).map((message, position) => (
                  <Text key={`approval-validation-${position}`} selectable style={styles.fieldNote}>
                    {message}
                  </Text>
                ))}
                {executionDiagnostics.map((message, position) => (
                  <Text key={`execution-detail-${position}`} selectable style={styles.fieldNote}>
                    {message}
                  </Text>
                ))}
                {executionError !== null ? (
                  <Text selectable style={styles.fieldNote}>
                    {executionError}
                  </Text>
                ) : null}
                {executionResult?.signature != null ? (
                  <Text selectable style={styles.fieldNote}>
                    Execution signature: {executionResult.signature}
                  </Text>
                ) : null}
                {(executionResult?.validationWarnings ?? []).map((warning, position) => (
                  <Text key={`execution-warning-${position}`} selectable style={styles.fieldNote}>
                    {warning}
                  </Text>
                ))}
                {approvalResult?.signature != null ? (
                  <Text selectable style={styles.fieldNote}>
                    Approval signature: {approvalResult.signature}
                  </Text>
                ) : null}
                {approvalResult?.readBack != null ? (
                  <Text selectable style={styles.fieldNote}>
                    Proposal account: {approvalResult.readBack.address}
                  </Text>
                ) : null}
                {fullDestination !== null ? (
                  <Text selectable style={styles.fieldNote}>
                    Destination (full): {fullDestination}
                  </Text>
                ) : null}
                <Text selectable style={styles.fieldNote}>
                  On-chain status: {effectiveProposalStatus}
                </Text>
              </Card>
            ) : null}
          </View>
        ) : null}

        {/* Ce bouton ne s'affiche QUE dans l'etat « Executed », ou il devient
            l'action principale de sortie. Dans les autres etats il faisait
            DOUBLON avec la fleche de retour de l'en-tete, et venait coller au
            repli « Advanced transaction details » juste au-dessus — d'ou
            l'espace ajoute par `backFooter`. */}
        {executed ? (
          <View style={styles.backFooter}>
            <PillButton
              accessibilityLabel="Go back"
              label="Back"
              onPress={() => onBack(verifiedStatusForReturn)}
              variant={executed ? 'primary' : 'secondary'}
            />
          </View>
        ) : null}
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
    paddingBottom: spacing.xxl * 2,
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
  backButtonPressed: {
    backgroundColor: colors.surface,
  },
  backGlyph: {
    color: colors.text,
    fontSize: 24,
    lineHeight: 26,
  },
  title: {
    color: colors.text,
    fontSize: typography.screenTitle - 6,
    fontWeight: '800',
    marginBottom: spacing.lg,
  },
  hero: {
    marginBottom: spacing.lg,
  },
  heroAction: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  heroAmount: {
    color: colors.text,
    fontSize: typography.balance,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  heroCaption: {
    color: colors.textMuted,
    fontSize: typography.micro,
    marginTop: spacing.md,
    textTransform: 'uppercase',
  },
  // Espace avant le bouton de sortie de l'etat « Executed » : sans lui, il venait
  // coller au repli « Advanced transaction details » quand le bloc de diagnostics
  // ne rendait rien.
  backFooter: {
    marginTop: spacing.xl,
  },
  stepper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  stepItem: {
    alignItems: 'center',
    flex: 1,
  },
  stepDot: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  stepDotDone: {
    backgroundColor: colors.successSoft,
  },
  stepDotText: {
    color: colors.textMuted,
    fontSize: typography.secondary,
    fontWeight: '800',
  },
  stepDotTextDone: {
    color: colors.success,
  },
  stepLabel: {
    color: colors.textMuted,
    fontSize: typography.caption,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  stepLabelDone: {
    color: colors.text,
  },
  statusCard: {
    marginBottom: spacing.md,
  },
  statusTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
  },
  statusDetail: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    marginTop: spacing.xs,
  },
  progressCard: {
    marginTop: spacing.md,
  },
  progressLabel: {
    color: colors.text,
    fontSize: typography.bodySmall,
    fontWeight: '700',
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
    marginTop: 2,
  },
  monoValue: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: typography.secondary,
    marginTop: spacing.xs,
  },
  fieldNote: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  errorBox: {
    backgroundColor: colors.errorSoft,
    borderRadius: radii.field,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  errorText: {
    color: colors.error,
    fontSize: typography.secondary,
  },
  successBox: {
    backgroundColor: colors.successSoft,
    borderRadius: radii.field,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  successText: {
    color: colors.success,
    fontSize: typography.secondary,
    fontWeight: '800',
  },
  // Etat SIGNE / EN ATTENTE (transitoire) : encart AMBRE, jamais rouge.
  warningPanel: {
    backgroundColor: colors.warningSoft,
    borderRadius: radii.field,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  warningPanelText: {
    color: colors.warning,
    fontSize: typography.secondary,
  },
  // Detail technique brut de l'incident reseau : INTEGRAL, copiable, en retrait.
  incidentRawDetails: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: typography.caption,
    marginTop: spacing.sm,
  },
  infoBox: {
    marginTop: spacing.md,
  },
  // Correctif LOCAL (la primitive partagée est figée par un test). `alignItems:
  // 'center'` : le glyphe ⚠ a une boîte de ligne plus haute que le texte (il
  // n'hérite pas du `lineHeight` de `InfoText`) ; en `flex-start` (défaut de la
  // primitive) il gonflait la rangée et le texte, calé en haut, laissait plus
  // d'espace sous lui qu'au-dessus. Padding `spacing.lg` : air interne
  // symétrique. Aucune couleur ni condition changée.
  warningBox: { alignItems: 'center', padding: spacing.lg },
  // Variante HAUT : encarts dont le corps porte un TITRE (1re ligne) PUIS du
  // contenu supplémentaire (phrase, bouton « Retry », divulgation). Centrer
  // contre tout le bloc décrochait le glyphe ⚠ de son titre ; en HAUT il reste
  // sur la PREMIÈRE ligne. Corps multi-lignes → hauteur de rangée donnée par le
  // corps : aucun déséquilibre réintroduit. Contenu COURT : `warningBox`.
  warningBoxTop: { alignItems: 'flex-start', padding: spacing.lg },
  button: {
    alignItems: 'center',
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.lg,
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    width: '100%',
  },
  secondary: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderWidth: 1,
  },
  secondaryPressed: {
    backgroundColor: colors.surface,
  },
  secondaryText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  disabled: {
    backgroundColor: colors.disabled,
  },
  inlineAction: {
    borderRadius: radii.pill,
    // Aération : 16 px entre actions empilées (avant : 8 px, trop serré).
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  inlineActionText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  advancedToggle: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  advancedToggleText: {
    color: colors.text,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  advancedBody: {
    marginTop: spacing.sm,
  },
  executedCard: {
    alignItems: 'center',
    backgroundColor: colors.successSoft,
    borderRadius: radii.card,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  executedCheck: {
    color: colors.mint,
    fontSize: 56,
    fontWeight: '800',
    lineHeight: 60,
  },
  executedTitle: {
    color: colors.success,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  executedMeta: {
    color: colors.textSecondary,
    fontSize: typography.caption,
    marginTop: spacing.xs,
  },
  executedAmount: {
    color: colors.text,
    fontSize: typography.balance - 10,
    fontWeight: '800',
    marginTop: spacing.md,
  },
});