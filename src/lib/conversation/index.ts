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
} from './model.ts'

export {
  buildConversation,
  cleanMessage,
  conversationId,
  deriveState,
  inferIntent,
  strippedReplyPrefix,
  toParticipant,
} from './model.ts'

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
  listByState,
  listConversations,
  recordDecision,
  reparseStoredMessages,
  saveConversation,
  getParsingProfileContext,
  saveParsingProfile,
  setConversationDetails,
  setGoal,
  setTopic,
} from './repository.ts'
export type {
  ParsingProfileContext,
  SenderProfileSettings,
} from './repository.ts'
export type { ParsingPreferences } from './model.ts'

export {
  mergeAccountConversations,
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
