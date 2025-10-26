import { createMCPClient, createA2AClient } from "@adcp/client";
import type { Agent } from "./types.js";

export interface PropertyInfo {
  identifier?: string;
  domain?: string;
  type?: string;
  tags?: string[];
  country?: string;
  description?: string;
}

export interface AgentPropertiesProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  properties: PropertyInfo[];
  last_fetched: string;
  error?: string;
}

export class PropertiesService {
  private cache: Map<string, AgentPropertiesProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  async getPropertiesForAgent(agent: Agent): Promise<AgentPropertiesProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_fetched).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    const protocol = agent.protocol || "mcp";
    let properties: PropertyInfo[] = [];
    let error: string | undefined;

    try {
      if (protocol === "a2a") {
        const client = createA2AClient(agent.url);
        const response = await client.callTool("list_authorized_properties", {});

        // Extract properties from A2A response
        const artifact = response?.result?.artifacts?.[0];
        if (artifact?.parts?.[0]?.data?.properties) {
          properties = artifact.parts[0].data.properties;
        }
      } else {
        const client = createMCPClient(agent.url);
        const response = await client.callTool("list_authorized_properties", {});

        // MCP response should have properties in the result
        if (response?.properties) {
          properties = response.properties;
        } else if (Array.isArray(response)) {
          properties = response;
        }
      }
    } catch (toolError: any) {
      error = `Agent does not support list_authorized_properties: ${toolError.message}`;
    }

    const profile: AgentPropertiesProfile = {
      agent_url: agent.url,
      protocol,
      properties,
      last_fetched: new Date().toISOString(),
      error,
    };

    this.cache.set(agent.url, profile);
    return profile;
  }

  async enrichAgentsWithProperties(agents: Agent[]): Promise<Map<string, AgentPropertiesProfile>> {
    const profiles = new Map<string, AgentPropertiesProfile>();

    await Promise.all(
      agents.map(async (agent) => {
        const profile = await this.getPropertiesForAgent(agent);
        profiles.set(agent.url, profile);
      })
    );

    return profiles;
  }

  getPropertiesProfile(agentUrl: string): AgentPropertiesProfile | undefined {
    return this.cache.get(agentUrl);
  }

  getAllPropertiesProfiles(): AgentPropertiesProfile[] {
    return Array.from(this.cache.values());
  }
}
