import fsp from 'node:fs/promises';
import path from 'node:path';

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function emitSignal(config, type, payload = {}) {
  if (!config.mesh?.emitRaosSignals) {
    return;
  }

  const event = {
    type,
    payload,
    at: new Date().toISOString()
  };
  process.stdout.write(`RAOS ${JSON.stringify(event)}\n`);
}

export function say(config, content) {
  process.stdout.write(`${config.mesh?.agentName ?? 'Resonant Code Agent'}: ${content}\n`);
}

export class SessionJournal {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.agent.workspace, '.resonant-code-agent');
    this.sessionDir = path.join(this.root, 'sessions');
    this.sessionPath = path.join(this.sessionDir, `${timestampForFile()}.jsonl`);
  }

  async ready() {
    await fsp.mkdir(this.sessionDir, { recursive: true });
  }

  async append(type, payload = {}) {
    await this.ready();
    const event = {
      type,
      payload,
      at: new Date().toISOString()
    };
    await fsp.appendFile(this.sessionPath, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }
}
