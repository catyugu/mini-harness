import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, ensurePaths } from '@mini-harness/platform/paths';
import { writeJson } from '@mini-harness/platform/json';

export interface MockProvider {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

type MockAnswer =
  | string
  | AsyncIterable<string>
  | { tool: string; args: Record<string, unknown>; text?: string; thinking?: string; callId?: string };

export async function createMockProvider(
  reply?: (request: { messages: { role: string; content: string }[] }) => MockAnswer | Promise<MockAnswer>,
): Promise<MockProvider> {
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
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, delta, finish_reason }],
        });
      const answer = reply
        ? await reply({
            messages: request.messages.map(
              (message: { role: string; content: string | { text?: string }[] }) => ({
                ...message,
                content: Array.isArray(message.content)
                  ? message.content.map((part: { text?: string }) => part.text ?? '').join('')
                  : message.content,
              }),
            ),
          })
        : 'Mock response';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (typeof answer === 'string') {
        res.write('data: ' + item({ role: 'assistant', content: answer.slice(0, 5) }, null) + '\n\n');
        res.write('data: ' + item({ content: answer.slice(5) }, null) + '\n\n');
        res.write('data: ' + item({}, 'stop') + '\n\n');
      } else if (Symbol.asyncIterator in answer) {
        res.write('data: ' + item({ role: 'assistant' }, null) + '\n\n');
        for await (const content of answer) res.write('data: ' + item({ content }, null) + '\n\n');
        res.write('data: ' + item({}, 'stop') + '\n\n');
      } else {
        if (answer.thinking)
          res.write(
            'data: ' + item({ role: 'assistant', reasoning_content: answer.thinking }, null) + '\n\n',
          );
        if (answer.text)
          res.write('data: ' + item({ role: 'assistant', content: answer.text }, null) + '\n\n');
        res.write(
          'data: ' +
            item(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: answer.callId ?? 'call_' + id,
                    type: 'function',
                    function: { name: answer.tool, arguments: JSON.stringify(answer.args) },
                  },
                ],
              },
              null,
            ) +
            '\n\n',
        );
        res.write('data: ' + item({}, 'tool_calls') + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock provider port');
  return {
    url: 'http://127.0.0.1:' + address.port + '/v1',
    requests,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
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
        models: [
          {
            id: 'mock-model',
            name: 'Mock Model',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 1024,
          },
        ],
      },
    },
  });
  const profile = join(paths.home, 'profiles', 'web');
  writeJson(join(profile, 'package.json'), {
    name: 'mini-harness-profile-web',
    private: true,
    type: 'module',
    dependencies: {},
    miniHarness: { profile: { bundles: ['@mini-harness/base', '@mini-harness/web'] } },
  });
  writeJson(join(profile, 'cordis.patch.yml'), { plugins: [] });
  writeJson(join(profile, 'cordis.yml'), {
    plugins: [
      {
        id: 'core:models',
        name: '@mini-harness/models',
        config: { model: { provider: 'local-mock', id: 'mock-model' } },
      },
    ],
  });
  return { root, paths };
}
