#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig, publicConfig } from './config.js';
import { createProvider } from './provider.js';
import { ResonantCodeAgent } from './agent.js';
import { SessionJournal, emitSignal, say } from './session.js';
import { ToolRegistry } from './tools.js';
import { ensureHarness, wakeTaskText } from './harness.js';

function printHelp() {
  process.stdout.write(`Resonant Code Agent

Usage:
  node src/cli.js [--task "do work"] [options]

Options:
  --task <text>       Run one task and exit.
  --workspace <path>  Workspace the agent may read/write.
  --config <path>     JSON config path.
  --base-url <url>    OpenAI-compatible base URL.
  --model <name>      Model name.
  --api-key-env <n>   Environment variable containing API key.
  --max-turns <n>     Maximum model/tool turns.
  --wake              Run the full harness wake protocol and exit.
  --yes               Auto-approve agent approval requests for one-shot runs.
  --mock              Use offline mock provider.
  --help              Show this help.

Interactive commands:
  /status
  /wake
  /exit
`);
}

function parseArgs(argv) {
  const out = { task: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--task':
      case '-t':
        out.task = argv[++i] ?? '';
        break;
      case '--workspace':
        out.workspace = argv[++i] ?? '';
        break;
      case '--config':
        out.config = argv[++i] ?? '';
        break;
      case '--base-url':
        out.baseUrl = argv[++i] ?? '';
        break;
      case '--model':
        out.model = argv[++i] ?? '';
        break;
      case '--api-key-env':
        out.apiKeyEnv = argv[++i] ?? '';
        break;
      case '--max-turns':
        out.maxTurns = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--wake':
        out.wake = true;
        break;
      case '--yes':
      case '-y':
        out.yes = true;
        break;
      case '--mock':
        out.mock = true;
        break;
      default:
        if (!out.task) {
          out.task = arg;
        } else {
          out.task = `${out.task} ${arg}`;
        }
    }
  }
  return out;
}

async function createRuntime(args) {
  const config = await loadConfig({
    cwd: process.cwd(),
    configPath: args.config,
    cli: {
      workspace: args.workspace,
      baseUrl: args.baseUrl,
      model: args.model,
      apiKeyEnv: args.apiKeyEnv,
      maxTurns: Number.isFinite(args.maxTurns) ? args.maxTurns : null,
      mock: args.mock
    }
  });
  const journal = new SessionJournal(config);
  await journal.ready();
  await ensureHarness(config, journal);
  const provider = createProvider(config);
  const tools = new ToolRegistry(config, journal);
  const agent = new ResonantCodeAgent({ config, provider, tools, journal });
  return { config, journal, agent };
}

function createRecoveryCollector() {
  return {
    active: false,
    lines: [],
    last: '',
    push(line) {
      if (line.trim() === '[RECOVERY PACKAGE]') {
        this.active = true;
        this.lines = [line];
        return true;
      }
      if (!this.active) {
        return false;
      }
      this.lines.push(line);
      if (line.trim() === '[END RECOVERY PACKAGE]') {
        this.active = false;
        this.last = this.lines.join('\n');
        this.lines = [];
      }
      return true;
    }
  };
}

async function runInteractive(runtime) {
  const { config, agent } = runtime;
  const recovery = createRecoveryCollector();
  let pendingApproval = null;

  agent.approvalHandler = async (request) => {
    say(config, `approval requested: ${request.question}`);
    if (request.proposedAction) {
      say(config, `proposed: ${request.proposedAction}`);
    }
    if (request.reason) {
      say(config, `reason: ${request.reason}`);
    }
    say(config, 'answer yes or no.');

    return new Promise((resolve) => {
      pendingApproval = resolve;
    });
  };

  emitSignal(config, 'ready', publicConfig(config));
  say(config, 'online. Send a coding task, /status, or /exit.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let busy = false;
  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) {
      return;
    }

    if (pendingApproval) {
      const approved = /^(y|yes|approve|approved)$/i.test(message);
      const response = {
        approved,
        answer: message,
        note: approved ? 'Operator approved.' : 'Operator did not approve.'
      };
      const resolve = pendingApproval;
      pendingApproval = null;
      resolve(response);
      return;
    }

    if (recovery.push(line)) {
      if (!recovery.active && recovery.last) {
        emitSignal(config, 'recovery_loaded', { chars: recovery.last.length });
        say(config, 'recovery package loaded.');
      }
      return;
    }

    if (message === '/exit') {
      emitSignal(config, 'shutdown', { reason: 'operator_exit' });
      rl.close();
      return;
    }

    if (message === '/status') {
      emitSignal(config, 'status', publicConfig(config));
      say(config, JSON.stringify(publicConfig(config)));
      return;
    }

    const isWake = message === '/wake';
    const task = isWake ? wakeTaskText() : message;

    if (busy) {
      say(config, 'busy on the current task. Send another task after completion.');
      return;
    }

    busy = true;
    try {
      await agent.runTask(task, {
        recovery: recovery.last,
        includeHarness: isWake,
        includeSourceLibrary: isWake
      });
    } finally {
      busy = false;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const runtime = await createRuntime(args);
  const { config, agent } = runtime;
  if (args.yes) {
    agent.approvalHandler = async (request) => ({
      approved: true,
      answer: 'yes',
      note: `Auto-approved by --yes for: ${request.question}`
    });
  }

  process.on('SIGTERM', () => {
    emitSignal(config, 'shutdown', { reason: 'SIGTERM' });
    process.exit(0);
  });
  process.on('SIGINT', () => {
    emitSignal(config, 'shutdown', { reason: 'SIGINT' });
    process.exit(0);
  });

  if (args.wake || args.task) {
    emitSignal(config, 'ready', publicConfig(config));
    const result = await agent.runTask(args.wake ? wakeTaskText() : args.task, {
      includeHarness: Boolean(args.wake),
      includeSourceLibrary: Boolean(args.wake)
    });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  await runInteractive(runtime);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
