# Authorization Utilities for @adcp/client

## Problem

Many AdCP clients need to validate that a sales agent is authorized to represent a specific publisher domain. Currently, each client implements their own logic to:

1. Fetch `/.well-known/adagents.json` from publisher domains
2. Parse the `authorized_agents` array
3. Check if an agent URL is in the authorized list
4. Handle normalization (trailing slashes, http/https, etc.)
5. Handle errors and timeouts
6. Cache results to avoid repeated lookups

This is repetitive boilerplate that should be standardized.

## Proposed API

Add authorization utilities to `@adcp/client`:

```typescript
import { validateAgentAuthorization } from '@adcp/client';

// Simple validation
const result = await validateAgentAuthorization({
  domain: 'nytimes.com',
  agentUrl: 'https://sales-agent.example.com'
});

console.log(result);
// {
//   authorized: true,
//   domain: 'nytimes.com',
//   agent_url: 'https://sales-agent.example.com',
//   checked_at: '2025-10-22T17:35:00Z',
//   source: 'https://nytimes.com/.well-known/adagents.json'
// }
```

### With Caching

```typescript
import { createAuthorizationValidator } from '@adcp/client';

const validator = createAuthorizationValidator({
  cacheTtlMinutes: 15,  // Cache results for 15 minutes
  timeout: 5000         // 5 second timeout for fetches
});

// Subsequent calls to same domain+agent use cache
const result1 = await validator.validate('nytimes.com', 'https://agent.example.com');
const result2 = await validator.validate('nytimes.com', 'https://agent.example.com'); // From cache

// Check cache stats
console.log(validator.getCacheStats()); // { size: 1, hits: 1, misses: 1 }

// Clear cache if needed
validator.clearCache();
```

### Batch Validation

```typescript
// Validate one agent against multiple publishers
const results = await validator.validateAgentForPublishers(
  'https://sales-agent.example.com',
  ['nytimes.com', 'washingtonpost.com', 'wsj.com']
);

// Validate multiple agents against one publisher
const results = await validator.validatePublisherAgents(
  'nytimes.com',
  ['https://agent1.com', 'https://agent2.com']
);
```

### Integration with AgentClient

```typescript
// Automatically validate before calling sales agent tools
const agent = client.agent('sales_agent_id');

// Validate that this agent is authorized for a publisher
const isAuthorized = await agent.isAuthorizedFor('nytimes.com');

// Or validate during the call
const result = await agent.getProducts({
  brief: 'Coffee brands',
  validate_authorization: 'nytimes.com'  // Throws if not authorized
});
```

## Implementation Details

### Core Function

```typescript
export interface AuthorizationValidationOptions {
  timeout?: number;
  userAgent?: string;
  cacheTtlMinutes?: number;
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

export async function validateAgentAuthorization(
  params: {
    domain: string;
    agentUrl: string;
  },
  options?: AuthorizationValidationOptions
): Promise<ValidationResult>;

export class AuthorizationValidator {
  constructor(options?: AuthorizationValidationOptions);

  validate(domain: string, agentUrl: string): Promise<ValidationResult>;
  validateAgentForPublishers(agentUrl: string, domains: string[]): Promise<ValidationResult[]>;
  validatePublisherAgents(domain: string, agentUrls: string[]): Promise<ValidationResult[]>;

  getCacheStats(): { size: number; hits: number; misses: number };
  clearCache(): void;
}

export function createAuthorizationValidator(
  options?: AuthorizationValidationOptions
): AuthorizationValidator;
```

### Normalization Rules

- Domain: Strip protocol (`http://`, `https://`), strip trailing slash
- Agent URL: Strip trailing slash for comparison
- Case-insensitive comparison for domains
- Case-sensitive comparison for agent URLs (paths are case-sensitive)

### Error Handling

- Network errors: `{ authorized: false, error: "fetch failed" }`
- HTTP errors: `{ authorized: false, error: "HTTP 404" }`
- Parse errors: `{ authorized: false, error: "Invalid JSON" }`
- Timeout: `{ authorized: false, error: "Request timeout" }`

### Caching Strategy

- Key: `${normalized_domain}:${normalized_agent_url}`
- TTL: Configurable (default 15 minutes)
- Invalidation: Manual via `clearCache()` or TTL expiry
- Cache both positive and negative results

## Use Cases

### 1. Registry Service (Our Use Case)

Validate that sales agents are authorized to represent publishers they claim:

```typescript
const validator = createAuthorizationValidator({ cacheTtlMinutes: 15 });

// Check if agent is authorized
const result = await validator.validate(
  'accuweather.com',
  'https://sales-agent.accuweather.com'
);

if (result.authorized) {
  console.log('✅ Agent is authorized');
} else {
  console.log('❌ Not authorized:', result.error);
}
```

### 2. Media Buyer Verification

Before creating a media buy, verify the agent is authorized:

```typescript
const agent = client.agent('sales_agent_id');

// Validate authorization before purchasing
const isAuthorized = await agent.isAuthorizedFor('publisher.com');

if (!isAuthorized) {
  throw new Error('Agent not authorized for this publisher');
}

// Proceed with media buy
const result = await agent.createMediaBuy({ ... });
```

### 3. Compliance Auditing

Audit all agents to ensure they're properly authorized:

```typescript
const agents = await getRegisteredAgents();
const publishers = await getPublisherList();

for (const agent of agents) {
  const results = await validator.validateAgentForPublishers(
    agent.url,
    publishers
  );

  const unauthorized = results.filter(r => !r.authorized);
  if (unauthorized.length > 0) {
    console.log(`⚠️  ${agent.name} has ${unauthorized.length} unauthorized claims`);
  }
}
```

### 4. Real-time Authorization Checks

In a media buying UI, show which publishers an agent can access:

```typescript
const agent = agents.find(a => a.id === selectedAgentId);
const publishers = await fetchPublisherList();

// Check authorization in parallel
const authorizations = await Promise.all(
  publishers.map(p => validator.validate(p.domain, agent.url))
);

const authorizedPublishers = publishers.filter((p, i) =>
  authorizations[i].authorized
);

renderPublisherSelect(authorizedPublishers);
```

## Benefits

1. **Standardization**: Everyone validates authorization the same way
2. **DRY**: No more copy-pasting authorization logic
3. **Performance**: Built-in caching reduces network calls
4. **Reliability**: Proper error handling and timeouts
5. **Maintainability**: Bug fixes benefit all clients
6. **Testing**: Authorization logic is tested once, centrally

## Migration Path

For existing clients:

```typescript
// Before (custom implementation)
async function checkAuth(domain: string, agentUrl: string) {
  const response = await fetch(`https://${domain}/.well-known/adagents.json`);
  const data = await response.json();
  return data.authorized_agents.some(a => a.url === agentUrl);
}

// After (using @adcp/client)
import { validateAgentAuthorization } from '@adcp/client';

const result = await validateAgentAuthorization({ domain, agentUrl });
return result.authorized;
```

## Open Questions

1. Should we also validate A2A agent cards at `/.well-known/agent.json`?
2. Should we support custom validation rules (e.g., checking `authorized_for` field)?
3. Should we emit events for authorization checks (for monitoring/logging)?
4. Should we support webhook callbacks for authorization changes?

## Related Work

- AdCP Spec: `/.well-known/adagents.json` format
- [AdCP Testing Framework](https://testing.adcontextprotocol.org/adagents.html)
- Existing validation in this registry: `server/src/validator.ts`
