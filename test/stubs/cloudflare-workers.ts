// `cloudflare:workers` exists only inside workerd. Under vitest (plain node)
// this stands in for it: just enough of WorkerEntrypoint to construct one.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: Env,
  ) {}
}
