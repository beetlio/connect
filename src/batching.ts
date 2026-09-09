/** Coalesce snapshot records across pages/parents; flush after a successful scan.
 * Do not use for checkpointed emissions: their acknowledgment must remain immediate.
 */
export function createRecordBatcher<Record>(
  emit: (value: { records: readonly Record[] }) => Promise<void>,
) {
  let records: Record[] = [];
  let bytes = 0;
  const flush = async () => {
    if (records.length === 0) return;
    await emit({ records });
    records = [];
    bytes = 0;
  };
  return {
    async emit(value: { records: readonly Record[] }) {
      for (const record of value.records) {
        // Leave room for storage JSON escaping and the runtime message envelope.
        const json = JSON.stringify(record);
        const size = new TextEncoder().encode(json).length;
        if (records.length && (records.length >= 100 || bytes + size > 1024 * 1024)) await flush();
        records.push(JSON.parse(json) as Record);
        bytes += size;
        if (bytes >= 1024 * 1024) await flush();
      }
    },
    flush,
  };
}
