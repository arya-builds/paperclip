import { describe, expect, it } from "vitest";
import {
  evaluateBedrockCredentials,
  preflightBedrockCredentials,
} from "./bedrock-preflight.js";

const NOW = Date.UTC(2026, 5, 28, 12, 0, 0); // fixed clock; no Date.now() in tests

describe("evaluateBedrockCredentials", () => {
  it("flags missing credentials when the resolver returns null", () => {
    const result = evaluateBedrockCredentials({ credentials: null }, NOW);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_missing");
    expect(result.errorMessage).toContain("AWS_PROFILE");
  });

  it("flags missing credentials when accessKeyId is empty", () => {
    const result = evaluateBedrockCredentials({ credentials: { accessKeyId: "" } }, NOW);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_missing");
  });

  it("treats a resolver error as missing credentials and surfaces the reason", () => {
    const result = evaluateBedrockCredentials(
      { error: new Error("Could not load credentials from any providers") },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_missing");
    expect(result.errorMessage).toContain("Could not load credentials");
  });

  it("flags expired temporary credentials (expiration in the past)", () => {
    const result = evaluateBedrockCredentials(
      { credentials: { accessKeyId: "ASIAEXAMPLE", expiration: new Date(NOW - 60_000) } },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_expired");
    expect(result.errorMessage).toContain("expired");
  });

  it("flags credentials expiring within the refresh skew window", () => {
    const result = evaluateBedrockCredentials(
      { credentials: { accessKeyId: "ASIAEXAMPLE", expiration: new Date(NOW + 60_000) } },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_expired");
  });

  it("accepts temporary credentials with a comfortable expiration", () => {
    const result = evaluateBedrockCredentials(
      { credentials: { accessKeyId: "ASIAEXAMPLE", expiration: new Date(NOW + 60 * 60_000) } },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("accepts static credentials with no expiration metadata", () => {
    const result = evaluateBedrockCredentials({ credentials: { accessKeyId: "AKIAEXAMPLE" } }, NOW);
    expect(result.ok).toBe(true);
  });

  it("never includes secret values in the error message", () => {
    const result = evaluateBedrockCredentials(
      { credentials: { accessKeyId: "ASIASECRETKEY", expiration: new Date(NOW - 1) } },
      NOW,
    );
    expect(result.errorMessage).not.toContain("ASIASECRETKEY");
  });
});

describe("preflightBedrockCredentials", () => {
  it("classifies an injected expired credential without touching the AWS SDK", async () => {
    const result = await preflightBedrockCredentials({
      now: NOW,
      resolveCredentials: async () => ({
        accessKeyId: "ASIAEXAMPLE",
        expiration: new Date(NOW - 1_000),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_expired");
  });

  it("classifies an injected missing credential", async () => {
    const result = await preflightBedrockCredentials({
      now: NOW,
      resolveCredentials: async () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_missing");
  });

  it("treats a thrown resolver error as missing credentials", async () => {
    const result = await preflightBedrockCredentials({
      now: NOW,
      resolveCredentials: async () => {
        throw new Error("ExpiredToken: The security token included in the request is expired");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("claude_bedrock_credentials_missing");
    expect(result.errorMessage).toContain("ExpiredToken");
  });

  it("passes through valid credentials", async () => {
    const result = await preflightBedrockCredentials({
      now: NOW,
      resolveCredentials: async () => ({ accessKeyId: "AKIAEXAMPLE" }),
    });
    expect(result.ok).toBe(true);
  });
});
