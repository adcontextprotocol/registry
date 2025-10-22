import type { Agent, AgentHealth, AgentStats } from "./types.js";
import { Cache } from "./cache.js";

interface MCPListToolsResponse {
  tools?: Array<{ name: string }>;
}

interface MCPListResourcesResponse {
  resources?: Array<{ uri: string }>;
}

export class HealthChecker {
  private healthCache: Cache<AgentHealth>;
  private statsCache: Cache<AgentStats>;

  constructor(cacheTtlMinutes: number = 15) {
    this.healthCache = new Cache<AgentHealth>(cacheTtlMinutes);
    this.statsCache = new Cache<AgentStats>(cacheTtlMinutes);
  }

  async checkHealth(agent: Agent): Promise<AgentHealth> {
    const cached = this.healthCache.get(agent.url);
    if (cached) return cached;

    const health = await this.performHealthCheck(agent);
    this.healthCache.set(agent.url, health);
    return health;
  }

  private async performHealthCheck(agent: Agent): Promise<AgentHealth> {
    const startTime = Date.now();

    try {
      // Try to call list_tools via MCP over HTTP
      const response = await fetch(agent.mcp_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          online: false,
          checked_at: new Date().toISOString(),
          error: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as MCPListToolsResponse;
      const toolsCount = data.tools?.length || 0;

      // Try to get resources count
      let resourcesCount = 0;
      try {
        const resourcesResponse = await fetch(agent.mcp_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "resources/list",
            id: 2,
          }),
          signal: AbortSignal.timeout(3000),
        });

        if (resourcesResponse.ok) {
          const resourcesData =
            (await resourcesResponse.json()) as MCPListResourcesResponse;
          resourcesCount = resourcesData.resources?.length || 0;
        }
      } catch {
        // Resources endpoint might not exist, that's ok
      }

      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: responseTime,
        tools_count: toolsCount,
        resources_count: resourcesCount,
      };
    } catch (error) {
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getStats(agent: Agent): Promise<AgentStats> {
    const cached = this.statsCache.get(agent.url);
    if (cached) return cached;

    const stats = await this.fetchStats(agent);
    this.statsCache.set(agent.url, stats);
    return stats;
  }

  private async fetchStats(agent: Agent): Promise<AgentStats> {
    const stats: AgentStats = {};

    try {
      if (agent.type === "sales") {
        // For sales agents, fetch their adagents.json to get publisher list
        const adagentsUrl = `${agent.url}/.well-known/adagents.json`;
        const response = await fetch(adagentsUrl, {
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json() as { represents?: string[] };
          if (data.represents && Array.isArray(data.represents)) {
            stats.publishers = data.represents;
            stats.publisher_count = data.represents.length;
          }
        }
      } else if (agent.type === "creative") {
        // For creative agents, try to get creative formats from resources
        const response = await fetch(agent.mcp_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "resources/list",
            id: 1,
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = (await response.json()) as MCPListResourcesResponse;
          // Count resources that look like creative formats
          const formatResources = data.resources?.filter((r) =>
            r.uri.includes("format")
          );
          stats.creative_formats = formatResources?.length || 0;
        }
      }
    } catch {
      // Stats are optional, failure is ok
    }

    return stats;
  }

  clearCache(): void {
    this.healthCache.clear();
    this.statsCache.clear();
  }
}
