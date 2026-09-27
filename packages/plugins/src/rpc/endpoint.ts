import { hasPluginPermission, type PluginPermission } from '@tessera/core';
import type { PluginErrorCode, PluginSurface } from '@tessera/plugin-api';
import { PLUGIN_LIMITS } from '../constants';
import { PluginCallError, toCallError } from '../errors';
import { t } from '../i18n';
import { inspectMessage } from './inspect';
import {
  API_METHODS,
  isApiMethod,
  notifyEnvelope,
  PROTOCOL_VERSION,
  requestEnvelope,
  responseEnvelope,
  type ApiMethod,
  type ApiParams,
  type ConnectionSurface,
  type HostEventName,
  type HostRequestMethod,
  type NotifyMethod,
} from './protocol';

/** The end of a MessageChannel the host holds. */
export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

/** Handlers for every API method, bound to one plugin and one surface. */
export type ApiHandlers = {
  [M in ApiMethod]: (params: ApiParams<M>) => unknown;
};

/** Options of {@link HostEndpoint}. */
export interface HostEndpointOptions {
  port: RpcPort;
  /** A renderer frame has no API: every call from it is refused. */
  surface: ConnectionSurface;
  /** The plugin's name, for messages. */
  pluginName: () => string;
  /** Permissions granted right now (checked on every call, so revoking applies at once). */
  granted: () => readonly PluginPermission[];
  /** A permission description for errors ("read your pages"). */
  describe: (permission: PluginPermission) => string;
  handlers: ApiHandlers;
  onNotify: (method: NotifyMethod, params: unknown) => void;
  /** A protocol violation or a refused call, for the plugin's console. */
  onWarning: (message: string) => void;
  /** An unexpected host error, for the plugin's console (not shown to the plugin). */
  onInternalError: (method: string, error: unknown) => void;
  onPermissionDenied?: (permission: PluginPermission, method: ApiMethod) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const MESSAGE_LIMITS = {
  depth: PLUGIN_LIMITS.messageDepth,
  nodes: PLUGIN_LIMITS.messageNodes,
  chars: PLUGIN_LIMITS.messageChars,
};

/**
 * The host side of one plugin connection (its worker, a panel, or a block). Every incoming message
 * is size-checked, then validated with zod; every API call is checked against the permissions
 * granted at that moment and the surface it came from. Nothing a plugin sends can reach host code
 * unvalidated.
 */
export class HostEndpoint {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Set<number>();
  private disposed = false;

  constructor(private readonly options: HostEndpointOptions) {
    options.port.onmessage = (event) => this.receive(event.data);
  }

  /** Calls into the plugin (ping, activate, deactivate, command.run). */
  request(method: HostRequestMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new PluginCallError('unavailable', t('errStopped')));
    const id = this.nextId;
    this.nextId = this.nextId >= 2 ** 31 - 1 ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginCallError('timeout', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ v: PROTOCOL_VERSION, type: 'request', id, method, params });
    });
  }

  /** Sends an event to the plugin. */
  emit(event: HostEventName, payload: unknown): void {
    this.post({ v: PROTOCOL_VERSION, type: 'event', event, payload });
  }

  /** Requests the plugin sent that the host hasn't answered yet. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Stops listening and rejects pending host requests (with `reason`, or "stopped"). */
  dispose(reason?: PluginCallError): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.port.onmessage = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason ?? new PluginCallError('unavailable', t('errStopped')));
    }
    this.pending.clear();
    this.inFlight.clear();
    try {
      this.options.port.close();
    } catch {
      // Already closed.
    }
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    try {
      this.options.port.postMessage(message);
    } catch (error) {
      this.options.onInternalError('postMessage', error);
    }
  }

  private respondError(id: number, code: PluginErrorCode, message: string) {
    this.post({ v: PROTOCOL_VERSION, type: 'response', id, ok: false, error: { code, message } });
  }

  /** Reads a request ID from a refused message, so the plugin's call rejects instead of hanging. */
  private salvageRequestId(data: unknown): number | null {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const { type, id } = data as { type?: unknown; id?: unknown };
    return type === 'request' &&
      typeof id === 'number' &&
      Number.isInteger(id) &&
      id > 0 &&
      id < 2 ** 31
      ? id
      : null;
  }

  private receive(data: unknown): void {
    if (this.disposed) return;
    const problem = inspectMessage(data, MESSAGE_LIMITS);
    if (problem) {
      this.options.onWarning(`Refused a malformed message (${problem}).`);
      const id = this.salvageRequestId(data);
      if (id !== null)
        this.respondError(
          id,
          'invalid',
          `The message was refused: ${problem === 'type' ? 'only JSON values can be sent' : `it is too large (${problem})`}.`,
        );
      return;
    }
    const type = (data as { type?: unknown } | null)?.type;
    if (type === 'request') this.receiveRequest(data);
    else if (type === 'response') this.receiveResponse(data);
    else if (type === 'notify') this.receiveNotify(data);
    else this.options.onWarning('Refused a message of unknown type.');
  }

  private receiveResponse(data: unknown): void {
    const parsed = responseEnvelope.safeParse(data);
    if (!parsed.success) {
      this.options.onWarning('Refused a malformed response.');
      return;
    }
    const pending = this.pending.get(parsed.data.id);
    if (!pending) {
      // Late (after a timeout), duplicated or invented responses are dropped.
      this.options.onWarning(`Ignored an unexpected response (id ${parsed.data.id}).`);
      return;
    }
    this.pending.delete(parsed.data.id);
    clearTimeout(pending.timer);
    if (parsed.data.ok) pending.resolve(parsed.data.result);
    else pending.reject(new PluginCallError('internal', parsed.data.error.message));
  }

  private receiveNotify(data: unknown): void {
    const parsed = notifyEnvelope.safeParse(data);
    if (!parsed.success) {
      this.options.onWarning('Refused a malformed notification.');
      return;
    }
    this.options.onNotify(parsed.data.method, parsed.data.params);
  }

  private receiveRequest(data: unknown): void {
    const envelope = requestEnvelope.safeParse(data);
    if (!envelope.success) {
      this.options.onWarning('Refused a malformed request.');
      const id = this.salvageRequestId(data);
      if (id !== null) this.respondError(id, 'invalid', 'The request was malformed.');
      return;
    }
    const { id, method, params } = envelope.data;
    if (this.inFlight.has(id)) {
      this.options.onWarning(`Refused a request that reused id ${id}.`);
      this.respondError(id, 'invalid', 'This request ID is already in use.');
      return;
    }
    if (this.inFlight.size >= PLUGIN_LIMITS.inFlightRequests) {
      this.respondError(id, 'unavailable', t('errTooManyRequests'));
      return;
    }
    const surface = this.options.surface;
    if (surface === 'renderer') {
      this.options.onWarning(`Refused an API call from the renderer ("${method.slice(0, 64)}").`);
      this.respondError(id, 'invalid_operation', t('errRendererApi'));
      return;
    }
    if (!isApiMethod(method)) {
      this.options.onWarning(`Refused an unknown API call "${method.slice(0, 64)}".`);
      this.respondError(id, 'not_found', t('errUnknownMethod', { method: method.slice(0, 64) }));
      return;
    }
    const specification: {
      params: {
        safeParse(value: unknown): {
          success: boolean;
          data?: unknown;
          error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
      };
      permission?: PluginPermission;
      surfaces?: readonly PluginSurface[];
    } = API_METHODS[method];
    if (specification.surfaces && !specification.surfaces.includes(surface)) {
      this.respondError(id, 'invalid_operation', t('errWrongSurface', { method, surface }));
      return;
    }
    const parsed = specification.params.safeParse(params);
    if (!parsed.success) {
      const details = (parsed.error?.issues ?? [])
        .slice(0, 3)
        .map((issue) =>
          issue.path.length
            ? `${issue.path.map(String).join('.')}: ${issue.message}`
            : issue.message,
        )
        .join('; ');
      this.respondError(id, 'invalid', t('errInvalidParams', { method, details }));
      return;
    }
    const permission = specification.permission;
    if (permission && !hasPluginPermission(this.options.granted(), permission)) {
      this.options.onPermissionDenied?.(permission, method);
      const message = t('permissionDenied', {
        plugin: this.options.pluginName(),
        action: this.options.describe(permission),
      });
      this.post({
        v: PROTOCOL_VERSION,
        type: 'response',
        id,
        ok: false,
        error: { code: 'permission_denied', message, permission },
      });
      return;
    }
    this.inFlight.add(id);
    // The method name and its params were validated together above, so the handler receives
    // exactly the params its schema describes.
    const handler = this.options.handlers[method] as (value: unknown) => unknown;
    Promise.resolve()
      .then(() => handler(parsed.data))
      .then(
        (result) => {
          if (!this.inFlight.delete(id)) return;
          this.post({ v: PROTOCOL_VERSION, type: 'response', id, ok: true, result });
        },
        (error: unknown) => {
          if (!this.inFlight.delete(id)) return;
          const { error: callError, expected } = toCallError(error, t('errInternal'));
          if (!expected) this.options.onInternalError(method, error);
          const payload: { code: string; message: string; permission?: string } = {
            code: callError.code,
            message: callError.message,
          };
          if (callError.permission) payload.permission = callError.permission;
          this.post({ v: PROTOCOL_VERSION, type: 'response', id, ok: false, error: payload });
        },
      );
  }
}
