import type { ProviderConfig, ResolvedConfig } from "../config.js";
import { resolveAuthSecret } from "../config.js";
import type { Provider } from "./base.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";

/** Lazily instantiated provider registry keyed by config provider id. */
export class ProviderRegistry {
  private cache = new Map<string, Provider>();

  constructor(private readonly cfg: ResolvedConfig) {}

  /** Create (without caching) — used by tests and diagnostics. */
  static create(providerId: string, cfg: ResolvedConfig): Provider {
    const pc: ProviderConfig | undefined = cfg.providers[providerId];
    if (!pc) throw new Error(`unknown provider: ${providerId}`);
    const secret = resolveAuthSecret(pc.auth);
    switch (pc.kind) {
      case "mock":
        return new MockProvider(pc, providerId);
      case "anthropic":
        return new AnthropicProvider(pc, secret, providerId);
      case "openai_compatible":
        return new OpenAiCompatibleProvider(pc, providerId, secret);
    }
  }

  get(providerId: string): Provider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const provider = ProviderRegistry.create(providerId, this.cfg);
    this.cache.set(providerId, provider);
    return provider;
  }

  configuredIds(): string[] {
    return Object.keys(this.cfg.providers);
  }
}

export class UnsupportedProviderKindError extends Error {
  constructor(kind: string, providerId: string) {
    super(`provider "${providerId}" has unsupported kind: ${kind}`);
    this.name = "UnsupportedProviderKindError";
  }
}
