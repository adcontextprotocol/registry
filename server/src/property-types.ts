// Temporary types until @adcp/client publishes PropertyIndex/PropertyCrawler
// These match the PR: https://github.com/adcontextprotocol/adcp-client/pull/68

export interface PropertyMatch {
  property: {
    property_type: string;
    name: string;
    identifiers: Array<{
      type: string;
      value: string;
    }>;
    tags?: string[];
    publisher_domain: string;
  };
  agent_url: string;
  publisher_domain: string;
}

export interface AgentAuthorization {
  agent_url: string;
  properties: Array<{
    property_type: string;
    name: string;
    identifiers: Array<{
      type: string;
      value: string;
    }>;
    tags?: string[];
    publisher_domain: string;
  }>;
}

export interface CrawlResult {
  totalProperties: number;
  successfulAgents: number;
  failedAgents: number;
  errors: Array<{
    agent_url: string;
    error: string;
  }>;
}

export interface AgentConfig {
  agent_url: string;
  protocol: "mcp" | "a2a";
  publisher_domain: string;
}

// Stub implementations until library is published
export class PropertyIndex {
  private agentProperties: Map<string, any[]> = new Map();
  private propertyToAgents: Map<string, Set<string>> = new Map();

  addAgentProperties(agentUrl: string, properties: any[]) {
    this.agentProperties.set(agentUrl, properties);

    // Build reverse index
    for (const prop of properties) {
      for (const identifier of prop.identifiers || []) {
        const key = `${identifier.type}:${identifier.value}`;
        if (!this.propertyToAgents.has(key)) {
          this.propertyToAgents.set(key, new Set());
        }
        this.propertyToAgents.get(key)!.add(agentUrl);
      }
    }
  }

  findAgentsForProperty(propertyType: string, propertyValue: string): PropertyMatch[] {
    const key = `${propertyType}:${propertyValue}`;
    const agentUrls = this.propertyToAgents.get(key) || new Set();

    const matches: PropertyMatch[] = [];
    for (const agentUrl of agentUrls) {
      const properties = this.agentProperties.get(agentUrl) || [];
      for (const prop of properties) {
        const hasIdentifier = prop.identifiers?.some(
          (id: any) => id.type === propertyType && id.value === propertyValue
        );
        if (hasIdentifier) {
          matches.push({
            property: prop,
            agent_url: agentUrl,
            publisher_domain: prop.publisher_domain,
          });
        }
      }
    }

    return matches;
  }

  getAgentAuthorizations(agentUrl: string): AgentAuthorization {
    return {
      agent_url: agentUrl,
      properties: this.agentProperties.get(agentUrl) || [],
    };
  }

  clear() {
    this.agentProperties.clear();
    this.propertyToAgents.clear();
  }

  getStats() {
    return {
      totalAgents: this.agentProperties.size,
      totalProperties: Array.from(this.agentProperties.values()).reduce(
        (sum, props) => sum + props.length,
        0
      ),
      totalIdentifiers: this.propertyToAgents.size,
    };
  }
}

// Singleton instance
let propertyIndex: PropertyIndex | null = null;

export function getPropertyIndex(): PropertyIndex {
  if (!propertyIndex) {
    propertyIndex = new PropertyIndex();
  }
  return propertyIndex;
}
