# Benchmark results

- Date: 2026-11-27T16:32:21.055Z
- Server: http://127.0.0.1:51805 (local process started by the script)
- Machine: darwin arm64, Bun 1.3.6
- Workload: every client inserts 1 character every 10 ms at a random position, 100 ops per client.
- Latency = time from op creation on one client to op integration on another client (all clients run in one process, so they share one clock).
- Ack RTT = time from batch send to server ack (the server writes the batch to SQLite before the ack).

| Clients | Ops total | Time (s) | Throughput (ops/s) | Latency p50 (ms) | p95 (ms) | p99 (ms) | Ack RTT p50 (ms) | Ack RTT p95 (ms) | Convergence after last op (ms) | Server RSS (MB) | Server CPU (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 500 | 1.16 | 430 | 1.2 | 3.1 | 5.6 | 0.9 | 2.6 | 0 | 52 | 253 |
| 10 | 1000 | 1.17 | 855 | 1.3 | 4 | 8.6 | 1 | 3 | 0 | 55 | 253 |
| 20 | 2000 | 1.16 | 1729 | 1.8 | 6.2 | 7.8 | 1.1 | 3 | 1 | 59 | 270 |
| 50 | 5000 | 1.15 | 4334 | 1.7 | 6.9 | 10.1 | 1.4 | 5.8 | 3 | 87 | 536 |

Note: all clients run in one benchmark process. With many clients, this process also uses CPU, so the numbers include client-side cost.
