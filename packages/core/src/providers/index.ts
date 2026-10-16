import type { ModelInfo, Usage } from "@familiar/protocol";
import type { ProviderConfig, ResolvedConfig } from "../config.js";
import { resolveAuthSecret } from "../config.js";
import type { Provider } from "./base.js";
import { ProviderError, type ProviderChunk, type ChatParams, type ChatResult } from "./base.js";
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

  /**
   * Provider for chat, including the fallback chain (M2):
   * if `cfg.fallback` is set, returns a FallbackProvider wrapping
   * [primary, ...fallbacks] resolved from "provider" or "provider/model".
   */
  get(providerId: string): Provider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const chain = this.buildChain(providerId);
    const provider =
      chain.length > 1 ? new FallbackProvider(chain) : chain[0]?.provider ?? ProviderRegistry.create(providerId, this.cfg);
    this.cache.set(providerId, provider);
    return provider;
  }

  /** Primary provider only (models.list etc.). */
  getPrimary(providerId: string): Provider {
    const key = `${providerId}::primary`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const provider = ProviderRegistry.create(providerId, this.cfg);
    this.cache.set(key, provider);
    return provider;
  }

  private buildChain(providerId: string): { id: string; model?: string; provider: Provider }[] {
    if (!this.cfg.providers[providerId]) throw new Error(`unknown provider: ${providerId}`);
    const links: { id: string; model?: string; provider: Provider }[] = [
      { id: providerId, provider: ProviderRegistry.create(providerId, this.cfg) },
    ];
    for (const entry of this.cfg.fallback ?? []) {
      const sep = entry.indexOf("/");
      const fProvider = sep === -1 ? entry : entry.slice(0, sep);
      const fModel = sep === -1 ? undefined : entry.slice(sep + 1);
      if (!this.cfg.providers[fProvider]) continue; // unknown fallback entries are skipped
      if (fProvider === providerId && fModel === undefined) continue; // identity entry is pointless
      try {
        links.push({
          id: fProvider,
          model: fModel ?? this.cfg.providers[fProvider]?.default_model,
          provider: ProviderRegistry.create(fProvider, this.cfg),
        });
      } catch {
        // never let a broken fallback break the primary path
        continue;
      }
    }
    return links;
  }

  configuredIds(): string[] {
    return Object.keys(this.cfg.providers);
  }
}

/**
 * Tries providers in order. Fail-over happens only when the failure occurs
 * BEFORE any chunk was streamed (avoids duplicated partial output).
 */
export class FallbackProvider implements Provider {
  readonly id: string;

  constructor(private readonly chain: { id: string; model?: string; provider: Provider }[]) {
    this.id = chain[0]?.id ?? "fallback";
  }

  async chat(params: ChatParams, onChunk: (c: ProviderChunk) => void): Promise<ChatResult> {
    let lastError: unknown;
    for (const link of this.chain) {
      let chunks = 0;
      const wrapped = (chunk: ProviderChunk): void => {
        chunks += 1;
        onChunk(chunk);
      };
      try {
        const linkParams: ChatParams = link.model ? { ...params, model: link.model } : params;
        return await link.provider.chat(linkParams, wrapped);
      } catch (err) {
        if (chunks > 0) throw err; // mid-stream: do not restart somewhere else
        lastError = err;
        continue;
      }
    }
    if (lastError instanceof ProviderError) throw lastError;
    throw new ProviderError(
      `all providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      undefined,
      this.id,
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    const primary = this.chain[0]?.provider;
    if (!primary) return [];
    return primary.listModels();
  }
}

export class UnsupportedProviderKindError extends Error {
  constructor(kind: string, providerId: string) {
    super(`provider "${providerId}" has unsupported kind: ${kind}`);
    this.name = "UnsupportedProviderKindError";
  }
}

export type { Usage };
