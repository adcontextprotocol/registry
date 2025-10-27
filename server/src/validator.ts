import type { AdAgentsJson, ValidationResult } from "./types.js";
import { Cache } from "./cache.js";

export class AgentValidator {
  private cache: Cache<ValidationResult>;

  constructor(cacheTtlMinutes: number = 15) {
    this.cache = new Cache<ValidationResult>(cacheTtlMinutes);
  }

  async validate(domain: string, agentUrl: string): Promise<ValidationResult> {
    const cacheKey = `${domain}:${agentUrl}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.fetchAndValidate(domain, agentUrl);
    this.cache.set(cacheKey, result);
    return result;
  }

  private async fetchAndValidate(
    domain: string,
    agentUrl: string
  ): Promise<ValidationResult> {
    const normalizedDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const adagentsUrl = `https://${normalizedDomain}/.well-known/adagents.json`;

    try {
      const response = await fetch(adagentsUrl, {
        headers: { "User-Agent": "AdCP-Registry/1.0" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: `HTTP ${response.status}`,
        };
      }

      const data = await response.json() as AdAgentsJson;

      const normalizedAgentUrl = agentUrl.replace(/\/$/, "");
      const isAuthorized = data.authorized_agents.some(
        (agent) => agent.url.replace(/\/$/, "") === normalizedAgentUrl
      );

      return {
        authorized: isAuthorized,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        source: adagentsUrl,
      };
    } catch (error) {
      return {
        authorized: false,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  getCacheStats(): { size: number } {
    return { size: this.cache.size() };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
