import { AgentClient } from "@adcp/client";
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

    let properties: PropertyInfo[] = [];
    let error: string | undefined;

    try {
      // Create agent client with the new API
      const agentConfig = {
        id: agent.name,
        name: agent.name,
        agent_uri: agent.url,
        protocol: (agent.protocol || "mcp") as "mcp" | "a2a",
      };
      const client = new AgentClient(agentConfig);
      const result = await client.executeTask("list_authorized_properties", {});

      if ((result.status === "completed" || result.success) && result.data) {
        const response = result.data;

        // Handle different response formats:
        // 1. Array of properties directly
        if (Array.isArray(response)) {
          properties = response;
        }
        // 2. Object with properties array
        else if (response?.properties && Array.isArray(response.properties)) {
          properties = response.properties;
        }
        // 3. Object with publisher_domains (convert to properties format)
        else if (response?.publisher_domains && Array.isArray(response.publisher_domains)) {
          properties = response.publisher_domains.map((domain: string) => ({
            identifier: domain,
            domain: domain,
            type: "domain",
            tags: response.primary_channels ? [response.primary_channels] : undefined,
            country: response.primary_countries,
            description: response.portfolio_description,
          }));
        }
      } else if (result.status === "error" || !result.success) {
        error = `Agent returned error: ${result.error || "Unknown error"}`;
      }
    } catch (toolError: any) {
      error = `Agent does not support list_authorized_properties: ${toolError.message}`;
    }

    const profile: AgentPropertiesProfile = {
      agent_url: agent.url,
      protocol: agent.protocol || "mcp",
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
