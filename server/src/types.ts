export type AgentType = "creative" | "signals" | "sales";

export interface Agent {
  $schema?: string;
  name: string;
  url: string;
  type: AgentType;
  description: string;
  capabilities: string[];
  mcp_endpoint: string;
  represents?: string[];
  contact: {
    name: string;
    email: string;
    website: string;
  };
  added_date: string;
}

export interface AdAgentsJson {
  $schema?: string;
  authorized_agents: Array<{
    url: string;
    authorized_for?: string;
  }>;
  last_updated?: string;
}

export interface ValidationResult {
  authorized: boolean;
  domain: string;
  agent_url: string;
  checked_at: string;
  source?: string;
  error?: string;
}
