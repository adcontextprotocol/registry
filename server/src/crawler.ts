import type { Agent } from "./types.js";
import type { AgentConfig, CrawlResult } from "./property-types.js";
import { getPropertyIndex } from "./property-types.js";
import { createMCPClient } from "@adcp/client";

export class CrawlerService {
  private crawling: boolean = false;
  private lastCrawl: Date | null = null;
  private lastResult: CrawlResult | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  async crawlAgent(config: AgentConfig): Promise<any[]> {
    try {
      // Try MCP first
      const client = createMCPClient(config.agent_url);
      const result = await client.callTool("list_authorized_properties", {});

      if (result?.properties && Array.isArray(result.properties)) {
        return result.properties;
      }

      return [];
    } catch (error) {
      console.error(`Failed to crawl ${config.agent_url}:`, error);
      throw error;
    }
  }

  async crawlAllAgents(agents: Agent[]): Promise<CrawlResult> {
    if (this.crawling) {
      console.log("Crawl already in progress, skipping...");
      return this.lastResult || this.emptyResult();
    }

    this.crawling = true;
    console.log(`Starting crawl of ${agents.length} agents...`);

    const result: CrawlResult = {
      totalProperties: 0,
      successfulAgents: 0,
      failedAgents: 0,
      errors: [],
    };

    const index = getPropertyIndex();
    index.clear(); // Clear previous data

    // Crawl all agents in parallel
    const crawlPromises = agents.map(async (agent) => {
      const config: AgentConfig = {
        agent_url: agent.url,
        protocol: "mcp", // Default to MCP for now
        publisher_domain: this.extractDomain(agent.url),
      };

      try {
        const properties = await this.crawlAgent(config);
        index.addAgentProperties(agent.url, properties);

        result.totalProperties += properties.length;
        result.successfulAgents += 1;

        console.log(
          `✅ Crawled ${agent.name}: ${properties.length} properties`
        );
      } catch (error) {
        result.failedAgents += 1;
        result.errors.push({
          agent_url: agent.url,
          error: error instanceof Error ? error.message : "Unknown error",
        });

        console.error(`❌ Failed to crawl ${agent.name}`);
      }
    });

    await Promise.allSettled(crawlPromises);

    this.lastCrawl = new Date();
    this.lastResult = result;
    this.crawling = false;

    console.log(
      `Crawl complete: ${result.totalProperties} properties from ${result.successfulAgents}/${agents.length} agents`
    );

    return result;
  }

  startPeriodicCrawl(agents: Agent[], intervalMinutes: number = 60) {
    // Initial crawl
    this.crawlAllAgents(agents);

    // Periodic crawl
    this.intervalId = setInterval(() => {
      this.crawlAllAgents(agents);
    }, intervalMinutes * 60 * 1000);

    console.log(`Periodic crawl started (every ${intervalMinutes} minutes)`);
  }

  stopPeriodicCrawl() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("Periodic crawl stopped");
    }
  }

  getStatus() {
    return {
      crawling: this.crawling,
      lastCrawl: this.lastCrawl?.toISOString() || null,
      lastResult: this.lastResult,
      indexStats: getPropertyIndex().getStats(),
    };
  }

  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return url;
    }
  }

  private emptyResult(): CrawlResult {
    return {
      totalProperties: 0,
      successfulAgents: 0,
      failedAgents: 0,
      errors: [],
    };
  }
}
