import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, ensurePaths, writeJson } from '../../src/config.js';

export interface MockProvider {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function createMockProvider(): Promise<MockProvider> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(request);
      const id = 'chatcmpl-mini-harness-' + requests.length;
      const item = (delta: Record<string, unknown>, finish_reason: string | null) =>
        JSON.stringify({ id, object: 'chat.completion.chunk', created: 1,
          model: 'mock-model', choices: [{ index: 0, delta, finish_reason }] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + item({ role: 'assistant', content: 'Mock ' }, null) + '\n\n');
      res.write('data: ' + item({ content: 'response' }, null) + '\n\n');
      res.write('data: ' + item({}, 'stop') + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock provider port');
  return {
    url: 'http://127.0.0.1:' + address.port + '/v1',
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function createFixturePaths(mockUrl: string) {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-e2e-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const paths = getPaths(cwd, { MINI_HARNESS_HOME: join(root, 'home') });
  ensurePaths(paths);
  writeJson(join(paths.home, 'models.json'), {
    providers: {
      'local-mock': {
        baseUrl: mockUrl,
        api: 'openai-completions',
        apiKey: 'local-test-only',
        models: [{ id: 'mock-model', name: 'Mock Model', reasoning: false, input: ['text'],
          contextWindow: 32768, maxTokens: 1024 }]
      }
    }
  });
  writeJson(paths.settings, { model: { provider: 'local-mock', id: 'mock-model' } });
  return { root, paths };
}
