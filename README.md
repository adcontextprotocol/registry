# AdCP Agent Registry

A static registry of AdCP compliant agents and publishers with real-time validation.

## Features

- **Static Agent Registry**: GitHub-based registry with manual approval via PRs
- **Real-time Validation**: Check if agents are authorized via `/.well-known/adagents.json`
- **MCP Server**: Query agents programmatically via Model Context Protocol
- **HTTP API**: REST endpoints for integration
- **Web UI**: Browse agents by type (creative, signals, sales)
- **Caching**: 15-minute TTL cache for validation results

## Quick Start

```bash
# Install dependencies
npm install

# Run HTTP server (default)
npm run dev

# Run MCP server
npm run dev:mcp

# Build
npm run build
```

## Usage

### HTTP API

**List all agents:**
```bash
curl http://localhost:3000/api/agents
```

**List agents by type:**
```bash
curl http://localhost:3000/api/agents?type=sales
```

**Validate agent authorization:**
```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{"domain": "nytimes.com", "agent_url": "https://sales.example.com"}'
```

**Get stats:**
```bash
curl http://localhost:3000/api/stats
```

### MCP Tools

- `list_agents(type?)` - List all agents, optionally filtered by type
- `get_agent(name)` - Get details for a specific agent
- `validate_agent(domain, agent_url)` - Validate agent authorization

### MCP Resources

- `agents://creative` - All creative agents
- `agents://signals` - All signals agents
- `agents://sales` - All sales agents
- `agents://all` - All agents

## Adding Agents

To add an agent to the registry:

1. Create a JSON file in the appropriate directory:
   - `/registry/creative/` for creative agents
   - `/registry/signals/` for signals/audience agents
   - `/registry/sales/` for media sales agents

2. Use this schema:

```json
{
  "$schema": "https://adcontextprotocol.org/schemas/v1/agent.json",
  "name": "Your Agent Name",
  "url": "https://your-agent.com",
  "type": "sales",
  "description": "Brief description of your agent",
  "capabilities": [
    "capability_1",
    "capability_2"
  ],
  "mcp_endpoint": "https://your-agent.com/mcp",
  "represents": ["publisher1.com", "publisher2.com"],
  "contact": {
    "name": "Your Team",
    "email": "contact@yourcompany.com",
    "website": "https://yourcompany.com"
  },
  "added_date": "2025-01-22"
}
```

3. Submit a pull request

## Architecture

- **Registry**: Static JSON files in `/registry/`
- **Server**: TypeScript with Express (HTTP) and MCP SDK
- **Validation**: On-demand fetching of `/.well-known/adagents.json` with caching
- **Deployment**: Fly.io (or any Node.js host)

## Environment Variables

- `MODE` - Server mode: `http` (default) or `mcp`
- `PORT` - HTTP server port (default: 3000)

## License

Apache 2.0 License - see [LICENSE](LICENSE) file for details.
