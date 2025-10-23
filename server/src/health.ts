import type { Agent, AgentHealth, AgentStats } from "./types.js";
import { Cache } from "./cache.js";
import { createMCPClient, createA2AClient, getPropertyIndex } from "@adcp/client";

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

    // Try MCP first (most common for AdCP agents)
    const mcpHealth = await this.tryMCP(agent, startTime);
    if (mcpHealth.online) return mcpHealth;

    // If MCP fails, try A2A
    const a2aHealth = await this.tryA2A(agent, startTime);
    return a2aHealth;
  }

  private async tryMCP(agent: Agent, startTime: number): Promise<AgentHealth> {
    // Try both the provided endpoint and /mcp fallback
    const endpoints = [
      agent.mcp_endpoint,
      agent.url.endsWith("/mcp") ? null : `${agent.url.replace(/\/$/, "")}/mcp`,
    ].filter(Boolean) as string[];

    for (const endpoint of endpoints) {
      try {
        const client = createMCPClient(endpoint);

        // Try to list tools - this is a standard MCP operation
        await client.callTool("list_tools", {});

        const responseTime = Date.now() - startTime;

        // If we got here, MCP is working
        // Now try to get actual tool count
        try {
          const toolsResponse = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "tools/list",
              id: 1,
            }),
            signal: AbortSignal.timeout(5000),
          });

          if (toolsResponse.ok) {
            const data = (await toolsResponse.json()) as any;
            const toolsCount = data.result?.tools?.length || 0;

            return {
              online: true,
              checked_at: new Date().toISOString(),
              response_time_ms: responseTime,
              tools_count: toolsCount,
              resources_count: 0,
            };
          }
        } catch {
          // Tool listing failed but connection worked
        }

        return {
          online: true,
          checked_at: new Date().toISOString(),
          response_time_ms: responseTime,
        };
      } catch (error) {
        // Try next endpoint
        continue;
      }
    }

    return {
      online: false,
      checked_at: new Date().toISOString(),
      error: "MCP connection failed",
    };
  }

  private async tryA2A(agent: Agent, startTime: number): Promise<AgentHealth> {
    try {
      // Check for A2A agent card at /.well-known/agent.json
      const agentCardUrl = `${agent.url.replace(/\/$/, "")}/.well-known/agent.json`;
      const response = await fetch(agentCardUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          online: false,
          checked_at: new Date().toISOString(),
          error: `A2A agent card not found (HTTP ${response.status})`,
        };
      }

      const agentCard = (await response.json()) as any;
      const responseTime = Date.now() - startTime;

      // Agent card exists, agent supports A2A
      const toolsCount = agentCard.tools?.length || agentCard.capabilities?.length || 0;

      return {
        online: true,
        checked_at: new Date().toISOString(),
        response_time_ms: responseTime,
        tools_count: toolsCount,
      };
    } catch (error) {
      return {
        online: false,
        checked_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "A2A connection failed",
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
        // Use PropertyIndex if available (populated by crawler)
        const index = getPropertyIndex();
        const auth = index.getAgentAuthorizations(agent.url);

        if (auth && auth.properties.length > 0) {
          stats.property_count = auth.properties.length;
          stats.publishers = auth.publisher_domains;
          stats.publisher_count = auth.publisher_domains.length;
        }
      } else if (agent.type === "creative") {
        // For creative agents, get format count from list_creative_formats tool
        try {
          const client = createMCPClient(agent.mcp_endpoint);
          const result = await client.callTool("list_creative_formats", {});

          if (result?.formats && Array.isArray(result.formats)) {
            stats.creative_formats = result.formats.length;
          }
        } catch {
          // Creative format listing failed
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
