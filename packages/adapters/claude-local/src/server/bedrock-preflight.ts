// Fail-fast AWS credential pre-flight for the Bedrock auth path.
//
// claude_local runs Claude on Bedrock (CLAUDE_CODE_USE_BEDROCK=1) and inherits
// the host AWS SDK default credential chain. When those credentials are absent
// or expired the failure used to surface as a cryptic mid-run STS 403
// (GetCallerIdentity ExpiredToken) — see MAS-148. This module validates the
// resolved credentials before the Claude CLI launches so the failure is a clear,
// typed adapter error at execution start instead.
//
// The credential resolver is injectable so unit tests never touch the AWS SDK
// and a future live-STS probe can drop in without changing call sites.

/** Minimal shape of credentials returned by the AWS SDK default provider chain. */
export interface ResolvedAwsCredentials {
  accessKeyId?: string;
  /** Present for temporary credentials (SSO / credential_process / STS). */
  expiration?: Date;
}

export type AwsCredentialResolver = () => Promise<ResolvedAwsCredentials | null | undefined>;

export type BedrockCredentialErrorCode =
  | "claude_bedrock_credentials_expired"
  | "claude_bedrock_credentials_missing";

export interface BedrockCredentialPreflightResult {
  ok: boolean;
  errorCode?: BedrockCredentialErrorCode;
  errorMessage?: string;
}

// Treat credentials that expire within this window as already expired, matching
// the AWS SDK's own refresh skew. Avoids racing an expiry mid-run.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const REFRESH_HINT =
  "Refresh AWS credentials or set AWS_PROFILE to an auto-refreshing credential_process " +
  "profile (e.g. claude-code-DO-NOT-DELETE) before launching the Bedrock-backed agent.";

/**
 * Pure classification of a credential-resolution outcome. No I/O, no clock of
 * its own — the caller passes `now` so both branches are deterministically
 * unit-testable. Never includes secret values in the returned message.
 */
export function evaluateBedrockCredentials(
  outcome: { credentials?: ResolvedAwsCredentials | null; error?: unknown },
  now: number,
): BedrockCredentialPreflightResult {
  if (outcome.error !== undefined) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      ok: false,
      errorCode: "claude_bedrock_credentials_missing",
      errorMessage: `Bedrock pre-flight could not resolve AWS credentials: ${reason}. ${REFRESH_HINT}`,
    };
  }

  const credentials = outcome.credentials;
  if (!credentials || typeof credentials.accessKeyId !== "string" || credentials.accessKeyId.length === 0) {
    return {
      ok: false,
      errorCode: "claude_bedrock_credentials_missing",
      errorMessage: `Bedrock pre-flight found no AWS credentials in the default provider chain. ${REFRESH_HINT}`,
    };
  }

  // Temporary credentials advertise an expiration; static keys do not, in which
  // case resolution alone cannot prove freshness and we let execution proceed.
  if (credentials.expiration instanceof Date) {
    const expiresAtMs = credentials.expiration.getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs - now <= EXPIRY_SKEW_MS) {
      return {
        ok: false,
        errorCode: "claude_bedrock_credentials_expired",
        errorMessage:
          `Bedrock AWS credentials are expired or expiring (expiration ${credentials.expiration.toISOString()}). ` +
          REFRESH_HINT,
      };
    }
  }

  return { ok: true };
}

/**
 * Resolve credentials via the AWS SDK default provider chain. Imported lazily so
 * the adapter only pulls in the SDK on the Bedrock path.
 */
async function defaultResolveAwsCredentials(): Promise<ResolvedAwsCredentials | null | undefined> {
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
  return defaultProvider()();
}

/**
 * Run the Bedrock credential pre-flight. Resolves credentials (injectable for
 * tests) and classifies them. If the SDK itself cannot be loaded — an infra/
 * tooling problem rather than a credential problem — this fails open with `ok`
 * so we never block every Bedrock run on our own checker being unavailable; the
 * mid-run 403 (if any) remains the backstop.
 */
export async function preflightBedrockCredentials(opts?: {
  resolveCredentials?: AwsCredentialResolver;
  now?: number;
}): Promise<BedrockCredentialPreflightResult> {
  const resolve = opts?.resolveCredentials ?? defaultResolveAwsCredentials;
  const now = opts?.now ?? Date.now();
  let credentials: ResolvedAwsCredentials | null | undefined;
  try {
    credentials = await resolve();
  } catch (error) {
    return evaluateBedrockCredentials({ error }, now);
  }
  return evaluateBedrockCredentials({ credentials }, now);
}
