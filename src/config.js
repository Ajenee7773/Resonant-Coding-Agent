import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'resonant-code-agent.config.json';

const DEFAULTS = {
  provider: {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    apiKeyEnv: 'RCA_API_KEY',
    timeoutMs: 120000,
    request: {
      temperature: 0.1
    },
    headers: {}
  },
  agent: {
    maxTurns: 30,
    maxReadBytes: 120000,
    maxHarnessBytes: 120000,
    maxSourceLibraryBytes: 320000,
    maxCommandOutputBytes: 24000,
    harnessPath: 'harness'
  },
  mesh: {
    agentName: 'Resonant Code Agent',
    emitRaosSignals: true
  }
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, overlay) {
  const out = { ...base };

  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

function envInt(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveApiKey(provider) {
  if (provider.apiKey) {
    return provider.apiKey;
  }

  const requestedEnv = provider.apiKeyEnv && process.env[provider.apiKeyEnv];
  if (requestedEnv) {
    return requestedEnv;
  }

  const baseUrl = String(provider.baseUrl ?? '').toLowerCase();
  if (baseUrl.includes('deepseek') && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }

  if (baseUrl.includes('openai') && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  if (process.env.RCA_API_KEY) {
    return process.env.RCA_API_KEY;
  }

  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
    return 'local';
  }

  return '';
}

export async function loadConfig({ cwd = process.cwd(), configPath = '', cli = {} } = {}) {
  const workspace = path.resolve(cli.workspace || process.env.RCA_WORKSPACE || cwd);
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : path.join(workspace, DEFAULT_CONFIG_FILE);

  const fileConfig = readJsonFile(resolvedConfigPath);
  const config = deepMerge(DEFAULTS, fileConfig);

  config.configPath = fs.existsSync(resolvedConfigPath) ? resolvedConfigPath : null;
  config.agent.workspace = workspace;

  if (process.env.RCA_BASE_URL) {
    config.provider.baseUrl = process.env.RCA_BASE_URL;
  }
  if (process.env.RCA_MODEL) {
    config.provider.model = process.env.RCA_MODEL;
  }
  if (process.env.RCA_API_KEY_ENV) {
    config.provider.apiKeyEnv = process.env.RCA_API_KEY_ENV;
  }

  const envMaxTurns = envInt('RCA_MAX_TURNS');
  if (envMaxTurns) {
    config.agent.maxTurns = envMaxTurns;
  }

  if (cli.baseUrl) {
    config.provider.baseUrl = cli.baseUrl;
  }
  if (cli.model) {
    config.provider.model = cli.model;
  }
  if (cli.apiKeyEnv) {
    config.provider.apiKeyEnv = cli.apiKeyEnv;
  }
  if (cli.maxTurns) {
    config.agent.maxTurns = cli.maxTurns;
  }
  if (cli.mock) {
    config.provider.type = 'mock';
  }

  config.provider.apiKey = resolveApiKey(config.provider);
  config.agent.workspace = path.resolve(config.agent.workspace);
  config.agent.charterPath = path.resolve(config.agent.workspace, config.agent.charterPath || 'RESONANT_CODE_AGENT.md');
  config.agent.harnessPath = config.agent.harnessPath || 'harness';

  await fsp.mkdir(config.agent.workspace, { recursive: true });
  return config;
}

export function publicConfig(config) {
  return {
    configPath: config.configPath,
    provider: {
      type: config.provider.type,
      baseUrl: config.provider.baseUrl,
      model: config.provider.model,
      hasApiKey: Boolean(config.provider.apiKey)
    },
    agent: {
      workspace: config.agent.workspace,
      harnessPath: config.agent.harnessPath,
      maxTurns: config.agent.maxTurns
    },
    mesh: config.mesh
  };
}
