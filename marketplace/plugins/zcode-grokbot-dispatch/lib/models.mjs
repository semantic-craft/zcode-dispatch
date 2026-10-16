/**
 * Model selection for every Grok Bot <-> ZCode dispatch (user decision 2026-10-16):
 *   default = GLM-5.3 Flash, using ZCode's own model id
 *   `account:bigmodel-individual-coding-plan/GLM-5.3-Flash` (providerId/modelId, exactly as ZCode
 *   reports it in automation_runs.model_selection, tasks.model and the CLI stream `payload.providerId/modelId`).
 *   Any other model only when the dispatch names one explicitly (`model` field / --model).
 *
 * The id is checked against the model list ZCode itself publishes for the signed-in account
 * (its provider catalog `providerRules[].config.builtinModelIds`, minus models the user disabled in
 * `~/.zcode/v2/provider_config.json` modelConfigRules). An unknown/disabled model is a hard error;
 * there is no silent fallback to another model.
 * Overrides: ZCODE_DISPATCH_DEFAULT_MODEL (or config "defaultModel"), ZCODE_PROVIDER_CATALOG, ZCODE_PROVIDER_CONFIG.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from './netconfig.mjs';

export const BUILTIN_DEFAULT_MODEL = 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash';
export class ModelError extends Error {
  constructor(msg) { super(`[zcode-dispatch] model check failed: ${msg}`); }
}

export function defaultModel(env = process.env) {
  return (env.ZCODE_DISPATCH_DEFAULT_MODEL || readConfigFile().defaultModel || BUILTIN_DEFAULT_MODEL).trim();
}

export function parseModel(id) {
  const m = /^([^/\s]+)\/([^/\s$]+)(?:\$[a-z]+)?$/.exec(String(id || '').trim());
  if (!m) throw new ModelError(`"${id}" is not a ZCode model id (expected <providerId>/<modelId>, e.g. ${BUILTIN_DEFAULT_MODEL})`);
  return { providerId: m[1], modelId: m[2], id: `${m[1]}/${m[2]}` };
}

/** Newest ZCode provider catalog (written by ZCode itself under ~/.zcode/v2/runtime/provider). */
export function catalogPath(env = process.env) {
  if (env.ZCODE_PROVIDER_CATALOG) return env.ZCODE_PROVIDER_CATALOG;
  const root = path.join(env.HOME || os.homedir(), '.zcode', 'v2', 'runtime', 'provider');
  const found = [];
  const walk = (d, depth) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'zcode-builtin.json') found.push({ p, t: fs.statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.t - a.t);
  return found[0]?.p ?? null;
}

/** ZCode's self-reported available model ids: ["providerId/modelId", ...]. Throws ModelError if unreadable. */
export function availableModels(env = process.env) {
  const cat = catalogPath(env);
  if (!cat) throw new ModelError('ZCode provider catalog not found (~/.zcode/v2/runtime/provider/**/zcode-builtin.json); open ZCode.app once, or set ZCODE_PROVIDER_CATALOG');
  let rules;
  try { rules = JSON.parse(fs.readFileSync(cat, 'utf8'))?.config?.providerConfigRules?.providerRules; } catch (e) { throw new ModelError(`cannot read ZCode provider catalog ${cat}: ${e.message}`); }
  if (!Array.isArray(rules)) throw new ModelError(`ZCode provider catalog ${cat} has no config.providerConfigRules.providerRules (ZCode changed its format; update lib/models.mjs)`);
  const disabled = new Set();
  const pc = env.ZCODE_PROVIDER_CONFIG || path.join(env.HOME || os.homedir(), '.zcode', 'v2', 'provider_config.json');
  try {
    const r = JSON.parse(fs.readFileSync(pc, 'utf8'))?.config?.modelConfigRules?.providerModelRules;
    if (Array.isArray(r)) for (const x of r) if (x?.config?.enabled === false) disabled.add(`${x.providerId}/${x.modelId}`);
  } catch {}
  const out = [];
  for (const r of rules) for (const m of r?.config?.builtinModelIds || []) { const id = `${r.providerId}/${m}`; if (!disabled.has(id)) out.push(id); }
  return out;
}

/** Resolve the model for one dispatch: explicit `requested` wins, else the default. Throws ModelError if ZCode does not offer it. */
export function resolveModel(requested, { env = process.env, available } = {}) {
  const explicit = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  const m = parseModel(explicit || defaultModel(env));
  const list = available ?? availableModels(env);
  if (!list.includes(m.id)) {
    const same = list.filter(x => x.startsWith(m.providerId + '/'));
    throw new ModelError(`${explicit ? 'requested' : 'default'} model ${m.id} is not offered by this ZCode install` +
      ` (available for ${m.providerId}: ${same.join(', ') || 'none'}). Not falling back to another model.`);
  }
  return { ...m, explicit: Boolean(explicit) };
}

/** True when ZCode's reported session model (e.g. "account:x/GLM-5.3-Flash$max") is the requested id. */
export function sameModel(reported, wanted) {
  if (!reported || !wanted) return false;
  return String(reported).replace(/\$[a-z]+$/, '') === String(wanted);
}
