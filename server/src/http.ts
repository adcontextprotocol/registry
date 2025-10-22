import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Registry } from "./registry.js";
import { AgentValidator } from "./validator.js";
import { HealthChecker } from "./health.js";
import { CrawlerService } from "./crawler.js";
import { getPropertyIndex } from "./property-types.js";
import type { AgentType, AgentWithStats } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class HTTPServer {
  private app: express.Application;
  private registry: Registry;
  private validator: AgentValidator;
  private healthChecker: HealthChecker;
  private crawler: CrawlerService;

  constructor() {
    this.app = express();
    this.registry = new Registry();
    this.validator = new AgentValidator();
    this.healthChecker = new HealthChecker();
    this.crawler = new CrawlerService();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, "../public")));
  }

  private setupRoutes(): void {
    // API endpoints
    this.app.get("/api/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const withHealth = req.query.health === "true";
      const agents = this.registry.listAgents(type);

      if (!withHealth) {
        return res.json(agents);
      }

      // Enrich with health and stats
      const enriched = await Promise.all(
        agents.map(async (agent): Promise<AgentWithStats> => {
          const [health, stats] = await Promise.all([
            this.healthChecker.checkHealth(agent),
            this.healthChecker.getStats(agent),
          ]);
          return { ...agent, health, stats };
        })
      );

      res.json(enriched);
    });

    this.app.get("/api/agents/:name", async (req, res) => {
      const agent = this.registry.getAgent(req.params.name);
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
        type as string,
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

      res.json({
        agent_id: agentId,
        agent_url: auth.agent_url,
        properties: auth.properties,
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

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });
  }

  async start(port: number = 3000): Promise<void> {
    await this.registry.load();

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
}
