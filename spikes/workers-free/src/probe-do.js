// Durable Object that runs the same CPU-heavy work as the Worker routes, to learn whether
// a DO on Workers Free has the same 10 ms CPU cap (auth design open question).
import { DurableObject } from 'cloudflare:workers';
import bcrypt from 'bcryptjs';
import { BCRYPT, PASSWORD } from './fixtures.js';

export class CpuProbe extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const cost = url.searchParams.get('cost') ?? '10';
    const ok = bcrypt.compareSync(PASSWORD, BCRYPT[cost]);
    return Response.json({ ok, cost: Number(cost), in: 'durable-object' });
  }
}
