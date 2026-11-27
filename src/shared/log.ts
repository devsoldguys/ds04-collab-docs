/**
 * One log line per event: "<ISO time> [<node>] <EVENT> key=value ... result=<RESULT>".
 * Server and CLI client use the same format, so logs from all nodes can be compared.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function makeLogger(node: string, sink: (line: string) => void = console.log) {
  return (event: string, fields: LogFields = {}, result = "OK") => {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : v}`);
    sink(`${new Date().toISOString()} [${node}] ${event} ${parts.join(" ")} result=${result}`.replace("  ", " "));
  };
}

export type Logger = ReturnType<typeof makeLogger>;
