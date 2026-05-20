/**
 * Supabase REST client for Cloudflare Workers.
 * Uses the PostgREST API — no Node.js dependencies.
 */

export class SupabaseDB {
  private url: string;
  private key: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.url = `${supabaseUrl}/rest/v1`;
    this.key = supabaseKey;
  }

  private headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
  }

  async select<T = any>(
    table: string,
    query?: string,
  ): Promise<T[]> {
    const url = `${this.url}/${table}${query ? `?${query}` : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`SELECT ${table}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T[]>;
  }

  async update(
    table: string,
    filter: string,
    data: Record<string, any>,
  ): Promise<any[]> {
    const url = `${this.url}/${table}?${filter}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`UPDATE ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async insert(table: string, data: Record<string, any>): Promise<any[]> {
    const url = `${this.url}/${table}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`INSERT ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
