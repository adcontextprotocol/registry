import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Registry } from "./registry.js";
import { AgentValidator } from "./validator.js";
import { HealthChecker } from "./health.js";
import { CrawlerService } from "./crawler.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { PublisherTracker } from "./publishers.js";
import { PropertiesService } from "./properties.js";
import { getPropertyIndex, createMCPClient, createA2AClient } from "@adcp/client";
import type { AgentType, AgentWithStats } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class HTTPServer {
  private app: express.Application;
  private registry: Registry;
  private validator: AgentValidator;
  private healthChecker: HealthChecker;
  private crawler: CrawlerService;
  private capabilityDiscovery: CapabilityDiscovery;
  private publisherTracker: PublisherTracker;
  private propertiesService: PropertiesService;

  constructor() {
    this.app = express();
    this.registry = new Registry();
    this.validator = new AgentValidator();
    this.healthChecker = new HealthChecker();
    this.crawler = new CrawlerService();
    this.capabilityDiscovery = new CapabilityDiscovery();
    this.publisherTracker = new PublisherTracker();
    this.propertiesService = new PropertiesService();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    // In production: __dirname is /app/dist, public is at /app/server/public
    // In development: __dirname is /path/to/server/src, public is at ../public
    const publicPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../server/public")
      : path.join(__dirname, "../public");
    this.app.use(express.static(publicPath));
  }


  private setupRoutes(): void {
    // API endpoints
    this.app.get("/api/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const withHealth = req.query.health === "true";
      const withCapabilities = req.query.capabilities === "true";
      const withProperties = req.query.properties === "true";
      const agents = this.registry.listAgents(type);

      if (!withHealth && !withCapabilities && !withProperties) {
        return res.json(agents);
      }

      // Enrich with health, stats, capabilities, and/or properties
      const enriched = await Promise.all(
        agents.map(async (agent): Promise<AgentWithStats> => {
          const promises = [];

          if (withHealth) {
            promises.push(
              this.healthChecker.checkHealth(agent),
              this.healthChecker.getStats(agent)
            );
          }

          if (withCapabilities) {
            promises.push(
              this.capabilityDiscovery.discoverCapabilities(agent)
            );
          }

          if (withProperties && agent.type === "sales") {
            promises.push(
              this.propertiesService.getPropertiesForAgent(agent)
            );
          }

          const results = await Promise.all(promises);

          const enrichedAgent: AgentWithStats = { ...agent };
          let resultIndex = 0;

          if (withHealth) {
            enrichedAgent.health = results[resultIndex++] as any;
            enrichedAgent.stats = results[resultIndex++] as any;
          }

          if (withCapabilities) {
            const capProfile = results[resultIndex++] as any;
            enrichedAgent.capabilities = {
              tools_count: capProfile.discovered_tools.length,
              tools: capProfile.discovered_tools,
              standard_operations: capProfile.standard_operations,
              creative_capabilities: capProfile.creative_capabilities,
              signals_capabilities: capProfile.signals_capabilities,
            };
          }

          if (withProperties && agent.type === "sales") {
            const propsProfile = results[resultIndex++] as any;
            enrichedAgent.properties = propsProfile.properties;
            enrichedAgent.propertiesError = propsProfile.error;
          }

          return enrichedAgent;
        })
      );

      res.json(enriched);
    });

    this.app.get("/api/agents/:type/:name", async (req, res) => {
      const agentId = `${req.params.type}/${req.params.name}`;
      const agent = this.registry.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const withHealth = req.query.health === "true";
      if (!withHealth) {
        return res.json(agent);
      }

      const [health, stats] = await Promise.all([
        this.healthChecker.checkHealth(agent),
        this.healthChecker.getStats(agent),
      ]);

      res.json({ ...agent, health, stats });
    });

    this.app.post("/api/validate", async (req, res) => {
      const { domain, agent_url } = req.body;

      if (!domain || !agent_url) {
        return res.status(400).json({
          error: "Missing required fields: domain and agent_url",
        });
      }

      try {
        const result = await this.validator.validate(domain, agent_url);
        res.json(result);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Validation failed",
        });
      }
    });

    // Property lookup endpoints
    this.app.get("/api/lookup/property", (req, res) => {
      const { type, value } = req.query;

      if (!type || !value) {
        return res.status(400).json({
          error: "Missing required query params: type and value",
        });
      }

      const index = getPropertyIndex();
      const agents = index.findAgentsForProperty(
        type as any, // PropertyIdentifierType
        value as string
      );

      res.json({
        type,
        value,
        agents,
        count: agents.length,
      });
    });

    this.app.get("/api/agents/:id/properties", (req, res) => {
      const agentId = req.params.id;
      const agent = this.registry.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const index = getPropertyIndex();
      const auth = index.getAgentAuthorizations(agent.url);

      if (!auth) {
        return res.json({
          agent_id: agentId,
          agent_url: agent.url,
          properties: [],
          publisher_domains: [],
          count: 0,
        });
      }

      res.json({
        agent_id: agentId,
        agent_url: auth.agent_url,
        properties: auth.properties,
        publisher_domains: auth.publisher_domains,
        count: auth.properties.length,
      });
    });

    // Crawler endpoints
    this.app.post("/api/crawler/run", async (req, res) => {
      const agents = this.registry.listAgents("sales");
      const result = await this.crawler.crawlAllAgents(agents);
      res.json(result);
    });

    this.app.get("/api/crawler/status", (req, res) => {
      res.json(this.crawler.getStatus());
    });

    this.app.get("/api/stats", (req, res) => {
      const agents = this.registry.listAgents();
      const byType = {
        creative: agents.filter((a) => a.type === "creative").length,
        signals: agents.filter((a) => a.type === "signals").length,
        sales: agents.filter((a) => a.type === "sales").length,
      };

      res.json({
        total: agents.length,
        by_type: byType,
        cache: this.validator.getCacheStats(),
      });
    });

    // Capability endpoints
    this.app.get("/api/agents/:id/capabilities", async (req, res) => {
      const agentId = req.params.id;
      const agent = this.registry.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      try {
        const profile = await this.capabilityDiscovery.discoverCapabilities(agent);
        res.json(profile);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Capability discovery failed",
        });
      }
    });

    this.app.post("/api/capabilities/discover-all", async (req, res) => {
      const agents = this.registry.listAgents();
      try {
        const profiles = await this.capabilityDiscovery.discoverAll(agents);
        res.json({
          total: profiles.size,
          profiles: Array.from(profiles.values()),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Bulk discovery failed",
        });
      }
    });

    // Publisher endpoints
    this.app.get("/api/publishers", async (req, res) => {
      const agents = this.registry.listAgents("sales");
      try {
        const statuses = await this.publisherTracker.trackPublishers(agents);
        res.json({
          total: statuses.size,
          publishers: Array.from(statuses.values()),
          stats: this.publisherTracker.getDeploymentStats(),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Publisher tracking failed",
        });
      }
    });

    this.app.get("/api/publishers/:domain", async (req, res) => {
      const domain = req.params.domain;
      const agents = this.registry.listAgents("sales");

      // Find agents claiming this domain
      const expectedAgents = agents
        .filter((a) => {
          try {
            const url = new URL(a.url);
            return url.hostname === domain;
          } catch {
            return false;
          }
        })
        .map((a) => a.url);

      try {
        const status = await this.publisherTracker.checkPublisher(domain, expectedAgents);
        res.json(status);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Publisher check failed",
        });
      }
    });

    this.app.get("/api/publishers/:domain/validation", async (req, res) => {
      const domain = req.params.domain;
      const agents = this.registry.listAgents("sales");

      const expectedAgents = agents
        .filter((a) => {
          try {
            const url = new URL(a.url);
            return url.hostname === domain;
          } catch {
            return false;
          }
        })
        .map((a) => a.url);

      try {
        const status = await this.publisherTracker.checkPublisher(domain, expectedAgents);
        res.json({
          domain: status.domain,
          deployment_status: status.deployment_status,
          issues: status.issues,
          coverage_percentage: status.coverage_percentage,
          recommended_actions: status.issues.map((issue) => ({
            issue: issue.message,
            fix: issue.fix,
            severity: issue.severity,
          })),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Validation failed",
        });
      }
    });

    // Simple REST API endpoint - for web apps and quick integrations
    this.app.get("/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const agents = this.registry.listAgents(type);

      res.json({
        agents,
        count: agents.length,
        by_type: {
          creative: agents.filter(a => a.type === "creative").length,
          signals: agents.filter(a => a.type === "signals").length,
          sales: agents.filter(a => a.type === "sales").length,
        }
      });
    });

    // MCP endpoint - for AI agents to discover other agents
    // This makes the registry itself an MCP server that can be queried by other agents
    this.app.options("/mcp", (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).end();
    });

    this.app.post("/mcp", async (req, res) => {
      // Add CORS headers for browser-based MCP clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      const { method, params, id } = req.body;

      try {
        // Handle MCP tools/list request
        if (method === "tools/list") {
          res.json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "list_agents",
                  description: "List all registered AdCP agents, optionally filtered by type",
                  inputSchema: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["creative", "signals", "sales"],
                        description: "Optional: Filter by agent type",
                      },
                    },
                  },
                },
                {
                  name: "get_agent",
                  description: "Get details for a specific agent by ID",
                  inputSchema: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        description: "Agent identifier (e.g., 'creative/4dvertible-creative-agent')",
                      },
                    },
                    required: ["id"],
                  },
                },
                {
                  name: "find_agents_for_property",
                  description: "Find which agents can sell a specific property",
                  inputSchema: {
                    type: "object",
                    properties: {
                      property_type: {
                        type: "string",
                        description: "Property identifier type (e.g., 'domain', 'app_id')",
                      },
                      property_value: {
                        type: "string",
                        description: "Property identifier value (e.g., 'nytimes.com')",
                      },
                    },
                    required: ["property_type", "property_value"],
                  },
                },
                {
                  name: "get_properties_for_agent",
                  description: "Get all properties that a specific agent is authorized to sell by checking their publisher's adagents.json",
                  inputSchema: {
                    type: "object",
                    properties: {
                      agent_url: {
                        type: "string",
                        description: "Agent URL (e.g., 'https://sales.weather.com')",
                      },
                    },
                    required: ["agent_url"],
                  },
                },
                {
                  name: "get_products_for_agent",
                  description: "Query a sales agent for available products (proxy tool that calls get_products on the agent)",
                  inputSchema: {
                    type: "object",
                    properties: {
                      agent_url: {
                        type: "string",
                        description: "Agent URL to query",
                      },
                      params: {
                        type: "object",
                        description: "Parameters to pass to get_products (leave empty for public products)",
                      },
                    },
                    required: ["agent_url"],
                  },
                },
                {
                  name: "list_creative_formats_for_agent",
                  description: "Query an agent for supported creative formats (proxy tool that calls list_creative_formats on the agent)",
                  inputSchema: {
                    type: "object",
                    properties: {
                      agent_url: {
                        type: "string",
                        description: "Agent URL to query",
                      },
                      params: {
                        type: "object",
                        description: "Parameters to pass to list_creative_formats",
                      },
                    },
                    required: ["agent_url"],
                  },
                },
              ],
            },
          });
          return;
        }

        // Handle MCP tools/call request
        if (method === "tools/call") {
          const { name, arguments: args } = params;

          if (name === "list_agents") {
            const type = args?.type as AgentType | undefined;
            const agents = this.registry.listAgents(type);
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/agents/${type || "all"}`,
                      mimeType: "application/json",
                      text: JSON.stringify({
                        agents,
                        count: agents.length,
                        by_type: {
                          creative: agents.filter(a => a.type === "creative").length,
                          signals: agents.filter(a => a.type === "signals").length,
                          sales: agents.filter(a => a.type === "sales").length,
                        }
                      }, null, 2),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "get_agent") {
            const agentId = args?.id as string;
            const agent = this.registry.getAgent(agentId);
            if (!agent) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Agent not found",
                },
              });
              return;
            }
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/agents/${agentId}`,
                      mimeType: "application/json",
                      text: JSON.stringify(agent, null, 2),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "find_agents_for_property") {
            const propertyType = args?.property_type as string;
            const propertyValue = args?.property_value as string;
            const index = getPropertyIndex();
            const agents = index.findAgentsForProperty(propertyType as any, propertyValue);
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/properties/${propertyType}/${propertyValue}`,
                      mimeType: "application/json",
                      text: JSON.stringify(
                        { property_type: propertyType, property_value: propertyValue, agents, count: agents.length },
                        null,
                        2
                      ),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "get_properties_for_agent") {
            const agentUrl = args?.agent_url as string;
            if (!agentUrl) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Missing agent_url parameter",
                },
              });
              return;
            }

            try {
              // Find the agent in our registry
              const agents = Array.from(this.registry.getAllAgents().values());
              const agent = agents.find((a) => a.url === agentUrl);

              if (!agent) {
                res.json({
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32602,
                    message: `Agent not found: ${agentUrl}`,
                  },
                });
                return;
              }

              // Use cached properties service
              const profile = await this.propertiesService.getPropertiesForAgent(agent);

              const url = new URL(agentUrl);
              const domain = url.hostname;

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `https://registry.adcontextprotocol.org/agent-properties/${domain}`,
                        mimeType: "application/json",
                        text: JSON.stringify(
                          {
                            agent_url: agentUrl,
                            domain,
                            protocol: profile.protocol,
                            properties: profile.properties,
                            count: profile.properties.length,
                            error: profile.error,
                            status: profile.error ? "error" : profile.properties.length > 0 ? "success" : "empty",
                            last_fetched: profile.last_fetched,
                          },
                          null,
                          2
                        ),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to get properties: ${error.message}`,
                },
              });
              return;
            }
          }

          if (name === "get_products_for_agent") {
            const agentUrl = args?.agent_url as string;
            const params = args?.params || {};

            try {
              const { AgentClient } = await import("@adcp/client");
              const client = new AgentClient({
                id: "registry",
                name: "Registry Query",
                agent_uri: agentUrl,
                protocol: "mcp",
              });

              const result = await client.executeTask("get_products", params);

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `adcp://products/${agentUrl}`,
                        mimeType: "application/json",
                        text: JSON.stringify(result.success ? result.data : { error: result.error || "Failed to get products" }),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to get products: ${error.message}`,
                },
              });
              return;
            }
          }

          if (name === "list_creative_formats_for_agent") {
            const agentUrl = args?.agent_url as string;
            const params = args?.params || {};

            try {
              const { AgentClient } = await import("@adcp/client");
              const client = new AgentClient({
                id: "registry",
                name: "Registry Query",
                agent_uri: agentUrl,
                protocol: "mcp",
              });

              const result = await client.executeTask("list_creative_formats", params);

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `adcp://formats/${agentUrl}`,
                        mimeType: "application/json",
                        text: JSON.stringify(result.success ? result.data : { error: result.error || "Failed to list formats" }),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to list formats: ${error.message}`,
                },
              });
              return;
            }
          }

          res.json({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: "Unknown tool",
            },
          });
          return;
        }

        // Unknown method
        res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        });
      } catch (error: any) {
        res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: error?.message || "Internal error",
          },
        });
      }
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });
  }

  async start(port: number = 3000): Promise<void> {
    await this.registry.load();

    // Pre-warm caches for all agents in background
    const allAgents = this.registry.listAgents();
    console.log(`Pre-warming caches for ${allAgents.length} agents...`);

    // Don't await - let this run in background
    this.prewarmCaches(allAgents).then(() => {
      console.log(`Cache pre-warming complete`);
    }).catch(err => {
      console.error(`Cache pre-warming failed:`, err.message);
    });

    // Start periodic property crawler for sales agents
    const salesAgents = this.registry.listAgents("sales");
    if (salesAgents.length > 0) {
      console.log(`Starting property crawler for ${salesAgents.length} sales agents...`);
      this.crawler.startPeriodicCrawl(salesAgents, 60); // Crawl every 60 minutes
    }

    this.app.listen(port, () => {
      console.log(`AdCP Registry HTTP server running on port ${port}`);
      console.log(`Web UI: http://localhost:${port}`);
      console.log(`API: http://localhost:${port}/api/agents`);
    });
  }

  private async prewarmCaches(agents: any[]): Promise<void> {
    await Promise.all(
      agents.map(async (agent) => {
        try {
          // Warm health and stats caches
          await Promise.all([
            this.healthChecker.checkHealth(agent),
            this.healthChecker.getStats(agent),
            this.capabilityDiscovery.discoverCapabilities(agent),
          ]);

          // Warm type-specific caches
          if (agent.type === "sales") {
            await this.propertiesService.getPropertiesForAgent(agent);
          }
        } catch (error) {
          // Errors are expected for offline agents, just continue
        }
      })
    );
  }
}
