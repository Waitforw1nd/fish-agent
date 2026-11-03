import { transaction } from '../db.js';

// Store the attribution once, and commit each event with its cursor. A restart
// may only close a run when process_runs already contains a confirmed end time.
export function attachHostingMeters({ supervisor, billing, intervalMs = 300000, logger = null }) {
  const db = billing.db;
  const active = new Map();
  const pendingStates = new Map();
  function flush(run, end, terminal = false) {
    try {
      transaction(db, () => {
        const saved = db.prepare('SELECT * FROM hosting_meter_checkpoints WHERE run_id=?').get(run.runId);
        if (!saved || saved.completed_at != null) return;
        const start = saved.cursor_at;
        if (end > start && saved.entry) billing.recordMeter({
          tenantId: saved.tenant_id, entry: saved.entry, meter: `${saved.entry}.hosting.seconds`,
          quantity: (end - start) / 1000, unit: 'seconds', kind: 'delta', source: 'supervisor',
          occurredAt: end, idempotencyKey: `hosting:${run.runId}:${start}:${end}`
        });
        db.prepare('UPDATE hosting_meter_checkpoints SET cursor_at=?, observed_at=?, completed_at=? WHERE run_id=?')
          .run(Math.max(start, end), Math.max(saved.observed_at, end), terminal ? end : null, run.runId);
      });
      run.cursor = Math.max(run.cursor, end);
      return true;
    } catch (error) { logger?.error?.('hosting meter checkpoint failed', error); return false; }
  }
  const recover = db.prepare(`SELECT c.*, p.status, p.stopped_at FROM hosting_meter_checkpoints c
    LEFT JOIN process_runs p ON p.id=c.run_id WHERE c.completed_at IS NULL`).all();
  for (const row of recover) {
    if (row.stopped_at != null && ['stopped', 'exited', 'failed', 'crashed'].includes(row.status)) {
      const run = { runId: row.run_id, cursor: row.cursor_at, endedAt: row.stopped_at };
      if (!flush(run, row.stopped_at, true)) active.set(run.runId, run);
    } else {
      logger?.warn?.('hosting meter requires run end verification', { runId: row.run_id, tenantId: row.tenant_id, observedAt: row.observed_at });
    }
  }
  // Older runs and a failure before initial checkpoint have no reliable attribution.
  const missing = db.prepare(`SELECT COUNT(*) AS count FROM process_runs p LEFT JOIN hosting_meter_checkpoints c ON c.run_id=p.id WHERE c.run_id IS NULL`).get().count;
  if (missing) logger?.warn?.('hosting meter runs lack attribution checkpoints; inspect process_runs', { count: missing });
  const applyState = event => {
    let run = active.get(event.runId);
    if (!run) {
      const saved = db.prepare('SELECT * FROM hosting_meter_checkpoints WHERE run_id=?').get(event.runId);
      if (saved?.completed_at != null) return;
      if (!saved && !['starting', 'running', 'restarting'].includes(event.state)) return;
      if (!saved) {
        if (!Object.hasOwn(event, 'meterEntry')) {
          const driver = event.kind === 'agent' ? db.prepare('SELECT driver FROM qq_accounts WHERE tenant_id=?').get(event.tenantId)?.driver : null;
          const qqEntry = driver ? (driver === 'qqbot' ? 'qq_official' : 'qq_protocol') : null;
          const choice = qqEntry ? db.prepare('SELECT enabled FROM tenant_entries WHERE tenant_id=? AND entry=?').get(event.tenantId, qqEntry) : null;
          event.meterEntry = event.kind === 'qq' ? 'qq_protocol' : event.kind === 'bili' ? 'bili'
            : event.kind === 'agent' && qqEntry && (choice == null || choice.enabled) ? qqEntry : null;
        }
        db.prepare('INSERT INTO hosting_meter_checkpoints(run_id,tenant_id,entry,cursor_at,observed_at) VALUES (?,?,?,?,?)')
          .run(event.runId, event.tenantId, event.meterEntry, event.startedAt, event.startedAt);
      }
      const current = db.prepare('SELECT * FROM hosting_meter_checkpoints WHERE run_id=?').get(event.runId);
      run = { runId: event.runId, cursor: current.cursor_at };
      active.set(event.runId, run);
    }
    if (event.endedAt) {
      run.endedAt ??= event.endedAt;
      if (flush(run, run.endedAt, true)) active.delete(event.runId);
    }
  };
  const retryStates = runId => {
    const queue = pendingStates.get(runId);
    while (queue?.length) {
      try { applyState(queue[0]); queue.shift(); }
      catch (error) { logger?.error?.('hosting meter state failed', error); break; }
    }
    if (queue && !queue.length) pendingStates.delete(runId);
  };
  const onState = event => {
    const queue = pendingStates.get(event.runId) || [];
    queue.push({ ...event });
    pendingStates.set(event.runId, queue);
    retryStates(event.runId);
  };
  supervisor.on('run-state', onState);
  const checkpoint = () => {
    try {
      for (const runId of pendingStates.keys()) retryStates(runId);
      for (const run of active.values()) {
        const persisted = db.prepare('SELECT status, stopped_at FROM process_runs WHERE id=?').get(run.runId);
        if (persisted?.stopped_at != null && ['stopped', 'exited', 'failed', 'crashed'].includes(persisted.status)) run.endedAt ??= persisted.stopped_at;
        const observed = supervisor.meterObservation?.(run.runId);
        if (observed?.endedAt != null) run.endedAt ??= observed.endedAt;
        // Legacy EventEmitter fixtures have no observation API. A real Supervisor
        // must affirm liveness before an open run can accrue more time.
        if (run.endedAt == null && typeof supervisor.meterObservation === 'function' && !observed?.chargeable) continue;
        if (flush(run, run.endedAt ?? Date.now(), run.endedAt != null) && run.endedAt != null) active.delete(run.runId);
      }
      // A previously unconfirmed run can acquire a verified end after startup.
      // Revisit it without charging any time until that end is persisted.
      const confirmed = db.prepare(`SELECT c.run_id, c.cursor_at, p.stopped_at FROM hosting_meter_checkpoints c
        JOIN process_runs p ON p.id=c.run_id WHERE c.completed_at IS NULL AND p.stopped_at IS NOT NULL
        AND p.status IN ('stopped', 'exited', 'failed', 'crashed')`).all();
      for (const row of confirmed) {
        if (active.has(row.run_id)) continue;
        const run = { runId: row.run_id, cursor: row.cursor_at, endedAt: row.stopped_at };
        if (!flush(run, run.endedAt, true)) active.set(run.runId, run);
      }
    } catch (error) { logger?.error?.('hosting meter recovery scan failed', error); }
  };
  const timer = setInterval(checkpoint, intervalMs); timer.unref?.();
  return () => { clearInterval(timer); supervisor.off('run-state', onState); checkpoint(); };
}
