import { readFileSync, statSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

function createUserMessage(input) {
  return Object.freeze({ ...input, id: randomUUID(), role: 'user',
    content: Object.freeze(input.content.map(block => Object.freeze({ ...block }))),
    source: Object.freeze({ ...input.source }) });
}

export const name = 'prompt-forge';
export const inject = ['systemPrompt'];
const FILES = ['system.md', 'runtime-context.md', 'turn-reminder.md', 'agents-reminder.md'];
const SYSTEM_SECTION = 'prompt-forge:system';
// A file whose whole content is this token declines the forged prompt, so a
// project can keep the Harness prompt while a global system.md exists.
const NATIVE = '{{default}}';
const DEFAULT_TEMPLATE = '遵守以下工作区指令。更具体目录中的指令优先于上级目录中的指令。\n\n{{instructions}}';
const INTRO = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';
const ADDITIONAL = /(^Additional instructions from: [^\n]+\n\n)These instructions apply to work under `([^`]+)`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions\./;

export function rewriteReminder(text, template) {
  if (!text.startsWith('<system-reminder>') || !text.endsWith('</system-reminder>')) return text;
  if (!template.includes('{{instructions}}')) throw new Error('agents-reminder.md must contain {{instructions}}');
  let body = text.slice('<system-reminder>'.length, -'</system-reminder>'.length).trim();
  // Only remove generated framing. File contents remain byte-for-byte intact.
  const paragraphs = body.split('\n\n');
  const introIndex = paragraphs[0]?.startsWith('Workspace instruction budget ') ? 1 : 0;
  const replacement = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ';
  if (paragraphs[introIndex] === INTRO) paragraphs.splice(introIndex, 1);
  else if (paragraphs[introIndex] === replacement + INTRO) paragraphs[introIndex] = replacement.trimEnd();
  body = paragraphs.join('\n\n');
  // Match only the first generated reconciliation header, not text inside instruction files.
  if (body.startsWith('Additional instructions from: ')) body = body.replace(ADDITIONAL, '$1These instructions apply to work under `$2`.');
  return '<system-reminder>\n' + template.replaceAll('{{instructions}}', () => body).replaceAll('</system-reminder>', '<\\/system-reminder>') + '\n</system-reminder>';
}

export function apply(ctx, config = {}) {
  const home = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const cache = new Map();
  const watchers = new Map();
  const lastReminder = new WeakMap();
  const lastSystem = new WeakMap();
  let disposed = false;
  let timer;
  const directories = new Set();
  const arm = () => {
    const needed = new Set();
    for (const directory of directories) {
      let path = directory;
      while (true) {
        try { if (statSync(path).isDirectory()) { needed.add(path); break; } }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = dirname(path);
        if (parent === path) break;
        path = parent;
      }
    }
    for (const [path, watcher] of watchers) if (!needed.has(path)) { watcher.close(); watchers.delete(path); }
    for (const path of needed) if (!watchers.has(path)) {
      const watcher = watch(path, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed) return;
          cache.clear();
          arm();
          ctx.emit('system-prompt/change');
        }, 40);
      });
      watcher.on('error', error => { cache.clear(); console.error('[prompt-forge] watcher:', error); });
      watchers.set(path, watcher);
    }
  };
  const read = path => {
    if (cache.has(path)) return cache.get(path);
    let text;
    try {
      if (statSync(path).size > 1024 * 1024) throw new Error(`Prompt file exceeds 1 MiB: ${path}`);
      text = readFileSync(path, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cache.set(path, text);
    return text;
  };
  // A file that exists but holds only whitespace counts as absent: a blank
  // placeholder must not shadow the other scope's file nor suppress the prompt.
  const pick = path => {
    const text = read(path);
    return text !== undefined && text.trim() ? text : undefined;
  };
  const values = agent => {
    const global = join(home, 'prompts');
    const local = join(resolve(agent?.session.header.cwd ?? process.cwd()), '.dsh', 'prompts');
    let changed = false;
    for (const path of [global, local]) if (!directories.has(path)) { directories.add(path); changed = true; }
    if (changed) arm();
    const files = Object.fromEntries(FILES.map(file => [file, pick(join(local, file)) ?? pick(join(global, file)) ?? '']));
    // Expand only our supported system variable; leave template examples intact.
    const cwd = resolve(agent?.session.header.cwd ?? process.cwd());
    files['system.md'] = files['system.md'].replaceAll('{{cwd}}', () => cwd);
    // A file holding only this token keeps the Harness prompt, which is how a
    // project declines a global system.md now that a blank file means absent.
    if (files['system.md'].trim() === NATIVE) files['system.md'] = '';
    return files;
  };
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear(); cache.clear(); directories.clear();
  }, 'prompt-forge.file-watchers');
  // A preset may own the whole prompt through a `complete` section of its own,
  // and the assembler restores that section after this waterfall, so a
  // system.md that looks effective would be dropped without a trace. No public
  // call enumerates the sections of a scope, so read the registry's own layers;
  // the version compatibility declaration is what pins that shape.
  const completeOwner = scope => {
    const sections = ctx.systemPrompt.layers?.merge(scope, layer => layer.sections);
    if (sections === undefined) return undefined;
    for (const section of sections.values()) if (section.complete === true) return section.name;
    return undefined;
  };
  // Replacing the whole prompt cannot be declared at registration time: a
  // `complete` section is fixed once registered, so a user who never creates
  // system.md could not get the Harness prompt back without a reload. Deciding
  // per assembly keeps the native prompt until there is text to replace it, and
  // the spread leaves tools, runtime contexts and variables untouched.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = await next();
    const text = values(context.agent)['system.md'];
    if (!text.trim()) return resolved;
    const owner = completeOwner(context.scope);
    if (owner !== undefined) throw new Error(`prompt-forge: system.md cannot take effect while the complete prompt section "${owner}" is active; use a preset without a complete prompt section, or delete system.md`);
    return { ...resolved, sections: [{ name: SYSTEM_SECTION, text, interpolate: false }] };
  }, { prepend: true });
  ctx.systemPrompt.context({ name: 'prompt-forge:runtime', order: 130, text: context => values(context.agent)['runtime-context.md'] });
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    signal.throwIfAborted();
    const files = values(agent);
    const template = files['agents-reminder.md'] || DEFAULT_TEMPLATE;
    const messages = decision.messages.map(message => {
      if (message.source?.kind !== 'agent-instructions') return message;
      return { ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: rewriteReminder(block.text, template) } : block) };
    });
    const text = files['turn-reminder.md'];
    const previous = lastReminder.get(agent);
    if (text && !(step === 1 && messages.length === 0) && (previous?.turn !== turn || previous.text !== text)) {
      messages.push(createUserMessage({ content: [{ type: 'text', text: '<system-reminder>\n' + text.replaceAll('</system-reminder>', '<\\/system-reminder>') + '\n</system-reminder>' }], source: { kind: 'prompt-forge', form: 'instructions' } }));
      lastReminder.set(agent, { turn, text });
    }
    // Start a new series when the complete prompt changes, so in-history
    // routes replace the surviving system head instead of appending updates.
    const systemText = files['system.md'];
    const replaceSystem = lastSystem.get(agent) !== systemText;
    lastSystem.set(agent, systemText);
    return { ...decision, messages, ...(replaceSystem ? { startsRequestSeries: true } : {}) };
  }, { prepend: true });
}
