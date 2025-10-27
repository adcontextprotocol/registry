import { createMCPClient } from '@adcp/client';

const client = createMCPClient('https://weather.sales-agent.scope3.com');
try {
  const response = await client.callTool('list_authorized_properties', {});
  console.log('Full response:', JSON.stringify(response, null, 2));
} catch (error) {
  console.error('Error:', error.message);
}
