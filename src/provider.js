export class ProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function parseContent(data) {
  const choice = data?.choices?.[0];
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }
  if (Array.isArray(choice?.message?.content)) {
    return choice.message.content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  if (typeof data?.message?.content === 'string') {
    return data.message.content;
  }

  throw new ProviderError('Provider response did not include assistant content.', { data });
}

export class OpenAICompatibleProvider {
  constructor(config) {
    this.config = config;
  }

  async complete(messages, options = {}) {
    const provider = this.config.provider;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeoutMs ?? 120000);
    const url = `${trimTrailingSlash(provider.baseUrl)}/chat/completions`;

    const headers = {
      'content-type': 'application/json',
      ...(provider.headers ?? {})
    };

    if (provider.apiKey) {
      headers.authorization = `Bearer ${provider.apiKey}`;
    }

    const body = {
      model: provider.model,
      messages,
      stream: false,
      ...(provider.request ?? {}),
      ...options
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError(`Provider returned HTTP ${response.status}.`, {
          status: response.status,
          body: text.slice(0, 2000)
        });
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new ProviderError(`Provider returned non-JSON response: ${error.message}`, {
          body: text.slice(0, 2000)
        });
      }

      return parseContent(data);
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new ProviderError(`Provider request timed out after ${provider.timeoutMs} ms.`);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(`Provider request failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class MockProvider {
  async complete(messages) {
    const workflowPlan = [...messages].reverse().find((message) => String(message.content).includes('Workflow result for plan'));
    if (!workflowPlan) {
      return JSON.stringify({
        reason: 'Smoke test should present a visible plan before acting.',
        action: 'plan',
        args: {
          goal: 'Verify the agent workflow loop',
          steps: [
            { id: '1', title: 'Record a plan' },
            { id: '2', title: 'Inspect workspace status' },
            { id: '3', title: 'Finish with a summary' }
          ]
        }
      });
    }

    const workflowStep = [...messages].reverse().find((message) => String(message.content).includes('Workflow result for mark_step'));
    if (!workflowStep) {
      return JSON.stringify({
        reason: 'Smoke test should advance one visible step before using a tool.',
        action: 'mark_step',
        args: {
          id: '2',
          status: 'in_progress',
          note: 'Inspecting workspace status next.'
        }
      });
    }

    const allContent = messages.map((message) => String(message.content)).join('\n');
    const taskContent = messages.find((message) => message.role === 'user' && String(message.content).includes('Task:'))?.content ?? '';
    const approvalResult = allContent.includes('Workflow result for request_approval');
    if (/approval/i.test(taskContent) && !approvalResult) {
      return JSON.stringify({
        reason: 'Smoke test should exercise the approval channel.',
        action: 'request_approval',
        args: {
          question: 'Approve the mock approval smoke test?',
          proposedAction: 'Continue after confirming the approval request path works.',
          reason: 'The task asked to test approval.'
        }
      });
    }

    if (approvalResult) {
      return JSON.stringify({
        reason: 'Smoke test observed approval resolution and can finish.',
        action: 'final',
        summary: 'Mock approval smoke completed.',
        changedFiles: [],
        tests: [],
        notes: ['Approval request path resolved.']
      });
    }

    const toolResult = [...messages].reverse().find((message) => String(message.content).includes('Tool result for'));
    if (toolResult) {
      return JSON.stringify({
        reason: 'Smoke test has observed a tool result and can finish.',
        action: 'final',
        summary: 'Mock provider completed the smoke task.',
        changedFiles: [],
        tests: [],
        notes: ['Provider wiring, tool loop, and JSON parsing are alive.']
      });
    }

    return JSON.stringify({
      reason: 'Smoke test should inspect the workspace before finishing.',
      action: 'workspace_status',
      args: {}
    });
  }
}

export function createProvider(config) {
  if (config.provider.type === 'mock') {
    return new MockProvider();
  }

  return new OpenAICompatibleProvider(config);
}
