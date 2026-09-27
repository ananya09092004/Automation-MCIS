import { render, screen } from '@testing-library/react';
import DevelopersPage, { examples } from './DevelopersPage';

jest.mock('../firebase', () => ({ auth: { currentUser: null } }));

const spec = {
  openapi: '3.0.3',
  info: { title: 'Nexus Automation API', version: '1', description: 'Run approved workflows with a workspace API key.' },
  'x-nexus': {
    authentication: { header: 'Authorization: Bearer nxk_<prefix>_<secret>', notes: ['The full key is shown ONCE.'] },
    scopes: { 'workflows:run': 'Start runs', 'runs:read': 'Read status', 'executions:run': 'Submit executions' },
    idempotency: ['POST requests REQUIRE an Idempotency-Key header.'],
    quotas: ['Every authenticated request counts as one API call.'],
    rateLimits: ['60 requests per minute per key (429 RATE_LIMITED).'],
    approvals: 'A key can never approve an action.',
    errors: [{ status: 401, code: 'INVALID_API_KEY', meaning: 'Bad key' }, { status: 402, code: 'QUOTA_EXCEEDED', meaning: 'Limit reached' }],
  },
  components: { schemas: { ExecutionRequest: { type: 'object', properties: { goal: { type: 'string' } } } } },
  paths: {
    '/executions': { post: { summary: 'Submit an agent execution', 'x-scope': 'executions:run', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecutionRequest' } } } }, responses: { 201: {}, 200: {}, 402: {} } } },
    '/executions/{executionId}': { get: { summary: 'Get an execution', 'x-scope': 'runs:read', responses: { 200: {}, 404: {} } } },
  },
};

beforeEach(() => {
  global.fetch = jest.fn(async (url) => ({ ok: String(url).endsWith('/api/automation/v1/openapi.json'), status: 200, json: async () => spec }));
});

test('N API docs: endpoints, scopes, request schema, idempotency, quotas and error codes come from the server description', async () => {
  render(<DevelopersPage />);
  expect(await screen.findByTestId('endpoint-POST /executions')).toHaveTextContent('POST /api/automation/v1/executions');
  expect(screen.getByTestId('endpoint-POST /executions')).toHaveTextContent('Request body: goal (string)');
  expect(screen.getByTestId('endpoint-GET /executions/{executionId}')).toHaveTextContent('scope runs:read');
  expect(screen.getByRole('region', { name: 'Idempotency' })).toHaveTextContent('Idempotency-Key');
  expect(screen.getByRole('region', { name: 'Quotas and rate limits' })).toHaveTextContent('429 RATE_LIMITED');
  expect(screen.getByRole('region', { name: 'Errors' })).toHaveTextContent('QUOTA_EXCEEDED');
  expect(global.fetch.mock.calls[0][1]).toBeUndefined(); // public document: no auth header sent
});

test('N examples are copyable and never contain a real key', async () => {
  render(<DevelopersPage />);
  const ex = await screen.findByTestId('example-Submit an execution');
  expect(ex).toHaveTextContent('$NEXUS_API_KEY');
  expect(ex).toHaveTextContent('Idempotency-Key');
  const all = Object.values(examples('https://api.example.com')).join('\n');
  expect(all).not.toMatch(/nxk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/);
  expect(all).toContain('https://api.example.com/api/automation/v1/executions');
});
