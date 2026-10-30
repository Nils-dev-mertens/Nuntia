/**
 * Conversation layer.
 *
 * `model.ts` is pure and dependency-free — the place to look for the rules.
 * `decision.ts` is the swappable AI seam. `repository.ts` is the only part that
 * touches the database.
 */

export type {
  BuildContext,
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  DoneMark,
} from './model.ts'

export {
  activeDone,
  activeImportanceOverride,
  activeStateOverride,
  buildConversation,
  cleanMessage,
  conversationId,
  deriveState,
  inferIntent,
  isSenderAddress,
  normaliseEmail,
  otherPartyOf,
  resolveReplyStyle,
  strippedReplyPrefix,
  toParticipant,
  unseenMessages,
} from './model.ts'
export type { ImportanceOverride, ReplyStyle, StateOverride } from './model.ts'

export { getLastOwnMessageStyle } from './repository.ts'
export {
  buildReplyDraftPrompt,
  NoReplyDrafter,
  replyDraftEligibility,
  REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
  sanitizeDraft,
} from './draft.ts'
export type {
  DraftEligibility,
  DraftSkipReason,
  ReplyDrafter,
  ReplyDraftMessage,
  ReplyDraftRequest,
} from './draft.ts'

export { buildGoalReviewPrompt, parseGoalVerdict } from './goal.ts'
export type { GoalReviewer, GoalReviewRequest, GoalVerdict } from './goal.ts'

export type {
  Decision,
  DecisionInput,
  DecisionModel,
  DecisionPipeline,
  ModelVerdict,
  RuleClassifier,
  RuleFacts,
  TopicGenerator,
} from './decision.ts'
export {
  applyDecision,
  decideConversation,
  defaultDecisionPipeline,
  HeuristicRuleClassifier,
  NoTopicGenerator,
  PlaceholderDecisionModel,
} from './decision.ts'

export {
  backfillDerivedFields,
  countByState,
  deleteConversation,
  DERIVED_VERSION,
  getByThreadIds,
  getConversation,
  getConversationByThreadId,
  getConversationClusterByThreadId,
  getStateOverride,
  getStoredAttachment,
  getStoredUserFields,
  listByState,
  listConversations,
  listIgnoredSenders,
  listIncomingSenders,
  markConversationSeen,
  recordDecision,
  recordSenderSignal,
  reparseStoredMessages,
  saveConversation,
  getParsingProfileContext,
  saveAccountParsingDefaults,
  saveParsingProfile,
  setAttachmentLocalPath,
  setConversationDetails,
  setConversationDone,
  setGoal,
  setReplyableForSender,
  setSenderReplyable,
  listUnreplyableSenders,
  setImportanceOverride,
  setStateOverride,
  setTopic,
} from './repository.ts'
export type {
  IncomingSender,
  SenderSignal,
  StoredUserFields,
} from './repository.ts'
export type {
  ParsingProfileContext,
  SenderProfileSettings,
  StoredAttachment,
} from './repository.ts'
export type { ParsingPreferences } from './model.ts'

export {
  mergeAccountConversations,
  partitionByState,
  relationForRoles,
  relationOf,
  replyAccountsFor,
} from './merge.ts'
export type {
  AccountConversation,
  ConnectedAccount,
  MergedConversation,
  MergeRelation,
} from './merge.ts'
