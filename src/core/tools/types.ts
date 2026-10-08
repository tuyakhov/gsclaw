import type { z } from 'zod';
import type { Config } from '../config.js';
import type { GscClient } from '../gsc/client.js';
import type { Logger } from '../log.js';

export interface ToolContext {
  gsc: GscClient;
  config: Pick<Config, 'maxRows' | 'batchInspectMax' | 'allowWrites'>;
  logger: Logger;
  now: () => Date;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * One tool, defined once. MCP serves `format(run(...))` as text plus the raw result as structured
 * content; the dashboard API calls the very same `run`, so both always see identical numbers.
 */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject, R = unknown> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Mutating tools are only registered when GSCLAW_ALLOW_WRITES=true and the credentials can write. */
  write?: boolean;
  run(ctx: ToolContext, input: z.output<S>): Promise<R>;
  format(result: R, input: z.output<S>): string;
}

export type AnyTool = ToolDefinition<z.ZodObject, unknown>;

export function defineTool<S extends z.ZodObject, R>(
  def: ToolDefinition<S, R>,
): ToolDefinition<S, R> {
  return def;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
