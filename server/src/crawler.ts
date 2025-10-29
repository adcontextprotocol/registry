import type { Agent } from "./types.js";
import { PropertyCrawler, getPropertyIndex, type AgentInfo, type CrawlResult } from "@adcp/client";

export class CrawlerService {
  private crawler: PropertyCrawler;
  private crawling: boolean = false;
  private lastCrawl: Date | null = null;
  private lastResult: CrawlResult | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    this.crawler = new PropertyCrawler({ logLevel: 'debug' });
  }

  async crawlAllAgents(agents: Agent[]): Promise<CrawlResult> {
    if (this.crawling) {
      console.log("Crawl already in progress, skipping...");
      return this.lastResult || this.emptyResult();
    }

    this.crawling = true;
    console.log(`Starting crawl of ${agents.length} agents...`);

    // Convert our Agent type to AgentInfo for the crawler
    const agentInfos: AgentInfo[] = agents.map((agent) => ({
      agent_url: agent.url,
      protocol: agent.protocol || "mcp", // Use agent's protocol, default to MCP
      publisher_domain: this.extractDomain(agent.url),
    }));

    try {
      // Temporarily suppress console errors during crawl to avoid noise from expected failures
      const originalConsoleError = console.error;
      console.error = (...args: any[]) => {
        const message = args.join(' ');
        // Only log non-crawler errors
        if (!message.includes('Failed to fetch adagents.json') &&
            !message.includes('property-crawler')) {
          originalConsoleError.apply(console, args);
        }
      };

      const result = await this.crawler.crawlAgents(agentInfos);

      // Restore console.error
      console.error = originalConsoleError;

      this.lastCrawl = new Date();
      this.lastResult = result;
      this.crawling = false;

      console.log(
        `Crawl complete: ${result.totalProperties} properties from ${result.successfulAgents}/${agents.length} agents`
      );

      if (result.failedAgents > 0) {
        console.log(`Note: ${result.failedAgents} agent(s) failed (domains without adagents.json files)`);
      }

      return result;
    } catch (error) {
      console.error("Crawl failed:", error);
      this.crawling = false;
      throw error;
    }
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
    const index = getPropertyIndex();
    const stats = index.getStats();
    return {
      crawling: this.crawling,
      lastCrawl: this.lastCrawl?.toISOString() || null,
      lastResult: this.lastResult,
      indexStats: stats,
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
      totalPublisherDomains: 0,
      successfulAgents: 0,
      failedAgents: 0,
      errors: [],
    };
  }
}
