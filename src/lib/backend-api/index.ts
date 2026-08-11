import "server-only";

export { backendApi, backendApiRequest } from "./client";
export type { HttpMethod, RequestOptions } from "./client";
export {
  BackendApiError,
  BackendNetworkError,
  type BackendErrorPayload,
} from "./errors";
export { creatorsApi } from "./creators";
export type {
  CreatorDealStatus,
  StreamSessionStatus,
  PendingConversionStatus,
  CreatorListItem,
  CreatorDealResponse,
  CreatorSessionResponse,
  PendingConversionResponse,
  CreateDealInput,
  UpdateDealInput,
  CreatorSocialPlatform,
  CreatorSocialStatus,
  CreatorSocialResponse,
  AdminCreatorSocial,
} from "./creators";
export { multiplierDealsApi } from "./multiplier-deals";
export type {
  MultiplierDealStatus,
  MultiplierDealResponse,
  MultiplierFlagEntry,
  CreateMultiplierDealInput,
  UpdateMultiplierDealInput,
  ApproveMultiplierDealInput,
  RejectMultiplierDealInput,
  FlagMultiplierDealInput,
} from "./multiplier-deals";
export { pnlDealsApi } from "./pnl-deals";
export type {
  PnlDealStatus,
  PnlDealFunding,
  PnlDealResponse,
  CreatePnlDealInput,
} from "./pnl-deals";
export { upgraderApi } from "./upgrader";
export type {
  UpgraderOutputCard,
  UpgraderOutputColor,
  UpdateUpgraderOutputBody,
  AddUpgraderOutputsResult,
} from "./upgrader";
export { challengesApi } from "./challenges";
export type {
  ChallengeGameType,
  ChallengeType,
  ChallengeStatus,
  ChallengeRequirementKind,
  ChallengePercentOp,
  ChallengeRequirement,
  Challenge,
  ChallengeWithRequirements,
  CreateChallengeRequirementInput,
  CreateChallengeInput,
  UpdateChallengeInput,
} from "./challenges";
