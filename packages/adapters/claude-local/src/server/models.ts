import type {
  AdapterEnvironmentCheck,
  AdapterModel,
  AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS, modelProfiles as STATIC_MODEL_PROFILES } from "../index.js";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

/**
 * Bedrock-native id for the `cheap` model profile. The profile preserves a
 * Sonnet "lower-cost lane" semantically, so under Bedrock it resolves to the
 * Bedrock Sonnet 4.5 id. Sourced from BEDROCK_MODELS so the profile id and the
 * validation list can never drift apart.
 */
export const BEDROCK_CHEAP_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v2:0";

export function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return isBedrockEnv() ? BEDROCK_MODELS : DIRECT_MODELS;
}

/**
 * Resolve the model profiles for the active auth mode.
 *
 * The static `modelProfiles` export hard-codes an Anthropic-API short id
 * (`claude-sonnet-4-6`) for the `cheap` profile. That id is invalid on Bedrock:
 * passing it as `--model` returns a 400, and even when the execute-time guard
 * strips it the CLI falls back to its own short-id default, which also 400s. So
 * under Bedrock we rewrite the `cheap` profile to a Bedrock-native id. Off
 * Bedrock the static (direct-Anthropic) profiles are already valid and pass
 * through unchanged. Wired into the registry as `listModelProfiles`, which the
 * server prefers over the static export. (MAS-221)
 */
export async function listClaudeModelProfiles(): Promise<AdapterModelProfileDefinition[]> {
  if (!isBedrockEnv()) return STATIC_MODEL_PROFILES;
  return STATIC_MODEL_PROFILES.map((profile) =>
    profile.key === "cheap"
      ? {
          ...profile,
          adapterConfig: { ...profile.adapterConfig, model: BEDROCK_CHEAP_MODEL_ID },
        }
      : profile,
  );
}

/** True when `model` appears in the model list valid for the active auth mode. */
export function isKnownModelId(model: string, available: AdapterModel[]): boolean {
  return available.some((entry) => entry.id === model);
}

/**
 * Validate every adapter-owned model profile's resolved model id against the
 * active model list, surfacing an invalid id at config-load as a typed
 * `AdapterEnvironmentCheck` (level "error") instead of a cryptic mid-run 400.
 *
 * Scope is intentionally limited to adapter-owned profile models — the auth-mode
 * model lists are not exhaustive of every deployed model, so validating
 * arbitrary user-configured `config.model` would produce false positives. The
 * profile ids, by contrast, are fully controlled here and must stay valid.
 */
export async function validateModelProfileModels(opts?: {
  profiles?: AdapterModelProfileDefinition[];
  available?: AdapterModel[];
}): Promise<AdapterEnvironmentCheck[]> {
  const bedrock = isBedrockEnv();
  const available = opts?.available ?? (await listClaudeModels());
  const profiles = opts?.profiles ?? (await listClaudeModelProfiles());
  const checks: AdapterEnvironmentCheck[] = [];
  for (const profile of profiles) {
    const model = profile.adapterConfig?.model;
    if (typeof model !== "string" || model.trim().length === 0) continue;
    if (isKnownModelId(model, available)) continue;
    checks.push({
      code: "claude_model_profile_invalid",
      level: "error",
      message: `Model profile "${profile.key}" resolves to model id "${model}", which is not valid for the active ${bedrock ? "Bedrock" : "Anthropic"} auth mode.`,
      detail: `Valid ids: ${available.map((entry) => entry.id).join(", ")}`,
      hint: bedrock
        ? "On Bedrock, profile models must be region-qualified ids (e.g. us.anthropic.*). Update the profile to a Bedrock-native id."
        : "Update the profile to a valid Anthropic model id.",
    });
  }
  return checks;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
