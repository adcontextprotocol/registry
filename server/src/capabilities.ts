import { createMCPClient, createA2AClient } from "@adcp/client";
import type { Agent } from "./types.js";

export interface ToolCapability {
  name: string;
  description: string;
  input_schema: any;
  verified_at: string;
}

export interface StandardOperations {
  can_search_inventory: boolean;
  can_get_availability: boolean;
  can_reserve_inventory: boolean;
  can_get_pricing: boolean;
  can_create_order: boolean;
  can_list_properties: boolean;
}

export interface CreativeCapabilities {
  formats_supported: string[];
  can_generate: boolean;
  can_validate: boolean;
  can_preview: boolean;
}

export interface SignalsCapabilities {
  audience_types: string[];
  can_match: boolean;
  can_activate: boolean;
  can_get_signals: boolean;
}

export interface AgentCapabilityProfile {
  agent_url: string;
  protocol: "mcp" | "a2a";
  discovered_tools: ToolCapability[];
  standard_operations?: StandardOperations;
  creative_capabilities?: CreativeCapabilities;
  signals_capabilities?: SignalsCapabilities;
  last_discovered: string;
  discovery_error?: string;
}

export class CapabilityDiscovery {
  private cache: Map<string, AgentCapabilityProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  async discoverCapabilities(agent: Agent): Promise<AgentCapabilityProfile> {
    const cached = this.cache.get(agent.url);
    if (cached && Date.now() - new Date(cached.last_discovered).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    try {
      const protocol = agent.protocol || "mcp";
      const tools = await this.discoverTools(agent.url, protocol);

      const profile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol,
        discovered_tools: tools,
        last_discovered: new Date().toISOString(),
      };

      // Analyze tools to determine standard operations
      if (agent.type === "sales") {
        profile.standard_operations = this.analyzeSalesCapabilities(tools);
      } else if (agent.type === "creative") {
        profile.creative_capabilities = this.analyzeCreativeCapabilities(tools);
      } else if (agent.type === "signals") {
        profile.signals_capabilities = this.analyzeSignalsCapabilities(tools);
      }

      this.cache.set(agent.url, profile);
      return profile;
    } catch (error: any) {
      const errorProfile: AgentCapabilityProfile = {
        agent_url: agent.url,
        protocol: agent.protocol || "mcp",
        discovered_tools: [],
        last_discovered: new Date().toISOString(),
        discovery_error: error.message,
      };
      this.cache.set(agent.url, errorProfile);
      return errorProfile;
    }
  }

  private async discoverTools(url: string, protocol: "mcp" | "a2a"): Promise<ToolCapability[]> {
    if (protocol === "a2a") {
      return this.discoverA2ATools(url);
    } else {
      return this.discoverMCPTools(url);
    }
  }

  private async discoverMCPTools(url: string): Promise<ToolCapability[]> {
    const client = createMCPClient(url);

    try {
      // MCP client from @adcp/client uses callTool, not request
      const response = await client.callTool("tools/list", {});

      if (!response?.tools || !Array.isArray(response.tools)) {
        return [];
      }

      return response.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.inputSchema || {},
        verified_at: new Date().toISOString(),
      }));
    } catch (error) {
      return [];
    }
  }

  private async discoverA2ATools(url: string): Promise<ToolCapability[]> {
    const client = createA2AClient(url);

    try {
      const response = await client.callTool("list_skills", {});

      if (!response?.result?.artifacts?.[0]?.parts?.[0]?.data?.skills) {
        return [];
      }

      const skills = response.result.artifacts[0].parts[0].data.skills;

      return skills.map((skill: any) => ({
        name: skill.name,
        description: skill.description || "",
        input_schema: skill.parameters || {},
        verified_at: new Date().toISOString(),
      }));
    } catch (error) {
      return [];
    }
  }

  private analyzeSalesCapabilities(tools: ToolCapability[]): StandardOperations {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    return {
      can_search_inventory: toolNames.has("search_inventory") || toolNames.has("get_products"),
      can_get_availability: toolNames.has("get_availability") || toolNames.has("check_availability"),
      can_reserve_inventory: toolNames.has("reserve_inventory") || toolNames.has("create_reservation"),
      can_get_pricing: toolNames.has("get_pricing") || toolNames.has("get_products"),
      can_create_order: toolNames.has("create_order") || toolNames.has("create_media_buy"),
      can_list_properties: toolNames.has("list_authorized_properties"),
    };
  }

  private analyzeCreativeCapabilities(tools: ToolCapability[]): CreativeCapabilities {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));
    const formatTool = tools.find((t) => t.name.toLowerCase() === "list_creative_formats");

    return {
      formats_supported: this.extractFormats(formatTool),
      can_generate: toolNames.has("build_creative") || toolNames.has("generate_creative"),
      can_validate: toolNames.has("validate_creative"),
      can_preview: toolNames.has("preview_creative") || toolNames.has("get_preview"),
    };
  }

  private analyzeSignalsCapabilities(tools: ToolCapability[]): SignalsCapabilities {
    const toolNames = new Set(tools.map((t) => t.name.toLowerCase()));

    return {
      audience_types: [], // Would need to inspect tool schemas to determine
      can_match: toolNames.has("match_audience") || toolNames.has("audience_match"),
      can_activate: toolNames.has("activate_signal") || toolNames.has("activate_audience"),
      can_get_signals: toolNames.has("get_signals") || toolNames.has("list_signals"),
    };
  }

  private extractFormats(formatTool?: ToolCapability): string[] {
    // Would need to call the tool to get actual formats
    // For now, return empty array
    return [];
  }

  async discoverAll(agents: Agent[]): Promise<Map<string, AgentCapabilityProfile>> {
    const profiles = new Map<string, AgentCapabilityProfile>();

    await Promise.all(
      agents.map(async (agent) => {
        const profile = await this.discoverCapabilities(agent);
        profiles.set(agent.url, profile);
      })
    );

    return profiles;
  }

  getCapabilities(agentUrl: string): AgentCapabilityProfile | undefined {
    return this.cache.get(agentUrl);
  }
}
