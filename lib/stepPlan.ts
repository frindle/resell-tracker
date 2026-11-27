// Step plans for the browser extension: DATA only (docs/step-plans.md in the extension repo).
// The file is config/plans.json, served with its Ed25519 signature (config/plans.json.sig) by
// GET /api/extension/plans. This validator is a mirror of the extension's src/lib/stepPlan.ts:
// the two MUST change together (rules, caps, allowlists, failure codes). An invalid file is
// logged at load and answered with a 500, like the scrape config.
import { createHash } from 'node:crypto';
import { verifyExtensionSecret } from './extensionAuth.ts';
import { etagMatches } from './scrapeConfig.ts';

export type PlanOpened = 'new-tab' | 'same-tab' | 'kept-in-tab';

// ---- bundled caps and allowlists (a plan can only lower the caps, never widen the lists) ----

export const PLAN_CAPS = { steps: 600, repeat: 100, runMs: 1_200_000, tabs: 4 } as const;
export type PlanLimits = { steps?: number; repeat?: number; runMs?: number; tabs?: number };

/** Hosts a plan may open and act on: today's host_permissions minus the tracker. */
export const PLAN_HOST_ALLOWLIST: readonly string[] = ['www.memberedelivery.com'];

/** Named tracker endpoints a `post` step may use. A plan never supplies a path. */
export const PLAN_ENDPOINTS: Readonly<Record<string, string>> = { egift: '/api/extension/egift' };

/** Command inputs a plan may declare, and the only values `open` and `fill` may take. */
export const PLAN_INPUTS = ['link', 'email', 'orderId'] as const;
const VALUE_INPUTS = ['link', 'email'];

/** Element text a click refuses (case-insensitive), whatever the plan says. */
export const CLICK_DENY_SOURCE = '\\b(?:cancel|delete|remove|place\\s+order|buy|pay|return|sign\\s*out)';
export function clickDenied(text: string): boolean {
  return new RegExp(CLICK_DENY_SOURCE, 'i').test(text);
}

/** The only failure text a plan can make a run report. */
export const PLAN_FAILURE_CODES = [
  'page-timeout', 'bot-check', 'email-rejected', 'email-no-response', 'no-open-button', 'out-of-sequence', 'total-mismatch',
  'ended-early', 'save-failed', 'link-rejected', 'click-denied', 'plan-failed',
] as const;
export type PlanCode = typeof PLAN_FAILURE_CODES[number];

// ---- plan types ----

export interface PlanPage { clickables: string; labelCells: string; alert: string; alertText: string; botCheck: string; botCheckText: string }
export interface Cond {
  exists?: string; clickable?: string; label?: string; text?: string; alert?: true; counterAtEnd?: true;
  /** With `label`: the labelled value differs from the last one a read step saw. */
  changed?: true;
}
export interface FieldSpec { label?: string; selector?: string; regex?: string }
export interface Timing { pollMs: number; waitMs: number; newTabWaitMs: number }

interface Base { id: string }
export interface OpenStep extends Base { do: 'open'; url: string }
export interface WaitStep extends Base {
  do: 'wait';
  any?: { when: Cond; go: string; opened?: PlanOpened }[];
  until?: Cond;
  timeout: PlanCode;
  /** Failure code on the first pass of a repeat. */
  timeoutFirst?: PlanCode;
  /** On a timeout, this code instead when the last page state matched `when`. */
  timeoutAlt?: { when: Cond; code: PlanCode };
  alert?: PlanCode;
  timeoutMs?: number;
}
export interface ClickStep extends Base {
  do: 'click'; selector?: string; clickable?: string; orText?: string;
  follow?: 'new-tab-or-same'; landed?: Cond; retryKeepInTab?: boolean; delayMs?: number; else?: PlanCode;
}
export interface FillStep extends Base {
  do: 'fill'; selector: string; value: string; submit?: boolean; submitButton?: string; buttons?: string; submitText?: string;
  delayMs?: number; else?: PlanCode;
}
export interface ReadStep extends Base {
  do: 'read'; into: string; all?: string; fields?: Record<string, FieldSpec>; secret?: string[]; parse?: string;
}
export interface ShootStep extends Base { do: 'shoot'; selector: string; into: string }
export interface PostStep extends Base { do: 'post'; to: string; body: Record<string, string>; else?: PlanCode }
export interface RepeatStep extends Base { do: 'repeat'; max: number; steps: Step[]; onMax?: PlanCode }
export interface StopIfStep extends Base { do: 'stopIf'; when: Cond }
export interface GoStep extends Base { do: 'go'; to: string }
export interface FailStep extends Base { do: 'fail'; code: PlanCode }
export type Step = OpenStep | WaitStep | ClickStep | FillStep | ReadStep | ShootStep | PostStep | RepeatStep | StopIfStep | GoStep | FailStep;

export interface Plan {
  hosts: string[];
  inputs: string[];
  limits?: PlanLimits;
  timing?: Partial<Timing>;
  page: PlanPage;
  /** Regex sources the plan's hook uses (card code, PIN, sequence, amount). */
  patterns?: Record<string, string>;
  steps: Step[];
}
export interface PlanFile { version: number; plans: Record<string, Plan> }

export const DEFAULT_TIMING: Timing = { pollMs: 1500, waitMs: 40_000, newTabWaitMs: 10_000 };

export function effectiveLimits(plan: Pick<Plan, 'limits'>): Required<PlanLimits> {
  const l = plan.limits ?? {};
  return {
    steps: Math.min(l.steps ?? PLAN_CAPS.steps, PLAN_CAPS.steps),
    repeat: Math.min(l.repeat ?? PLAN_CAPS.repeat, PLAN_CAPS.repeat),
    runMs: Math.min(l.runMs ?? PLAN_CAPS.runMs, PLAN_CAPS.runMs),
    tabs: Math.min(l.tabs ?? PLAN_CAPS.tabs, PLAN_CAPS.tabs),
  };
}
export function effectiveTiming(plan: Pick<Plan, 'timing'>): Timing {
  return { ...DEFAULT_TIMING, ...(plan.timing ?? {}) };
}

// ---- page function contracts (src/lib/planPage.ts) ----

export interface ProbeReq { page: PlanPage; conds: Cond[] }
export interface ProbeRes {
  /** One per requested condition (a `changed` condition holds when the label is present). */
  hits: boolean[];
  /** The labelled value for a `label` condition (a secret, in memory only), else null. */
  labels: (string | null)[];
  alert: boolean;
  botCheck: boolean;
}
export interface ClickSpec { page: PlanPage; selector?: string; clickable?: string; orText?: string }
export interface FillSpec { selector: string; submit?: boolean; submitButton: string; buttons: string; submitText: string }
export interface ReadSpec { page: PlanPage; fields?: Record<string, FieldSpec>; all?: string }
export interface ReadRes { fields: Record<string, string | null>; all: string[] }

// ---- validator ----

export type PlanCheck = { ok: true } | { ok: false; reason: string };
export type PlanFileCheck = { ok: true; file: PlanFile } | { ok: false; reason: string };

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const MAX_STR = 2000;
const MAX_RX = 500;
const MAX_MS = 300_000;
const OPENED: readonly string[] = ['new-tab', 'same-tab', 'kept-in-tab'];

function isObj(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

class Bad extends Error {}
const bad = (m: string): never => { throw new Bad(m); };

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where}: unknown key "${k}"`);
}
function str(v: unknown, where: string, max = MAX_STR): string {
  if (typeof v !== 'string' || !v || v.length > max) return bad(`${where} must be a non-empty string up to ${max} characters`);
  return v;
}
function rx(v: unknown, where: string): string {
  const s = str(v, where, MAX_RX);
  try { new RegExp(s, 'i'); } catch { bad(`${where} is not a valid regex`); }
  return s;
}
function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return bad(`${where} must be an integer ${min}..${max}`);
  return v;
}
function code(v: unknown, where: string): void {
  if (typeof v !== 'string' || !(PLAN_FAILURE_CODES as readonly string[]).includes(v)) bad(`${where} is not a known failure code`);
}

function cond(v: unknown, where: string, opts: { counter?: boolean } = {}): void {
  if (!isObj(v)) return bad(`${where} must be an object`);
  onlyKeys(v, ['exists', 'clickable', 'label', 'text', 'alert', 'changed', 'counterAtEnd'], where);
  const kinds = ['exists', 'clickable', 'label', 'text', 'alert', 'counterAtEnd'].filter(k => k in v);
  if (kinds.length !== 1) bad(`${where} needs exactly one of exists, clickable, label, text, alert, counterAtEnd`);
  if ('exists' in v) str(v.exists, `${where}.exists`);
  if ('clickable' in v) str(v.clickable, `${where}.clickable`);
  if ('label' in v) str(v.label, `${where}.label`);
  if ('text' in v) rx(v.text, `${where}.text`);
  if ('alert' in v && v.alert !== true) bad(`${where}.alert must be true`);
  if ('counterAtEnd' in v) {
    if (v.counterAtEnd !== true) bad(`${where}.counterAtEnd must be true`);
    if (!opts.counter) bad(`${where}: counterAtEnd is only for stopIf`);
  }
  if ('changed' in v && (v.changed !== true || !('label' in v))) bad(`${where}.changed needs a label condition`);
}

/** `open` and `fill` values: a command input ($link, $email) or plain text; never a page read. */
function inputValue(v: unknown, where: string, inputs: string[]): string {
  const s = str(v, where);
  if (s.includes('$')) {
    const name = /^\$([A-Za-z]+)$/.exec(s)?.[1];
    if (!name || !VALUE_INPUTS.includes(name)) bad(`${where} may only be $link or $email, never a page read`);
    if (!inputs.includes(name as string)) bad(`${where} uses input "${name}" the plan does not declare`);
  }
  return s;
}

type Ctx = { ids: Set<string>; top: Set<string>; plan: Record<string, unknown>; inputs: string[]; hosts: string[]; count: number; vars: Set<string> };

function step(raw: unknown, ctx: Ctx, nested: boolean, inLoop: boolean): void {
  if (!isObj(raw)) return bad('a step must be an object');
  if (++ctx.count > PLAN_CAPS.steps) bad(`more than ${PLAN_CAPS.steps} steps`);
  const id = str(raw.id, 'step id', 48);
  if (!ID_RE.test(id)) bad(`bad step id "${id}"`);
  if (ctx.ids.has(id)) bad(`duplicate step id "${id}"`);
  ctx.ids.add(id);
  const w = `step "${id}"`;
  const d = raw.do;
  switch (d) {
    case 'open': {
      onlyKeys(raw, ['id', 'do', 'url'], w);
      const url = inputValue(raw.url, `${w}.url`, ctx.inputs);
      if (!url.startsWith('$')) {
        let u: URL | null = null;
        try { u = new URL(url); } catch { /* checked below */ }
        if (!u || u.protocol !== 'https:' || !ctx.hosts.includes(u.hostname.toLowerCase())) bad(`${w}.url must be $link or an https URL on a plan host`);
      }
      return;
    }
    case 'wait': {
      onlyKeys(raw, ['id', 'do', 'any', 'until', 'timeout', 'timeoutFirst', 'timeoutAlt', 'alert', 'timeoutMs'], w);
      if (('any' in raw) === ('until' in raw)) bad(`${w} needs exactly one of any, until`);
      if ('any' in raw) {
        if (nested) bad(`${w}: any/go only at the top level`);
        if (!Array.isArray(raw.any) || !raw.any.length || raw.any.length > 12) bad(`${w}.any must be 1..12 entries`);
        for (const [i, a] of (raw.any as unknown[]).entries()) {
          if (!isObj(a)) return bad(`${w}.any[${i}] must be an object`);
          onlyKeys(a, ['when', 'go', 'opened'], `${w}.any[${i}]`);
          cond(a.when, `${w}.any[${i}].when`);
          str(a.go, `${w}.any[${i}].go`, 48);
          if ('opened' in a && !OPENED.includes(a.opened as string)) bad(`${w}.any[${i}].opened is not known`);
        }
      } else cond(raw.until, `${w}.until`);
      code(raw.timeout, `${w}.timeout`);
      if ('timeoutFirst' in raw) code(raw.timeoutFirst, `${w}.timeoutFirst`);
      if ('alert' in raw) code(raw.alert, `${w}.alert`);
      if ('timeoutAlt' in raw) {
        const a = raw.timeoutAlt;
        if (!isObj(a)) return bad(`${w}.timeoutAlt must be an object`);
        onlyKeys(a, ['when', 'code'], `${w}.timeoutAlt`);
        cond(a.when, `${w}.timeoutAlt.when`);
        code(a.code, `${w}.timeoutAlt.code`);
      }
      if ('timeoutMs' in raw) int(raw.timeoutMs, `${w}.timeoutMs`, 1, MAX_MS);
      return;
    }
    case 'click': {
      onlyKeys(raw, ['id', 'do', 'selector', 'clickable', 'orText', 'follow', 'landed', 'retryKeepInTab', 'delayMs', 'else'], w);
      if (!('selector' in raw || 'clickable' in raw || 'orText' in raw)) bad(`${w} needs selector, clickable or orText`);
      if ('selector' in raw) str(raw.selector, `${w}.selector`);
      if ('clickable' in raw) str(raw.clickable, `${w}.clickable`);
      if ('orText' in raw) rx(raw.orText, `${w}.orText`);
      if ('follow' in raw) {
        if (raw.follow !== 'new-tab-or-same') bad(`${w}.follow must be "new-tab-or-same"`);
        if (nested) bad(`${w}: follow only at the top level`);
        if (!('landed' in raw)) bad(`${w}.follow needs a landed condition`);
        cond(raw.landed, `${w}.landed`);
        const l = raw.landed as Record<string, unknown>;
        if ('changed' in l) bad(`${w}.landed cannot use changed`);
      } else if ('landed' in raw || 'retryKeepInTab' in raw) bad(`${w}: landed and retryKeepInTab need follow`);
      if ('retryKeepInTab' in raw && typeof raw.retryKeepInTab !== 'boolean') bad(`${w}.retryKeepInTab must be a boolean`);
      if ('delayMs' in raw) int(raw.delayMs, `${w}.delayMs`, 0, MAX_MS);
      if ('else' in raw) code(raw.else, `${w}.else`);
      return;
    }
    case 'fill': {
      onlyKeys(raw, ['id', 'do', 'selector', 'value', 'submit', 'submitButton', 'buttons', 'submitText', 'delayMs', 'else'], w);
      str(raw.selector, `${w}.selector`);
      if (!str(raw.value, `${w}.value`).startsWith('$')) bad(`${w}.value must be $link or $email`);
      inputValue(raw.value, `${w}.value`, ctx.inputs);
      if ('submit' in raw && typeof raw.submit !== 'boolean') bad(`${w}.submit must be a boolean`);
      if ('submitButton' in raw) str(raw.submitButton, `${w}.submitButton`);
      if ('buttons' in raw) str(raw.buttons, `${w}.buttons`);
      if ('submitText' in raw) rx(raw.submitText, `${w}.submitText`);
      if ('delayMs' in raw) int(raw.delayMs, `${w}.delayMs`, 0, MAX_MS);
      if ('else' in raw) code(raw.else, `${w}.else`);
      return;
    }
    case 'read': {
      onlyKeys(raw, ['id', 'do', 'into', 'all', 'fields', 'secret', 'parse'], w);
      const into = str(raw.into, `${w}.into`, 48);
      if (!ID_RE.test(into)) bad(`${w}.into is not a valid name`);
      if (('all' in raw) === ('fields' in raw)) bad(`${w} needs exactly one of all, fields`);
      if ('all' in raw) str(raw.all, `${w}.all`);
      const names: string[] = [];
      if ('fields' in raw) {
        if (!isObj(raw.fields) || !Object.keys(raw.fields).length || Object.keys(raw.fields).length > 12) bad(`${w}.fields must hold 1..12 entries`);
        for (const [k, f] of Object.entries(raw.fields as Record<string, unknown>)) {
          if (!ID_RE.test(k)) bad(`${w}.fields: bad name "${k}"`);
          if (!isObj(f)) return bad(`${w}.fields.${k} must be an object`);
          onlyKeys(f, ['label', 'selector', 'regex'], `${w}.fields.${k}`);
          if (Object.keys(f).length !== 1) bad(`${w}.fields.${k} needs exactly one of label, selector, regex`);
          if ('label' in f) str(f.label, `${w}.fields.${k}.label`);
          if ('selector' in f) str(f.selector, `${w}.fields.${k}.selector`);
          if ('regex' in f) rx(f.regex, `${w}.fields.${k}.regex`);
          names.push(k);
        }
      }
      if ('secret' in raw) {
        if (!Array.isArray(raw.secret) || raw.secret.some(s => typeof s !== 'string' || !names.includes(s))) bad(`${w}.secret must list field names`);
      }
      if ('parse' in raw) {
        if (raw.parse !== 'card') bad(`${w}.parse must be "card"`);
        if (!inLoop) bad(`${w}: parse only inside repeat`);
      }
      ctx.vars.add(into);
      return;
    }
    case 'shoot': {
      onlyKeys(raw, ['id', 'do', 'selector', 'into'], w);
      str(raw.selector, `${w}.selector`);
      const into = str(raw.into, `${w}.into`, 48);
      if (!ID_RE.test(into)) bad(`${w}.into is not a valid name`);
      ctx.vars.add(into);
      return;
    }
    case 'post': {
      onlyKeys(raw, ['id', 'do', 'to', 'body', 'else'], w);
      const to = str(raw.to, `${w}.to`, 48);
      if (!Object.prototype.hasOwnProperty.call(PLAN_ENDPOINTS, to)) bad(`${w}.to "${to}" is not a known endpoint`);
      if (!isObj(raw.body) || Object.keys(raw.body).length > 12) bad(`${w}.body must be an object`);
      for (const [k, v] of Object.entries(raw.body as Record<string, unknown>)) {
        if (!ID_RE.test(k)) bad(`${w}.body: bad key "${k}"`);
        const s = str(v, `${w}.body.${k}`, 80);
        if (!/^\$[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?$/.test(s)) bad(`${w}.body.${k} must be a $variable`);
      }
      if ('else' in raw) code(raw.else, `${w}.else`);
      return;
    }
    case 'repeat': {
      onlyKeys(raw, ['id', 'do', 'max', 'steps', 'onMax'], w);
      if (nested) bad(`${w}: repeat cannot nest`);
      int(raw.max, `${w}.max`, 1, PLAN_CAPS.repeat);
      if (!Array.isArray(raw.steps) || !raw.steps.length) bad(`${w}.steps must be a non-empty list`);
      if ('onMax' in raw) code(raw.onMax, `${w}.onMax`);
      for (const s of raw.steps as unknown[]) step(s, ctx, true, true);
      return;
    }
    case 'stopIf': {
      onlyKeys(raw, ['id', 'do', 'when'], w);
      if (!inLoop) bad(`${w}: stopIf only inside repeat`);
      cond(raw.when, `${w}.when`, { counter: true });
      return;
    }
    case 'go': {
      onlyKeys(raw, ['id', 'do', 'to'], w);
      if (nested) bad(`${w}: go only at the top level`);
      str(raw.to, `${w}.to`, 48);
      return;
    }
    case 'fail': {
      onlyKeys(raw, ['id', 'do', 'code'], w);
      code(raw.code, `${w}.code`);
      return;
    }
    default:
      return bad(`${w}: unknown step "${String(d).slice(0, 40)}"`);
  }
}

function gotoTargets(steps: unknown[], top: Set<string>) {
  for (const s of steps as Record<string, unknown>[]) {
    if (s.do === 'go' && !top.has(s.to as string)) bad(`step "${String(s.id)}": go target "${String(s.to)}" is not a top-level step`);
    if (s.do === 'wait' && Array.isArray(s.any)) {
      for (const a of s.any as { go: string }[]) if (!top.has(a.go)) bad(`step "${String(s.id)}": go target "${a.go}" is not a top-level step`);
    }
  }
}

function checkPlan(raw: unknown): void {
  if (!isObj(raw)) return bad('plan must be an object');
  onlyKeys(raw, ['hosts', 'inputs', 'limits', 'timing', 'page', 'patterns', 'steps'], 'plan');
  if (!Array.isArray(raw.hosts) || !raw.hosts.length || raw.hosts.length > 8) bad('hosts must be 1..8 hostnames');
  const hosts = (raw.hosts as unknown[]).map(h => str(h, 'host', 253).toLowerCase());
  for (const h of hosts) if (!PLAN_HOST_ALLOWLIST.includes(h)) bad(`host "${h}" is outside the bundled allowlist`);
  if (!Array.isArray(raw.inputs) || raw.inputs.some(i => !(PLAN_INPUTS as readonly string[]).includes(i as string))) bad('inputs must be from link, email, orderId');
  const inputs = raw.inputs as string[];
  if ('limits' in raw) {
    const l = raw.limits;
    if (!isObj(l)) return bad('limits must be an object');
    onlyKeys(l, ['steps', 'repeat', 'runMs', 'tabs'], 'limits');
    for (const k of ['steps', 'repeat', 'runMs', 'tabs'] as const) {
      if (k in l) int(l[k], `limits.${k}`, 1, PLAN_CAPS[k]);
    }
  }
  if ('timing' in raw) {
    const t = raw.timing;
    if (!isObj(t)) return bad('timing must be an object');
    onlyKeys(t, ['pollMs', 'waitMs', 'newTabWaitMs'], 'timing');
    if ('pollMs' in t) int(t.pollMs, 'timing.pollMs', 100, MAX_MS);
    for (const k of ['waitMs', 'newTabWaitMs'] as const) if (k in t) int(t[k], `timing.${k}`, 1, MAX_MS);
  }
  const p = raw.page;
  if (!isObj(p)) return bad('page must be an object');
  onlyKeys(p, ['clickables', 'labelCells', 'alert', 'alertText', 'botCheck', 'botCheckText'], 'page');
  for (const k of ['clickables', 'labelCells', 'alert', 'botCheck']) if (k in p) str(p[k], `page.${k}`);
  for (const k of ['clickables', 'labelCells', 'alert', 'alertText', 'botCheck', 'botCheckText']) if (!(k in p)) bad(`page.${k} is required`);
  rx(p.alertText, 'page.alertText');
  rx(p.botCheckText, 'page.botCheckText');
  if ('patterns' in raw) {
    if (!isObj(raw.patterns)) return bad('patterns must be an object');
    for (const [k, v] of Object.entries(raw.patterns)) {
      if (!ID_RE.test(k)) bad(`patterns: bad name "${k}"`);
      rx(v, `patterns.${k}`);
    }
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length) return bad('steps must be a non-empty list');
  const ctx: Ctx = { ids: new Set(), top: new Set(), plan: raw, inputs, hosts, count: 0, vars: new Set() };
  for (const s of raw.steps as unknown[]) if (isObj(s) && typeof s.id === 'string') ctx.top.add(s.id);
  for (const s of raw.steps as unknown[]) step(s, ctx, false, false);
  gotoTargets(raw.steps, ctx.top);
  const lim = effectiveLimits({ limits: raw.limits as PlanLimits | undefined });
  if (ctx.count > lim.steps) bad(`plan has ${ctx.count} steps, over its limit of ${lim.steps}`);
}

/** Checks one plan. Pure: ok, or the first reason it is not acceptable. */
export function validatePlan(raw: unknown): PlanCheck {
  try { checkPlan(raw); return { ok: true }; } catch (e) {
    if (e instanceof Bad) return { ok: false, reason: e.message };
    return { ok: false, reason: 'plan could not be checked' };
  }
}

/** Checks a whole plan file ({ version, plans }). A plan file with any bad plan is rejected whole. */
export function validatePlanFile(raw: unknown): PlanFileCheck {
  if (!isObj(raw)) return { ok: false, reason: 'plan file must be an object' };
  for (const k of Object.keys(raw)) if (k !== 'version' && k !== 'plans') return { ok: false, reason: `unknown top-level key "${k}"` };
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: 'version must be a positive integer' };
  if (!isObj(raw.plans)) return { ok: false, reason: 'plans must be an object' };
  for (const [name, plan] of Object.entries(raw.plans)) {
    if (!ID_RE.test(name)) return { ok: false, reason: `bad plan name "${name}"` };
    const c = validatePlan(plan);
    if (!c.ok) return { ok: false, reason: `plan "${name}": ${c.reason}` };
  }
  return { ok: true, file: raw as unknown as PlanFile };
}

// ---- serving ----

export type LoadedPlans =
  | { ok: true; file: PlanFile; text: string; sig: string | null; body: string; etag: string }
  | { ok: false; error: string };

/** Strong ETag from the plan version, a hash of the exact text, and the signature. */
export function plansEtag(version: number, text: string, sig: string | null): string {
  const h = createHash('sha256').update(text).update('\0').update(sig ?? '').digest('hex').slice(0, 16);
  return `"${version}-${h}"`;
}

/** Parses and validates the raw file text once. Serves the exact text; an invalid file logs one line and is never served. */
export function loadPlans(text: string, sig: string | null, log: (msg: string) => void = console.error): LoadedPlans {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    log('[plans] INVALID config/plans.json, serving 500 (extensions keep their cache): not valid JSON');
    return { ok: false, error: 'not valid JSON' };
  }
  const v = validatePlanFile(parsed);
  if (!v.ok) {
    log(`[plans] INVALID config/plans.json, serving 500 (extensions keep their cache): ${v.reason}`);
    return { ok: false, error: v.reason };
  }
  const s = sig && sig.trim() ? sig.trim() : null;
  return { ok: true, file: v.file, text, sig: s, body: JSON.stringify({ plans: text, sig: s }), etag: plansEtag(v.file.version, text, s) };
}

/** GET /api/extension/plans: secret guard like scrape-config, then 304/200/500. */
export function plansResponse(req: Request, loaded: LoadedPlans): Response {
  if (!verifyExtensionSecret(req)) return Response.json({ error: 'extension secret missing or invalid' }, { status: 401 });
  if (!loaded.ok) return Response.json({ error: 'plans invalid' }, { status: 500 });
  const headers = { ETag: loaded.etag, 'Cache-Control': 'no-cache' };
  if (etagMatches(req.headers.get('If-None-Match'), loaded.etag)) return new Response(null, { status: 304, headers });
  return new Response(loaded.body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
}
