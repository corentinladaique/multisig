import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SAFE_TOP_PADDING } from '../ui/safeAreaPadding';
import { resolveReturnFilter } from '../ui/proposalReturnFilter';
import {
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Image,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

import {
  describeMwaError,
  describeWalletIdentity,
  type MwaErrorReport,
} from '../wallet/mwaDiagnostics';
import { shouldReloadForWalletIdentity } from '../wallet/walletIdentityRefresh';
import { PublicKey } from '@solana/web3.js';

import { connection } from '../solana/connection';
import type { TransactionReviewModel } from '../types/transactionReview';
import { useRpcHealth } from '../solana/useRpcHealth';
import { useMultisigLookup } from '../squads/useMultisigLookup';
import type { MultisigRegistryEntry } from '../vault/multisigRegistry';
import { shortenMemberAddress } from '../vault/vaultDraft';
import { computeProposalDecision, summarizeOperation, loadProposalReview,
  useProposals,
  type ProposalReviewResult, } from '../squads/proposals';
import { filterProposals, type ProposalFilterGroup } from '../squads/proposalFilters';
import { TransactionReviewScreen } from './TransactionReviewScreen';
import { CreateVaultScreen } from './CreateVaultScreen';
import { MultisigDetailsScreen } from './MultisigDetailsScreen';
import { MultisigInboxScreen } from './MultisigInboxScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { ReceiveScreen } from './ReceiveScreen';
import { ProposalListBody } from './ProposalListScreen';
import { AddressInput } from '../ui/AddressInput';
import { useOnboarding } from '../onboarding/useOnboarding';
import { useMultisigRegistry } from '../vault/useMultisigRegistry';
import { useVaultUsage } from '../vault/useVaultUsage';
import { useVaultArchive } from '../vault/useVaultArchive';
import {
  activeEntries,
  ARCHIVE_CONFIRMATION_COPY,
  archivedSectionLabel,
  describeVaultBody,
  describeVaultHeader,
  isArchived,
  matchesArchivedEntry,
  mostRecentlyUsedActiveAddress,
  nextActiveAfterArchiving,
  orderArchivedEntries,
  pendingProposalWarning,
  REMOVE_CONFIRMATION_COPY,
  RESTORE_ARCHIVED_PROMPT,
  shouldAutoLoad,
  sortEntriesByLastUsed,
} from '../vault/vaultNavigation';
import { VaultPickerSheet } from '../ui/v2/VaultPickerSheet';
import { WalletHelpSheet } from '../ui/v2/WalletHelpSheet';
import { APP_VERSION } from '../appInfo';
import { describeVaultLoadError } from '../ui/vaultLoadMessage';
import { describeVaultBalance, type BalanceStatus } from '../wallet/vaultBalance';
import { Accelerometer } from 'expo-sensors';
import { consumeShake } from '../ui/shake';
import { ProposalDetailsScreen } from './ProposalDetailsScreen';
import { buildReviewPreviews } from '../solana/decodeTransactionMessage';
import type { DecodeStatus } from '../types/transactionReview';
import { COPIED_MESSAGE, COPY_FAILED_MESSAGE, copyToClipboard } from '../ui/clipboard';
import { CardsMark } from '../ui/v2/CardsMark';
import { nextAddMultisigOpen } from '../ui/v2/addMultisigToggle';
import { LaunchSplash } from '../ui/v2/LaunchSplash';
import { colors, radii, spacing, typography } from '../ui/theme';
import {
  Card,
  DevnetPill,
  InfoBox,
  InfoText,
  ListRow,
  PillButton,
} from '../ui/v2/primitives';
import { TabBar, type TabKey } from '../ui/v2/TabBar';

// Marge conservee entre le haut du bloc multisig (label + champ + bouton Load
// multisig) et le haut de la zone visible : uniquement une valeur de confort,
// aucune dimension d'ecran codee en dur.
const MULTISIG_KEYBOARD_MARGIN = 24;

// Profil X de l'auteur — lien EXTERNE affiche et tappable dans l'onglet Account.
const X_PROFILE_URL = 'https://x.com/Corentin_Lad';

// Largeur MINIMALE du composant pour disposer [champ + Paste] et [Load] cote a
// cote. En dessous, on bascule sur la version compacte sur deux lignes. Le
// constat vient de la largeur REELLE du composant (onLayout) : jamais d'une
// detection de modele d'appareil ni d'une dimension d'ecran codee en dur.
const MULTISIG_LOADER_ROW_MIN_WIDTH = 320;

// Mesure REELLE de position : `measureInWindow` n'est pas expose par les types
// publics de React Native, on le declare explicitement (meme approche que
// CreateVaultScreen). Sert a amener REELLEMENT le champ « Multisig address »
// dans la vue, quelle que soit la hauteur de la page.
type MeasurableNode = {
  measureInWindow?: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
};

// Jeux de preview construits localement par le décodeur pur (aucun RPC,
// aucune signature). Voir src/solana/decodeTransactionMessage.ts.
const PREVIEW_CASES = buildReviewPreviews();

type Phase = 'idle' | 'connecting' | 'disconnecting';

function shortenAddress(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Duree MINIMALE d'affichage de l'ecran d'attente du wallet (le calque menthe).
 *
 * Pourquoi : la visibilite du calque depend de `phase === 'connecting'`, et
 * `phase` retombe a `'idle'` des que `connect()` se conclut. A la DEUXIEME
 * tentative (apres une annulation), `connect()` se conclut parfois si vite que
 * React groupe les deux `setPhase` dans un SEUL rendu : le calque n'est alors
 * jamais peint, et l'utilisateur croit qu'il ne revient pas. Une duree plancher
 * garantit qu'il est vu — sans toucher a l'appel `connect()` lui-meme.
 */
const CONNECTING_SPLASH_MIN_MS = 450;

/**
 * Cadre de la marque de l'ecran d'attente (dp). L'asset `brand-splash-cards.png`
 * a son dessin sur environ 54 % de la toile : 480 donne un eventail d'environ
 * 260 dp de large, entierement visible.
 */
const CONNECTING_MARK_DP = 480;

/**
 * Attend la frame suivante. Sert a garantir qu'un rendu est bien PEINT avant
 * de poursuivre : quand l'invite du wallet prend le focus, Android cesse de
 * redessiner notre app, donc un changement d'etat pas encore peint ne sera
 * jamais vu.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Traduit l'erreur brute remontée par Mobile Wallet Adapter en message lisible.
 * Un refus de l'utilisateur n'est jamais présenté comme une erreur technique
 * (SECURITY.md §6).
 *
 * Ces messages sont RENDUS à l'écran : ils sont donc en ANGLAIS, comme le reste
 * de l'interface. Les commentaires du fichier restent en français (style maison),
 * mais jamais le texte visible.
 */
function toReadableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/reject|cancel|denied|declin|refus/i.test(raw)) {
    return 'Connection declined in the wallet. No authorization was granted.';
  }
  if (/no wallet|no activity|not found|not installed|unable to (find|open)/i.test(raw)) {
    return 'No Mobile Wallet Adapter wallet was found on this device.';
  }
  return `Connection failed: ${raw}`;
}

/** Tuile d'action principale du Home V2 (Receive / Propose / Signers). Présentation seule. */
function HomeAction({
  accessibilityLabel,
  glyph,
  label,
  onPress,
}: {
  accessibilityLabel?: string;
  glyph: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [styles.actionTile, pressed && styles.actionTilePressed]}
    >
      <Text style={styles.actionGlyph}>{glyph}</Text>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Boite de dialogue de confirmation — PRESENTATION SEULE.
 *
 * Aucun effet metier ici : elle n'affiche qu'un titre, un message, un
 * avertissement optionnel (ex. propositions en attente) et deux actions
 * (Annuler / Confirmer). Les effets reels (archivage, retrait, restauration,
 * renommage) vivent dans les handlers du parent. Aucun RPC, aucun wallet,
 * aucune transaction, aucun stockage.
 */
function ConfirmDialog({
  cancelLabel,
  children,
  confirmLabel,
  confirmVariant = 'primary',
  message,
  onCancel,
  onConfirm,
  title,
  visible,
  warning = null,
}: {
  cancelLabel: string;
  children?: ReactNode;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  visible: boolean;
  warning?: string | null;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <View style={styles.dialogBackdrop}>
        <View style={styles.dialogCard}>
          <Text style={styles.dialogTitle}>{title}</Text>
          <Text style={styles.dialogMessage}>{message}</Text>
          {warning !== null && warning.length > 0 ? (
            <InfoBox glyph="⚠" style={styles.dialogWarning} tone="warning">
              <InfoText tone="warning">{warning}</InfoText>
            </InfoBox>
          ) : null}
          {children}
          <View style={styles.dialogActions}>
            <View style={styles.dialogAction}>
              <PillButton label={cancelLabel} onPress={onCancel} variant="secondary" />
            </View>
            <View style={styles.dialogAction}>
              <PillButton label={confirmLabel} onPress={onConfirm} variant={confirmVariant} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function ConnectScreen() {
  const { account, connect, disconnect } = useMobileWallet();
  const { detail: rpcDetail, retry: retryRpc, status: rpcStatus } = useRpcHealth();
  const msig = useMultisigLookup();
  // Archivage LOCAL des vaults (etape 3) : stockage DEDIE, a cote de la recence.
  // Declare tot pour que TOUS les handlers de chargement (dont « Add existing
  // multisig ») puissent consulter l'etat d'archivage. Aucun RPC, aucune
  // transaction, aucune signature : etat local a l'appareil.
  const archive = useVaultArchive();
  // Registre LOCAL : sert uniquement à afficher le nom donné au vault par
  // l'utilisateur. Rien n'en est jamais transmis ni synchronisé.
  const registry = useMultisigRegistry();
  // Confirmations et dialogues d'archivage : l'ADRESSE ciblee, ou null. Rendus
  // UNE seule fois ici, donc partages a l'identique par le selecteur et Account.
  const [archiveConfirmAddress, setArchiveConfirmAddress] = useState<string | null>(null);
  const [removeConfirmAddress, setRemoveConfirmAddress] = useState<string | null>(null);
  const [renameAddress, setRenameAddress] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [restorePromptAddress, setRestorePromptAddress] = useState<string | null>(null);
  // Menu « ⋯ » de l'onglet Account (par adresse) : un seul ouvert a la fois.
  const [accountMenuFor, setAccountMenuFor] = useState<string | null>(null);
  // Repli de la section « Archived (N) » d'Account : REPLIEE par defaut, et
  // l'en-tete (avec le compteur) sert de controle accessible (tap = bascule).
  const [accountArchivedOpen, setAccountArchivedOpen] = useState(false);
  // Jeton d'actualisation EXPLICITE de la liste des propositions. Sans lui,
  // cette liste ne pouvait JAMAIS etre relue (aucun 4e argument) : une
  // proposition executee restait dans To do jusqu'a un demontage. Lecture seule.
  const [proposalsNonce, setProposalsNonce] = useState(0);
  const proposalsRefreshRef = useRef(false);
  const refreshProposalsReadOnly = useCallback(() => {
    // Aucun chevauchement : tant que la lecture precedente n'a pas rendu la
    // main (statut revenue a autre chose que « loading »), on ne relance rien.
    if (proposalsRefreshRef.current) return;
    proposalsRefreshRef.current = true;
    setProposalsNonce((previous) => previous + 1);
  }, []);
  const proposals = useProposals(
    msig.view?.address ?? null,
    msig.view?.transactionIndex ?? 0,
    msig.view?.staleTransactionIndex ?? 0,
    proposalsNonce,
  );
  // La lecture est terminee : le verrou anti-chevauchement est relache.
  useEffect(() => {
    if (proposals.status !== 'loading') proposalsRefreshRef.current = false;
  }, [proposals.status]);
  // Retour au premier plan (le wallet prend puis rend le focus) : relecture
  // LECTURE SEULE de la liste. Aucun wallet, aucune signature, aucun envoi.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshProposalsReadOnly();
    });
    return () => subscription.remove();
  }, [refreshProposalsReadOnly]);
  const [multisigInput, setMultisigInput] = useState('');
  const [previewCase, setPreviewCase] = useState<DecodeStatus | null>(null);
  // Vue Receive SOL (Groupe 1) : informative, lecture seule.
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Loader manuel d'un multisig existant : replié par défaut (secondaire).
  const [addMultisigOpen, setAddMultisigOpen] = useState(false);
  // Feuille d'aide « Wallet help » de l'écran de connexion (branche déconnectée).
  const [walletHelpOpen, setWalletHelpOpen] = useState(false);
  // Retour de copie de l'adresse du wallet.
  const [walletCopyFeedback, setWalletCopyFeedback] = useState<string | null>(null);
  // Assistant local de configuration de vault (aucun RPC, aucune signature).
  const [vaultCreationOpen, setVaultCreationOpen] = useState(false);
  // Rafraichissement du registre au RETOUR d'un flux qui ECRIT le registre
  // depuis une AUTRE instance du hook : la creation (CreateVaultScreen ecrit le
  // vault cree sur le stockage, mais CETTE instance-ci a charge son instantane
  // une seule fois au montage et ne verrait jamais la nouvelle entree -> le
  // vault cree n'apparaitrait pas dans « My multisigs »). On relit donc le
  // registre des que l'ecran de creation se referme. `refreshRegistry` est un
  // `useCallback([storage])` d'identite STABLE : l'utiliser en dep ne boucle
  // pas, contrairement a l'objet `registry` entier (recree a chaque rendu).
  // Le drapeau ne repasse a `false` qu'a la fermeture d'un flux de creation :
  // la garde `vaultCreationWasOpenRef` empeche tout declenchement au montage.
  const { refresh: refreshRegistry } = registry;
  const vaultCreationWasOpenRef = useRef(false);
  useEffect(() => {
    if (vaultCreationWasOpenRef.current && !vaultCreationOpen) {
      refreshRegistry();
    }
    vaultCreationWasOpenRef.current = vaultCreationOpen;
  }, [vaultCreationOpen, refreshRegistry]);
  // Inbox des multisigs connus (registre local uniquement, aucun RPC).
  const [inboxOpen, setInboxOpen] = useState(false);
  // Multisig ouvert depuis l'inbox (registre local) : lecture seule.
  const [openEntry, setOpenEntry] = useState<MultisigRegistryEntry | null>(null);
  // Proposition ouverte depuis l'inbox : MÊME écran que depuis Home, et son
  // décodage est fait sur place. Aucun envoi, aucun wallet sollicité ici.
  const [openDecisionIndex, setOpenDecisionIndex] = useState<number | null>(null);
  // Filtre de l'onglet Proposals, POSSEDE ICI : il doit survivre au demontage de
  // la liste (ouvrir une proposition monte un autre ecran, pas celui-ci). Le
  // filtre d'ORIGINE est memorise pour calculer le retour si la categorie a
  // change pendant la consultation (ex. executee -> Done).
  const [proposalFilter, setProposalFilter] = useState<ProposalFilterGroup>('todo');
  const [openDecisionOrigin, setOpenDecisionOrigin] = useState<ProposalFilterGroup>('todo');
  // Multisig charge manuellement : meme ecran de detail que ceux de l'inbox.
  const [manualDetailsOpen, setManualDetailsOpen] = useState(false);
  // Origine de l'ouverture de la vue partagee : 'details' (« View vault details »
  // / « View all proposals ») ou 'propose' (action rapide « Propose », qui doit
  // mener DIRECTEMENT a la creation de proposition).
  const [manualDetailsIntent, setManualDetailsIntent] = useState<'details' | 'propose'>('details');
  // Prechargement de l'operation de la proposition PRIORITAIRE : un seul appel
  // cible (getAccountInfo sur sa VaultTransaction), jamais pour les autres.
  const [inboxDecoded, setInboxDecoded] = useState<ProposalReviewResult | null>(null);
  const [inboxDecoding, setInboxDecoding] = useState(false);
  const [inboxDecodeError, setInboxDecodeError] = useState<string | null>(null);
  // Ref et non state : marquer la tentative ne doit PAS provoquer un rendu,
  // sinon l'effet se relance et annule la lecture en cours (cleanup).
  const inboxAttemptedRef = useRef<number | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const multisigInputRef = useRef<TextInput>(null);
  // Rideau de lancement : le splash natif est un drawable STATIQUE, il ne peut
  // rien animer. On le prolonge dès que le bundle est prêt par l'ouverture de
  // l'éventail, puis le rideau s'efface sur l'écran. Vit ici et non dans
  // `App.tsx`, qui est un fichier protege (test « aucun invariant metier
  // modifie », ui-v2-group4).
  const [launching, setLaunching] = useState(true);
  const finishLaunch = useCallback(() => setLaunching(false), []);
  // Le champ est-il actuellement focus ? Le clavier peut s'ouvrir pour une
  // autre raison : on ne remonte l'ecran que si la saisie multisig est active.
  const multisigFocusedRef = useRef(false);
  // Offset de défilement courant, tenu à jour par `onScroll` : indispensable
  // pour convertir une position mesurée à l'écran (`measureInWindow`) en
  // position dans le CONTENU scrollable, base du `scrollTo`. Sans cela, la
  // position du champ serait fausse dès que la page dépasse un écran.
  const scrollOffsetRef = useRef(0);
  const onScrollContent = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    },
    [],
  );

  // Largeur REELLE du bloc « Add existing multisig », mesuree par onLayout : elle
  // decide de la disposition (cote a cote ou compacte) sans jamais detecter le
  // modele d'appareil. Valeur purement locale a la session de rendu.
  const [loaderWidth, setLoaderWidth] = useState(0);
  const onLoaderLayout = useCallback((event: LayoutChangeEvent) => {
    setLoaderWidth(event.nativeEvent.layout.width);
  }, []);
  const loaderWide = loaderWidth >= MULTISIG_LOADER_ROW_MIN_WIDTH;

  const onMultisigInputFocus = useCallback(() => {
    multisigFocusedRef.current = true;
  }, []);

  const onMultisigInputBlur = useCallback(() => {
    multisigFocusedRef.current = false;
  }, []);

  /**
   * Android : la fenetre n'est plus redimensionnee par l'IME en edge-to-edge,
   * donc on remonte explicitement le champ « Multisig address » a l'ouverture
   * reelle du clavier (keyboardDidShow), en utilisant sa position RÉELLE.
   *
   * Mesure identique a l'amenee au champ : `measureInWindow` du champ et du
   * ScrollView + offset de defilement courant. Sans cela (position estimee via
   * le haut du bloc), sur une page longue le clavier rouvrait en ramenant
   * l'ecran vers le HAUT du bloc et le champ ressortait de la vue. Aucun delai
   * arbitraire, aucune fermeture du clavier, aucune remise a zero du texte.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      if (!multisigFocusedRef.current) return;
      const scroller = scrollViewRef.current;
      const field = multisigInputRef.current as unknown as MeasurableNode | null;
      if (scroller === null || field === null) return;
      (scroller as unknown as MeasurableNode).measureInWindow?.((_viewX, viewY) => {
        field.measureInWindow?.((_fieldX, fieldY) => {
          const targetY = Math.max(
            scrollOffsetRef.current + fieldY - viewY - MULTISIG_KEYBOARD_MARGIN,
            0,
          );
          if (__DEV__) {
            console.log(
              '[keyboard] keyboardDidShow ; fieldY =',
              fieldY,
              '; viewY =',
              viewY,
              '; scrollTo.y =',
              targetY,
            );
          }
          scroller.scrollTo({ animated: true, y: targetY });
        });
      });
    });
    return () => subscription.remove();
  }, []);

  // Boite de reception de decisions : classement par etat ON-CHAIN reel.
  const walletAddress = account === undefined ? null : account.address.toString();
  const walletCanApprove =
    msig.view !== null &&
    walletAddress !== null &&
    msig.view.members.some(
      (member) => member.address === walletAddress && member.roles.includes('Vote'),
    );

  // Modele deja en memoire pour un index donne : seule la proposition
  // prioritaires prechargee fournit un modele. Aucun appel reseau ici.
  const decodedModelFor = (index: number): TransactionReviewModel | null => {
    if (inboxDecoded !== null && inboxDecoded.model.proposalIndex === index) return inboxDecoded.model;
    return null;
  };
  const [phase, setPhase] = useState<Phase>('idle');
  // Onglet actif de la barre de navigation V2. État LOCAL de rendu : ne
  // persiste rien, ne déclenche aucun RPC, ne sollicite jamais le wallet.
  const [tab, setTab] = useState<TabKey>('vault');
  // L'onglet revient TOUJOURS sur Vault dès qu'un wallet est connecté. Sans ça,
  // se déconnecter depuis Account (seul endroit d'où on peut le faire) y
  // ramenait à la reconnexion, puisque `tab` est un état local qui survit à la
  // déconnexion — alors que la barre d'onglets n'est rendue que connecté.
  // La condition `!== null` évite de faire sauter l'écran pendant la
  // déconnexion elle-même ; la clé est `walletAddress` (une chaîne, stable tant
  // que le wallet ne change pas), et non l'objet `account`.
  useEffect(() => {
    if (walletAddress !== null) {
      setTab('vault');
    }
  }, [walletAddress]);
  // FILET DE SÉCURITÉ (focus) : revenir sur l'onglet Proposals relit la liste
  // on-chain (LECTURE SEULE, aucun wallet, aucune signature). Le rechargement du
  // compte Multisig n'est PAS refait ici : `msig.load` viderait la vue courante
  // et ferait clignoter « Loading your multisig… » à CHAQUE changement d'onglet
  // (régression visible). La correction PRINCIPALE — le changement d'identité du
  // wallet — relit, elle, le compte à neuf (voir l'effet dédié plus bas).
  const previousTabRef = useRef<TabKey>(tab);
  useEffect(() => {
    const leftTab = previousTabRef.current;
    previousTabRef.current = tab;
    if (leftTab === tab) return;
    if (tab !== 'proposals') return;
    refreshProposalsReadOnly();
  }, [tab, refreshProposalsReadOnly]);
  const [error, setError] = useState<string | null>(null);
  // Diagnostics MWA : étape, code et message exacts, jamais reformulés.
  const [mwaReport, setMwaReport] = useState<MwaErrorReport | null>(null);

  const onConnect = useCallback(async () => {
    setError(null);
    setMwaReport(null);
    setPhase('connecting');
    // Le calque doit etre PEINT avant que le wallet ne s'ouvre : des que son
    // invite prend le focus, Android cesse de redessiner notre app, et un
    // changement d'etat pas encore peint ne sera JAMAIS vu (les cartes
    // n'apparaissaient qu'une fois sur trois). Deux frames : celle qui peint,
    // puis la suivante, pour etre sur d'etre passe apres.
    await nextFrame();
    await nextFrame();
    const startedAt = Date.now();
    try {
      await connect();
    } catch (caught: unknown) {
      setError(toReadableError(caught));
      setMwaReport(describeMwaError(caught, 'authorize'));
    } finally {
      // Le calque est deja rendu : on lui garantit une duree MINIMALE avant de
      // repasser a `idle`, sinon un `connect()` qui se conclut instantanement le
      // retirerait dans le meme rendu (voir CONNECTING_SPLASH_MIN_MS).
      const remaining = CONNECTING_SPLASH_MIN_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      setPhase('idle');
    }
  }, [connect]);

  const onDisconnect = useCallback(async () => {
    setError(null);
    setMwaReport(null);
    setPhase('disconnecting');
    try {
      await disconnect();
    } catch (caught: unknown) {
      setError(toReadableError(caught));
      setMwaReport(describeMwaError(caught, 'deauthorize'));
    } finally {
      setPhase('idle');
    }
  }, [disconnect]);

  const busy = phase !== 'idle';

  /**
   * Point d'entree UNIQUE de chargement d'un vault (auto-chargement, selection
   * dans le selecteur, ou saisie manuelle). Il ne contient QUE l'appel existant
   * `msig.load` : aucune logique nouvelle, aucune deuxieme source de chargement.
   * La mise a jour de la recence reste pilotee ailleurs, APRES un chargement
   * reussi (jamais ici).
   */
  const loadVault = useCallback(
    (address: string) => {
      if (msig.status === 'loading') return;
      msig.load(address);
    },
    [msig],
  );

  /**
   * Copie de l'adresse du wallet connecté. Réutilise le mécanisme presse-papiers
   * existant (module Clipboard du coeur RN, cf. src/ui/clipboard.ts). Aucun
   * wallet, aucun RPC : simple écriture locale avec retour utilisateur.
   */
  const onCopyWallet = useCallback(() => {
    if (account === undefined) return;
    setWalletCopyFeedback(
      copyToClipboard(account.address.toString()) ? COPIED_MESSAGE : COPY_FAILED_MESSAGE,
    );
  }, [account]);

  /**
   * Point d'entrée UNIQUE de chargement manuel d'un multisig, partagé par le
   * bouton de chargement ET la touche Entrée du clavier (onSubmitEditing).
   *
   * - réutilise la validation locale existante de `msig.load` (saisie vide ou
   *   invalide → aucun RPC, l'erreur est posée par le hook) ;
   * - réutilise l'état `loading` existant ;
   * - empêche tout appel concurrent : un tap/Entrée pendant le chargement est ignoré ;
   * - n'ajoute aucun RPC, aucun wallet, aucune transaction.
   */
  const onLoadMultisig = useCallback(() => {
    if (msig.status === 'loading') return;
    // « Add existing multisig » avec une adresse DEJA archivee : aucun doublon,
    // on propose de restaurer l'entree locale existante (etat local seulement).
    if (matchesArchivedEntry(registry.entries, archive.archive, multisigInput)) {
      setRestorePromptAddress(multisigInput.trim());
      return;
    }
    loadVault(multisigInput);
    // `msig` reste dans les dependances : `loadVault` en derive, donc sa toute
    // derniere version est capturee des que `msig` change.
  }, [archive.archive, msig, multisigInput, registry.entries]);

  // Ce que le wallet a réellement fourni lors de l'autorisation : labels et
  // icône sont facultatifs dans le protocole, donc on affiche aussi leur absence.
  const walletIdentity =
    account === undefined
      ? null
      : describeWalletIdentity({
          address: account.address.toString(),
          icon: account.icon,
          label: account.label,
        });

  // Charge la revue RÉELLE d'une proposition : un seul appel RPC ciblé.
  // Une seule lecture par index prioritaire ; aucun retry automatique.
  // Dependances PRIMITIVES : sans cela, les nouvelles identites d'objet a
  // chaque rendu relanceraient l'effet et annuleraient la lecture en cours.
  const viewAddress = msig.view?.address ?? null;
  const viewVaultAddress = msig.view?.vaultAddress ?? null;
  const view = msig.view ?? null;

  /**
   * IDENTITÉ DU WALLET (clé publique du signataire) : elle CHANGE sans que ce
   * composant soit remonté quand l'utilisateur bascule d'un wallet à un autre
   * DANS l'app (disconnect puis connect). Or la vue du multisig (dont le
   * `transactionIndex` lu on-chain) et la liste des propositions ont été lues
   * UNE fois puis mises en cache : aucune dépendance ne les relisait pour le
   * NOUVEAU signataire. Une proposition créée après le dernier chargement
   * (index on-chain devenu supérieur au `transactionIndex` en cache) — ainsi que
   * les compteurs/badges « waiting for your vote » et le « To do » — restaient
   * donc invisibles jusqu'à une RELANCE de l'app (qui, elle, relit le compte à
   * neuf). On relit ici, en LECTURE SEULE, dès que l'identité du signataire
   * change : compte Multisig frais (transactionIndex à jour) PUIS propositions.
   * Aucun wallet, aucune signature, aucun envoi.
   *
   * Même famille que la relecture du registre au retour d'une création : une
   * dépendance explicite sur l'identité remplace l'absence de relecture.
   */
  const lastWalletIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    // Déconnecté : on ne relit rien ET on ne mémorise pas `null`, sinon une
    // reconnexion du MÊME wallet serait vue comme un changement d'identité.
    if (walletAddress === null) return;
    const previous = lastWalletIdentityRef.current;
    // On mémorise TOUTE identité réelle dès qu'elle apparaît (même sans vault) :
    // ainsi le tout premier chargement automatique ne sera pas suivi d'une
    // relecture inutile, et seule une VRAIE bascule déclenche la relecture.
    lastWalletIdentityRef.current = walletAddress;
    if (!shouldReloadForWalletIdentity(previous, walletAddress, viewAddress !== null)) return;
    // Prudence de typage : le helper garantit déjà qu'un vault est chargé ici.
    if (viewAddress === null) return;
    loadVault(viewAddress);
    // Libère le garde anti-chevauchement puis force une relecture on-chain : les
    // compteurs/badges sont recalculés au rendu suivant, sur la liste fraîche.
    proposalsRefreshRef.current = false;
    setProposalsNonce((previousNonce) => previousNonce + 1);
  }, [loadVault, viewAddress, walletAddress]);

  // --- Tableau de bord Home -------------------------------------------------
  // Solde du Main vault, chargé en lecture seule AVEC son adresse : changer de
  // multisig purge immédiatement la valeur précédente.
  const [homeBalance, setHomeBalance] = useState<{
    address: string;
    lamports: number | null;
    stale: boolean;
    status: BalanceStatus;
  } | null>(null);
  const [homeBalanceError, setHomeBalanceError] = useState(false);
  // Confidentialite du solde : etat LOCAL de session uniquement (jamais
  // persiste). Masquer n'affecte QUE l'affichage : la valeur reelle reste
  // intacte, aucune incidence sur Max, les propositions ou les calculs.
  const [balanceHidden, setBalanceHidden] = useState(false);
  /**
   * SECOUAGE -> masquage du solde.
   *
   * Le capteur n'est branche QUE tant que le solde est visible : une fois
   * masque, l'abonnement est retire (plus aucune mesure, et le geste n'a plus
   * rien a faire). Conforme a la demande : le secouage ne fait que MASQUER,
   * c'est le bouton « Show balance » qui remontre. L'etat reste local a la
   * session, jamais persiste. Un appareil sans accelerometre n'est pas une
   * erreur : la fonctionnalite est simplement absente.
   */
  const shakeStateRef = useRef({ lastTriggerMs: 0 });
  // Le capteur ne doit etre arme QUE si un vault est charge : sans vault, il n'y
  // a aucun montant a masquer, et pendant le chargement (on manipule l'appareil)
  // une secousse masquait le solde sans que l'utilisateur l'ait demande.
  const hasLoadedVault = msig.view !== null;
  useEffect(() => {
    if (balanceHidden || !hasLoadedVault) return undefined;
    let subscription: { remove: () => void } | null = null;
    try {
      Accelerometer.setUpdateInterval(120);
      subscription = Accelerometer.addListener((sample) => {
        if (consumeShake(shakeStateRef.current, sample, Date.now()).triggered) {
          setBalanceHidden(true);
        }
      });
    } catch {
      return undefined;
    }
    return () => subscription?.remove();
  }, [balanceHidden, hasLoadedVault]);
  /**
   * Le solde doit etre VISIBLE des qu'un multisig est charge : demande explicite
   * de Corentin. Sans ce reset, une secousse detectee pendant la manipulation de
   * l'appareil au chargement masquait le montant a son insu, et il fallait taper
   * « Show balance » pour le revoir.
   */
  const lastLoadedAddressRef = useRef<string | null>(null);
  useEffect(() => {
    const loadedAddress = msig.view?.address ?? null;
    if (loadedAddress !== null && loadedAddress !== lastLoadedAddressRef.current) {
      lastLoadedAddressRef.current = loadedAddress;
      setBalanceHidden(false);
    }
  }, [msig.view]);

  // Recence LOCALE des vaults (selection) : stockage separe du registre, ecrit
  // UNIQUEMENT apres un chargement reussi. Aucun RPC.
  const usage = useVaultUsage();
  // Selecteur de vault de l'en-tete (feuille « My multisigs »).
  const [vaultPickerOpen, setVaultPickerOpen] = useState(false);
  // L'utilisateur a-t-il DEMANDE a choisir un vault (ouverture volontaire du
  // selecteur : « Switch multisig », en-tete « Select multisig », « Choose
  // another multisig », section archivee) ? Ce drapeau LOCAL et de rendu sert
  // UNIQUEMENT a choisir la copie de la carte de chargement : avec lui, rien ne
  // se charge en silence, l'utilisateur vient choisir. Il n'arme ni ne change
  // le chargement lui-meme (auto-chargement du dernier vault inchange), ne
  // touche aucun wallet, aucun RPC, aucun stockage.
  const [choosingVault, setChoosingVault] = useState(false);
  // Demande d'amenee au champ « Multisig address » : incrementee par
  // « Add existing multisig » (feuille ou carte d'etat vide). Un COMPTEUR, et
  // non un booleen, car l'effet doit se reexecuter meme si `addMultisigOpen`
  // etait deja vrai (cas d'un vault charge, ou le bloc est deplie).
  const [focusMultisigToken, setFocusMultisigToken] = useState(0);
  // Une tentative d'auto-chargement au lancement n'a lieu qu'UNE fois.
  const autoLoadAttemptedRef = useRef(false);
  // Fermer la feuille UNIQUEMENT apres une selection chargee avec succes.
  const selectCloseRef = useRef(false);
  // Dernière vue de multisig dont le chargement réussi a déjà été enregistré
  // (identité d'objet : un nouveau chargement produit une nouvelle vue).
  const lastMarkedViewRef = useRef<unknown>(null);

  /**
   * « Amener au champ » : après un tap sur « Add existing multisig » (feuille ou
   * carte d'état vide), la feuille est fermée et le bloc « Multisig address »
   * est désormais TOUJOURS visible (le repli « More » a disparu). On défile
   * jusqu'au champ et on l'active.
   *
   * Mesure RÉELLE, jamais une position estimée : le champ ET le ScrollView sont
   * mesurés par `measureInWindow`, puis on ajoute l'offset de défilement courant
   * (`scrollOffsetRef`) pour obtenir la position du champ dans le CONTENU. La
   * valeur est donc exacte que la page fasse un écran ou dix : sur un vault
   * « full of proposals », le champ est réellement amené dans la vue (auparavant,
   * la position mesurée était celle du bloc entier, d'où un atterrissage « juste
   * au-dessus »). Le défilement est déclenché sur la frame SUIVANTE
   * (`requestAnimationFrame`) pour mesurer le bloc tout juste déplié avec sa
   * hauteur définitive. Aucun délai arbitraire, aucun décalage fixe.
   */
  useEffect(() => {
    if (focusMultisigToken === 0) return;
    const raf = requestAnimationFrame(() => {
      const scroller = scrollViewRef.current;
      const field = multisigInputRef.current as unknown as MeasurableNode | null;
      if (scroller !== null && field !== null) {
        (scroller as unknown as MeasurableNode).measureInWindow?.((_viewX, viewY) => {
          field.measureInWindow?.((_fieldX, fieldY) => {
            const targetY = Math.max(
              scrollOffsetRef.current + fieldY - viewY - MULTISIG_KEYBOARD_MARGIN,
              0,
            );
            scroller.scrollTo({ animated: true, y: targetY });
          });
        });
      }
      multisigInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusMultisigToken]);
  // Onboarding pedagogique : profil LOCAL uniquement, aucun wallet, aucun RPC.
  const onboarding = useOnboarding();

  // Retour Android (bouton materiel ET geste de balayage arriere) : quand le
  // parcours pedagogique « Learn » est OUVERT, le retour le REFERME et rend
  // l'ecran d'origine (l'onglet Account s'il a ete ouvert de la, sinon l'ecran
  // de connexion) : `close()` repose simplement `show` a false, et ConnectScreen
  // re-rend la vue precedente avec l'onglet deja selectionne.
  //
  // Le listener n'est enregistre QUE pendant l'ouverture (et retire au
  // demontage / a la fermeture) : un listener toujours actif intercepterait le
  // retour partout ailleurs dans l'app.
  //
  // Aucun conflit avec le BackHandler « post-creation -> inbox » (CreateVault) :
  // l'ecran de creation n'est pas monte tant que le parcours est affiche (rendu
  // anticipe), donc un seul listener vit a la fois ; et le listener du parcours
  // rend `true` pour consommer l'evenement.
  useEffect(() => {
    if (!(onboarding.ready && onboarding.show)) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onboarding.close();
      return true;
    });
    return () => subscription.remove();
  }, [onboarding.ready, onboarding.show, onboarding.close]);

  const refreshHomeBalance = useCallback((targetVaultAddress: string) => {
    setHomeBalance((previous) => ({
      address: targetVaultAddress,
      lamports:
        previous !== null && previous.address === targetVaultAddress ? previous.lamports : null,
      stale:
        previous !== null && previous.address === targetVaultAddress && previous.lamports !== null,
      status: 'loading',
    }));
    setHomeBalanceError(false);
    void (async () => {
      try {
        const lamports = await connection.getBalance(
          new PublicKey(targetVaultAddress),
          'confirmed',
        );
        setHomeBalance({ address: targetVaultAddress, lamports, stale: false, status: 'loaded' });
      } catch {
        setHomeBalance((previous) => ({
          address: targetVaultAddress,
          lamports:
            previous !== null && previous.address === targetVaultAddress ? previous.lamports : null,
          stale:
            previous !== null && previous.address === targetVaultAddress && previous.lamports !== null,
          status: 'error',
        }));
        setHomeBalanceError(true);
      }
    })();
  }, []);

  // Purge + lecture à chaque changement d'adresse de multisig / de vault.
  useEffect(() => {
    if (viewVaultAddress === null) {
      setHomeBalance(null);
      return;
    }
    refreshHomeBalance(viewVaultAddress);
  }, [viewVaultAddress, refreshHomeBalance]);

  /**
   * Tirer vers le bas = relire ce que la page Vault affiche DEJA : le solde
   * on-chain et les propositions. Reutilise les DEUX handlers existants (les
   * memes que les liens « Reload balance » et « Refresh ») : aucune logique
   * nouvelle, aucun appel supplementaire invente.
   *
   * CE HOOK DOIT RESTER AVANT TOUS LES `return` ANTICIPES du composant (Inbox,
   * creation de vault, vue detaillee). Place apres eux, React voyait un nombre
   * de hooks different selon l'ecran et l'application CRASHAIT des l'ouverture
   * de l'Inbox. Regle des Hooks : jamais de hook apres un retour conditionnel.
   */
  const onPullToRefresh = useCallback(() => {
    if (viewVaultAddress) {
      refreshHomeBalance(viewVaultAddress);
    }
    proposals.retry();
  }, [proposals, refreshHomeBalance, viewVaultAddress]);

  // Etat du spinner : derive de l'etat REEL des deux lectures, jamais simule.
  const pullingToRefresh = homeBalance?.status === 'loading' || proposals.status === 'loading';

  const homeBalanceView = describeVaultBalance({
    addressMatches:
      homeBalance !== null && viewVaultAddress !== null && homeBalance.address === viewVaultAddress,
    lamports: homeBalance?.lamports ?? null,
    status: homeBalance?.status ?? 'idle',
    stale: homeBalance?.stale === true,
  });

  // Rôles RÉELLEMENT lus on-chain pour le wallet connecté.
  const homeWalletRoles =
    view === null || walletAddress === null
      ? []
      : (view.members.find((member) => member.address === walletAddress)?.roles ?? []);
  const homeIsMember = homeWalletRoles.length > 0;
  const homeVaultName = registry.entries.find((entry) => entry.address === viewAddress)?.vaultName ?? null;

  // Vaults ACTIFS ordonnes par recence LOCALE (plus recent d'abord). Aucun
  // reseau. Les entrees archivees sont EXCLUES du selecteur principal.
  const orderedEntries = useMemo(
    () => sortEntriesByLastUsed(registry.entries, usage.usage).filter((entry) => !isArchived(archive.archive, entry.address)),
    [registry.entries, usage.usage, archive.archive],
  );
  // Vaults ARCHIVES, ordonnes par recence : section repliee, rendue seulement si N > 0.
  const archivedOrderedEntries = useMemo(
    () => orderArchivedEntries(registry.entries, usage.usage, archive.archive),
    [registry.entries, usage.usage, archive.archive],
  );
  // Seuil/membres par adresse : ceux DEJA lus on-chain (vault actif) plus ceux
  // memorises localement au dernier chargement. Aucune lecture ajoutee.
  const vaultStatsByAddress = useMemo(() => {
    const stats: Record<string, { threshold: number | null; memberCount: number | null }> = {};
    for (const [address, record] of Object.entries(usage.usage.records)) {
      stats[address] = { threshold: record.threshold, memberCount: record.memberCount };
    }
    if (view !== null) {
      stats[view.address] = { threshold: view.threshold, memberCount: view.members.length };
    }
    return stats;
  }, [usage.usage, view]);
  const savedCount = registry.entries.length;
  // Nombre d'entrees archivees : pilote la section « Archived (N) » et l'etat vide.
  const archivedCount = archivedOrderedEntries.length;
  const vaultLoadFailed = msig.status === 'error' && msig.error !== null;
  // Copie COURTE et HUMAINE de l'échec de chargement : jamais le texte technique
  // brut (exception, hôte RPC, base58). Calculée hors du rendu visuel.
  const vaultLoadMessage = describeVaultLoadError(msig.error);
  // « No multisig loaded » UNIQUEMENT quand aucune sauvegarde locale n'existe ;
  // « No active multisig » quand des sauvegardes existent mais sont TOUTES archivees.
  const computedVaultBodyState = describeVaultBody({
    registryStatus: registry.status,
    savedCount,
    archivedCount,
    hasView: view !== null,
    loadFailed: vaultLoadFailed,
  });
  // CORRECTIF 1 — « loading-vault » n'est annoncé QUE si un chargement est
  // RÉELLEMENT en cours (`msig.status === 'loading'`) ou imminent (l'auto-
  // chargement du lancement n'a pas encore été tenté : `autoLoadAttemptedRef`
  // est faux). Après un « Disconnect this vault », AUCUN chargement n'est en
  // cours : l'état devient ACTIONNABLE — la MÊME carte neutre que « no-saved »
  // (« No multisig loaded » + « Create a vault » / « Add existing multisig ») —
  // au lieu d'un faux « Loading your multisig… » sans aucun contrôle, qui
  // laissait l'utilisateur coincé. Aucune modification du module pur
  // `vaultNavigation` : la distinction est calculée ici, côté écran.
  const vaultLoadReal = msig.status === 'loading' || !autoLoadAttemptedRef.current;
  const vaultBodyState =
    computedVaultBodyState === 'loading-vault' && !vaultLoadReal
      ? 'no-saved'
      : computedVaultBodyState;
  const headerVaultLabel = describeVaultHeader({
    hasView: view !== null,
    activeName: homeVaultName,
  }).label;

  // Droit d'exécution RÉELLEMENT lu on-chain pour le wallet connecté.
  const homeWalletCanExecute =
    view !== null &&
    walletAddress !== null &&
    view.members.some(
      (member) => member.address === walletAddress && member.roles.includes('Execute'),
    );

  // TO DO — uniquement les actions RÉELLEMENT disponibles pour ce wallet,
  // classées par les fonctions PURES de `proposalFilters` (aucune seconde
  // logique maison) :
  //   Active + wallet peut voter + pas déjà approuvée → « Needs your approval » ;
  //   Approved + wallet peut exécuter                 → « Ready to execute ».
  // Ordre d'affichage : « Ready to execute » d'abord, puis « Needs your approval ».
  const proposalFilterInputs = (proposals.list?.proposals ?? []).map((proposal) => ({
    index: proposal.index,
    status: proposal.status,
    approvals: proposal.approvals,
    threshold: msig.view?.threshold ?? 0,
    approvedAddresses: proposal.approvedAddresses,
    walletAddress,
    walletCanApprove,
    walletCanExecute: homeWalletCanExecute,
  }));
  const todoInputs = filterProposals(proposalFilterInputs, 'todo');
  const inboxDecisions = [
    ...todoInputs.filter((input) => input.status === 'Approved'),
    ...todoInputs.filter((input) => input.status === 'Active'),
  ].map((input) =>
    computeProposalDecision({
      index: input.index,
      status: input.status,
      approvedAddresses: input.approvedAddresses,
      threshold: input.threshold,
      walletAddress,
      walletCanApprove: input.walletCanApprove,
    }),
  );

  // Onglet Proposals : la liste elle-même vient du CORPS partagé
  // (`ProposalListBody`), alimenté par `proposals` — DÉJÀ lu par cet écran. Les
  // filtres et leurs compteurs restent les fonctions PURES de `proposalFilters`,
  // donc aucune divergence possible avec l'écran Vault, et AUCUNE double lecture.
  const priorityIndex = inboxDecisions[0]?.index ?? null;

  // Compteurs : ce qui attend une action du wallet (vote) et ce qui est prêt à
  // être exécuté par lui. Aucune lecture supplémentaire : propositions déjà lues.
  const homeNeedsVote = view === undefined
    ? 0
    : (proposals.list?.proposals ?? []).filter(
        (proposal) =>
          proposal.status === 'Active' &&
          homeIsMember &&
          homeWalletRoles.includes('Vote') &&
          !proposal.approvedAddresses.includes(walletAddress ?? ''),
      ).length;
  const homeReadyToExecute = view === undefined
    ? 0
    : (proposals.list?.proposals ?? []).filter(
        (proposal) =>
          proposal.status === 'Approved' && homeIsMember && homeWalletRoles.includes('Execute'),
      ).length;
  const proposalsLoaded = proposals.list !== null;

  useEffect(() => {
    const view = msig.view;
    const list = proposals.list;
    if (view === null || list === null) return;
    if (priorityIndex === null) return;
    if (inboxAttemptedRef.current === priorityIndex) return;
    inboxAttemptedRef.current = priorityIndex;
    setInboxDecoding(true);
    setInboxDecodeError(null);
    let cancelled = false;
    void (async () => {
      try {
        const status =
          list.proposals.find((entry) => entry.index === priorityIndex)?.status ?? 'Unknown';
        const result = await loadProposalReview(
          connection,
          new PublicKey(view.address),
          {
            network: 'devnet',
            multisigAddress: view.address,
            vaultAddress: view.vaultAddress,
            proposalIndex: priorityIndex,
            proposalStatus: status,
            signerWallet: account === undefined ? 'Unknown' : account.address.toString(),
          },
          priorityIndex,
        );
        if (!cancelled) setInboxDecoded(result);
      } catch (caught: unknown) {
        if (!cancelled) {
          setInboxDecoded(null);
          setInboxDecodeError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setInboxDecoding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, priorityIndex, proposalsLoaded, viewAddress, viewVaultAddress]);

  // --- Selection de vault : auto-chargement et recence ---------------------
  /**
   * Selection d'un vault dans le selecteur : on DEMANDE le chargement ; la
   * feuille ne se ferme qu'APRES un succes (voir l'effet ci-dessous). Un echec
   * ne ferme pas la feuille et ne met jamais a jour la recence.
   */
  const onSelectVault = useCallback(
    (address: string) => {
      selectCloseRef.current = true;
      loadVault(address);
    },
    [loadVault],
  );

  /**
   * Ouverture VOLONTAIRE du selecteur (« chemin de sélection ») : c'est ici,
   * et seulement ici, que le drapeau `choosingVault` est arme. Toutes les
   * entrees du selecteur y passent, donc le texte de choix est toujours celui
   * affiche sur une arrivee volontaire. Aucun effet sur le chargement.
   */
  const openVaultPicker = useCallback(() => {
    setChoosingVault(true);
    setVaultPickerOpen(true);
  }, []);

  /**
   * Bascule EXPLICITE du bloc « Multisig address » depuis la carte d'état vide
   * (aucun vault chargé : `no-saved` / `no-active`). Un tap de l'utilisateur
   * gagne TOUJOURS sur la révélation AUTOMATIQUE par le chemin de choix :
   *  - si le bloc n'est visible QUE parce que le chemin de choix l'a révélé
   *    (`choosingVault` vrai, `addMultisigOpen` faux), le tap le REPLIE
   *    (`addMultisigOpen` reste faux) ET referme le drapeau de choix ;
   *  - sinon il bascule normalement (`addMultisigOpen`), ouvre au 1er tap,
   *    referme au 2e.
   * La PREMIÈRE révélation depuis le chemin de choix reste garantie : elle est
   * le fait de `openVaultPicker` (drapeau `choosingVault`), pas de ce handler.
   */
  const onToggleAddMultisig = useCallback(() => {
    setAddMultisigOpen((previous) => nextAddMultisigOpen(previous, choosingVault));
    setChoosingVault(false);
  }, [choosingVault]);

  const onCloseVaultPicker = useCallback(() => {
    selectCloseRef.current = false;
    setVaultPickerOpen(false);
  }, []);

  const onCreateVaultFromPicker = useCallback(() => {
    setVaultPickerOpen(false);
    setVaultCreationOpen(true);
  }, []);

  const onAddExistingFromPicker = useCallback(() => {
    setVaultPickerOpen(false);
    setAddMultisigOpen(true);
    // OPTION A : depuis la feuille, ce state DEPLIE le bloc « Multisig address »,
    // que le champ soit replié (vault charge, repli par defaut) ou absent (carte
    // d'etat vide). L'effet « amener au champ » fait le reste (defilement + focus).
    setFocusMultisigToken((previous) => previous + 1);
  }, []);

  // --- Archivage local (etape 3) : handlers PARTAGES selecteur + Account ------

  /** Ouvre la confirmation d'archivage (copie locale, aucun effet on-chain). */
  const onRequestArchive = useCallback((address: string) => {
    setArchiveConfirmAddress(address);
  }, []);

  /**
   * Confirme l'archivage : ecriture LOCALE uniquement. Si le vault archive etait
   * l'actif, bascule vers le plus recemment utilise des AUTRES vaults actifs
   * (par lastUsedAt), sinon vers l'etat vide « No active multisig ». Ne touche
   * jamais l'etat on-chain, ne cree aucune transaction, aucun appel reseau.
   */
  const onConfirmArchive = useCallback(() => {
    const address = archiveConfirmAddress;
    setArchiveConfirmAddress(null);
    if (address === null) return;
    const wasActive = address === viewAddress;
    void (async () => {
      await archive.markArchived(address);
      if (!wasActive) return;
      const next = nextActiveAfterArchiving(
        registry.entries,
        usage.usage,
        archive.archive,
        address,
      );
      if (next !== null) {
        loadVault(next);
      } else {
        // Aucun vault actif restant : on DECHARGE la vue (etat local, sans reseau).
        setMultisigInput('');
        msig.clear();
      }
    })();
  }, [archive, archiveConfirmAddress, loadVault, msig, registry.entries, usage.usage, viewAddress]);

  /** Restaure un vault archive (action primaire, etat local uniquement). */
  const onRestoreVault = useCallback(
    (address: string) => {
      void archive.markRestored(address);
    },
    [archive],
  );

  /** Ouvre la confirmation de retrait de l'appareil (entrees archivees seulement). */
  const onRequestRemove = useCallback((address: string) => {
    setRemoveConfirmAddress(address);
  }, []);

  /** Confirme le retrait : supprime l'entree locale ET son etat d'archivage. */
  const onConfirmRemove = useCallback(() => {
    const address = removeConfirmAddress;
    setRemoveConfirmAddress(null);
    if (address === null) return;
    void (async () => {
      await registry.remove(address);
      await archive.forget(address);
    })();
  }, [archive, registry, removeConfirmAddress]);

  /** Ouvre l'edition de nom (Renommer) avec la valeur locale courante. */
  const onRequestRename = useCallback(
    (address: string) => {
      const entry = registry.entries.find((candidate) => candidate.address === address);
      setRenameValue(entry?.vaultName ?? '');
      setRenameAddress(address);
    },
    [registry.entries],
  );

  const onCancelRename = useCallback(() => {
    setRenameAddress(null);
    setRenameValue('');
  }, []);

  /**
   * Valide le renommage : reutilise l'ecriture EXISTANTE du registre local
   * (`registry.add`, upsert par adresse => jamais de doublon). Aucun reseau.
   */
  const onSubmitRename = useCallback(() => {
    const address = renameAddress;
    setRenameAddress(null);
    if (address === null) return;
    const entry = registry.entries.find((candidate) => candidate.address === address);
    const name = renameValue.trim();
    if (entry === undefined || name.length === 0 || name === entry.vaultName) return;
    void registry.add({
      address,
      vaultName: name,
      memberLabels: entry.memberLabels,
      source: entry.source,
    });
  }, [registry, renameAddress, renameValue]);

  /**
   * « Add existing multisig » avec une adresse DEJA archivee : on n'ajoute pas
   * de doublon, on propose de restaurer l'entree locale existante.
   */
  const onConfirmRestorePrompt = useCallback(() => {
    const address = restorePromptAddress;
    setRestorePromptAddress(null);
    if (address === null) return;
    void (async () => {
      await archive.markRestored(address);
      loadVault(address);
    })();
  }, [archive, loadVault, restorePromptAddress]);

  /**
   * Avertissement « pending proposal » de la confirmation d'archivage : rendu
   * SEULEMENT si l'on archive le vault ACTIF et que la source VERIFIEE deja lue
   * (`proposals`, lue pour le vault actif) fournit un compte. Aucune lecture
   * declenchee pour cet avertissement, aucun scan multi-vault.
   */
  const archiveProposalWarning =
    archiveConfirmAddress !== null &&
    archiveConfirmAddress === viewAddress &&
    proposals.status === 'loaded'
      ? pendingProposalWarning(homeNeedsVote)
      : null;

  /**
   * Auto-chargement, AU LANCEMENT UNIQUEMENT, du vault le plus recemment
   * utilise. Une seule tentative : un echec n'entraine AUCUNE bascule
   * silencieuse vers un autre vault et ne reessaie pas en boucle.
   */
  useEffect(() => {
    // Il faut connaitre l'archivage AVANT de choisir la cible : un vault
    // archive ne doit JAMAIS etre auto-charge.
    if (archive.status !== 'ready') return;
    const active = activeEntries(registry.entries, archive.archive);
    if (
      !shouldAutoLoad({
        registryStatus: registry.status,
        usageStatus: usage.status,
        hasView: view !== null,
        attempted: autoLoadAttemptedRef.current,
        savedCount: active.length,
        loading: msig.status === 'loading',
      })
    ) {
      return;
    }
    const target = mostRecentlyUsedActiveAddress(registry.entries, usage.usage, archive.archive);
    autoLoadAttemptedRef.current = true;
    if (target !== null) loadVault(target);
  }, [
    archive.archive,
    archive.status,
    loadVault,
    msig.status,
    registry.entries,
    registry.status,
    usage.status,
    usage.usage,
    view,
  ]);

  /**
   * PERSISTANCE + recence : enregistrees UNIQUEMENT apres un chargement REUSSI —
   * jamais a l'affichage, jamais a l'ouverture du selecteur, jamais sur un echec.
   *
   * (a) Un multisig charge avec succes et encore INCONNU du registre (ajout
   *     manuel « Add existing multisig ») est PERSISTE localement (upsert par
   *     adresse) : il reapparait dans la liste apres une relance. Une entree
   *     EXISTANTE n'est JAMAIS touchee (nom et provenance conserves) — le
   *     renommage et la creation ecrivent le registre ailleurs.
   * (b) Le vault charge est ensuite marque comme DERNIER UTILISE, donc il sera
   *     auto-charge a l'ouverture suivante.
   */
  useEffect(() => {
    if (msig.status !== 'loaded' || view === null) return;
    if (lastMarkedViewRef.current === view) return;
    lastMarkedViewRef.current = view;
    if (!registry.entries.some((entry) => entry.address === view.address)) {
      void registry.add({
        address: view.address,
        vaultName: '',
        memberLabels: {},
        source: 'manual',
      });
    }
    if (selectCloseRef.current) {
      selectCloseRef.current = false;
      setVaultPickerOpen(false);
    }
    void usage.markUsed(view.address, {
      threshold: view.threshold,
      memberCount: view.members.length,
    });
  }, [msig.status, registry.entries, view, usage]);

  // Receive SOL (Groupe 1) : vue informative. N'ouvre aucun wallet, ne prépare
  // aucune transaction, ne fait aucun RPC. L'adresse vient de msig.view
  // (Main vault PDA index 0, déjà dérivée) — jamais d'une valeur inventée.
  if (receiveOpen) {
    return <ReceiveScreen address={viewVaultAddress} onBack={() => setReceiveOpen(false)} />;
  }

  // Revue d'une proposition réelle : prioritaire sur les previews de dev.
  // Onboarding : premiere utilisation (ou reouverture depuis Home). Cet ecran ne
  // connecte aucun wallet, ne signe rien et ne fait aucun appel reseau.
  if (onboarding.ready && onboarding.show) {
    return (
      <OnboardingScreen
        initialProfile={onboarding.profile}
        onClose={onboarding.close}
        onFinish={(profile) => {
          void onboarding.complete(profile);
        }}
        onSkip={(profile) => {
          void onboarding.skip(profile);
        }}
      />
    );
  }

  // Proposition ouverte depuis l'inbox : exactement le MEME ecran que depuis
  // Home (ProposalDetailsScreen), avec decodage sur place. Lecture seule.
  if (openDecisionIndex !== null && msig.view !== null) {
    const view = msig.view;
    const decision =
      proposals.list?.proposals.find((entry) => entry.index === openDecisionIndex) ?? null;
    if (decision !== null) {
      return (
        <ProposalDetailsScreen
          address={view.address}
          decodedModel={
            inboxDecoded !== null && inboxDecoded.model.proposalIndex === decision.index
              ? inboxDecoded.model
              : null
          }
          index={decision.index}
          members={view.members}
          onBack={(verifiedStatus) => {
            // Retour depuis le detail : relecture de la liste, sinon une
            // proposition executee resterait affichee dans To do.
            setOpenDecisionIndex(null);
            // FILTRE DE RETOUR : origine gardee SAUF si la categorie VERIFIEE
            // on-chain a change (ex. executee pendant la consultation -> Done).
            // `verifiedStatus === null` = aucune relecture aboutie : on ne
            // devine RIEN et on garde l'origine.
            setProposalFilter(
              resolveReturnFilter(openDecisionOrigin, verifiedStatus, {
                index: decision.index,
                approvals: decision.approvals,
                threshold: view.threshold,
                approvedAddresses: decision.approvedAddresses,
                walletAddress,
                walletCanApprove,
                walletCanExecute: homeWalletCanExecute,
              }),
            );
            refreshProposalsReadOnly();
          }}
          proposal={{ approvedAddresses: decision.approvedAddresses, status: decision.status }}
          threshold={view.threshold}
          vaultTransactionAddress={decision.vaultTransactionAddress}
          walletAddress={walletAddress}
          walletCanApprove={view.members.some(
            (member) => member.address === walletAddress && member.roles.includes('Vote'),
          )}
        />
      );
    }
  }

  // Preview locale (développement uniquement) : affiche un modèle fictif.
  // Aucun appel réseau, aucune action au montage, fermeture par Back seulement.
  const activePreview = PREVIEW_CASES.find((entry) => entry.key === previewCase);
  if (activePreview) {
    return (
      <TransactionReviewScreen
        model={activePreview.model}
        onBack={() => setPreviewCase(null)}
      />
    );
  }

  // Multisig ouvert depuis l'inbox : un seul getAccountInfo (loadMultisig),
  // aucune creation, aucune signature, aucune proposition.
  if (openEntry !== null) {
    return (
      <MultisigDetailsScreen
        address={openEntry.address}
        decodedModelFor={(index) =>
          // Uniquement les modeles DEJA decodes : celui de la proposition
          // prioritaire prechargee plus haut. Aucune lecture declenchee ici.
          inboxDecoded !== null && inboxDecoded.model.proposalIndex === index
            ? inboxDecoded.model
            : null
        }
        onBack={() => setOpenEntry(null)}
        vaultName={openEntry.vaultName}
      />
    );
  }

  // Multisig charge manuellement : meme ecran de detail que ceux de l'inbox.
  // L'adresse vient de la vue deja lue : aucun appel reseau supplementaire ici.
  if (manualDetailsOpen && msig.view !== null) {
    return (
      <MultisigDetailsScreen
        address={msig.view.address}
        onBack={() => {
          setManualDetailsOpen(false);
          // Toute reouverture repart de la vue detaillee par defaut.
          setManualDetailsIntent('details');
        }}
        // Objectif A : « Propose » ouvre DIRECTEMENT la creation de proposition,
        // jamais la simple vue « Vault Details ».
        openNewProposalOnMount={manualDetailsIntent === 'propose'}
        // Objectif B : vrai nom local du vault (sinon fallback « Main vault »).
        vaultName={homeVaultName}
      />
    );
  }

  // Inbox des multisigs connus : lecture du registre local uniquement.
  if (inboxOpen) {
    return (
      <MultisigInboxScreen
        onBack={() => setInboxOpen(false)}
        onOpenMultisig={(entry) => setOpenEntry(entry)}
      />
    );
  }

  // Assistant local de creation de vault : ecran dedie. Apres un succes verifie
  // on sort vers l'inbox ou directement sur le vault cree.
  if (vaultCreationOpen) {
    return (
      <CreateVaultScreen
        onCancel={() => setVaultCreationOpen(false)}
        onGoToInbox={() => {
          setVaultCreationOpen(false);
          setInboxOpen(true);
        }}
        onOpenVault={(vault) => {
          setVaultCreationOpen(false);
          setOpenEntry({
            address: vault.address,
            addedAt: new Date().toISOString(),
            memberLabels: {},
            source: 'created',
            vaultName: vault.vaultName,
          });
        }}
        onViewProposals={(vault) => {
          // Le vault CREÉ doit etre le vault ACTIF : c'est `msig.view` (chemin
          // de selection EXISTANT `loadVault`, le meme que le selecteur de
          // vault) qui alimente l'onglet Proposals — jamais `openEntry`, qui
          // rend l'ecran de detail partage (sans barre d'onglets). L'entree
          // locale (source `created`) est deja persistee par l'ecran de
          // creation ; on ne fait que charger ce vault puis basculer l'onglet.
          setVaultCreationOpen(false);
          loadVault(vault.address);
          setTab('proposals');
        }}
      />
    );
  }

  /**
   * Bloc de chargement manuel d'un multisig, EXTRAIT ici pour n'exister qu'une
   * seule fois dans le fichier : il est rendu soit dans la carte d'etat vide
   * (aucun vault charge, revele par `addMultisigOpen || choosingVault`), soit
   * dans le bloc de gestion du Home (un vault est deja charge, REPLIE par defaut
   * et deplie par « Add existing multisig » via `addMultisigOpen`). Aucune
   * logique nouvelle : handlers et etats existants uniquement.
   */
  const multisigLoaderBlock = (
    <View onLayout={onLoaderLayout} style={styles.loaderBlock}>
      <View style={loaderWide ? styles.loaderRow : styles.loaderColumn}>
        <View style={styles.loaderField}>
          <AddressInput
            disabled={msig.status === 'loading'}
            inputRef={multisigInputRef}
            label="Multisig address"
            onBlur={onMultisigInputBlur}
            onChangeText={setMultisigInput}
            onFocus={onMultisigInputFocus}
            onSubmitEditing={onLoadMultisig}
            placeholder="Multisig address"
            returnKeyType="go"
            value={multisigInput}
          />
        </View>
        {loaderWide ? (
          <View style={styles.loaderButtonSlot}>
            <PillButton
              accessibilityLabel="Load multisig"
              busy={msig.status === 'loading'}
              disabled={msig.status === 'loading'}
              label="Load"
              onPress={onLoadMultisig}
              variant="primary"
            />
          </View>
        ) : null}
      </View>
      {loaderWide ? null : (
        <PillButton
          accessibilityLabel="Load multisig"
          busy={msig.status === 'loading'}
          disabled={msig.status === 'loading'}
          label="Load multisig"
          onPress={onLoadMultisig}
          variant="primary"
        />
      )}
      {msig.status === 'loading' ? (
        <Text style={styles.vaultCopySmall}>Lecture…</Text>
      ) : null}
      {/* Erreur de chargement MANUEL : même panneau AMBRE (warning), copie
          COURTE et humaine — jamais le texte brut. AUCUN « Retry » ici : le
          seul point d'action de l'écran vit dans la carte d'état, et il est le
          SEUL bouton « Retry ». Rendu uniquement quand la carte d'échec ne
          porte pas déjà ce message (sinon redondance). */}
      {vaultBodyState !== 'load-failed' && msig.status === 'error' && msig.error ? (
        <InfoBox glyph="⚠" style={styles.loadWarningBox} tone="warning">
          <InfoText tone="warning">{vaultLoadMessage.title}</InfoText>
          <InfoText tone="warning">{vaultLoadMessage.body}</InfoText>
        </InfoBox>
      ) : null}
    </View>
  );

  /* « Disconnect this vault » (et non « Clear ») : ce controle ne CHANGE pas
     de multisig, il DECHARGE celui en cours (champ vide + vue liberee) et
     ramene a l'etat vide. Pour changer de vault, le chemin est
     « Add existing multisig » ou l'Inbox, qui liste le registre local.
     Il vit HORS du bloc repliable « Multisig address » : il reste donc
     TOUJOURS visible quand le champ est replié (option A). Rendu uniquement
     quand un vault est charge (`view !== null`). */
  const multisigDisconnectBlock =
    view !== null ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Disconnect this vault"
        onPress={() => {
          setMultisigInput('');
          msig.clear();
        }}
        style={styles.retry}
      >
        <Text style={[styles.retryTextV2, styles.retryTextDanger]}>Disconnect this vault</Text>
      </Pressable>
    ) : null;

  // Android : la fenetre n'etant plus redimensionnee par l'IME en edge-to-edge,
  // le KeyboardAvoidingView en mode "padding" est necessaire sur les deux
  // plateformes (aucune hauteur codee en dur).
  return (
    <>
    <KeyboardAvoidingView behavior="padding" style={[styles.keyboardAvoider, SAFE_TOP_PADDING]}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={onScrollContent}
        ref={scrollViewRef}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            colors={[colors.text]}
            onRefresh={onPullToRefresh}
            progressBackgroundColor={colors.surface}
            refreshing={pullingToRefresh}
            tintColor={colors.textSecondary}
          />
        }
        style={styles.scrollView}
      >
      {/* Le carre menthe « ◈ » est retire : un faux logo dont personne ne
          comprenait le sens. Il ne reste que la pastille reseau, alignee a droite. */}
      <View style={styles.headerRow}>
        {/* Selecteur de vault : remplace l'ancienne enveloppe Inbox. Affiche le
            nom du vault actif (ou « Select a multisig ») + un chevron ; ouvre la
            feuille « My multisigs ». AUCUNE adresse de wallet dans cet en-tete. */}
        {account === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Select multisig"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            onPress={openVaultPicker}
            style={({ pressed }) => [styles.headerSelector, pressed && styles.inlineActionPressed]}
          >
            <Text numberOfLines={1} style={styles.headerSelectorName}>
              {headerVaultLabel}
            </Text>
            <Ionicons color={colors.mint} name="chevron-down" size={16} />
          </Pressable>
        )}
        <DevnetPill />
      </View>

      {account === undefined ? (
        <>
          {/* Marque animée : même cycle que le SVG de marque (ouverture,
              maintien, fermeture, maintien — 3,6 s). Mode tuile : les cartes
              sont sombres et disparaîtraient sur le fond de l'app. */}
          <CardsMark loop size={132} style={styles.brandMark} tile />
          <Text style={styles.heroTitle}>Multisig</Text>
          <Text style={styles.heroTagline}>
            Shared vaults on Solana.{'\n'}Everyone signs, nobody trusts alone.
          </Text>

          <View style={styles.valueList}>
            {/* Vraies icônes : le carré « ◈ », le « ✓ » et le « ❖ » d'avant ne
                voulaient rien dire. Le coffre reprend la marque de l'app. */}
            <ListRow
              glyphNode={<MaterialCommunityIcons color={colors.mint} name="safe" size={22} />}
              title="Create a shared vault"
              subtitle="2 or more signers"
            />
            <ListRow
              glyphNode={
                <Ionicons color={colors.mint} name="checkmark-done-outline" size={22} />
              }
              title="Propose, approve, execute"
              subtitle="Each step signed in your wallet"
            />
            <ListRow
              glyphNode={<Ionicons color={colors.mint} name="lock-closed-outline" size={22} />}
              title="Keys stay in your wallet"
              subtitle="Seed Vault, Solflare, Ledger"
            />
          </View>

          {/* Espace supplementaire AU-DESSUS du groupe du bouton principal
              (Connect wallet + note Devnet + Learn) : l'enveloppe pousse tout le
              groupe un peu plus bas, son espacement INTERNE reste inchange. */}
          <View style={styles.connectWalletSpacer}>
            <PillButton
              accessibilityLabel="Connect wallet"
              busy={phase === 'connecting'}
              disabled={busy}
              label="Connect wallet"
              onPress={onConnect}
            />
          </View>
          {/* « Open wallet help » : ghost pill (fond doux, texte mint, SANS
              bordure), SOUS le CTA blanc principal, centré et largeur au
              contenu. Il ne concurrence pas le bouton « Connect wallet » : pas
              de fond vif, pas de blanc plein. Ouvre la feuille « Wallet help ». */}
          <View style={styles.walletHelpRow}>
            <Pressable
              accessibilityLabel="Open wallet help"
              accessibilityRole="button"
              onPress={() => setWalletHelpOpen(true)}
              style={({ pressed }) => [
                styles.walletHelpPill,
                pressed && styles.walletHelpPillPressed,
              ]}
            >
              <Text style={styles.walletHelpPillText}>Open wallet help</Text>
            </Pressable>
          </View>
          {/* Note Devnet : REMISE a cote du bouton Connect. C'est un avertissement
              sur l'ACTION de connexion — donc il vit la ou l'action se fait, a
              cote de ce qui peut paraitre risque. */}
          <Text style={styles.footerNote}>Devnet · nothing real is at stake</Text>
          {phase === 'connecting' ? (
            <Text style={styles.footerNote}>Opening the wallet…</Text>
          ) : null}
          {error !== null ? (
            <InfoBox glyph="⚠" style={styles.errorBoxV2} tone="error">
              <InfoText tone="error">{error}</InfoText>
            </InfoBox>
          ) : null}
          {error !== null || (__DEV__ && mwaReport !== null) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry connecting the wallet"
              onPress={onConnect}
              style={styles.retry}
            >
              <Text style={styles.retryTextV2}>Retry</Text>
            </Pressable>
          ) : null}
          {__DEV__ && mwaReport !== null ? (
            <View style={styles.devBlock}>
              <Text style={styles.devText}>MWA diagnostics</Text>
              <Text style={styles.devText}>Step: {mwaReport.step}</Text>
              <Text style={styles.devText}>
                Protocol code: {mwaReport.code ?? 'none returned'}
              </Text>
              <Text style={styles.devText}>
                Error type: {mwaReport.name ?? 'not an Error instance'}
              </Text>
              <Text style={styles.devText}>Message: {mwaReport.message}</Text>
              {mwaReport.data !== null ? (
                <Text style={styles.devText}>Data: {mwaReport.data}</Text>
              ) : null}
              <Text style={styles.devText}>{mwaReport.hint}</Text>
            </View>
          ) : null}
        </>
      ) : null}

      {/* Apprentissage : visible SANS wallet (écran déconnecté). Une fois
          connecté, l'accès Learn vit dans l'onglet Account. */}
      {account === undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Learn how multisig works"
          onPress={onboarding.open}
          style={({ pressed }) => [styles.learnSurface, pressed && styles.learnSurfacePressed]}
        >
          <Text style={styles.learnSurfaceText}>Learn how multisig works</Text>
        </Pressable>
      ) : null}

      {/* Diagnostics réseau : DEV uniquement. En release, aucun niveau RPC au
          premier niveau des écrans V2. */}
      {__DEV__ ? (
        <View style={styles.devBlock}>
          <Text style={styles.devText}>
            Network: Devnet · RPC: {rpcStatus}
          </Text>
          {rpcDetail !== null ? <Text style={styles.devText}>{rpcDetail}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry the RPC health check"
            onPress={retryRpc}
            style={styles.retry}
          >
            <Text style={styles.retryTextV2}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Onglet Vault : le contenu du Home V2, strictement INCHANGÉ. */}
      {account === undefined || tab !== 'vault' ? null : (
        <View
          style={view === null && !addMultisigOpen ? styles.homeBodyEmpty : styles.homeBody}
        >
          {/* ÉTAT SANS MULTISIG : la carte porte les DEUX seules actions utiles,
              avec `Create a vault` en principal. Auparavant, six boutons de poids
              égal se disputaient l'écran ; les actions de gestion (Learn,
              Disconnect, Reset) vivent désormais dans l'onglet Account, et
              « Your wallet » aussi. */}
          {view === null ? (
            <>
              {/* Variante B : la marque animée RÉELLE coiffe la carte de
                  chargement. Props STRICTEMENT identiques à l'écran de
                  connexion du wallet (`loop`, `size={132}`, `tile`) — aucune
                  reproduction redessinée. L'ensemble est centré verticalement
                  par `homeBodyEmpty` (plus de grand vide noir sous une carte
                  collée en haut). La marque coiffe AUSSI les cartes neutres
                  « no-saved » (aucun vault local — y compris APRÈS une
                  déconnexion) et « no-active » (toutes les entrées archivées),
                  pour la cohérence entre les états « aucun vault à l'écran ». */}
              {vaultBodyState === 'loading-registry' || vaultBodyState === 'loading-vault' || vaultBodyState === 'no-saved' || vaultBodyState === 'no-active' ? (
                <CardsMark loop size={132} style={styles.brandMark} tile />
              ) : null}
            <Card elevated style={styles.vaultCard}>
              {/* « No multisig loaded » UNIQUEMENT s'il n'existe aucune
                  sauvegarde locale. Avec des sauvegardes mais aucun vault
                  charge, on affiche le chargement ou l'echec — jamais cet etat. */}
              {vaultBodyState === 'no-saved' ? (
                <>
                  <Text style={styles.vaultName}>No multisig loaded</Text>
                  <Text style={styles.vaultCopy}>
                    Create a vault, or load one you are a signer of, to see its balance and actions.
                  </Text>
                  <View style={styles.manageBody}>
                    <PillButton
                      accessibilityLabel="Create a vault"
                      label="Create a vault"
                      onPress={() => setVaultCreationOpen(true)}
                    />
                    <PillButton
                      accessibilityLabel="Add an existing multisig"
                      disabled={msig.status === 'loading'}
                      label="Add existing multisig"
                      onPress={onToggleAddMultisig}
                      variant="secondary"
                    />
                  </View>
                </>
              ) : null}
              {/* « No active multisig » : des sauvegardes existent mais sont
                  TOUTES archivees (etape 3). Memes actions, plus l'acces aux
                  archives. La section « Archived (N) » n'apparait que si N > 0. */}
              {vaultBodyState === 'no-active' ? (
                <>
                  <Text style={styles.vaultName}>No active multisig</Text>
                  <Text style={styles.vaultCopy}>
                    All your multisigs are archived on this device. Restore one, or add another.
                  </Text>
                  <View style={styles.manageBody}>
                    <PillButton
                      accessibilityLabel="Create a vault"
                      label="Create a vault"
                      onPress={() => setVaultCreationOpen(true)}
                    />
                    <PillButton
                      accessibilityLabel="Add an existing multisig"
                      disabled={msig.status === 'loading'}
                      label="Add existing multisig"
                      onPress={onToggleAddMultisig}
                      variant="secondary"
                    />
                    {archivedSectionLabel(archivedCount) !== null ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={archivedSectionLabel(archivedCount) ?? 'Archived'}
                        onPress={openVaultPicker}
                        style={styles.retry}
                      >
                        <Text style={styles.retryTextV2}>
                          {archivedSectionLabel(archivedCount)}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : null}
              {/* Echec de chargement : panneau AMBRE (warning, jamais rouge),
                  copie COURTE et humaine (aucun texte brut : ni exception, ni
                  hôte RPC, ni base58). « Retry » ici est le SEUL bouton de
                  reessai de l'ecran ; « Choose another multisig » reste. */}
              {vaultBodyState === 'load-failed' ? (
                <>
                  <InfoBox glyph="⚠" style={styles.loadWarningBox} tone="warning">
                    <InfoText tone="warning">{vaultLoadMessage.title}</InfoText>
                    <InfoText tone="warning">{vaultLoadMessage.body}</InfoText>
                  </InfoBox>
                  <View style={styles.manageBody}>
                    <PillButton
                      accessibilityLabel="Retry loading this multisig"
                      busy={msig.status === 'loading'}
                      disabled={msig.status === 'loading'}
                      label="Retry"
                      onPress={msig.retry}
                    />
                    <PillButton
                      accessibilityLabel="Choose another multisig"
                      label="Choose another multisig"
                      onPress={() => setVaultPickerOpen(true)}
                      variant="secondary"
                    />
                  </View>
                </>
              ) : null}
              {vaultBodyState === 'loading-registry' || vaultBodyState === 'loading-vault' ? (
                <>
                  <Text style={styles.vaultName}>
                    {vaultBodyState === 'loading-registry'
                      ? 'Loading saved multisigs…'
                      : choosingVault
                        ? 'Open a multisig'
                        : 'Loading your multisig…'}
                  </Text>
                  <Text style={styles.vaultCopy}>
                    {vaultBodyState === 'loading-registry'
                      ? 'Reading the local registry.'
                      : choosingVault
                        ? 'Pick one from your saved vaults, or paste an address.'
                        : 'Getting your most recent vault.'}
                  </Text>
                </>
              ) : null}
              {addMultisigOpen || choosingVault ? multisigLoaderBlock : null}
            </Card>
            </>
          ) : (
            <Card elevated style={styles.vaultCard}>
              <View style={styles.vaultCardTop}>
                <Text style={styles.vaultName}>{homeVaultName ?? 'Main vault'}</Text>
                <View style={styles.memberBadge}>
                  <Text style={styles.memberBadgeText}>
                    {`MULTISIG · ${view.threshold} OF ${view.members.length}`}
                  </Text>
                </View>
              </View>
              <View style={styles.balanceRow}>
                <Text selectable style={styles.balanceValue}>
                  {balanceHidden
                    ? '•••••• SOL'
                    : homeBalanceView.sol !== null
                      ? `${homeBalanceView.sol} SOL`
                      : '0 SOL'}
                </Text>
                {/* Confidentialite du solde : etat LOCAL de session, aucune
                    persistance, aucune modification de la valeur reelle ni des
                    calculs (Max / propositions). */}
                {/* OEIL au lieu du texte (demande explicite) : plus commun, et ca
                    debarrasse la carte d'un lien texte de plus. L'etiquette
                    INVISIBLE reste : une icone seule ne se lit pas a voix haute. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={balanceHidden ? 'Show balance' : 'Hide balance'}
                  accessibilityState={{ selected: balanceHidden }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  onPress={() => setBalanceHidden((previous) => !previous)}
                  style={({ pressed }) => [styles.inlineAction, pressed && styles.inlineActionPressed]}
                >
                  <Ionicons
                    color={colors.textSecondary}
                    name={balanceHidden ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                  />
                </Pressable>
              </View>
              {homeBalanceView.title === 'Main vault not funded' ? (
                <Text style={styles.balanceNote}>Main vault not funded</Text>
              ) : null}
              {homeBalanceView.title === 'Balance unavailable' ? (
                <Text style={styles.balanceNote}>Balance unavailable</Text>
              ) : null}
              {homeBalanceView.hint.length > 0 ? (
                <Text style={styles.vaultCopySmall}>{homeBalanceView.hint}</Text>
              ) : null}
              {homeBalanceView.stale ? (
                <Text style={styles.vaultCopySmall}>stale</Text>
              ) : null}
              <Text style={styles.vaultCopySmall}>
                {/* Le ROLE, pas un nom : « My multisig » se lisait comme un
                    second nom du vault (Claude : « Test3 et My multisig donnent
                    deux noms pour le meme vault »). Le nom est deja au-dessus,
                    en gros. Ici on dit ce que TU es pour ce vault. */}
                {homeIsMember ? 'You are a signer' : 'Observed multisig · Read only'}
              </Text>
              {!homeIsMember ? (
                <Text style={styles.vaultCopySmall}>This is public on-chain information.</Text>
              ) : null}
              <View style={styles.vaultAddressRow}>
                <Text selectable style={styles.vaultAddressText}>
                  {shortenAddress(view.vaultAddress)}
                </Text>
                {/* Plus de lien « Reload balance » au quotidien : la relecture du
                    solde passe par la fleche circulaire de « To do » (et par le
                    geste de traction), qui relisent LES DEUX. Il ne reste ici
                    qu'un « Retry » en cas d'echec de lecture — la seule situation
                    ou une action dediee est reellement utile. */}
                {homeBalanceError ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry reading the Main vault balance"
                    disabled={homeBalance?.status === 'loading'}
                    onPress={() => {
                      refreshHomeBalance(viewVaultAddress ?? '');
                    }}
                    style={({ pressed }) => [
                      styles.inlineAction,
                      pressed && styles.inlineActionPressed,
                    ]}
                  >
                    <Text style={styles.inlineActionText}>Retry</Text>
                  </Pressable>
                ) : null}
              </View>
              {/* Objectif B : action secondaire vers l'UNIQUE vue detaillee
                  (MultisigDetailsScreen V2), meme handler que le chemin Inbox.
                  Porte desormais le repere d'accessibilite de la vue detaillee,
                  depuis le retrait de la tuile « Signers ». */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open this multisig in the shared detail screen"
                onPress={() => {
                  setManualDetailsIntent('details');
                  setManualDetailsOpen(true);
                }}
                style={({ pressed }) => [
                  styles.inlineAction,
                  pressed && styles.inlineActionPressed,
                ]}
              >
                <Text style={styles.inlineActionText}>View vault details ›</Text>
              </Pressable>
            </Card>
          )}

          {/* ACTIONS PRINCIPALES — uniquement quand un vault est chargé. */}
          {view === null ? null : (
            <View style={styles.actionRow}>
              <HomeAction glyph="↓" label="Receive" onPress={() => setReceiveOpen(true)} />
              {/* Objectif A : « Propose » ouvre l'ecran partage AVEC l'intention de
                  creation immediate — l'utilisateur atterrit sur New Proposal,
                  jamais sur la vue « Vault Details » (aucun flash). */}
              <HomeAction
                glyph="↗"
                label="Propose"
                onPress={() => {
                  setManualDetailsIntent('propose');
                  setManualDetailsOpen(true);
                }}
              />
              {/* Tuile « Signers » RETIREE (decision produit de Corentin) : elle
                  menait au MEME ecran que « View vault details », qui porte
                  desormais le repere d'accessibilite de la vue detaillee. */}
            </View>
          )}

          {/* TO DO — propositions réellement actionnables, compactes, max 3. */}
          {view === null ? null : (
            <>
              <View style={styles.sectionRow}>
                <Text style={styles.sectionTitle}>To do</Text>
                {/* FLECHE CIRCULAIRE (choix « C ») : elle fait EXACTEMENT ce que
                    fait le geste de traction — solde ET propositions — et
                    remplace les deux liens texte. Le geste reste un raccourci,
                    jamais une obligation : sans lui, l'action reste visible. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh balance and proposals"
                  disabled={pullingToRefresh}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  onPress={onPullToRefresh}
                  style={({ pressed }) => [
                    styles.inlineAction,
                    pressed && styles.inlineActionPressed,
                  ]}
                >
                  <Ionicons
                    color={pullingToRefresh ? colors.textSecondary : colors.mint}
                    name="refresh-outline"
                    size={20}
                  />
                </Pressable>
              </View>
              {/* Compteurs derives des propositions deja lues (donnee conservee) :
                  rendus uniquement s'ils sont non nuls, sans identifiant technique. */}
              {homeNeedsVote + homeReadyToExecute > 0 ? (
                <Text style={styles.vaultCopySmall}>
                  {homeNeedsVote} waiting for your vote · {homeReadyToExecute} ready to execute
                </Text>
              ) : null}
              {proposals.status === 'loading' ? (
                <Text style={styles.vaultCopySmall}>Reading…</Text>
              ) : null}
              {inboxDecisions.length === 0 && proposals.status === 'loaded' ? (
                <Text style={styles.emptyNote}>Nothing waiting</Text>
              ) : null}
              {inboxDecisions.slice(0, 3).map((decision) => {
                const model = decodedModelFor(decision.index);
                const summary = summarizeOperation(model);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open proposal ${decision.index} in the shared detail screen`}
                    key={decision.index}
                    onPress={() => {
                      setOpenDecisionIndex(decision.index);
                    }}
                    style={({ pressed }) => [styles.todoRow, pressed && styles.todoRowPressed]}
                  >
                    <Text style={styles.todoIndex}>{`#${decision.index}`}</Text>
                    <View style={styles.todoBody}>
                      <Text style={styles.todoTitle}>
                        {summary === null ? 'Proposal' : summary.action}
                      </Text>
                      <Text style={styles.todoMeta}>
                        {summary === null
                          ? inboxDecodeError !== null
                            ? 'Operation details unavailable'
                            : inboxDecoding
                              ? 'Loading operation…'
                              : `${decision.stateLabel} · ${decision.approvals} of ${decision.threshold} approvals`
                          : `${summary.amount} · ${decision.stateLabel} · ${decision.approvals} of ${decision.threshold} approvals`}
                      </Text>
                    </View>
                    <Text style={styles.todoChevron}>›</Text>
                  </Pressable>
                );
              })}
              {/* Plus de 3 actions : lien vers la liste complete des propositions,
                  via le handler de navigation EXISTANT (Vault Details → Proposals).
                  Aucune nouvelle route n'est creee. */}
              {inboxDecisions.length > 3 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="View all proposals"
                  onPress={() => {
                    setManualDetailsIntent('details');
                    setManualDetailsOpen(true);
                  }}
                  style={({ pressed }) => [
                    styles.inlineAction,
                    styles.viewAllAction,
                    pressed && styles.inlineActionPressed,
                  ]}
                >
                  <Text style={styles.inlineActionText}>View all proposals</Text>
                </Pressable>
              ) : null}
              {proposals.status === 'error' && proposals.error ? (
                <InfoBox glyph="⚠" style={styles.errorBoxV2} tone="error">
                  <InfoText tone="error">{proposals.error}</InfoText>
                </InfoBox>
              ) : null}
            </>
          )}

          {/* « YOUR WALLET » A ETE RETIRE du Home : le portefeuille n'a rien a
              faire AVANT l'action principale, et l'information vit deja dans
              l'onglet Account (nom, adresse courte, copie). */}

          {/* GESTION DU VAULT — toujours visible quand un vault est chargé.
              OPTION A : le bloc « Multisig address » (champ + Paste + Load +
              note de securite) est REPLIE PAR DEFAUT quand un vault est charge.
              Le bouton « Add existing multisig » ci-dessous le deplie/replie
              (meme mecanisme que la branche sans vault : `addMultisigOpen`).
              « Disconnect this vault » (rouge) vit HORS du repli et reste donc
              TOUJOURS visible. Sans vault, la carte d'etat vide porte deja ses
              deux actions (Create a vault / Add existing multisig). */}
          {view === null ? null : (
            <View style={styles.manageBody}>
              <PillButton
                accessibilityLabel="Switch multisig"
                disabled={msig.status === 'loading'}
                label="Switch multisig"
                onPress={openVaultPicker}
                variant="secondary"
              />
              <PillButton
                accessibilityLabel="Add existing multisig"
                disabled={msig.status === 'loading'}
                label="Add existing multisig"
                onPress={() => setAddMultisigOpen((previous) => !previous)}
                variant="secondary"
              />
              {addMultisigOpen ? multisigLoaderBlock : null}
              {multisigDisconnectBlock}
            </View>
          )}

          {/* Hotfix de coherence : le bloc technique complet du Home est
              SUPPRIME. Les identifiants complets (Main vault, configuration,
              Config authority, Rent collector, Program ID) vivent
              exclusivement dans Vault Details → Advanced details. */}
        </View>
      )}

      {/* Onglets Proposals / Account : rendus À LA PLACE du Home.
          Aucune logique nouvelle — les actions d'Account réutilisent les
          handlers EXISTANTS du Home (copie, déconnexion, guide). */}
      {account === undefined || tab === 'vault' ? null : (
        <View style={styles.homeBody}>
          <Text style={styles.tabTitle}>
            {tab === 'proposals' ? 'Proposals' : 'Account'}
          </Text>

          {tab === 'proposals' ? (
            /* MÊME corps que l'écran Vault : rien n'est relu ici, tout vient de
               `proposals`, déjà lu par cet écran (aucune double lecture). */
            <ProposalListBody
              busy={proposals.status === 'loading'}
              decodedModelFor={decodedModelFor}
              filter={proposalFilter}
              onFilterChange={setProposalFilter}
              onOpenProposal={(proposal) => {
                setOpenDecisionOrigin(proposalFilter);
                setOpenDecisionIndex(proposal.index);
              }}
              proposals={proposals}
              threshold={msig.view?.threshold ?? 0}
              walletAddress={walletAddress}
              walletCanApprove={walletCanApprove}
              walletCanExecute={homeWalletCanExecute}
            />
          ) : null}

          {tab === 'account' ? (
            <>
              {/* CARTE « CONNECTED WALLET » : nom (si déjà connu par la
                  session), adresse abrégée, Copy, et déconnexion via le
                  handler DÉJÀ supporté (`onDisconnect`). Aucune logique de
                  session wallet nouvelle ; Copy réutilise le retour
                  temporaire EXISTANT (`walletCopyFeedback` / `COPIED_MESSAGE`). */}
              <Card elevated style={styles.accountWalletCard}>
                <Text style={styles.accountCardTitle}>Connected wallet</Text>
                <View style={styles.accountWallet}>
                  <View style={styles.walletRowBody}>
                    <Text style={styles.accountWalletLabel}>
                      {walletIdentity?.label ?? 'Wallet without label'}
                    </Text>
                    <Text numberOfLines={1} style={styles.accountWalletAddress}>
                      {shortenAddress(account.address.toString())}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy the wallet address"
                    onPress={onCopyWallet}
                    style={({ pressed }) => [
                      styles.inlineAction,
                      pressed && styles.inlineActionPressed,
                    ]}
                  >
                    <Text style={styles.inlineActionText}>Copy</Text>
                  </Pressable>
                </View>
                {walletCopyFeedback !== null ? (
                  <Text style={styles.copyFeedback}>{walletCopyFeedback}</Text>
                ) : null}
                {/* Disconnect est exposé ICI parce que la déconnexion EST déjà
                    supportée par le flux wallet/session existant (même
                    handler que l'ancien bouton). */}
                <View style={styles.accountWalletActions}>
                  <PillButton
                    accessibilityLabel="Disconnect the wallet"
                    busy={phase === 'disconnecting'}
                    disabled={busy}
                    label="Disconnect wallet"
                    onPress={onDisconnect}
                    variant="danger"
                  />
                </View>
              </Card>

              {/* « MY MULTISIGS » : MÊMES entrées locales que le sélecteur de
                  vault — la MÊME valeur `orderedEntries` (registre + recence)
                  et les MÊMES seuils `vaultStatsByAddress` que ceux passés à
                  `VaultPickerSheet`. Aucune seconde source de stockage, aucune
                  découverte réseau, aucune lecture pour obtenir un seuil. */}
              <Text style={styles.sectionTitle}>My multisigs</Text>
              {orderedEntries.length === 0 ? (
                <Text style={styles.emptyNote}>No multisigs saved on this device yet.</Text>
              ) : (
                orderedEntries.map((entry) => {
                  const stat = vaultStatsByAddress[entry.address];
                  const thresholdLabel =
                    stat !== undefined && stat.threshold !== null && stat.memberCount !== null
                      ? `${stat.threshold} of ${stat.memberCount}`
                      : null;
                  const menuOpen = accountMenuFor === entry.address;
                  return (
                    <View key={entry.address}>
                      <View style={styles.accountMultisigRow}>
                        <View style={styles.walletRowBody}>
                          <Text numberOfLines={1} style={styles.accountMultisigName}>
                            {entry.vaultName.length > 0 ? entry.vaultName : 'Untitled vault'}
                          </Text>
                          <Text numberOfLines={1} style={styles.accountMultisigAddress}>
                            {shortenMemberAddress(entry.address)}
                          </Text>
                          {thresholdLabel !== null ? (
                            <Text style={styles.accountMultisigThreshold}>{thresholdLabel}</Text>
                          ) : null}
                        </View>
                        {/* Menu « ⋯ » de ligne active : Rename / Archive. */}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Options for ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          onPress={() => setAccountMenuFor(menuOpen ? null : entry.address)}
                          style={({ pressed }) => [styles.accountMenuTrigger, pressed && styles.inlineActionPressed]}
                        >
                          <Text style={styles.accountMenuGlyph}>⋯</Text>
                        </Pressable>
                      </View>
                      {menuOpen ? (
                        <View style={styles.accountMenu}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Rename ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                            onPress={() => {
                              setAccountMenuFor(null);
                              onRequestRename(entry.address);
                            }}
                            style={({ pressed }) => [styles.accountMenuItem, pressed && styles.inlineActionPressed]}
                          >
                            <Text style={styles.accountMenuItemText}>Rename</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Archive ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                            onPress={() => {
                              setAccountMenuFor(null);
                              onRequestArchive(entry.address);
                            }}
                            style={({ pressed }) => [styles.accountMenuItem, pressed && styles.inlineActionPressed]}
                          >
                            <Text style={styles.accountMenuItemText}>Archive</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}

              {/* Section « Archived (N) » : MEME source que le selecteur, rendue
                  SEULEMENT quand N > 0. Restore + « Remove from this device »
                  (jamais expose sur une entree active). */}
              {archivedSectionLabel(archivedCount) !== null ? (
                <View style={styles.accountArchivedSection}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      accountArchivedOpen
                        ? `Hide archived vaults (${archivedCount})`
                        : `Show archived vaults (${archivedCount})`
                    }
                    accessibilityState={{ expanded: accountArchivedOpen }}
                    onPress={() => setAccountArchivedOpen((previous) => !previous)}
                    style={({ pressed }) => [
                      styles.accountArchivedHeaderRow,
                      pressed && styles.inlineActionPressed,
                    ]}
                  >
                    <Ionicons
                      color={colors.textSecondary}
                      name={accountArchivedOpen ? 'chevron-down' : 'chevron-forward'}
                      size={16}
                    />
                    <Text style={styles.accountArchivedHeader}>
                      {archivedSectionLabel(archivedCount)}
                    </Text>
                  </Pressable>
                  {accountArchivedOpen
                    ? archivedOrderedEntries.map((entry) => {
                    const stat = vaultStatsByAddress[entry.address];
                    const thresholdLabel =
                      stat !== undefined && stat.threshold !== null && stat.memberCount !== null
                        ? `${stat.threshold} of ${stat.memberCount}`
                        : null;
                    const menuOpen = accountMenuFor === entry.address;
                    return (
                      <View key={entry.address}>
                        <View style={styles.accountMultisigRow}>
                          <View style={styles.walletRowBody}>
                            <Text numberOfLines={1} style={styles.accountMultisigName}>
                              {entry.vaultName.length > 0 ? entry.vaultName : 'Untitled vault'}
                            </Text>
                            <Text numberOfLines={1} style={styles.accountMultisigAddress}>
                              {shortenMemberAddress(entry.address)}
                            </Text>
                            {thresholdLabel !== null ? (
                              <Text style={styles.accountMultisigThreshold}>{thresholdLabel}</Text>
                            ) : null}
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Restore ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                            onPress={() => onRestoreVault(entry.address)}
                            style={({ pressed }) => [styles.accountRestoreAction, pressed && styles.inlineActionPressed]}
                          >
                            <Text style={styles.accountRestoreText}>Restore</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Options for archived ${entry.vaultName.length > 0 ? entry.vaultName : entry.address}`}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            onPress={() => setAccountMenuFor(menuOpen ? null : entry.address)}
                            style={({ pressed }) => [styles.accountMenuTrigger, pressed && styles.inlineActionPressed]}
                          >
                            <Text style={styles.accountMenuGlyph}>⋯</Text>
                          </Pressable>
                        </View>
                        {menuOpen ? (
                          <View style={styles.accountMenu}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Remove from this device"
                              onPress={() => {
                                setAccountMenuFor(null);
                                onRequestRemove(entry.address);
                              }}
                              style={({ pressed }) => [styles.accountMenuItem, pressed && styles.inlineActionPressed]}
                            >
                              <Text style={styles.accountMenuItemDanger}>Remove from this device</Text>
                            </Pressable>
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                    : null}
                </View>
              ) : null}

              {/* Lignes informatives du BAS d'Account (Network / Learn / About /
                  X). Regroupees dans `accountFooterLinks`, dont le retrait
                  horizontal (spacing.md) s'ajoute a celui du conteneur
                  (spacing.lg) : leur bord GAUCHE de texte tombe donc EXACTEMENT
                  sur celui du texte des cartes de vaults (`accountMultisigRow`),
                  lui aussi a spacing.lg + spacing.md = 28 dp. Aucun libelle,
                  aucune action, aucun ordre ne change. */}
              <View style={styles.accountFooterLinks}>
                <ListRow title="Network" subtitle="Devnet · nothing real is at stake" />
                <ListRow
                  accessibilityLabel="Learn how multisig works"
                  onPress={onboarding.open}
                  subtitle="What a shared vault is, and how approvals work"
                  title="Learn how multisig works"
                />
                <ListRow subtitle={`Version ${APP_VERSION}`} title="About" />
                <ListRow
                  accessibilityLabel="Open the X profile of the app (@Corentin_Lad)"
                  onPress={() => {
                    // Presentation seule : on ouvre le navigateur. Un echec
                    // (aucune app capable d'ouvrir un lien) ne change rien ici.
                    void Linking.openURL(X_PROFILE_URL).catch(() => undefined);
                  }}
                  subtitle="@Corentin_Lad"
                  title="X (Twitter)"
                />
              </View>
              {onboarding.storageFailed ? (
                <Text style={styles.vaultCopySmall}>
                  Your answers could not be saved on this device: the app keeps working with the
                  default learning mode, and nothing is sent anywhere.
                </Text>
              ) : null}

              {/* Disconnect vit désormais dans la carte « Connected wallet »
                  ci-dessus (une seule exposition de la déconnexion). */}
            </>
          ) : null}
        </View>
      )}

      {__DEV__ ? (
        <View style={styles.previewBlock}>
          <Text style={styles.previewHeading}>Development only</Text>
          <Text style={styles.previewHint}>
            Local fixture — not on-chain data
          </Text>
          {PREVIEW_CASES.map((entry) => (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              onPress={() => setPreviewCase(entry.key)}
              style={styles.previewButton}
            >
              <Text style={styles.previewButtonText}>
                Preview confirmation screen ({entry.label})
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
      {/* Barre d'onglets : visible une fois le wallet connecté. Elle ne fait
          que changer l'onglet ACTIF — aucun handler métier n'est appelé ici. */}
      {/* Badge Proposals : scopé au vault ACTIF. Le compte vient de la source
          VÉRIFIÉE déjà lue pour ce wallet dans ce vault (`homeNeedsVote`),
          jamais d'une nouvelle lecture ni d'un scan multi-vault. */}
      {account === undefined ? null : (
        <TabBar active={tab} badgeCount={homeNeedsVote} onSelect={setTab} />
      )}
      {/* Feuille « My multisigs » : selecteur de vault rendu hors du flux, au
          dessus du contenu. Presentation seule ; le chargement reste au parent. */}
      {account === undefined ? null : (
        <VaultPickerSheet
          activeAddress={viewAddress}
          archivedEntries={archivedOrderedEntries}
          entries={orderedEntries}
          error={vaultLoadFailed ? vaultLoadMessage.title : null}
          loading={registry.status === 'loading'}
          onAddExisting={onAddExistingFromPicker}
          onArchive={onRequestArchive}
          onClose={onCloseVaultPicker}
          onCreate={onCreateVaultFromPicker}
          onRemove={onRequestRemove}
          onRename={onRequestRename}
          onRestore={onRestoreVault}
          onRetry={msig.retry}
          onSelect={onSelectVault}
          statsByAddress={vaultStatsByAddress}
          visible={vaultPickerOpen}
        />
      )}
      {/* Feuille « Wallet help » : aide de la branche DÉCONNECTÉE (le ghost pill
          « Open wallet help » n'existe que là). Présentation seule ; la
          fermeture revient au parent (bouton « Got it », fond, retour Android). */}
      {account === undefined ? (
        <WalletHelpSheet onClose={() => setWalletHelpOpen(false)} visible={walletHelpOpen} />
      ) : null}
      {/* Dialogues de confirmation — rendus UNE seule fois ici, donc partages a
          l'identique par le selecteur et Account. Les copies viennent des
          constantes PURES de `vaultNavigation` (ponctuation exacte). Aucun effet
          on-chain, aucun RPC, aucune transaction : seul l'archivage LOCAL et le
          retrait LOCAL de l'appareil sont concernes. */}
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Save"
        message="Give this vault a name shown only on this device. It is never sent anywhere."
        onCancel={onCancelRename}
        onConfirm={onSubmitRename}
        title="Rename vault"
        visible={renameAddress !== null}
      >
        <TextInput
          accessibilityLabel="Vault name"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setRenameValue}
          placeholder="Vault name"
          placeholderTextColor={colors.textMuted}
          style={styles.dialogInput}
          value={renameValue}
        />
      </ConfirmDialog>
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Archive"
        message={ARCHIVE_CONFIRMATION_COPY}
        onCancel={() => setArchiveConfirmAddress(null)}
        onConfirm={onConfirmArchive}
        title="Archive this vault?"
        visible={archiveConfirmAddress !== null}
        warning={archiveProposalWarning}
      />
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Remove"
        confirmVariant="danger"
        message={REMOVE_CONFIRMATION_COPY}
        onCancel={() => setRemoveConfirmAddress(null)}
        onConfirm={onConfirmRemove}
        title="Remove from this device?"
        visible={removeConfirmAddress !== null}
      />
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Restore"
        message={RESTORE_ARCHIVED_PROMPT}
        onCancel={() => setRestorePromptAddress(null)}
        onConfirm={onConfirmRestorePrompt}
        title="Restore this vault?"
        visible={restorePromptAddress !== null}
      />
    </KeyboardAvoidingView>
    {launching ? <LaunchSplash onDone={finishLaunch} /> : null}
    {/* ECRAN D'ATTENTE DU WALLET — idee de Corentin, et c'est la bonne : quand
        l'invite du wallet prend le focus, Android cesse de redessiner notre app,
        donc l'ecran reste FIGE. On ne peut pas empecher le gel, mais on peut
        CHOISIR ce qui reste a l'ecran : les cartes en eventail, plein ecran, sur
        fond noir. L'utilisateur voit un etat VOULU au lieu d'une animation
        coupee en plein mouvement.
        Monte EN PERMANENCE (invisible hors connexion, `pointerEvents: 'none'`) :
        un bitmap n'est decode qu'a la taille ou il est RENDU, donc le demonter
        entre deux tentatives obligeait a le redecoder, et sur un aller-retour
        (annuler puis reconnecter) l'ouverture du wallet se conclut en quelques
        centaines de ms — plus vite que le decodage. Resultat : l'image manquait
        une fois
        sur deux. Monte en continu, elle est deja peinte quand le calque devient
        visible.
        Rendu EN DERNIER, donc au-dessus de tout le contenu. */}
    <View
      pointerEvents={phase === 'connecting' ? 'auto' : 'none'}
      style={[
        styles.connectingSplash,
        phase === 'connecting' ? null : styles.connectingSplashIdle,
      ]}
    >
      {/* LES CARTES EN EVENTAIL, seules : ni tuile, ni fond d'icone, ni
          habillage d'application. L'asset `brand-splash-cards.png` derive du
          logo (`foregroundImage`) avec la carte AVANT noircie (#102028 ->
          #03080A) ; les cartes teal et les accents mint sont intacts.
          On n'anime RIEN : une marque animee se figeait sur sa toute premiere
          frame des que le panneau du wallet prenait le focus. */}
      <View style={styles.connectingSplashTop}>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={require('../../assets/brand-splash-cards.png')}
          style={styles.connectingSplashMark}
        />
      </View>
      {/* Reserve la hauteur de la feuille « Open with Wallet » d'Android :
          sans elle les cartes sont centrees, et la feuille coupe leur bas. */}
      <View style={styles.connectingSplashSheetSpace} />
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Conteneur du KeyboardAvoidingView : occupe tout l'espace disponible.
  keyboardAvoider: {
    backgroundColor: colors.background,
    flex: 1,
    width: '100%',
  },
  // Le ScrollView remplit ce conteneur ; le centrage reste assure par container.
  scrollView: {
    backgroundColor: colors.background,
    flex: 1,
    width: '100%',
  },
  container: {
    alignItems: 'stretch',
    backgroundColor: colors.background,
    flexGrow: 1,
    justifyContent: 'flex-start',
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  inboxHeading: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
  },
  inboxCount: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  decisionCard: {
    alignSelf: 'stretch',
    backgroundColor: '#f9fafb',
    borderColor: '#e5e7eb',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
    padding: 14,
  },
  decisionAction: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '800',
  },
  decisionMeta: {
    color: '#4b5563',
    fontSize: 13,
    marginTop: 2,
  },
  decisionState: {
    color: '#065f46',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 6,
  },
  detailsBody: {
    borderColor: colors.divider,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 12,
  },
  proposalRow: {
    alignSelf: 'stretch',
    backgroundColor: '#f9fafb',
    borderColor: '#e5e7eb',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  proposalAction: {
    color: '#1a56db',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  previewBlock: {
    alignSelf: 'stretch',
    borderColor: '#e5e7eb',
    borderRadius: 10,
    borderStyle: 'dashed',
    borderWidth: 1,
    marginTop: 32,
    padding: 14,
  },
  previewHeading: {
    color: '#6b7280',
    fontSize: 11,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  previewHint: {
    color: '#9ca3af',
    fontSize: 11,
    marginBottom: 10,
    marginTop: 2,
    textAlign: 'center',
  },
  previewButton: {
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    marginTop: 6,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  previewButtonText: {
    color: '#374151',
    fontSize: 13,
    fontWeight: '600',
  },
  badge: {
    backgroundColor: '#e8f0fe',
    borderRadius: 999,
    color: '#1a56db',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 24,
  },
  card: {
    alignItems: 'center',
    borderColor: '#e5e7eb',
    borderRadius: 12,
    borderWidth: 1,
    padding: 20,
    width: '100%',
  },
  label: {
    color: '#6b7280',
    fontSize: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  walletLabel: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  address: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  fullAddress: {
    color: '#6b7280',
    fontFamily: 'monospace',
    fontSize: 11,
    marginBottom: 12,
    textAlign: 'center',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#1a56db',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 24,
    width: '100%',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondary: {
    backgroundColor: '#f3f4f6',
    borderColor: '#cbd5e1',
    borderWidth: 1,
  },
  // Etat appuye : retroaction visuelle distincte de l'etat disabled (opacite).
  secondaryPressed: {
    backgroundColor: '#e5e7eb',
  },
  // Entrees laterales : assistant de creation de vault et inbox locale.
  sideButton: {
    alignSelf: 'stretch',
    marginTop: 28,
  },
  secondaryText: {
    color: '#101317',
    fontSize: 16,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 12,
  },
  rpcBox: {
    alignItems: 'center',
    marginTop: 28,
  },
  rpcLine: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 2,
  },
  rpcValue: {
    fontWeight: '700',
  },
  rpcOnline: {
    color: '#047857',
  },
  rpcOffline: {
    color: '#b91c1c',
  },
  rpcDetail: {
    color: '#b91c1c',
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
  },
  msigBlock: {
    alignSelf: 'stretch',
    marginTop: 28,
  },
  msigHeading: {
    color: '#6b7280',
    fontSize: 12,
    marginBottom: 8,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  input: {
    borderColor: '#d1d5db',
    borderRadius: 10,
    borderWidth: 1,
    color: '#101317',
    fontSize: 13,
    marginBottom: 12,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  msigResult: {
    backgroundColor: '#f9fafb',
    borderColor: '#e5e7eb',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 16,
    padding: 14,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 12,
    textTransform: 'uppercase',
  },
  fieldValue: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
  memberLine: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 4,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 20,
    padding: 14,
    width: '100%',
  },
  errorText: {
    color: '#991b1b',
    fontSize: 14,
  },
  retry: {
    alignItems: 'center',
    marginTop: 12,
    paddingVertical: 8,
  },
  retryText: {
    color: '#1a56db',
    fontSize: 15,
    fontWeight: '600',
  },
  // Diagnostics MWA : valeurs exactes, jamais reformulées.
  diagnosticsTitle: {
    color: '#991b1b',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 8,
  },
  balanceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  balanceValue: {
    color: colors.text,
    flex: 1,
    fontSize: 40,
    fontWeight: '800',
    marginTop: 4,
  },
  balanceNote: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
  },
  diagnosticsText: {
    color: '#7f1d1d',
    fontSize: 12,
    marginTop: 4,
  },
  statusBarSpacer: {
    backgroundColor: '#ffffff',
    height: SAFE_TOP_PADDING.paddingTop,
  },
  // Surface unique d'apprentissage : un seul contenant cliquable, style
  // secondaire explicite (bordure + libelle bleu), pas d'imbrication.
  learnSurface: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 52,
    paddingHorizontal: 24,
  },
  learnSurfacePressed: {
    backgroundColor: colors.surface,
  },
  learnSurfaceText: {
    color: colors.mint,
    fontSize: 16,
    fontWeight: '600',
  },

  // --- UI V2 « Seeker style » ------------------------------------------------
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: spacing.lg,
  },
  // Selecteur de vault, en haut a gauche : `marginRight: 'auto'` le pousse a
  // GAUCHE, sans toucher au `justifyContent: 'flex-end'` qui garde le badge
  // Devnet a droite. Nom du vault actif (ou « Select a multisig ») + chevron.
  headerSelector: {
    alignItems: 'center',
    borderRadius: radii.pill,
    flexDirection: 'row',
    marginRight: 'auto',
    maxWidth: '70%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  headerSelectorName: {
    color: colors.text,
    flexShrink: 1,
    fontSize: typography.bodySmall,
    fontWeight: '700',
    marginRight: spacing.xs,
  },
  // Ecran d'attente pendant l'ouverture du wallet : plein ecran, fond NOIR
  // (demande explicite), les cartes centrees. C'est CE rendu qui reste fige
  // pendant que l'invite du wallet a le focus (Android ne redessine plus l'app).
  connectingSplash: {
    backgroundColor: '#000000',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // Hors connexion : le calque reste monte (pour que son bitmap reste decode a
  // la bonne taille) mais totalement invisible, et il ne capte aucun toucher
  // (`pointerEvents: 'none'` cote JSX).
  connectingSplashIdle: {
    opacity: 0,
  },
  // Les cartes sont centrees dans la partie HAUTE de l'ecran : la feuille
  // « Open with Wallet » d'Android occupe le bas et coupait l'eventail. Le
  // partage est PROPORTIONNEL (60 / 40), donc identique sur tout ecran, et il
  // n'ajoute aucun element hors flux. Pour monter ou descendre les cartes, il
  // suffit de deplacer ce rapport (ex. 65 / 35 les remonte).
  connectingSplashTop: {
    alignItems: 'center',
    flex: 60,
    justifyContent: 'center',
  },
  connectingSplashSheetSpace: {
    flex: 40,
  },
  // Les cartes en eventail, seules : aucun habillage autour.
  connectingSplashMark: {
    height: CONNECTING_MARK_DP,
    width: CONNECTING_MARK_DP,
  },
  // Filtres de l'onglet Proposals : pastilles. L'actif est BLANC a texte sombre,
  // comme la pastille de l'onglet actif de la barre du bas.
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  filterChip: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.button,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  filterChipActive: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  filterChipText: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
  filterChipTextActive: {
    color: colors.onLight,
  },
  brandMark: {
    alignSelf: 'center',
    marginBottom: spacing.lg,
    marginTop: spacing.lg,
  },
  heroTitle: {
    color: colors.text,
    fontSize: typography.screenTitle,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  heroTagline: {
    color: colors.textSecondary,
    fontSize: typography.body,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  valueList: {
    marginTop: spacing.xl,
  },
  // Espace supplementaire au-dessus du groupe du bouton principal de l'ecran
  // deconnecte (Connect wallet + note + Learn) : +24 dp, mesure sur l'echelle du
  // theme. Le groupe descend ensemble ; l'espacement interne (footerNote,
  // learnSurface) est inchange.
  connectWalletSpacer: {
    marginTop: spacing.xl,
  },
  footerNote: {
    color: colors.textMuted,
    fontSize: typography.caption,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  // Encart ROUGE (erreur wallet / propositions) : meme correction verticale
  // que `dialogWarning` — `alignItems: 'center'` (le glyphe ⚠, sans `lineHeight`,
  // a une boite de ligne plus haute que le texte ; en `flex-start`, defaut de la
  // primitive figee, le texte cale en haut laissait plus d'espace sous lui
  // qu'au-dessus). Le `marginTop` et les couleurs (tone error) restent inchanges.
  errorBoxV2: {
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  // Encart AMBRE de l'echec de chargement du vault : même marge que l'encart
  // d'erreur, mais le ton vient de la primitive `InfoBox tone="warning"` (tokens
  // `warningSoft` / `warning` du theme) — aucune couleur codee en dur.
  // `alignItems: 'flex-start'` : ce panneau porte un TITRE (1re ligne) PUIS un
  // corps (`vaultLoadMessage.title` + `.body`). Centrer verticalement contre tout
  // le bloc (`'center'`, comme avant) décrochait le glyphe ⚠ de son titre ; en
  // HAUT, le glyphe reste sur la PREMIÈRE ligne. Le corps est multi-lignes, donc
  // la hauteur de rangée vient du corps et aucun déséquilibre n'est réintroduit.
  loadWarningBox: {
    alignItems: 'flex-start',
    marginTop: spacing.lg,
  },
  retryTextV2: {
    color: colors.mint,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
  // « Disconnect this vault » : seule la COULEUR change (token danger du theme),
  // le reste du style vient de `retryTextV2`, non affaibli pour les autres usages.
  retryTextDanger: {
    color: colors.error,
  },
  devBlock: {
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderStyle: 'dashed',
    borderWidth: 1,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  devText: {
    color: colors.textMuted,
    fontSize: typography.micro,
    marginTop: 2,
  },
  homeBody: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
  },
  // Etat VIDE (aucun vault, champ de chargement FERME) : le contenu est recentre
  // dans la hauteur disponible, au lieu de rester colle en haut avec 60 % d'ecran
  // noir en dessous. Retour direct de Corentin sur capture.
  // JAMAIS applique quand le champ de chargement est ouvert : le champ reste
  // alors dans le flux normal, et son amenee dans la vue (mesure RÉELLE par
  // `measureInWindow`) reste exacte.
  homeBodyEmpty: {
    alignSelf: 'stretch',
    flex: 1,
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  vaultCard: {
    marginTop: spacing.sm,
  },
  vaultCardTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  vaultName: {
    color: colors.text,
    flexShrink: 1,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginRight: spacing.sm,
  },
  memberBadge: {
    backgroundColor: colors.successSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  memberBadgeText: {
    color: colors.success,
    fontSize: typography.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  vaultCopy: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    marginTop: spacing.sm,
  },
  vaultCopySmall: {
    color: colors.textMuted,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  actionTile: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    marginHorizontal: spacing.xs,
    minHeight: 84,
    paddingVertical: spacing.md,
  },
  actionTilePressed: {
    backgroundColor: colors.surface,
  },
  actionGlyph: {
    color: colors.mint,
    fontSize: 22,
  },
  actionLabel: {
    color: colors.text,
    fontSize: typography.secondary,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginTop: spacing.xl,
  },
  emptyNote: {
    color: colors.textMuted,
    fontSize: typography.bodySmall,
    marginTop: spacing.md,
  },
  todoCard: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  walletCard: {
    marginTop: spacing.md,
  },
  walletAddress: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: typography.body,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  copyFeedback: {
    color: colors.success,
    fontSize: typography.secondary,
    marginTop: spacing.sm,
  },
  secondaryStack: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  loaderBlock: {
    marginTop: spacing.md,
  },
  // Disposition cote a cote [champ + Paste] [Load] (largeur suffisante).
  loaderRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // Disposition compacte sur deux lignes (largeur etroite) : le champ prend
  // toute la largeur, Load multisig passe dessous en pleine largeur.
  loaderColumn: {
    width: '100%',
  },
  // Bloc texte du champ : occupe l'espace restant, ne deborde jamais (flexShrink).
  loaderField: {
    flex: 1,
    flexShrink: 1,
  },
  // Aligne le bouton Load sur la ZONE DE SAISIE, pas sur le haut du bloc.
  // AddressInput ajoute son propre `marginTop` (spacing.md = 12), puis la hauteur
  // de son libellé (~18 pour typography.secondary), puis le `marginTop` de son
  // champ (spacing.sm = 8). Soit 38. Vérifié par MESURE sur une capture réelle :
  // avec spacing.xxl (32) le bouton sortait 5,6 dp trop haut.
  loaderButtonSlot: {
    marginTop: 38,
  },
  manageBody: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  vaultAddressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  vaultAddressText: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontFamily: 'monospace',
    fontSize: typography.bodySmall,
  },
  inlineAction: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  // Lien « View all proposals » : simple action inline alignee a gauche.
  viewAllAction: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  inlineActionPressed: {
    backgroundColor: colors.surface,
  },
  inlineActionText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '700',
  },
  sectionRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  todoRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  todoRowPressed: {
    backgroundColor: colors.surfaceElevated,
  },
  todoIndex: {
    color: colors.mint,
    fontFamily: 'monospace',
    fontSize: typography.bodySmall,
    fontWeight: '700',
    marginRight: spacing.md,
  },
  todoBody: {
    flex: 1,
  },
  todoTitle: {
    color: colors.text,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
  todoMeta: {
    color: colors.textSecondary,
    fontSize: typography.secondary,
    marginTop: 2,
  },
  todoChevron: {
    color: colors.textMuted,
    fontSize: 22,
    marginLeft: spacing.sm,
  },
  walletRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  walletRowBody: {
    flex: 1,
  },

  // --- Navigation V2 : onglets Proposals / Activity / Account ---------------
  tabTitle: {
    color: colors.text,
    fontSize: typography.screenTitle,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  tabEmpty: {
    color: colors.textMuted,
    fontSize: typography.bodySmall,
    lineHeight: 21,
    marginTop: spacing.lg,
  },
  // Ligne wallet de l'onglet Account : compacte, sur une seule ligne.
  accountWallet: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.lg,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  accountWalletLabel: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  accountWalletAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: typography.bodySmall,
    marginTop: 2,
  },
  // Carte « Connected wallet » de l'onglet Account (étape 2).
  accountWalletCard: {
    marginTop: spacing.lg,
  },
  accountCardTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
    marginBottom: spacing.md,
  },
  accountWalletActions: {
    marginTop: spacing.md,
  },
  // Lignes « My multisigs » de l'onglet Account : mêmes informations que le
  // sélecteur de vault (nom, adresse abrégée, seuil si connu).
  accountMultisigRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  accountMultisigName: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  accountMultisigAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: typography.caption,
    marginTop: 2,
  },
  accountMultisigThreshold: {
    color: colors.mint,
    fontSize: typography.caption,
    fontWeight: '700',
    marginTop: 2,
  },
  // Menu « ⋯ » des lignes Account (actives : Rename / Archive ; archivees :
  // Remove from this device). Aucune couleur codée en dur : tout vient du thème.
  accountMenuTrigger: {
    alignItems: 'center',
    borderRadius: radii.pill,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  accountMenuGlyph: {
    color: colors.textSecondary,
    fontSize: 22,
    fontWeight: '800',
  },
  accountMenu: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
  },
  accountMenuItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  accountMenuItemText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  accountMenuItemDanger: {
    color: colors.error,
    fontSize: typography.body,
    fontWeight: '700',
  },
  // Section « Archived (N) » d'Account : même source que le sélecteur, rendue
  // SEULEMENT quand N > 0 (voir `archivedSectionLabel`).
  accountArchivedSection: {
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    marginTop: spacing.lg,
    paddingTop: spacing.sm,
  },
  accountArchivedHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    // Alignement : le BORD GAUCHE DU TEXTE de l'en-tete tombe sur celui des
    // lignes du bas (et des cartes de vaults), a spacing.lg + spacing.md = 28.
    // Le chevron (16 dp) + l'ecart (spacing.xs = 4) occupent 20 dp dans la
    // ligne : celle-ci doit donc commencer a 28 - 20 = 8 dp, soit un retrait
    // de spacing.sm en arriere du conteneur (spacing.lg = 16).
    marginLeft: -spacing.sm,
    marginTop: spacing.sm,
  },
  accountArchivedHeader: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    fontWeight: '800',
  },
  // Lignes informatives du BAS d'Account (Network / Learn / About / X).
  // Le retrait horizontal S'AJOUTE a celui du conteneur (spacing.lg) pour que
  // leur bord GAUCHE de texte coincide EXACTEMENT avec celui du texte des
  // cartes de vaults (`accountMultisigRow`, paddingHorizontal spacing.md) :
  // conteneur (16) + ici (12) = 28 dp des deux cotes, gauche comme droite.
  accountFooterLinks: {
    paddingHorizontal: spacing.md,
  },
  accountRestoreAction: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  accountRestoreText: {
    color: colors.mint,
    fontSize: typography.secondary,
    fontWeight: '800',
  },
  // Dialogues de confirmation (archivage / retrait / restauration / renommage).
  dialogBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialogCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.divider,
    borderRadius: radii.card,
    borderWidth: 1,
    maxWidth: 460,
    padding: spacing.lg,
    width: '100%',
  },
  dialogTitle: {
    color: colors.text,
    fontSize: typography.sectionTitle,
    fontWeight: '800',
  },
  dialogMessage: {
    color: colors.textSecondary,
    fontSize: typography.bodySmall,
    lineHeight: 21,
    marginTop: spacing.sm,
  },
  // Encart d'avertissement ambré de la boîte d'archivage : même correctif LOCAL
  // que NewProposalScreen.warningBox (la primitive partagée est figée par un
  // test, on corrige donc l'instance). `alignItems: 'center'` : le glyphe ⚠ a
  // une boîte de ligne plus haute que le texte (il n'hérite pas du `lineHeight`
  // de `InfoText`) ; en `flex-start` (défaut de la primitive) il gonflait la
  // rangée et le texte, calé en haut, laissait plus d'espace sous lui qu'au-
  // dessus. Centrer verticalement les enfants répartit ce résidu de façon
  // symétrique (haut = bas) et aligne le glyphe sur la ligne du message.
  // `padding: spacing.lg` : même air interne symétrique que l'encart validé.
  dialogWarning: {
    alignItems: 'center',
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  dialogInput: {
    backgroundColor: colors.surface,
    borderColor: colors.divider,
    borderRadius: radii.field,
    borderWidth: 1,
    color: colors.text,
    fontSize: typography.body,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dialogActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  dialogAction: {
    flex: 1,
  },
  // --- Ghost pill « Open wallet help » (écran de connexion, branche déconnectée)
  // Conteneur : centre la pilule, largeur au contenu (alignSelf), sous le CTA.
  walletHelpRow: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  // Ghost pill : pilule arrondie (mêmes rayons que les boutons), fond doux
  // (`surfaceElevated`), mint en texte, AUCUNE bordure et aucun fond vif.
  walletHelpPill: {
    alignSelf: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  walletHelpPillPressed: {
    backgroundColor: colors.surface,
  },
  walletHelpPillText: {
    color: colors.mint,
    fontSize: typography.bodySmall,
    fontWeight: '700',
  },
});