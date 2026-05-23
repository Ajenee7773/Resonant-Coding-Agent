import { buildHarnessPrompt, loadHarnessSnapshot } from './harness.js';
import { emitSignal, say } from './session.js';

function truncateForModel(value, max = 40000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function stripCodeFence(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseAgentJson(raw) {
  const text = stripCodeFence(raw);

  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error('Assistant response was not valid JSON.');
  }
}

function buildSystemPrompt(config, tools, harnessPrompt) {
  const parts = [
    'You are Resonant Code Agent, a local-first software engineering agent.',
    '',
    'Harness:',
    `- Harness path: ${config.agent.harnessPath || 'harness'}`,
    '- The harness is the agent second brain. Load it when the operator asks, when continuity is needed, or during wake/alignment.',
    '- Source libraries are one-time/full-wake study material unless the operator asks for a fresh study pass.',
    '',
    'Workspace:',
    config.agent.workspace,
    '',
    'Protocol:',
    '- Return exactly one JSON object. No markdown, no code fence, no prose outside JSON.',
    '- Use one action per response.',
    '- Keep "reason" short: one sentence about why this action is next.',
    '- For non-trivial work, start with action "plan": give a short goal and ordered steps.',
    '- Execute one step at a time. Use "mark_step" when a step changes state.',
    '- Use "request_approval" when you judge the operator should confirm direction, cost, scope, irreversible action, or a major write.',
    '- Approval is an agency/coordination channel, not a restraint. Decide when to use it.',
    '- Prefer read_file/search/list_files before editing.',
    '- Prefer replace_in_file for targeted edits after reading the file.',
    '- Use write_file for new files or full rewrites only when that is the cleanest move.',
    '- Run the narrowest useful check after edits.',
    '- Use judgment. The agent is expected to understand scope, consent, and consequence without a hardcoded rule cage.',
    '- Write self-authored synthesis into harness/brain and continuity into harness/memory when the work calls for it.',
    '- Finish with action "final" when the task is handled or blocked.',
    '',
    'Available actions:',
    JSON.stringify([
      {
        action: 'plan',
        args: {
          goal: 'Short goal',
          steps: [
            { id: '1', title: 'Inspect project shape' },
            { id: '2', title: 'Make focused change' },
            { id: '3', title: 'Verify result' }
          ]
        },
        result: 'Records an operator-visible plan.'
      },
      {
        action: 'mark_step',
        args: { id: '1', status: 'in_progress', note: 'Reading files now.' },
        result: 'Updates one visible plan step. Status values: pending, in_progress, completed, skipped.'
      },
      {
        action: 'request_approval',
        args: {
          question: 'May I rewrite this file?',
          proposedAction: 'Rewrite README.md to match the new architecture.',
          reason: 'This is a broad visible change.'
        },
        result: 'Asks the operator for yes/no approval when available.'
      },
      ...tools.listToolDescriptions()
    ], null, 2),
    '',
    'Response examples:',
    '{"reason":"This needs a clear work order before edits.","action":"plan","args":{"goal":"Add workflow support","steps":[{"id":"1","title":"Inspect agent loop"},{"id":"2","title":"Add planning actions"},{"id":"3","title":"Run checks"}]}}',
    '{"reason":"I need to inspect the workspace shape first.","action":"workspace_status","args":{}}',
    '{"reason":"The task is complete.","action":"final","summary":"...","changedFiles":["src/file.js"],"tests":["npm run check"],"notes":[]}'
  ];

  if (harnessPrompt?.trim()) {
    parts.splice(6, 0, '', 'Explicitly loaded harness material:', harnessPrompt.trim());
  }

  return parts.join('\n');
}

export class ResonantCodeAgent {
  constructor({ config, provider, tools, journal, approvalHandler = null }) {
    this.config = config;
    this.provider = provider;
    this.tools = tools;
    this.journal = journal;
    this.approvalHandler = approvalHandler;
    this.plan = null;
  }

  async runTask(task, { recovery = '', includeHarness = false, includeSourceLibrary = false } = {}) {
    let harnessPrompt = '';
    if (includeHarness) {
      const harnessSnapshot = await loadHarnessSnapshot(this.config, {
        includeSource: includeSourceLibrary
      });
      harnessPrompt = buildHarnessPrompt(harnessSnapshot);
      await this.journal?.append('harness.loaded', {
        root: harnessSnapshot.root,
        coreFiles: harnessSnapshot.loaded.map((file) => file.path),
        sourceFiles: harnessSnapshot.sourceFiles,
        loadedSourceFiles: harnessSnapshot.loadedSource.map((file) => file.path),
        sourceLoaded: harnessSnapshot.sourceLoaded,
        truncated: harnessSnapshot.truncated
      });
      emitSignal(this.config, 'harness_loaded', {
        root: harnessSnapshot.root,
        coreFiles: harnessSnapshot.loaded.length,
        sourceFiles: harnessSnapshot.sourceFiles.length,
        loadedSourceFiles: harnessSnapshot.loadedSource.length,
        sourceLoaded: harnessSnapshot.sourceLoaded,
        truncated: harnessSnapshot.truncated
      });
    }

    const messages = [
      {
        role: 'system',
        content: buildSystemPrompt(this.config, this.tools, harnessPrompt)
      },
      {
        role: 'user',
        content: [
          'Task:',
          task,
          '',
          recovery ? `Recovery context:\n${recovery}` : '',
          '',
          'Begin.'
        ].join('\n')
      }
    ];

    await this.journal?.append('task.start', { task });
    emitSignal(this.config, 'task_started', { task });

    for (let turn = 1; turn <= this.config.agent.maxTurns; turn += 1) {
      emitSignal(this.config, 'model_turn_started', { turn });

      let raw;
      try {
        raw = await this.provider.complete(messages);
      } catch (error) {
        await this.journal?.append('provider.error', { message: error.message, details: error.details ?? {} });
        emitSignal(this.config, 'provider_error', { message: error.message });
        say(this.config, `provider error: ${error.message}`);
        return {
          ok: false,
          summary: error.message,
          changedFiles: [],
          tests: [],
          notes: ['Provider request failed before task completion.']
        };
      }

      await this.journal?.append('assistant.raw', { turn, raw });
      messages.push({ role: 'assistant', content: raw });

      let action;
      try {
        action = parseAgentJson(raw);
      } catch (error) {
        messages.push({
          role: 'user',
          content: `Your previous response was invalid JSON: ${error.message}. Return exactly one JSON object using the action protocol.`
        });
        continue;
      }

      if (!action || typeof action.action !== 'string') {
        messages.push({
          role: 'user',
          content: 'Your JSON must include a string field named "action". Try again.'
        });
        continue;
      }

      if (action.action === 'final') {
        const finalResult = {
          ok: true,
          summary: action.summary ?? action.reason ?? 'Task complete.',
          changedFiles: action.changedFiles ?? [],
          tests: action.tests ?? [],
          notes: action.notes ?? []
        };
        await this.journal?.append('task.final', finalResult);
        emitSignal(this.config, 'task_completed', finalResult);
        say(this.config, finalResult.summary);
        return finalResult;
      }

      const workflowResult = await this.handleWorkflowAction(action);
      if (workflowResult) {
        messages.push({
          role: 'user',
          content: [
            `Workflow result for ${action.action}:`,
            truncateForModel(workflowResult),
            '',
            'Continue with the next JSON action.'
          ].join('\n')
        });
        continue;
      }

      emitSignal(this.config, 'tool_started', {
        turn,
        action: action.action,
        reason: action.reason ?? ''
      });

      const result = await this.tools.run(action.action, action.args ?? {});
      emitSignal(this.config, 'tool_finished', {
        turn,
        action: action.action,
        ok: result.ok
      });

      messages.push({
        role: 'user',
        content: [
          `Tool result for ${action.action}:`,
          truncateForModel(result),
          '',
          'Continue with the next JSON action.'
        ].join('\n')
      });
    }

    const finalResult = {
      ok: false,
      summary: `Stopped after maxTurns=${this.config.agent.maxTurns}.`,
      changedFiles: [],
      tests: [],
      notes: ['Increase agent.maxTurns or narrow the task.']
    };
    await this.journal?.append('task.max_turns', finalResult);
    emitSignal(this.config, 'task_stopped', finalResult);
    say(this.config, finalResult.summary);
    return finalResult;
  }

  async handleWorkflowAction(action) {
    if (action.action === 'plan') {
      const args = action.args ?? {};
      const steps = Array.isArray(args.steps) ? args.steps : [];
      this.plan = {
        goal: args.goal ?? 'Task plan',
        steps: steps.map((step, index) => ({
          id: String(step.id ?? index + 1),
          title: step.title ?? step.description ?? `Step ${index + 1}`,
          status: step.status ?? 'pending',
          note: step.note ?? ''
        }))
      };
      await this.journal?.append('workflow.plan', this.plan);
      emitSignal(this.config, 'workflow_plan', this.plan);
      say(this.config, `plan: ${this.plan.goal}`);
      for (const step of this.plan.steps) {
        say(this.config, `${step.id}. ${step.title}`);
      }
      return { ok: true, plan: this.plan };
    }

    if (action.action === 'mark_step') {
      const args = action.args ?? {};
      const id = String(args.id ?? '');
      const status = args.status ?? 'in_progress';
      const note = args.note ?? '';
      if (this.plan) {
        const step = this.plan.steps.find((candidate) => candidate.id === id);
        if (step) {
          step.status = status;
          step.note = note;
        }
      }
      const result = { ok: true, id, status, note, plan: this.plan };
      await this.journal?.append('workflow.step', result);
      emitSignal(this.config, 'workflow_step', result);
      say(this.config, `step ${id}: ${status}${note ? ` - ${note}` : ''}`);
      return result;
    }

    if (action.action === 'request_approval') {
      const args = action.args ?? {};
      const request = {
        question: args.question ?? 'Approve this action?',
        proposedAction: args.proposedAction ?? '',
        reason: args.reason ?? '',
        at: new Date().toISOString()
      };
      emitSignal(this.config, 'approval_requested', request);
      await this.journal?.append('approval.requested', request);

      let response;
      if (this.approvalHandler) {
        response = await this.approvalHandler(request);
      } else {
        response = {
          approved: false,
          answer: 'unavailable',
          note: 'No interactive approval handler is available in this run.'
        };
      }

      const result = { ok: true, request, response };
      await this.journal?.append('approval.resolved', result);
      emitSignal(this.config, 'approval_resolved', result);
      return result;
    }

    return null;
  }
}
